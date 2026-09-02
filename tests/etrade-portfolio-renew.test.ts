// Regression: etrade-portfolio-service was the last E*Trade consumer without renew-and-retry.
//
// Every other consumer has had it since v1.1.94. This one called etradeGet bare on all its
// paths, so a dormant token failed the whole portfolio sync outright instead of recovering.
// Tokens go dormant after 2h of inactivity, and this service is driven by manual button
// clicks — precisely the usage pattern that idles past the window.
//
// The retry fires on ANY error, deliberately. A dormant token does NOT reliably surface as a
// 401 — it can kill or hang the response stream instead. Gating renewal on an auth-shaped
// message is the exact bug that halted the evening orchestrator chain 8 of 10 trading days
// before v1.1.92 and silently emptied option chains before v1.1.94.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
const renewAccessToken = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet, renewAccessToken,
  buildAuthHeader: () => 'OAuth x',
  ETRADE_SLOW_TIMEOUT_MS: 180_000,
}));

const { EtradePortfolioService } = await import('../src/main/services/etrade-portfolio-service.js');
const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };
const ACCOUNTS = { AccountListResponse: { Accounts: { Account: [
  { accountId: '1', accountIdKey: 'KEY1', accountName: 'X', accountType: 'I', institutionType: 'B' },
] } } };

describe('EtradePortfolioService — renew and retry', () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    etradeGet.mockReset();
    renewAccessToken.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('renews and retries when listAccounts fails on a dormant token', async () => {
    // A terminated stream, NOT a 401 — the shape a dormant token actually takes.
    etradeGet.mockRejectedValueOnce(new Error('terminated'))
             .mockResolvedValue(ACCOUNTS);

    const accounts = await new EtradePortfolioService().listAccounts(creds);

    expect(renewAccessToken).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveLength(1);
  });

  it('does not give up when renewal itself throws', async () => {
    // Renewing an ALREADY-ACTIVE token errors harmlessly; the retry decides the outcome.
    etradeGet.mockRejectedValueOnce(new Error('terminated'))
             .mockResolvedValue(ACCOUNTS);
    renewAccessToken.mockRejectedValue(new Error('token is already active'));

    const accounts = await new EtradePortfolioService().listAccounts(creds);
    expect(accounts).toHaveLength(1);
  });

  it('retries exactly once, so a genuinely dead token still fails', async () => {
    etradeGet.mockRejectedValue(new Error('terminated'));

    await expect(new EtradePortfolioService().listAccounts(creds)).rejects.toThrow('terminated');
    expect(etradeGet).toHaveBeenCalledTimes(2);       // original + one retry
    expect(renewAccessToken).toHaveBeenCalledTimes(1);
  });

  it('renews on the orders path too, not just account listing', async () => {
    let ordersAttempts = 0;
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('timeout');
      if (path.includes('/orders')) {
        ordersAttempts++;
        if (ordersAttempts === 1) throw new Error('terminated');
        return { OrdersResponse: {} };
      }
      return {};
    });

    await new EtradePortfolioService().syncClosedPositions(db, creds);

    expect(ordersAttempts).toBe(2);                   // failed, renewed, succeeded
    expect(renewAccessToken).toHaveBeenCalled();
  });
});
