import { describe, expect, it } from 'vitest';
import {
  computePartRanges,
  partCountFor,
  runTransfer,
  verifyStaged,
  PART_STEP_CONFIG,
} from './workflow';
import { PART_SIZE, type DriveFileMeta, type TransferContext, type TransferParams } from './types';
import type { TransferStep } from './workflow';

// --- Pure part-range math ---------------------------------------------------
//
// The streaming pipe itself (Drive Range GET → FixedLengthStream → uploadPart)
// needs the real Workers runtime and is left to integration/live. The range
// arithmetic that decides part boundaries is pure and tested hard here.

const PS = 256; // small part size so boundaries are readable

function assertTiles(total: number, partSize: number) {
  const ranges = computePartRanges(total, partSize);
  expect(ranges).toHaveLength(partCountFor(total, partSize));
  expect(ranges[0]!.start).toBe(0);
  expect(ranges[ranges.length - 1]!.end).toBe(total - 1);
  let cursor = 0;
  let sum = 0;
  for (const [i, r] of ranges.entries()) {
    expect(r.index).toBe(i);
    expect(r.start).toBe(cursor); // contiguous, no gaps/overlaps
    expect(r.length).toBe(r.end - r.start + 1);
    cursor = r.end + 1;
    sum += r.length;
  }
  expect(sum).toBe(total); // exact coverage
}

describe('computePartRanges', () => {
  it('is a single part when the file is smaller than one part', () => {
    const ranges = computePartRanges(PS - 1, PS);
    expect(ranges).toEqual([{ index: 0, start: 0, end: PS - 2, length: PS - 1 }]);
  });

  it('is a single part at exactly one part size (boundary)', () => {
    expect(computePartRanges(PS, PS)).toEqual([{ index: 0, start: 0, end: PS - 1, length: PS }]);
  });

  it('spills to a 1-byte second part at one-over (off-by-one)', () => {
    const ranges = computePartRanges(PS + 1, PS);
    expect(ranges).toHaveLength(2);
    expect(ranges[1]).toEqual({ index: 1, start: PS, end: PS, length: 1 });
    assertTiles(PS + 1, PS);
  });

  it('tiles an exact multiple with equal parts', () => {
    const ranges = computePartRanges(PS * 3, PS);
    expect(ranges.map((r) => r.length)).toEqual([PS, PS, PS]);
    assertTiles(PS * 3, PS);
  });

  it('gives the remainder to the last part', () => {
    assertTiles(PS * 2 + 5, PS);
    const ranges = computePartRanges(PS * 2 + 5, PS);
    expect(ranges[ranges.length - 1]!.length).toBe(5);
  });

  it('never produces zero parts (defensive, even for a 0-byte file)', () => {
    expect(partCountFor(0, PS)).toBe(1);
  });

  it('uses the production 256 MiB part size to bound part count', () => {
    // 50 GB (Takeout max) → 200 parts, comfortably under the Workflows step cap.
    expect(partCountFor(50 * 1024 * 1024 * 1024, PART_SIZE)).toBe(200);
  });
});

describe('PART_STEP_CONFIG', () => {
  it('retries generously with exponential backoff and a wide timeout', () => {
    expect(PART_STEP_CONFIG.retries?.limit).toBe(6);
    expect(PART_STEP_CONFIG.retries?.backoff).toBe('exponential');
    expect(PART_STEP_CONFIG.timeout).toBe('15 minutes');
  });
});

// --- run() orchestration with a fake step + fake context --------------------
//
// The fake step RECORDS step names and RETURNS canned persisted values without
// invoking the callbacks (so the real streaming/R2 bodies never run — that's
// the integration surface). This lets us assert the step SEQUENCE and the
// failure path precisely, which is the behavior that matters.

interface Recorder {
  step: TransferStep;
  names: string[];
}

function fakeStep(opts?: {
  values?: Record<string, unknown>;
  throwAt?: string | string[];
}): Recorder {
  const names: string[] = [];
  const values = opts?.values ?? {};
  const throwSet = new Set(
    opts?.throwAt === undefined ? [] : Array.isArray(opts.throwAt) ? opts.throwAt : [opts.throwAt]
  );
  const doImpl = async (name: string, a: unknown, b?: unknown): Promise<unknown> => {
    names.push(name);
    if (throwSet.has(name)) throw new Error(`boom at ${name}`);
    void a;
    void b;
    return values[name];
  };
  return { step: { do: doImpl } as unknown as TransferStep, names };
}

const params: TransferParams = {
  fileId: 'file-1',
  name: 'takeout-1.zip',
  size: 0, // meta step overrides via the fake's canned value
  md5: 'md5',
  batchKey: 'takeout-1',
  mode: { kind: 'tenant', tenantId: 't1' },
};

// onFileComplete runs INSIDE a step (`step.do('on-complete', …)`), so the
// non-invoking fake represents it by the recorded step name, not an actual
// call. onFileFailed is a DIRECT call on the terminal path, so it IS observable
// here. Its distinct treatment is exactly what we assert.
function fakeContext() {
  const failedCalls: { err: unknown }[] = [];
  const ctx: TransferContext = {
    tokens: { accessToken: async () => 'tok' },
    target: {
      bucket: {} as unknown as R2Bucket, // never touched — the fake step doesn't run bodies
      keyFor: (f) => `staged/${f.batchKey}/${f.name}`,
    },
    selector: {
      driveQuery: 'q',
      accept: () => true,
      batchKey: (n) => n,
      settleAgeSeconds: 3600,
    },
    hooks: {
      onFileComplete: async () => undefined,
      onFileFailed: async (_f, err) => {
        failedCalls.push({ err });
      },
    },
  };
  return { ctx, failedCalls };
}

// The meta step persists {..., partSize} (S4), and runTransfer tiles from that
// PERSISTED partSize, not the compile-time PART_SIZE — so the canned meta value
// must carry it, exactly as the real step's return would.
const metaOf = (size: number, partSize: number = PART_SIZE): DriveFileMeta & { partSize: number } => ({
  id: 'file-1',
  name: 'takeout-1.zip',
  size,
  partSize,
});

describe('runTransfer', () => {
  it('takes the single put path for a file that fits in one part', async () => {
    const { step, names } = fakeStep({ values: { meta: metaOf(10) } });
    const { ctx } = fakeContext();

    await runTransfer(ctx, params, step);

    expect(names).toEqual(['meta', 'put', 'verify', 'trash', 'on-complete']);
    expect(names).not.toContain('create');
    // keyFor is the layout contract discovery and the workflow share.
    expect(ctx.target.keyFor(params)).toBe('staged/takeout-1/takeout-1.zip');
  });

  it('runs meta→create→part-*→complete→trash→on-complete for a multipart file', async () => {
    const size = PART_SIZE * 2 + 5; // 3 parts
    const { step, names } = fakeStep({
      values: { meta: metaOf(size), create: 'upload-xyz' },
    });
    const { ctx } = fakeContext();

    await runTransfer(ctx, params, step);

    expect(names).toEqual([
      'meta',
      'create',
      'part-0',
      'part-1',
      'part-2',
      'complete',
      'verify',
      'trash',
      'on-complete',
    ]);
    // trash runs only after the object is durably complete.
    expect(names.indexOf('complete')).toBeLessThan(names.indexOf('trash'));
  });

  it('aborts the multipart, fires onFileFailed, and rethrows on a terminal part failure', async () => {
    const size = PART_SIZE * 3;
    const { step, names } = fakeStep({
      values: { meta: metaOf(size), create: 'upload-xyz' },
      throwAt: 'part-1',
    });
    const { ctx, failedCalls } = fakeContext();

    await expect(runTransfer(ctx, params, step)).rejects.toThrow('boom at part-1');

    expect(names).toEqual(['meta', 'create', 'part-0', 'part-1', 'abort']);
    expect(failedCalls).toHaveLength(1);
    expect(names).not.toContain('complete'); // never completed
    expect(names).not.toContain('trash');
    expect(names).not.toContain('on-complete');
  });

  it('does NOT abort when there is no multipart yet (single-part failure)', async () => {
    const { step, names } = fakeStep({ values: { meta: metaOf(10) }, throwAt: 'put' });
    const { ctx, failedCalls } = fakeContext();

    await expect(runTransfer(ctx, params, step)).rejects.toThrow('boom at put');
    expect(names).toEqual(['meta', 'put']); // no 'abort' — nothing to clean up
    expect(failedCalls).toHaveLength(1);
  });

  it('tiles from the PERSISTED meta.partSize, not the compile-time PART_SIZE (S4)', async () => {
    // meta carries partSize=40 for a 100-byte file → 3 parts. Had the code used
    // PART_SIZE (256 MiB) it would have taken the single-put path (1 part) — so
    // this asserts the persisted value wins, which is what protects a resumed
    // transfer from a mid-flight PART_SIZE deploy change.
    const { step, names } = fakeStep({
      values: { meta: metaOf(100, 40), create: 'upload-xyz' },
    });
    const { ctx } = fakeContext();

    await runTransfer(ctx, params, step);

    expect(names).toEqual(['meta', 'create', 'part-0', 'part-1', 'part-2', 'complete', 'verify', 'trash', 'on-complete']);
  });

  it('still fires onFileFailed and rethrows the ORIGINAL error when abort itself fails (S5)', async () => {
    const size = PART_SIZE * 3;
    const { step, names } = fakeStep({
      values: { meta: metaOf(size), create: 'upload-xyz' },
      throwAt: ['part-1', 'abort'], // the part fails terminally AND the abort fails
    });
    const { ctx, failedCalls } = fakeContext();

    // The rejection is the part failure, not the abort failure — abort's error
    // must not mask it.
    await expect(runTransfer(ctx, params, step)).rejects.toThrow('boom at part-1');
    expect(names).toEqual(['meta', 'create', 'part-0', 'part-1', 'abort']);
    expect(failedCalls).toHaveLength(1); // onFileFailed ran despite the abort failure
  });
});

// verifyStaged is the safety net that once failed: an upload "succeeded" but
// left a 0-byte object, and the file was trashed anyway. These assert it now
// refuses that case (a mismatch/missing object throws so trash never runs).
describe('verifyStaged', () => {
  const ctxWithHead = (head: { size: number } | undefined): TransferContext => ({
    tokens: { accessToken: async () => 'tok' },
    target: {
      bucket: { head: async () => head } as unknown as R2Bucket,
      keyFor: (f) => f.name,
    },
    selector: { driveQuery: 'q', accept: () => true, batchKey: (n) => n, settleAgeSeconds: 3600 },
    hooks: { onFileComplete: async () => {} },
  });

  it('passes when the staged object is exactly the expected size', async () => {
    await expect(verifyStaged(ctxWithHead({ size: 100 }), 'k', 100)).resolves.toBeUndefined();
  });

  it('throws when the object is missing', async () => {
    await expect(verifyStaged(ctxWithHead(undefined), 'k', 100)).rejects.toThrow(/missing/);
  });

  it('throws on a size mismatch — the production 0-byte case', async () => {
    await expect(verifyStaged(ctxWithHead({ size: 0 }), 'k', 100)).rejects.toThrow(
      /size 0 != expected 100/
    );
  });
});
