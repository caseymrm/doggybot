#!/usr/bin/env node
/*
 * One-time helper: obtain a Google OAuth **refresh token** for doggybot.
 *
 * doggybot runs unattended, so it needs a long-lived refresh token (not the
 * short-lived access token a normal login gives you). This script runs the
 * standard OAuth "Desktop app" loopback flow entirely on your machine:
 *
 *   1. opens the Google consent screen in your browser,
 *   2. catches the redirect on http://127.0.0.1:<port> (Google auto-allows
 *      loopback redirects for Desktop clients — no redirect URI to register),
 *   3. exchanges the code for tokens and prints the refresh_token.
 *
 * Then store it as a Worker secret (it is NEVER written to disk here):
 *
 *   wrangler secret put GOOGLE_REFRESH_TOKEN
 *
 * Zero dependencies (Node built-ins only).
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/get-refresh-token.mjs
 * or:
 *   node scripts/get-refresh-token.mjs --client-id xxx --client-secret yyy
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

// Read-only Drive access is all doggybot needs: list, download, and trash.
// `drive` (full) is required because trashing a file is a write; if you would
// rather doggybot never trash (leave cleanup to you), swap to
// `drive.readonly` and the transfer still works — the trash step will just
// fail and the file stays in Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const clientId = arg('--client-id') ?? process.env.GOOGLE_CLIENT_ID;
const clientSecret = arg('--client-secret') ?? process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    'Missing credentials. Provide them via env or flags:\n' +
      '  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs\n' +
      '  node scripts/get-refresh-token.mjs --client-id ... --client-secret ...'
  );
  process.exit(1);
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on(
    'error',
    () => {}
  );
}

async function exchange(code, redirectUri) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = await resp.json();
  if (!resp.ok) {
    throw new Error(`token exchange failed: HTTP ${resp.status} ${JSON.stringify(body)}`);
  }
  return body;
}

const state = randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
  if (url.pathname !== '/') {
    res.writeHead(404).end();
    return;
  }
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');

  if (err) {
    res.writeHead(400).end(`Authorization failed: ${err}`);
    console.error(`\nAuthorization failed: ${err}`);
    server.close();
    process.exit(1);
  }
  if (gotState !== state) {
    res.writeHead(400).end('State mismatch — aborting.');
    console.error('\nState mismatch — possible CSRF; aborting.');
    server.close();
    process.exit(1);
  }

  try {
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const token = await exchange(code, redirectUri);
    res.writeHead(200, { 'content-type': 'text/plain' }).end(
      'doggybot: got your refresh token. You can close this tab and return to the terminal.'
    );
    if (!token.refresh_token) {
      console.error(
        '\nNo refresh_token in the response. This usually means you have granted\n' +
          'consent before. Revoke doggybot at https://myaccount.google.com/permissions\n' +
          'and run this again (the script forces prompt=consent to avoid this).'
      );
      server.close();
      process.exit(1);
    }
    console.log('\n Success. Your refresh token (store it as a secret, do NOT commit):\n');
    console.log(token.refresh_token);
    console.log('\nNext:\n  wrangler secret put GOOGLE_REFRESH_TOKEN\n  (paste the value above)\n');
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end(String(e));
    console.error(`\n${e}`);
    server.close();
    process.exit(1);
  }
});

// Port 0 = let the OS pick a free port; Google accepts any loopback port for a
// Desktop client, so nothing needs to be registered ahead of time.
server.listen(0, '127.0.0.1', () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline'); // ask for a refresh token
  authUrl.searchParams.set('prompt', 'consent'); // force it even on re-consent
  authUrl.searchParams.set('state', state);

  console.log('Opening your browser to authorize doggybot...');
  console.log('If it does not open, visit this URL manually:\n');
  console.log(authUrl.toString(), '\n');
  openBrowser(authUrl.toString());
});
