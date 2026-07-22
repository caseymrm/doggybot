/* The default Takeout selector: the Drive query, the real-shape acceptance
 * predicate, and the export-batch grouping. Ported verbatim from a Go Takeout
 * puller so the serverless engine reproduces its hard-won Drive behavior
 * exactly. */
import { DEFAULT_SETTLE_AGE_SECONDS, type DriveFileMeta, type TransferSelector } from './types';

/** Bare token `takeout`, not `takeout-` (Drive tokenizes and the trailing
 *  hyphen breaks the match) and not a mimeType filter (Takeout zips are
 *  `application/x-zip`, so a mime equality filter matched ZERO files). The real
 *  shape is enforced by `acceptTakeout` in code. See design §0/§3. */
export const TAKEOUT_DRIVE_QUERY = "name contains 'takeout' and trashed = false";

/** Captures the export identity — the timestamp — shared by every zip of ONE
 *  Takeout export. Google splits a large export across multiple numbering
 *  series (`…-001.zip` AND `…-2-014.zip`, same timestamp), and a photo can land
 *  in a different zip than its JSON sidecar. Grouping on the timestamp (not the
 *  last hyphen, which would split one export in two) keeps one export as one
 *  batch. Ported from takeoutBatchRe. */
const takeoutBatchRe = /^(takeout-\d{8}t\d{6}z)/i;

/** The export-batch identity for a Takeout archive name; a non-matching name
 *  becomes its own singleton batch (defensive — process it rather than drop it). */
export function batchKey(name: string): string {
  const m = takeoutBatchRe.exec(name);
  return m ? m[1]!.toLowerCase() : name;
}

/** Real-shape enforcement: `takeout-*.zip`, case-insensitive. Rejects the
 *  non-zip files and the `*takeout.zip` false positives that the bare-token
 *  query lets through, plus folders (no `.zip` suffix). */
export function acceptTakeout(file: DriveFileMeta): boolean {
  const n = file.name.toLowerCase();
  return n.startsWith('takeout-') && n.endsWith('.zip');
}

export const takeoutSelector: TransferSelector = {
  driveQuery: TAKEOUT_DRIVE_QUERY,
  accept: acceptTakeout,
  batchKey,
  settleAgeSeconds: DEFAULT_SETTLE_AGE_SECONDS,
};
