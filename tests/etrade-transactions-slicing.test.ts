// Regression: the closed-position import died on a single YTD transactions query (v1.1.146).
//
// Diagnosed 2026-09-02 from the v1.1.144 E*Trade logging, first time this path was ever
// visible:
//
//   01:08:09.192  200      308ms  /v1/accounts/list
//   01:08:09.501  401  120250ms  /v1/accounts/{acct}/transactions
//         BODY: <Error><message>oauth_problem=nonce_used</message></Error>
//
// ONE app-level request, stalled 120 seconds, answered nonce_used. The duplicate nonce came
// from a transport-level retransmission: undici resent the already-signed Authorization
// header, so E*Trade saw the same oauth_nonce twice. Every other E*Trade call that session
// finished under 500 ms — the stall was the 8-month span (01012026 -> 09022026).
//
// Two fixes, both pinned here: narrow slices so no single request stalls, and a hard timeout
// so one that does stall aborts instead of being silently replayed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
// The factory must export everything the service imports: a missing named export throws
// inside fetchTransactionLegs, and syncClosedPositions' per-account try/catch swallows it,
// so the test would see zero calls rather than an error.
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet,
  buildAuthHeader: () => 'OAuth x',
  ETRADE_SLOW_TIMEOUT_MS: 180_000,
}));

const { EtradePortfolioService } = await import('../src/main/services/etrade-portfolio-service.js');

const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };

describe('closed-position import — transactions query slicing', () => {
  let db: DbHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    etradeGet.mockReset();
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) {
        return { AccountListResponse: { Accounts: { Account: [
          { accountId: '123', accountIdKey: 'KEY1', accountName: 'X', accountType: 'INDIVIDUAL', institutionType: 'BROKERAGE' },
        ] } } };
      }
      return { TransactionListResponse: {} };   // no transactions, no marker
    });
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('splits the year into narrow windows instead of one YTD span', async () => {
    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);

    const txCalls = etradeGet.mock.calls.filter(c => String(c[0]).includes('/transactions'));
    expect(txCalls.length).toBeGreaterThan(1);         // the whole point — not one big query

    for (const call of txCalls) {
      const p = call[1] as Record<string, string>;
      expect(p['startDate']).toMatch(/^\d{8}$/);       // E*Trade wants MMDDYYYY, no separators
      expect(p['endDate']).toMatch(/^\d{8}$/);
      const toDays = (s: string) =>
        Date.parse(`${s.slice(4)}-${s.slice(0, 2)}-${s.slice(2, 4)}T00:00:00Z`) / 86_400_000;
      const span = toDays(p['endDate']!) - toDays(p['startDate']!);
      expect(span).toBeGreaterThan(0);
      expect(span).toBeLessThanOrEqual(31);            // no slice wide enough to stall
    }
  });

  it('covers the full range with no gaps between slices', async () => {
    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);

    const wins = etradeGet.mock.calls
      .filter(c => String(c[0]).includes('/transactions'))
      .map(c => (c[1] as Record<string, string>))
      .map(p => ({ from: p['startDate']!, to: p['endDate']! }))
      .map(w => ({
        from: `${w.from.slice(4)}-${w.from.slice(0, 2)}-${w.from.slice(2, 4)}`,
        to:   `${w.to.slice(4)}-${w.to.slice(0, 2)}-${w.to.slice(2, 4)}`,
      }));

    expect(wins[0]!.from).toBe(`${new Date().getFullYear()}-01-01`);
    for (let i = 1; i < wins.length; i++) {
      const prevEnd = Date.parse(`${wins[i - 1]!.to}T00:00:00Z`);
      const thisStart = Date.parse(`${wins[i]!.from}T00:00:00Z`);
      // Next slice starts the day after the previous ended — contiguous, no lost days.
      expect(thisStart - prevEnd).toBe(86_400_000);
    }
    expect(wins[wins.length - 1]!.to).toBe(new Date().toISOString().slice(0, 10));
  });

  it('gives the transactions endpoint its slow-timeout budget', async () => {
    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);

    // Measured 2026-09-02: a YTD query took 120,250 ms and a 31-day slice still exceeded 30 s.
    // Narrowing the range does NOT speed this endpoint up, so it needs its own budget or the
    // default (tuned to the ~300 ms every other E*Trade call takes) guarantees failure.
    const tx = etradeGet.mock.calls.find(c => String(c[0]).includes('/transactions'));
    expect(tx?.[3]).toMatchObject({ timeoutMs: 180_000 });
  });

  it('follows pagination when E*Trade returns the marker as a number, not a string', async () => {
    let served = 0;
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) {
        return { AccountListResponse: { Accounts: { Account: [
          { accountId: '1', accountIdKey: 'KEY1', accountName: 'X', accountType: 'I', institutionType: 'B' },
        ] } } };
      }
      served++;
      // A numeric marker used to fail the `typeof === 'string'` check and silently stop
      // paging after the first page, losing every transaction beyond it.
      if (served === 1) return { TransactionListResponse: { Transaction: [], marker: 12345 } };
      return { TransactionListResponse: { Transaction: [] } };
    });

    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);

    const txCalls = etradeGet.mock.calls.filter(c => String(c[0]).includes('/transactions'));
    expect(txCalls.some(c => (c[1] as Record<string, string>)['marker'] === '12345')).toBe(true);
  });
});
