// The ExecutionBroker seam (Requirements/v2-execution/01-architecture §1.4).
//
// This interface abstracts the venue that places and fills orders, so the engine
// (governor, loops, UI) never depends on a concrete broker. v2.0 ships two
// implementations behind it: `MockExecutionBroker` (deterministic, for tests and
// offline dev) and — once the IBKR account is live — `IbkrExecutionBroker`. Paper vs
// live is a config of the IBKR implementation, never a code branch here.
//
// These types are main-process internal: the renderer talks to the core's control API,
// never to a broker directly. Persisted/IPC domain shapes live in src/shared/types.ts.

import type { ExecLeg } from '../../shared/types.js';

/** Broker session state. `reauth_needed` is treated as fail-closed by the core. */
export type ConnState = 'connected' | 'disconnected' | 'reauth_needed';

/** One option leg to be priced/ordered (the underlying + contract spec). */
export interface LegSpec {
  ticker: string; // underlying symbol
  right: 'P' | 'C';
  action: 'buy' | 'sell';
  strike: number;
  expiry: string; // YYYY-MM-DD
  ratio: number; // contracts multiple within the combo (usually 1)
}

/** A broker-qualified contract (conId resolved). Always re-qualified before an order. */
export interface QualifiedContract {
  spec: LegSpec;
  conId: string; // broker contract id
  multiplier: number; // 100 for equity options
  qualified: boolean;
}

/** Live net pricing for a combo, from the execution venue (per-share). */
export interface ComboQuote {
  legs: LegSpec[];
  netCredit: number; // per-share; positive = credit received, negative = debit paid
  bid: number; // combo net bid
  ask: number; // combo net ask
  mid: number;
  asOf: string; // ISO timestamp
}

export interface BuyingPower {
  available: number; // $ available to deploy
  total: number;
  currency: string;
}

/** A request to place a combo order. `clientOrderId` (COID) is the idempotency key. */
export interface OrderRequest {
  clientOrderId: string;
  legs: LegSpec[];
  side: 'open' | 'close';
  netLimit: number; // net limit price per-share (credit positive)
  contracts: number;
}

export interface OrderAck {
  clientOrderId: string;
  brokerOrderId: string | null;
  accepted: boolean;
  rejectReason: string | null;
}

export type BrokerOrderStatus =
  | 'submitted'
  | 'working'
  | 'filled'
  | 'partially_filled'
  | 'rejected'
  | 'cancelled';

export interface OrderStatusUpdate {
  clientOrderId: string;
  brokerOrderId: string | null;
  status: BrokerOrderStatus;
  filledContracts: number;
  remainingContracts: number;
  rejectReason: string | null;
}

export interface Fill {
  clientOrderId: string;
  brokerOrderId: string;
  brokerExecId: string; // unique per fill (dedup key)
  price: number; // net per-share
  contracts: number;
  commission: number;
  filledAt: string; // ISO
}

/** A position as the broker reports it — the source of truth for reconciliation. */
export interface BrokerPosition {
  ticker: string;
  legs: ExecLeg[];
  contracts: number;
  avgPrice: number; // net per-share entry credit
  mark: number | null; // current net mark per-share
}

export interface BrokerOrder {
  clientOrderId: string | null;
  brokerOrderId: string;
  status: BrokerOrderStatus;
  side: 'open' | 'close';
  contracts: number;
  filledContracts: number;
}

/**
 * The broker abstraction. Implementations must be idempotent on `clientOrderId`
 * (a repeated COID must never create a duplicate order — §2.8) and must treat the
 * caller's COID as the canonical key across reconnects/crashes.
 */
export interface ExecutionBroker {
  // ── lifecycle ──
  connect(): Promise<void>;
  isConnected(): boolean;
  onConnectionState(cb: (s: ConnState) => void): void;

  // ── reference / pricing (priced at the execution venue — §0.6) ──
  qualifyContract(spec: LegSpec): Promise<QualifiedContract>;
  priceCombo(legs: LegSpec[]): Promise<ComboQuote>;
  getBuyingPower(): Promise<BuyingPower>;

  // ── orders (idempotent on clientOrderId) ──
  placeOrder(o: OrderRequest): Promise<OrderAck>;
  cancelOrder(clientOrderId: string): Promise<void>;
  onOrderStatus(cb: (u: OrderStatusUpdate) => void): void;
  onFill(cb: (f: Fill) => void): void;

  // ── truth (for reconciliation — §2.9) ──
  getOpenPositions(): Promise<BrokerPosition[]>;
  getOrders(): Promise<BrokerOrder[]>;
}
