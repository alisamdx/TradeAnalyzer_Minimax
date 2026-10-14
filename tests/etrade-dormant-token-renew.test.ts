// Regression: the on-demand E*Trade options path must self-heal from token
// dormancy. E*Trade access tokens go dormant after ~2 h of inactivity; the
// nightly jobs renew-and-retry, but the on-demand getOptionsChain /
// getOptionsExpirations path did not — so any options fetch made > 2 h after the
// last E*Trade activity returned an empty chain the API route silently swallowed.
// The provider renews once and retries (v1.1.48).
//
// v1.1.94: renew on ANY error, not just auth-shaped ones. A dormant token doesn't
// reliably return a 401 — it can kill the response stream (undici 'terminated'),
// which the old auth-message heuristic missed, so the renewal never ran (observed
// live 2026-07-01). Renewing an active token is harmless; a genuine error just
// fails again on the retry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getETradeOptionsChain = vi.fn();
const getETradeExpirations = vi.fn();
const renewAccessToken = vi.fn();

vi.mock('../src/main/services/etrade-options.js', () => ({
  getETradeOptionsChain: (...a: unknown[]) => getETradeOptionsChain(...a),
  getETradeExpirations: (...a: unknown[]) => getETradeExpirations(...a),
}));
vi.mock('../src/main/services/etrade-auth.js', () => ({
  renewAccessToken: (...a: unknown[]) => renewAccessToken(...a),
}));

const { ETradeDataProvider } = await import('../src/main/services/etrade-data-provider.js');
const { etradeApiErrorMessage, etradeApplicationErrorCode } = await import('../src/main/services/etrade-errors.js');

const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };
const emptyChain = { calls: [], puts: [], underlyingPrice: 100 };

describe('ETradeDataProvider dormant-token renew-and-retry', () => {
  beforeEach(() => {
    getETradeOptionsChain.mockReset();
    getETradeExpirations.mockReset();
    renewAccessToken.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('getOptionsChain renews once on a 401 then retries successfully', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain
      .mockRejectedValueOnce(new Error('E*Trade API error (401) at /v1/market/optionchains: token dormant'))
      .mockResolvedValueOnce(emptyChain);

    const chain = await provider.getOptionsChain('AAPL', '2026-07-17');

    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(2); // failed, then retried
    expect(chain.ticker).toBe('AAPL');
  });

  it('getOptionsExpirations renews once on a 401 then retries successfully', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeExpirations
      .mockRejectedValueOnce(new Error('E*Trade API error (401) at /v1/market/optionexpiredate: token'))
      .mockResolvedValueOnce([{ dateStr: '2026-07-17' }]);

    const exps = await provider.getOptionsExpirations('AAPL');

    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(exps).toEqual(['2026-07-17']);
  });

  it('renews on a non-auth "terminated" error (dormant token kills the stream) then retries', async () => {
    // The v1.1.94 fix: a dormant token surfaces as a stream-terminated TypeError, NOT a
    // 401. This must still trigger renew-and-retry (the old heuristic did not).
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain
      .mockRejectedValueOnce(new TypeError('terminated'))
      .mockResolvedValueOnce(emptyChain);

    const chain = await provider.getOptionsChain('AAPL', '2026-07-17');

    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(2);
    expect(chain.ticker).toBe('AAPL');
  });

  it('surfaces the retry error when renew fails and the retry still fails (expired past midnight)', async () => {
    // Renew failure is swallowed; the retry runs and its error propagates (the real
    // failure the caller must act on — e.g. a Reconnect prompt on a true midnight expiry).
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain
      .mockRejectedValueOnce(new TypeError('terminated'))
      .mockRejectedValueOnce(new Error('E*Trade API error (401) token expired'));
    renewAccessToken.mockRejectedValueOnce(new Error('E*Trade renew token failed (401)'));

    await expect(provider.getOptionsChain('AAPL', '2026-07-17')).rejects.toThrow(/401|expired/);
    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(2);
  });
});

// v1.1.355: an HTTP 400 with an E*Trade application code is an answer about the request,
// sent only after the token was accepted — renewing and retrying it tripled every such call
// (2026-10-13: 136 failed chain calls + 89 renews). 10032/10033 answer for the whole ticker,
// so the provider remembers them for the ET day.
describe('ETradeDataProvider definitive E*Trade errors', () => {
  // Bodies copied from logs/api/api_2026-10-13.jsonl (responseBodyPreview), as etradeGet throws them.
  const noOptions = () => new Error(etradeApiErrorMessage(400, '/v1/market/optionchains',
    '<Error>\n  <code>10032</code>\n  <message>No options are available for this symbol.</message>\n</Error>'));
  const invalidSymbol = () => new Error(etradeApiErrorMessage(400, '/v1/market/optionexpiredate',
    '<Error>\n  <code>10033</code>\n  <message>The symbol entered is invalid. Please enter another symbol.</message>\n</Error>'));
  const noChainForDate = () => new Error(etradeApiErrorMessage(400, '/v1/market/optionchains',
    '<Error>\n  <code>10031</code>\n  <message>No chain for this expiration.</message>\n</Error>'));

  beforeEach(() => {
    getETradeOptionsChain.mockReset();
    getETradeExpirations.mockReset();
    renewAccessToken.mockReset();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T21:30:00Z')); // 17:30 ET
  });
  afterEach(() => vi.useRealTimers());

  it('parses the code out of the message etradeGet throws, and nothing else', () => {
    expect(etradeApplicationErrorCode(noOptions())).toBe('10032');
    expect(etradeApplicationErrorCode(invalidSymbol())).toBe('10033');
    expect(etradeApplicationErrorCode(new Error(etradeApiErrorMessage(401, '/x', '<Error><code>10033</code></Error>')))).toBeNull();
    expect(etradeApplicationErrorCode(new Error(etradeApiErrorMessage(400, '/x', '<!doctype html><html>…')))).toBeNull();
    expect(etradeApplicationErrorCode(new TypeError('terminated'))).toBeNull();
  });

  it('does not renew or retry a 10032, and skips that ticker for the rest of the day', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain.mockRejectedValue(noOptions());

    await expect(provider.getOptionsChain('MDT', '2026-10-16')).rejects.toThrow(/10032/);
    expect(renewAccessToken).not.toHaveBeenCalled();
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(1);

    // Another expiration, another method, another letter case: no call at all.
    await expect(provider.getOptionsChain('mdt', '2026-10-23')).rejects.toThrow(/10032/);
    await expect(provider.getOptionsExpirations('MDT')).rejects.toThrow(/10032/);
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(1);
    expect(getETradeExpirations).not.toHaveBeenCalled();

    // Other tickers are untouched.
    getETradeOptionsChain.mockResolvedValueOnce(emptyChain);
    await expect(provider.getOptionsChain('AAPL', '2026-10-16')).resolves.toMatchObject({ ticker: 'AAPL' });
  });

  it('asks again on the next ET day', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeExpirations.mockRejectedValueOnce(invalidSymbol());
    await expect(provider.getOptionsExpirations('PSKY')).rejects.toThrow(/10033/);

    vi.setSystemTime(new Date('2026-10-14T03:59:00Z')); // 23:59 ET, same day
    await expect(provider.getOptionsExpirations('PSKY')).rejects.toThrow(/10033/);
    expect(getETradeExpirations).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-10-14T04:01:00Z')); // 00:01 ET, next day
    getETradeExpirations.mockResolvedValueOnce([{ dateStr: '2026-10-16' }]);
    await expect(provider.getOptionsExpirations('PSKY')).resolves.toEqual(['2026-10-16']);
    expect(getETradeExpirations).toHaveBeenCalledTimes(2);
  });

  it('does not retry a per-expiration code (10031), but does not skip the ticker either', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain.mockRejectedValueOnce(noChainForDate()).mockResolvedValueOnce(emptyChain);

    await expect(provider.getOptionsChain('AAPL', '2026-10-17')).rejects.toThrow(/10031/);
    expect(renewAccessToken).not.toHaveBeenCalled();
    await expect(provider.getOptionsChain('AAPL', '2026-10-16')).resolves.toMatchObject({ ticker: 'AAPL' });
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(2);
  });

  it('still renews and retries a 400 with no E*Trade code (an HTML body is not an answer)', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain
      .mockRejectedValueOnce(new Error(etradeApiErrorMessage(400, '/v1/market/optionchains', '<!doctype html><html>')))
      .mockResolvedValueOnce(emptyChain);

    await expect(provider.getOptionsChain('AAPL', '2026-10-16')).resolves.toMatchObject({ ticker: 'AAPL' });
    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(2);
  });

  it('still renews and retries a 401 that quotes an application code', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain
      .mockRejectedValueOnce(new Error(etradeApiErrorMessage(401, '/v1/market/optionchains', '<Error><code>10033</code></Error>')))
      .mockResolvedValueOnce(emptyChain);

    await provider.getOptionsChain('AAPL', '2026-10-16');
    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(2);
  });
});
