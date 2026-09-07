import type { IngestContext } from '../collector/capture.js';
import type { IngestedRow } from './market.js';

/**
 * Ingestion for option expirations and contract snapshots — 02 §5, 04 §2.3.
 *
 * Every converter here exists because a live response was measured on
 * 2026-09-07 and disagreed with what the field name suggested. That is the whole
 * argument for the verify list: the ones that fail loudly cost an hour, and the
 * ones that fail silently cost a quarter.
 */

/**
 * E*Trade sends `inTheMoney` as the **string** `"y"` or `"n"`.
 *
 * A plain cast is the obvious implementation and is wrong in the worst
 * available direction: `Boolean("n")` is `true`, so every contract would read as
 * in-the-money. Nothing throws, no check fires, and a moneyness filter silently
 * selects the whole chain.
 */
export function etradeYesNoToFlag(v: unknown): number | null {
  if (v === true || v === 'y' || v === 'Y') return 1;
  if (v === false || v === 'n' || v === 'N') return 0;
  return null;
}

/** E*Trade's `timeStamp` is epoch **seconds** (measured: as ms it lands in 1970). */
export function secondsEpochToEt(sec: unknown): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  const d = new Date(sec * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const utcMs = Date.UTC(
    Number(g('year')), Number(g('month')) - 1, Number(g('day')),
    Number(g('hour')) % 24, Number(g('minute')), Number(g('second'))
  );
  const off = Math.round((utcMs - d.getTime()) / 60_000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}` +
    `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function etradeExpiryToDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * "Absent" and "zero" are different facts, and only one of them is data.
 *
 * Measured 2026-09-07: E*Trade sends a genuine `0` volume on 60 of 171 SPY
 * calls, so the test has to be **presence**, never truthiness. The existing
 * app's `leg.volume ?? 0` collapsed the two on 23 of 250 stored legs and a
 * liquidity gate then rejected them (D7).
 */
function presence(v: unknown): { value: number | null; status: 'ok' | 'omitted' } {
  return v === undefined || v === null
    ? { value: null, status: 'omitted' }
    : { value: v as number, status: 'ok' };
}

/** IV must be a decimal fraction. Anything outside (0,5) is stored `invalid`. */
function ivOrInvalid(v: unknown): { value: number | null; status: 'ok' | 'omitted' | 'invalid' } {
  if (v === undefined || v === null) return { value: null, status: 'omitted' };
  const n = v as number;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n >= 5) {
    return { value: null, status: 'invalid' };
  }
  return { value: n, status: 'ok' };
}

interface EtradeExpiration {
  year?: number; month?: number; day?: number; expiryType?: string;
}

export interface ExpirationSelection {
  readonly date: string;
  readonly reason: 'within_max_dte' | 'extra_monthly' | 'sticky_contract' | 'outside';
}

export function makeExpirationIngest(opts: {
  readonly ticker: string;
  /** Which expirations this run's rule selected, and why. */
  readonly selection: ReadonlyMap<string, ExpirationSelection['reason']>;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as {
      OptionExpireDateResponse?: { ExpirationDate?: EtradeExpiration[] };
    };
    const dates = parsed.OptionExpireDateResponse?.ExpirationDate ?? [];

    return dates
      .filter((d) => typeof d.year === 'number' && typeof d.month === 'number' && typeof d.day === 'number')
      .map((d) => {
        const date = etradeExpiryToDate(d.year as number, d.month as number, d.day as number);
        const reason = opts.selection.get(date) ?? 'outside';
        return {
          table: 'raw_option_expiration',
          values: {
            run_id: ctx.runId,
            as_of_date: ctx.asOfDate,
            observed_at: ctx.observedAt,
            capture_rule_id: ctx.captureRuleId,
            ticker: opts.ticker,
            expiration_date: date,
            // Verbatim. Measured 2026-09-07: SPY lists WEEKLY, MONTHLY,
            // QUARTERLY and MONTHEND — a fourth value the draft did not have,
            // harmless only because this is not mapped to an enum of our own.
            expiry_type: d.expiryType ?? 'UNKNOWN',
            in_capture_window: reason === 'outside' ? 0 : 1,
            window_reason: reason
          }
        };
      });
  };
}

interface EtradeOption {
  osiKey?: string; strikePrice?: number; displaySymbol?: string;
  bid?: number; ask?: number; lastPrice?: number; bidSize?: number; askSize?: number;
  volume?: number; openInterest?: number; inTheMoney?: unknown; timeStamp?: number;
  OptionGreeks?: { iv?: number; delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
}

function contractRow(
  o: EtradeOption,
  right: 'call' | 'put',
  ctx: IngestContext,
  opts: { ticker: string; expirationDate: string; underlyingPrice: number; sticky?: string | null }
): IngestedRow | null {
  if (!o.osiKey || typeof o.strikePrice !== 'number') return null;

  const priceOk = o.bid !== undefined && o.ask !== undefined;
  const sizeOk = o.bidSize !== undefined && o.askSize !== undefined;
  const g = o.OptionGreeks ?? {};
  const greeksOk = g.delta !== undefined;
  const iv = ivOrInvalid(g.iv);
  const vol = presence(o.volume);
  const oi = presence(o.openInterest);

  // E*Trade sends 0 for lastPrice when a contract has not traded. Stored as
  // null with `omitted`, never 0 — a zero here reads as "it traded at zero".
  const last = o.lastPrice === undefined || o.lastPrice === null || o.lastPrice === 0
    ? { value: null, status: 'omitted' as const }
    : { value: o.lastPrice, status: 'ok' as const };

  return {
    table: 'raw_option_contract_snapshot',
    values: {
      run_id: ctx.runId,
      as_of_date: ctx.asOfDate,
      observed_at: ctx.observedAt,
      capture_rule_id: ctx.captureRuleId,
      ticker: opts.ticker,
      osi_symbol: o.osiKey,
      expiration_date: opts.expirationDate,
      strike: o.strikePrice,
      right,
      display_symbol: o.displaySymbol ?? null,
      bid: priceOk ? o.bid : null,
      ask: priceOk ? o.ask : null,
      price_status: priceOk ? 'ok' : 'omitted',
      last: last.value,
      last_status: last.status,
      bid_size: sizeOk ? o.bidSize : null,
      ask_size: sizeOk ? o.askSize : null,
      size_status: sizeOk ? 'ok' : 'omitted',
      volume: vol.value,
      volume_status: vol.status,
      open_interest: oi.value,
      open_interest_status: oi.status,
      iv: iv.value,
      iv_status: iv.status,
      delta: greeksOk ? (g.delta ?? null) : null,
      gamma: greeksOk ? (g.gamma ?? null) : null,
      theta: greeksOk ? (g.theta ?? null) : null,
      vega: greeksOk ? (g.vega ?? null) : null,
      rho: greeksOk ? (g.rho ?? null) : null,
      greeks_status: greeksOk ? 'ok' : 'omitted',
      in_the_money: etradeYesNoToFlag(o.inTheMoney),
      underlying_price: opts.underlyingPrice,
      provider_timestamp: secondsEpochToEt(o.timeStamp),
      sticky_reason: opts.sticky ?? null
    }
  };
}

export function makeChainIngest(opts: {
  readonly ticker: string;
  readonly expirationDate: string;
  /** Contracts pinned into capture regardless of the rule, by OSI symbol. */
  readonly stickyReasons?: ReadonlyMap<string, string>;
}) {
  return (body: string, ctx: IngestContext): readonly IngestedRow[] => {
    const parsed = JSON.parse(body) as {
      OptionChainResponse?: { nearPrice?: number; OptionPair?: { Call?: EtradeOption; Put?: EtradeOption }[] };
    };
    const resp = parsed.OptionChainResponse;
    if (!resp || typeof resp.nearPrice !== 'number') return [];

    const rows: IngestedRow[] = [];
    for (const pair of resp.OptionPair ?? []) {
      for (const [side, right] of [[pair.Call, 'call'], [pair.Put, 'put']] as const) {
        if (!side) continue;
        const sticky = side.osiKey ? opts.stickyReasons?.get(side.osiKey) ?? null : null;
        const row = contractRow(side, right, ctx, {
          ticker: opts.ticker,
          expirationDate: opts.expirationDate,
          underlyingPrice: resp.nearPrice,
          sticky
        });
        // Every strike returned is stored (Q2) — the losers are the data a
        // study needs, and pipelines habitually discard exactly those.
        if (row) rows.push(row);
      }
    }
    return rows;
  };
}
