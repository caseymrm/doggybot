import { describe, expect, it } from 'vitest';
import { DriveClient } from './drive';
import { DriveFileGoneError } from './types';
import type { DriveTokenSource } from './types';

const tokens: DriveTokenSource = { accessToken: async () => 'ACCESS' };

interface Call {
  url: string;
  init?: RequestInit;
}

/** Build a DriveClient whose fetch returns queued responses and records calls. */
function client(responses: Response[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[i++];
    if (!r) throw new Error('unexpected extra fetch');
    return r;
  }) as unknown as typeof fetch;
  return { drive: new DriveClient({ tokens, fetch: impl }), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.[name];
}

describe('DriveClient.list', () => {
  it('builds the files.list query and follows nextPageToken', async () => {
    const { drive, calls } = client([
      json(200, {
        nextPageToken: 'PAGE2',
        files: [
          { id: 'a', name: 'takeout-1.zip', size: '10', md5Checksum: 'm1', createdTime: 't1' },
        ],
      }),
      json(200, {
        files: [{ id: 'b', name: 'takeout-2.zip', size: '20' }],
      }),
    ]);

    const out = await drive.list("name contains 'takeout' and trashed = false");

    expect(out).toEqual([
      { id: 'a', name: 'takeout-1.zip', size: 10, md5: 'm1', createdTime: 't1' },
      { id: 'b', name: 'takeout-2.zip', size: 20, md5: undefined, createdTime: undefined },
    ]);
    expect(calls).toHaveLength(2); // paginated

    const u1 = new URL(calls[0]!.url);
    expect(u1.pathname).toBe('/drive/v3/files');
    expect(u1.searchParams.get('q')).toBe("name contains 'takeout' and trashed = false");
    expect(u1.searchParams.get('pageSize')).toBe('1000');
    expect(u1.searchParams.get('spaces')).toBe('drive');
    expect(u1.searchParams.get('fields')).toContain('nextPageToken');
    expect(u1.searchParams.get('pageToken')).toBeNull();
    expect(headerOf(calls[0]!.init, 'authorization')).toBe('Bearer ACCESS');

    // Page 2 carries the token from page 1.
    expect(new URL(calls[1]!.url).searchParams.get('pageToken')).toBe('PAGE2');
  });
});

describe('DriveClient.fileMeta', () => {
  it('parses size (string→number) and md5', async () => {
    const { drive } = client([
      json(200, { id: 'a', name: 'takeout-1.zip', size: '884000', md5Checksum: 'abc' }),
    ]);
    expect(await drive.fileMeta('a')).toEqual({
      id: 'a',
      name: 'takeout-1.zip',
      size: 884000,
      md5: 'abc',
      createdTime: undefined,
    });
  });

  it('maps 404 to DriveFileGoneError (terminal)', async () => {
    const { drive } = client([json(404, {})]);
    await expect(drive.fileMeta('gone')).rejects.toBeInstanceOf(DriveFileGoneError);
  });

  it('throws when the file has no size (anomaly, not a takeout zip)', async () => {
    const { drive } = client([json(200, { id: 'a', name: 'folder' })]);
    await expect(drive.fileMeta('a')).rejects.toBeInstanceOf(Error);
  });
});

describe('DriveClient.rangeRequest', () => {
  it('sets an inclusive byte Range and forbids transfer-encoding', async () => {
    const { drive, calls } = client([new Response('bytes', { status: 206 })]);
    const resp = await drive.rangeRequest('a', 0, 99);
    expect(resp.status).toBe(206);

    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('alt')).toBe('media');
    expect(headerOf(calls[0]!.init, 'range')).toBe('bytes=0-99');
    expect(headerOf(calls[0]!.init, 'accept-encoding')).toBe('identity');
    expect(headerOf(calls[0]!.init, 'authorization')).toBe('Bearer ACCESS');
  });

  it('maps 404 to DriveFileGoneError', async () => {
    const { drive } = client([new Response(null, { status: 404 })]);
    await expect(drive.rangeRequest('gone', 0, 99)).rejects.toBeInstanceOf(DriveFileGoneError);
  });

  it('treats a non-206 (e.g. a 200 full body, or a 5xx) as a retryable Error', async () => {
    const a = client([new Response('x', { status: 200 })]);
    await expect(a.drive.rangeRequest('a', 0, 99)).rejects.toBeInstanceOf(Error);
    await expect(a.drive.rangeRequest('a', 0, 99)).rejects.not.toBeInstanceOf(DriveFileGoneError);

    const b = client([new Response('x', { status: 503 })]);
    await expect(b.drive.rangeRequest('a', 0, 99)).rejects.toBeInstanceOf(Error);
  });
});

describe('DriveClient.trash', () => {
  it('PATCHes files/<id> with {trashed:true}', async () => {
    const { drive, calls } = client([new Response(null, { status: 200 })]);
    await drive.trash('file-1');
    expect(calls[0]!.init!.method).toBe('PATCH');
    expect(new URL(calls[0]!.url).pathname).toBe('/drive/v3/files/file-1');
    expect(calls[0]!.init!.body).toBe(JSON.stringify({ trashed: true }));
    expect(headerOf(calls[0]!.init, 'content-type')).toBe('application/json');
  });

  it('treats a 404 as success (the file is already gone — trash is idempotent)', async () => {
    const { drive } = client([new Response(null, { status: 404 })]);
    await expect(drive.trash('file-1')).resolves.toBeUndefined();
  });

  it('throws on other non-2xx', async () => {
    const { drive } = client([new Response(null, { status: 500 })]);
    await expect(drive.trash('file-1')).rejects.toBeInstanceOf(Error);
  });
});
