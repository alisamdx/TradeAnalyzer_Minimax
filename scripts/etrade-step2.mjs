/**
 * E*Trade OAuth Step 2 — exchange verifier for access token.
 *
 * Usage:
 *   node scripts/etrade-step2.mjs <verifier>
 *
 * Run etrade-step1.mjs first to get the auth URL and verifier.
 */

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR     = join(homedir(), '.tradeanalyzer');
const TOKEN_FILE   = join(DATA_DIR, 'agent.token');
const PORT_FILE    = join(DATA_DIR, 'api.port');
const STATE_FILE   = join(DATA_DIR, 'etrade-oauth-state.json');
const PENDING_FILE = join(DATA_DIR, 'etrade-tokens-pending.json');

const BASE_URL = 'https://api.etrade.com';

function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function nonce() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
function ts()    { return Math.floor(Date.now() / 1000).toString(); }

function buildAuthHeader(method, url, consumerKey, consumerSecret, tokenKey = '', tokenSecret = '', extraOauth = {}) {
  const params = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts(),
    oauth_version:          '1.0',
    ...extraOauth,
  };
  if (tokenKey) params['oauth_token'] = tokenKey;
  const sorted = Object.keys(params).sort().map(k => `${pct(k)}=${pct(params[k])}`).join('&');
  const base   = `${method.toUpperCase()}&${pct(url)}&${pct(sorted)}`;
  const sig    = createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest('base64');
  params['oauth_signature'] = sig;
  return 'OAuth ' + Object.keys(params).map(k => `${pct(k)}="${pct(params[k])}"`).join(', ');
}

const verifier = process.argv[2]?.trim();
if (!verifier) {
  console.error('\nUsage: node scripts/etrade-step2.mjs <verifier>\n');
  process.exit(1);
}

try {
  if (!existsSync(STATE_FILE)) {
    throw new Error('No OAuth state found. Run etrade-step1.mjs first.');
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));

  // Warn if state is stale (> 5 minutes)
  if (Date.now() - state.createdAt > 5 * 60 * 1000) {
    console.warn('Warning: OAuth state is over 5 minutes old. If this fails, re-run step 1.\n');
  }

  const { consumerKey, consumerSecret, requestToken, requestSecret } = state;

  const res = await fetch(`${BASE_URL}/oauth/access_token`, {
    headers: { Authorization: buildAuthHeader('GET', `${BASE_URL}/oauth/access_token`, consumerKey, consumerSecret, requestToken, requestSecret, { oauth_verifier: verifier }) },
  });
  const p = Object.fromEntries(new URLSearchParams(await res.text()));
  if (!p.oauth_token) throw new Error(`Failed to get access token: ${JSON.stringify(p)}`);

  const accessToken  = p.oauth_token;
  const accessSecret = p.oauth_token_secret;

  // Try to store in the running app; fall back to pending file
  let stored = false;
  if (existsSync(TOKEN_FILE) && existsSync(PORT_FILE)) {
    try {
      const agentToken = readFileSync(TOKEN_FILE, 'utf8').trim();
      const port       = parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10);
      const postRes = await fetch(`http://127.0.0.1:${port}/api/v1/etrade/token`, {
        method:  'POST',
        headers: { 'X-Agent-Token': agentToken, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken, accessSecret }),
        signal:  AbortSignal.timeout(3000),
      });
      const json = await postRes.json();
      if (json.ok) stored = true;
    } catch { /* fall through to pending file */ }
  }

  if (!stored) {
    writeFileSync(PENDING_FILE, JSON.stringify({ accessToken, accessSecret }), { mode: 0o600 });
    console.log('\nTokens saved — will be imported when TradeAnalyzer next starts.\n');
  } else {
    console.log('\nTokens stored in app. E*Trade is ready to use.\n');
  }

  // Clean up state file
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }

} catch (err) {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
}
