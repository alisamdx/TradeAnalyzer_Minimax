// Regression for v1.1.180: the cash balance snapshot must happen on EVERY sync path.
//
// v1.1.179 hooked `syncBalances` into the batch job only. The manual Sync button goes through
// `portfolio:etrade:sync` straight to `syncPortfolio`, so it snapshotted nothing — the operator
// synced, the Portfolio strip still read "no balance synced yet", and the API log for that day
// contained ZERO `/balance` calls. Two sync paths, one instrumented.
//
// The fix was to move the snapshot INSIDE `syncPortfolio`, which both paths call. These tests pin
// that: the balance is written as a consequence of syncing the portfolio, not as a step some
// callers remember to add.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet,
  renewAccessToken: vi.fn().mockResolvedValue(undefined),
}));

const { EtradePortfolioService } = await import('../src/main/services/etrade-portfolio-service.js');

const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };
let db: DbHandle;

/** Routes each E*Trade path to a canned response. */
function route(opts: { balance?: unknown; balanceThrows?: boolean } = {}) {
  etradeGet.mockReset().mockImplementation(async (path: string) => {
    if (path === '/v1/accounts/list') {
      return { AccountListResponse: { Accounts: { Account: [
        { accountId: '511275374', accountIdKey: 'KEY1', accountName: 'Wheel', accountType: 'INDIVIDUAL', institutionType: 'BROKERAGE' },
      ] } } };
    }
    if (path.endsWith('/portfolio')) {
      return { PortfolioResponse: { AccountPortfolio: [{ Position: [] }] } };
    }
    if (path.endsWith('/balance')) {
      if (opts.balanceThrows) throw new Error('E*Trade 401 token_rejected');
      return opts.balance ?? {
        BalanceResponse: {
          accountId: '511275374',
          Computed: {
            cashAvailableForInvestment: 21_450.75,
            cashBalance: 21_500,
            netCash: 21_450.75,
            settledCashForInvestment: 21_000,
            marginBuyingPower: 0,
            RealTimeValues: { totalAccountValue: 59_087.25 },
          },
        },
      };
    }
    throw new Error(`unexpected path ${path}`);
  });
}

const balances = () => db.prepare('SELECT * FROM account_balances').all() as Array<Record<string, unknown>>;

describe('balance snapshot is part of syncPortfolio', () => {
  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    route();
  });

  // The exact bug: syncing the portfolio wrote no balance.
  it('writes a snapshot as a consequence of syncPortfolio — the manual Sync path', async () => {
    await new EtradePortfolioService().syncPortfolio(db, creds);
    const rows = balances();
    expect(rows).toHaveLength(1);
    expect(rows[0]!['account_id_key']).toBe('KEY1');
    expect(rows[0]!['cash_available']).toBeCloseTo(21_450.75);
    expect(rows[0]!['total_account_value']).toBeCloseTo(59_087.25);
    // And it actually called the endpoint, rather than writing a default.
    expect(etradeGet.mock.calls.some(c => String(c[0]).endsWith('/balance'))).toBe(true);
  });

  it('passes the required query params — E*Trade rejects the call without instType', async () => {
    await new EtradePortfolioService().syncPortfolio(db, creds);
    const call = etradeGet.mock.calls.find(c => String(c[0]).endsWith('/balance'));
    expect(call?.[1]).toMatchObject({ instType: 'BROKERAGE', realTimeNAV: 'true' });
  });

  // Reporting must never break the thing it reports on.
  it('still syncs positions when the balance call fails', async () => {
    route({ balanceThrows: true });
    const r = await new EtradePortfolioService().syncPortfolio(db, creds);
    expect(r.accountsScanned).toBe(1);
    expect(r.errors).toHaveLength(0);      // a balance failure is not a sync error
    expect(balances()).toHaveLength(0);
  });

  it('nulls a missing field rather than storing zero', async () => {
    route({ balance: { BalanceResponse: { accountId: 'X', Computed: { cashBalance: 100 } } } });
    await new EtradePortfolioService().syncPortfolio(db, creds);
    const r = balances()[0]!;
    // A missing balance and a zero balance are very different facts to a wheel operator.
    expect(r['cash_available']).toBeNull();
    expect(r['total_account_value']).toBeNull();
    expect(r['cash_balance']).toBe(100);
  });

  it('replaces rather than duplicates on a same-day re-sync', async () => {
    const svc = new EtradePortfolioService();
    await svc.syncPortfolio(db, creds);
    route({ balance: { BalanceResponse: { accountId: 'X', Computed: { cashAvailableForInvestment: 9_000 } } } });
    await svc.syncPortfolio(db, creds);
    const rows = balances();
    expect(rows).toHaveLength(1);
    expect(rows[0]!['cash_available']).toBe(9_000);
  });

  it('does not make a second /accounts/list call just to snapshot', async () => {
    await new EtradePortfolioService().syncPortfolio(db, creds);
    const listCalls = etradeGet.mock.calls.filter(c => c[0] === '/v1/accounts/list').length;
    expect(listCalls).toBe(1);
  });
});
