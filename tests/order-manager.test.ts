import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { OrderManager } from '../src/main/execution/order-manager.js';
import { EntryPolicy, type PickInput } from '../src/main/execution/entry-policy.js';
import { RiskGovernor } from '../src/main/execution/risk-governor.js';
import { MockExecutionBroker } from '../src/main/execution/mock-execution-broker.js';

const NOW = new Date('2026-06-15T18:00:00Z');

function pick(overrides: Partial<PickInput> = {}): PickInput {
  return {
    ticker: 'AAA',
    strategy: 'inflection',
    structure: 'short-put-vertical',
    legs: [
      { ticker: 'AAA', right: 'P', action: 'sell', strike: 100, expiry: '2026-07-17', ratio: 1 },
      { ticker: 'AAA', right: 'P', action: 'buy', strike: 95, expiry: '2026-07-17', ratio: 1 },
    ],
    compositeScore: 80,
    criticVerdict: 'pass',
    hasAdequateLiquidity: true,
    earningsBeforeExpiry: false,
    maxLossPerContract: 350,
    sourceBriefId: null,
    ...overrides,
  };
}

async function setup() {
  const db: DbHandle = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const broker = new MockExecutionBroker();
  const governor = new RiskGovernor(db);
  const entryPolicy = new EntryPolicy(db, governor);
  const om = new OrderManager(db, broker, governor);
  om.wire();
  await broker.connect();
  governor.start();
  return { db, broker, governor, entryPolicy, om };
}

async function makeProposal(ctx: Awaited<ReturnType<typeof setup>>, overrides: Partial<PickInput> = {}): Promise<number> {
  const out = await ctx.entryPolicy.buildProposal(pick(overrides), ctx.broker, NOW);
  return out.proposalId!;
}

describe('OrderManager.approveProposal', () => {
  it('approves → submits → fills → opens a position', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    const res = await ctx.om.approveProposal(proposalId, NOW);
    expect(res.ok).toBe(true);

    // The mock fills synchronously on placeOrder, so by here the entry is a position and its
    // proposal is retired to 'superseded' (counts the entry once — via the position — not twice).
    const proposal = ctx.db.prepare('SELECT status FROM exec_proposals WHERE id = ?').get(proposalId) as { status: string };
    expect(proposal.status).toBe('superseded');

    const order = ctx.db.prepare('SELECT * FROM exec_orders WHERE id = ?').get(res.orderId) as Record<string, unknown>;
    expect(order.status).toBe('filled');
    expect(order.side).toBe('open');
    expect(order.position_id).not.toBeNull();
    expect(order.broker_order_id).toBeTruthy();

    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM exec_fills').get() as { n: number }).n).toBe(1);

    const pos = ctx.db.prepare('SELECT * FROM exec_positions').get() as Record<string, unknown>;
    expect(pos.ticker).toBe('AAA');
    expect(pos.status).toBe('open');
    expect(pos.contracts).toBe(1);
    expect(pos.entry_net_credit).toBeCloseTo(0.1, 5);
    expect(pos.max_loss).toBe(350);

    expect(ctx.governor.getRiskState().capitalDeployed).toBe(350);

    const events = (ctx.db.prepare('SELECT event FROM exec_audit_log').all() as Array<{ event: string }>).map((r) => r.event);
    for (const e of ['proposal_approved', 'order_submitted', 'fill', 'position_opened']) expect(events).toContain(e);
  });

  it('refuses a non-pending proposal', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    await ctx.om.approveProposal(proposalId, NOW);
    const again = await ctx.om.approveProposal(proposalId, NOW);
    expect(again.reason).toBe('not_pending');
  });

  it('expires a stale proposal', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    const later = new Date(NOW.getTime() + 3 * 3_600_000); // +3h > 120-min shelf life
    const res = await ctx.om.approveProposal(proposalId, later);
    expect(res.reason).toBe('expired');
    const status = (ctx.db.prepare('SELECT status FROM exec_proposals WHERE id = ?').get(proposalId) as { status: string }).status;
    expect(status).toBe('expired');
  });

  it('re-checks the gate at submission and rejects on failure', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    ctx.governor.stop(); // engine no longer running
    const res = await ctx.om.approveProposal(proposalId, NOW);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('engine_running');
    const status = (ctx.db.prepare('SELECT status FROM exec_proposals WHERE id = ?').get(proposalId) as { status: string }).status;
    expect(status).toBe('rejected');
  });
});

describe('OrderManager.submitClose', () => {
  it('closes an open position (reversed legs) and frees capital', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    await ctx.om.approveProposal(proposalId, NOW);
    const positionId = (ctx.db.prepare('SELECT id FROM exec_positions').get() as { id: number }).id;

    const res = await ctx.om.submitClose(positionId, 'profit_target', NOW);
    expect(res.ok).toBe(true);

    const pos = ctx.db.prepare('SELECT * FROM exec_positions WHERE id = ?').get(positionId) as Record<string, unknown>;
    expect(pos.status).toBe('closed');
    expect(pos.close_reason).toBe('profit_target');
    expect(pos.closed_at).toBeTruthy();

    const order = ctx.db.prepare("SELECT * FROM exec_orders WHERE side = 'close'").get() as Record<string, unknown>;
    expect(order.status).toBe('filled');
    expect(order.position_id).toBe(positionId);

    expect(ctx.governor.getRiskState().capitalDeployed).toBe(0);
  });

  it('refuses to close an already-closed position', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    await ctx.om.approveProposal(proposalId, NOW);
    const positionId = (ctx.db.prepare('SELECT id FROM exec_positions').get() as { id: number }).id;
    await ctx.om.submitClose(positionId, 'manual', NOW);
    const again = await ctx.om.submitClose(positionId, 'manual', NOW);
    expect(again.reason).toBe('already_closed');
  });
});

describe('OrderManager.reconcileStaleOrders', () => {
  // A combo order the broker silently drops sits 'submitted' forever; its approved proposal would
  // otherwise hold the daily-cap slot indefinitely. The sweep cancels it and frees the slot.
  const stuckOpenOrder = (ctx: Awaited<ReturnType<typeof setup>>, proposalId: number, submittedAt: string): number => {
    ctx.db.prepare("UPDATE exec_proposals SET status = 'approved' WHERE id = ?").run(proposalId);
    const info = ctx.db
      .prepare("INSERT INTO exec_orders (client_order_id, proposal_id, status, side, submitted_at) VALUES ('ta_stuck_open', ?, 'submitted', 'open', ?)")
      .run(proposalId, submittedAt);
    return Number(info.lastInsertRowid);
  };

  it('cancels a stale submitted OPEN order and expires its proposal to free the cap', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    const orderId = stuckOpenOrder(ctx, proposalId, new Date(NOW.getTime() - 5 * 60_000).toISOString()); // 5 min old

    const swept = await ctx.om.reconcileStaleOrders(NOW, 90_000);
    expect(swept).toBe(1);

    const order = ctx.db.prepare('SELECT status, reject_reason FROM exec_orders WHERE id = ?').get(orderId) as { status: string; reject_reason: string };
    expect(order.status).toBe('cancelled');
    expect(order.reject_reason).toBe('stale_no_ack');

    const proposal = ctx.db.prepare('SELECT status FROM exec_proposals WHERE id = ?').get(proposalId) as { status: string };
    expect(proposal.status).toBe('expired'); // cap slot freed

    const events = (ctx.db.prepare('SELECT event FROM exec_audit_log').all() as Array<{ event: string }>).map((r) => r.event);
    expect(events).toContain('order_stale_cancelled');
    expect(events).toContain('proposal_expired');
  });

  it('leaves a fresh (not-yet-stale) submitted order untouched', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    const orderId = stuckOpenOrder(ctx, proposalId, NOW.toISOString()); // just submitted

    const swept = await ctx.om.reconcileStaleOrders(NOW, 90_000);
    expect(swept).toBe(0);
    const order = ctx.db.prepare('SELECT status FROM exec_orders WHERE id = ?').get(orderId) as { status: string };
    expect(order.status).toBe('submitted');
    const proposal = ctx.db.prepare('SELECT status FROM exec_proposals WHERE id = ?').get(proposalId) as { status: string };
    expect(proposal.status).toBe('approved');
  });

  it('un-sticks a position when a stale CLOSE order is swept', async () => {
    const ctx = await setup();
    const proposalId = await makeProposal(ctx);
    await ctx.om.approveProposal(proposalId, NOW); // open + fill a position
    const positionId = (ctx.db.prepare('SELECT id FROM exec_positions').get() as { id: number }).id;
    // Simulate a close order that was submitted but never acked: position stuck 'closing'.
    ctx.db.prepare("UPDATE exec_positions SET status = 'closing', close_reason = 'profit_target' WHERE id = ?").run(positionId);
    ctx.db
      .prepare("INSERT INTO exec_orders (client_order_id, position_id, status, side, submitted_at) VALUES ('ta_stuck_close', ?, 'submitted', 'close', ?)")
      .run(positionId, new Date(NOW.getTime() - 5 * 60_000).toISOString());

    const swept = await ctx.om.reconcileStaleOrders(NOW, 90_000);
    expect(swept).toBe(1);
    const pos = ctx.db.prepare('SELECT status, close_reason FROM exec_positions WHERE id = ?').get(positionId) as { status: string; close_reason: string | null };
    expect(pos.status).toBe('open'); // re-openable so management retries the close
    expect(pos.close_reason).toBeNull();
  });
});
