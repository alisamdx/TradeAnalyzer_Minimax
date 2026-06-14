import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { reconcile, markNeedsAttention } from '../src/main/execution/reconciliation.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';
import type { LegSpec } from '../src/main/execution/execution-broker.js';

function db(): DbHandle {
  const d = openDatabase(':memory:');
  runMigrations(d, MIGRATIONS_DIR);
  return d;
}

const SPREAD: LegSpec[] = [
  { ticker: 'AAA', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 },
  { ticker: 'AAA', right: 'P', action: 'buy', strike: 95, expiry: '2026-07-17', ratio: 1 },
];

function insertPosition(d: DbHandle, ticker: string, status = 'open') {
  d.prepare(
    `INSERT INTO exec_positions (ticker, strategy, structure, legs_json, contracts, max_loss, opened_at, status)
     VALUES (?, 'inflection', 'short-put-vertical', '[]', 1, 350, '2026-06-14', ?)`
  ).run(ticker, status);
}

describe('reconcile', () => {
  it('is consistent and updates the mark when broker and core agree', async () => {
    const d = db();
    const broker = new MockExecutionBroker();
    await broker.connect();
    await broker.placeOrder({ clientOrderId: 'o1', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    insertPosition(d, 'AAA');

    const r = await reconcile(d, broker);
    expect(r.consistent).toBe(true);
    const mark = (d.prepare('SELECT current_mark AS m FROM exec_positions WHERE ticker = ?').get('AAA') as { m: number }).m;
    expect(mark).toBeCloseTo(0.1, 5);
  });

  it('flags an unexpected broker position (broker holds, core does not)', async () => {
    const d = db();
    const broker = new MockExecutionBroker();
    await broker.connect();
    await broker.placeOrder({ clientOrderId: 'o2', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    // no exec_positions row

    const r = await reconcile(d, broker);
    expect(r.consistent).toBe(false);
    expect(r.unexpectedBrokerTickers).toContain('AAA');
  });

  it('flags a position missing at the broker (core open, broker has none)', async () => {
    const d = db();
    const broker = new MockExecutionBroker();
    await broker.connect();
    insertPosition(d, 'BBB');

    const r = await reconcile(d, broker);
    expect(r.consistent).toBe(false);
    expect(r.missingAtBroker).toContain('BBB');
  });

  it('syncs order status from broker truth', async () => {
    const d = db();
    const broker = new MockExecutionBroker({ fillMode: 'manual' });
    await broker.connect();
    await broker.placeOrder({ clientOrderId: 'ord-9', legs: SPREAD, side: 'open', netLimit: 0.1, contracts: 1 });
    d.prepare("INSERT INTO exec_orders (client_order_id, status, side) VALUES ('ord-9', 'pending', 'open')").run();

    await reconcile(d, broker);
    const row = d.prepare('SELECT status, broker_order_id FROM exec_orders WHERE client_order_id = ?').get('ord-9') as {
      status: string;
      broker_order_id: string | null;
    };
    expect(row.status).toBe('working');
    expect(row.broker_order_id).toBeTruthy();
  });

  it('markNeedsAttention flags the given open positions', () => {
    const d = db();
    insertPosition(d, 'CCC');
    markNeedsAttention(d, ['CCC']);
    const status = (d.prepare('SELECT status FROM exec_positions WHERE ticker = ?').get('CCC') as { status: string }).status;
    expect(status).toBe('needs_attention');
  });
});
