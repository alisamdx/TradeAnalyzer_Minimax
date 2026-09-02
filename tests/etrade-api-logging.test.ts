// E*Trade API-call logging (v1.1.144).
//
// E*Trade was the only provider writing NOTHING to logs/api — Polygon has been instrumented
// since the logger existed (17,200 entries on 2026-09-01 vs zero for E*Trade). That made
// every E*Trade failure invisible after the fact, and it is what blocked diagnosing why
// "Sync Closed Positions" imports nothing: there was no record of whether the request was
// even made, let alone what came back.
//
// Two properties matter and are pinned here: secrets/account keys never reach the log, and
// logging can never break an API call.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const logApiCall = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/logger.js', async (orig) => {
  const actual = await orig<typeof import('../src/main/services/logger.js')>();
  return { ...actual, logApiCall };
});

const { etradeGet } = await import('../src/main/services/etrade-auth.js');

// Distinctive values on purpose: short ones like 'at' collide with ordinary JSON keys
// ("responseStatus" contains "at"), which would make the leak assertion below meaningless.
const creds = {
  consumerKey:    'CONSUMERKEY_LEAKCANARY_1',
  consumerSecret: 'CONSUMERSECRET_LEAKCANARY_2',
  accessToken:    'ACCESSTOKEN_LEAKCANARY_3',
  accessSecret:   'ACCESSSECRET_LEAKCANARY_4',
};

describe('etradeGet — API logging', () => {
  beforeEach(() => { logApiCall.mockReset(); logApiCall.mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('logs a successful call without leaking the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ QuoteResponse: { secret: 'balances' } }),
    })));

    await etradeGet('/v1/market/quote/SPY', { detailFlag: 'ALL' }, creds);

    expect(logApiCall).toHaveBeenCalledTimes(1);
    const e = logApiCall.mock.calls[0]![0];
    expect(e.provider).toBe('etrade');
    expect(e.responseStatus).toBe(200);
    expect(e.endpoint).toBe('/v1/market/quote/SPY');
    // Success bodies carry positions/balances/quotes — never written to disk.
    expect(e.responseBodyPreview).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('balances');
  });

  it('masks the brokerage account key out of the logged endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })));

    await etradeGet('/v1/accounts/SECRET_ACCT_KEY_123/transactions', { count: '50' }, creds);

    const e = logApiCall.mock.calls[0]![0];
    expect(e.endpoint).toBe('/v1/accounts/{acct}/transactions');
    expect(JSON.stringify(e)).not.toContain('SECRET_ACCT_KEY_123');
  });

  it('keeps /accounts/list readable — it is an endpoint, not an identifier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })));

    await etradeGet('/v1/accounts/list', {}, creds);

    // Masking this made the account-list call indistinguishable from an account-scoped one,
    // which is exactly the distinction needed to tell which sync path ran.
    expect(logApiCall.mock.calls[0]![0].endpoint).toBe('/v1/accounts/list');
  });

  it('records the provider error body on a failed call — the thing diagnosis needs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 400,
      text: async () => '{"Error":{"code":10031,"message":"Invalid date range"}}',
    })));

    await expect(etradeGet('/v1/accounts/K/transactions', {}, creds)).rejects.toThrow(/400/);

    const e = logApiCall.mock.calls[0]![0];
    expect(e.responseStatus).toBe(400);
    expect(e.errorMessage).toBe('HTTP 400');
    expect(e.responseBodyPreview).toContain('Invalid date range');
  });

  it('records a network fault, which a dormant token can produce instead of a 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('terminated'); }));

    await expect(etradeGet('/v1/market/quote/SPY', {}, creds)).rejects.toThrow('terminated');

    const e = logApiCall.mock.calls[0]![0];
    expect(e.responseStatus).toBeNull();
    expect(e.errorMessage).toBe('terminated');
  });

  it('never scrubs away a real param, but never logs the OAuth header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })));

    await etradeGet('/v1/market/quote/SPY', { detailFlag: 'ALL', requireEarningsDate: 'true' }, creds);

    const e = logApiCall.mock.calls[0]![0];
    expect(e.requestParams).toEqual({ detailFlag: 'ALL', requireEarningsDate: 'true' });
    const dumped = JSON.stringify(e);
    for (const secret of [
      'LEAKCANARY', 'oauth_signature', 'oauth_consumer_key', 'Authorization', 'OAuth ',
    ]) {
      expect(dumped).not.toContain(secret);
    }
  });

  it('a failing logger must NOT break the API call', async () => {
    logApiCall.mockImplementation(() => { throw new Error('disk full'); });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"ok":1}' })));

    // Instrumentation must never take down the thing it instruments.
    await expect(etradeGet('/v1/market/quote/SPY', {}, creds)).resolves.toEqual({ ok: 1 });
  });
});

// ── nonce_used retry (v1.1.147) ─────────────────────────────────────────────
//
// Measured 2026-09-02: a transactions request took 120,250 ms and came back
// `oauth_problem=nonce_used` on a SINGLE app-level call. The app sends each request once
// (verified in the API log), so the duplicate nonce is a transport-level retransmission of
// the already-signed header — most likely on a slow request. Re-signing is the only recovery,
// since the nonce is baked into the Authorization header at build time.
describe('etradeGet — nonce_used recovery', () => {
  beforeEach(() => { logApiCall.mockReset(); logApiCall.mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('retries once with a fresh signature when E*Trade reports nonce_used', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 401,
        text: async () => '<Error><message>oauth_problem=nonce_used</message></Error>',
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"ok":1}' });
    vi.stubGlobal('fetch', fetchMock);

    await expect(etradeGet('/v1/accounts/K/transactions', {}, creds)).resolves.toEqual({ ok: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry must carry a DIFFERENT Authorization header — same nonce would fail again.
    const first  = fetchMock.mock.calls[0]![1].headers.Authorization;
    const second = fetchMock.mock.calls[1]![1].headers.Authorization;
    expect(second).not.toBe(first);
  });

  it('does not loop when the retry also reports nonce_used', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => '<Error><message>oauth_problem=nonce_used</message></Error>',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(etradeGet('/v1/accounts/K/transactions', {}, creds)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(2);   // one attempt + exactly one retry
  });

  it('does not retry a 401 that is not a nonce problem', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => '<Error><message>oauth_problem=token_rejected</message></Error>',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(etradeGet('/v1/market/quote/SPY', {}, creds)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);   // a dead token is not fixed by re-signing
  });

  it('honours a per-call timeout override for slow endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' })));
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await etradeGet('/v1/accounts/K/transactions', {}, creds, { timeoutMs: 180_000 });

    expect(spy).toHaveBeenCalledWith(180_000);
  });
});
