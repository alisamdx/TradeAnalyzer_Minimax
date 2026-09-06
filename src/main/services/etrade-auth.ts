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

/**
 * Hard timeout for an E*Trade request.
 *
 * Without one, a stalled connection hangs until Node's default and gets RETRANSMITTED by
 * undici — replaying the already-signed Authorization header, so E*Trade sees the same
 * oauth_nonce twice and answers `oauth_problem=nonce_used`. Observed 2026-09-02: the
 * closed-position import's transactions call stalled 120,250 ms and came back 401 nonce_used
 * on a single app-level request. Every other E*Trade call in that session finished under
 * 500 ms, so this is generous by two orders of magnitude — it exists to fail fast and
 * legibly, not to bound normal latency.
 */
const ETRADE_TIMEOUT_MS = 30_000;

/**
 * The transactions endpoint is genuinely slow and needs its own budget.
 *
 * Measured 2026-09-02: a YTD query took **120,250 ms** before responding, and a 31-day slice
 * still exceeded 30 s. Narrowing the range does NOT speed it up — that hypothesis was tested
 * and falsified — so the endpoint is simply slow per call, and a timeout tuned to the ~300 ms
 * norm of every other E*Trade call guarantees failure here.
 */
export const ETRADE_SLOW_TIMEOUT_MS = 180_000;

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

  // requestParams is deliberately empty: the only inputs here are OAuth protocol values,
  // and `oauth_verifier` (in getAccessToken) is a live short-lived credential. The endpoint
  // path and outcome are what diagnosis needs.
  const { res, body, latencyMs, logBase } = await sendETradeRequest({
    path: REQUEST_TOKEN_PATH, fullUrl: url, authHeader,
    accept: 'application/x-www-form-urlencoded',
    timeoutMs: ETRADE_TIMEOUT_MS, requestParams: {},
  });
  logAuthOutcome(logBase, res, body, latencyMs);
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

  const { res, body, latencyMs, logBase } = await sendETradeRequest({
    path: ACCESS_TOKEN_PATH, fullUrl: url, authHeader,
    accept: 'application/x-www-form-urlencoded',
    timeoutMs: ETRADE_TIMEOUT_MS, requestParams: {},
  });
  logAuthOutcome(logBase, res, body, latencyMs);
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

  const { res, body, latencyMs, logBase } = await sendETradeRequest({
    path: RENEW_TOKEN_PATH, fullUrl: url, authHeader,
    accept: 'application/x-www-form-urlencoded',
    timeoutMs: ETRADE_TIMEOUT_MS, requestParams: {},
  });
  logAuthOutcome(logBase, res, body, latencyMs);
  if (!res.ok) throw new Error(`E*Trade renew token failed (${res.status}): ${body.slice(0, 200)}`);
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
  // `list` is a literal endpoint (`/v1/accounts/list`), not an identifier. Masking it made
  // the account-list call indistinguishable from an account-scoped one in the log, which is
  // precisely the distinction needed to tell which sync path ran.
  return path.replace(/\/accounts\/([^/]+)/i, (m, seg: string) =>
    seg.toLowerCase() === 'list' ? m : '/accounts/{acct}');
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

/**
 * The single instrumented transport every E*Trade request goes through.
 *
 * Extracted from `etradeGet` so the OAuth calls share it. They used to call `fetch`
 * directly and were therefore the one part of the integration v1.1.144's logging never
 * covered: an API log holding 13,098 E*Trade rows contained ZERO auth entries. A renew that
 * silently failed left no trace at all, which is what reduced the 2026-09-02 stale-token
 * diagnosis to inference — the log could prove the token worked, but never whether a renew
 * or re-auth had happened.
 *
 * Returns the raw body and the log skeleton; each caller decides what success and failure
 * mean and logs the outcome itself, because an OAuth response is form-encoded while a
 * market response is JSON. Network-level faults are logged here, since they look the same
 * either way (and a dormant token can terminate the stream rather than return 401).
 */
async function sendETradeRequest(opts: {
  path: string;
  fullUrl: string;
  authHeader: string;
  accept: string;
  timeoutMs: number;
  requestParams: Record<string, string>;
}): Promise<{ res: Response; body: string; latencyMs: number; logBase: ApiLogEntry }> {
  const startedAt = Date.now();
  const logBase = {
    timestamp: new Date().toISOString(),
    provider: 'etrade',
    endpoint: maskEndpoint(opts.path),
    method: 'GET',
    requestParams: scrubObject(opts.requestParams),
    retryCount: 0,
    jobRunId: null,
  } as ApiLogEntry;

  let res: Response;
  try {
    res = await fetch(opts.fullUrl, {
      headers: { Authorization: opts.authHeader, Accept: opts.accept },
      // A retransmission would replay this exact signed header (same nonce) and earn a
      // nonce_used 401, so abort rather than let a stalled socket linger. A retry has to
      // re-sign with a fresh nonce.
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    safeLog({
      ...logBase,
      responseStatus: null,
      responseLatencyMs: Date.now() - startedAt,
      responseSizeBytes: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  return { res, body: await res.text(), latencyMs: Date.now() - startedAt, logBase };
}

/**
 * Log the outcome of an OAuth call.
 *
 * A FAILURE body is E*Trade's `oauth_problem=...` envelope — exactly what diagnosis needs.
 * A SUCCESS body carries `oauth_token` and `oauth_token_secret` in clear text, so it is
 * never written: the log is a plaintext file with 30-day retention, and a leaked token
 * secret is a live brokerage credential.
 */
function logAuthOutcome(
  logBase: ApiLogEntry,
  res: Response,
  body: string,
  latencyMs: number,
): void {
  safeLog({
    ...logBase,
    responseStatus: res.status,
    responseLatencyMs: latencyMs,
    responseSizeBytes: body.length,
    ...(res.ok ? {} : { errorMessage: `HTTP ${res.status}`, responseBodyPreview: body.slice(0, 300) }),
  });
}

/**
 * Raw variant for the collector (NewApp 04 §1.1, §2.2).
 *
 * Same signing, same instrumented transport, same nonce retry as `etradeGet` —
 * it differs only in what it returns and what it does with a failure. The
 * collector needs the **response bytes as received**, because those bytes are
 * what the archive stores and what `meta_response.sha256` is taken over, and it
 * needs a non-2xx returned rather than thrown, because a failed call is evidence
 * about the day and is archived like any other response (P2).
 *
 * The logging asymmetry is unchanged and load-bearing: a failure body is logged
 * because that is exactly what diagnosis needs, a success body never is.
 */
export async function etradeGetRaw(
  path: string,
  queryParams: Record<string, string>,
  creds: OAuthCredentials,
  opts: { timeoutMs?: number; _isNonceRetry?: boolean } = {}
): Promise<{ status: number | null; body: string; requestedAt: string; respondedAt: string | null; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? ETRADE_TIMEOUT_MS;
  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  const requestedAt = new Date().toISOString();

  const authHeader = buildAuthHeader(
    'GET', `${BASE_URL}${path}`,
    creds.consumerKey, creds.consumerSecret,
    creds.accessToken, creds.accessSecret,
    {}, queryParams,
  );

  try {
    const { res, body, latencyMs, logBase } = await sendETradeRequest({
      path, fullUrl, authHeader, accept: 'application/json',
      timeoutMs, requestParams: queryParams,
    });

    if (!res.ok && res.status === 401 && /nonce_used/i.test(body) && !opts._isNonceRetry) {
      safeLog({
        ...logBase,
        responseStatus: res.status,
        responseLatencyMs: latencyMs,
        responseSizeBytes: body.length,
        errorMessage: 'HTTP 401 nonce_used — retrying once with a fresh signature',
        responseBodyPreview: body.slice(0, 300),
      });
      return etradeGetRaw(path, queryParams, creds, { ...opts, _isNonceRetry: true });
    }

    safeLog({
      ...logBase,
      responseStatus: res.status,
      responseLatencyMs: latencyMs,
      responseSizeBytes: body.length,
      ...(res.ok ? {} : { errorMessage: `HTTP ${res.status}`, responseBodyPreview: body.slice(0, 300) }),
    });

    return { status: res.status, body, requestedAt, respondedAt: new Date().toISOString() };
  } catch (err) {
    // A dormant token can terminate the stream rather than answer 401, so a
    // network fault has no status at all — which the archive records as such.
    return {
      status: null,
      body: '',
      requestedAt,
      respondedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function etradeGet(
  path: string,
  queryParams: Record<string, string>,
  creds: OAuthCredentials,
  opts: { timeoutMs?: number; _isNonceRetry?: boolean } = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? ETRADE_TIMEOUT_MS;
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
  const { res, body, latencyMs, logBase } = await sendETradeRequest({
    path, fullUrl, authHeader, accept: 'application/json',
    timeoutMs, requestParams: queryParams,
  });

  if (!res.ok) {
    // `oauth_problem=nonce_used` means E*Trade saw this exact nonce already — the signed
    // request reached it twice. The app sends each call once (verified in the API log), so
    // the duplicate is a transport-level retransmission of the already-signed header, which
    // is most likely on a slow request. Retrying re-enters this function and re-signs with a
    // fresh nonce and timestamp; guarded to a single attempt so a genuinely repeated nonce
    // cannot loop.
    if (res.status === 401 && /nonce_used/i.test(body) && !opts._isNonceRetry) {
      safeLog({
        ...logBase,
        responseStatus: res.status,
        responseLatencyMs: latencyMs,
        responseSizeBytes: body.length,
        errorMessage: 'HTTP 401 nonce_used — retrying once with a fresh signature',
        responseBodyPreview: body.slice(0, 300),
      });
      return etradeGet(path, queryParams, creds, { ...opts, _isNonceRetry: true });
    }

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
