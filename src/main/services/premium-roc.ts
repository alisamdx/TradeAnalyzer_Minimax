/**
 * Real income/wheel return on capital — the deferred analysis `options_premium_history` was built
 * for (v0.32.94), now that ≥ 40 capture dates have matured.
 *
 * Every stored cash-secured put is settled at expiry on the real premium:
 *
 *   P&L/share = premium − max(0, strike − S_T)        S_T = close on the last bar ≤ expiration
 *   ROC %     = P&L / strike × 100                    capital = the cash securing the put
 *
 * see docs/formulas.md#premium-roc
 *
 * Beside it, each row carries the **proxy** Brief Replay scores income/wheel picks on today
 * (`brief-replay-service.ts`): a synthetic strike at 0.85 × entry, "kept" if no low over the next
 * 21 sessions touches it, and no premium at all. Settling both on the same rows is what tells us
 * whether that proxy can be trusted.
 *
 * Unlike `settled-csp-panel.ts` this does NOT require bid/ask/OI — return needs only the premium,
 * and before v1.1.132 every wheel row had those fields null, so requiring them would discard the
 * whole early wheel history.
 *
 * **Scale guard.** A split repaired after capture puts the stored strike and the repaired closes
 * on different scales, and settling one against the other manufactures enormous fake losses (the
 * CRWD rows once inverted the sign of a backtest's headline). A row whose stored `last_price`
 * disagrees with the stored close on its own capture date, or whose settlement close sits outside
 * a plausible band of its entry, is EXCLUDED and listed — never settled, never silently dropped.
 *
 * Read-only: SELECTs only.
 */

import type { PanelDb } from './settled-csp-panel';

export type RocStrategy = 'income' | 'wheel';
export const ROC_STRATEGIES: readonly RocStrategy[] = ['income', 'wheel'];

/** |last_price / close(asOf) − 1| above this ⇒ the two are on different scales. Same day, so tight. */
export const ENTRY_SCALE_TOLERANCE = 0.15;
/** Without a stored last_price, a CSP strike outside this band of the entry close is implausible. */
export const STRIKE_TO_ENTRY_BAND: readonly [number, number] = [0.5, 1.2];
/** settle / entry outside this band within one option cycle reads as a scale step, not a move. */
export const SETTLE_TO_ENTRY_BAND: readonly [number, number] = [0.35, 3.0];
/** The settlement bar must be at most this many calendar days before expiration (holidays). */
export const MAX_SETTLE_GAP_DAYS = 4;
/** Brief Replay's proxy, mirrored exactly: strike at 0.85 × entry, lows over 21 forward sessions. */
export const PROXY_STRIKE_FRACTION = 0.85;
export const PROXY_SESSIONS = 21;

export interface PremiumRocRow {
  readonly asOfDate: string;
  readonly ticker: string;
  readonly strike: number;
  readonly expiration: string;
  readonly dte: number;
  readonly premium: number;
  readonly ivRank: number | null;
  /** The annualized return the recommendation promised at capture. */
  readonly expectedAnnualizedPct: number | null;
  readonly entryClose: number;
  readonly settle: number;
  readonly settleDate: string;
  readonly assigned: boolean;
  readonly rocPct: number;
  readonly annualizedRocPct: number;
  /** Brief Replay's proxy verdict on the same ticker/date; null when < 21 forward sessions exist. */
  readonly proxyKept: boolean | null;
}

export type ExclusionReason = 'scale_mismatch_entry' | 'scale_mismatch_settle' | 'no_entry_bar' | 'no_settle_bar';

export interface ExcludedRow {
  readonly asOfDate: string;
  readonly ticker: string;
  readonly strike: number;
  readonly expiration: string;
  readonly reason: ExclusionReason;
  readonly detail: string;
}

export interface PremiumRocReport {
  readonly strategy: RocStrategy;
  readonly maxPriceDate: string | null;
  /** Stored CSP rows whose expiration is on or before maxPriceDate. */
  readonly eligible: number;
  /** Covered-call fallbacks (wheel only) — a different capital base, not settled here. */
  readonly coveredCallsSkipped: number;
  readonly rows: readonly PremiumRocRow[];
  readonly excluded: readonly ExcludedRow[];
}

export interface Bar { date: string; low: number; close: number }

function lastIndexAtOrBefore(bars: readonly Bar[], target: string): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= target) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** P&L per share and ROC of a short put held to expiry. see docs/formulas.md#premium-roc */
export function settleShortPut(strike: number, premium: number, settle: number): { pnl: number; rocPct: number; assigned: boolean } {
  const intrinsic = Math.max(0, strike - settle);
  const pnl = premium - intrinsic;
  return { pnl, rocPct: (pnl / strike) * 100, assigned: settle < strike };
}

/** One stored CSP as read from `options_premium_history`. */
export interface StoredCsp {
  readonly asOfDate: string;
  readonly ticker: string;
  readonly strike: number;
  readonly expiration: string;
  readonly dte: number | null;
  readonly premium: number;
  readonly lastPrice: number | null;
  readonly ivRank: number | null;
  readonly expectedAnnualizedPct: number | null;
}

export type SettleResult = { row: PremiumRocRow } | { excluded: ExcludedRow };

/**
 * Settle one stored CSP against its ticker's bars (ascending by date), applying the scale guard.
 * The single implementation behind both this report and Brief Replay's real outcome, so the two
 * can never settle the same put differently. see docs/formulas.md#premium-roc
 */
export function settleStoredCsp(bars: readonly Bar[], r: StoredCsp): SettleResult {
  const base = { asOfDate: r.asOfDate, ticker: r.ticker, strike: r.strike, expiration: r.expiration };
  const exclude = (reason: ExclusionReason, detail: string): SettleResult => ({ excluded: { ...base, reason, detail } });

  const ei = lastIndexAtOrBefore(bars, r.asOfDate);
  if (ei < 0 || daysBetween(bars[ei]!.date, r.asOfDate) > MAX_SETTLE_GAP_DAYS) {
    return exclude('no_entry_bar', 'no close on or just before the capture date');
  }
  const entryClose = bars[ei]!.close;

  if (r.lastPrice !== null && r.lastPrice > 0) {
    const ratio = r.lastPrice / entryClose;
    if (Math.abs(ratio - 1) > ENTRY_SCALE_TOLERANCE) {
      return exclude('scale_mismatch_entry', `last_price/close = ${ratio.toFixed(3)}`);
    }
  } else {
    const ratio = r.strike / entryClose;
    if (ratio < STRIKE_TO_ENTRY_BAND[0] || ratio > STRIKE_TO_ENTRY_BAND[1]) {
      return exclude('scale_mismatch_entry', `strike/close = ${ratio.toFixed(3)} (no last_price)`);
    }
  }

  const si = lastIndexAtOrBefore(bars, r.expiration);
  if (si <= ei || daysBetween(bars[si]!.date, r.expiration) > MAX_SETTLE_GAP_DAYS) {
    return exclude('no_settle_bar', 'no close on or just before expiration');
  }
  const settleBar = bars[si]!;
  const move = settleBar.close / entryClose;
  if (move < SETTLE_TO_ENTRY_BAND[0] || move > SETTLE_TO_ENTRY_BAND[1]) {
    return exclude('scale_mismatch_settle', `settle/entry = ${move.toFixed(3)}`);
  }

  const { rocPct, assigned } = settleShortPut(r.strike, r.premium, settleBar.close);
  const dte = r.dte !== null && r.dte > 0 ? r.dte : Math.max(1, daysBetween(r.asOfDate, r.expiration));

  // Brief Replay's proxy, exactly: entry bar plus the next 21 sessions, every low ≥ 0.85 × entry.
  let proxyKept: boolean | null = null;
  if (ei + PROXY_SESSIONS < bars.length) {
    const synth = entryClose * PROXY_STRIKE_FRACTION;
    proxyKept = bars.slice(ei, ei + PROXY_SESSIONS + 1).every((b) => b.low >= synth);
  }

  return {
    row: {
      asOfDate: r.asOfDate,
      ticker: r.ticker,
      strike: r.strike,
      expiration: r.expiration,
      dte,
      premium: r.premium,
      ivRank: r.ivRank,
      expectedAnnualizedPct: r.expectedAnnualizedPct,
      entryClose,
      settle: settleBar.close,
      settleDate: settleBar.date,
      assigned,
      rocPct,
      annualizedRocPct: rocPct * (365 / dte),
      proxyKept
    }
  };
}

export function premiumRoc(db: PanelDb, strategy: RocStrategy): PremiumRocReport {
  const maxRow = db.prepare('SELECT MAX(date) AS d FROM historical_prices').get() as { d: string | null } | undefined;
  const maxPriceDate = maxRow?.d ?? null;
  if (maxPriceDate === null) {
    return { strategy, maxPriceDate, eligible: 0, coveredCallsSkipped: 0, rows: [], excluded: [] };
  }

  const cc = db
    .prepare(
      `SELECT COUNT(*) AS n FROM options_premium_history
        WHERE strategy = ? AND structure = 'CC' AND expiration <= ?`
    )
    .get(strategy, maxPriceDate) as { n: number };

  const raw = db
    .prepare(
      `SELECT as_of_date, ticker, strike, expiration, dte, premium, last_price, iv_rank, annualized_return
         FROM options_premium_history
        WHERE strategy = ? AND structure = 'CSP' AND expiration <= ?
          AND premium IS NOT NULL AND premium > 0 AND strike > 0
        ORDER BY as_of_date, ticker`
    )
    .all(strategy, maxPriceDate) as {
    as_of_date: string; ticker: string; strike: number; expiration: string; dte: number | null;
    premium: number; last_price: number | null; iv_rank: number | null; annualized_return: number | null;
  }[];

  // One bar load per ticker, not per row.
  const barsFor = db.prepare('SELECT date, low, close FROM historical_prices WHERE ticker = ? ORDER BY date');
  const series = new Map<string, Bar[]>();

  const rows: PremiumRocRow[] = [];
  const excluded: ExcludedRow[] = [];

  for (const r of raw) {
    let bars = series.get(r.ticker);
    if (!bars) {
      bars = barsFor.all(r.ticker) as Bar[];
      series.set(r.ticker, bars);
    }
    const res = settleStoredCsp(bars, {
      asOfDate: r.as_of_date, ticker: r.ticker, strike: r.strike, expiration: r.expiration, dte: r.dte,
      premium: r.premium, lastPrice: r.last_price, ivRank: r.iv_rank, expectedAnnualizedPct: r.annualized_return
    });
    if ('excluded' in res) excluded.push(res.excluded);
    else rows.push(res.row);
  }

  return { strategy, maxPriceDate, eligible: raw.length, coveredCallsSkipped: cc.n, rows, excluded };
}
