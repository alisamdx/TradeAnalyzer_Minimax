// Deterministic in-memory ExecutionBroker for tests and offline development.
//
// It is the backbone that lets the entire engine (risk governor, loops, control panel)
// be built and exercised with NO IBKR account (Requirements/v2-execution/05, "Strategy").
// Behaviour is deterministic and fully controllable: fills, rejections, connection state,
// buying power, and marks can all be driven by the caller so tests assert exact outcomes.

import type { ExecLeg } from '../../shared/types.js';
import type {
  BrokerOrder,
  BrokerPosition,
  BuyingPower,
  ComboQuote,
  ConnState,
  ExecutionBroker,
  Fill,
  LegSpec,
  OrderAck,
  OrderRequest,
  OrderStatusUpdate,
  PermissionCheck,
  QualifiedContract,
} from './execution-broker.js';

/** How a freshly-placed order behaves by default (override per-order via drive methods). */
export type MockFillMode = 'auto' | 'manual' | 'reject' | 'partial';

export interface MockOptions {
  buyingPower?: number; // default 100_000
  halfSpread?: number; // default 0.05 (per-share)
  /** Per-leg per-share premium. Default = 2% of strike (a short vertical → positive credit). */
  pricer?: (leg: LegSpec) => number;
  fillMode?: MockFillMode; // default 'auto'
  commissionPerContractLeg?: number; // default 0.65
}

interface InternalOrder {
  clientOrderId: string;
  brokerOrderId: string;
  side: 'open' | 'close';
  legs: LegSpec[];
  contracts: number;
  netLimit: number;
  status: OrderStatusUpdate['status'];
  filled: number;
}

// Signature excludes `action` so a closing order (reversed legs) matches the position
// it opened — a given ticker holds at most one structure under the v2.0 rules.
function legSignature(legs: LegSpec[]): string {
  return [...legs]
    .map((l) => `${l.right}${l.strike}@${l.expiry}x${l.ratio}`)
    .sort()
    .join('|');
}

function toExecLegs(legs: LegSpec[]): ExecLeg[] {
  return legs.map((l) => ({
    right: l.right,
    action: l.action,
    strike: l.strike,
    expiry: l.expiry,
    ratio: l.ratio,
  }));
}

export class MockExecutionBroker implements ExecutionBroker {
  private connected = false;
  private connState: ConnState = 'disconnected';
  private buyingPower: number;
  private readonly halfSpread: number;
  private readonly pricer: (leg: LegSpec) => number;
  private readonly fillMode: MockFillMode;
  private readonly commissionPerContractLeg: number;

  private readonly connCbs: Array<(s: ConnState) => void> = [];
  private readonly statusCbs: Array<(u: OrderStatusUpdate) => void> = [];
  private readonly fillCbs: Array<(f: Fill) => void> = [];

  private readonly orders = new Map<string, InternalOrder>(); // by COID
  private readonly positions = new Map<string, BrokerPosition>(); // by ticker|signature
  private brokerSeq = 0;
  private execSeq = 0;

  constructor(opts: MockOptions = {}) {
    this.buyingPower = opts.buyingPower ?? 100_000;
    this.halfSpread = opts.halfSpread ?? 0.05;
    this.pricer = opts.pricer ?? ((leg) => Number((leg.strike * 0.02).toFixed(2)));
    this.fillMode = opts.fillMode ?? 'auto';
    this.commissionPerContractLeg = opts.commissionPerContractLeg ?? 0.65;
  }

  // ── lifecycle ──

  connect(): Promise<void> {
    this.setConnectionState('connected');
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionState(cb: (s: ConnState) => void): void {
    this.connCbs.push(cb);
  }

  // ── reference / pricing ──

  qualifyContract(spec: LegSpec): Promise<QualifiedContract> {
    return Promise.resolve({
      spec,
      conId: `MOCK-${spec.ticker}-${spec.right}-${spec.strike}-${spec.expiry}`,
      multiplier: 100,
      qualified: true,
    });
  }

  priceCombo(legs: LegSpec[]): Promise<ComboQuote> {
    const net = legs.reduce((sum, leg) => {
      const px = this.pricer(leg) * leg.ratio;
      return sum + (leg.action === 'sell' ? px : -px);
    }, 0);
    const netCredit = Number(net.toFixed(2));
    return Promise.resolve({
      legs,
      netCredit,
      bid: Number((netCredit - this.halfSpread).toFixed(2)),
      ask: Number((netCredit + this.halfSpread).toFixed(2)),
      mid: netCredit,
      asOf: new Date().toISOString(),
    });
  }

  getBuyingPower(): Promise<BuyingPower> {
    return Promise.resolve({ available: this.buyingPower, total: this.buyingPower, currency: 'USD' });
  }

  /** A simulator always has full permissions — paper/mock never models a broker entitlement. */
  checkSpreadPermission(): Promise<PermissionCheck> {
    return Promise.resolve({ ok: true, code: 'ok', message: 'mock broker: spread permission simulated' });
  }

  // ── orders ──

  placeOrder(o: OrderRequest): Promise<OrderAck> {
    // Idempotency: a repeated COID never creates a duplicate (§2.8).
    const existing = this.orders.get(o.clientOrderId);
    if (existing) {
      return Promise.resolve({
        clientOrderId: o.clientOrderId,
        brokerOrderId: existing.brokerOrderId,
        accepted: existing.status !== 'rejected',
        rejectReason: null,
      });
    }

    if (!this.connected) {
      return Promise.resolve({
        clientOrderId: o.clientOrderId,
        brokerOrderId: null,
        accepted: false,
        rejectReason: 'not_connected',
      });
    }

    const brokerOrderId = `B${++this.brokerSeq}`;
    const order: InternalOrder = {
      clientOrderId: o.clientOrderId,
      brokerOrderId,
      side: o.side,
      legs: o.legs,
      contracts: o.contracts,
      netLimit: o.netLimit,
      status: 'submitted',
      filled: 0,
    };
    this.orders.set(o.clientOrderId, order);

    this.emitStatus(order);
    order.status = 'working';
    this.emitStatus(order);

    switch (this.fillMode) {
      case 'auto':
        this.fillOrder(o.clientOrderId);
        break;
      case 'partial':
        this.fillOrder(o.clientOrderId, Math.max(1, Math.floor(o.contracts / 2)));
        break;
      case 'reject':
        this.rejectOrder(o.clientOrderId, 'mock_reject');
        break;
      case 'manual':
        break;
    }

    return Promise.resolve({ clientOrderId: o.clientOrderId, brokerOrderId, accepted: true, rejectReason: null });
  }

  cancelOrder(clientOrderId: string): Promise<void> {
    const order = this.orders.get(clientOrderId);
    if (order && (order.status === 'working' || order.status === 'submitted' || order.status === 'partially_filled')) {
      order.status = 'cancelled';
      this.emitStatus(order);
    }
    return Promise.resolve();
  }

  onOrderStatus(cb: (u: OrderStatusUpdate) => void): void {
    this.statusCbs.push(cb);
  }

  onFill(cb: (f: Fill) => void): void {
    this.fillCbs.push(cb);
  }

  // ── truth ──

  getOpenPositions(): Promise<BrokerPosition[]> {
    return Promise.resolve([...this.positions.values()].map((p) => ({ ...p, legs: [...p.legs] })));
  }

  getOrders(): Promise<BrokerOrder[]> {
    return Promise.resolve(
      [...this.orders.values()].map((o) => ({
        clientOrderId: o.clientOrderId,
        brokerOrderId: o.brokerOrderId,
        status: o.status,
        side: o.side,
        contracts: o.contracts,
        filledContracts: o.filled,
      }))
    );
  }

  // ── test / drive controls (not part of the interface) ──

  setConnectionState(state: ConnState): void {
    this.connState = state;
    this.connected = state === 'connected';
    for (const cb of this.connCbs) cb(state);
  }

  setBuyingPower(amount: number): void {
    this.buyingPower = amount;
  }

  /** Set the current net mark (per-share) for the open position on `ticker`. */
  setMark(ticker: string, mark: number): void {
    for (const p of this.positions.values()) {
      if (p.ticker === ticker) p.mark = mark;
    }
  }

  /** Fill (all or `contracts`) of a working order, emitting status + a Fill event. */
  fillOrder(clientOrderId: string, contracts?: number): void {
    const order = this.orders.get(clientOrderId);
    if (!order || order.status === 'filled' || order.status === 'rejected' || order.status === 'cancelled') return;

    const remaining = order.contracts - order.filled;
    const qty = Math.min(contracts ?? remaining, remaining);
    if (qty <= 0) return;

    order.filled += qty;
    order.status = order.filled >= order.contracts ? 'filled' : 'partially_filled';

    const fill: Fill = {
      clientOrderId,
      brokerOrderId: order.brokerOrderId,
      brokerExecId: `E${++this.execSeq}`,
      price: order.netLimit,
      contracts: qty,
      commission: Number((this.commissionPerContractLeg * qty * order.legs.length).toFixed(2)),
      filledAt: new Date().toISOString(),
    };

    this.applyFillToPositions(order, qty);
    this.emitStatus(order);
    for (const cb of this.fillCbs) cb(fill);
  }

  rejectOrder(clientOrderId: string, reason: string): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;
    order.status = 'rejected';
    this.emitStatus(order, reason);
  }

  // ── internals ──

  private applyFillToPositions(order: InternalOrder, qty: number): void {
    const ticker = order.legs[0]?.ticker ?? '';
    const key = `${ticker}|${legSignature(order.legs)}`;
    const existing = this.positions.get(key);

    if (order.side === 'open') {
      if (existing) {
        existing.contracts += qty;
      } else {
        this.positions.set(key, {
          ticker,
          legs: toExecLegs(order.legs),
          contracts: qty,
          avgPrice: order.netLimit,
          mark: order.netLimit,
        });
      }
    } else {
      // close: reduce / remove the matching position
      if (existing) {
        existing.contracts -= qty;
        if (existing.contracts <= 0) this.positions.delete(key);
      }
    }
  }

  private emitStatus(order: InternalOrder, rejectReason: string | null = null): void {
    const update: OrderStatusUpdate = {
      clientOrderId: order.clientOrderId,
      brokerOrderId: order.brokerOrderId,
      status: order.status,
      filledContracts: order.filled,
      remainingContracts: order.contracts - order.filled,
      rejectReason,
    };
    for (const cb of this.statusCbs) cb(update);
  }
}
