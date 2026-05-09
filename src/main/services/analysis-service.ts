// Analysis service — runs one of 5 analysis modes over a watchlist.
// see SPEC: FR-3, §5.3
// see docs/formulas.md for all financial formula references.

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import { QuoteCache, FundamentalsCache } from './cache-service.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { JobQueue } from './job-queue.js';
import type {
  AnalysisSnapshotRow,
  AnalysisMode,
  OptionsChain
} from '@shared/types.js';

// ─── Shared types for analysis modes ─────────────────────────────────────────

export interface Bar {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

/** Progress callback: (current, total, ticker) */
export type ProgressCallback = (current: number, total: number, ticker: string) => void;

// ─── Mode result types ────────────────────────────────────────────────────────

export interface BuyResult {
  mode: 'buy';
  ticker: string;
  lastPrice: number | null;
  compositeScore: number;       // 0–10
  trend: 'bullish' | 'bearish' | 'sideways';
  smaStack: { sma20: number | null; sma50: number | null; sma200: number | null };
  rsi: number | null;
  entryZoneLow: number | null;  // lower bound of entry zone
  entryZoneHigh: number | null; // upper bound of entry zone
  stopLoss: number | null;
  targetPrice: number | null;
  riskReward: number | null;    // reward / risk
  fundamentalsPass: boolean;
  explanation: string;
}

export interface OptionsIncomeResult {
  mode: 'options_income';
  ticker: string;
  lastPrice: number | null;
  strategy: 'CSP' | 'CC';
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  delta: number | null;
  premium: number | null;       // per-share credit received
  annualizedReturn: number | null; // annualized return on capital (%)
  ivRank: number | null;
  breakeven: number | null;
  capitalRequired: number | null; // 100 × strike
  explanation: string;
}

export interface WheelResult {
  mode: 'wheel';
  ticker: string;
  lastPrice: number | null;
  recommendedStrike: number | null;
  expiration: string | null;
  dte: number | null;
  delta: number | null;
  premium: number | null;
  annualizedReturn: number | null;
  ivRank: number | null;
  daysToEarnings: number | null;
  optionLiquidityScore: number; // 0–10
  suitabilityScore: number;     // 1–10, see docs/formulas.md#wheel-suitability-score
  explanation: string;
}

export interface StrategyResult {
  mode: 'bullish' | 'bearish';
  ticker: string;
  lastPrice: number | null;
  trendStrength: number | null; // ADX value
  suggestedStrategy: 'long_call' | 'bull_call_spread' | 'short_put' | 'long_put' | 'bear_put_spread' | 'short_call';
  structure: string;           // human-readable leg description
  maxProfit: number | null;
  maxLoss: number | null;
  breakeven: number | null;
  probabilityOfProfit: number | null; // estimated via delta
  explanation: string;
}

export type AnalysisResult =
  | BuyResult
  | OptionsIncomeResult
  | WheelResult
  | StrategyResult;

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

  // ADX = Wilder smoothed DX.
  const smoothDX = smooth(dxs, period);
  for (let i = period - 1; i < bars.length; i++) {
    const idx = i - (period - 1);
    if (smoothDX[idx] !== null && smoothDX[idx] !== undefined) result[i] = smoothDX[idx] as number;
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

// ─── Options helper functions ─────────────────────────────────────────────────

function dteDays(expiration: string): number {
  const exp = new Date(expiration + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.max(0, Math.round((exp - now) / 86_400_000));
}

function isDTEMatch(dte: number, min: number, max: number): boolean {
  return dte >= min && dte <= max;
}

function annualizedReturn(
  premium: number,
  strike: number,
  dte: number
): number | null {
  if (dte <= 0 || strike <= 0) return null;
  const annual = premium / (strike * 100) * (365 / dte) * 100;
  return annual;
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
    private readonly jobQueue: JobQueue
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

  /** Analyze a single ticker with a given mode. */
  async analyzeTicker(ticker: string, mode: AnalysisMode): Promise<AnalysisResult> {
    await this.rateLimiter.acquire(1);

    const quote = await this.fetchQuote(ticker);
    const fundamentals = await this.fetchFundamentals(ticker);
    const bars = await this.dataProvider.getHistoricalBars(ticker, 'day', 252);
    const latestBars = bars.slice(-200); // last ~200 trading days

    switch (mode) {
      case 'buy': return this.modeBuy(ticker, quote, fundamentals, latestBars);
      case 'options_income': return this.modeOptionsIncome(ticker, quote, fundamentals, latestBars);
      case 'wheel': return this.modeWheel(ticker, quote, fundamentals, latestBars);
      case 'bullish': return this.modeDirectional(ticker, quote, fundamentals, latestBars, 'bullish');
      case 'bearish': return this.modeDirectional(ticker, quote, fundamentals, latestBars, 'bearish');
    }
  }

  /** Analyze a full watchlist. */
  async analyzeWatchlist(
    watchlistId: number,
    tickers: string[],
    mode: AnalysisMode,
    onProgress?: ProgressCallback
  ): Promise<AnalysisResult[]> {
    this.resetCancel();
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
        mode: row.mode as AnalysisMode,
        runAt: row.run_at,
        resultCount: row.result_count,
        payloadJson
      };
    });
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
      mode: r.mode as AnalysisMode,
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
      mode: r.mode as AnalysisMode,
      runAt: r.run_at,
      resultCount: r.result_count,
      payloadJson: r.payload_json
    }));
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
    const entryZoneLow = swing.low;
    const entryZoneHigh = sma50 !== null ? sma50 : currentPrice;

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

    // Composite score (0–10).
    let compositeScore = 0;
    if (trend === 'bullish') compositeScore += 3;
    else if (trend === 'sideways') compositeScore += 1;
    if (rsi !== null && rsi >= 40 && rsi <= 65) compositeScore += 2;
    if (rsi !== null && rsi >= 45 && rsi <= 55) compositeScore += 1; // sweet spot
    if (fundamentals.peRatio !== null && fundamentals.peRatio >= 5 && fundamentals.peRatio <= 25) compositeScore += 1;
    if (fundamentals.profitMargin !== null && fundamentals.profitMargin >= 10) compositeScore += 1;
    if (fundamentals.roe !== null && fundamentals.roe >= 15) compositeScore += 1;
    if (fundamentals.debtToEquity !== null && fundamentals.debtToEquity < 1) compositeScore += 1;
    compositeScore = Math.min(10, compositeScore);

    // Fundamentals pass (basic screen criteria).
    const fundamentalsPass = !!(
      fundamentals.peRatio !== null && fundamentals.peRatio >= 5 && fundamentals.peRatio <= 30 &&
      (fundamentals.eps ?? 0) > 0 &&
      fundamentals.debtToEquity !== null && fundamentals.debtToEquity < 1.5
    );

    // Explanation.
    const explanation = `Price ${currentPrice !== null ? `$${currentPrice.toFixed(2)}` : '—'} above $${sma50?.toFixed(2) ?? '?'}/$${sma200?.toFixed(2) ?? '?'} SMA${trend === 'bullish' ? ' (bullish stack)' : trend === 'bearish' ? ' (bearish stack)' : ' (sideways)'}. RSI ${rsi !== null ? rsi.toFixed(1) : '—'} ${rsi !== null && rsi >= 40 && rsi <= 65 ? '✓' : '✗'} (target 40–65). Composite score ${compositeScore}/10.`;

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
    const mid = (contract.bid + contract.ask) / 2;
    const premium = mid / 2; // credit received (mid-price / 2 = conservative estimate)

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
      premium, annualizedReturn: annualizedReturn_val,
      ivRank, breakeven, capitalRequired, explanation
    };
  }

  private emptyOptionsIncome(ticker: string, price: number | null, ivRank: number | null, explanation: string): OptionsIncomeResult {
    return {
      mode: 'options_income', ticker, lastPrice: price,
      strategy: 'CSP', strike: null, expiration: null, dte: null,
      delta: null, premium: null, annualizedReturn: null,
      ivRank, breakeven: null, capitalRequired: null, explanation
    };
  }

  // ─── Mode: Wheel Strategy ───────────────────────────────────────────────────

  private async modeWheel(
    ticker: string,
    quote: { last: number | null; ivRank: number | null },
    fundamentals: { peRatio: number | null; eps: number | null; debtToEquity: number | null;
      roe: number | null; freeCashFlow: number | null },
    bars: Bar[]
  ): Promise<WheelResult> {
    const price = quote.last ?? null;
    const ivRank = quote.ivRank ?? null;

    // Stability check: price within 25% of 52-wk high, not at 52-wk low.
    if (bars.length < 252) {
      return this.emptyWheel(ticker, price, ivRank, 'Insufficient price history (need ≥252 bars).');
    }
    const high252 = Math.max(...bars.map((b) => b.h));
    const low252 = Math.min(...bars.map((b) => b.l));
    const currentPrice = bars[bars.length - 1]?.c ?? null;
    const distFromHigh = currentPrice !== null && high252 > 0
      ? ((high252 - currentPrice) / high252) * 100 : null;
    const distFromLow = currentPrice !== null && low252 > 0
      ? ((currentPrice - low252) / low252) * 100 : null;

    const stabilityPass = distFromHigh !== null && distFromHigh <= 25 && distFromLow !== null && distFromLow >= 15;

    // Earnings check.
    const earnings = await this.dataProvider.getEarningsCalendar(ticker);
    const daysToEarnings = earnings.nextEarningsDate
      ? Math.max(0, Math.round((new Date(earnings.nextEarningsDate).getTime() - Date.now()) / 86_400_000))
      : null;
    const earningsPass = daysToEarnings === null || daysToEarnings > 45;

    // IV rank check.
    const ivPass = ivRank === null || ivRank >= 30;

    // Find suitable CSP 30–45 DTE, delta 0.20–0.30.
    const chain = await this.findSuitableChain(ticker, 30, 45, 0.20, 0.30);
    let liquidityScore = 0;
    if (chain) {
      const spread = chain.contract.bid > 0
        ? ((chain.contract.ask - chain.contract.bid) / ((chain.contract.ask + chain.contract.bid) / 2)) * 100
        : 100;
      const oiPass = (chain.contract.openInterest ?? 0) >= 500;
      const spreadPass = spread <= 5;
      if (oiPass) liquidityScore += 5;
      if (spreadPass) liquidityScore += 5;
    }

    // Suitability score (1–10) — see docs/formulas.md#wheel-suitability-score
    let score = 1;
    if (ivPass) score += 2;
    if (stabilityPass) score += 2;
    if (liquidityScore >= 5) score += 2;
    if (earningsPass) score += 2;
    if (fundamentals.roe !== null && fundamentals.roe >= 15) score += 1;
    if (fundamentals.freeCashFlow !== null && fundamentals.freeCashFlow > 0) score += 1;
    score = Math.min(10, score);

    let explanation = '';
    if (!ivPass) explanation += `IV rank ${ivRank} < 30. `;
    if (!stabilityPass) explanation += 'Price not in healthy range. ';
    if (!earningsPass) explanation += `Earnings in ${daysToEarnings} days. `;
    if (liquidityScore < 5) explanation += 'Low option liquidity. ';
    if (explanation === '') explanation = 'All checks passed.';

    if (!chain || !price) {
      return this.emptyWheel(ticker, price, ivRank, explanation || 'No suitable CSP found.');
    }

    const { contract, dte } = chain;
    const mid = (contract.bid + contract.ask) / 2;
    const premium = mid / 2;
    const annual = annualizedReturn(premium, contract.strike, dte);

    return {
      mode: 'wheel', ticker, lastPrice: price,
      recommendedStrike: contract.strike,
      expiration: contract.expiration,
      dte, delta: contract.delta,
      premium, annualizedReturn: annual,
      ivRank, daysToEarnings,
      optionLiquidityScore: Math.min(10, liquidityScore),
      suitabilityScore: score,
      explanation: explanation.trim()
    };
  }

  private emptyWheel(ticker: string, price: number | null, ivRank: number | null, explanation: string): WheelResult {
    return {
      mode: 'wheel', ticker, lastPrice: price,
      recommendedStrike: null, expiration: null, dte: null,
      delta: null, premium: null, annualizedReturn: null,
      ivRank, daysToEarnings: null,
      optionLiquidityScore: 0, suitabilityScore: 1, explanation
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

    if (!isTrending || !price) {
      suggestedStrategy = mode === 'bullish' ? 'short_put' : 'short_call';
      structure = 'Wait for trend confirmation';
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
        maxProfit = null; // theoretically unlimited
        maxLoss = null; // premium paid
        breakeven = atm + 3; // approximate
        probabilityOfProfit = 0.45;
      } else {
        // Moderate: short put for income on pullback.
        suggestedStrategy = 'short_put';
        const otm = Math.round(price * 0.95 / 5) * 5;
        structure = `Sell ${otm} put (cash-secured)`;
        maxProfit = null; // premium received
        maxLoss = (otm * 100) - 0; // if put expires worthless
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
        maxProfit = null;
        maxLoss = null;
        breakeven = atm - 3;
        probabilityOfProfit = 0.45;
      } else {
        suggestedStrategy = 'short_call';
        const otm = Math.round(price * 1.05 / 5) * 5;
        structure = `Sell ${otm} call (covered or naked)`;
        maxProfit = null;
        maxLoss = null;
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

  // ─── Private: options chain helper ───────────────────────────────────────────

  private async findSuitableChain(
    ticker: string,
    minDTE: number,
    maxDTE: number,
    minDelta: number,
    maxDelta: number
  ): Promise<{ contract: NonNullable<OptionsChain['contracts']>[number]; dte: number; expiration: string } | null> {
    try {
      // Try nearest 3 expirations.
      const expirations = await this.getNearTermExpirations(ticker, 3);
      for (const exp of expirations) {
        const chain = await this.dataProvider.getOptionsChain(ticker, exp);
        const dte = dteDays(exp);
        if (!isDTEMatch(dte, minDTE, maxDTE)) continue;
        const puts = chain.contracts.filter(
          (c) => c.side === 'put' &&
            c.delta !== null && c.delta >= minDelta && c.delta <= maxDelta &&
            c.bid > 0 && c.openInterest !== null && c.openInterest >= 100
        );
        if (puts.length > 0) {
          // Pick the one closest to ATM (delta closest to 0.25 for CSP).
          const best = puts.reduce((a, b) =>
            Math.abs((a.delta ?? 0) - 0.25) < Math.abs((b.delta ?? 0) - 0.25) ? a : b
          );
          return { contract: best, dte, expiration: exp };
        }
      }
    } catch { /* no options data available */ }
    return null;
  }

  private async getNearTermExpirations(ticker: string, count = 3): Promise<string[]> {
    // Fetch the options chain for any near-term expiration to get the list.
    // For now, derive from today's date: try Fridays for next 12 weeks.
    const expirations: string[] = [];
    const now = new Date();
    for (let w = 0; expirations.length < count && w < 16; w++) {
      const d = new Date(now.getTime() + w * 7 * 86_400_000);
      const day = d.getUTCDay();
      // Find next Friday.
      const daysUntilFriday = (5 - day + 7) % 7 || 7;
      d.setUTCDate(d.getUTCDate() + daysUntilFriday);
      expirations.push(d.toISOString().slice(0, 10));
    }
    return expirations;
  }
}