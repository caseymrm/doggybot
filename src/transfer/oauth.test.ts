import { describe, expect, it } from 'vitest';
import { CachingTokenSource, exchangeRefreshToken, refreshTokenSource } from './oauth';
import { DriveAuthRevokedError } from './types';
import type { MintedToken } from './oauth';

const creds = { clientId: 'id', clientSecret: 'secret', refreshToken: 'rt' };

/** A fetch stub that returns one canned JSON response and records the call. */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('exchangeRefreshToken', () => {
  it('posts the refresh grant to the Google token endpoint', async () => {
    const { impl, calls } = stubFetch(200, { access_token: 'at', expires_in: 3600 });
    const out = await exchangeRefreshToken(creds, { fetch: impl });
    expect(out).toEqual({ accessToken: 'at', expiresInSeconds: 3600 });
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    const body = calls[0]!.init!.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt');
    expect(params.get('client_id')).toBe('id');
  });

  it('defaults expiry to 3600s when the response omits expires_in', async () => {
    const { impl } = stubFetch(200, { access_token: 'at' });
    expect((await exchangeRefreshToken(creds, { fetch: impl })).expiresInSeconds).toBe(3600);
  });

  it('maps invalid_grant to a terminal DriveAuthRevokedError', async () => {
    const { impl } = stubFetch(400, { error: 'invalid_grant', error_description: 'Token revoked' });
    await expect(exchangeRefreshToken(creds, { fetch: impl })).rejects.toBeInstanceOf(
      DriveAuthRevokedError
    );
  });

  it('surfaces other errors as a plain (retryable) Error, not auth-revoked', async () => {
    const { impl } = stubFetch(500, { error: 'internal_failure' });
    const err = await exchangeRefreshToken(creds, { fetch: impl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DriveAuthRevokedError);
  });

  it('treats a 200 with no access_token as an error', async () => {
    const { impl } = stubFetch(200, {});
    await expect(exchangeRefreshToken(creds, { fetch: impl })).rejects.toBeInstanceOf(Error);
  });
});

describe('CachingTokenSource', () => {
  it('mints once, then serves the cached token until near expiry', async () => {
    let mints = 0;
    let clock = 0;
    const mint = async (): Promise<MintedToken> => {
      mints++;
      return { accessToken: `tok-${mints}`, expiresInSeconds: 3600 };
    };
    const src = new CachingTokenSource(mint, () => clock);

    expect(await src.accessToken()).toBe('tok-1');
    clock = 3000 * 1000; // 3000s < 3600-60 → still cached
    expect(await src.accessToken()).toBe('tok-1');
    expect(mints).toBe(1);
  });

  it('re-mints once the cached token passes the expiry-minus-skew mark', async () => {
    let mints = 0;
    let clock = 0;
    const mint = async (): Promise<MintedToken> => {
      mints++;
      return { accessToken: `tok-${mints}`, expiresInSeconds: 3600 };
    };
    const src = new CachingTokenSource(mint, () => clock);

    await src.accessToken(); // tok-1, expires (3600-60)*1000 = 3540000
    clock = 3540 * 1000; // exactly at the skew boundary → re-mint
    expect(await src.accessToken()).toBe('tok-2');
    expect(mints).toBe(2);
  });

  it('propagates a terminal DriveAuthRevokedError from the minter (no caching)', async () => {
    const src = new CachingTokenSource(async () => {
      throw new DriveAuthRevokedError();
    });
    await expect(src.accessToken()).rejects.toBeInstanceOf(DriveAuthRevokedError);
  });
});

describe('refreshTokenSource', () => {
  it('caches an exchanged token across calls', async () => {
    const { impl, calls } = stubFetch(200, { access_token: 'at', expires_in: 3600 });
    const src = refreshTokenSource(creds, { fetch: impl });
    expect(await src.accessToken()).toBe('at');
    expect(await src.accessToken()).toBe('at');
    expect(calls).toHaveLength(1); // second call served from cache, no exchange
  });
});
