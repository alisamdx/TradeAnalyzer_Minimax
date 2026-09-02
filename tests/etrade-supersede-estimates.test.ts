// Imported real fills must SUPERSEDE the estimated rows, not sit beside them (v1.1.151).
//
// When a position vanishes from the broker, the position sync writes an estimate marked
// "realized P&L estimated from last mark" with exit_price NULL. Those are systematically wrong
// in two ways, measured 2026-09-02 against actual fills:
//   - an ASSIGNED CSP reads as a large loss when it was a conversion into stock
//     (TSLA 350: estimate -$3,735.53, actual +$499.48)
//   - a position closed by expiry is booked at its last mark rather than zero
//     (TSLA 360 CC: estimate -$463.02, actual +$347.47)
// Those two rows alone accounted for a $4,235 swing, and the book overall read -$2,902 when it
// was actually +$4,494.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet, buildAuthHeader: () => 'OAuth x', ETRADE_SLOW_TIMEOUT_MS: 180_000,
}));
const { EtradePortfolioService } = await import('../src/main/services/etrade-portfolio-service.js');
const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };
const ACCOUNTS = { AccountListResponse: { Accounts: { Account: [
  { accountId: '1', accountIdKey: 'KEY1', accountName: 'X', accountType: 'I', institutionType: 'B' },
] } } };

function order(id: number, action: string, price: number, epochMs: number) {
  return { orderId: id, OrderDetail: [{ executedTime: epochMs, Instrument: [{
    orderAction: action, filledQuantity: 1, averageExecutionPrice: price,
    Product: { symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT',
               expiryYear: 2026, expiryMonth: 7, expiryDay: 31, strikePrice: 350 },
  }] }] };
}

describe('imported fills supersede estimated rows', () => {
  let db: DbHandle;
  const estimate = (over: Record<string, unknown> = {}) => {
    const base = {
      ticker: 'TSLA', position_type: 'CSP', quantity: 1, entry_price: 5, entry_date: '2026-07-17',
      strike_price: 350, expiration_date: '2026-07-31', status: 'closed',
      exit_date: '2026-08-01T16:41:28.908Z', realized_pnl: -3735.53,
      exit_notes: 'Closed via E*Trade sync (no longer at broker); realized P&L estimated from last mark',
      ...over,
    };
    db.prepare(`INSERT INTO positions
      (ticker,position_type,quantity,entry_price,entry_date,strike_price,expiration_date,status,exit_date,realized_pnl,exit_notes,created_at,updated_at)
      VALUES (@ticker,@position_type,@quantity,@entry_price,@entry_date,@strike_price,@expiration_date,@status,@exit_date,@realized_pnl,@exit_notes,'x','x')`).run(base);
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    etradeGet.mockReset();
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('timeout');
      if (path.includes('/orders')) {
        return { OrdersResponse: { Order: [
          order(1, 'SELL_OPEN', 5.00, Date.UTC(2026, 6, 17)),
          order(2, 'BUY_CLOSE', 0.00, Date.UTC(2026, 6, 31)),
        ] } };
      }
      return {};
    });
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('overwrites the estimate in place rather than creating a duplicate', async () => {
    estimate();
    await new EtradePortfolioService().syncClosedPositions(db, creds);

    const rows = db.prepare(`SELECT * FROM positions WHERE ticker='TSLA' AND position_type='CSP'`)
      .all() as Array<{ exit_price: number | null; realized_pnl: number; exit_notes: string }>;
    expect(rows).toHaveLength(1);                       // superseded, not duplicated
    expect(rows[0]!.exit_price).not.toBeNull();         // a real fill now
    expect(rows[0]!.realized_pnl).toBeGreaterThan(0);   // not the -3735.53 estimate
    expect(rows[0]!.exit_notes).toMatch(/Superseded by actual E\*Trade fill/);
  });

  it('does NOT collapse an open assignment lot into an unrelated closed stock lot', async () => {
    // Matching on ticker+type alone merged an open 100-share assignment lot with a closed
    // 60-share lot from four months earlier. Quantity and entry_date are part of the key.
    db.prepare(`INSERT INTO positions (ticker,position_type,quantity,entry_price,entry_date,status,created_at,updated_at)
                VALUES ('TSLA','Stock',100,345.0052,'2026-07-29','open','x','x')`).run();
    estimate();

    await new EtradePortfolioService().syncClosedPositions(db, creds);

    const stock = db.prepare(`SELECT status, quantity FROM positions WHERE position_type='Stock'`)
      .get() as { status: string; quantity: number };
    expect(stock.status).toBe('open');     // untouched
    expect(stock.quantity).toBe(100);
  });

  it('is idempotent — a second import neither duplicates nor re-supersedes', async () => {
    estimate();
    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);
    const after1 = db.prepare(`SELECT COUNT(*) n FROM positions`).get() as { n: number };

    await svc.syncClosedPositions(db, creds);
    const after2 = db.prepare(`SELECT COUNT(*) n FROM positions`).get() as { n: number };
    expect(after2.n).toBe(after1.n);
  });

  it('leaves an estimate alone when no real fill matches it', async () => {
    // A directional leg the orders feed never returned must keep its estimate rather than
    // being silently dropped or zeroed.
    estimate({ ticker: 'NFLX', position_type: 'Long Call', strike_price: 85,
               expiration_date: '2026-07-17', entry_date: '2026-06-09', realized_pnl: -113.51 });

    await new EtradePortfolioService().syncClosedPositions(db, creds);

    const row = db.prepare(`SELECT exit_price, realized_pnl FROM positions WHERE ticker='NFLX'`)
      .get() as { exit_price: number | null; realized_pnl: number };
    expect(row.exit_price).toBeNull();
    expect(row.realized_pnl).toBeCloseTo(-113.51, 2);
  });
});
