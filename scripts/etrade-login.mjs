/**
 * E*Trade CLI login script.
 *
 * Run this from an SSH session on the laptop when your E*Trade access token
 * has expired (midnight ET rollover). It does the full OAuth 1.0a flow in the
 * terminal and pushes the new tokens into the app.
 *
 * Works in two modes:
 *   - App running:     tokens are stored immediately via the API (encrypted)
 *   - App not running: tokens are saved to a pending file; app imports on next launch
 *
 * Usage:
 *   node scripts/etrade-login.mjs
 */

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as rl from 'node:readline/promises';

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR      = join(homedir(), '.tradeanalyzer');
const TOKEN_FILE    = join(DATA_DIR, 'agent.token');
const PORT_FILE     = join(DATA_DIR, 'api.port');
const CONFIG_FILE   = join(DATA_DIR, 'etrade-config.json');
const PENDING_FILE  = join(DATA_DIR, 'etrade-tokens-pending.json');

const BASE_URL = 'https://api.etrade.com';
const AUTH_URL = 'https://us.etrade.com/e/t/etws/authorize';

// ─── OAuth helpers ────────────────────────────────────────────────────────────

function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function nonce() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function ts()    { return Math.floor(Date.now() / 1000).toString(); }

function buildAuthHeader(method, url, consumerKey, consumerSecret, tokenKey = '', tokenSecret = '', extraOauth = {}, query = {}) {
  const params = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts(),
    oauth_version:          '1.0',
    ...extraOauth,
  };
  if (tokenKey) params['oauth_token'] = tokenKey;
  const all    = { ...params, ...query };
  const sorted = Object.keys(all).sort().map(k => `${pct(k)}=${pct(all[k])}`).join('&');
  const base   = `${method.toUpperCase()}&${pct(url.split('?')[0])}&${pct(sorted)}`;
  const sig    = createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest('base64');
  params['oauth_signature'] = sig;
  return 'OAuth ' + Object.keys(params).map(k => `${pct(k)}="${pct(params[k])}"`).join(', ');
}

// ─── App API helpers ──────────────────────────────────────────────────────────

function isAppRunning() {
  return existsSync(TOKEN_FILE) && existsSync(PORT_FILE);
}

async function tryAppGet(path) {
  const agentToken = readFileSync(TOKEN_FILE, 'utf8').trim();
  const port       = parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10);
  const res  = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    headers: { 'X-Agent-Token': agentToken },
    signal: AbortSignal.timeout(3000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return { data: json.data, port, agentToken };
}

async function tryAppPost(port, agentToken, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method:  'POST',
    headers: { 'X-Agent-Token': agentToken, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(3000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const io = rl.createInterface({ input: process.stdin, output: process.stdout });

try {
  console.log('\n=== E*Trade Token Refresh ===\n');

  // Get consumer credentials — try live app first, fall back to config file
  let consumerKey, consumerSecret, livePort, liveToken;

  if (isAppRunning()) {
    try {
      const result = await tryAppGet('/etrade/credentials');
      consumerKey    = result.data.consumerKey;
      consumerSecret = result.data.consumerSecret;
      livePort       = result.port;
      liveToken      = result.agentToken;
      console.log('App is running — tokens will be stored immediately.');
    } catch {
      // App files exist but server not responding — fall through to config file
    }
  }

  if (!consumerKey) {
    if (!existsSync(CONFIG_FILE)) {
      throw new Error(
        `App is not running and no config file found at ${CONFIG_FILE}.\n` +
        `Start TradeAnalyzer once to generate the config file, then re-run this script.`
      );
    }
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    consumerKey    = cfg.consumerKey;
    consumerSecret = cfg.consumerSecret;
    console.log('App is offline — tokens will be stored on next app launch.');
  }

  console.log(`Consumer key: ${consumerKey.slice(0, 8)}...`);

  // Step 1: Request token
  process.stdout.write('\nFetching request token... ');
  const r1 = await fetch(`${BASE_URL}/oauth/request_token`, {
    headers: { Authorization: buildAuthHeader('GET', `${BASE_URL}/oauth/request_token`, consumerKey, consumerSecret, '', '', { oauth_callback: 'oob' }) },
  });
  const p1 = Object.fromEntries(new URLSearchParams(await r1.text()));
  if (!p1.oauth_token) throw new Error(`E*Trade request token failed: ${JSON.stringify(p1)}`);
  console.log('done.');

  // Step 2: User authorizes in browser
  const authUrl = `${AUTH_URL}?key=${encodeURIComponent(consumerKey)}&token=${encodeURIComponent(p1.oauth_token)}`;
  console.log(`\nOpen this URL in your browser:\n\n  ${authUrl}\n`);

  const verifier = (await io.question('Paste the verifier code: ')).trim();
  if (!verifier) throw new Error('No verifier entered');

  // Step 3: Exchange for access token
  process.stdout.write('\nExchanging verifier for access token... ');
  const r2 = await fetch(`${BASE_URL}/oauth/access_token`, {
    headers: { Authorization: buildAuthHeader('GET', `${BASE_URL}/oauth/access_token`, consumerKey, consumerSecret, p1.oauth_token, p1.oauth_token_secret, { oauth_verifier: verifier }) },
  });
  const p2 = Object.fromEntries(new URLSearchParams(await r2.text()));
  if (!p2.oauth_token) throw new Error(`E*Trade access token failed: ${JSON.stringify(p2)}`);
  console.log('done.');

  const accessToken  = p2.oauth_token;
  const accessSecret = p2.oauth_token_secret;

  // Step 4: Store tokens
  process.stdout.write('Storing tokens... ');
  if (livePort && liveToken) {
    await tryAppPost(livePort, liveToken, '/etrade/token', { accessToken, accessSecret });
    console.log('stored in app.');
  } else {
    writeFileSync(PENDING_FILE, JSON.stringify({ accessToken, accessSecret }), { mode: 0o600 });
    console.log('saved — will be imported when app starts.');
  }

  console.log('\nDone. E*Trade token valid until midnight ET.\n');
} catch (err) {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
} finally {
  io.close();
}
