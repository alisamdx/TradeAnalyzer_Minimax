// IBKR implementation of the ExecutionBroker seam (Requirements/v2-execution §1.5, Phase 6).
//
// Talks to a locally-running TWS or IB Gateway over the TWS socket API via @stoqey/ib.
// Paper vs live is purely a host/port of the *connection* (TWS paper 7497 / live 7496,
// Gateway paper 4002 / live 4001) — never a code branch here, matching the seam contract.
// The engine, governor, loops, and UI are unchanged; this class swaps in behind the
// interface via the broker factory.
//
// Scope note (options approval): connection, contract qualification, account/buying-power,
// and position/order reads need no options trading permission and are live-verifiable now.
// Combo order placement + fills require the account's options-spread permission; the order
// path is implemented to IBKR's documented combo conventions and is calibrated/verified on
// the paper account during Phase 7. The combo net-price sign convention is centralised in
// `comboLimitOrderParams()` so there is a single place to confirm against paper fills.

import {
  IBApi,
  EventName,
  ErrorCode,
  SecType,
  OrderAction,
  OrderType,
  OptionType,
  TimeInForce,
  type Contract,
  type Order,
  type OrderStatus,
  type ContractDetails,
  type Execution,
  type CommissionReport,
} from '@stoqey/ib';
import type { ExecLeg } from '../../shared/types.js';
import type {
  BrokerOrder,
  BrokerOrderStatus,
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
  QualifiedContract,
} from './execution-broker.js';

export interface IbkrBrokerOptions {
  host?: string; // default 127.0.0.1
  port: number; // 7497 TWS paper · 7496 TWS live · 4002 GW paper · 4001 GW live
  clientId?: number; // default 7 — stable so this app reconnects to its own session
  account?: string; // explicit account; else the first managed account
  reqTimeoutMs?: number; // default 12_000 — per data request
  exchange?: string; // default SMART
  currency?: string; // default USD
}

// ── pure helpers (no connection — unit tested) ──────────────────────────────

/** YYYY-MM-DD → YYYYMMDD (IBKR `lastTradeDateOrContractMonth`). */
export function toIbkrExpiry(expiry: string): string {
  return expiry.replace(/-/g, '');
}

/** A single option leg → an IBKR OPT contract for qualification/pricing. */
export function legToOptionContract(
  leg: LegSpec,
  opts: { exchange: string; currency: string }
): Contract {
  return {
    symbol: leg.ticker,
    secType: SecType.OPT,
    lastTradeDateOrContractMonth: toIbkrExpiry(leg.expiry),
    strike: leg.strike,
    right: leg.right as OptionType, // 'P' | 'C' map 1:1 to OptionType.Put/Call
    multiplier: 100,
    exchange: opts.exchange,
    currency: opts.currency,
  };
}

/**
 * Net-limit → IBKR combo (BAG) order parameters. Single source of truth for the
 * sign convention. We always submit the BAG as a BUY of the combo; IBKR reads a
 * **negative** limit price as a net **credit received** and a positive price as a
 * net debit paid. Our `netLimit` is credit-positive (per the seam), so we negate it.
 */
export function comboLimitOrderParams(netLimit: number): { action: OrderAction; lmtPrice: number } {
  return { action: OrderAction.BUY, lmtPrice: Number((-netLimit).toFixed(2)) };
}

/** The inverse of {@link comboLimitOrderParams}: an IBKR combo fill price → credit-positive. */
export function ibkrFillToNetCredit(ibkrPrice: number): number {
  return Number((-ibkrPrice).toFixed(2));
}

/** Per-leg top-of-book used to price a combo from its legs. */
export interface LegQuote {
  bid: number;
  ask: number;
}

/**
 * Compute a credit-positive combo quote from each leg's top-of-book. IBKR returns no market
 * data for smart-routed BAG combos, so the adapter prices from the legs that *do* have data.
 * A sold leg adds its premium (credit), a bought leg subtracts it (debit). `bid` is the
 * conservative side (sell at each sold-leg bid, buy at each bought-leg ask); `ask` the other.
 */
export function comboQuoteFromLegs(
  legs: LegSpec[],
  quotes: LegQuote[]
): { netCredit: number; bid: number; ask: number; mid: number } {
  let mid = 0;
  let low = 0;
  let high = 0;
  legs.forEach((leg, i) => {
    const q = quotes[i]!;
    const legMid = (q.bid + q.ask) / 2;
    const r = leg.ratio;
    if (leg.action === 'sell') {
      mid += legMid * r;
      low += q.bid * r;
      high += q.ask * r;
    } else {
      mid -= legMid * r;
      low -= q.ask * r;
      high -= q.bid * r;
    }
  });
  const round = (n: number): number => Number(n.toFixed(2));
  return { netCredit: round(mid), bid: round(Math.min(low, high)), ask: round(Math.max(low, high)), mid: round(mid) };
}

/** Map IBKR order-status strings to the seam's BrokerOrderStatus. */
export function mapIbkrOrderStatus(status: string): BrokerOrderStatus {
  switch (status) {
    case 'PendingSubmit':
    case 'PreSubmitted':
    case 'ApiPending':
      return 'submitted';
    case 'Submitted':
      return 'working';
    case 'Filled':
      return 'filled';
    case 'Cancelled':
    case 'ApiCancelled':
    case 'Inactive':
      return 'cancelled';
    default:
      return 'working';
  }
}

/** IBKR `error` callbacks with code < 1000 against a live request are real failures;
 *  these specific notices are benign session/data-farm chatter (reqId === -1). */
export function isBenignNotice(code: number): boolean {
  return [2104, 2106, 2107, 2108, 2158, 2119, 2100, 1102].includes(code);
}

// ── adapter ─────────────────────────────────────────────────────────────────

interface RequestSlot {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  data: unknown[];
}

interface TrackedOrder {
  clientOrderId: string;
  brokerOrderId: string;
  side: 'open' | 'close';
  contracts: number;
  status: BrokerOrderStatus;
  filled: number;
  lastEmittedFill: number; // contracts already surfaced as Fill events (dedup)
  commissionAccrued: number;
}

export class IbkrExecutionBroker implements ExecutionBroker {
  private readonly ib: IBApi;
  private readonly host: string;
  private readonly port: number;
  private readonly clientId: number;
  private readonly reqTimeoutMs: number;
  private readonly exchange: string;
  private readonly currency: string;
  private accountId: string | null;

  private connected = false;
  private nextOrderId = -1;
  private reqSeq = 9_000_000; // data-request ids, kept clear of order ids
  private readonly pending = new Map<number, RequestSlot>();
  private readonly connCbs: Array<(s: ConnState) => void> = [];
  private readonly statusCbs: Array<(u: OrderStatusUpdate) => void> = [];
  private readonly fillCbs: Array<(f: Fill) => void> = [];

  private readonly ordersByBrokerId = new Map<string, TrackedOrder>();
  private readonly coidToBrokerId = new Map<string, string>(); // idempotency key
  private readonly commissionByExecId = new Map<string, number>();
  private positionReqId: number | null = null; // single in-flight reqPositions slot
  private openOrderReqId: number | null = null; // single in-flight reqAllOpenOrders slot
  private readonly mdPending = new Map<number, (field: number, price: number) => void>(); // per-leg quote subs
  private readonly mdTimeoutMs: number;

  constructor(opts: IbkrBrokerOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port;
    this.clientId = opts.clientId ?? 7;
    this.reqTimeoutMs = opts.reqTimeoutMs ?? 12_000;
    this.mdTimeoutMs = 5_000; // per-leg quote collection window before resolving with what arrived
    this.exchange = opts.exchange ?? 'SMART';
    this.currency = opts.currency ?? 'USD';
    this.accountId = opts.account ?? null;
    this.ib = new IBApi({ host: this.host, port: this.port, clientId: this.clientId });
    this.wireEvents();
  }

  // ── lifecycle ──

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`IBKR connect timed out (${this.host}:${this.port}) — is TWS/Gateway logged in with the API enabled?`));
      }, this.reqTimeoutMs);
      const onReady = (orderId: number): void => {
        this.nextOrderId = orderId;
        this.connected = true;
        clearTimeout(timer);
        this.emitConn('connected');
        resolve();
      };
      this.ib.once(EventName.nextValidId, onReady);
      try {
        this.ib.connect();
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionState(cb: (s: ConnState) => void): void {
    this.connCbs.push(cb);
  }

  disconnect(): void {
    try {
      this.ib.disconnect();
    } catch {
      /* already down */
    }
  }

  // ── reference / pricing ──

  async qualifyContract(spec: LegSpec): Promise<QualifiedContract> {
    const contract = legToOptionContract(spec, { exchange: this.exchange, currency: this.currency });
    const reqId = this.nextReqId();
    const details = await this.request<ContractDetails>(reqId, () =>
      this.ib.reqContractDetails(reqId, contract)
    );
    const first = details[0];
    if (!first?.contract?.conId) {
      return { spec, conId: '', multiplier: 100, qualified: false };
    }
    return {
      spec,
      conId: String(first.contract.conId),
      multiplier: Number(first.contract.multiplier ?? 100),
      qualified: true,
    };
  }

  async priceCombo(legs: LegSpec[]): Promise<ComboQuote> {
    // IBKR returns no market data for smart-routed BAG combos, so price from the individual
    // legs (which do have data) and net them — see comboQuoteFromLegs.
    const quotes = await Promise.all(legs.map((leg) => this.quoteLeg(leg)));
    const missing = quotes.findIndex((q) => q.bid <= 0 && q.ask <= 0);
    if (missing >= 0) {
      const l = legs[missing]!;
      throw new Error(`no market data for ${l.ticker} ${l.right}${l.strike} ${l.expiry} (options data subscription?)`);
    }
    const q = comboQuoteFromLegs(legs, quotes);
    return { legs, ...q, asOf: new Date().toISOString() };
  }

  /** Top-of-book for a single option leg via a short streaming subscription. */
  private quoteLeg(leg: LegSpec): Promise<LegQuote> {
    const contract = legToOptionContract(leg, { exchange: this.exchange, currency: this.currency });
    const reqId = this.nextReqId();
    return new Promise<LegQuote>((resolve) => {
      const acc: { bid?: number; ask?: number } = {};
      const settle = (): void => {
        clearTimeout(timer);
        this.mdPending.delete(reqId);
        try {
          this.ib.cancelMktData(reqId);
        } catch {
          /* already gone */
        }
        resolve({ bid: acc.bid ?? 0, ask: acc.ask ?? 0 });
      };
      const timer = setTimeout(settle, this.mdTimeoutMs);
      this.mdPending.set(reqId, (field, price) => {
        if (price < 0) return;
        if (field === 1 || field === 66) acc.bid = price; // bid / delayed-bid
        else if (field === 2 || field === 67) acc.ask = price; // ask / delayed-ask
        if (acc.bid != null && acc.ask != null) settle();
      });
      this.ib.reqMktData(reqId, contract, '', false, false);
    });
  }

  async getBuyingPower(): Promise<BuyingPower> {
    const reqId = this.nextReqId();
    const rows = await this.request<{ tag: string; value: string; currency: string }>(reqId, () =>
      this.ib.reqAccountSummary(reqId, 'All', 'NetLiquidation,AvailableFunds,BuyingPower')
    );
    this.ib.cancelAccountSummary(reqId);
    const pick = (tag: string): number => {
      const r = rows.find((x) => x.tag === tag);
      return r ? Number(r.value) : 0;
    };
    const currency = rows[0]?.currency ?? this.currency;
    return { available: pick('AvailableFunds'), total: pick('NetLiquidation'), currency };
  }

  // ── orders (idempotent on clientOrderId — §2.8) ──

  async placeOrder(o: OrderRequest): Promise<OrderAck> {
    // Idempotency: a repeated COID never creates a second broker order.
    const existingId = this.coidToBrokerId.get(o.clientOrderId);
    if (existingId) {
      const tracked = this.ordersByBrokerId.get(existingId);
      return { clientOrderId: o.clientOrderId, brokerOrderId: existingId, accepted: tracked?.status !== 'rejected', rejectReason: null };
    }
    if (!this.connected) {
      return { clientOrderId: o.clientOrderId, brokerOrderId: null, accepted: false, rejectReason: 'not_connected' };
    }

    let bag: Contract;
    try {
      bag = await this.buildComboContract(o.legs);
    } catch (e) {
      return { clientOrderId: o.clientOrderId, brokerOrderId: null, accepted: false, rejectReason: e instanceof Error ? e.message : 'qualify_failed' };
    }

    const orderId = this.takeOrderId();
    const brokerOrderId = String(orderId);
    const { action, lmtPrice } = comboLimitOrderParams(o.netLimit);
    const order: Order = {
      action,
      orderType: OrderType.LMT,
      totalQuantity: o.contracts,
      lmtPrice,
      tif: TimeInForce.DAY,
      orderRef: o.clientOrderId,
      transmit: true,
      // Combos legging into different exchanges fill non-guaranteed; required or IBKR rejects.
      smartComboRoutingParams: [{ tag: 'NonGuaranteed', value: '1' }],
      ...(this.accountId ? { account: this.accountId } : {}),
    };

    const tracked: TrackedOrder = {
      clientOrderId: o.clientOrderId,
      brokerOrderId,
      side: o.side,
      contracts: o.contracts,
      status: 'submitted',
      filled: 0,
      lastEmittedFill: 0,
      commissionAccrued: 0,
    };
    this.ordersByBrokerId.set(brokerOrderId, tracked);
    this.coidToBrokerId.set(o.clientOrderId, brokerOrderId);

    try {
      this.ib.placeOrder(orderId, bag, order);
    } catch (e) {
      tracked.status = 'rejected';
      return { clientOrderId: o.clientOrderId, brokerOrderId: null, accepted: false, rejectReason: e instanceof Error ? e.message : 'place_failed' };
    }
    return { clientOrderId: o.clientOrderId, brokerOrderId, accepted: true, rejectReason: null };
  }

  cancelOrder(clientOrderId: string): Promise<void> {
    const brokerOrderId = this.coidToBrokerId.get(clientOrderId);
    if (brokerOrderId) {
      const id = Number(brokerOrderId);
      try {
        // @stoqey/ib's cancelOrder takes (orderId, manualOrderCancelTime?).
        (this.ib.cancelOrder as (orderId: number, t?: string) => void)(id, '');
      } catch {
        /* already terminal */
      }
    }
    return Promise.resolve();
  }

  onOrderStatus(cb: (u: OrderStatusUpdate) => void): void {
    this.statusCbs.push(cb);
  }

  onFill(cb: (f: Fill) => void): void {
    this.fillCbs.push(cb);
  }

  // ── truth (reconciliation — §2.9) ──

  async getOpenPositions(): Promise<BrokerPosition[]> {
    const reqId = this.nextReqId();
    type Row = { account: string; contract: Contract; pos: number; avgCost: number };
    this.positionReqId = reqId;
    const rows = await this.request<Row>(reqId, () => this.ib.reqPositions()).finally(() => {
      this.positionReqId = null;
    });
    this.ib.cancelPositions();
    // Group option legs back into per-underlying structures. avgPrice/mark at combo level
    // require the original combo price; reconciliation matches on legs + contract count.
    const byTicker = new Map<string, BrokerPosition>();
    for (const r of rows) {
      if (r.contract.secType !== SecType.OPT || r.pos === 0) continue;
      const ticker = r.contract.symbol ?? '';
      const leg: ExecLeg = {
        right: (r.contract.right as 'P' | 'C') ?? 'P',
        action: r.pos > 0 ? 'buy' : 'sell',
        strike: Number(r.contract.strike ?? 0),
        expiry: fromIbkrExpiry(String(r.contract.lastTradeDateOrContractMonth ?? '')),
        ratio: 1,
      };
      const existing = byTicker.get(ticker);
      if (existing) {
        existing.legs.push(leg);
      } else {
        byTicker.set(ticker, {
          ticker,
          legs: [leg],
          contracts: Math.abs(r.pos),
          avgPrice: 0,
          mark: null,
        });
      }
    }
    return [...byTicker.values()];
  }

  async getOrders(): Promise<BrokerOrder[]> {
    const reqId = this.nextReqId();
    this.openOrderReqId = reqId;
    await this.request<unknown>(reqId, () => this.ib.reqAllOpenOrders())
      .catch(() => [])
      .finally(() => {
        this.openOrderReqId = null;
      });
    return [...this.ordersByBrokerId.values()].map((o) => ({
      clientOrderId: o.clientOrderId,
      brokerOrderId: o.brokerOrderId,
      status: o.status,
      side: o.side,
      contracts: o.contracts,
      filledContracts: o.filled,
    }));
  }

  // ── internals ──

  private async buildComboContract(legs: LegSpec[]): Promise<Contract> {
    const qualified = await Promise.all(legs.map((l) => this.qualifyContract(l)));
    const bad = qualified.find((q) => !q.qualified);
    if (bad) throw new Error(`could not qualify ${bad.spec.ticker} ${bad.spec.right}${bad.spec.strike} ${bad.spec.expiry}`);
    const symbol = legs[0]?.ticker ?? '';
    return {
      symbol,
      secType: SecType.BAG,
      currency: this.currency,
      exchange: this.exchange,
      comboLegs: qualified.map((q, i) => ({
        conId: Number(q.conId),
        ratio: legs[i]!.ratio,
        action: legs[i]!.action === 'sell' ? OrderAction.SELL : OrderAction.BUY,
        exchange: this.exchange,
      })),
    };
  }

  private nextReqId(): number {
    return ++this.reqSeq;
  }

  private takeOrderId(): number {
    const id = this.nextOrderId;
    this.nextOrderId += 1;
    return id;
  }

  /** Issue a request and resolve the collected rows when its wired `*End`/error settles it. */
  private request<T>(reqId: number, fire: () => void): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`IBKR request ${reqId} timed out after ${this.reqTimeoutMs}ms`));
      }, this.reqTimeoutMs);
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as T[]),
        reject,
        timer,
        data: [],
      });
      try {
        fire();
      } catch (e) {
        this.settle(reqId, 'reject', e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private settle(reqId: number, how: 'resolve' | 'reject', errOrNothing?: Error): void {
    const slot = this.pending.get(reqId);
    if (!slot) return;
    clearTimeout(slot.timer);
    this.pending.delete(reqId);
    if (how === 'resolve') slot.resolve(slot.data);
    else slot.reject(errOrNothing ?? new Error('request failed'));
  }

  private push(reqId: number, row: unknown): void {
    this.pending.get(reqId)?.data.push(row);
  }

  private wireEvents(): void {
    this.ib.on(EventName.nextValidId, (id: number) => {
      if (this.nextOrderId < 0) this.nextOrderId = id;
    });
    this.ib.on(EventName.managedAccounts, (accounts: string) => {
      if (!this.accountId) this.accountId = accounts.split(',')[0]?.trim() ?? null;
    });
    this.ib.on(EventName.disconnected, () => {
      this.connected = false;
      this.emitConn('disconnected');
    });
    this.ib.on(EventName.connectionClosed, () => {
      this.connected = false;
      this.emitConn('disconnected');
    });

    // Reference / pricing collectors.
    this.ib.on(EventName.contractDetails, (reqId: number, details: ContractDetails) => this.push(reqId, details));
    this.ib.on(EventName.contractDetailsEnd, (reqId: number) => this.settle(reqId, 'resolve'));
    this.ib.on(EventName.accountSummary, (reqId: number, _acct: string, tag: string, value: string, currency: string) =>
      this.push(reqId, { tag, value, currency })
    );
    this.ib.on(EventName.accountSummaryEnd, (reqId: number) => this.settle(reqId, 'resolve'));
    this.ib.on(EventName.tickPrice, (reqId: number, field: number, price: number) => {
      this.mdPending.get(reqId)?.(field, price);
    });
    // reqPositions/reqAllOpenOrders are account-wide subscriptions whose `*End` events
    // carry no reqId, so route them to the single in-flight request slot.
    this.ib.on(EventName.position, (account: string, contract: Contract, pos: number, avgCost?: number) => {
      if (this.positionReqId != null) this.push(this.positionReqId, { account, contract, pos, avgCost: avgCost ?? 0 });
    });
    this.ib.on(EventName.positionEnd, () => {
      if (this.positionReqId != null) this.settle(this.positionReqId, 'resolve');
    });
    this.ib.on(EventName.openOrder, (orderId: number, _contract: Contract, order: Order) => {
      // Re-bind COID→brokerOrderId on reconnect from the order's orderRef.
      const coid = order.orderRef;
      if (coid && !this.coidToBrokerId.has(coid)) this.coidToBrokerId.set(coid, String(orderId));
    });
    this.ib.on(EventName.openOrderEnd, () => {
      if (this.openOrderReqId != null) this.settle(this.openOrderReqId, 'resolve');
    });

    // Order lifecycle.
    this.ib.on(
      EventName.orderStatus,
      (
        orderId: number,
        status: OrderStatus,
        filled: number,
        remaining: number,
        avgFillPrice: number,
        _permId?: number,
        _parent?: number,
        lastFillPrice?: number
      ) => {
        this.onIbkrOrderStatus(orderId, status, filled, remaining, avgFillPrice, lastFillPrice);
      }
    );
    this.ib.on(EventName.commissionReport, (report: CommissionReport) => {
      if (report.execId && typeof report.commission === 'number') this.commissionByExecId.set(report.execId, report.commission);
    });
    this.ib.on(EventName.execDetails, (_reqId: number, _contract: Contract, exec: Execution) => {
      // Attribute commission to the order; emitted with the matching Fill from orderStatus.
      const brokerOrderId = String(exec.orderId);
      const tracked = this.ordersByBrokerId.get(brokerOrderId);
      if (tracked && exec.execId) {
        const c = this.commissionByExecId.get(exec.execId);
        if (c != null) tracked.commissionAccrued += c;
      }
    });

    this.ib.on(EventName.error, (err: Error, code: ErrorCode | number, reqId: number) => {
      const num = Number(code);
      if (isBenignNotice(num)) return;
      // Connection-level failures (reqId === -1) flip session state fail-closed.
      if (reqId === -1) {
        if (num === 1100 || num === 504 || num === 502 || num === 1300) {
          this.connected = false;
          this.emitConn('disconnected');
        }
        return;
      }
      if (this.pending.has(reqId)) this.settle(reqId, 'reject', err instanceof Error ? err : new Error(String(err)));
    });
  }

  private onIbkrOrderStatus(
    orderId: number,
    status: string,
    filled: number,
    _remaining: number,
    _avgFillPrice: number,
    lastFillPrice: number | undefined
  ): void {
    const brokerOrderId = String(orderId);
    const tracked = this.ordersByBrokerId.get(brokerOrderId);
    if (!tracked) return;

    tracked.status = mapIbkrOrderStatus(status);
    tracked.filled = filled;

    // Surface the incremental fill (if any) as a Fill event, deduped by contracts seen.
    const newlyFilled = filled - tracked.lastEmittedFill;
    if (newlyFilled > 0 && lastFillPrice != null) {
      tracked.lastEmittedFill = filled;
      const fill: Fill = {
        clientOrderId: tracked.clientOrderId,
        brokerOrderId,
        brokerExecId: `${brokerOrderId}-${filled}`, // stable across orderStatus replays
        price: ibkrFillToNetCredit(lastFillPrice),
        contracts: newlyFilled,
        commission: Number(tracked.commissionAccrued.toFixed(2)),
        filledAt: new Date().toISOString(),
      };
      tracked.commissionAccrued = 0;
      for (const cb of this.fillCbs) cb(fill);
    }

    const update: OrderStatusUpdate = {
      clientOrderId: tracked.clientOrderId,
      brokerOrderId,
      status: tracked.status,
      filledContracts: tracked.filled,
      remainingContracts: Math.max(0, tracked.contracts - tracked.filled),
      rejectReason: tracked.status === 'rejected' ? status : null,
    };
    for (const cb of this.statusCbs) cb(update);
  }

  private emitConn(s: ConnState): void {
    for (const cb of this.connCbs) cb(s);
  }
}

/** YYYYMMDD → YYYY-MM-DD (inverse of {@link toIbkrExpiry}). */
export function fromIbkrExpiry(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
