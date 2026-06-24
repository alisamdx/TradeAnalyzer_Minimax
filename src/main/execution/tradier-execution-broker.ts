// Tradier implementation of the ExecutionBroker seam (Requirements/v2-execution/07-broker-alternatives §3, Option 3).
//
// Tradier is the drop-in for the IBKR model: a REAL sandbox/paper environment AND production on the
// SAME REST API, with native multi-leg ("multileg") option orders. That restores the v2 design's
// "soak then go live on one adapter" property that IBKR's options-level wall denied us. Auth is a
// simple Bearer token (separate tokens for sandbox vs production), so there is no local Gateway
// process to babysit — a reliability win for an always-on engine.
//
// STATUS — skeleton (2026-06-24). The PURE mapping helpers below (OCC symbols, multileg payload,
// net-price sign, status mapping, combo pricing) are fully implemented and unit-tested offline. The
// network methods are implemented to Tradier's DOCUMENTED shapes and are fail-closed when not
// connected, but every endpoint/field is marked `// VERIFY` because they are NOT yet calibrated
// against a live sandbox account (pending L3 approval + tokens). This mirrors how the IBKR adapter
// was written to documented conventions and then calibrated on paper. Order status/fills arrive by
// POLLING (Tradier supports streaming too; polling is the simpler, always-correct baseline).
//
// Tradier API reference: https://documentation.tradier.com/brokerage-api

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
  PermissionCheck,
  QualifiedContract,
} from './execution-broker.js';

export interface TradierBrokerOptions {
  baseUrl: string; // https://sandbox.tradier.com (paper) | https://api.tradier.com (live)
  env: 'sandbox' | 'production';
  token: string | null; // Bearer access token for this environment
  accountId: string | null; // Tradier account id (accountIdKey equivalent)
  reqTimeoutMs?: number; // default 12_000
  pollIntervalMs?: number; // order status/fill poll cadence; default 4_000
}

// ── pure helpers (no network — unit tested) ──────────────────────────────────

/** Tradier net order side from our leg action + the order's open/close intent. */
export type TradierSide = 'buy_to_open' | 'sell_to_open' | 'buy_to_close' | 'sell_to_close';
export function tradierLegSide(action: 'buy' | 'sell', side: 'open' | 'close'): TradierSide {
  return `${action}_to_${side}` as TradierSide;
}

/**
 * Build an OCC/OSI option symbol (Tradier's `option_symbol`): ROOT + YYMMDD + C/P + strike×1000
 * left-padded to 8 digits. e.g. {SPY, 2026-06-19, P, 450} → "SPY260619P00450000". No spaces — Tradier
 * uses the compact OSI form, not the space-padded 21-char variant.
 */
export function toOccSymbol(leg: { ticker: string; expiry: string; right: 'P' | 'C'; strike: number }): string {
  const yymmdd = leg.expiry.slice(2).replace(/-/g, ''); // 2026-06-19 → 260619
  const strike8 = Math.round(leg.strike * 1000).toString().padStart(8, '0');
  return `${leg.ticker.toUpperCase()}${yymmdd}${leg.right}${strike8}`;
}

/** Inverse of {@link toOccSymbol}: parse an OSI symbol back to an ExecLeg (action unknown → caller sets). */
export function fromOccSymbol(occ: string, action: 'buy' | 'sell' = 'buy'): ExecLeg | null {
  const m = /^([A-Z]+)(\d{6})([CP])(\d{8})$/.exec(occ.trim().toUpperCase());
  if (!m) return null;
  const [, , yymmdd, right, strike8] = m;
  const expiry = `20${yymmdd!.slice(0, 2)}-${yymmdd!.slice(2, 4)}-${yymmdd!.slice(4, 6)}`;
  return { right: right as 'P' | 'C', action, strike: Number(strike8) / 1000, expiry, ratio: 1 };
}

/**
 * Net-limit → Tradier multileg price convention. Single source of truth for the sign. Our `netLimit`
 * is credit-positive (per the seam); Tradier carries direction in the order `type` field and the
 * `price` is always the absolute net premium. credit = we receive, debit = we pay, even = zero net.
 */
export function tradierNetType(netLimit: number): { type: 'credit' | 'debit' | 'even'; price: number } {
  const price = Number(Math.abs(netLimit).toFixed(2));
  if (price === 0) return { type: 'even', price: 0 };
  return { type: netLimit > 0 ? 'credit' : 'debit', price };
}

/** Inverse: a Tradier fill price for an order of `type` → credit-positive net (matches the seam). */
export function tradierFillToNetCredit(type: 'credit' | 'debit' | 'even', price: number): number {
  if (type === 'even') return 0;
  return Number((type === 'credit' ? price : -price).toFixed(2));
}

/**
 * Build the form-encoded body for a Tradier multileg option order (parallel indexed arrays). Returned
 * as a flat Record so the request layer just URL-encodes it and the shape is unit-testable. `tag`
 * carries our COID for idempotency/reconciliation (Tradier echoes it back on the order).
 */
export function buildMultilegPayload(o: {
  underlying: string;
  legs: LegSpec[];
  side: 'open' | 'close';
  netLimit: number;
  contracts: number;
  clientOrderId: string;
  duration?: 'day' | 'gtc';
}): Record<string, string> {
  const { type, price } = tradierNetType(o.netLimit);
  const body: Record<string, string> = {
    class: 'multileg',
    symbol: o.underlying.toUpperCase(),
    type, // credit | debit | even
    duration: o.duration ?? 'day',
    price: price.toFixed(2),
    tag: sanitizeTag(o.clientOrderId),
  };
  o.legs.forEach((leg, i) => {
    body[`option_symbol[${i}]`] = toOccSymbol(leg);
    body[`side[${i}]`] = tradierLegSide(leg.action, o.side);
    body[`quantity[${i}]`] = String(o.contracts * leg.ratio);
  });
  return body;
}

/** Tradier order `tag` accepts only letters, numbers, dash and underscore (max 255). */
export function sanitizeTag(coid: string): string {
  return coid.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 255);
}

/** Map a Tradier order status string to the seam's BrokerOrderStatus. */
export function mapTradierOrderStatus(status: string): BrokerOrderStatus {
  switch (status) {
    case 'pending':
    case 'open':
    case 'submitted':
    case 'received':
      return 'submitted';
    case 'partially_filled':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'cancelled':
    case 'expired':
      return 'cancelled';
    case 'rejected':
    case 'error':
      return 'rejected';
    default:
      return 'working';
  }
}

/** Per-leg top-of-book used to net a combo quote. */
export interface LegQuote {
  bid: number;
  ask: number;
}

/**
 * Net a credit-positive combo quote from each leg's top-of-book (same convention as IBKR's
 * comboQuoteFromLegs). A sold leg adds premium (credit), a bought leg subtracts it (debit). `bid` is
 * the conservative fill side, `ask` the optimistic one.
 */
export function netComboFromLegs(
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

/** Classify a Tradier order-preview response into a spread-permission verdict (fail-closed). */
export function classifyTradierPreview(body: unknown): PermissionCheck {
  const order = (body as { order?: Record<string, unknown> })?.order;
  const errors = extractErrors(body);
  if (errors.length > 0) {
    const msg = errors.join('; ');
    return /permission|not (allowed|permitted|approved)|option level|spread|eligib|unauthor/i.test(msg)
      ? { ok: false, code: 'no_spread_permission', message: `Tradier: ${msg}` }
      : { ok: false, code: 'check_failed', message: `Tradier: ${msg}` };
  }
  if (order && (order.status === 'ok' || order.cost != null || order.margin_change != null)) {
    return { ok: true, code: 'ok', message: 'Tradier preview accepted — spread permitted' };
  }
  return { ok: false, code: 'check_failed', message: 'Tradier preview returned no order/errors' };
}

/** Pull error strings out of a Tradier JSON body (errors.error may be a string or array). */
export function extractErrors(body: unknown): string[] {
  const e = (body as { errors?: { error?: unknown } })?.errors?.error;
  if (e == null) return [];
  return Array.isArray(e) ? e.map(String) : [String(e)];
}

// ── adapter ─────────────────────────────────────────────────────────────────

interface TrackedOrder {
  clientOrderId: string;
  brokerOrderId: string;
  side: 'open' | 'close';
  contracts: number;
  netType: 'credit' | 'debit' | 'even';
  status: BrokerOrderStatus;
  filled: number;
  lastEmittedFill: number; // contracts already surfaced as Fill events (dedup)
}

export class TradierExecutionBroker implements ExecutionBroker {
  private readonly baseUrl: string;
  private readonly env: 'sandbox' | 'production';
  private readonly token: string | null;
  private accountId: string | null;
  private readonly reqTimeoutMs: number;
  private readonly pollIntervalMs: number;

  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly connCbs: Array<(s: ConnState) => void> = [];
  private readonly statusCbs: Array<(u: OrderStatusUpdate) => void> = [];
  private readonly fillCbs: Array<(f: Fill) => void> = [];

  private readonly ordersByBrokerId = new Map<string, TrackedOrder>();
  private readonly coidToBrokerId = new Map<string, string>(); // idempotency key

  constructor(opts: TradierBrokerOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.env = opts.env;
    this.token = opts.token;
    this.accountId = opts.accountId;
    this.reqTimeoutMs = opts.reqTimeoutMs ?? 12_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 4_000;
  }

  // ── lifecycle ──

  async connect(): Promise<void> {
    if (!this.token) {
      this.emitConn('reauth_needed');
      throw new Error(`Tradier ${this.env}: no access token configured (set TA_TRADIER_TOKEN_${this.env === 'production' ? 'PROD' : 'SANDBOX'})`);
    }
    // VERIFY: /v1/user/profile confirms the token + lists accounts; pick the first if none set.
    const profile = (await this.req('GET', '/v1/user/profile')) as {
      profile?: { account?: unknown };
    };
    if (!this.accountId) {
      const acct = profile?.profile?.account;
      const first = Array.isArray(acct) ? acct[0] : acct;
      this.accountId = ((first as { account_number?: string })?.account_number ?? null) || null;
    }
    this.connected = true;
    this.emitConn('connected');
    this.startPolling();
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionState(cb: (s: ConnState) => void): void {
    this.connCbs.push(cb);
  }

  disconnect(): void {
    this.stopPolling();
    this.connected = false;
    this.emitConn('disconnected');
  }

  // ── reference / pricing ──

  // Tradier identifies options by OCC symbol — there is no conId/qualify round-trip. We synthesize
  // the "qualified" contract from the OCC symbol; validity is confirmed at preview/place time.
  qualifyContract(spec: LegSpec): Promise<QualifiedContract> {
    return Promise.resolve({ spec, conId: toOccSymbol(spec), multiplier: 100, qualified: true });
  }

  async priceCombo(legs: LegSpec[]): Promise<ComboQuote> {
    const symbols = legs.map((l) => toOccSymbol(l)).join(',');
    // VERIFY: GET /v1/markets/quotes?symbols=...  → quotes.quote (object or array).
    const body = (await this.req('GET', `/v1/markets/quotes?symbols=${encodeURIComponent(symbols)}&greeks=false`)) as {
      quotes?: { quote?: unknown };
    };
    const raw = body?.quotes?.quote;
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const bySym = new Map<string, { bid: number; ask: number }>();
    for (const q of list as Array<{ symbol?: string; bid?: number; ask?: number }>) {
      if (q.symbol) bySym.set(q.symbol, { bid: Number(q.bid ?? 0), ask: Number(q.ask ?? 0) });
    }
    const quotes: LegQuote[] = legs.map((l) => bySym.get(toOccSymbol(l)) ?? { bid: 0, ask: 0 });
    const missing = quotes.findIndex((q) => q.bid <= 0 && q.ask <= 0);
    if (missing >= 0) {
      const l = legs[missing]!;
      throw new Error(`no Tradier quote for ${l.ticker} ${l.right}${l.strike} ${l.expiry}`);
    }
    return { legs, ...netComboFromLegs(legs, quotes), asOf: new Date().toISOString() };
  }

  async getBuyingPower(): Promise<BuyingPower> {
    this.requireAccount();
    // VERIFY: GET /v1/accounts/{id}/balances → balances.option_buying_power / total_equity.
    const body = (await this.req('GET', `/v1/accounts/${this.accountId}/balances`)) as {
      balances?: { option_buying_power?: number; total_equity?: number };
    };
    const b = body?.balances ?? {};
    return { available: Number(b.option_buying_power ?? 0), total: Number(b.total_equity ?? 0), currency: 'USD' };
  }

  /**
   * Spread-permission preflight (§2.13) via a non-transmitted order PREVIEW of the supplied (or a
   * reference) vertical. Fail-closed: not connected / no probe / any failure → ok:false. A preview
   * never rests an order, so it is safe to run on connect.
   */
  async checkSpreadPermission(probe?: LegSpec[]): Promise<PermissionCheck> {
    if (!this.connected) return { ok: false, code: 'not_connected', message: 'broker not connected' };
    const legs = probe && probe.length >= 2 ? probe : null;
    if (!legs) {
      // A real probe needs a live, near-the-money expiry/strikes — discovered from the chain at
      // calibration time. Until that is wired, fail-closed rather than falsely pass.
      return { ok: false, code: 'check_failed', message: 'no probe spread supplied (chain-discovery pending)' };
    }
    try {
      const payload = buildMultilegPayload({
        underlying: legs[0]!.ticker,
        legs,
        side: 'open',
        netLimit: 0.05, // price irrelevant for a preview
        contracts: 1,
        clientOrderId: 'preflight-probe',
      });
      const body = await this.req('POST', `/v1/accounts/${this.accountId}/orders`, { ...payload, preview: 'true' });
      return classifyTradierPreview(body);
    } catch (e) {
      return { ok: false, code: 'check_failed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── orders (idempotent on clientOrderId — §2.8) ──

  async placeOrder(o: OrderRequest): Promise<OrderAck> {
    const existingId = this.coidToBrokerId.get(o.clientOrderId);
    if (existingId) {
      const tracked = this.ordersByBrokerId.get(existingId);
      return { clientOrderId: o.clientOrderId, brokerOrderId: existingId, accepted: tracked?.status !== 'rejected', rejectReason: null };
    }
    if (!this.connected) {
      return { clientOrderId: o.clientOrderId, brokerOrderId: null, accepted: false, rejectReason: 'not_connected' };
    }
    const payload = buildMultilegPayload({
      underlying: o.legs[0]?.ticker ?? '',
      legs: o.legs,
      side: o.side,
      netLimit: o.netLimit,
      contracts: o.contracts,
      clientOrderId: o.clientOrderId,
    });
    let body: { order?: { id?: number | string } };
    try {
      // VERIFY: POST /v1/accounts/{id}/orders → { order: { id, status, partner_id } }.
      body = (await this.req('POST', `/v1/accounts/${this.accountId}/orders`, payload)) as { order?: { id?: number | string } };
    } catch (e) {
      return { clientOrderId: o.clientOrderId, brokerOrderId: null, accepted: false, rejectReason: e instanceof Error ? e.message : 'place_failed' };
    }
    const errors = extractErrors(body);
    if (errors.length > 0 || body?.order?.id == null) {
      return { clientOrderId: o.clientOrderId, brokerOrderId: null, accepted: false, rejectReason: errors.join('; ') || 'no order id returned' };
    }
    const brokerOrderId = String(body.order.id);
    this.ordersByBrokerId.set(brokerOrderId, {
      clientOrderId: o.clientOrderId,
      brokerOrderId,
      side: o.side,
      contracts: o.contracts,
      netType: tradierNetType(o.netLimit).type,
      status: 'submitted',
      filled: 0,
      lastEmittedFill: 0,
    });
    this.coidToBrokerId.set(o.clientOrderId, brokerOrderId);
    return { clientOrderId: o.clientOrderId, brokerOrderId, accepted: true, rejectReason: null };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const brokerOrderId = this.coidToBrokerId.get(clientOrderId);
    if (!brokerOrderId || !this.connected) return;
    try {
      // VERIFY: DELETE /v1/accounts/{id}/orders/{orderId}.
      await this.req('DELETE', `/v1/accounts/${this.accountId}/orders/${brokerOrderId}`);
    } catch {
      /* already terminal */
    }
  }

  onOrderStatus(cb: (u: OrderStatusUpdate) => void): void {
    this.statusCbs.push(cb);
  }

  onFill(cb: (f: Fill) => void): void {
    this.fillCbs.push(cb);
  }

  // ── truth (reconciliation — §2.9) ──

  async getOpenPositions(): Promise<BrokerPosition[]> {
    this.requireAccount();
    // VERIFY: GET /v1/accounts/{id}/positions → positions.position (object or array). Option legs are
    // OCC symbols; group by underlying root and rebuild ExecLegs.
    const body = (await this.req('GET', `/v1/accounts/${this.accountId}/positions`)) as {
      positions?: { position?: unknown };
    };
    const raw = body?.positions?.position;
    const list = (Array.isArray(raw) ? raw : raw != null ? [raw] : []) as Array<{ symbol?: string; quantity?: number; cost_basis?: number }>;
    const byTicker = new Map<string, BrokerPosition>();
    for (const p of list) {
      const occ = String(p.symbol ?? '');
      const qty = Number(p.quantity ?? 0);
      if (qty === 0) continue;
      const leg = fromOccSymbol(occ, qty > 0 ? 'buy' : 'sell');
      if (!leg) continue; // not an option (equity) — skip
      const ticker = occ.replace(/\d{6}[CP]\d{8}$/, '');
      const existing = byTicker.get(ticker);
      if (existing) existing.legs.push(leg);
      else byTicker.set(ticker, { ticker, legs: [leg], contracts: Math.abs(qty), avgPrice: 0, mark: null });
    }
    return [...byTicker.values()];
  }

  async getOrders(): Promise<BrokerOrder[]> {
    if (this.connected) await this.pollOnce().catch(() => undefined);
    return [...this.ordersByBrokerId.values()].map((o) => ({
      clientOrderId: o.clientOrderId,
      brokerOrderId: o.brokerOrderId,
      status: o.status,
      side: o.side,
      contracts: o.contracts,
      filledContracts: o.filled,
    }));
  }

  // ── polling (Tradier has no push by default — diff GET /orders each tick) ──

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((e) => console.warn('[tradier] poll failed:', e instanceof Error ? e.message : e));
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** One status/fill reconciliation pass over GET /orders, diffing against tracked state. */
  private async pollOnce(): Promise<void> {
    if (!this.accountId) return;
    // VERIFY: GET /v1/accounts/{id}/orders → orders.order (object or array).
    const body = (await this.req('GET', `/v1/accounts/${this.accountId}/orders`)) as { orders?: { order?: unknown } };
    const raw = body?.orders?.order;
    const list = (Array.isArray(raw) ? raw : raw != null ? [raw] : []) as Array<{
      id?: number | string;
      status?: string;
      exec_quantity?: number;
      avg_fill_price?: number;
      quantity?: number;
    }>;
    for (const ord of list) {
      const brokerOrderId = String(ord.id ?? '');
      const tracked = this.ordersByBrokerId.get(brokerOrderId);
      if (!tracked) continue;
      tracked.status = mapTradierOrderStatus(String(ord.status ?? ''));
      const filled = Math.round(Number(ord.exec_quantity ?? 0));
      tracked.filled = filled;

      const newly = filled - tracked.lastEmittedFill;
      if (newly > 0) {
        tracked.lastEmittedFill = filled;
        for (const cb of this.fillCbs) {
          cb({
            clientOrderId: tracked.clientOrderId,
            brokerOrderId,
            brokerExecId: `${brokerOrderId}-${filled}`, // stable across poll replays
            price: tradierFillToNetCredit(tracked.netType, Number(ord.avg_fill_price ?? 0)),
            contracts: newly,
            commission: 0, // VERIFY: Tradier commission surfacing (per-order detail) at calibration
            filledAt: new Date().toISOString(),
          });
        }
      }
      for (const cb of this.statusCbs) {
        cb({
          clientOrderId: tracked.clientOrderId,
          brokerOrderId,
          status: tracked.status,
          filledContracts: tracked.filled,
          remainingContracts: Math.max(0, tracked.contracts - tracked.filled),
          rejectReason: tracked.status === 'rejected' ? String(ord.status ?? 'rejected') : null,
        });
      }
    }
  }

  // ── internals ──

  private requireAccount(): void {
    if (!this.accountId) throw new Error('Tradier: no account id (connect() resolves it from the profile)');
  }

  /** Signed Tradier request. Bearer auth; GET via query string, POST/DELETE via form-urlencoded body. */
  private async req(method: 'GET' | 'POST' | 'DELETE', path: string, form?: Record<string, string>): Promise<unknown> {
    if (!this.token) throw new Error('Tradier: no access token');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.reqTimeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      };
      let body: string | undefined;
      if (form && method !== 'GET') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }
      const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (res.status === 401) {
        this.connected = false;
        this.emitConn('reauth_needed');
        throw new Error(`Tradier 401 (token expired/invalid) on ${method} ${path}`);
      }
      if (!res.ok) throw new Error(`Tradier ${res.status} on ${method} ${path}: ${text.slice(0, 200)}`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private emitConn(s: ConnState): void {
    for (const cb of this.connCbs) cb(s);
  }
}
