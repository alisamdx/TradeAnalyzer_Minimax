// The E*Trade OAuth calls must appear in logs/api/ like every other E*Trade request.
//
// getRequestToken / getAccessToken / renewAccessToken called `fetch` directly instead of
// going through the instrumented transport, so they were the one part of the integration
// v1.1.144's logging never covered: on 2026-09-02 the API log held 13,098 E*Trade rows and
// ZERO auth entries. A renew that silently failed left no trace, which is what reduced the
// stale-token diagnosis that day to inference — the log could prove the token worked, but
// never whether a renew or re-auth had happened.
//
// The hard constraint pinned here: a FAILURE body (E*Trade's oauth_problem envelope) is
// exactly what diagnosis needs and is logged, while a SUCCESS body carries oauth_token and
// oauth_token_secret in clear text and must never touch disk.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logApiCall = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/logger.js', async (orig) => {
  const actual = await orig<typeof import('../src/main/services/logger.js')>();
  return { ...actual, logApiCall };
});

const { getRequestToken, getAccessToken, renewAccessToken } =
  await import('../src/main/services/etrade-auth.js');

// Distinctive values so a leak assertion cannot pass by accident on a common substring.
const TOKEN_CANARY  = 'OAUTHTOKEN_LEAKCANARY_1';
const SECRET_CANARY = 'OAUTHSECRET_LEAKCANARY_2';
const VERIFIER      = 'VERIFIER_LEAKCANARY_3';
const CONSUMER_KEY  = 'CONSUMERKEY_LEAKCANARY_4';
const CONSUMER_SEC  = 'CONSUMERSECRET_LEAKCANARY_5';

const successBody = `oauth_token=${TOKEN_CANARY}&oauth_token_secret=${SECRET_CANARY}`;

const creds = {
  consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SEC,
  accessToken: TOKEN_CANARY, accessSecret: SECRET_CANARY,
};

function stubFetch(res: { ok: boolean; status: number; body: string }) {
  const fn = vi.fn(async (_url: string, _init?: { signal?: AbortSignal }) => ({
    ok: res.ok, status: res.status, text: async () => res.body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Everything the logger was handed, flattened — nothing sensitive may appear in here. */
function loggedText(): string {
  return JSON.stringify(logApiCall.mock.calls);
}

beforeEach(() => { logApiCall.mockReset(); logApiCall.mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('OAuth calls are instrumented', () => {
  it('logs a successful renew', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });

    await renewAccessToken(creds);

    expect(logApiCall).toHaveBeenCalledTimes(1);
    expect(logApiCall.mock.calls[0]![0]).toMatchObject({
      provider: 'etrade',
      endpoint: '/oauth/renew_access_token',
      method: 'GET',
      responseStatus: 200,
    });
  });

  it('logs a successful request-token call', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });
    await getRequestToken(CONSUMER_KEY, CONSUMER_SEC);
    expect(logApiCall.mock.calls[0]![0]).toMatchObject({
      endpoint: '/oauth/request_token', responseStatus: 200,
    });
  });

  it('logs a successful access-token exchange', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });
    await getAccessToken(CONSUMER_KEY, CONSUMER_SEC, 'rt', 'rs', VERIFIER);
    expect(logApiCall.mock.calls[0]![0]).toMatchObject({
      endpoint: '/oauth/access_token', responseStatus: 200,
    });
  });
});

describe('OAuth logging never leaks a credential', () => {
  it('does not write the success body — it contains the token and its secret', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });

    await renewAccessToken(creds);

    const entry = logApiCall.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry.responseBodyPreview).toBeUndefined();
    expect(loggedText()).not.toContain(TOKEN_CANARY);
    expect(loggedText()).not.toContain(SECRET_CANARY);
  });

  it('does not leak the freshly minted token from an access-token exchange', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });

    const result = await getAccessToken(CONSUMER_KEY, CONSUMER_SEC, 'rt', 'rs', VERIFIER);

    expect(result.accessToken).toBe(TOKEN_CANARY);   // returned to the caller…
    expect(loggedText()).not.toContain(TOKEN_CANARY); // …but never logged
    expect(loggedText()).not.toContain(SECRET_CANARY);
  });

  it('does not log the oauth_verifier — a live short-lived credential', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });
    await getAccessToken(CONSUMER_KEY, CONSUMER_SEC, 'rt', 'rs', VERIFIER);
    expect(loggedText()).not.toContain(VERIFIER);
  });

  it('never logs the consumer key/secret or the signed Authorization header', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });
    await getRequestToken(CONSUMER_KEY, CONSUMER_SEC);
    expect(loggedText()).not.toContain(CONSUMER_KEY);
    expect(loggedText()).not.toContain(CONSUMER_SEC);
    expect(loggedText().toLowerCase()).not.toContain('oauth_signature');
  });
});

describe('OAuth failures are legible in the log', () => {
  it('records the oauth_problem envelope on a rejected renew', async () => {
    stubFetch({ ok: false, status: 401, body: 'oauth_problem=token_rejected' });

    await expect(renewAccessToken(creds)).rejects.toThrow(/renew token failed \(401\)/);

    expect(logApiCall.mock.calls[0]![0]).toMatchObject({
      endpoint: '/oauth/renew_access_token',
      responseStatus: 401,
      errorMessage: 'HTTP 401',
      responseBodyPreview: 'oauth_problem=token_rejected',
    });
  });

  it('records a network fault with a null status — a dormant token can kill the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed: terminated'); }));

    await expect(renewAccessToken(creds)).rejects.toThrow(/terminated/);

    expect(logApiCall.mock.calls[0]![0]).toMatchObject({
      endpoint: '/oauth/renew_access_token',
      responseStatus: null,
      errorMessage: 'fetch failed: terminated',
    });
  });

  it('logs a 4xx on the request-token step and still throws', async () => {
    stubFetch({ ok: false, status: 400, body: 'oauth_problem=consumer_key_rejected' });

    await expect(getRequestToken(CONSUMER_KEY, CONSUMER_SEC)).rejects.toThrow(/request token failed/);

    expect(logApiCall.mock.calls[0]![0]).toMatchObject({
      responseStatus: 400,
      responseBodyPreview: 'oauth_problem=consumer_key_rejected',
    });
  });
});

describe('instrumentation cannot break authentication', () => {
  it('completes a renew even when the logger throws', async () => {
    stubFetch({ ok: true, status: 200, body: successBody });
    logApiCall.mockImplementation(() => { throw new Error('disk full'); });

    await expect(renewAccessToken(creds)).resolves.toBeUndefined();
  });

  it('still surfaces the real auth error when the logger throws', async () => {
    stubFetch({ ok: false, status: 401, body: 'oauth_problem=token_rejected' });
    logApiCall.mockImplementation(() => { throw new Error('disk full'); });

    await expect(renewAccessToken(creds)).rejects.toThrow(/renew token failed \(401\)/);
  });
});

describe('OAuth calls get the same hard timeout as every other E*Trade request', () => {
  it('aborts a stalled renew instead of letting undici retransmit the signed header', async () => {
    const fetchFn = stubFetch({ ok: true, status: 200, body: successBody });

    await renewAccessToken(creds);

    // Without a signal a stalled socket is retransmitted, replaying the same oauth_nonce —
    // which E*Trade answers with oauth_problem=nonce_used.
    expect(fetchFn.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
