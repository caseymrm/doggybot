import { describe, expect, it } from 'vitest';
import { runDiscovery } from './discovery';
import { takeoutSelector } from './batch';
import type { DriveApi } from './drive';
import type {
  DriveFileMeta,
  DriveTokenSource,
  TransferContext,
  TransferMode,
  TransferParams,
} from './types';

const NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // fixed clock so settle is not wall-clock dependent
const HOUR = 3600 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const tenantMode: TransferMode = { kind: 'tenant', tenantId: 't1' };
const tokens: DriveTokenSource = { accessToken: async () => 'tok' };

/** A fake Drive returning a canned list and recording trashes. */
function fakeDrive(files: DriveFileMeta[]) {
  const trashed: string[] = [];
  const drive: DriveApi = {
    list: async () => files,
    trash: async (id) => {
      trashed.push(id);
    },
    fileMeta: async () => {
      throw new Error('not used in discovery');
    },
    rangeRequest: async () => {
      throw new Error('not used in discovery');
    },
    download: async () => {
      throw new Error('not used in discovery');
    },
  };
  return { drive, trashed };
}

/** A fake R2 bucket whose head() reports the given keys as present at a size. */
function fakeBucket(present: Record<string, number>) {
  return {
    head: async (key: string) => {
      const size = present[key];
      return size === undefined ? null : ({ size } as unknown as R2Object);
    },
  } as unknown as R2Bucket;
}

/** A fake Workflow binding: records created ids, throws already-exists on dup. */
function fakeBinding(existing: string[] = []) {
  const created: TransferParams[] = [];
  const ids = new Set(existing);
  const binding = {
    create: async (opts: { id?: string; params?: TransferParams }) => {
      const id = opts.id!;
      if (ids.has(id)) throw new Error(`instance ${id} already exists`);
      ids.add(id);
      created.push(opts.params!);
      return {} as unknown as WorkflowInstance;
    },
  } as unknown as Workflow<TransferParams>;
  return { binding, created };
}

function harness(opts: {
  files: DriveFileMeta[];
  present?: Record<string, number>;
  existing?: string[];
}) {
  const { drive, trashed } = fakeDrive(opts.files);
  const { binding, created } = fakeBinding(opts.existing);
  const completed: TransferParams[] = [];
  const ctx: TransferContext = {
    tokens,
    target: {
      bucket: fakeBucket(opts.present ?? {}),
      keyFor: (f) => `staged/${f.batchKey}/${f.name}`,
    },
    selector: takeoutSelector,
    hooks: {
      onFileComplete: async (f) => {
        completed.push(f);
      },
    },
  };
  const run = () =>
    runDiscovery<unknown>(
      {},
      async () => ctx,
      () => binding,
      [tenantMode],
      { now: () => NOW, driveFor: () => drive }
    );
  return { run, trashed, created, completed };
}

const zip = (name: string, size: number, createdMsAgo: number): DriveFileMeta => ({
  id: `id-${name}`,
  name,
  size,
  createdTime: ago(createdMsAgo),
});

describe('runDiscovery', () => {
  it('skips a batch whose newest file is younger than the settle age', async () => {
    // Two zips of one export, newest 30 min old → still uploading → whole batch waits.
    const h = harness({
      files: [
        zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR),
        zip('takeout-20260721T100000Z-002.zip', 100, 30 * 60 * 1000),
      ],
    });
    const summary = await h.run();
    expect(summary.created).toBe(0);
    expect(summary.skippedSettling).toBe(2);
    expect(h.created).toHaveLength(0);
    expect(h.trashed).toHaveLength(0);
  });

  it('creates one instance per fresh, settled file — keyed by Drive file id', async () => {
    const h = harness({ files: [zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR)] });
    const summary = await h.run();

    expect(summary.created).toBe(1);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.fileId).toBe('id-takeout-20260721T100000Z-001.zip');
    expect(h.created[0]!.batchKey).toBe('takeout-20260721t100000z');
    expect(h.created[0]!.mode).toEqual(tenantMode);
    expect(h.trashed).toHaveLength(0);
  });

  it('finishes a stranded transfer: R2 object already present at matching size → trash + hook, no instance', async () => {
    // The "complete succeeded, trash failed" case (design §3): don't re-upload.
    const h = harness({
      files: [zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR)],
      present: { 'staged/takeout-20260721t100000z/takeout-20260721T100000Z-001.zip': 100 },
    });
    const summary = await h.run();

    expect(summary.finishedAlreadyStaged).toBe(1);
    expect(summary.created).toBe(0);
    expect(h.created).toHaveLength(0);
    expect(h.trashed).toEqual(['id-takeout-20260721T100000Z-001.zip']);
    expect(h.completed).toHaveLength(1);
  });

  it('re-uploads when the R2 object is present but the size disagrees', async () => {
    const h = harness({
      files: [zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR)],
      present: { 'staged/takeout-20260721t100000z/takeout-20260721T100000Z-001.zip': 99 },
    });
    const summary = await h.run();
    expect(summary.created).toBe(1);
    expect(summary.finishedAlreadyStaged).toBe(0);
  });

  it('skips a file whose instance already exists (the id IS the lock)', async () => {
    const h = harness({
      files: [zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR)],
      existing: ['id-takeout-20260721T100000Z-001.zip'],
    });
    const summary = await h.run();
    expect(summary.created).toBe(0);
    expect(summary.skippedInFlight).toBe(1);
    expect(h.created).toHaveLength(0);
  });

  it('ignores files the selector rejects (bare-token query false positives)', async () => {
    const h = harness({
      files: [
        zip('takeout-notes.pdf', 100, 2 * HOUR),
        zip('mytakeout.zip', 100, 2 * HOUR),
        zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR),
      ],
    });
    const summary = await h.run();
    expect(summary.scanned).toBe(1); // only the real takeout zip
    expect(summary.created).toBe(1);
  });

  it('isolates a failing mode: one tenant Drive failure does not abort the others (S2)', async () => {
    // Two tenants, bad ordered first. t-bad's Drive list throws (revoked grant);
    // t-good must still process its file, and the failure is recorded per-mode
    // rather than propagated. Route drives by a distinct tokens object per mode.
    const badMode: TransferMode = { kind: 'tenant', tenantId: 't-bad' };
    const goodMode: TransferMode = { kind: 'tenant', tenantId: 't-good' };
    const badTokens: DriveTokenSource = { accessToken: async () => 'bad' };
    const goodTokens: DriveTokenSource = { accessToken: async () => 'good' };

    const { drive: goodDrive, trashed: goodTrashed } = fakeDrive([
      zip('takeout-20260721T100000Z-001.zip', 100, 2 * HOUR),
    ]);
    void goodTrashed;
    const badDrive: DriveApi = {
      ...goodDrive,
      list: async () => {
        throw new Error('drive_auth_revoked');
      },
    };
    const { binding, created } = fakeBinding();

    const ctxFor = (mode: TransferMode): TransferContext => ({
      tokens: mode.kind === 'tenant' && mode.tenantId === 't-bad' ? badTokens : goodTokens,
      target: { bucket: fakeBucket({}), keyFor: (f) => `staged/${f.batchKey}/${f.name}` },
      selector: takeoutSelector,
      hooks: { onFileComplete: async () => undefined },
    });

    const summary = await runDiscovery<unknown>(
      {},
      async (_env, mode) => ctxFor(mode),
      () => binding,
      [badMode, goodMode],
      { now: () => NOW, driveFor: (t) => (t === badTokens ? badDrive : goodDrive) }
    );

    // The bad mode is recorded, the good mode still ran to completion.
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.mode).toEqual(badMode);
    expect(summary.errors[0]!.error).toContain('drive_auth_revoked');
    expect(summary.created).toBe(1);
    expect(created).toHaveLength(1);
  });
});
