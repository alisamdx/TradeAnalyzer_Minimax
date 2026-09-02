// Split-adjustment repair for `historical_prices`.
//
// Polygon aggregates are fetched with adjusted=true, so each response is correctly
// split-adjusted AS OF THAT FETCH. The corruption comes from incremental storage:
// price-gap-fill only re-fetches a ~3-day window, so bars written before a split keep
// their PRE-split prices while new bars arrive POST-split. The stored series is then
// internally inconsistent — a permanent step change in the middle.
//
// Measured 2026-08-28 across Jun–Aug: CRWD −74% in a single day (4:1 split), DD +203%,
// MRNA +177%, HON +95%, KLAC +89% (reverse splits), against SPY's largest genuine daily
// move of 2.58%. Every indicator spanning such a date is wrong, and that feeds the
// scoring engine's technicals, the backtest engine, and Brief Replay — the tool FR-SEY-5
// depends on to validate trade-logic changes. see docs/formulas.md#split-adjustment
//
// Strategy: detect the discontinuity from the stored data (provider-agnostic — no new
// API surface), then repair by re-fetching the ticker's whole series, which Polygon
// returns adjusted to today. The repair is idempotent: re-fetching a ticker that did NOT
// split simply rewrites identical bars, so a false positive costs one API call and
// changes nothing. A jump that survives a re-fetch is treated as a real market move and
// skipped for CONFIRMED_REAL_TTL_DAYS, then re-verified — providers backfill corporate
// actions late, so that verdict must expire rather than stand forever.

import type { DbHandle } from '../db/connection.js';
import type { HistoricalDataService } from './historical-service.js';
import { fetchAndStorePrices } from './historical-service.js';
import type { PolygonDataProvider } from './polygon-provider.js';

/** Default |1-day move| beyond which a bar is treated as split-like and re-verified. */
export const DEFAULT_SPLIT_THRESHOLD = 0.25;

/**
 * Tolerance for matching an observed ratio to a named split ratio. Wide on purpose —
 * see nearestSplitRatio: a split day also carries that day's real price move.
 */
export const SPLIT_RATIO_TOLERANCE = 0.08;

/** Never re-fetch further back than this — bounds the payload on very long histories. */
const MAX_REPAIR_LOOKBACK_DAYS = 800;

/**
 * How long a `confirmed_real` classification is trusted before the discontinuity is
 * re-verified against the provider.
 *
 * A one-shot classification is too strong: data providers backfill corporate actions
 * late, so a split can be genuinely absent from the adjusted series on the day we check
 * and present a week later. Without a TTL that row is excluded from detection forever and
 * the corruption becomes permanent and invisible — the exact failure this module exists to
 * prevent, just moved one level up. Observed 2026-09-01: MRNA stepped 62.96 → 174.38 and
 * STAYED there (split-shaped, not a spike), yet survived a re-fetch and was written off as
 * real. Re-verification costs one API call per stale entry per month. v1.1.140
 */
const CONFIRMED_REAL_TTL_DAYS = 30;

/**
 * Sustained volume-regime shift beyond which a price discontinuity is read as the symbol
 * having been reassigned to a DIFFERENT COMPANY rather than as a split or a news move.
 *
 * Calibrated 2026-09-01 on the eight discontinuities that survived a re-fetch. Median
 * volume over 20 bars either side (skipping a 3-bar buffer so the event-day spike is
 * excluded):
 *   ticker reuse : BNY 76x  ·  SPCX 53,592x
 *   genuine move : MRNA 5.0x · PRIM 2.7x · FMC 2.6x · CORT 2.0x · KD 2.0x · CAR 0.4x
 * 15x sits three times above the largest genuine case, so the separation is not marginal.
 */
const TICKER_REUSE_VOLUME_RATIO = 15;

/** Bars either side used to measure the regime, and the buffer skipped around the event. */
const REGIME_WINDOW_BARS = 20;
const REGIME_BUFFER_BARS = 3;

export interface PriceBar {
  date: string;
  close: number;
  volume?: number;
}

/**
 * Median volume AFTER a discontinuity divided by median volume BEFORE it — the signature
 * that separates a reassigned ticker from a violent but genuine move.
 *
 * A split rescales share count, so volume moves inversely and settles; a news event spikes
 * volume then decays back toward its old level. Only a different company trading under the
 * same symbol shifts the volume REGIME permanently. Medians over a window (rather than the
 * event day itself) are what make that distinction — the event-day spike is excluded by the
 * caller's buffer.
 *
 * Returns null when either side is too thin to judge, so the caller can decline to act.
 */
export function volumeRegimeRatio(
  beforeVolumes: readonly number[],
  afterVolumes: readonly number[],
  minSamples = 5,
): number | null {
  const median = (xs: readonly number[]): number => {
    const s = [...xs].filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
  };
  if (beforeVolumes.length < minSamples || afterVolumes.length < minSamples) return null;
  const vb = median(beforeVolumes);
  const va = median(afterVolumes);
  if (!(vb > 0) || !(va > 0)) return null;
  return va / vb;
}

/** Whether a volume-regime ratio is extreme enough to mean "different company". */
export function isTickerReuse(volRatio: number | null): boolean {
  if (volRatio === null) return false;
  return volRatio >= TICKER_REUSE_VOLUME_RATIO || volRatio <= 1 / TICKER_REUSE_VOLUME_RATIO;
}

export interface Discontinuity {
  ticker: string;
  date: string;      // the bar that jumped
  prevClose: number;
  close: number;
  ratio: number;     // close / prevClose — 0.25 ≈ 4:1 split, 3.0 ≈ 1:3 reverse split
}

/**
 * Pure scan for split-like steps in one ticker's close series.
 *
 * `bars` must be ascending by date. A bar is flagged when |close/prevClose − 1| exceeds
 * `threshold`. Non-positive closes are skipped rather than producing an infinite ratio.
 */
export function detectDiscontinuities(
  ticker: string,
  bars: readonly PriceBar[],
  threshold: number = DEFAULT_SPLIT_THRESHOLD,
): Discontinuity[] {
  const out: Discontinuity[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    const ratio = cur.close / prev.close;
    if (Math.abs(ratio - 1) > threshold) {
      out.push({ ticker, date: cur.date, prevClose: prev.close, close: cur.close, ratio });
    }
  }
  return out;
}

/**
 * Nearest simple split ratio for a discontinuity, or null when it doesn't look like one.
 * Purely descriptive — used for logging, never to rewrite prices (the authoritative
 * adjusted series always comes from the provider).
 */
export function nearestSplitRatio(ratio: number): string | null {
  // Only ratios that CANNOT be confused with an ordinary one-day move are labelled.
  //
  // 3:2 (−33%) was in this list until v1.1.140 and was the source of every false label:
  // a third of the 2026-08-28 scan's `confirmed_real` entries came back tagged "~3:2"
  // when they were ordinary crashes (SRPT, ALGN, ELF, SMCI all dropping 32–37% on bad
  // news). A one-third single-day fall is routine; a halving is not. Every remaining
  // candidate implies a move of ≥46%, which no liquid name makes on news often enough
  // to matter.
  //
  // The ±8% tolerance stays wide ON PURPOSE and must not be tightened: a split day also
  // carries that day's genuine price move, so the observed ratio is never exact. CRWD's
  // real 4:1 printed at 0.2649 vs a theoretical 0.25 — 6% off, because the stock rose 6%
  // that session. A 3% tolerance would have rejected a true split. The fix for false
  // labels is a safer candidate SET, not a narrower band.
  const candidates: Array<[string, number]> = [
    ['2:1', 0.5], ['3:1', 1 / 3], ['4:1', 0.25], ['5:1', 0.2], ['10:1', 0.1],
    ['1:2', 2], ['1:3', 3], ['1:4', 4], ['1:5', 5], ['1:10', 10],
  ];
  for (const [label, target] of candidates) {
    if (Math.abs(ratio / target - 1) <= SPLIT_RATIO_TOLERANCE) return label;
  }
  return null;
}

export interface RepairSummary {
  scanned: number;
  flagged: number;
  repaired: number;
  confirmedReal: number;
  tickerReuse: number;
  failed: number;
  details: string[];
}

/**
 * Scan every ticker in `historical_prices` and repair split-corrupted series.
 *
 * A discontinuity recorded as `confirmed_real` is skipped while that verdict is inside
 * CONFIRMED_REAL_TTL_DAYS, so a genuine −40% earnings crash costs one API call a month
 * rather than one per run — while a split the provider had not yet published still gets
 * picked up on a later pass.
 */
export async function detectAndRepairSplits(
  db: DbHandle,
  service: HistoricalDataService,
  provider: PolygonDataProvider,
  opts: {
    threshold?: number;
    lookbackDays?: number;
    maxRepairs?: number;
    signal?: AbortSignal;
    onProgress?: (ticker: string, note: string) => void;
  } = {},
): Promise<RepairSummary> {
  const threshold = opts.threshold ?? DEFAULT_SPLIT_THRESHOLD;
  const lookbackDays = opts.lookbackDays ?? 400;
  const maxRepairs = opts.maxRepairs ?? 40;
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  // Only trust a `confirmed_real` verdict while it is inside its TTL. Older ones fall back
  // into detection so a late-published corporate action is eventually picked up. Both sides
  // of the comparison use the same ISO format the table is written with, so the string
  // compare is well-defined.
  const known = new Set(
    (db.prepare(`
      SELECT ticker, discontinuity_date FROM price_split_repairs
      WHERE status = 'confirmed_real'
        AND resolved_at IS NOT NULL
        AND resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
    `).all(`-${CONFIRMED_REAL_TTL_DAYS} days`) as Array<{ ticker: string; discontinuity_date: string }>)
      .map(r => `${r.ticker}|${r.discontinuity_date}`),
  );

  const tickers = (db.prepare(
    `SELECT DISTINCT ticker FROM historical_prices WHERE date >= ? ORDER BY ticker`,
  ).all(since) as Array<{ ticker: string }>).map(r => r.ticker);

  const barsStmt = db.prepare(
    `SELECT date, close, volume FROM historical_prices WHERE ticker = ? AND date >= ? ORDER BY date ASC`,
  );
  // Regime windows are measured over the FULL stored series, not the scan lookback, so a
  // splice near the lookback edge still has bars on both sides to compare.
  const beforeVolStmt = db.prepare(
    `SELECT volume FROM historical_prices WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT ?`,
  );
  const afterVolStmt = db.prepare(
    `SELECT volume FROM historical_prices WHERE ticker = ? AND date > ? ORDER BY date ASC LIMIT ?`,
  );
  const offsetDate = (d: string, bars: number, dir: 1 | -1): string =>
    new Date(Date.parse(`${d}T00:00:00Z`) + dir * bars * 86_400_000).toISOString().slice(0, 10);
  const truncPricesStmt = db.prepare(`DELETE FROM historical_prices WHERE ticker = ? AND date < ?`);
  const truncIvStmt = db.prepare(`DELETE FROM iv_history WHERE ticker = ? AND date < ?`);
  const earliestStmt = db.prepare(`SELECT MIN(date) AS d FROM historical_prices WHERE ticker = ?`);
  const recordStmt = db.prepare(`
    INSERT INTO price_split_repairs
      (ticker, discontinuity_date, ratio, volume_ratio, status, bars_rewritten, detected_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(ticker, discontinuity_date) DO UPDATE SET
      status = excluded.status, ratio = excluded.ratio, volume_ratio = excluded.volume_ratio,
      bars_rewritten = excluded.bars_rewritten, resolved_at = excluded.resolved_at
  `);

  const summary: RepairSummary = { scanned: 0, flagged: 0, repaired: 0, confirmedReal: 0, tickerReuse: 0, failed: 0, details: [] };

  for (const ticker of tickers) {
    if (opts.signal?.aborted) break;
    if (summary.repaired + summary.confirmedReal + summary.tickerReuse >= maxRepairs) break;
    summary.scanned++;

    const bars = barsStmt.all(ticker, since) as PriceBar[];
    const hits = detectDiscontinuities(ticker, bars, threshold)
      .filter(h => !known.has(`${h.ticker}|${h.date}`));
    if (hits.length === 0) continue;
    summary.flagged++;

    // ── Ticker reuse, checked BEFORE any re-fetch ──────────────────────────────
    // A symbol reassigned to a different company (rename, reverse merger, de-SPAC,
    // delisting + reuse) splices two unrelated entities into one series, and NO re-fetch
    // can fix it — the provider keys by ticker too and returns the same spliced data. So
    // this is settled first: it saves a pointless API call and is the only one of the
    // three verdicts that is not a question about price adjustment at all.
    //
    // The tell is a permanent shift in the VOLUME regime. A split rescales share count and
    // settles; a news event spikes volume then decays. Only a different company changes the
    // regime for good (BNY 76x, SPCX 53,592x vs 0.4-5.0x across six genuine moves).
    const reuseHit = hits.find(h => {
      const vb = (beforeVolStmt.all(ticker, offsetDate(h.date, REGIME_BUFFER_BARS, -1), REGIME_WINDOW_BARS) as Array<{ volume: number }>).map(r => r.volume);
      const va = (afterVolStmt.all(ticker, offsetDate(h.date, REGIME_BUFFER_BARS, 1), REGIME_WINDOW_BARS) as Array<{ volume: number }>).map(r => r.volume);
      return isTickerReuse(volumeRegimeRatio(vb, va));
    });
    if (reuseHit) {
      const vb = (beforeVolStmt.all(ticker, offsetDate(reuseHit.date, REGIME_BUFFER_BARS, -1), REGIME_WINDOW_BARS) as Array<{ volume: number }>).map(r => r.volume);
      const va = (afterVolStmt.all(ticker, offsetDate(reuseHit.date, REGIME_BUFFER_BARS, 1), REGIME_WINDOW_BARS) as Array<{ volume: number }>).map(r => r.volume);
      const volRatio = volumeRegimeRatio(vb, va)!;
      // Truncate to the current entity. Deleting is the right action rather than flagging:
      // every consumer reads these tables directly, so removing the previous company's bars
      // makes indicators, scoring, backtests and replay correct without touching any of
      // them. iv_history is truncated too — it is keyed the same way and feeds IV rank over
      // a 252-day window (BNY held 246 of 316 rows on the wrong company).
      const priceRows = truncPricesStmt.run(ticker, reuseHit.date).changes;
      const ivRows = truncIvStmt.run(ticker, reuseHit.date).changes;
      recordStmt.run(ticker, reuseHit.date, reuseHit.ratio, volRatio, 'ticker_reuse', priceRows);
      summary.tickerReuse++;
      const line = `${ticker} ${reuseHit.date} ${((reuseHit.ratio - 1) * 100).toFixed(0)}% `
        + `vol regime ${volRatio >= 1 ? volRatio.toFixed(0) + 'x' : '1/' + (1 / volRatio).toFixed(0) + 'x'}`
        + ` → ticker_reuse, truncated ${priceRows} price + ${ivRows} iv rows before it`;
      summary.details.push(line);
      opts.onProgress?.(ticker, line);
      continue;
    }

    // Re-fetch the whole stored series (bounded). Polygon returns it adjusted to today,
    // so a genuine split is corrected across every bar in one pass.
    const earliest = (earliestStmt.get(ticker) as { d: string | null } | undefined)?.d ?? since;
    const floor = new Date(Date.now() - MAX_REPAIR_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const from = earliest > floor ? earliest : floor;

    try {
      const rewritten = await fetchAndStorePrices(service, provider, ticker, '5Y', from);
      const after = detectDiscontinuities(ticker, barsStmt.all(ticker, since) as PriceBar[], threshold);
      const afterKeys = new Set(after.map(h => h.date));

      for (const h of hits) {
        const stillThere = afterKeys.has(h.date);
        const status = stillThere ? 'confirmed_real' : 'repaired';
        recordStmt.run(ticker, h.date, h.ratio, null, status, rewritten);
        const split = nearestSplitRatio(h.ratio);
        const line = `${ticker} ${h.date} ${((h.ratio - 1) * 100).toFixed(0)}%`
          + (split ? ` (~${split})` : '')
          + ` → ${status}`;
        summary.details.push(line);
        opts.onProgress?.(ticker, line);
      }
      if (afterKeys.size < hits.length) summary.repaired++; else summary.confirmedReal++;
    } catch (err) {
      summary.failed++;
      summary.details.push(`${ticker}: repair failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return summary;
}
