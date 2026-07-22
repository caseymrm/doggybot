/* Engine-core types, constants, error classes, and the credential/config seam
 * for the Takeout transfer engine.
 *
 * HARD RULE: no deployment-specific imports anywhere under src/transfer/. Only
 * `cloudflare:workers` / `cloudflare:workflows` platform modules, the R2 /
 * Workflow ambient globals, and zod. Everything deployment-specific (tokens,
 * bucket, key layout, hooks) arrives through the ContextResolver seam below.
 */
import { z } from 'zod';
import { NonRetryableError } from 'cloudflare:workflows';

// --- Constants --------------------------------------------------------------

/** R2 multipart part size: 256 MiB, uniform across every part except the last
 *  (R2 requires all-but-last parts to be equal size). Chosen so a 50 GB Takeout
 *  zip is ~200 parts — comfortable headroom under the Workflows per-instance
 *  step cap — and a failed part re-pulls at most 256 MiB. Fixed per file;
 *  a deployment may override it (bytes) but must not vary it mid-upload. */
export const PART_SIZE = 256 * 1024 * 1024;

/** A batch whose newest file is younger than this may still be uploading from
 *  Google — Takeout delivers a multi-zip export file-by-file with no manifest,
 *  so one quiet hour ≈ settled. Same settle guard the original Go puller used. */
export const DEFAULT_SETTLE_AGE_SECONDS = 3600;

/** Re-mint an access token this many seconds before its stated expiry so a
 *  token never dies mid-request-chain (a 60s skew, as in the Go Drive client). */
export const TOKEN_EXPIRY_SKEW_SECONDS = 60;

// --- Errors -----------------------------------------------------------------

/** Terminal: the grant was revoked or the refresh token aged out (Google
 *  `invalid_grant`). Extends NonRetryableError so a Workflow step fails fast
 *  instead of burning its retry budget; the owner must reconnect. */
export class DriveAuthRevokedError extends NonRetryableError {
  constructor(message = 'drive_auth_revoked') {
    super(message, 'DriveAuthRevokedError');
  }
}

/** Terminal: the Drive file vanished mid-transfer (404 on meta or a range GET).
 *  No retry can recover it — the workflow aborts its multipart and errors. */
export class DriveFileGoneError extends NonRetryableError {
  constructor(message = 'drive_file_gone') {
    super(message, 'DriveFileGoneError');
  }
}

// --- Drive file shape -------------------------------------------------------

/** The subset of Drive file metadata the engine uses. `createdTime` is present
 *  from files.list (the settle guard reads it) and absent from the per-file
 *  meta step (which only re-checks size + md5). */
export interface DriveFileMeta {
  id: string;
  name: string;
  size: number;
  md5?: string;
  createdTime?: string;
}

// --- Workflow params (serialized into each instance) ------------------------

/** The deployment/tenant identity. This is what the resolver consumes to build
 *  a live context (tokens, target, selector, hooks). It is deliberately NOT
 *  the place for per-file data like batchKey — see the note on the params
 *  schema below. */
export const transferModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standalone') }),
  z.object({ kind: z.literal('tenant'), tenantId: z.string() }),
]);
export type TransferMode = z.infer<typeof transferModeSchema>;

/** Per-file instance params (zod-validated at the workflow entrypoint; a few
 *  hundred bytes, far under the params size limit). Carries ids and layout
 *  data, never credentials — the access token is minted inside steps.
 *
 *  Divergence from design §2 (noted intentionally): `batchKey` is a top-level
 *  field here, not nested inside `mode`. `mode` is the deployment identity used
 *  by both discovery and the resolver *before any file is known*; batchKey is
 *  per-file data used only by `keyFor`. Nesting it in `mode` would force
 *  discovery to fabricate a batchKey just to name a deployment. */
export const transferParamsSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(), // from files.list; re-checked in the meta step
  md5: z.string().optional(), // Drive md5Checksum, for downstream verification
  batchKey: z.string(), // takeout-YYYYMMDDTHHMMSSZ (or the raw name), settle grouping + key layout
  mode: transferModeSchema,
});
export type TransferParams = z.infer<typeof transferParamsSchema>;

// --- The credential/config seam (design §4) ---------------------------------

export interface DriveTokenSource {
  /** Short-lived Drive access token; implementations cache until ~60s before
   *  expiry and re-mint transparently. A thrown DriveAuthRevokedError (mapped
   *  from invalid_grant) is terminal. */
  accessToken(): Promise<string>;
}

export interface TransferTarget {
  /** ZERO-EGRESS INVARIANT: the R2 *binding* only — never an S3-API client. */
  bucket: R2Bucket;
  /** e.g. `tenants/<tid>/<batchKey>/<name>` (embedded) or `<prefix><name>`
   *  (standalone). Pure over its argument so discovery and the workflow derive
   *  the same key for a file. */
  keyFor(file: TransferParams): string;
}

export interface TransferSelector {
  /** files.list `q`. */
  driveQuery: string;
  /** Real-shape enforcement in code (mime/`contains` are unreliable — §0). */
  accept(file: DriveFileMeta): boolean;
  /** Settle-guard grouping; default groups Takeout zips by export timestamp. */
  batchKey(name: string): string;
  settleAgeSeconds: number;
}

export interface TransferHooks {
  onFileComplete(file: TransferParams, r2Key: string, meta: DriveFileMeta): Promise<void>;
  onFileFailed?(file: TransferParams, err: unknown): Promise<void>;
}

export interface TransferContext {
  tokens: DriveTokenSource;
  target: TransferTarget;
  selector: TransferSelector;
  hooks: TransferHooks;
}

/** Each deployment wires its own resolver: mode (deployment identity) → live
 *  context. Cheap, minimal I/O — it just constructs the token source / target
 *  / hooks; the actual Drive/R2 work happens inside workflow steps. */
export type ContextResolver<E> = (env: E, mode: TransferMode) => Promise<TransferContext>;
