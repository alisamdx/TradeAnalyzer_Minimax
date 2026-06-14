// Order manager (Requirements/v2-execution §2.8, 03-lifecycle §3.4).
//
// Turns an approved proposal into a live order and reconciles fills into managed
// positions — the bridge between proposals/exits and the broker. Idempotency: the COID is
// minted and the order row written before the network send; broker status/fill callbacks
// drive the order state machine and open/close exec_positions. Both entry (open) and exit
// (close) orders flow through here.

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { ExecCloseReason, ExecStructure } from '../../shared/types.js';
import type { ExecutionBroker, Fill, LegSpec, OrderStatusUpdate } from './execution-broker.js';
import type { GateCandidate } from './risk-gate.js';
import type { RiskGovernor } from './risk-governor.js';

interface ProposalRow {
  id: number;
  status: string;
  expires_at: string;
  ticker: string;
  strategy: string;
  structure: string;
  legs_json: string;
  net_credit: number | null;
  max_loss: number;
  contracts: number;
}

interface OrderRow {
  id: number;
  proposal_id: number | null;
  position_id: number | null;
  side: string;
}

interface PositionRow {
  id: number;
  status: string;
  legs_json: string;
  contracts: number;
  current_mark: number | null;
}

export interface ApproveResult {
  ok: boolean;
  orderId: number | null;
  reason: string | null;
}

export class OrderManager {
  private wired = false;

  constructor(
    private readonly db: DbHandle,
    private readonly broker: ExecutionBroker,
    private readonly governor: RiskGovernor
  ) {}

  /** Wire broker status/fill callbacks once (call at core startup). */
  wire(): void {
    if (this.wired) return;
    this.broker.onOrderStatus((u) => this.handleStatus(u));
    this.broker.onFill((f) => this.handleFill(f));
    this.wired = true;
  }

  /** Approve a pending proposal → submit an open order. Re-runs the gate at submission. */
  async approveProposal(proposalId: number, now: Date): Promise<ApproveResult> {
    const p = this.db.prepare('SELECT * FROM exec_proposals WHERE id = ?').get(proposalId) as ProposalRow | undefined;
    if (!p) return { ok: false, orderId: null, reason: 'not_found' };
    if (p.status !== 'pending') return { ok: false, orderId: null, reason: 'not_pending' };
    if (Date.parse(p.expires_at) <= now.getTime()) {
      this.db.prepare("UPDATE exec_proposals SET status = 'expired' WHERE id = ?").run(proposalId);
      this.governor.audit('proposal_expired', { refTable: 'exec_proposals', refId: proposalId });
      return { ok: false, orderId: null, reason: 'expired' };
    }

    const legs = JSON.parse(p.legs_json) as LegSpec[];
    const cand: GateCandidate = {
      ticker: p.ticker,
      strategy: p.strategy,
      structure: p.structure as ExecStructure,
      isDefinedRisk: true,
      contracts: p.contracts,
      maxLossPerContract: p.max_loss,
    };
    const gate = await this.governor.checkEntry(cand, this.broker);
    if (!gate.passed) {
      this.db.prepare("UPDATE exec_proposals SET status = 'rejected', reject_reason = ? WHERE id = ?").run(gate.rejectReason, proposalId);
      this.governor.audit('proposal_rejected', { refTable: 'exec_proposals', refId: proposalId, detail: { reason: gate.rejectReason } });
      return { ok: false, orderId: null, reason: gate.rejectReason };
    }

    const coid = this.governor.newClientOrderId();
    const orderId = withTransaction(this.db, () => {
      const info = this.db
        .prepare("INSERT INTO exec_orders (client_order_id, proposal_id, status, side) VALUES (?, ?, 'pending', 'open')")
        .run(coid, proposalId);
      this.db.prepare("UPDATE exec_proposals SET status = 'approved' WHERE id = ?").run(proposalId);
      this.governor.audit('proposal_approved', { refTable: 'exec_proposals', refId: proposalId });
      return Number(info.lastInsertRowid);
    });

    // COID + submitted marker persisted before the send (§2.8).
    this.db.prepare("UPDATE exec_orders SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now.toISOString(), orderId);
    const ack = await this.broker.placeOrder({ clientOrderId: coid, legs, side: 'open', netLimit: p.net_credit ?? 0, contracts: p.contracts });
    if (!ack.accepted) {
      this.db.prepare("UPDATE exec_orders SET status = 'rejected', reject_reason = ? WHERE id = ?").run(ack.rejectReason, orderId);
      this.governor.audit('order_rejected', { refTable: 'exec_orders', refId: orderId, detail: { reason: ack.rejectReason } });
      return { ok: false, orderId, reason: ack.rejectReason ?? 'rejected' };
    }
    this.db.prepare('UPDATE exec_orders SET broker_order_id = ? WHERE id = ?').run(ack.brokerOrderId, orderId);
    this.governor.audit('order_submitted', { refTable: 'exec_orders', refId: orderId, detail: { coid, side: 'open' } });
    return { ok: true, orderId, reason: null };
  }

  /** Submit a close order for an open position (reversed legs). */
  async submitClose(positionId: number, reason: ExecCloseReason, now: Date): Promise<ApproveResult> {
    const pos = this.db.prepare('SELECT * FROM exec_positions WHERE id = ?').get(positionId) as PositionRow | undefined;
    if (!pos) return { ok: false, orderId: null, reason: 'not_found' };
    if (pos.status === 'closed') return { ok: false, orderId: null, reason: 'already_closed' };

    const legs = (JSON.parse(pos.legs_json) as LegSpec[]).map((l) => ({
      ...l,
      action: l.action === 'sell' ? ('buy' as const) : ('sell' as const),
    }));
    const coid = this.governor.newClientOrderId();
    const orderId = withTransaction(this.db, () => {
      const info = this.db
        .prepare("INSERT INTO exec_orders (client_order_id, status, side, position_id) VALUES (?, 'pending', 'close', ?)")
        .run(coid, positionId);
      this.db.prepare("UPDATE exec_positions SET status = 'closing', close_reason = ? WHERE id = ?").run(reason, positionId);
      return Number(info.lastInsertRowid);
    });

    this.db.prepare("UPDATE exec_orders SET status = 'submitted', submitted_at = ? WHERE id = ?").run(now.toISOString(), orderId);
    const ack = await this.broker.placeOrder({ clientOrderId: coid, legs, side: 'close', netLimit: pos.current_mark ?? 0.05, contracts: pos.contracts });
    if (!ack.accepted) {
      this.db.prepare("UPDATE exec_orders SET status = 'rejected', reject_reason = ? WHERE id = ?").run(ack.rejectReason, orderId);
      return { ok: false, orderId, reason: ack.rejectReason ?? 'rejected' };
    }
    this.db.prepare('UPDATE exec_orders SET broker_order_id = ? WHERE id = ?').run(ack.brokerOrderId, orderId);
    this.governor.audit('order_submitted', { refTable: 'exec_orders', refId: orderId, detail: { coid, side: 'close', reason } });
    return { ok: true, orderId, reason: null };
  }

  // ── broker callbacks ──

  private handleStatus(u: OrderStatusUpdate): void {
    this.db
      .prepare(
        "UPDATE exec_orders SET status = ?, broker_order_id = COALESCE(?, broker_order_id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE client_order_id = ?"
      )
      .run(u.status, u.brokerOrderId, u.clientOrderId);
  }

  private handleFill(fill: Fill): void {
    withTransaction(this.db, () => {
      if (this.db.prepare('SELECT id FROM exec_fills WHERE broker_exec_id = ?').get(fill.brokerExecId)) return; // dedup
      const order = this.db.prepare('SELECT id, proposal_id, position_id, side FROM exec_orders WHERE client_order_id = ?').get(fill.clientOrderId) as
        | OrderRow
        | undefined;
      if (!order) return;
      this.db
        .prepare('INSERT INTO exec_fills (order_id, broker_exec_id, filled_at, price, quantity, commission) VALUES (?, ?, ?, ?, ?, ?)')
        .run(order.id, fill.brokerExecId, fill.filledAt, fill.price, fill.contracts, fill.commission);
      this.governor.audit('fill', { refTable: 'exec_orders', refId: order.id, detail: { price: fill.price, contracts: fill.contracts } });
      if (order.side === 'open') this.applyOpenFill(order, fill);
      else this.applyCloseFill(order, fill);
    });
  }

  private applyOpenFill(order: OrderRow, fill: Fill): void {
    if (order.position_id) {
      this.db.prepare('UPDATE exec_positions SET contracts = contracts + ? WHERE id = ?').run(fill.contracts, order.position_id);
      return;
    }
    const p = this.db.prepare('SELECT * FROM exec_proposals WHERE id = ?').get(order.proposal_id) as ProposalRow;
    const info = this.db
      .prepare(
        `INSERT INTO exec_positions
           (ticker, strategy, structure, legs_json, contracts, entry_order_id, entry_net_credit, max_loss, opened_at, status, current_mark, current_pnl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 0)`
      )
      .run(p.ticker, p.strategy, p.structure, p.legs_json, fill.contracts, order.id, fill.price, p.max_loss * fill.contracts, fill.filledAt, fill.price);
    const positionId = Number(info.lastInsertRowid);
    this.db.prepare('UPDATE exec_orders SET position_id = ? WHERE id = ?').run(positionId, order.id);
    this.governor.recomputeDeployed();
    this.governor.audit('position_opened', { refTable: 'exec_positions', refId: positionId, detail: { ticker: p.ticker, contracts: fill.contracts } });
  }

  private applyCloseFill(order: OrderRow, fill: Fill): void {
    if (!order.position_id) return;
    this.db.prepare("UPDATE exec_positions SET status = 'closed', closed_at = ?, current_mark = ? WHERE id = ?").run(fill.filledAt, fill.price, order.position_id);
    this.governor.recomputeDeployed();
    this.governor.audit('position_closed', { refTable: 'exec_positions', refId: order.position_id, detail: { price: fill.price } });
  }
}
