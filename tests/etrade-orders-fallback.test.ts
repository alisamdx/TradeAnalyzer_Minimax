// Executed-orders fallback for the closed-position import (v1.1.150).
//
// `/v1/accounts/{key}/transactions` is unresponsive for this account. Nine hypotheses were
// tested against the API log and all falsified: range (8mo / 31d / 7d / none), path (with and
// without `.json`), sortOrder, count (5 / 50), a fresh nonce, and our signing — against 28
// other calls on the same credentials all returning 200 in ~300 ms.
//
// E*Trade exposes no dedicated closed-positions endpoint; Transactions and Orders are the two
// documented ways to reconstruct one. Orders is the better source regardless:
//   - `orderAction` states OPEN vs CLOSE outright (the transactions path had to guess with
//     "a sell must be an open", which mislabels an assignment)
//   - `averageExecutionPrice` is the realised fill, which is the entire point of this import

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-auth.js', () => ({
  etradeGet,
  buildAuthHeader: () => 'OAuth x',
  ETRADE_SLOW_TIMEOUT_MS: 180_000,
}));

const { EtradePortfolioService } = await import('../src/main/services/etrade-portfolio-service.js');
const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };

const ACCOUNTS = { AccountListResponse: { Accounts: { Account: [
  { accountId: '1', accountIdKey: 'KEY1', accountName: 'X', accountType: 'I', institutionType: 'B' },
] } } };

/** One executed option order, in E*Trade's documented OrdersResponse shape. */
function order(id: number, action: string, price: number, epochMs: number) {
  return {
    orderId: id,
    OrderDetail: [{
      executedTime: epochMs,
      Instrument: [{
        orderAction: action,
        filledQuantity: 1,
        averageExecutionPrice: price,
        estimatedCommission: 0.65,
        Product: {
          symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT',
          expiryYear: 2026, expiryMonth: 7, expiryDay: 31, strikePrice: 350,
        },
      }],
    }],
  };
}

describe('closed-position import — executed-orders fallback', () => {
  let db: DbHandle;
  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    etradeGet.mockReset();
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('falls back to executed orders when transactions is unresponsive, with REAL fills', async () => {
    etradeGet.mockImplementation(async (path: string, params: Record<string, string>) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('The operation was aborted due to timeout');
      if (path.includes('/orders')) {
        expect(params['status']).toBe('EXECUTED');
        expect(params['fromDate']).toMatch(/^\d{8}$/);   // MMDDYYYY, no separators
        return { OrdersResponse: { Order: [
          order(1, 'SELL_OPEN',  5.00, Date.UTC(2026, 6, 17)),
          order(2, 'BUY_CLOSE',  1.20, Date.UTC(2026, 6, 28)),
        ] } };
      }
      return {};
    });

    const svc = new EtradePortfolioService();
    const res = await svc.syncClosedPositions(db, creds);

    expect(res.positionsUpserted).toBe(1);
    const row = db.prepare(`SELECT * FROM positions WHERE status='closed'`).get() as
      { ticker: string; entry_price: number; exit_price: number; strike_price: number };
    expect(row.ticker).toBe('TSLA');
    expect(row.strike_price).toBe(350);
    // The whole point: a real fill, not a mark. Every existing row has exit_price NULL.
    expect(row.entry_price).toBeCloseTo(5.00, 2);
    expect(row.exit_price).toBeCloseTo(1.20, 2);
  });

  it('reads OPEN vs CLOSE from orderAction rather than guessing from buy/sell', async () => {
    // A BUY_OPEN followed by SELL_CLOSE is a LONG option round trip. The transactions
    // heuristic ("bought = close") would have mislabelled the opening leg.
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('timeout');
      if (path.includes('/orders')) {
        return { OrdersResponse: { Order: [
          order(3, 'BUY_OPEN',   2.00, Date.UTC(2026, 5, 10)),
          order(4, 'SELL_CLOSE', 3.50, Date.UTC(2026, 5, 20)),
        ] } };
      }
      return {};
    });

    const svc = new EtradePortfolioService();
    const res = await svc.syncClosedPositions(db, creds);
    expect(res.positionsUpserted).toBe(1);
    const row = db.prepare(`SELECT entry_price, exit_price FROM positions WHERE status='closed'`)
      .get() as { entry_price: number; exit_price: number };
    expect(row.entry_price).toBeCloseTo(2.00, 2);
    expect(row.exit_price).toBeCloseTo(3.50, 2);
  });

  it('pages through orders with a numeric marker', async () => {
    let page = 0;
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('timeout');
      if (path.includes('/orders')) {
        page++;
        if (page === 1) {
          return { OrdersResponse: { Order: [order(5, 'SELL_OPEN', 4, Date.UTC(2026, 4, 1))], marker: 999 } };
        }
        return { OrdersResponse: { Order: [order(6, 'BUY_CLOSE', 1, Date.UTC(2026, 4, 9))] } };
      }
      return {};
    });

    const svc = new EtradePortfolioService();
    await svc.syncClosedPositions(db, creds);

    const orderCalls = etradeGet.mock.calls.filter(c => String(c[0]).includes('/orders'));
    expect(orderCalls.some(c => (c[1] as Record<string, string>)['marker'] === '999')).toBe(true);
  });

  it('surfaces why the fallback engaged rather than hiding it', async () => {
    etradeGet.mockImplementation(async (path: string) => {
      if (path.includes('/accounts/list')) return ACCOUNTS;
      if (path.includes('/transactions')) throw new Error('The operation was aborted due to timeout');
      return { OrdersResponse: {} };
    });

    const svc = new EtradePortfolioService();
    const res = await svc.syncClosedPositions(db, creds);
    expect(res.errors.join(' ')).toMatch(/Transactions unavailable, falling back to executed orders/);
  });
});
