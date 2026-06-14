import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ManagementLoop } from '../src/main/execution/position-manager.js';
import { OrderManager } from '../src/main/execution/order-manager.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';

const NOW = new Date('2026-06-15T18:00:00Z');
const FAR = '2026-07-17';

async function setup() {
  const db: DbHandle = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const governor = new RiskGovernor(db);
  const om = new OrderManager(db, broker, governor);
  om.wire();
  await broker.connect();
  const mgmt = new ManagementLoop(db, governor, om);
  return { db, broker, governor, om, mgmt };
}

function insertPos(
  db: DbHandle,
  o: { ticker?: string; credit: number; mark: number | null; openedAt?: string; expiry?: string }
): number {
  const ticker = o.ticker ?? 'AAA';
  const legs = [
    { ticker, right: 'P', action: 'sell', strike: 100, expiry: o.expiry ?? FAR, ratio: 1 },
    { ticker, right: 'P', action: 'buy', strike: 95, expiry: o.expiry ?? FAR, ratio: 1 },
  ];
  const info = db
    .prepare(
      `INSERT INTO exec_positions
         (ticker, strategy, structure, legs_json, contracts, entry_net_credit, max_loss, opened_at, status, current_mark, current_pnl)
       VALUES (?, 'inflection', 'short-put-vertical', ?, 1, ?, 350, ?, 'open', ?, 0)`
    )
    .run(ticker, JSON.stringify(legs), o.credit, o.openedAt ?? NOW.toISOString(), o.mark);
  return Number(info.lastInsertRowid);
}

describe('ManagementLoop.runOnce', () => {
  it('auto-closes on a protective stop', async () => {
    const { db, mgmt } = await setup();
    const id = insertPos(db, { credit: 0.1, mark: 0.35 });
    const outcomes = await mgmt.runOnce(NOW);
    expect(outcomes[0]).toEqual({ positionId: id, action: 'closed', reason: 'stop' });
    const pos = db.prepare('SELECT status, close_reason FROM exec_positions WHERE id = ?').get(id) as { status: string; close_reason: string };
    expect(pos.status).toBe('closed');
    expect(pos.close_reason).toBe('stop');
  });

  it('proposes (not auto-closes) a discretionary profit target by default', async () => {
    const { db, mgmt } = await setup();
    const id = insertPos(db, { credit: 0.1, mark: 0.04 });
    const outcomes = await mgmt.runOnce(NOW);
    expect(outcomes[0]).toEqual({ positionId: id, action: 'proposed', reason: 'profit_target' });
    expect((db.prepare('SELECT status FROM exec_positions WHERE id = ?').get(id) as { status: string }).status).toBe('open');
    const prop = db.prepare("SELECT * FROM exec_proposals WHERE kind = 'exit'").get() as Record<string, unknown>;
    expect(prop.position_id).toBe(id);
    expect(prop.close_reason).toBe('profit_target');
  });

  it('auto-closes a discretionary exit when the mode is auto', async () => {
    const { db, governor, mgmt } = await setup();
    governor.updateConfig({ profitTargetMode: 'auto' });
    const id = insertPos(db, { credit: 0.1, mark: 0.04 });
    const outcomes = await mgmt.runOnce(NOW);
    expect(outcomes[0]!.action).toBe('closed');
    expect((db.prepare('SELECT status FROM exec_positions WHERE id = ?').get(id) as { status: string }).status).toBe('closed');
  });

  it('does not duplicate a pending exit proposal across cycles', async () => {
    const { db, mgmt } = await setup();
    insertPos(db, { credit: 0.1, mark: 0.04 });
    await mgmt.runOnce(NOW);
    await mgmt.runOnce(NOW);
    expect((db.prepare("SELECT COUNT(*) AS n FROM exec_proposals WHERE kind = 'exit'").get() as { n: number }).n).toBe(1);
  });

  it('takes no action when no rule triggers', async () => {
    const { db, mgmt } = await setup();
    const id = insertPos(db, { credit: 0.1, mark: 0.08 });
    expect((await mgmt.runOnce(NOW))[0]).toEqual({ positionId: id, action: 'none', reason: null });
  });
});

describe('ManagementLoop.approveExitProposal', () => {
  it('approves a proposed exit and closes the position', async () => {
    const { db, mgmt } = await setup();
    const posId = insertPos(db, { credit: 0.1, mark: 0.04 });
    await mgmt.runOnce(NOW); // creates the exit proposal
    const proposalId = (db.prepare("SELECT id FROM exec_proposals WHERE kind = 'exit'").get() as { id: number }).id;

    const res = await mgmt.approveExitProposal(proposalId, NOW);
    expect(res.ok).toBe(true);
    expect((db.prepare('SELECT status FROM exec_positions WHERE id = ?').get(posId) as { status: string }).status).toBe('closed');
  });
});
