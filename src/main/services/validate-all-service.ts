// Validate All service — deep-dive validation for every ticker in a watchlist.
// Implements FR-4.4: batch validation with progress reporting, resumable via job queue.
// see SPEC: FR-4
// see docs/formulas.md

import type { DbHandle } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import { QuoteCache, FundamentalsCache } from './cache-service.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { JobQueue } from './job-queue.js';
import { computeSMA } from './analysis-service.js';
import { computeRSI } from './analysis-service.js';
import { computeADX } from './analysis-service.js';
import { detectAllPatterns } from './pattern-detector.js';
import { findRecentDemandZone, findRecentSupplyZone, computeEntryZoneAndStop } from './support-resistance.js';
import type { ValidateDashboardResult, Bar, Zone } from '@shared/types.js';

// ─── Validate All service ────────────────────────────────────────────────────

export class ValidateAllService {
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

  cancel(): void { this.cancelled = true; }
  resetCancel(): void { this.cancelled = false; }

  /** Validate a single ticker (FR-4.5 target: <5s warm, <10s cold). */
  async validateTicker(ticker: string): Promise<ValidateDashboardResult> {
    await this.rateLimiter.acquire(1);

    // Fetch quote - required but handle failures gracefully
    let quote = { ticker, last: null as number | null, prevClose: null as number | null, volume: null as number | null, dayHigh: null as number | null, dayLow: null as number | null, ivRank: null as number | null, ivPercentile: null as number | null, distance52WkHigh: null as number | null, distance52WkLow: null as number | null, fetchedAt: new Date().toISOString() };
    try {
      quote = await this.fetchQuote(ticker);
    } catch (err) {
      console.log(`[validateTicker] ${ticker} quote fetch failed, continuing without:`, err instanceof Error ? err.message : String(err));
    }

    // Fetch fundamentals - optional, some tickers may not have data
    let fundamentals = { peRatio: null as number | null, eps: null as number | null, revenueGrowth: null as number | null, profitMargin: null as number | null, debtToEquity: null as number | null, roe: null as number | null, companyName: null as string | null };
    try {
      fundamentals = await this.fetchFundamentals(ticker);
    } catch (err) {
      console.log(`[validateTicker] ${ticker} fundamentals fetch failed, continuing without:`, err instanceof Error ? err.message : String(err));
    }

    // Fetch earnings - optional
    let earnings = { nextEarningsDate: null as string | null, epsActualLast4: [] as number[] };
    try {
      earnings = await this.dataProvider.getEarningsCalendar(ticker);
    } catch (err) {
      console.log(`[validateTicker] ${ticker} earnings fetch failed, continuing without:`, err instanceof Error ? err.message : String(err));
    }

    // Fetch historical bars - required but handle failures gracefully
    let bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
    try {
      bars = await this.dataProvider.getHistoricalBars(ticker, 'day', 252);
    } catch (err) {
      console.log(`[validateTicker] ${ticker} historical bars fetch failed, continuing without:`, err instanceof Error ? err.message : String(err));
    }

    // Fetch IV data from options - optional
    let ivData = { currentIv: null as number | null, iv52WkHigh: null as number | null, iv52WkLow: null as number | null };
    try {
      ivData = await this.dataProvider.getOptionsIV(ticker);
    } catch (err) {
      console.log(`[validateTicker] ${ticker} IV fetch failed, continuing without IV:`, err instanceof Error ? err.message : String(err));
    }

    return this.buildValidateResult(ticker, quote, fundamentals, earnings, bars, ivData);
  }

  /** Validate an entire watchlist via the job queue pipeline. */
  async validateWatchlist(
    watchlistId: number,
    tickers: string[],
    onProgress?: (current: number, total: number, ticker: string, status: string) => void
  ): Promise<ValidateDashboardResult[]> {
    this.resetCancel();
    const jobRunId = this.jobQueue.enqueue('validate_all', tickers, watchlistId, {}).id;
    this.jobQueue.markRunning(jobRunId);
    const results: ValidateDashboardResult[] = [];
    const total = tickers.length;

    for (let i = 0; i < tickers.length; i++) {
      if (this.cancelled) {
        this.jobQueue.stopRun(jobRunId);
        this.jobQueue.finalizeRun(jobRunId, 'stopped');
        break;
      }
      const ticker = tickers[i]!;
      onProgress?.(i + 1, total, ticker, 'running');
      this.jobQueue.getNextPending(jobRunId); // peek
      try {
        const result = await this.validateTicker(ticker);
        results.push(result);
        this.jobQueue.markPersisted(jobRunId, ticker);
        onProgress?.(i + 1, total, ticker, 'pass');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.jobQueue.markFailed(jobRunId, ticker, msg);
        onProgress?.(i + 1, total, ticker, 'fail');
      }
    }

    // Check if all are done.
    const stats = this.jobQueue.getRunStats(jobRunId);
    if (stats.pending === 0 && !this.cancelled) {
      this.jobQueue.finalizeRun(jobRunId, stats.failed > 0 ? 'completed' : 'completed');
    }

    return results;
  }

  /** Get status of a running job. */
  getJobStatus(jobRunId: number): { run: import('./job-queue.js').JobRunRecord | null; progress: import('./job-queue.js').JobProgressRecord[] } {
    return {
      run: this.jobQueue.getRun(jobRunId),
      progress: this.jobQueue.getProgress(jobRunId)
    };
  }

  // ─── Private: data fetch ────────────────────────────────────────────────────

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
      distance52WkHigh: snap.distance52WkHigh ?? null, distance52WkLow: snap.distance52WkLow ?? null,
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

  // ─── Private: result builder ───────────────────────────────────────────────

  private buildValidateResult(
    ticker: string,
    quote: { last: number | null; prevClose: number | null; volume: number | null; dayHigh: number | null; dayLow: number | null; ivRank: number | null; ivPercentile: number | null },
    fundamentals: { peRatio: number | null; eps: number | null; revenueGrowth: number | null; profitMargin: number | null; debtToEquity: number | null; roe: number | null },
    earnings: { nextEarningsDate: string | null; epsActualLast4: number[] },
    bars: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>,
    ivData: { currentIv: number | null; iv52WkHigh: number | null; iv52WkLow: number | null }
  ): ValidateDashboardResult {

    // Trend (SMA stack + ADX).
    const sma20Arr = computeSMA(bars, 20);
    const sma50Arr = computeSMA(bars, 50);
    const sma200Arr = computeSMA(bars, 200);
    const adxArr = computeADX(bars, 14);
    const rsiArr = computeRSI(bars, 14);

    const lastBar = bars[bars.length - 1];
    const sma20 = sma20Arr[sma20Arr.length - 1] ?? null;
    const sma50 = sma50Arr[sma50Arr.length - 1] ?? null;
    const sma200 = sma200Arr[sma200Arr.length - 1] ?? null;
    const adx = adxArr[adxArr.length - 1] ?? null;
    const rsi = rsiArr[rsiArr.length - 1] ?? null;
    const currentPrice = lastBar?.c ?? null;

    let trendLabel: 'Bullish' | 'Bearish' | 'Sideways' = 'Sideways';
    if (currentPrice !== null && sma50 !== null && sma200 !== null) {
      if (currentPrice > sma50 && sma50 > sma200) trendLabel = 'Bullish';
      else if (currentPrice < sma50 && sma50 < sma200) trendLabel = 'Bearish';
    }
    const priceVsSma50 = currentPrice !== null && sma50 !== null && sma50 > 0
      ? ((currentPrice - sma50) / sma50) * 100 : null;

    // Volume anomaly.
    const recentVolumes = bars.slice(-31).map((b) => b.v);
    const avgVol = recentVolumes.slice(0, 30).reduce((a, b) => a + b, 0) / 30;
    const todayVol = recentVolumes[recentVolumes.length - 1] ?? 0;
    const volumeAnomalyPct = avgVol > 0 ? ((todayVol - avgVol) / avgVol) * 100 : null;

    // Bollinger Bands (20-period, 2 std dev).
    const bbPeriod = 20;
    const bollingerMiddle: (number | null)[] = [];
    const bollingerUpper: (number | null)[] = [];
    const bollingerLower: (number | null)[] = [];
    for (let i = 0; i < bars.length; i++) {
      if (i < bbPeriod - 1) {
        bollingerMiddle.push(null);
        bollingerUpper.push(null);
        bollingerLower.push(null);
      } else {
        const slice = bars.slice(i - bbPeriod + 1, i + 1).map(b => b.c);
        const mid = slice.reduce((a, b) => a + b, 0) / bbPeriod;
        const std = Math.sqrt(slice.map(c => (c - mid) ** 2).reduce((a, b) => a + b, 0) / bbPeriod);
        bollingerMiddle.push(mid);
        bollingerUpper.push(mid + 2 * std);
        bollingerLower.push(mid - 2 * std);
      }
    }
    const upperBand = bollingerUpper[bollingerUpper.length - 1] ?? null;
    const lowerBand = bollingerLower[bollingerLower.length - 1] ?? null;
    const bollingerPosition = upperBand !== null && lowerBand !== null && currentPrice !== null
      ? ((currentPrice - lowerBand) / (upperBand - lowerBand)) * 100 : null;

    // MACD (12/26/9) — keep full arrays aligned with bars.
    const ema12 = this.emaSeries(bars, 12);
    const ema26 = this.emaSeries(bars, 26);
    const macd: (number | null)[] = [];
    for (let i = 0; i < bars.length; i++) {
      const e12 = ema12[i];
      const e26 = ema26[i];
      macd.push(e12 != null && e26 != null ? e12 - e26 : null);
    }
    // Signal line = EMA(9) of MACD values.
    const macdSignalArr = this.emaSeriesFromNumbersWithNulls(macd, 9);
    const macdHistogram: (number | null)[] = [];
    for (let i = 0; i < bars.length; i++) {
      const m = macd[i];
      const s = macdSignalArr[i];
      macdHistogram.push(m != null && s != null ? m - s : null);
    }
    const macdSignal = macdSignalArr[macdSignalArr.length - 1] ?? null;
    const macdValue = macd[macd.length - 1] ?? null;

    // Verdict.
    let verdict: ValidateDashboardResult['verdict'] = 'Acceptable';
    let verdictReason = '';
    const earningsDays = earnings.nextEarningsDate
      ? Math.max(0, Math.round((new Date(earnings.nextEarningsDate).getTime() - Date.now()) / 86_400_000))
      : null;

    if (earningsDays !== null && earningsDays <= 14) {
      verdict = 'Caution';
      verdictReason = `Earnings in ${earningsDays} days — binary risk. `;
    }
    if (fundamentals.peRatio !== null && fundamentals.peRatio > 40) {
      verdict = 'Avoid';
      verdictReason += 'P/E is stretched. ';
    }
    if (fundamentals.roe !== null && fundamentals.roe < 10) {
      if (verdict !== 'Avoid') verdict = 'Caution';
      verdictReason += 'Low ROE. ';
    }
    if (verdictReason === '') {
      if (trendLabel === 'Bullish' && (rsi ?? 0) < 65 && (fundamentals.roe ?? 0) >= 15) {
        verdict = 'Strong';
        verdictReason = 'Bullish trend, healthy fundamentals.';
      } else if (fundamentals.peRatio !== null && fundamentals.peRatio >= 5 && fundamentals.peRatio <= 30 && (fundamentals.eps ?? 0) > 0) {
        verdict = 'Acceptable';
        verdictReason = 'Fundamentals acceptable.';
      }
    }

    // Market opinion — analyst data not available via Polygon, use fundamentals proxy.
    const buyCount = null; const holdCount = null; const sellCount = null;
    const avgPriceTarget = null; const upsidePct = null;
    let badge: 'BUY' | 'HOLD' | 'SELL' | null = null;
    if (verdict === 'Strong') badge = 'BUY';
    else if (verdict === 'Acceptable') badge = 'HOLD';
    else if (verdict === 'Avoid') badge = 'SELL';

    // Pattern detection + supply/demand zones + entry zone.
    const patterns = detectAllPatterns(bars as Bar[], 5);
    const demandZone = findRecentDemandZone(bars as Bar[], 50);
    const supplyZone = findRecentSupplyZone(bars as Bar[], 50);
    const supportZones: Zone[] = [];
    if (demandZone) supportZones.push(demandZone);
    if (supplyZone) supportZones.push(supplyZone);
    const entryZone = computeEntryZoneAndStop(bars as Bar[], trendLabel);

    return {
      ticker,
      companyName: fundamentals.companyName,
      verdict,
      verdictReason: verdictReason.trim(),
      fundamentals: {
        peRatio: fundamentals.peRatio,
        eps: fundamentals.eps,
        revenueGrowth: fundamentals.revenueGrowth,
        profitMargin: fundamentals.profitMargin,
        debtToEquity: fundamentals.debtToEquity,
        roe: fundamentals.roe,
        nextEarningsDate: earnings.nextEarningsDate,
        daysToEarnings: earningsDays,
        epsHistory: earnings.epsActualLast4
      },
      marketOpinion: { buyCount, holdCount, sellCount, avgPriceTarget, upsidePct, badge },
      trend: {
        label: trendLabel,
        adx,
        smaStack: { sma20, sma50, sma200 },
        priceVsSma50
      },
      chart: {
        bars: bars as Bar[],
        entryZoneLow: entryZone.entryZoneLow,
        entryZoneHigh: entryZone.entryZoneHigh,
        stopLoss: entryZone.stopLoss,
        target: entryZone.target,
        supportZones,
        patterns,
        sma20: sma20Arr,
        sma50: sma50Arr,
        sma200: sma200Arr,
        bollingerUpper,
        bollingerMiddle,
        bollingerLower,
        rsi: rsiArr,
        macd,
        macdSignal: macdSignalArr,
        macdHistogram
      },
      indicators: {
        rsi,
        macdSignal,
        macdValue,
        bollingerPosition,
        volumeAnomalyPct
      },
      ivData: {
        currentIv: ivData.currentIv,
        iv52WkHigh: ivData.iv52WkHigh,
        iv52WkLow: ivData.iv52WkLow,
        ivRank: quote.ivRank,
        ivPercentile: quote.ivPercentile
      },
      fetchedAt: new Date().toISOString()
    } satisfies ValidateDashboardResult;
  }

  private emaSeries(bars: Array<{ c: number }>, period: number): (number | null)[] {
    const closes = bars.map((b) => b.c);
    const k = 2 / (period + 1);
    const result: (number | null)[] = new Array(closes.length).fill(null);
    if (closes.length < period) return result;
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period - 1; i < closes.length; i++) {
      if (i === period - 1) result[i] = ema;
      else { ema = closes[i]! * k + ema * (1 - k); result[i] = ema; }
    }
    return result;
  }

  /** EMA over a plain number array (no nulls). */
  private emaSeriesFromNumbers(values: number[], period: number): (number | null)[] {
    if (values.length < period) return new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    const result: (number | null)[] = new Array(values.length).fill(null);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[period - 1] = ema;
    for (let i = period; i < values.length; i++) {
      ema = values[i]! * k + ema * (1 - k);
      result[i] = ema;
    }
    return result;
  }

  /** EMA over an array that may contain nulls, preserving alignment. */
  private emaSeriesFromNumbersWithNulls(values: (number | null)[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let ema: number | null = null;
    let validCount = 0;

    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) {
        result[i] = null;
        continue;
      }
      validCount++;
      if (ema == null) {
        ema = v;
      } else {
        ema = v * k + ema * (1 - k);
      }
      if (validCount >= period) {
        result[i] = ema;
      }
    }
    return result;
  }
}