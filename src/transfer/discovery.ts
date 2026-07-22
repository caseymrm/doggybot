/* Discovery / scheduler (design §3): list Drive for matching untrashed files,
 * apply the settle guard, and spawn one Workflow instance per new file — with
 * the R2-head shortcut that finishes a stranded (uploaded-but-not-trashed)
 * transfer without re-uploading. Deliberately near-stateless: done/in-flight/
 * partial are all derivable from Drive, the instance registry, and R2. */
import { DriveClient, type DriveApi } from './drive';
import type {
  ContextResolver,
  DriveFileMeta,
  DriveTokenSource,
  TransferMode,
  TransferParams,
} from './types';

/** Resolves the per-mode Workflow binding used to spawn per-file instances.
 *  Kept separate from the context resolver so the running workflow's context
 *  (design §4) carries no binding it doesn't need. The deployment closes over
 *  its env (e.g. `() => env.TAKEOUT_TRANSFER`). */
export type WorkflowBindingFor<E> = (env: E, mode: TransferMode) => Workflow<TransferParams>;

export interface DiscoveryDeps {
  /** Injectable clock (ms) for the settle guard; defaults to Date.now. */
  now?: () => number;
  /** Injectable Drive client factory (tests supply a fake). */
  driveFor?: (tokens: DriveTokenSource) => DriveApi;
}

/** One mode's discovery failed (e.g. its Drive grant was revoked). Recorded so
 *  one tenant's failure can't abort the pass for the others. */
export interface DiscoveryModeError {
  mode: TransferMode;
  error: string;
}

export interface DiscoverySummary {
  scanned: number; // files listed, accepted, and past the settle guard
  created: number; // new instances spawned
  skippedInFlight: number; // instance id already existed
  skippedSettling: number; // files in a batch still within the settle age
  finishedAlreadyStaged: number; // R2 object already present → trashed + hook, no upload
  errors: DiscoveryModeError[]; // per-mode failures; discovery continued past them
}

/** Cloudflare Workflows rejects a second `create` with an existing id; that
 *  rejection IS our idempotency lock. Detect it so discovery can skip rather
 *  than fail. NOTE: the exact error surface isn't documented — match broadly
 *  and verify against the live binding. */
function isInstanceExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /already exists|instance.*exist/i.test(err.message) || err.name === 'InstanceAlreadyExists';
}

/** Parse an RFC3339 createdTime to epoch-ms; unparseable/missing → 0, matching
 *  the Go puller (an unknown time never trips the settle guard). */
function createdMs(f: DriveFileMeta): number {
  if (!f.createdTime) return 0;
  const t = Date.parse(f.createdTime);
  return Number.isNaN(t) ? 0 : t;
}

export async function runDiscovery<E>(
  env: E,
  resolve: ContextResolver<E>,
  bindingFor: WorkflowBindingFor<E>,
  modes: TransferMode[],
  deps?: DiscoveryDeps
): Promise<DiscoverySummary> {
  const now = deps?.now ?? Date.now;
  const driveFor = deps?.driveFor ?? ((tokens: DriveTokenSource) => new DriveClient({ tokens }));
  const summary: DiscoverySummary = {
    scanned: 0,
    created: 0,
    skippedInFlight: 0,
    skippedSettling: 0,
    finishedAlreadyStaged: 0,
    errors: [],
  };

  for (const mode of modes) {
    // One mode per tenant (embedded): isolate each so one tenant's Drive failure
    // (revoked grant → drive.list throws, resolver error, …) can't abort the pass
    // for every other tenant. The failure is recorded, not swallowed.
    try {
      const ctx = await resolve(env, mode);
      const binding = bindingFor(env, mode);
      const drive = driveFor(ctx.tokens);

      const files = (await drive.list(ctx.selector.driveQuery)).filter((f) =>
        ctx.selector.accept(f)
      );

      // Group into export batches for the settle guard (design §3): a batch whose
      // newest file is < settleAge old may still be growing from Google's side.
      const batches = new Map<string, DriveFileMeta[]>();
      for (const f of files) {
        const key = ctx.selector.batchKey(f.name);
        const group = batches.get(key);
        if (group) group.push(f);
        else batches.set(key, [f]);
      }

      const settleMs = ctx.selector.settleAgeSeconds * 1000;
      for (const [batchKey, batchFiles] of batches) {
        const newest = batchFiles.reduce((max, f) => Math.max(max, createdMs(f)), 0);
        if (now() - newest < settleMs) {
          summary.skippedSettling += batchFiles.length;
          continue;
        }

        // Deterministic (name) order — matches the Go puller and keeps the first
        // export zip processed first.
        const ordered = [...batchFiles].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        );
        for (const f of ordered) {
          summary.scanned++;
          const params: TransferParams = {
            fileId: f.id,
            name: f.name,
            size: f.size,
            md5: f.md5,
            batchKey,
            mode,
          };
          const key = ctx.target.keyFor(params);

          const head = await ctx.target.bucket.head(key);
          if (head && head.size === f.size) {
            // Completed on an earlier pass but the trash didn't land — finish the
            // job, don't re-upload.
            await drive.trash(f.id);
            await ctx.hooks.onFileComplete(params, key, f);
            summary.finishedAlreadyStaged++;
            continue;
          }

          try {
            await binding.create({ id: f.id, params });
            summary.created++;
          } catch (err) {
            if (isInstanceExistsError(err)) {
              summary.skippedInFlight++;
              continue;
            }
            throw err;
          }
        }
      }
    } catch (err) {
      summary.errors.push({ mode, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;
}
