/**
 * The settled-CSP study panel — every stored cash-secured-put recommendation whose expiration has
 * a settlement close, with the inputs needed to re-score it point-in-time.
 *
 * Read by scripts/fr-income-liquidity-realized-ab.mjs through GET /diagnostics/settled-csp-panel.
 *
 * That script used to open `%APPDATA%\trade-analyzer\trade-analyzer.sqlite` itself, write-capable.
 * The path is MSIX-redirected in the container a Claude Code session runs in (probed 2026-09-18),
 * so an unattended run of it read the container's stale shadow copy — and the scheduled 2026-09-28
 * re-run exists precisely to measure a panel that has doubled since the last one. Reading through
 * the running app gives it the live database on the app's own connection, which is the same fix the
 * wheel A/B got in v1.1.220.
 *
 * Read-only: SELECTs only.
 */

export interface PanelDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

export type PanelStrategy = 'income' | 'wheel';
export const PANEL_STRATEGIES: readonly PanelStrategy[] = ['income', 'wheel'];

export interface SettledCspRow {
  readonly asOfDate: string;
  readonly ticker: string;
  readonly strike: number;
  readonly expiration: string;
  readonly dte: number | null;
  readonly premium: number;
  readonly bid: number;
  readonly ask: number;
  readonly openInterest: number;
  readonly ivRank: number | null;
  readonly annualizedReturn: number | null;
  /** Close on the expiration date — the settlement price. */
  readonly settle: number;
  /** The `recentVolatility` signal as live scoring would have computed it on `asOfDate`. */
  readonly realizedVol: number | null;
}

export interface SettledCspPanel {
  readonly strategy: PanelStrategy;
  /** The newest stored bar date: nothing expiring after it can be settled yet. */
  readonly maxPriceDate: string | null;
  readonly rows: readonly SettledCspRow[];
}

/**
 * 20-day realized volatility, annualized, as a percentage — **the live rule, exactly**.
 *
 * Mirrors `ScoringService.loadRecentVolatility`: the newest ≤ 22 closes, at least 16 of them, at
 * least 15 log returns between two positive closes, sample variance, × √252 × 100. The study script
 * carried its own copy that accepted as few as 10 closes (9 returns) and took `log(0)` on a zero
 * close, so its `recentVolatility` was never the one the engine scored on for a thin-history ticker.
 * A replay signal that is computed differently from the live one measures a different signal.
 *
 * `closesNewestFirst` is the ticker's closes up to and including the as-of date, newest first.
 * see docs/formulas.md#recent-volatility
 */
export function recentVolatility(closesNewestFirst: readonly number[]): number | null {
  const window = closesNewestFirst.slice(0, 22);
  if (window.length < 16) return null;
  const oldestFirst = [...window].reverse();
  const logReturns: number[] = [];
  for (let i = 1; i < oldestFirst.length; i++) {
    const prev = oldestFirst[i - 1]!;
    const curr = oldestFirst[i]!;
    if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev));
  }
  if (logReturns.length < 15) return null;
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance * 252) * 100;
}

/** Index of the last element ≤ `target` in an ascending array, or -1. */
function lastAtOrBefore(sortedDates: readonly string[], target: string): number {
  let lo = 0;
  let hi = sortedDates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid]! <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function settledCspPanel(db: PanelDb, strategy: PanelStrategy): SettledCspPanel {
  const maxRow = db.prepare('SELECT MAX(date) AS d FROM historical_prices').get() as { d: string | null } | undefined;
  const maxPriceDate = maxRow?.d ?? null;
  if (maxPriceDate === null) return { strategy, maxPriceDate, rows: [] };

  const raw = db
    .prepare(
      `SELECT o.as_of_date, o.ticker, o.strike, o.expiration, o.dte, o.premium,
              o.bid, o.ask, o.open_interest, o.iv_rank, o.annualized_return,
              h.close AS settle
         FROM options_premium_history o
         JOIN historical_prices h ON h.ticker = o.ticker AND h.date = o.expiration
        WHERE o.strategy = ? AND o.structure = 'CSP'
          AND o.expiration <= ? AND o.bid IS NOT NULL AND o.ask IS NOT NULL
          AND o.open_interest IS NOT NULL AND o.premium IS NOT NULL AND o.strike > 0
        ORDER BY o.as_of_date, o.ticker`
    )
    .all(strategy, maxPriceDate) as {
    as_of_date: string; ticker: string; strike: number; expiration: string; dte: number | null;
    premium: number; bid: number; ask: number; open_interest: number; iv_rank: number | null;
    annualized_return: number | null; settle: number;
  }[];

  // One bar load per TICKER, not per row. The script queried bars once per (ticker, as_of_date) —
  // thousands of round trips that would each become an HTTP call if moved across the API.
  const barsFor = db.prepare('SELECT date, close FROM historical_prices WHERE ticker = ? ORDER BY date');
  const series = new Map<string, { dates: string[]; closes: number[] }>();
  const volCache = new Map<string, number | null>();

  const rows: SettledCspRow[] = raw.map((r) => {
    let s = series.get(r.ticker);
    if (!s) {
      const bars = barsFor.all(r.ticker) as { date: string; close: number }[];
      s = { dates: bars.map((b) => b.date), closes: bars.map((b) => b.close) };
      series.set(r.ticker, s);
    }
    const key = `${r.ticker}|${r.as_of_date}`;
    let vol = volCache.get(key);
    if (vol === undefined) {
      const end = lastAtOrBefore(s.dates, r.as_of_date);
      vol = end < 0 ? null : recentVolatility(s.closes.slice(Math.max(0, end - 21), end + 1).reverse());
      volCache.set(key, vol);
    }
    return {
      asOfDate: r.as_of_date,
      ticker: r.ticker,
      strike: r.strike,
      expiration: r.expiration,
      dte: r.dte,
      premium: r.premium,
      bid: r.bid,
      ask: r.ask,
      openInterest: r.open_interest,
      ivRank: r.iv_rank,
      annualizedReturn: r.annualized_return,
      settle: r.settle,
      realizedVol: vol
    };
  });

  return { strategy, maxPriceDate, rows };
}
