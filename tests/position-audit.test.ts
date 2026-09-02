// Audit trail for automated writes to the real position record (v1.1.159).
//
// The nightly sync is the FIRST batch job that mutates financial data rather than market data.
// Every other job touches prices or signals — if one corrupts something you re-fetch it. This
// one rewrites `positions`, and its supersede path OVERWRITES a stored realized P&L.
//
// Risk is low by construction (idempotent; only ever replaces an ESTIMATE with a broker fill,
// never the reverse) but "unattended, nightly, on money" earns a record. Tonight's whole E*Trade
// investigation only became tractable once the calls were logged; same argument.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet, renewAccessToken: vi.fn(), buildAuthHeader: () => 'OAuth x',
  ETRADE_SLOW_TIMEOUT_MS: 180_000,
}));
const { EtradePortfolioService } = await import('../src/main/services/etrade-portfolio-service.js');

const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };
const ACCOUNTS = { AccountListResponse: { Accounts: { Account: [
  { accountId: '1', accountIdKey: 'KEY1', accountName: 'X', accountType: 'I', institutionType: 'B' },
] } } };
const order = (id: number, action: string, price: number, epochMs: number) => ({
  orderId: id, OrderDetail: [{ executedTime: epochMs, Instrument: [{
    orderAction: action, filledQuantity: 1, averageExecutionPrice: price,
    Product: { symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT',
               expiryYear: 2026, expiryMonth: 7, expiryDay: 31, strikePrice: 350 } }] }],
});

describe('position_audit', () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    etradeGet.mockReset().mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('timeout');
      if (path.includes('/orders')) {
        return { OrdersResponse: { Order: [
          order(1, 'SELL_OPEN', 5.00, Date.UTC(2026, 6, 17)),
          order(2, 'BUY_CLOSE', 0.02, Date.UTC(2026, 6, 30)),
        ] } };
      }
      return {};
    });
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('records an import with no prior value', async () => {
    await new EtradePortfolioService().syncClosedPositions(db, creds);
    const a = db.prepare(`SELECT * FROM position_audit`).get() as {
      action: string; ticker: string; old_realized_pnl: number | null;
      new_realized_pnl: number; source: string;
    };
    expect(a.action).toBe('imported');
    expect(a.ticker).toBe('TSLA');
    expect(a.old_realized_pnl).toBeNull();      // nothing existed before
    expect(a.new_realized_pnl).toBeGreaterThan(0);
    expect(a.source).toBe('orders');
  });

  it('preserves the OVERWRITTEN value when a bad estimate is superseded', async () => {
    // The exact shape that made the book read -$2,902: an assigned CSP booked as a large loss.
    db.prepare(`INSERT INTO positions
      (ticker,position_type,quantity,entry_price,entry_date,strike_price,expiration_date,
       status,exit_date,realized_pnl,exit_notes,created_at,updated_at)
      VALUES ('TSLA','CSP',1,5,'2026-07-17',350,'2026-07-31','closed',
              '2026-08-01T16:41:28.908Z',-3735.53,'estimated from last mark','x','x')`).run();

    await new EtradePortfolioService().syncClosedPositions(db, creds);

    const a = db.prepare(`SELECT * FROM position_audit WHERE action='superseded'`).get() as {
      old_realized_pnl: number; new_realized_pnl: number; note: string; position_id: number;
    };
    // Without this row the -3735.53 would be gone with no trace of what replaced it or why.
    expect(a.old_realized_pnl).toBeCloseTo(-3735.53, 2);
    expect(a.new_realized_pnl).toBeGreaterThan(0);
    expect(a.note).toMatch(/estimate from last mark replaced by broker fill/);
    expect(a.position_id).toBeGreaterThan(0);
  });

  it('writes nothing when a run changes nothing — idempotent reruns stay quiet', async () => {
    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);
    const after1 = (db.prepare(`SELECT COUNT(*) n FROM position_audit`).get() as { n: number }).n;

    await svc.syncClosedPositions(db, creds);
    const after2 = (db.prepare(`SELECT COUNT(*) n FROM position_audit`).get() as { n: number }).n;
    expect(after2).toBe(after1);        // a nightly job must not grow the log for doing nothing
  });
});
