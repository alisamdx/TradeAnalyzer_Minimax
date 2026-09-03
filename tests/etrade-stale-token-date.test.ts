// Regression: a stale `etradeTokenDate` must never, on its own, declare the token dead.
//
// Both the startup check and the "live" probe used to short-circuit to 'expired' the moment
// the stamp differed from today's ET date, on the theory that a token past midnight ET is
// certainly dead so probing it would waste a call. Measured 2026-09-02, that premise is
// false: a token stamped 2026-09-01 served 13,098 successful E*Trade calls straight through
// the midnight boundary — including at 00:40 ET — while every check reported 'expired'.
// The observable damage was an app launch that hijacked startup and demanded an interactive
// re-auth for a token that was working perfectly.
//
// The stamp now means "last known good", and a stale value only means "not verified today".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const etradeGet = vi.fn();
const renewAccessToken = vi.fn();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet: (...a: unknown[]) => etradeGet(...a),
  renewAccessToken: (...a: unknown[]) => renewAccessToken(...a),
  getRequestToken: vi.fn(),
  getAccessToken: vi.fn(),
}));

const store = new Map<string, string>();
vi.mock('../src/main/services/secure-settings.js', () => ({
  secureGet: (_db: unknown, k: string) => store.get(k) ?? '',
  secureSet: (_db: unknown, k: string, v: string) => { store.set(k, v); },
}));

const { probeETradeConnection, checkETradeConnection } =
  await import('../src/main/ipc/ipc-etrade.js');

const db = {} as never;
const YESTERDAY = '2026-09-01';

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Credentials present, token stamped on an earlier ET day. */
function seedStaleStamp(): void {
  store.clear();
  store.set('etradeConsumerKey', 'k');
  store.set('etradeConsumerSecret', 's');
  store.set('etradeAccessToken', 't');
  store.set('etradeAccessSecret', 'a');
  store.set('etradeTokenDate', YESTERDAY);
}

const authError = () => new Error('E*Trade API error (401): oauth_problem=token_rejected');
const netError = () => new TypeError('fetch failed: terminated');

beforeEach(() => {
  etradeGet.mockReset();
  renewAccessToken.mockReset();
  seedStaleStamp();
});
afterEach(() => vi.restoreAllMocks());

describe('probeETradeConnection — a stale stamp is a question, not a verdict', () => {
  it('probes a stale-stamped token instead of assuming it is expired', async () => {
    etradeGet.mockResolvedValueOnce({ QuoteResponse: {} });

    const res = await probeETradeConnection(db);

    expect(res.status).toBe('ok');
    expect(etradeGet).toHaveBeenCalledTimes(1); // it actually asked E*Trade
  });

  it('re-stamps the date after a successful probe so the next startup is free', async () => {
    etradeGet.mockResolvedValueOnce({ QuoteResponse: {} });
    await probeETradeConnection(db);
    expect(store.get('etradeTokenDate')).toBe(todayET());
  });

  it('re-stamps after a renew-and-retry too', async () => {
    etradeGet.mockRejectedValueOnce(authError()).mockResolvedValueOnce({ QuoteResponse: {} });
    renewAccessToken.mockResolvedValueOnce(undefined);

    const res = await probeETradeConnection(db);

    expect(res.status).toBe('renewed');
    expect(store.get('etradeTokenDate')).toBe(todayET());
  });

  it('still reports expired when E*Trade actually rejects it after renew+retry', async () => {
    etradeGet.mockRejectedValue(authError());
    renewAccessToken.mockResolvedValue(undefined);

    const res = await probeETradeConnection(db);

    expect(res.status).toBe('expired');
    expect(store.get('etradeTokenDate')).toBe(YESTERDAY); // a dead token is not marked alive
  });

  it('reports a transient failure as error, not expired', async () => {
    etradeGet.mockRejectedValue(netError());
    renewAccessToken.mockResolvedValue(undefined);

    const res = await probeETradeConnection(db);

    expect(res.status).toBe('error');
    expect(store.get('etradeTokenDate')).toBe(YESTERDAY);
  });
});

describe('checkETradeConnection — the startup gate', () => {
  it('does NOT send the user to re-auth when the stale-stamped token still works', async () => {
    etradeGet.mockResolvedValueOnce({ QuoteResponse: {} });

    const res = await checkETradeConnection(db);

    expect(res.status).toBe('ok'); // the bug returned 'expired' here, hijacking startup
  });

  it('costs no API call at all once the token is verified for the day', async () => {
    store.set('etradeTokenDate', todayET());

    const res = await checkETradeConnection(db);

    expect(res.status).toBe('ok');
    expect(etradeGet).not.toHaveBeenCalled(); // fast path preserved — no startup latency
  });

  it('reports expired only when E*Trade itself rejected the token', async () => {
    etradeGet.mockRejectedValue(authError());
    renewAccessToken.mockResolvedValue(undefined);

    expect((await checkETradeConnection(db)).status).toBe('expired');
  });

  it('maps an unreachable E*Trade to unknown, never expired', async () => {
    etradeGet.mockRejectedValue(netError());
    renewAccessToken.mockResolvedValue(undefined);

    // Being unable to reach E*Trade is not evidence the token is bad; startup must not
    // demand a re-auth because the network blipped.
    expect((await checkETradeConnection(db)).status).toBe('unknown');
  });

  it('probes rather than trusting a missing stamp', async () => {
    store.delete('etradeTokenDate');
    etradeGet.mockResolvedValueOnce({ QuoteResponse: {} });

    const res = await checkETradeConnection(db);

    expect(res.status).toBe('ok');
    expect(etradeGet).toHaveBeenCalledTimes(1); // old code stamped today and assumed valid
    expect(store.get('etradeTokenDate')).toBe(todayET());
  });

  it('short-circuits on missing credentials and tokens without calling E*Trade', async () => {
    store.clear();
    expect((await checkETradeConnection(db)).status).toBe('no_credentials');

    store.set('etradeConsumerKey', 'k');
    store.set('etradeConsumerSecret', 's');
    expect((await checkETradeConnection(db)).status).toBe('no_token');

    expect(etradeGet).not.toHaveBeenCalled();
  });
});
