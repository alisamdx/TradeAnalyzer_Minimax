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

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_URL    = 'https://api.etrade.com';
const AUTH_URL    = 'https://us.etrade.com/e/t/etws/authorize';

const REQUEST_TOKEN_PATH = '/oauth/request_token';
const ACCESS_TOKEN_PATH  = '/oauth/access_token';
const RENEW_TOKEN_PATH   = '/v1/oauth/renew_access_token';

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

  const res = await fetch(fullUrl, {
    headers: { Authorization: authHeader, Accept: 'application/json' }
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`E*Trade API error (${res.status}) at ${path}: ${body.slice(0, 300)}`);

  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`E*Trade returned non-JSON at ${path}: ${body.slice(0, 200)}`);
  }
}
