// Analysis service — runs one of 5 analysis modes over a watchlist.
// see SPEC: FR-3, §5.3
// see docs/formulas.md for all financial formula references.

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import { QuoteCache, FundamentalsCache } from './cache-service.js';
import { fillPrice } from './options-fill.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { JobQueue } from './job-queue.js';
import type {
  AnalysisSnapshotRow,
  AnalysisMode,
  AnalysisAllModesPayload,
  OptionsChain,
  BuyResult,
  OptionsIncomeResult,
  WheelResult,
  StrategyResult,
  LizardResult,
  AnalysisResult
} from '@shared/types.js';

// ─── Shared types for analysis modes ─────────────────────────────────────────

export interface Bar {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

/** Progress callback: (current, total, ticker) */
export type ProgressCallback = (current: number, total: number, ticker: string) => void;

// ─── Mode result types ────────────────────────────────────────────────────────
//
// These live in `src/shared/types.ts` (the documented home for cross-process types) and are
// re-exported here so the long-standing `from './analysis-service.js'` imports keep working.
//
// They used to be declared in BOTH files. Nothing enforced that the copies matched, and they
// silently drifted: the shared `WheelResult` was missing `currentIv`, which is the shape the
// RENDERER sees (`AnalysisAllModesPayload` in shared/types.ts is built from the shared copies,
// and analysis-service imports that payload type while returning its own local ones —
// structurally compatible, so TypeScript never complained). That is why `AnalysisView` hand-rolls
// its own row types instead of using these. One declaration now, so it cannot drift again.
export type {
  BuyResult,
  OptionsIncomeResult,
  WheelResult,
  StrategyResult,
  LizardResult,
  AnalysisResult,
};

// ─── Indicator calculations (pure, unit-testable) ────────────────────────────

/** Simple Moving Average. */
// see docs/formulas.md#sma
export function computeSMA(bars: Bar[], period: number): (number | null)[] {
  const closes = bars.map((b) => b.c);
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

/** Exponential Moving Average. */
// see docs/formulas.md#ema
export function computeEMA(bars: Bar[], period: number): (number | null)[] {
  const closes = bars.map((b) => b.c);
  const k = 2 / (period + 1);
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  // Seed with SMA of first `period` bars.
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period - 1; i < closes.length; i++) {
    if (i === period - 1) {
      result[i] = ema;
    } else {
      ema = closes[i]! * k + ema * (1 - k);
      result[i] = ema;
    }
  }
  return result;
}

/** Relative Strength Index (Wilder's smoothed). */
// see docs/formulas.md#rsi-14
export function computeRSI(bars: Bar[], period = 14): (number | null)[] {
  const closes = bars.map((b) => b.c);
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs2);
  }
  return result;
}

/** Average True Range. */
// see docs/formulas.md#atr
export function computeATR(bars: Bar[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < 2) return result;
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i]!.h, l = bars[i]!.l, pc = i > 0 ? bars[i - 1]!.c : bars[i]!.c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder's smoothed ATR.
  if (trs.length >= period) {
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]!) / period;
      result[i] = atr;
    }
    result[period - 1] = atr;
  }
  return result;
}

/** Average Directional Index (ADX). Approximate — simplified Wilder. */
// see docs/formulas.md#adx
export function computeADX(bars: Bar[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < period * 2) return result;

  // Compute +DM, -DM, TR for each bar.
  const trs: number[] = [], pDMs: number[] = [], nDMs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i]!.h, l = bars[i]!.l, ph = bars[i - 1]!.h, pl = bars[i - 1]!.l;
    trs.push(Math.max(h - l, Math.abs(h - pl), Math.abs(l - ph)));
    pDMs.push(Math.max(0, h - ph));
    nDMs.push(Math.max(0, pl - l));
  }

  const smooth = (arr: number[], n: number): (number | null)[] => {
    let s = arr.slice(0, n).reduce((a, b) => a + b, 0);
    const out: (number | null)[] = new Array(n - 1).fill(null);
    out.push(s);
    for (let i = n; i < arr.length; i++) {
      s = s - s / n + arr[i]!;
      out.push(s);
    }
    return out;
  };

  const sTR = smooth(trs, period);
  const spDM = smooth(pDMs, period);
  const snDM = smooth(nDMs, period);

  const plusDI: (number | null)[] = new Array(bars.length).fill(null);
  const minusDI: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = period - 1; i < bars.length; i++) {
    const idx = i - (period - 1);
    if (sTR[idx]! > 0) {
      plusDI[i] = 100 * spDM[idx]! / sTR[idx]!;
      minusDI[i] = 100 * snDM[idx]! / sTR[idx]!;
    }
  }

  // DX = |+DI − −DI| / (+DI + −DI) × 100
  const dxs: number[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    const pd = plusDI[i] ?? 0, nd = minusDI[i] ?? 0;
    dxs.push(pd + nd === 0 ? 0 : Math.abs(pd - nd) / (pd + nd) * 100);
  }

  // ADX = Wilder smoothed AVERAGE of DX. `smooth` returns the Wilder running SUM (≈ period ×
  // average), which is correct for the +DI/−DI ratios above (the sums cancel) but NOT for ADX,
  // which is the average — so the result must be divided by `period`. Omitting this inflated
  // ADX ~`period`× (e.g. AMD 648 vs the true ~46), saturating the trendStrength/trendNeutral
  // signals. `smoothDX/period` equals the exact Wilder ADX recursion. see docs/formulas.md#adx
  const smoothDX = smooth(dxs, period);
  for (let i = period - 1; i < bars.length; i++) {
    const idx = i - (period - 1);
    if (smoothDX[idx] !== null && smoothDX[idx] !== undefined) result[i] = (smoothDX[idx] as number) / period;
  }
  return result;
}

/** Identify swing high/low from recent bars (for support/resistance). */
export function findSwingHighLow(bars: Bar[], lookback = 20): { high: number | null; low: number | null; highIdx: number; lowIdx: number } {
  if (bars.length < lookback) return { high: null, low: null, highIdx: -1, lowIdx: -1 };
  const recent = bars.slice(-lookback);
  let maxVal = -Infinity, maxIdx = 0, minVal = Infinity, minIdx = 0;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i]!.h >= maxVal) { maxVal = recent[i]!.h; maxIdx = i; }
    if (recent[i]!.l <= minVal) { minVal = recent[i]!.l; minIdx = i; }
  }
  return {
    high: maxVal === -Infinity ? null : maxVal,
    low: minVal === Infinity ? null : minVal,
    highIdx: bars.length - lookback + maxIdx,
    lowIdx: bars.length - lookback + minIdx
  };
}

// see docs/formulas.md#volume-profile-levels
export function computeVolumeProfileLevels(
  bars: Bar[],
  binCount = 24
): { poc: number; vah: number; val: number } | null {
  if (bars.length === 0) return null;
  const priceHigh = Math.max(...bars.map((b) => b.h));
  const priceLow = Math.min(...bars.map((b) => b.l));
  const priceRange = priceHigh - priceLow;
  if (priceRange <= 0) return null;

  const binSize = priceRange / binCount;
  const bins = new Array<number>(binCount).fill(0);
  for (const bar of bars) {
    const startBin = Math.max(0, Math.floor((bar.l - priceLow) / binSize));
    const endBin = Math.min(binCount - 1, Math.floor((bar.h - priceLow) / binSize));
    const numBins = Math.max(1, endBin - startBin + 1);
    const volPerBin = bar.v / numBins;
    for (let b = startBin; b <= endBin; b++) { const cur = bins[b] ?? 0; bins[b] = cur + volPerBin; }
  }

  const maxVol = Math.max(...bins);
  if (maxVol <= 0) return null;
  const pocIdx = bins.indexOf(maxVol);
  const poc = priceLow + (pocIdx + 0.5) * binSize;

  // Value area: bins containing 70% of total volume (highest-vol first)
  const totalVol = bins.reduce((s, v) => s + v, 0);
  const vaTarget = totalVol * 0.70;
  const sorted = bins.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const vaSet = new Set<number>();
  let acc = 0;
  for (const { v, i } of sorted) {
    if (acc >= vaTarget) break;
    acc += v;
    vaSet.add(i);
  }
  const vaIndices = Array.from(vaSet).sort((a, b) => a - b);
  const val = priceLow + (vaIndices[0]!) * binSize;
  const vah = priceLow + (vaIndices[vaIndices.length - 1]! + 1) * binSize;

  return { poc: +poc.toFixed(4), vah: +vah.toFixed(4), val: +val.toFixed(4) };
}

// ─── Options helper functions ─────────────────────────────────────────────────

function dteDays(expiration: string): number {
  // 21:00 UTC ≈ 4pm ET (winter) — consistent settlement reference across services.
  const exp = new Date(expiration + 'T21:00:00Z').getTime();
  const now = Date.now();
  return Math.max(0, Math.round((exp - now) / 86_400_000));
}

function isDTEMatch(dte: number, min: number, max: number): boolean {
  return dte >= min && dte <= max;
}

// Annualized return on collateral for a short option.
// premium and strike are both per-share, so premium/strike is the period return
// directly — do NOT divide by (strike × 100); that treats per-share premium as
// per-contract and understates the result 100×.
// see docs/formulas.md#annualized-options-return
export function annualizedReturn(
  premium: number,
  strike: number,
  dte: number
): number | null {
  if (dte <= 0 || strike <= 0) return null;
  const annual = premium / strike * (365 / dte) * 100;
  return annual;
}

// ── Graded wheel liquidity scoring (NOT YET ENABLED, v1.1.131) ───────────────
//
// The legacy score is three BINARY gates (OI ≥50 → +4, spread ≤5% → +4, volume ≥50 → +2), and
// two of them almost never fire. A 5% *relative* bid-ask on a 25-delta put is institutional-grade
// tight — WMT with open interest 13,824 and a 5.2% spread misses it by 0.2pp — and per-strike
// volume ≥50 is rare (and accrues through the session, so it reads lower in the morning). The OI
// gate ends up carrying the whole score, which sits at a near-constant 0 or 4 and ranks nothing.
//
// Calibrated against 1,278 real short-put quotes in the 0.20–0.30 delta band, pulled from stored
// `daily_briefs` structures (all captured during market hours) by
// `scripts/fr-wheel-liquidity-calibration.mjs`. Ground truth = what the contract actually costs to
// trade under the app's own fill model (`options-fill.ts`): 0.5 × half-spread as a share of the
// credit collected. Panel medians: OI 74, spread 16.9%, volume 6, entry cost 4.4% of credit.
//
//   scheme       distinct values   % scoring 0   entropy   Spearman(score, cost%)
//   legacy              6              38%         0.75          -0.419
//   continuous         21               2%         0.97          -0.799   ← this one
//
// The legacy scheme scores KO — spread 13.9%, volume 39, real cost 3.6% of credit — a flat 0.0/10.
//
// Honest caveat: `cost%` is derived from the spread, so a scheme that grades spread will always
// correlate better than one that gates it. Read the Spearman column as "graded beats binary on the
// component it measures", not as independent proof that the OI and volume terms are weighted
// right — those price exit optionality and depth, which a single-contract entry-cost measure
// cannot see.
//
// Left OFF: the signal carries weight 9 (wheel) / 13 (income), so re-ranking follows and FR-SEY-5
// wants realized outcomes, which this calibration does not provide. Independent of
// WHEEL_MONTHLY_FIRST_EXPIRY — that fixes WHICH contract is measured, this fixes how it is SCORED;
// either is useful alone, and the two were measured to be complementary.
// WHEEL_GRADED_LIQUIDITY=1 overrides on. Checked live, not cached at import.
const WHEEL_GRADED_LIQUIDITY = false;
export function wheelGradedLiquidityEnabled(): boolean {
  return WHEEL_GRADED_LIQUIDITY || process.env['WHEEL_GRADED_LIQUIDITY'] === '1';
}

/**
 * Wheel CSP option liquidity, 0–10, on the recommended contract.
 * Legacy: open interest ≥50 → +4, relative spread ≤5% → +4, same-day volume ≥50 → +2.
 * Graded (`WHEEL_GRADED_LIQUIDITY`): continuous, no cliffs — see above.
 *
 * Returns **null when there is no contract to score** — i.e. `findSuitableChain` resolved
 * nothing in the 30–45 DTE / 0.20–0.30 delta window, or price history was insufficient.
 * That case must NOT collapse to 0: a 0 asserts "measured, and illiquid", which is a
 * materially different claim from "never measured", and it propagates into the stored
 * snapshot, the Trade Scoring Engine's `missing` flag, and the wheel explanation text.
 * (~68% of a full-universe snapshot resolves no chain, so the distinction is the common
 * case, not an edge case.)
 *
 * see docs/formulas.md#liquidity-score
 */
// ── Wheel expiry selection: monthly-first (NOT YET ENABLED, v1.1.128) ────────
//
// `findSuitableChain` walks expirations in ascending date order and returns the FIRST one
// yielding a delta-band match — it never compares candidates. Since `getNearTermExpirations`
// generates consecutive Fridays, the earliest qualifying expiry is structurally a WEEKLY, and
// the [30,45] DTE window is narrower than the ~30-day monthly cycle, so a 3rd-Friday monthly is
// often unreachable anyway (from 2026-08-03 the Sep-18 monthly sat at 46 DTE — clipped by one
// day, while Sep 4 at 32 DTE won on date order).
//
// Weeklies carry 1–2 orders of magnitude less open interest at the same ~25 delta (2026-08-05,
// Sep-4 weekly vs Sep-18 monthly: PG 7 vs 4,063 · V 15 vs 802 · DIS 56 vs 2,982 · JPM 65 vs 879
// · WMT 109 vs 13,824 · AAPL 450 vs 7,668). So `optionLiquidityScore` ends up measuring a
// contract nobody would wheel and charging the TICKER for it — 94% of a full-universe snapshot
// scores 0/10, and the signal cannot separate WMT from a microcap.
//
// ENABLED: try 3rd-Friday monthlies first, and widen the window [30,45] → [28,52]. No extra
// API calls — still one chain fetch in the common case, just a different try-order.
//
// The widening does NOT guarantee a monthly is always in range: consecutive 3rd Fridays are
// 28–35 days apart, so a full guarantee needs a ~35-day-wide window (e.g. [28,63]), and a
// 63-DTE CSP is well outside the wheel's premium-selling tenor. [28,52] (width 25) puts a
// monthly in range on ~82% of days vs ~53% under [30,45]; on the remaining days the nearest
// weekly is used exactly as today. Ordering does the rest of the work — even inside the OLD
// window, first-by-date meant the monthly lost whenever a weekly was nearer.
//
// This is NOT the expiry lever rejected in v1.1.126. That tested preferring monthlies for the
// structures the ENGINE TRADES (`selectExpiration`, closest-to-30 in [20,50],
// strategy-lab-service.ts) and failed because the engine's liquidityScore>=8 gate already
// screens thin weeklies out. This is a different code path and a different purpose:
// characterising a ticker for SCORING, not choosing a trade.
//
// Left OFF until validated: it changes the recommended CSP itself, so `premiumYield` (wheel
// weight 19) and Stage-4 pool selection move with it — FR-SEY-5. It also changes what
// `options_premium_history` captures going forward, putting a discontinuity in that series.
// A clean retrospective A/B is not possible (the analysis_snapshots panel holds the OLD
// measurements and recomputing needs historical chains we don't have), so validation has to be
// forward-looking. WHEEL_MONTHLY_FIRST=1 overrides it on for a validation run or a test;
// checked live, not cached at import, so it can be set per test case.
const WHEEL_MONTHLY_FIRST_EXPIRY = false;
export function wheelMonthlyFirstEnabled(): boolean {
  return WHEEL_MONTHLY_FIRST_EXPIRY || process.env['WHEEL_MONTHLY_FIRST'] === '1';
}

/** Wheel CSP DTE window; widened when monthly-first is on so a 3rd Friday is in range far more
 *  often (~82% of days vs ~53%) — not always, see WHEEL_MONTHLY_FIRST_EXPIRY. */
export function wheelDteWindow(monthlyFirst = wheelMonthlyFirstEnabled()): { minDTE: number; maxDTE: number } {
  return monthlyFirst ? { minDTE: 28, maxDTE: 52 } : { minDTE: 30, maxDTE: 45 };
}

/**
 * True when `iso` is a standard monthly expiration (the 3rd Friday of its month).
 * All-UTC — see the weekly-expiration time-base quirk in CLAUDE.md: mixing local weekday math
 * with `toISOString()` shifts every date to Saturday on evening runs.
 */
export function isMonthlyExpiration(iso: string): boolean {
  const [y, m] = iso.split('-').map(Number);
  if (!y || !m) return false;
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(y, m - 1, firstFriday + 14)).toISOString().slice(0, 10) === iso;
}

/**
 * Order the expirations `findSuitableChain` should try, best-first.
 *
 * Default (`monthlyFirst: false`) preserves today's behavior exactly: ascending by date, so the
 * first qualifying expiry wins. With `monthlyFirst`, 3rd-Friday monthlies come first (ascending
 * among themselves), then everything else ascending — so the liquid monthly is tried before the
 * thin weekly that merely happens to be sooner.
 *
 * Input is not required to be sorted; DTE filtering is the caller's concern.
 */
export function wheelExpirationOrder(expirations: string[], monthlyFirst: boolean): string[] {
  const sorted = [...expirations].sort();
  if (!monthlyFirst) return sorted;
  const monthlies = sorted.filter(isMonthlyExpiration);
  const rest = sorted.filter((e) => !isMonthlyExpiration(e));
  return [...monthlies, ...rest];
}

export function wheelOptionLiquidityScore(
  contract: { bid: number; ask: number; openInterest: number | null; volume: number | null } | null,
  graded = wheelGradedLiquidityEnabled()
): number | null {
  if (!contract) return null;
  const { bid, ask } = contract;
  // A v3 snapshot uses day.close as the bid/ask proxy (no real quote), so the spread reads 0.
  // Only penalize when there is a meaningful spread to penalize.
  const spread = (bid > 0 && ask > 0 && ask > bid)
    ? ((ask - bid) / ((ask + bid) / 2)) * 100
    : 0;
  const oi = contract.openInterest ?? 0;
  const volume = contract.volume ?? 0;

  if (graded) {
    // Continuous, no cliffs. Calibrated on 1,278 real market-hours short-put quotes
    // (scripts/fr-wheel-liquidity-calibration.mjs) — see WHEEL_GRADED_LIQUIDITY.
    //   spread: full credit at <=5%, decaying to zero by 40% (panel median is 16.9%)
    //   OI:     log-scaled, saturating around 2,000 contracts
    //   volume: log-scaled, saturating around 100 contracts
    const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
    // NO BID is the worst possible liquidity, not the best. The shared `spread` expression above
    // reports 0 for any degenerate quote, which would hand a no-bid contract full spread credit —
    // fine for a LOCKED quote (bid === ask > 0, e.g. the v3 snapshot's day.close proxy: there
    // genuinely is no spread to measure) but wrong when there is simply no bid at all.
    // Unreachable via findSuitableChain, which filters `bid > 0`, but this is an exported helper.
    const sPts = bid > 0 ? 4 * clamp01(1 - (spread - 5) / 35) : 0;
    const oPts = 4 * clamp01(Math.log10(Math.max(oi, 1)) / 3.3);
    const vPts = 2 * clamp01(Math.log10(Math.max(volume, 1)) / 2);
    return Math.min(10, sPts + oPts + vPts);
  }

  // Legacy: three binary gates. Two of them almost never fire (see WHEEL_GRADED_LIQUIDITY),
  // so this collapses to a near-constant 0 or 4.
  let score = 0;
  if (oi >= 50) score += 4;
  if (spread <= 5) score += 4;
  if (volume >= 50) score += 2;
  return Math.min(10, score);
}

// ─── Analysis service ────────────────────────────────────────────────────────

export class AnalysisService {
  private readonly quoteCache: QuoteCache;
  private readonly fundamentalsCache: FundamentalsCache;
  private cancelled = false;

  constructor(
    private readonly db: DbHandle,
    private readonly dataProvider: DataProvider,
    private readonly rateLimiter: TokenBucketRateLimiter,
    private readonly jobQueue: JobQueue,
    private readonly optionsProvider?: OptionsProvider
  ) {
    this.quoteCache = new QuoteCache(db);
    this.fundamentalsCache = new FundamentalsCache(db);
  }

  /** Cancel the running analysis. */
  cancel(): void {
    this.cancelled = true;
  }

  /** Reset the cancel flag. Call before starting a new run. */
  resetCancel(): void {
    this.cancelled = false;
  }

  /** Analyze a single ticker with a given mode.
   *
   * @param opts.forceCache — skip all Polygon API calls and read quote,
   *   fundamentals, and price bars directly from the local DB/cache.
   *   Use this in batch jobs that run after Market Sync so the data is
   *   already warm — avoids 3 extra Polygon calls + rate-limiter waits
   *   per ticker (saves ~1.4 s/ticker in DailyOptionsSnapshotJob).
   */
  async analyzeTicker(
    ticker: string,
    mode: AnalysisMode,
    opts?: { forceCache?: boolean }
  ): Promise<AnalysisResult> {
    const forceCache = opts?.forceCache ?? false;

    if (!forceCache) await this.rateLimiter.acquire(1);

    const quoteRaw = forceCache
      ? this.fetchQuoteCached(ticker)
      : await this.fetchQuote(ticker);

    // Polygon snapshot ivRank is always null — override from iv_history when available
    // see docs/formulas.md#iv-rank
    const ivRankHistory = this.lookupIvRankFromHistory(ticker);
    const quote = ivRankHistory !== null ? { ...quoteRaw, ivRank: ivRankHistory } : quoteRaw;

    const fundamentals = forceCache
      ? this.fetchFundamentalsCached(ticker)
      : await this.fetchFundamentals(ticker);

    const bars = forceCache
      ? this.getBarsFromDb(ticker, 378)
      : await this.dataProvider.getHistoricalBars(ticker, 'day', 378); // ~252 trading days ≈ 378 calendar days
    const latestBars = bars.slice(-200); // last ~200 trading days

    switch (mode) {
      case 'buy': return this.modeBuy(ticker, quote, fundamentals, latestBars);
      case 'options_income': return this.modeOptionsIncome(ticker, quote, fundamentals, latestBars);
      case 'wheel': return this.modeWheel(ticker, quote, fundamentals, bars, forceCache); // needs full 252 for 52-wk range
      case 'bullish': return this.modeDirectional(ticker, quote, fundamentals, latestBars, 'bullish');
      case 'bearish': return this.modeDirectional(ticker, quote, fundamentals, latestBars, 'bearish');
      case 'jade_lizard': return this.modeJadeLizard(ticker, quote);
      case 'big_lizard': return this.modeBigLizard(ticker, quote);
    }
  }

  /** Inner loop — runs one mode over tickers without resetting the cancel flag. */
  private async runMode(
    tickers: string[],
    mode: AnalysisMode,
    onProgress?: ProgressCallback
  ): Promise<AnalysisResult[]> {
    const results: AnalysisResult[] = [];
    const total = tickers.length;
    for (let i = 0; i < tickers.length; i++) {
      if (this.cancelled) break;
      const ticker = tickers[i]!;
      onProgress?.(i + 1, total, ticker);
      try {
        const result = await this.analyzeTicker(ticker, mode);
        results.push(result);
      } catch {
        // Individual failures are skipped per spec §4.4.6.
      }
    }
    onProgress?.(total, total, tickers[tickers.length - 1] ?? '');
    return results;
  }

  /** Analyze a full watchlist in a single mode. */
  async analyzeWatchlist(
    _watchlistId: number,
    tickers: string[],
    mode: AnalysisMode,
    onProgress?: ProgressCallback
  ): Promise<AnalysisResult[]> {
    this.resetCancel();
    return this.runMode(tickers, mode, onProgress);
  }

  /** Analyze a full watchlist across all 5 modes sequentially. */
  async analyzeWatchlistAllModes(
    tickers: string[],
    onProgress?: (current: number, total: number, ticker: string, mode: AnalysisMode) => void
  ): Promise<AnalysisAllModesPayload> {
    this.resetCancel();
    const modes: AnalysisMode[] = ['buy', 'options_income', 'wheel', 'bullish', 'bearish', 'jade_lizard', 'big_lizard'];
    const payload: AnalysisAllModesPayload = {
      buy: [], options_income: [], wheel: [], bullish: [], bearish: [],
      jade_lizard: [], big_lizard: []
    };

    for (const mode of modes) {
      if (this.cancelled) break;
      const results = await this.runMode(
        tickers,
        mode,
        (cur, tot, ticker) => onProgress?.(cur, tot, ticker, mode)
      );
      if (mode === 'buy') payload.buy = results as BuyResult[];
      else if (mode === 'options_income') payload.options_income = results as OptionsIncomeResult[];
      else if (mode === 'wheel') payload.wheel = results as WheelResult[];
      else if (mode === 'bullish') payload.bullish = results.filter(r => r.mode === 'bullish') as StrategyResult[];
      else if (mode === 'bearish') payload.bearish = results.filter(r => r.mode === 'bearish') as StrategyResult[];
      else if (mode === 'jade_lizard') payload.jade_lizard = results as LizardResult[];
      else if (mode === 'big_lizard') payload.big_lizard = results as LizardResult[];
    }
    return payload;
  }

  /** Save an analysis snapshot to the DB. */
  saveSnapshot(
    watchlistId: number,
    mode: AnalysisMode,
    results: AnalysisResult[],
    jobRunId: number | null = null
  ): AnalysisSnapshotRow {
    const payloadJson = JSON.stringify({ jobRunId, results });
    return withTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO analysis_snapshots (watchlist_id, mode, result_count, payload_json)
         VALUES (?, ?, ?, ?)`
      ).run(watchlistId, mode, results.length, payloadJson);

      const row = this.db.prepare(
        `SELECT id, watchlist_id, mode, run_at, result_count
           FROM analysis_snapshots WHERE id = last_insert_rowid()`
      ).get() as { id: number; watchlist_id: number; mode: string; run_at: string; result_count: number };

      return {
        id: row.id,
        watchlistId: row.watchlist_id,
        mode: row.mode as AnalysisMode | 'all',
        runAt: row.run_at,
        resultCount: row.result_count,
        payloadJson
      };
    });
  }

  /**
   * Save an analysis snapshot that is not associated with any watchlist.
   * Used by batch jobs (e.g. DailyOptionsSnapshotJob) that operate on the
   * full screener universe rather than a user-defined watchlist.
   * Requires migration 024 (watchlist_id nullable).
   */
  saveGlobalSnapshot(
    mode: AnalysisMode,
    results: AnalysisResult[],
  ): void {
    const payloadJson = JSON.stringify({ jobRunId: null, results });
    this.db.prepare(
      `INSERT INTO analysis_snapshots (watchlist_id, mode, result_count, payload_json)
       VALUES (NULL, ?, ?, ?)`
    ).run(mode, results.length, payloadJson);
  }

  /** Save a combined all-modes snapshot to the DB. */
  saveAllModesSnapshot(
    watchlistId: number,
    tickerCount: number,
    results: AnalysisAllModesPayload
  ): AnalysisSnapshotRow {
    const payloadJson = JSON.stringify({ tickerCount, results });
    return withTransaction(this.db, () => {
      this.db.prepare(
        `INSERT INTO analysis_snapshots (watchlist_id, mode, result_count, payload_json)
         VALUES (?, 'all', ?, ?)`
      ).run(watchlistId, tickerCount, payloadJson);

      const row = this.db.prepare(
        `SELECT id, watchlist_id, mode, run_at, result_count
           FROM analysis_snapshots WHERE id = last_insert_rowid()`
      ).get() as { id: number; watchlist_id: number; mode: string; run_at: string; result_count: number };

      return {
        id: row.id,
        watchlistId: row.watchlist_id,
        mode: 'all',
        runAt: row.run_at,
        resultCount: row.result_count,
        payloadJson
      };
    });
  }

  /** Load a combined all-modes snapshot by id. Returns null if not found or wrong mode. */
  getAllModesSnapshot(id: number): { tickerCount: number; results: AnalysisAllModesPayload } | null {
    const snap = this.getSnapshot(id);
    if (!snap || snap.mode !== 'all') return null;
    const payload = JSON.parse(snap.payloadJson) as { tickerCount: number; results: AnalysisAllModesPayload };
    return payload;
  }

  /** Load a snapshot by id. */
  getSnapshot(id: number): AnalysisSnapshotRow | null {
    const r = this.db.prepare(
      `SELECT id, watchlist_id, mode, run_at, result_count, payload_json
         FROM analysis_snapshots WHERE id = ?`
    ).get(id) as {
      id: number; watchlist_id: number; mode: string;
      run_at: string; result_count: number; payload_json: string;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      watchlistId: r.watchlist_id,
      mode: r.mode as AnalysisMode | 'all',
      runAt: r.run_at,
      resultCount: r.result_count,
      payloadJson: r.payload_json
    };
  }

  /** List snapshots for a watchlist. */
  listSnapshots(watchlistId: number): AnalysisSnapshotRow[] {
    const rows = this.db.prepare(
      `SELECT id, watchlist_id, mode, run_at, result_count, payload_json
         FROM analysis_snapshots WHERE watchlist_id = ? ORDER BY run_at DESC`
    ).all(watchlistId) as Array<{
      id: number; watchlist_id: number; mode: string;
      run_at: string; result_count: number; payload_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      watchlistId: r.watchlist_id,
      mode: r.mode as AnalysisMode | 'all',
      runAt: r.run_at,
      resultCount: r.result_count,
      payloadJson: r.payload_json
    }));
  }

  /**
   * Latest snapshot of a mode across ALL watchlists, including the global (watchlist_id NULL)
   * ones the batch jobs write — which `listSnapshots` can never return, since `= NULL` matches
   * nothing. Lets scripts read the live wheel panel through the API instead of the SQLite file.
   */
  getLatestSnapshotByMode(
    mode: AnalysisMode | 'all'
  ): (Omit<AnalysisSnapshotRow, 'watchlistId'> & { watchlistId: number | null }) | null {
    const r = this.db.prepare(
      `SELECT id, watchlist_id, mode, run_at, result_count, payload_json
         FROM analysis_snapshots WHERE mode = ? ORDER BY run_at DESC, id DESC LIMIT 1`
    ).get(mode) as {
      id: number; watchlist_id: number | null; mode: string;
      run_at: string; result_count: number; payload_json: string;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      watchlistId: r.watchlist_id,
      mode: r.mode as AnalysisMode | 'all',
      runAt: r.run_at,
      resultCount: r.result_count,
      payloadJson: r.payload_json
    };
  }

  deleteSnapshot(id: number): void {
    this.db.prepare('DELETE FROM analysis_snapshots WHERE id = ?').run(id);
  }

  clearSnapshots(watchlistId: number): void {
    this.db.prepare('DELETE FROM analysis_snapshots WHERE watchlist_id = ?').run(watchlistId);
  }

  // ─── Private: data fetch helpers ────────────────────────────────────────────

  private async fetchQuote(ticker: string) {
    try {
      const cached = this.quoteCache.get(ticker);
      if (cached && !this.quoteCache.isStale(ticker)) return cached;
    } catch { /* fall through */ }
    const snap = await this.dataProvider.getQuote(ticker);
    const q = { ticker, last: snap.last ?? null, prevClose: snap.prevClose ?? null,
      bid: snap.bid ?? null, ask: snap.ask ?? null, volume: snap.volume ?? null,
      dayHigh: snap.dayHigh ?? null, dayLow: snap.dayLow ?? null,
      ivRank: snap.ivRank ?? null, ivPercentile: snap.ivPercentile ?? null,
      currentIv: null,
      fetchedAt: new Date().toISOString() };
    try { this.quoteCache.upsert(q); } catch { /* best effort */ }
    return q;
  }

  private async fetchFundamentals(ticker: string) {
    const cached = this.fundamentalsCache.get(ticker);
    if (cached && !this.fundamentalsCache.isStale(ticker)) return cached.ratios;
    const ratios = await this.dataProvider.getFundamentals(ticker);
    try { this.fundamentalsCache.upsert(ticker, ratios); } catch { /* best effort */ }
    return ratios;
  }

  /** Quote from cache regardless of TTL — used by forceCache path. */
  private fetchQuoteCached(ticker: string) {
    try {
      const cached = this.quoteCache.get(ticker);
      if (cached) return cached;
    } catch { /* fall through */ }
    // Return a minimal null-filled quote so downstream analysis still runs.
    return {
      ticker, last: null, prevClose: null, bid: null, ask: null,
      volume: null, dayHigh: null, dayLow: null,
      ivRank: null, ivPercentile: null, currentIv: null,
      fetchedAt: new Date().toISOString(),
    };
  }

  /** Fundamentals from cache regardless of TTL — used by forceCache path.
   *  Returns a null-filled DerivedRatios (never null itself) so mode functions
   *  always receive the expected shape even when fundamentals aren't cached.
   */
  private fetchFundamentalsCached(ticker: string): import('@shared/types.js').DerivedRatios {
    try {
      const cached = this.fundamentalsCache.get(ticker);
      if (cached) return cached.ratios;
    } catch { /* fall through */ }
    return {
      peRatio: null, eps: null, marketCap: null, debtToEquity: null, roe: null,
      profitMargin: null, revenueGrowth: null, epsGrowth: null, freeCashFlow: null,
      currentRatio: null, dividendYield: null, beta: null,
      fcfToNetIncome: null, roic: null, netDebtToEbitda: null,
      revenueGrowth5Y: null, epsGrowth5Y: null,
      valueScore: null, growthScore: null, stockGrade: null,
      sector: null, industry: null, companyName: null,
    };
  }

  /** Read historical price bars from the local DB (historical_prices table).
   *  Used by forceCache path — avoids a Polygon API call when bars are
   *  already populated by Market Sync / Price Gap Fill.
   *  Returns bars in the same shape as DataProvider.getHistoricalBars().
   */
  private getBarsFromDb(
    ticker: string,
    calendarDaysLookback: number
  ): Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> {
    type Row = { date: string; open: number; high: number; low: number; close: number; volume: number };
    const cutoff = new Date(Date.now() - calendarDaysLookback * 86_400_000)
      .toISOString().slice(0, 10);
    const rows = this.db.prepare(`
      SELECT date, open, high, low, close, volume
      FROM historical_prices
      WHERE ticker = ? AND date >= ?
      ORDER BY date ASC
    `).all(ticker, cutoff) as Row[];

    return rows.map(r => ({
      t: new Date(r.date + 'T00:00:00Z').getTime(),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume,
    }));
  }

  /** Compute IVR from the iv_history table (252-day rolling window).
   *  Polygon snapshot ivRank is always null — use this instead.
   *  see docs/formulas.md#iv-rank */
  private lookupIvRankFromHistory(ticker: string): number | null {
    try {
      const agg = this.db.prepare(`
        SELECT MAX(atm_iv) as iv_high, MIN(atm_iv) as iv_low, COUNT(*) as cnt
        FROM iv_history WHERE ticker = ?
      `).get(ticker) as { iv_high: number | null; iv_low: number | null; cnt: number } | undefined;
      if (!agg || agg.cnt < 21 || agg.iv_high === null || agg.iv_low === null) return null;
      const range = agg.iv_high - agg.iv_low;
      if (range <= 0) return null;
      const latest = this.db.prepare(
        `SELECT atm_iv FROM iv_history WHERE ticker = ? ORDER BY date DESC LIMIT 1`
      ).get(ticker) as { atm_iv: number } | undefined;
      if (!latest) return null;
      return Math.min(100, Math.max(0, ((latest.atm_iv - agg.iv_low) / range) * 100));
    } catch {
      return null;
    }
  }

  // ─── Mode: Buy Opportunities ────────────────────────────────────────────────

  private modeBuy(
    ticker: string,
    quote: { last: number | null },
    fundamentals: { peRatio: number | null; eps: number | null; revenueGrowth: number | null;
      profitMargin: number | null; debtToEquity: number | null; roe: number | null },
    bars: Bar[]
  ): BuyResult {
    const price = quote.last ?? null;

    // SMA stack.
    const sma20Arr = computeSMA(bars, 20);
    const sma50Arr = computeSMA(bars, 50);
    const sma200Arr = computeSMA(bars, 200);
    const last = bars[bars.length - 1];
    const sma20 = sma20Arr[sma20Arr.length - 1] ?? null;
    const sma50 = sma50Arr[sma50Arr.length - 1] ?? null;
    const sma200 = sma200Arr[sma200Arr.length - 1] ?? null;
    const currentPrice = last?.c ?? null;

    // Trend: bullish if price > SMA50 > SMA200.
    let trend: 'bullish' | 'bearish' | 'sideways' = 'sideways';
    if (currentPrice !== null && sma50 !== null && sma200 !== null) {
      if (currentPrice > sma50 && sma50 > sma200) trend = 'bullish';
      else if (currentPrice < sma50 && sma50 < sma200) trend = 'bearish';
    }

    // RSI.
    const rsiArr = computeRSI(bars, 14);
    const rsi = rsiArr[rsiArr.length - 1] ?? null;

    // ATR for stop/target.
    const atrArr = computeATR(bars, 14);
    const atr = atrArr[atrArr.length - 1] ?? null;

    // Swing low for entry zone lower bound.
    const swing = findSwingHighLow(bars, 20);
    const rawA = swing.low;
    const rawB = sma50 !== null ? sma50 : currentPrice;
    const entryZoneLow = (rawA !== null && rawB !== null) ? Math.min(rawA, rawB) : (rawA ?? rawB);
    const entryZoneHigh = (rawA !== null && rawB !== null) ? Math.max(rawA, rawB) : (rawA ?? rawB);

    // Stop-loss: 1.5× ATR below entry zone low.
    const stopLoss = (entryZoneLow !== null && atr !== null)
      ? +(entryZoneLow - 1.5 * atr).toFixed(2)
      : null;

    // Target: entry zone + 2× ATR (2:1 risk/reward).
    const targetPrice = (entryZoneLow !== null && atr !== null)
      ? +(entryZoneLow + 3 * atr).toFixed(2)
      : null;

    // Risk/reward.
    const riskReward = (stopLoss !== null && targetPrice !== null && entryZoneLow !== null)
      ? +(targetPrice - entryZoneLow) / (entryZoneLow - stopLoss)
      : null;

    // Detect ETF: all key fundamental ratios null → P/E, EPS, ROE, D/E not applicable.
    const isEtf =
      fundamentals.peRatio === null &&
      fundamentals.eps === null &&
      fundamentals.roe === null &&
      fundamentals.debtToEquity === null;

    // Composite score (0–10).
    let compositeScore = 0;
    if (trend === 'bullish') compositeScore += 3;
    else if (trend === 'sideways') compositeScore += 1;
    if (rsi !== null && rsi >= 40 && rsi <= 65) compositeScore += 2;
    if (rsi !== null && rsi >= 45 && rsi <= 55) compositeScore += 1; // sweet spot
    // Fundamental scoring — skipped for ETFs (P/E, Margin, ROE, D/E are N/A)
    if (!isEtf) {
      if (fundamentals.peRatio !== null && fundamentals.peRatio >= 5 && fundamentals.peRatio <= 25) compositeScore += 1;
      if (fundamentals.profitMargin !== null && fundamentals.profitMargin >= 10) compositeScore += 1;
      if (fundamentals.roe !== null && fundamentals.roe >= 15) compositeScore += 1;
      if (fundamentals.debtToEquity !== null && fundamentals.debtToEquity < 1) compositeScore += 1;
    }

    // Volume profile scoring (+0–2). see docs/formulas.md#volume-profile-levels
    const vpLevels = computeVolumeProfileLevels(bars);
    let vpNote = '';
    if (vpLevels !== null && currentPrice !== null) {
      if (currentPrice > vpLevels.poc) {
        compositeScore += 1; // price above POC → buyers in control
      }
      const nearVAL = currentPrice >= vpLevels.val * 0.98 && currentPrice <= vpLevels.val * 1.02;
      if (currentPrice > vpLevels.vah) {
        compositeScore += 1; // breakout above value area
        vpNote = `VP: above VAH $${vpLevels.vah.toFixed(2)} (breakout ✓)`;
      } else if (nearVAL) {
        compositeScore += 1; // testing value area support
        vpNote = `VP: near VAL $${vpLevels.val.toFixed(2)} (support test ✓)`;
      } else if (currentPrice > vpLevels.poc) {
        vpNote = `VP: above POC $${vpLevels.poc.toFixed(2)} ✓`;
      } else {
        vpNote = `VP: below POC $${vpLevels.poc.toFixed(2)}`;
      }
    }

    compositeScore = Math.min(10, compositeScore);

    // Fundamentals pass — ETFs are always treated as passing (no earnings/debt risk by construction).
    const fundamentalsPass = isEtf || !!(
      fundamentals.peRatio !== null && fundamentals.peRatio >= 5 && fundamentals.peRatio <= 30 &&
      (fundamentals.eps ?? 0) > 0 &&
      fundamentals.debtToEquity !== null && fundamentals.debtToEquity < 1.5
    );

    // Explanation.
    const etfNote = isEtf ? ' ETF — fundamentals N/A, scored on technicals only.' : '';
    const explanation = `Price ${currentPrice !== null ? `$${currentPrice.toFixed(2)}` : '—'} above $${sma50?.toFixed(2) ?? '?'}/$${sma200?.toFixed(2) ?? '?'} SMA${trend === 'bullish' ? ' (bullish stack)' : trend === 'bearish' ? ' (bearish stack)' : ' (sideways)'}. RSI ${rsi !== null ? rsi.toFixed(1) : '—'} ${rsi !== null && rsi >= 40 && rsi <= 65 ? '✓' : '✗'} (target 40–65).${vpNote ? ' ' + vpNote + '.' : ''}${etfNote} Composite score ${compositeScore}/10.`;

    return {
      mode: 'buy', ticker, lastPrice: price,
      compositeScore, trend,
      smaStack: { sma20, sma50, sma200 },
      rsi,
      entryZoneLow, entryZoneHigh,
      stopLoss, targetPrice, riskReward,
      fundamentalsPass, explanation
    };
  }

  // ─── Mode: Options Income ──────────────────────────────────────────────────

  private async modeOptionsIncome(
    ticker: string,
    quote: { last: number | null; ivRank: number | null },
    _fundamentals: { peRatio: number | null; eps: number | null; revenueGrowth: number | null;
      profitMargin: number | null; debtToEquity: number | null; roe: number | null; freeCashFlow: number | null },
    _bars: Bar[]
  ): Promise<OptionsIncomeResult> {
    const price = quote.last ?? null;
    const ivRank = quote.ivRank ?? null;

    // Get options chain for near-term expiration (30–45 DTE).
    const chain = await this.findSuitableChain(ticker, 30, 45, 0.20, 0.35);
    if (!chain) {
      return this.emptyOptionsIncome(ticker, price, ivRank, 'No suitable options found for 30–45 DTE with delta 0.20–0.35.');
    }

    const { contract, dte } = chain;
    // Credit received, modeled at a realistic short fill (below mid toward the bid) rather
    // than the optimistic mid or the old flat mid/2 hack. see docs/formulas.md#fill-model
    const premium = fillPrice(contract.bid, contract.ask, 'sell');

    if (!price) {
      return this.emptyOptionsIncome(ticker, price, ivRank, 'No quote available.');
    }

    const capitalRequired = contract.strike * 100;
    const annualizedReturn_val = annualizedReturn(premium, contract.strike, dte);
    const breakeven = contract.side === 'put'
      ? contract.strike - premium
      : contract.strike + premium;

    const strategy = contract.side === 'put' ? 'CSP' : 'CC';
    const explanation =
      `${strategy} at $${contract.strike.toFixed(2)} exp ${contract.ticker.split('O')[1]?.slice(0, 6) ?? contract.expiration}. ` +
      `Premium ~$${premium.toFixed(2)}/share. ` +
      `Annualized ${annualizedReturn_val !== null ? annualizedReturn_val.toFixed(1) : '?'}%. ` +
      `Capital: $${(capitalRequired).toLocaleString()}.`;

    return {
      mode: 'options_income', ticker, lastPrice: price,
      strategy, strike: contract.strike, expiration: contract.expiration,
      dte, delta: contract.delta,
      bid: contract.bid, ask: contract.ask,
      premium, annualizedReturn: annualizedReturn_val,
      ivRank, openInterest: contract.openInterest ?? null, volume: contract.volume ?? null,
      breakeven, capitalRequired, explanation
    };
  }

  private emptyOptionsIncome(ticker: string, price: number | null, ivRank: number | null, explanation: string): OptionsIncomeResult {
    return {
      mode: 'options_income', ticker, lastPrice: price,
      strategy: 'CSP', strike: null, expiration: null, dte: null,
      delta: null, bid: null, ask: null, premium: null, annualizedReturn: null,
      ivRank, openInterest: null, volume: null, breakeven: null, capitalRequired: null, explanation
    };
  }

  // ─── Mode: Wheel Strategy ───────────────────────────────────────────────────

  private async modeWheel(
    ticker: string,
    quote: { last: number | null; ivRank: number | null },
    fundamentals: { peRatio: number | null; eps: number | null; debtToEquity: number | null;
      roe: number | null; freeCashFlow: number | null },
    bars: Bar[],
    forceCache = false
  ): Promise<WheelResult> {
    const price = quote.last ?? null;
    const ivRank = quote.ivRank ?? null;

    // Current IV — prefer iv_history (no API call) in forceCache mode.
    // In live mode, fetch from options chain for the freshest value.
    let currentIv: number | null = null;
    if (forceCache) {
      // atm_iv is stored as a percentage (e.g. 28.5 = 28.5%) — see docs/formulas.md#iv-history
      try {
        type IvRow = { atm_iv: number };
        const row = this.db.prepare(
          `SELECT atm_iv FROM iv_history WHERE ticker = ? ORDER BY date DESC LIMIT 1`
        ).get(ticker) as IvRow | undefined;
        currentIv = row?.atm_iv ?? null;
      } catch { /* leave null */ }
    } else {
      try {
        const ivData = await (this.optionsProvider ?? this.dataProvider).getOptionsIV(ticker);
        currentIv = ivData.currentIv;
      } catch { /* ignore errors */ }
    }

    // Stability check: price within 25% of 52-wk high, not at 52-wk low.
    if (bars.length < 252) {
      return this.emptyWheel(ticker, price, currentIv, ivRank, 'Insufficient price history (need ≥252 bars).');
    }
    const high252 = Math.max(...bars.map((b) => b.h));
    const low252 = Math.min(...bars.map((b) => b.l));
    const currentPrice = bars[bars.length - 1]?.c ?? null;
    const distFromHigh = currentPrice !== null && high252 > 0
      ? ((high252 - currentPrice) / high252) * 100 : null;
    const distFromLow = currentPrice !== null && low252 > 0
      ? ((currentPrice - low252) / low252) * 100 : null;

    const stabilityPass = distFromHigh !== null && distFromHigh <= 25 && distFromLow !== null && distFromLow >= 15;

    // Earnings check — skip in forceCache mode (Polygon earnings stub always
    // returns null; skipping it saves one network call per ticker).
    let daysToEarnings: number | null = null;
    if (!forceCache) {
      const earnings = await this.dataProvider.getEarningsCalendar(ticker);
      daysToEarnings = earnings.nextEarningsDate
        ? Math.max(0, Math.round((new Date(earnings.nextEarningsDate).getTime() - Date.now()) / 86_400_000))
        : null;
    }
    const earningsPass = daysToEarnings === null || daysToEarnings > 45;

    // IV rank check.
    const ivPass = ivRank === null || ivRank >= 30;

    // Find suitable CSP in the wheel DTE window, delta 0.20–0.30. Window and try-order both
    // depend on WHEEL_MONTHLY_FIRST_EXPIRY (default off → 30–45 DTE, first-by-date).
    const monthlyFirst = wheelMonthlyFirstEnabled();
    const { minDTE, maxDTE } = wheelDteWindow(monthlyFirst);
    const chain = await this.findSuitableChain(ticker, minDTE, maxDTE, 0.20, 0.30, monthlyFirst);
    // null (not 0) when there is no contract to measure — see wheelOptionLiquidityScore.
    const liquidity = wheelOptionLiquidityScore(chain?.contract ?? null);
    // Local 0-floor for the suitability/explanation gates below, which are pass/fail on a
    // measured score and must not credit an unmeasured ticker.
    const liquidityScore = liquidity ?? 0;

    // Detect ETF: ROE and FCF are N/A (null) — award those points automatically.
    // ETFs hold diversified assets with no single-company earnings/debt risk.
    const isEtf = fundamentals.peRatio === null && fundamentals.roe === null;

    // Suitability score (1–10) — see docs/formulas.md#wheel-suitability-score
    let score = 1;
    if (ivPass) score += 2;
    if (stabilityPass) score += 2;
    if (liquidityScore >= 5) score += 2;
    if (earningsPass) score += 2;
    // ROE / FCF — auto-pass for ETFs (no meaningful company fundamentals)
    if (isEtf || (fundamentals.roe !== null && fundamentals.roe >= 15)) score += 1;
    if (isEtf || (fundamentals.freeCashFlow !== null && fundamentals.freeCashFlow > 0)) score += 1;
    score = Math.min(10, score);

    let explanation = '';
    if (!ivPass) explanation += `IV rank ${ivRank} < 30. `;
    if (!stabilityPass) explanation += 'Price not in healthy range. ';
    if (!earningsPass) explanation += `Earnings in ${daysToEarnings} days. `;
    // Only claim "low liquidity" when a chain was actually found and scored — with no chain,
    // liquidityScore is an unset 0, not a measurement.
    if (chain && liquidityScore < 5) explanation += 'Low option liquidity. ';

    // No contract resolved → say exactly that. This must come BEFORE the "all checks passed"
    // default, or a ticker with no CSP but no other failed check reports success.
    if (!chain || !price) {
      explanation += 'No suitable CSP found (30–45 DTE, delta 0.20–0.30). ';
      return this.emptyWheel(ticker, price, currentIv, ivRank, explanation.trim());
    }

    if (isEtf && explanation === '') explanation = 'ETF — all checks passed (fundamentals N/A). ';
    if (explanation === '') explanation = 'All checks passed.';

    const { contract, dte } = chain;
    // CSP credit at a realistic short fill (below mid toward the bid). see docs/formulas.md#fill-model
    const premium = fillPrice(contract.bid, contract.ask, 'sell');
    const annual = annualizedReturn(premium, contract.strike, dte);

    return {
      mode: 'wheel', ticker, lastPrice: price,
      recommendedStrike: contract.strike,
      expiration: contract.expiration,
      dte, delta: contract.delta,
      premium, annualizedReturn: annual,
      currentIv, ivRank, daysToEarnings,
      // The liquidity inputs, not just the verdict — so options_premium_history can persist the
      // evidence. Discarded before v1.1.132, which left two months of wheel rows NULL here.
      bid: contract.bid, ask: contract.ask,
      openInterest: contract.openInterest ?? null, volume: contract.volume ?? null,
      optionLiquidityScore: liquidity,
      suitabilityScore: score,
      explanation: explanation.trim()
    };
  }

  private emptyWheel(ticker: string, price: number | null, currentIv: number | null, ivRank: number | null, explanation: string): WheelResult {
    return {
      mode: 'wheel', ticker, lastPrice: price,
      recommendedStrike: null, expiration: null, dte: null,
      delta: null, premium: null, annualizedReturn: null,
      currentIv, ivRank, daysToEarnings: null,
      bid: null, ask: null, openInterest: null, volume: null,
      // NOT 0 — nothing was measured here (no suitable chain / insufficient history). A 0
      // would be read downstream as "measured and illiquid" and cost the full weight-9
      // optionLiquidity penalty; null makes the signal *missing* instead (FR-SE-03).
      optionLiquidityScore: null, suitabilityScore: 1, explanation
    };
  }

  // ─── Mode: Bullish / Bearish ───────────────────────────────────────────────

  private modeDirectional(
    ticker: string,
    quote: { last: number | null },
    _fundamentals: { peRatio: number | null; eps: number | null; revenueGrowth: number | null;
      profitMargin: number | null; debtToEquity: number | null; roe: number | null; freeCashFlow: number | null },
    bars: Bar[],
    mode: 'bullish' | 'bearish'
  ): StrategyResult {
    const price = quote.last ?? null;

    const sma50Arr = computeSMA(bars, 50);
    const sma200Arr = computeSMA(bars, 200);
    const adxArr = computeADX(bars, 14);
    const rsiArr = computeRSI(bars, 14);

    const currentPrice = bars[bars.length - 1]?.c ?? null;
    const sma50 = sma50Arr[sma50Arr.length - 1] ?? null;
    const sma200 = sma200Arr[sma200Arr.length - 1] ?? null;
    const adx = adxArr[adxArr.length - 1] ?? null;
    const rsi = rsiArr[rsiArr.length - 1] ?? null;

    let trendStrength = 0;
    if (adx !== null) trendStrength = Math.round(adx);

    // Determine trend.
    let isTrending = false;
    if (mode === 'bullish' && currentPrice !== null && sma50 !== null && sma200 !== null) {
      isTrending = currentPrice > sma50 && sma50 > sma200 && (adx ?? 0) > 20;
    } else if (mode === 'bearish' && currentPrice !== null && sma50 !== null && sma200 !== null) {
      isTrending = currentPrice < sma50 && sma50 < sma200 && (adx ?? 0) > 20;
    }

    // Pick strategy based on trend strength.
    let suggestedStrategy: StrategyResult['suggestedStrategy'];
    let structure = '';
    let maxProfit: number | null = null;
    let maxLoss: number | null = null;
    let breakeven: number | null = null;
    let probabilityOfProfit: number | null = null;

    if (!price) {
      suggestedStrategy = mode === 'bullish' ? 'short_put' : 'short_call';
      structure = 'No price data available';
    } else if (!isTrending) {
      // No confirmed trend yet — suggest a conservative, income-oriented strategy.
      if (mode === 'bullish') {
        const otm = Math.round(price * 0.95 / 5) * 5;
        suggestedStrategy = 'short_put';
        structure = `Sell ${otm} put (conservative CSP — trend not confirmed)`;
        maxProfit = null;
        maxLoss = otm * 100;
        breakeven = otm - 3;
        probabilityOfProfit = 0.60;
      } else {
        const otm = Math.round(price * 1.05 / 5) * 5;
        suggestedStrategy = 'short_call';
        structure = `Sell ${otm} call (conservative — trend not confirmed)`;
        maxProfit = null; // premium received
        maxLoss = null; // theoretically unlimited if naked
        breakeven = otm + 3;
        probabilityOfProfit = 0.55;
      }
    } else if (mode === 'bullish') {
      if (adx !== null && adx > 30 && rsi !== null && rsi < 70) {
        // Strong trend: bull call spread.
        suggestedStrategy = 'bull_call_spread';
        const atm = Math.round(price / 5) * 5;
        const otm = atm + 5;
        const breakeven_val = atm + 2; // net debit
        structure = `Buy ${atm} call / Sell ${otm} call (bull call spread)`;
        maxProfit = (otm - atm - 2) * 100; // per spread
        maxLoss = 2 * 100; // net debit
        breakeven = breakeven_val;
        probabilityOfProfit = 0.55; // conservative estimate
      } else if (rsi !== null && rsi < 50) {
        // Weak: long call.
        suggestedStrategy = 'long_call';
        const atm = Math.round(price / 5) * 5;
        structure = `Buy ${atm} call (straight)`;
        maxProfit = null; // unlimited upside
        maxLoss = null; // limited to premium paid
        breakeven = atm + 3; // approximate
        probabilityOfProfit = 0.45;
      } else {
        // Moderate: short put for income on pullback.
        suggestedStrategy = 'short_put';
        const otm = Math.round(price * 0.95 / 5) * 5;
        structure = `Sell ${otm} put (cash-secured)`;
        maxProfit = null; // premium received
        maxLoss = otm * 100; // max loss if assigned
        breakeven = otm - 3; // approximate
        probabilityOfProfit = 0.60;
      }
    } else {
      // Bearish mode.
      if (adx !== null && adx > 30 && rsi !== null && rsi > 30) {
        suggestedStrategy = 'bear_put_spread';
        const atm = Math.round(price / 5) * 5;
        const otm = atm - 5;
        structure = `Buy ${atm} put / Sell ${otm} put (bear put spread)`;
        maxProfit = (atm - otm - 2) * 100;
        maxLoss = 2 * 100;
        breakeven = atm - 2;
        probabilityOfProfit = 0.55;
      } else if (rsi !== null && rsi > 50) {
        suggestedStrategy = 'long_put';
        const atm = Math.round(price / 5) * 5;
        structure = `Buy ${atm} put (straight)`;
        maxProfit = null; // limited to strike - premium
        maxLoss = null; // limited to premium paid
        breakeven = atm - 3;
        probabilityOfProfit = 0.45;
      } else {
        suggestedStrategy = 'short_call';
        const otm = Math.round(price * 1.05 / 5) * 5;
        structure = `Sell ${otm} call (covered or naked)`;
        maxProfit = null; // premium received
        maxLoss = null; // unlimited if naked
        breakeven = otm + 3;
        probabilityOfProfit = 0.60;
      }
    }

    const explanation =
      `${mode === 'bullish' ? 'Bullish' : 'Bearish'} trend ` +
      `${isTrending ? `confirmed (ADX ${trendStrength}, price ${currentPrice !== null ? `$${currentPrice.toFixed(2)}` : '—'}, SMA50 $${sma50?.toFixed(2) ?? '?'})` : 'not confirmed yet'}. ` +
      `Suggested: ${structure}.${adx !== null ? ` ADX=${adx.toFixed(1)}.` : ''}`;

    return {
      mode, ticker, lastPrice: price,
      trendStrength,
      suggestedStrategy, structure,
      maxProfit, maxLoss, breakeven,
      probabilityOfProfit,
      explanation
    };
  }

  // ─── Mode: Jade Lizard ────────────────────────────────────────────────────────

  private async modeJadeLizard(
    ticker: string,
    quote: { last: number | null; ivRank: number | null }
  ): Promise<LizardResult> {
    const price = quote.last;
    const ivRank = quote.ivRank;
    const empty = (reason: string): LizardResult => ({
      mode: 'jade_lizard', ticker, lastPrice: price, expiration: null, dte: null,
      putStrike: null, shortCallStrike: null, longCallStrike: null,
      netCredit: null, spreadWidth: null, hasNoUpsideRisk: null,
      maxProfit: null, maxLossDown: null, breakevenDown: null, ivRank,
      putPremium: null, shortCallPremium: null, longCallPremium: null, explanation: reason
    });

    if (!price) return empty('No quote available.');

    const chainData = await this.findLizardChain(ticker, 30, 45);
    if (!chainData) return empty('No options chain found for 30–45 DTE.');

    const { contracts, dte, expiration } = chainData;

    // Short OTM put: |delta| ~0.30, range 0.20–0.40
    const puts = contracts.filter(c => c.side === 'put' && c.delta !== null &&
      Math.abs(c.delta) >= 0.20 && Math.abs(c.delta) <= 0.40 && c.bid > 0);
    if (!puts.length) return empty('No liquid OTM puts found (delta 0.20–0.40).');
    const shortPut = puts.reduce((a, b) =>
      Math.abs(Math.abs(a.delta ?? 0) - 0.30) <= Math.abs(Math.abs(b.delta ?? 0) - 0.30) ? a : b);

    // Short OTM call: delta ~0.20, range 0.10–0.30
    const otmCalls = contracts.filter(c => c.side === 'call' && c.delta !== null &&
      c.delta >= 0.10 && c.delta <= 0.30 && c.bid > 0);
    if (!otmCalls.length) return empty('No liquid OTM calls found (delta 0.10–0.30).');
    const shortCall = otmCalls.reduce((a, b) =>
      Math.abs((a.delta ?? 0) - 0.20) <= Math.abs((b.delta ?? 0) - 0.20) ? a : b);

    // Long call: nearest strike above short call (forms the bear call spread)
    const longCallCandidates = contracts.filter(c => c.side === 'call' && c.strike > shortCall.strike && c.ask > 0);
    if (!longCallCandidates.length) return empty('No long call available above short call strike.');
    const longCall = longCallCandidates.reduce((a, b) => a.strike < b.strike ? a : b);

    const putMid       = (shortPut.bid  + shortPut.ask)  / 2;
    const sCallMid     = (shortCall.bid + shortCall.ask) / 2;
    const lCallMid     = (longCall.bid  + longCall.ask)  / 2;
    const netCredit    = putMid + sCallMid - lCallMid;
    const spreadWidth  = longCall.strike - shortCall.strike;
    const hasNoUpsideRisk = netCredit > spreadWidth;
    const breakevenDown   = shortPut.strike - netCredit;

    const explanation =
      `Jade Lizard: Sell $${shortPut.strike} put + Sell $${shortCall.strike}/$${longCall.strike} call spread. ` +
      `Net credit $${netCredit.toFixed(2)}/share (spread width $${spreadWidth.toFixed(2)}). ` +
      `${hasNoUpsideRisk ? '✓ No upside risk' : '⚠ Credit < spread width — upside risk exists'}. ` +
      `Downside break-even $${breakevenDown.toFixed(2)}.`;

    return {
      mode: 'jade_lizard', ticker, lastPrice: price, expiration, dte,
      putStrike: shortPut.strike, shortCallStrike: shortCall.strike, longCallStrike: longCall.strike,
      netCredit, spreadWidth, hasNoUpsideRisk,
      maxProfit: netCredit,
      maxLossDown: shortPut.strike - netCredit,
      breakevenDown, ivRank,
      putPremium: putMid, shortCallPremium: sCallMid, longCallPremium: lCallMid,
      explanation
    };
  }

  // ─── Mode: Big Lizard ─────────────────────────────────────────────────────────

  private async modeBigLizard(
    ticker: string,
    quote: { last: number | null; ivRank: number | null }
  ): Promise<LizardResult> {
    const price = quote.last;
    const ivRank = quote.ivRank;
    const empty = (reason: string): LizardResult => ({
      mode: 'big_lizard', ticker, lastPrice: price, expiration: null, dte: null,
      putStrike: null, shortCallStrike: null, longCallStrike: null,
      netCredit: null, spreadWidth: null, hasNoUpsideRisk: null,
      maxProfit: null, maxLossDown: null, breakevenDown: null, ivRank,
      putPremium: null, shortCallPremium: null, longCallPremium: null, explanation: reason
    });

    if (!price) return empty('No quote available.');

    const chainData = await this.findLizardChain(ticker, 30, 45);
    if (!chainData) return empty('No options chain found for 30–45 DTE.');

    const { contracts, dte, expiration } = chainData;

    // ATM strike: nearest to current price
    const strikes = [...new Set(contracts.map(c => c.strike))].sort((a, b) => a - b);
    if (!strikes.length) return empty('No strikes in chain.');
    const atmStrike = strikes.reduce((a, b) => Math.abs(a - price) <= Math.abs(b - price) ? a : b);

    const atmPut  = contracts.find(c => c.side === 'put'  && c.strike === atmStrike && c.bid > 0);
    const atmCall = contracts.find(c => c.side === 'call' && c.strike === atmStrike && c.bid > 0);
    if (!atmPut || !atmCall) return empty(`No liquid ATM straddle at $${atmStrike}.`);

    // Long call: nearest strike above ATM
    const longCallCandidates = contracts.filter(c => c.side === 'call' && c.strike > atmStrike && c.ask > 0);
    if (!longCallCandidates.length) return empty('No long call available above ATM strike.');
    const longCall = longCallCandidates.reduce((a, b) => a.strike < b.strike ? a : b);

    const putMid      = (atmPut.bid  + atmPut.ask)  / 2;
    const callMid     = (atmCall.bid + atmCall.ask) / 2;
    const lCallMid    = (longCall.bid + longCall.ask) / 2;
    const netCredit   = putMid + callMid - lCallMid;
    const spreadWidth = longCall.strike - atmStrike;
    const hasNoUpsideRisk = netCredit > spreadWidth;
    const breakevenDown   = atmStrike - netCredit;

    const explanation =
      `Big Lizard: Sell $${atmStrike} straddle + Buy $${longCall.strike} call (spread width $${spreadWidth.toFixed(2)}). ` +
      `Net credit $${netCredit.toFixed(2)}/share. ` +
      `${hasNoUpsideRisk ? '✓ No upside risk' : '⚠ Credit < spread width — upside risk exists'}. ` +
      `Downside break-even $${breakevenDown.toFixed(2)}.`;

    return {
      mode: 'big_lizard', ticker, lastPrice: price, expiration, dte,
      putStrike: atmStrike, shortCallStrike: atmStrike, longCallStrike: longCall.strike,
      netCredit, spreadWidth, hasNoUpsideRisk,
      maxProfit: netCredit,
      maxLossDown: atmStrike - netCredit,
      breakevenDown, ivRank,
      putPremium: putMid, shortCallPremium: callMid, longCallPremium: lCallMid,
      explanation
    };
  }

  // ─── Private: lizard chain helper ────────────────────────────────────────────

  /** Fetch first expiration in [minDTE, maxDTE] that has a non-empty chain. */
  private async findLizardChain(
    ticker: string,
    minDTE: number,
    maxDTE: number
  ): Promise<{ contracts: NonNullable<OptionsChain['contracts']>; dte: number; expiration: string } | null> {
    let expirations: string[];
    try {
      expirations = await this.getNearTermExpirations(ticker, 7);
    } catch {
      return null;
    }
    for (const exp of expirations) {
      const dte = dteDays(exp);
      if (!isDTEMatch(dte, minDTE, maxDTE)) continue;
      let chain: OptionsChain;
      try {
        chain = await (this.optionsProvider ?? this.dataProvider).getOptionsChain(ticker, exp);
      } catch {
        continue;
      }
      if (chain.contracts.length > 0) {
        return { contracts: chain.contracts, dte, expiration: exp };
      }
    }
    return null;
  }

  // ─── Private: options chain helper ───────────────────────────────────────────

  private async findSuitableChain(
    ticker: string,
    minDTE: number,
    maxDTE: number,
    minDelta: number,
    maxDelta: number,
    // Try 3rd-Friday monthlies before nearer weeklies — see WHEEL_MONTHLY_FIRST_EXPIRY.
    // Default false keeps every existing caller (incl. options-income) bit-identical.
    preferMonthly = false
  ): Promise<{ contract: NonNullable<OptionsChain['contracts']>[number]; dte: number; expiration: string } | null> {
    // Generate enough Fridays to cover maxDTE (the first is up to 6 days out, hence the +2).
    const weeksNeeded = Math.ceil(maxDTE / 7) + 2;
    let expirations: string[];
    try {
      expirations = await this.getNearTermExpirations(ticker, weeksNeeded);
    } catch {
      return null;
    }
    for (const exp of wheelExpirationOrder(expirations, preferMonthly)) {
      // Check DTE BEFORE making the API call — avoids fetching chains for expirations outside
      // the target window (most generated Fridays are too near and would be wasted calls).
      const dte = dteDays(exp);
      if (!isDTEMatch(dte, minDTE, maxDTE)) continue;

      let chain: OptionsChain;
      try {
        chain = await (this.optionsProvider ?? this.dataProvider).getOptionsChain(ticker, exp);
      } catch {
        // E*Trade returns 10031 for expiry dates without listed options — skip and try next
        continue;
      }
      // For puts, delta is negative (e.g. -0.25). Use absolute value for filtering.
      // Note: bid is lastPrice (day.close) from the v3 snapshot; OI is often 0/null.
      const puts = chain.contracts.filter(
        (c) => c.side === 'put' &&
          c.delta !== null && Math.abs(c.delta) >= minDelta && Math.abs(c.delta) <= maxDelta &&
          c.bid > 0
      );
      if (puts.length > 0) {
        // Pick the one closest to ATM (delta closest to -0.25 for CSP, i.e. |delta| closest to 0.25).
        const best = puts.reduce((a, b) =>
          Math.abs(Math.abs(a.delta ?? 0) - 0.25) < Math.abs(Math.abs(b.delta ?? 0) - 0.25) ? a : b
        );
        return { contract: best, dte, expiration: exp };
      }
      // If we got contracts but none matched filters, try calls for CC
      const calls = chain.contracts.filter(
        (c) => c.side === 'call' &&
          c.delta !== null && Math.abs(c.delta) >= minDelta && Math.abs(c.delta) <= maxDelta &&
          c.bid > 0
      );
      if (calls.length > 0) {
        const best = calls.reduce((a, b) =>
          Math.abs((a.delta ?? 0) - 0.25) < Math.abs((b.delta ?? 0) - 0.25) ? a : b
        );
        return { contract: best, dte, expiration: exp };
      }
    }
    return null;
  }

  private async getNearTermExpirations(ticker: string, count = 7): Promise<string[]> {
    // Generate next `count` Fridays starting from the upcoming one (or today if Friday).
    // We look out enough weeks to cover the 30–45 DTE window.
    // Holiday Fridays (market closed) shift the expiry back to Thursday.
    const HOLIDAY_FRIDAYS = new Set([
      '2025-04-18', // Good Friday
      '2025-07-04', // Independence Day
      '2026-04-03', // Good Friday
      '2026-06-19', // Juneteenth
      '2026-12-25', // Christmas
      '2027-01-01', // New Year's Day
      '2027-03-26', // Good Friday
      '2028-04-14', // Good Friday
    ]);
    const expirations: string[] = [];
    const now = new Date();
    const day = now.getUTCDay();
    // Days until next Friday (0 = today if Friday, else days ahead)
    const daysUntilFriday = (5 - day + 7) % 7;
    const firstFriday = new Date(now);
    firstFriday.setUTCDate(now.getUTCDate() + daysUntilFriday);
    for (let w = 0; w < count; w++) {
      const d = new Date(firstFriday);
      d.setUTCDate(firstFriday.getUTCDate() + w * 7);
      let ymd = d.toISOString().slice(0, 10);
      if (HOLIDAY_FRIDAYS.has(ymd)) {
        // Shift holiday Friday back to Thursday
        d.setUTCDate(d.getUTCDate() - 1);
        ymd = d.toISOString().slice(0, 10);
      }
      expirations.push(ymd);
    }
    return expirations;
  }
}