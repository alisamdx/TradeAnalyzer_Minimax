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
