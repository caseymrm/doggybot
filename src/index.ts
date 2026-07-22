/* doggybot — the standalone Worker entry.
 *
 * Three responsibilities, all thin wiring over the reusable engine in
 * src/transfer/:
 *   - export the per-file transfer Workflow class (bound as TRANSFER)
 *   - scheduled(): every cron tick, run discovery → spawn one Workflow per new
 *     Drive zip (instance id = Drive file id = the idempotency lock)
 *   - fetch(): a health check, plus an optional owner-only "scan now" kick
 *
 * The engine core knows nothing about this deployment; everything specific
 * (Google credentials, the R2 bucket, the object-key layout, the completion
 * hook) is supplied here through the ContextResolver seam.
 */
import {
  makeTransferWorkflow,
  runDiscovery,
  refreshTokenSource,
  takeoutSelector,
  DEFAULT_SETTLE_AGE_SECONDS,
  type ContextResolver,
  type TransferMode,
  type TransferParams,
  type WorkflowBindingFor,
} from './transfer';

export interface Env {
  /** R2 bucket the zips land in (binding name; the bucket_name is yours, set in
   *  wrangler.jsonc). ZERO-EGRESS INVARIANT: the engine writes through this
   *  binding, never an S3-API client. */
  BUCKET: R2Bucket;
  /** The per-file transfer Workflow binding (class TakeoutTransferWorkflow). */
  TRANSFER: Workflow<TransferParams>;

  // --- Google OAuth (Desktop client) ---------------------------------------
  /** OAuth client id. Not sensitive (it ships in every OAuth desktop app); kept
   *  as a plain var in wrangler.jsonc. */
  GOOGLE_CLIENT_ID: string;
  /** OAuth client secret — a `wrangler secret`, never committed. */
  GOOGLE_CLIENT_SECRET: string;
  /** The long-lived refresh token minted by scripts/get-refresh-token.mjs — a
   *  `wrangler secret`, never committed. */
  GOOGLE_REFRESH_TOKEN: string;

  // --- Optional config (plain vars; sensible defaults) ---------------------
  /** Drive files.list `q`. Defaults to the Takeout query. Override to point at
   *  a specific folder, e.g. `'<FOLDER_ID>' in parents and trashed = false`. */
  DRIVE_QUERY?: string;
  /** R2 key prefix for staged objects. Default `takeout/`. Final key is
   *  `<prefix><batchKey>/<name>`. */
  R2_KEY_PREFIX?: string;
  /** Settle guard (seconds): a batch whose newest file is younger than this is
   *  assumed still uploading and skipped this pass. Default 3600. */
  SETTLE_AGE_SECONDS?: string;

  /** If set, POST /scan requires `Authorization: Bearer <this>` and triggers a
   *  discovery pass immediately. If unset, /scan is disabled (404). A
   *  `wrangler secret`. */
  CONTROL_TOKEN?: string;
}

/** This deployment runs a single mode: itself. (The engine also supports a
 *  multi-tenant `tenant` arm, unused here.) */
const STANDALONE_MODE: TransferMode = { kind: 'standalone' };
const MODES: TransferMode[] = [STANDALONE_MODE];

function requireVar(env: Env, key: keyof Env): string {
  const v = env[key];
  if (typeof v !== 'string' || v.length === 0) {
    // Fail loudly rather than silently transfer with a broken credential —
    // a missing secret is a deploy mistake, not a runtime condition to absorb.
    throw new Error(`doggybot: required config ${String(key)} is not set`);
  }
  return v;
}

/** The engine's context resolver (the §4 seam), bound to doggybot's env. Cheap,
 *  no I/O — it just constructs the token source / target / selector / hooks;
 *  the actual Drive/R2 work happens inside Workflow steps. */
const resolveContext: ContextResolver<Env> = async (env) => {
  const prefix = env.R2_KEY_PREFIX ?? 'takeout/';
  const settleAgeSeconds = env.SETTLE_AGE_SECONDS
    ? Number(env.SETTLE_AGE_SECONDS)
    : DEFAULT_SETTLE_AGE_SECONDS;
  if (!Number.isFinite(settleAgeSeconds) || settleAgeSeconds < 0) {
    throw new Error(`doggybot: SETTLE_AGE_SECONDS must be a non-negative number`);
  }

  return {
    tokens: refreshTokenSource({
      clientId: requireVar(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: requireVar(env, 'GOOGLE_CLIENT_SECRET'),
      refreshToken: requireVar(env, 'GOOGLE_REFRESH_TOKEN'),
    }),
    target: {
      bucket: env.BUCKET,
      // Keep batchKey in the path so same-named zips from different exports
      // (Google reuses `…-001.zip` every cycle) can never collide.
      keyFor: (f: TransferParams) => `${prefix}${f.batchKey}/${f.name}`,
    },
    selector: {
      ...takeoutSelector,
      driveQuery: env.DRIVE_QUERY ?? takeoutSelector.driveQuery,
      settleAgeSeconds,
    },
    hooks: {
      onFileComplete: async (file, r2Key) => {
        console.log(
          `[doggybot] staged ${file.name} (${file.size} bytes) → r2:${r2Key}; trashed from Drive`
        );
      },
      onFileFailed: async (file, err) => {
        console.error(
          `[doggybot] transfer FAILED for ${file.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      },
    },
  };
};

/** The Workflow binding discovery spawns per-file instances on. */
const bindingFor: WorkflowBindingFor<Env> = (env) => env.TRANSFER;

/** The per-file transfer Workflow, bound as TRANSFER in wrangler.jsonc. A thin
 *  subclass: makeTransferWorkflow supplies the durable step sequence,
 *  resolveContext wires doggybot's tokens / bucket / hooks. MUST be exported
 *  from the entry module for the Workflows binding to find it. */
export class TakeoutTransferWorkflow extends makeTransferWorkflow(resolveContext) {}

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/') {
    return Response.json({ ok: true, service: 'doggybot' });
  }

  // Owner-only "scan now" kick — the cron is the steady state; this is for
  // testing or forcing a pass without waiting up to 6 h. Disabled unless
  // CONTROL_TOKEN is set. Discovery is idempotent, so a scan is always safe.
  if (req.method === 'POST' && url.pathname === '/scan') {
    if (!env.CONTROL_TOKEN) {
      return Response.json({ error: 'scan_disabled' }, { status: 404 });
    }
    if (req.headers.get('authorization') !== `Bearer ${env.CONTROL_TOKEN}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const summary = await runDiscovery(env, resolveContext, bindingFor, MODES);
    return Response.json(summary);
  }

  return Response.json({ error: 'not_found' }, { status: 404 });
}

export default {
  fetch: handleFetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Scan Drive, spawn a per-file Workflow for each new, settled zip. Swallowed
    // so a discovery failure (e.g. a transient Drive 5xx) never fails the cron —
    // the next tick retries, and in-flight/partial state is derivable from Drive
    // + the instance registry + R2, so nothing is lost.
    ctx.waitUntil(
      runDiscovery(env, resolveContext, bindingFor, MODES)
        .then((summary) => console.log(`[doggybot] discovery: ${JSON.stringify(summary)}`))
        .catch((err) => console.error('[doggybot] discovery failed', err))
    );
  },
};
