/* Google Drive v3 REST client — exactly the four calls the engine needs
 * (files.list, files.get metadata, files.get?alt=media with Range, files.update
 * trash). Ported from a Go Drive client; Range-GET is new (the Workflows step
 * is the resume unit, so each part fetches its own byte range). */
import { z } from 'zod';
import { DriveFileGoneError, type DriveFileMeta, type DriveTokenSource } from './types';

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

// Boundary parse of Drive's file JSON. `size` is an int64-as-string and is
// absent for folders / Docs; md5Checksum and createdTime are absent on some
// resources. All optional — callers enforce what they require.
const driveFileJsonSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.string().optional(),
  md5Checksum: z.string().optional(),
  createdTime: z.string().optional(),
});
type DriveFileJson = z.infer<typeof driveFileJsonSchema>;

const driveListPageSchema = z.object({
  nextPageToken: z.string().optional(),
  files: z.array(driveFileJsonSchema).default([]),
});

function toMeta(j: DriveFileJson): DriveFileMeta {
  return {
    id: j.id,
    name: j.name,
    size: j.size !== undefined ? Number(j.size) : 0,
    md5: j.md5Checksum,
    createdTime: j.createdTime,
  };
}

/** The Drive surface the engine depends on — lets discovery + the workflow be
 *  tested against a fake without HTTP mocking. */
export interface DriveApi {
  list(query: string): Promise<DriveFileMeta[]>;
  fileMeta(fileId: string): Promise<DriveFileMeta>;
  /** A 206 partial-content Response whose body is the requested byte range. */
  rangeRequest(fileId: string, start: number, end: number): Promise<Response>;
  /** The full object body (single-part small-file path). */
  download(fileId: string): Promise<Response>;
  trash(fileId: string): Promise<void>;
}

export interface DriveClientDeps {
  tokens: DriveTokenSource;
  /** Injectable for tests; defaults to the runtime's global fetch. */
  fetch?: typeof fetch;
}

export class DriveClient implements DriveApi {
  private readonly tokens: DriveTokenSource;
  private readonly doFetch: typeof fetch;

  constructor(deps: DriveClientDeps) {
    this.tokens = deps.tokens;
    // Bind to globalThis: the runtime's `fetch` is a native method that throws
    // "Illegal invocation" if called detached from its global receiver (which
    // is exactly what storing it in a field and calling `this.doFetch(...)`
    // does). Tests inject their own fetch so they never hit this fallback.
    this.doFetch = deps.fetch ?? fetch.bind(globalThis);
  }

  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const token = await this.tokens.accessToken();
    return { authorization: `Bearer ${token}`, ...extra };
  }

  async list(query: string): Promise<DriveFileMeta[]> {
    const out: DriveFileMeta[] = [];
    let pageToken: string | undefined;
    do {
      const u = new URL(DRIVE_FILES_URL);
      u.searchParams.set('q', query);
      u.searchParams.set('fields', 'nextPageToken, files(id,name,size,md5Checksum,createdTime)');
      u.searchParams.set('pageSize', '1000');
      u.searchParams.set('spaces', 'drive');
      if (pageToken) u.searchParams.set('pageToken', pageToken);

      const resp = await this.doFetch(u.toString(), { headers: await this.authHeaders() });
      if (!resp.ok) throw new Error(`drive files.list: HTTP ${resp.status}`);
      const page = driveListPageSchema.parse(await resp.json());
      for (const f of page.files) out.push(toMeta(f));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async fileMeta(fileId: string): Promise<DriveFileMeta> {
    const u = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    u.searchParams.set('fields', 'id,name,size,md5Checksum');
    const resp = await this.doFetch(u.toString(), { headers: await this.authHeaders() });
    if (resp.status === 404) throw new DriveFileGoneError();
    if (!resp.ok) throw new Error(`drive files.get meta: HTTP ${resp.status}`);
    const j = driveFileJsonSchema.parse(await resp.json());
    if (j.size === undefined) throw new Error(`drive file ${fileId} has no size`);
    return toMeta(j);
  }

  async rangeRequest(fileId: string, start: number, end: number): Promise<Response> {
    const resp = await this.mediaFetch(fileId, `bytes=${start}-${end}`);
    if (resp.status === 404) throw new DriveFileGoneError();
    // A Range GET must answer 206 with a body. A 200 (full body) or any other
    // status means we did NOT get exactly the bytes we asked for — retryable.
    if (resp.status !== 206 || !resp.body) {
      throw new Error(`drive range ${start}-${end}: HTTP ${resp.status}`);
    }
    return resp;
  }

  async download(fileId: string): Promise<Response> {
    const resp = await this.mediaFetch(fileId, undefined);
    if (resp.status === 404) throw new DriveFileGoneError();
    if (!resp.ok || !resp.body) throw new Error(`drive download: HTTP ${resp.status}`);
    return resp;
  }

  private async mediaFetch(fileId: string, range: string | undefined): Promise<Response> {
    const u = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    u.searchParams.set('alt', 'media');
    // Zips are incompressible; `identity` forbids transfer-encoding so the
    // received byte count equals the Range we asked for (integrity for free).
    const headers = await this.authHeaders(
      range ? { range, 'accept-encoding': 'identity' } : { 'accept-encoding': 'identity' }
    );
    return this.doFetch(u.toString(), { headers });
  }

  async trash(fileId: string): Promise<void> {
    const u = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
    const resp = await this.doFetch(u.toString(), {
      method: 'PATCH',
      headers: await this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ trashed: true }),
    });
    // 404 = the file is already gone: the goal (not in Drive) is met. Idempotent.
    if (resp.status === 404) return;
    if (!resp.ok) throw new Error(`drive trash: HTTP ${resp.status}`);
  }
}
