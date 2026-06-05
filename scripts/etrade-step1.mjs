/**
 * E*Trade OAuth Step 1 — get request token and print auth URL.
 *
 * Usage (SSH terminal or Claude Code on phone):
 *   node scripts/etrade-step1.mjs
 *
 * Open the printed URL in your browser, authorize, then run:
 *   node scripts/etrade-step2.mjs <verifier>
 */

import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR    = join(homedir(), '.tradeanalyzer');
const TOKEN_FILE  = join(DATA_DIR, 'agent.token');
const PORT_FILE   = join(DATA_DIR, 'api.port');
const CONFIG_FILE = join(DATA_DIR, 'etrade-config.json');
const STATE_FILE  = join(DATA_DIR, 'etrade-oauth-state.json');

const BASE_URL = 'https://api.etrade.com';
const AUTH_URL = 'https://us.etrade.com/e/t/etws/authorize';

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

async function getConsumerCreds() {
  if (existsSync(TOKEN_FILE) && existsSync(PORT_FILE)) {
    try {
      const agentToken = readFileSync(TOKEN_FILE, 'utf8').trim();
      const port       = parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10);
      const res  = await fetch(`http://127.0.0.1:${port}/api/v1/etrade/credentials`, {
        headers: { 'X-Agent-Token': agentToken },
        signal: AbortSignal.timeout(3000),
      });
      const json = await res.json();
      if (json.ok) return json.data;
    } catch { /* fall through */ }
  }
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`No config file at ${CONFIG_FILE}. Start TradeAnalyzer once to generate it.`);
  }
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

try {
  const { consumerKey, consumerSecret } = await getConsumerCreds();

  const res = await fetch(`${BASE_URL}/oauth/request_token`, {
    headers: { Authorization: buildAuthHeader('GET', `${BASE_URL}/oauth/request_token`, consumerKey, consumerSecret, '', '', { oauth_callback: 'oob' }) },
  });
  const p = Object.fromEntries(new URLSearchParams(await res.text()));
  if (!p.oauth_token) throw new Error(`Failed to get request token: ${JSON.stringify(p)}`);

  // Save state for step 2
  writeFileSync(STATE_FILE, JSON.stringify({
    consumerKey,
    consumerSecret,
    requestToken:  p.oauth_token,
    requestSecret: p.oauth_token_secret,
    createdAt:     Date.now(),
  }), { mode: 0o600 });

  const authUrl = `${AUTH_URL}?key=${encodeURIComponent(consumerKey)}&token=${encodeURIComponent(p.oauth_token)}`;
  console.log('\n=== E*Trade Token Refresh — Step 1 of 2 ===\n');
  console.log('Open this URL in your browser and authorize:\n');
  console.log(`  ${authUrl}\n`);
  console.log('Then run:  node scripts/etrade-step2.mjs <verifier>\n');
} catch (err) {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
}
