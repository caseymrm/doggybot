/* Refresh-token → access-token exchange + a caching token source. A standard
 * Google OAuth refresh-token exchange, kept free of deployment-specific imports
 * — a deployment builds its own token source on top of these primitives. */
import { z } from 'zod';
import {
  DriveAuthRevokedError,
  TOKEN_EXPIRY_SKEW_SECONDS,
  type DriveTokenSource,
} from './types';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Boundary parse of the token endpoint's JSON — every field optional so a
// malformed/`error` body still parses and we branch on what's present.
const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export interface MintedToken {
  accessToken: string;
  expiresInSeconds: number;
}

export interface RefreshCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface OAuthDeps {
  /** Injectable for tests; defaults to the runtime's global fetch. */
  fetch?: typeof fetch;
}

/** Exchange a refresh token for a short-lived access token. `invalid_grant`
 *  (revoked / aged-out grant) maps to the terminal DriveAuthRevokedError;
 *  everything else throws a plain Error (retryable at the step level). */
export async function exchangeRefreshToken(
  creds: RefreshCredentials,
  deps?: OAuthDeps
): Promise<MintedToken> {
  // Bind to globalThis: a detached native `fetch` throws "Illegal invocation".
  // Tests inject their own fetch, so this fallback only runs in production.
  const doFetch = deps?.fetch ?? fetch.bind(globalThis);
  const resp = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const parsed = tokenResponseSchema.safeParse(await resp.json().catch(() => ({})));
  const body = parsed.success ? parsed.data : {};
  if (body.error === 'invalid_grant') {
    throw new DriveAuthRevokedError(body.error_description ?? 'invalid_grant');
  }
  if (!resp.ok || !body.access_token) {
    throw new Error(
      `token exchange failed: HTTP ${resp.status}${body.error ? ` (${body.error})` : ''}`
    );
  }
  return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3600 };
}

export type TokenMinter = () => Promise<MintedToken>;

/** Caches a minted token until TOKEN_EXPIRY_SKEW_SECONDS before its stated
 *  expiry, then re-mints transparently. `now` is injectable for tests. A
 *  thrown DriveAuthRevokedError propagates and is not cached. */
export class CachingTokenSource implements DriveTokenSource {
  private cached?: { token: string; expiresAtMs: number };

  constructor(
    private readonly mint: TokenMinter,
    private readonly now: () => number = Date.now
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs) {
      return this.cached.token;
    }
    const { accessToken, expiresInSeconds } = await this.mint();
    this.cached = {
      token: accessToken,
      expiresAtMs: this.now() + (expiresInSeconds - TOKEN_EXPIRY_SKEW_SECONDS) * 1000,
    };
    return accessToken;
  }
}

/** The standalone token source: refresh-token exchange behind the cache. */
export function refreshTokenSource(
  creds: RefreshCredentials,
  deps?: OAuthDeps & { now?: () => number }
): CachingTokenSource {
  return new CachingTokenSource(() => exchangeRefreshToken(creds, deps), deps?.now);
}
