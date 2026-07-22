import { describe, expect, it } from 'vitest';
import { batchKey, acceptTakeout, takeoutSelector, TAKEOUT_DRIVE_QUERY } from './batch';
import type { DriveFileMeta } from './types';

const file = (name: string): DriveFileMeta => ({ id: name, name, size: 1 });

describe('batchKey', () => {
  it('groups every zip of one export — across split numbering series — under one key', () => {
    // The real 884 GB export spanned two series with the SAME timestamp; they
    // must land in one batch or cross-zip JSON sidecars orphan (design §0).
    const a = batchKey('takeout-20260719T225131Z-001.zip');
    const b = batchKey('takeout-20260719T225131Z-2-014.zip');
    expect(a).toBe('takeout-20260719t225131z');
    expect(b).toBe(a);
  });

  it('is case-insensitive on the timestamp token', () => {
    expect(batchKey('Takeout-20260719T225131Z-001.zip')).toBe('takeout-20260719t225131z');
  });

  it('falls back to the whole name for non-timestamped files (own singleton batch)', () => {
    expect(batchKey('random-archive.zip')).toBe('random-archive.zip');
  });
});

describe('acceptTakeout', () => {
  it('accepts takeout-<...>.zip (case-insensitive)', () => {
    expect(acceptTakeout(file('takeout-20260719T225131Z-001.zip'))).toBe(true);
    expect(acceptTakeout(file('TAKEOUT-20260719T225131Z-001.ZIP'))).toBe(true);
  });

  it('rejects a non-zip takeout file', () => {
    // The bare-token `contains 'takeout'` query catches these; the code shape
    // check is what filters them out (design §3).
    expect(acceptTakeout(file('takeout-notes.pdf'))).toBe(false);
  });

  it('rejects a zip that only ends in "takeout"', () => {
    expect(acceptTakeout(file('mytakeout.zip'))).toBe(false);
  });

  it('rejects a folder-shaped name (no .zip suffix)', () => {
    expect(acceptTakeout(file('takeout-20260719T225131Z'))).toBe(false);
  });
});

describe('takeoutSelector', () => {
  it('queries the bare token (not a mimeType filter, not "takeout-")', () => {
    // Both hard-won Drive gotchas: `contains 'takeout-'` breaks on the
    // trailing hyphen, and the mime is application/x-zip. Query bare + filter in code.
    expect(takeoutSelector.driveQuery).toBe(TAKEOUT_DRIVE_QUERY);
    expect(TAKEOUT_DRIVE_QUERY).toContain("name contains 'takeout'");
    expect(TAKEOUT_DRIVE_QUERY).toContain('trashed = false');
    expect(TAKEOUT_DRIVE_QUERY).not.toContain("'takeout-'");
    expect(TAKEOUT_DRIVE_QUERY).not.toContain('mimeType');
  });

  it('defaults the settle age to one hour', () => {
    expect(takeoutSelector.settleAgeSeconds).toBe(3600);
  });

  it('wires accept + batchKey to the takeout implementations', () => {
    // selector.accept must delegate to acceptTakeout (the bare `===` here
    // previously asserted nothing). Check both a match and a reject so a stubbed
    // `() => true` wouldn't pass.
    const good = file('takeout-1T1Z.zip');
    const bad = file('mytakeout.zip');
    expect(takeoutSelector.accept(good)).toBe(acceptTakeout(good));
    expect(takeoutSelector.accept(good)).toBe(true);
    expect(takeoutSelector.accept(bad)).toBe(acceptTakeout(bad));
    expect(takeoutSelector.accept(bad)).toBe(false);
    expect(takeoutSelector.batchKey('takeout-20260719T225131Z-001.zip')).toBe(
      'takeout-20260719t225131z'
    );
  });
});
