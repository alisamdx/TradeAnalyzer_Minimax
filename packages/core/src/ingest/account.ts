import { createHash } from 'node:crypto';
import type { IngestContext } from '../collector/capture.js';
import type { IngestedRow } from './market.js';
import { etradeExpiryToDate } from './options.js';

/**
 * Ingestion for the operator's account — 02 §10, 04 §2.
 *
 * **No derived P&L, at all.** The existing app reconstructed it by inference and
 * got five positions wrong in both directions — an assigned CSP read -$3,736
 * when it was a +$499.48 conversion into stock, and the whole book read -$2,902
 * when it was +$3,983.12. `days_gain` and `total_gain` are stored as what they
 * are: provider estimates, labelled as such in the dictionary and never used as
 * realised P&L.
 */

/** The account key is never stored — only a digest of it (P15). */
export function hashAccountKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function statusOf(v: unknown): 'ok' | 'omitted' {
  return v === undefined || v === null ? 'omitted' : 'ok';
}

/** ms epoch to an ET timestamp; E*Trade order times are milliseconds. */
export function msEpochToEt(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  const utc = Date.UTC(Number(g('year')), Number(g('month')) - 1, Number(g('day')),
    Number(g('hour')) % 24, Number(g('minute')), Number(g('second')));
  const off = Math.round((utc - d.getTime()) / 60_000);
  const s = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}` +
    `${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

interface EtradeProduct {
  symbol?: string; securityType?: string; callPut?: string;
  expiryYear?: number; expiryMonth?: number; expiryDay?: number; strikePrice?: number;
}

/** Option-leg columns, shared by positions and order legs. Null when it is a stock line. */
function optionFields(p: EtradeProduct | undefined): Record<string, unknown> {
  if (p?.securityType !== 'OPTN' || typeof p.strikePrice !== 'number') {
    return { osi_symbol: null, right: null, strike: null, expiration_date: null };
  }
  const strike = p.strikePrice;
  const expiry = typeof p.expiryYear === 'number' && typeof p.expiryMonth === 'number' && typeof p.expiryDay === 'number'
    ? etradeExpiryToDate(p.expiryYear, p.expiryMonth, p.expiryDay)
    : null;
  const right = p.callPut === 'CALL' ? 'call' : p.callPut === 'PUT' ? 'put' : null;
  // OCC: root padded to 6, YYMMDD, C/P, strike x1000 padded to 8.
  const osi = expiry && right && p.symbol
    ? `${p.symbol.padEnd(6, ' ')}${expiry.slice(2).replace(/-/g, '')}` +
      `${right === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`
    : null;
  return { osi_symbol: osi, right, strike, expiration_date: expiry };
}

interface EtradePosition {
  positionId?: number; quantity?: number; positionType?: string;
  pricePaid?: number; totalCost?: number; marketValue?: number;
  daysGain?: number; totalGain?: number; dateAcquired?: string;
  Product?: EtradeProduct; Quick?: { lastTrade?: number };
}

/**
 * Who an account parser is for: the raw key, or — from a stored recipe — only
 * its digest. The parsers never needed more than the digest, which is why a
 * recipe can be replayed without the key ever being written anywhere (P15).
 */
export type AccountKeyed = { readonly accountKey: string } | { readonly accountKeyHash: string };

function digestOf(account: string | AccountKeyed): string {
  if (typeof account === 'string') return hashAccountKey(account);
  return 'accountKeyHash' in account ? account.accountKeyHash : hashAccountKey(account.accountKey);
}

export function makePositionIngest(account: string | AccountKeyed) {
  const hash = digestOf(account);
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as {
      PortfolioResponse?: { AccountPortfolio?: { Position?: EtradePosition[] }[] };
    };
    const positions = (parsed.PortfolioResponse?.AccountPortfolio ?? []).flatMap((a) => a.Position ?? []);

    return positions
      .filter((p) => p.Product?.symbol)
      .map((p) => {
        // Signed by positionType, so a short position is negative and nothing
        // downstream has to remember which sign convention this feed uses.
        const signed = p.positionType === 'SHORT' ? -Math.abs(p.quantity ?? 0) : (p.quantity ?? 0);
        return {
          table: 'raw_account_position_snapshot',
          values: {
            run_id: ctx.runId,
            as_of_date: ctx.asOfDate,
            observed_at: ctx.observedAt,
            capture_rule_id: ctx.captureRuleId,
            account_key_hash: hash,
            symbol: p.Product?.symbol,
            security_type: p.Product?.securityType ?? 'UNKNOWN',
            ...optionFields(p.Product),
            quantity: signed,
            position_type: p.positionType ?? 'UNKNOWN',
            price_paid: p.pricePaid ?? null,
            price_paid_status: statusOf(p.pricePaid),
            total_cost: p.totalCost ?? null,
            total_cost_status: statusOf(p.totalCost),
            market_value: p.marketValue ?? null,
            market_value_status: statusOf(p.marketValue),
            last_price: p.Quick?.lastTrade ?? null,
            last_price_status: statusOf(p.Quick?.lastTrade),
            days_gain: p.daysGain ?? null,
            days_gain_status: statusOf(p.daysGain),
            total_gain: p.totalGain ?? null,
            total_gain_status: statusOf(p.totalGain),
            date_acquired: p.dateAcquired ? String(p.dateAcquired).slice(0, 10) : null,
            provider_position_id: p.positionId !== undefined ? String(p.positionId) : null
          }
        };
      });
  };
}

export function makeBalanceIngest(account: string | AccountKeyed) {
  const hash = digestOf(account);
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as {
      BalanceResponse?: {
        accountType?: string;
        Computed?: {
          cashAvailableForInvestment?: number; cashBuyingPower?: number; netCash?: number;
          marginBuyingPower?: number; RealTimeValues?: { totalAccountValue?: number };
        };
      };
    };
    const b = parsed.BalanceResponse;
    if (!b?.Computed) return [];
    const c = b.Computed;
    const total = c.RealTimeValues?.totalAccountValue;

    return [{
      table: 'raw_account_balance_snapshot',
      values: {
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        account_key_hash: hash,
        cash_available_for_investment: c.cashAvailableForInvestment ?? null,
        cash_available_for_investment_status: statusOf(c.cashAvailableForInvestment),
        cash_buying_power: c.cashBuyingPower ?? null,
        cash_buying_power_status: statusOf(c.cashBuyingPower),
        net_cash: c.netCash ?? null,
        net_cash_status: statusOf(c.netCash),
        margin_buying_power: c.marginBuyingPower ?? null,
        margin_buying_power_status: statusOf(c.marginBuyingPower),
        total_account_value: total ?? null,
        total_account_value_status: statusOf(total),
        account_type: b.accountType ?? null
      }
    }];
  };
}

interface EtradeInstrument {
  Product?: EtradeProduct; orderAction?: string;
  quantityOrdered?: number; filledQuantity?: number; averageExecutionPrice?: number;
  estimatedCommission?: number; estimatedFees?: number;
}

interface EtradeOrder {
  orderId?: number;
  OrderDetail?: {
    placedTime?: number; executedTime?: number; orderTerm?: string; priceType?: string;
    limitPrice?: number; status?: string; Instrument?: EtradeInstrument[];
  }[];
  orderType?: string;
}

/**
 * Executed orders — the **primary** source of fills.
 *
 * `orderAction` states open versus close outright and `averageExecutionPrice` is
 * the realised fill, which is why this replaced the transactions parser that
 * inferred intent from "sold means opened" and paired legs by index.
 *
 * Legs are declared as `children`: `order_row_id` is not knowable until the
 * order row exists, and an ingestion module gets no database handle by design,
 * so the relationship is declared here and resolved inside the same transaction
 * that writes the parent.
 */
export function orderFingerprint(order: {
  readonly executedTime: string | null;
  readonly status: string;
  readonly legs: readonly Readonly<Record<string, unknown>>[];
}): string {
  const legs = order.legs.map((l) =>
    [l['leg_index'], l['symbol'], l['osi_symbol'], l['order_action'], l['filled_quantity'], l['average_execution_price']].join('|')
  );
  return createHash('sha256')
    .update([order.executedTime ?? '', order.status, ...legs].join('~'))
    .digest('hex')
    .slice(0, 32);
}

export function makeOrderIngest(opts: AccountKeyed & {
  /**
   * `order_id` to fingerprint for orders already stored. An unchanged order is
   * skipped, so the normal daily re-pull of a 30-day window writes nothing; a
   * changed one appends a second observation, which is the only shape QC-803
   * can read.
   */
  readonly knownOrders?: ReadonlyMap<string, string>;
}) {
  const hash = digestOf(opts);
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as { OrdersResponse?: { Order?: EtradeOrder[] } };
    const orders = parsed.OrdersResponse?.Order ?? [];
    const rows: IngestedRow[] = [];

    for (const o of orders) {
      const detail = o.OrderDetail?.[0];
      if (!o.orderId || !detail) continue;
      const executed = msEpochToEt(detail.executedTime);
      const status = detail.status ?? 'EXECUTED';

      const legs = (detail.Instrument ?? []).map((inst, i) => ({
        run_id: ctx.runId,
        as_of_date: ctx.asOfDate,
        observed_at: ctx.observedAt,
        capture_rule_id: ctx.captureRuleId,
        leg_index: i,
        symbol: inst.Product?.symbol ?? 'UNKNOWN',
        security_type: inst.Product?.securityType ?? 'UNKNOWN',
        ...optionFields(inst.Product),
        order_action: inst.orderAction ?? 'BUY',
        quantity_ordered: inst.quantityOrdered ?? 0,
        filled_quantity: inst.filledQuantity ?? 0,
        // Stored as sent, including a 0. QC-804 blocks on a filled leg with no
        // price rather than the ingestion inventing one.
        average_execution_price: inst.averageExecutionPrice ?? 0,
        estimated_commission: inst.estimatedCommission ?? null,
        estimated_commission_status: statusOf(inst.estimatedCommission),
        estimated_fees: inst.estimatedFees ?? null,
        estimated_fees_status: statusOf(inst.estimatedFees)
      }));

      const id = String(o.orderId);
      const fingerprint = orderFingerprint({ executedTime: executed, status, legs });
      if (opts.knownOrders?.get(id) === fingerprint) continue;

      rows.push({
        table: 'raw_executed_order',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          account_key_hash: hash,
          order_id: id,
          order_type: o.orderType ?? 'UNKNOWN',
          placed_time: msEpochToEt(detail.placedTime) ?? ctx.observedAt,
          executed_time: executed,
          executed_time_status: executed === null ? 'omitted' : 'ok',
          order_term: detail.orderTerm ?? null,
          price_type: detail.priceType ?? null,
          limit_price: detail.limitPrice ?? null,
          status,
          order_fingerprint: fingerprint
        },
        children: [{ table: 'raw_executed_order_leg', parentColumn: 'order_row_id', rows: legs }]
      });
    }
    return rows;
  };
}

interface EtradeTransaction {
  transactionId?: number | string; transactionDate?: number | string;
  transactionType?: string; description?: string; amount?: number;
  brokerage?: { product?: { symbol?: string }; quantity?: number; price?: number };
}

/**
 * Transactions — a **fallback** for what executed orders miss (dividends, fees,
 * interest, assignments). Known to be intermittently unresponsive for ~120 s
 * behind an `oauth_problem=nonce_used` mask that is a server-side timeout rather
 * than an OAuth fault, so a failure here is a warning and never blocking.
 */
export function makeTransactionIngest(opts: AccountKeyed & {
  /** Ids already stored. A transaction is immutable, so a known one is skipped outright. */
  readonly knownIds?: ReadonlySet<string>;
}) {
  const hash = digestOf(opts);
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as { TransactionListResponse?: { Transaction?: EtradeTransaction[] } };
    return (parsed.TransactionListResponse?.Transaction ?? [])
      .filter((t) => t.transactionId !== undefined && typeof t.amount === 'number')
      .filter((t) => !opts.knownIds?.has(String(t.transactionId)))
      .map((t) => ({
        table: 'raw_account_transaction',
        values: {
          run_id: ctx.runId,
          as_of_date: ctx.asOfDate,
          observed_at: ctx.observedAt,
          capture_rule_id: ctx.captureRuleId,
          account_key_hash: hash,
          transaction_id: String(t.transactionId),
          transaction_date: typeof t.transactionDate === 'number'
            ? (msEpochToEt(t.transactionDate) ?? ctx.asOfDate).slice(0, 10)
            : String(t.transactionDate ?? ctx.asOfDate).slice(0, 10),
          transaction_type: t.transactionType ?? 'UNKNOWN',
          description: t.description ?? null,
          // `brokerage.product` comes back as an EMPTY OBJECT on cash
          // transactions (measured 2026-09-07 on `Transfer`), so the declared
          // null meaning is the observed behaviour rather than an assumption.
          symbol: t.brokerage?.product?.symbol ?? null,
          amount: t.amount as number,
          quantity: t.brokerage?.quantity ?? null,
          price: t.brokerage?.price ?? null
        }
      }));
  };
}
