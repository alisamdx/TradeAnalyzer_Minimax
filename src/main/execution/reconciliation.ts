// Reconciliation (Requirements/v2-execution §2.9). The broker is the source of truth.
//
// Pulls broker positions/orders, syncs order status + position marks into exec_*, and
// detects drift between the core's belief and broker reality. It does NOT itself decide
// the response — the caller (ExecutionCore) fails closed: refuse-to-start at cold start,
// trip the kill switch during a running cycle. Keeping detection separate from response
// keeps both testable.

import type { DbHandle } from '../db/connection.js';
import type { ExecutionBroker } from './execution-broker.js';

export interface ReconcileResult {
  consistent: boolean;
  /** Broker holds a position the core has no open row for (e.g. a manual trade). */
  unexpectedBrokerTickers: string[];
  /** Core believes a position is open that the broker does not report. */
  missingAtBroker: string[];
}

const OPEN_STATES = "('open','closing','needs_attention')";

export async function reconcile(db: DbHandle, broker: ExecutionBroker): Promise<ReconcileResult> {
  const [brokerPositions, brokerOrders] = await Promise.all([broker.getOpenPositions(), broker.getOrders()]);

  // Sync order status from broker truth (match by client order id).
  const updateOrder = db.prepare(
    "UPDATE exec_orders SET status = ?, broker_order_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE client_order_id = ?"
  );
  for (const bo of brokerOrders) {
    if (bo.clientOrderId) updateOrder.run(bo.status, bo.brokerOrderId, bo.clientOrderId);
  }

  // Sync marks onto matching open positions (ticker holds ≤1 structure under v2.0 rules).
  const updateMark = db.prepare(
    `UPDATE exec_positions SET current_mark = ? WHERE ticker = ? AND status IN ${OPEN_STATES}`
  );
  for (const bp of brokerPositions) {
    if (bp.mark != null) updateMark.run(bp.mark, bp.ticker);
  }

  const coreTickers = new Set(
    (db.prepare(`SELECT ticker FROM exec_positions WHERE status IN ${OPEN_STATES}`).all() as Array<{ ticker: string }>).map(
      (r) => r.ticker
    )
  );
  const brokerTickers = new Set(brokerPositions.map((p) => p.ticker));

  const unexpectedBrokerTickers = [...brokerTickers].filter((t) => !coreTickers.has(t));
  const missingAtBroker = [...coreTickers].filter((t) => !brokerTickers.has(t));

  return {
    consistent: unexpectedBrokerTickers.length === 0 && missingAtBroker.length === 0,
    unexpectedBrokerTickers,
    missingAtBroker,
  };
}

/** Flag the given tickers' open positions as needs_attention (mismatch response). */
export function markNeedsAttention(db: DbHandle, tickers: string[]): void {
  if (tickers.length === 0) return;
  const stmt = db.prepare(
    `UPDATE exec_positions SET status = 'needs_attention' WHERE ticker = ? AND status IN ('open','closing')`
  );
  for (const t of tickers) stmt.run(t);
}
