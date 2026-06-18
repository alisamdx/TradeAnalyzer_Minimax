// Regression: the on-demand E*Trade options path must self-heal from token
// dormancy. E*Trade access tokens go dormant after ~2 h of inactivity and the
// API then returns 401. The nightly jobs renew-and-retry, but the on-demand
// getOptionsChain / getOptionsExpirations path did not — so any options fetch
// made > 2 h after the last E*Trade activity (e.g. an evening TraderAgent run)
// returned an empty chain, which the API route silently swallowed. The provider
// now renews the dormant token once and retries. see CHANGELOG v1.1.48.

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

  it('does NOT renew on a non-auth error (propagates it)', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain.mockRejectedValueOnce(new Error('E*Trade API error (500) server blew up'));

    await expect(provider.getOptionsChain('AAPL', '2026-07-17')).rejects.toThrow('500');
    expect(renewAccessToken).not.toHaveBeenCalled();
    expect(getETradeOptionsChain).toHaveBeenCalledTimes(1); // no retry
  });

  it('propagates a renew failure (token expired past midnight)', async () => {
    const provider = new ETradeDataProvider(() => creds as never);
    getETradeOptionsChain.mockRejectedValue(new Error('E*Trade API error (401) token dormant'));
    renewAccessToken.mockRejectedValueOnce(new Error('E*Trade renew token failed (401)'));

    await expect(provider.getOptionsChain('AAPL', '2026-07-17')).rejects.toThrow('renew token failed');
    expect(renewAccessToken).toHaveBeenCalledTimes(1);
  });
});
