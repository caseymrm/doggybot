/* The per-file transfer Workflow: durable multipart-create → Range-GET /
 * uploadPart loop → complete → trash, one step per part (design §2). Cloudflare
 * Workflows persists each step's result, so a crash/retry resumes at the failed
 * step against the same open R2 multipart upload — not the start of the file. */
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { DriveClient } from './drive';
import {
  PART_SIZE,
  transferParamsSchema,
  type ContextResolver,
  type DriveFileMeta,
  type TransferContext,
  type TransferParams,
} from './types';

// --- Part-range math (pure) -------------------------------------------------

export interface PartRange {
  index: number; // 0-based; R2 part number is index + 1
  start: number; // inclusive byte offset
  end: number; // inclusive byte offset
  length: number;
}

/** Part count for a file. Always ≥ 1 so a 0-byte file still gets one part
 *  (which the workflow handles via the single-put path, not multipart). */
export function partCountFor(total: number, partSize: number): number {
  return Math.max(1, Math.ceil(total / partSize));
}

/** Tile [0, total) into equal `partSize` parts, remainder on the last. Every
 *  part except the last is exactly `partSize` (R2's equal-parts requirement). */
export function computePartRanges(total: number, partSize: number): PartRange[] {
  const count = partCountFor(total, partSize);
  const ranges: PartRange[] = [];
  for (let index = 0; index < count; index++) {
    const start = index * partSize;
    const end = Math.min(start + partSize, total) - 1; // inclusive
    ranges.push({ index, start, end, length: end - start + 1 });
  }
  return ranges;
}

/** Every part step: retry hard (a part re-pulls at most one part size), with a
 *  timeout wide enough for a slow link (256 MiB at 1 MB/s ≈ 4.5 min). */
export const PART_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 6, delay: '30 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
};

// --- Orchestration ----------------------------------------------------------

/** The `step.do` surface the orchestration uses. Exactly the real WorkflowStep
 *  method (both overloads), so a real step is trivially assignable and tests
 *  can supply a fake. */
export type TransferStep = Pick<WorkflowStep, 'do'>;

/** The durable step sequence for one file, factored out of the entrypoint class
 *  so it's unit-testable with a fake step + context. Every external effect runs
 *  inside a `step.do` (persisted, replayed) except onFileFailed, which is best-
 *  effort on the terminal path. */
export async function runTransfer(
  ctx: TransferContext,
  params: TransferParams,
  step: TransferStep
): Promise<void> {
  const key = ctx.target.keyFor(params);

  // meta — re-fetch size (files.list size can be stale if the file was still
  // landing) and confirm the file still exists. The part size is PERSISTED here
  // and every range is computed from meta.partSize, NOT the compile-time
  // PART_SIZE: a deploy that changes PART_SIZE mid-transfer must not re-tile a
  // resumed file, or replayed part etags would re-associate with different byte
  // ranges (R2 requires all-but-last parts to be equal size).
  const meta = await step.do('meta', async () => ({
    ...(await driveFileMeta(ctx, params.fileId)),
    partSize: PART_SIZE,
  }));
  const ranges = computePartRanges(meta.size, meta.partSize);

  let uploadId: string | undefined;
  try {
    if (ranges.length === 1) {
      // Small file: one streamed put, no multipart ceremony.
      await step.do('put', () => streamPut(ctx, params.fileId, key, meta));
    } else {
      // create returns the uploadId (tiny string). Persisted, so any later
      // step's retry reattaches via resumeMultipartUpload(key, uploadId).
      uploadId = await step.do('create', () => createMultipart(ctx, key, meta));
      const id = uploadId;

      // One step per part; each persists only its {partNumber, etag}.
      const parts: R2UploadedPart[] = [];
      for (const range of ranges) {
        parts.push(
          await step.do(`part-${range.index}`, PART_STEP_CONFIG, () =>
            transferPart(ctx, params.fileId, key, id, range)
          )
        );
      }

      await step.do('complete', () => completeMultipart(ctx, key, id, parts));
    }

    // verify BEFORE trash — inside the try so a size mismatch (or a missing
    // object) triggers abort + onFileFailed and the file is never trashed. A
    // 0-byte object once slipped past a "successful" upload (2026-07-22); this
    // is the guarantee that the R2 copy is intact before the original is gone.
    await step.do('verify', () => verifyStaged(ctx, key, meta.size));
  } catch (err) {
    // Terminal (retries exhausted or a NonRetryableError): abort the multipart
    // so R2 doesn't accrete orphaned parts, notify, then rethrow so the instance
    // lands in `errored` (visible, alertable).
    if (uploadId !== undefined) {
      const id = uploadId;
      try {
        await step.do('abort', () => abortMultipart(ctx, key, id));
      } catch (abortErr) {
        // An abort failure must NOT mask the original error or skip onFileFailed
        // — the bucket's incomplete-multipart lifecycle rule (design §2) is the
        // backstop for a multipart we couldn't abort here. Log and press on.
        console.error('[takeout-transfer] abort multipart failed', abortErr);
      }
    }
    await ctx.hooks.onFileFailed?.(params, err);
    throw err;
  }

  // trash — only after the object is durably complete in R2.
  await step.do('trash', () => trashDriveFile(ctx, params.fileId));

  // completion hook — its own step so it retries independently and a hook
  // failure can't re-trash or re-upload.
  await step.do('on-complete', () => ctx.hooks.onFileComplete(params, key, meta));
}

/** Factory: a WorkflowEntrypoint subclass bound to a deployment's resolver.
 *  `worker.ts` wires it as `class Foo extends makeTransferWorkflow(resolve) {}`. */
export function makeTransferWorkflow<E>(resolve: ContextResolver<E>) {
  return class TransferWorkflow extends WorkflowEntrypoint<E, TransferParams> {
    async run(event: Readonly<WorkflowEvent<TransferParams>>, step: WorkflowStep): Promise<void> {
      const params = transferParamsSchema.parse(event.payload);
      const ctx = await resolve(this.env, params.mode); // §4 seam; cheap, no I/O
      await runTransfer(ctx, params, step);
    }
  };
}

// --- Step bodies ------------------------------------------------------------
//
// These touch the real Workers runtime (global fetch, FixedLengthStream, the R2
// binding), so they're covered by integration/live rather than unit tests; the
// orchestration test above drives run() with a fake step that never invokes
// them. Kept tiny and side-effect-focused for exactly that reason.

function driveClient(ctx: TransferContext): DriveClient {
  return new DriveClient({ tokens: ctx.tokens });
}

function driveFileMeta(ctx: TransferContext, fileId: string): Promise<DriveFileMeta> {
  return driveClient(ctx).fileMeta(fileId);
}

async function createMultipart(
  ctx: TransferContext,
  key: string,
  meta: DriveFileMeta
): Promise<string> {
  // Stamp the Drive md5 into the object so it's self-describing for downstream
  // verification (design §4, embedded wiring).
  const upload = await ctx.target.bucket.createMultipartUpload(key, {
    customMetadata: meta.md5 ? { driveMd5: meta.md5 } : undefined,
  });
  return upload.uploadId;
}

async function transferPart(
  ctx: TransferContext,
  fileId: string,
  key: string,
  uploadId: string,
  range: PartRange
): Promise<R2UploadedPart> {
  const resp = await driveClient(ctx).rangeRequest(fileId, range.start, range.end);
  const body = resp.body;
  if (!body) throw new Error('drive range: empty body');
  // pipeThrough, NOT a split `new FixedLengthStream()` + separate `pipeTo`/
  // `Promise.all`: the split form produced 0-byte R2 objects in production
  // (2026-07-22) — uploadPart saw an empty readable. Single-pipe is the pattern
  // that works. FixedLengthStream still errors the read if
  // Drive delivers != range.length bytes (integrity for free); the verify step
  // in runTransfer is the belt-and-suspenders check before anything is trashed.
  const fixed = body.pipeThrough(new FixedLengthStream(range.length));
  const upload = ctx.target.bucket.resumeMultipartUpload(key, uploadId);
  return upload.uploadPart(range.index + 1, fixed);
}

async function completeMultipart(
  ctx: TransferContext,
  key: string,
  uploadId: string,
  parts: R2UploadedPart[]
): Promise<void> {
  await ctx.target.bucket.resumeMultipartUpload(key, uploadId).complete(parts);
}

async function abortMultipart(ctx: TransferContext, key: string, uploadId: string): Promise<void> {
  await ctx.target.bucket.resumeMultipartUpload(key, uploadId).abort();
}

async function streamPut(
  ctx: TransferContext,
  fileId: string,
  key: string,
  meta: DriveFileMeta
): Promise<void> {
  const resp = await driveClient(ctx).download(fileId);
  const body = resp.body;
  if (!body) throw new Error('drive download: empty body');
  // pipeThrough (see transferPart): the split FixedLengthStream form put a
  // 0-byte object in production. Single-pipe is the pattern that works.
  const fixed = body.pipeThrough(new FixedLengthStream(meta.size));
  await ctx.target.bucket.put(key, fixed, {
    customMetadata: meta.md5 ? { driveMd5: meta.md5 } : undefined,
  });
}

/** Confirm the staged R2 object exists and holds EXACTLY the expected bytes
 *  before the Drive original is trashed. R2 put/complete can "succeed" with a
 *  truncated or empty object (a 0-byte object slipped through on 2026-07-22),
 *  and trash is only ~30-day-reversible — so never trash unverified. A mismatch
 *  is non-retryable: retrying the head won't change a wrong object. */
export async function verifyStaged(
  ctx: TransferContext,
  key: string,
  expectedSize: number
): Promise<void> {
  const head = await ctx.target.bucket.head(key);
  if (!head) {
    throw new NonRetryableError(`staged object missing after upload: ${key}`);
  }
  if (head.size !== expectedSize) {
    throw new NonRetryableError(
      `staged object size ${head.size} != expected ${expectedSize} for ${key}`
    );
  }
}

function trashDriveFile(ctx: TransferContext, fileId: string): Promise<void> {
  return driveClient(ctx).trash(fileId);
}
