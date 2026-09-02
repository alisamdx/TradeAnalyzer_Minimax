/**
 * E*Trade OAuth 1.0a implementation.
 *
 * Flow:
 *   1. getRequestToken()  → { requestToken, requestSecret, authUrl }
 *   2. User opens authUrl in browser, receives a verifier code
 *   3. getAccessToken(requestToken, requestSecret, verifier) → { accessToken, accessSecret }
 *   4. All subsequent calls use signRequest(accessToken, accessSecret, ...)
 *
 * Tokens expire at midnight US Eastern every day.
 * After 2 hours of inactivity the token goes dormant; call renewAccessToken() to wake it.
 */

import { createHmac } from 'node:crypto';
import { logApiCall, scrubObject } from './logger.js';
import type { ApiLogEntry } from './logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL    = 'https://api.etrade.com';
const AUTH_URL    = 'https://us.etrade.com/e/t/etws/authorize';

const REQUEST_TOKEN_PATH = '/oauth/request_token';
const ACCESS_TOKEN_PATH  = '/oauth/access_token';
// E*Trade OAuth endpoints live under /oauth/, NOT /v1/oauth/ (the /v1/ prefix is only for the
// market/accounts APIs). This was '/v1/oauth/renew_access_token' — a wrong path that made EVERY
// renew fail (404), so dormant tokens (idle > 2 h) were never revived and always surfaced as
// "token expired" until a manual re-auth. Confirmed against E*Trade docs. See CLAUDE.md.
const RENEW_TOKEN_PATH   = '/oauth/renew_access_token';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RequestTokenResult {
  requestToken: string;
  requestSecret: string;
  authUrl: string;
}

export interface AccessTokenResult {
  accessToken: string;
  accessSecret: string;
}

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
}

// ─── OAuth 1.0a Core ─────────────────────────────────────────────────────────

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function timestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/**
 * Build an OAuth 1.0a Authorization header for a GET request.
 * additionalParams are any query parameters included in the request URL
 * (they must be included in the signature base string).
 */
export function buildAuthHeader(
  method: string,
  url: string,
  consumerKey: string,
  consumerSecret: string,
  tokenKey = '',
  tokenSecret = '',
  additionalOAuthParams: Record<string, string> = {},
  queryParams: Record<string, string> = {}
): string {
  const ts = timestamp();
  const n  = nonce();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            n,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        ts,
    oauth_version:          '1.0',
    ...additionalOAuthParams,
  };
  if (tokenKey) oauthParams['oauth_token'] = tokenKey;

  // Collect all params for base string (oauth + query)
  const allParams: Record<string, string> = { ...oauthParams, ...queryParams };

  // Sort and encode
  const sortedPairs = Object.keys(allParams)
    .sort()
    .map(k => `${pct(k)}=${pct(allParams[k]!)}`)
    .join('&');

  // Strip query string from URL for base string
  const baseUrl = url.split('?')[0]!;
  const baseString = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(sortedPairs)}`;
  const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;

  const signature = createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  oauthParams['oauth_signature'] = signature;

  const headerValue = 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${pct(k)}="${pct(oauthParams[k]!)}"`)
    .join(', ');

  return headerValue;
}

// ─── Auth Steps ───────────────────────────────────────────────────────────────

/** Step 1 — get a request token and return the URL the user must visit. */
export async function getRequestToken(
  consumerKey: string,
  consumerSecret: string
): Promise<RequestTokenResult> {
  const url = `${BASE_URL}${REQUEST_TOKEN_PATH}`;
  const authHeader = buildAuthHeader(
    'GET', url, consumerKey, consumerSecret,
    '', '',
    { oauth_callback: 'oob' }
  );

  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/x-www-form-urlencoded' }
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`E*Trade request token failed (${res.status}): ${body.slice(0, 300)}`);

  const params = Object.fromEntries(new URLSearchParams(body));
  const requestToken  = params['oauth_token'];
  const requestSecret = params['oauth_token_secret'];
  if (!requestToken || !requestSecret) {
    throw new Error(`E*Trade returned unexpected request token body: ${body.slice(0, 300)}`);
  }

  const authUrl = `${AUTH_URL}?key=${encodeURIComponent(consumerKey)}&token=${encodeURIComponent(requestToken)}`;
  return { requestToken, requestSecret, authUrl };
}

/** Step 3 — exchange the verifier code for a live access token. */
export async function getAccessToken(
  consumerKey: string,
  consumerSecret: string,
  requestToken: string,
  requestSecret: string,
  verifier: string
): Promise<AccessTokenResult> {
  const url = `${BASE_URL}${ACCESS_TOKEN_PATH}`;
  const authHeader = buildAuthHeader(
    'GET', url, consumerKey, consumerSecret,
    requestToken, requestSecret,
    { oauth_verifier: verifier }
  );

  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/x-www-form-urlencoded' }
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`E*Trade access token failed (${res.status}): ${body.slice(0, 300)}`);

  const params = Object.fromEntries(new URLSearchParams(body));
  const accessToken  = params['oauth_token'];
  const accessSecret = params['oauth_token_secret'];
  if (!accessToken || !accessSecret) {
    throw new Error(`E*Trade returned unexpected access token body: ${body.slice(0, 300)}`);
  }

  return { accessToken, accessSecret };
}

/** Renew a dormant token (inactive > 2 hours). No user interaction needed. */
export async function renewAccessToken(creds: OAuthCredentials): Promise<void> {
  const url = `${BASE_URL}${RENEW_TOKEN_PATH}`;
  const authHeader = buildAuthHeader(
    'GET', url,
    creds.consumerKey, creds.consumerSecret,
    creds.accessToken, creds.accessSecret
  );

  const res = await fetch(url, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`E*Trade renew token failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

/**
 * Make an authenticated GET request to the E*Trade API.
 * Returns parsed JSON. Handles the JSON wrapper E*Trade uses.
 */
/**
 * Mask the account identifier out of a logged endpoint path.
 *
 * `/v1/accounts/{accountIdKey}/transactions` carries a real brokerage account key. The API
 * log is plaintext on disk, so the key is replaced while the SHAPE of the call is kept —
 * which is all diagnosis needs.
 */
function maskEndpoint(path: string): string {
  return path.replace(/\/accounts\/[^/]+/i, '/accounts/{acct}');
}

/**
 * Fail-safe wrapper around `logApiCall`.
 *
 * Instrumentation must never break the thing it instruments. The logger touches the
 * filesystem and reads Electron's userData path, so a disk error or an unready app would
 * otherwise turn every E*Trade request into a hard failure — trading the blind spot this
 * logging exists to fix for something strictly worse.
 */
function safeLog(entry: ApiLogEntry): void {
  try { logApiCall(entry); } catch { /* logging must never break an API call */ }
}

export async function etradeGet(
  path: string,
  queryParams: Record<string, string>,
  creds: OAuthCredentials
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;

  const authHeader = buildAuthHeader(
    'GET', `${BASE_URL}${path}`,
    creds.consumerKey, creds.consumerSecret,
    creds.accessToken, creds.accessSecret,
    {}, queryParams
  );

  // Instrumented v1.1.144. E*Trade was the only provider writing nothing to logs/api — the
  // Polygon path has been logged since the logger existed — so any E*Trade failure was
  // invisible after the fact. That blocked diagnosing why Sync Closed Positions imports
  // nothing: there was no record of whether the request was even made.
  //
  // Only the caller's query params are logged (scrubbed), never the OAuth Authorization
  // header, and the account key is masked out of the path.
  const startedAt = Date.now();
  const logBase = {
    timestamp: new Date().toISOString(),
    provider: 'etrade',
    endpoint: maskEndpoint(path),
    method: 'GET',
    requestParams: scrubObject(queryParams),
    retryCount: 0,
    jobRunId: null,
  };

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    });
  } catch (err) {
    // Network-level fault. A dormant E*Trade token can terminate the stream rather than
    // returning 401 (see CLAUDE.md), and that used to leave no trace at all.
    safeLog({
      ...logBase,
      responseStatus: null,
      responseLatencyMs: Date.now() - startedAt,
      responseSizeBytes: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const body = await res.text();
  const latencyMs = Date.now() - startedAt;

  if (!res.ok) {
    // Body preview ONLY on failure — E*Trade's error envelope is exactly what diagnosis
    // needs, and success bodies (positions, balances, quotes) are never written to disk.
    safeLog({
      ...logBase,
      responseStatus: res.status,
      responseLatencyMs: latencyMs,
      responseSizeBytes: body.length,
      errorMessage: `HTTP ${res.status}`,
      responseBodyPreview: body.slice(0, 300),
    });
    throw new Error(`E*Trade API error (${res.status}) at ${path}: ${body.slice(0, 300)}`);
  }

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    safeLog({
      ...logBase,
      responseStatus: res.status,
      responseLatencyMs: latencyMs,
      responseSizeBytes: body.length,
    });
    return parsed;
  } catch {
    safeLog({
      ...logBase,
      responseStatus: res.status,
      responseLatencyMs: latencyMs,
      responseSizeBytes: body.length,
      errorMessage: 'non-JSON response',
      responseBodyPreview: body.slice(0, 300),
    });
    throw new Error(`E*Trade returned non-JSON at ${path}: ${body.slice(0, 200)}`);
  }
}
