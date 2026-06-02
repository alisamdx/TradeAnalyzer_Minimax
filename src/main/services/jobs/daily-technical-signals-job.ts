// Daily Technical Signals batch job.
// Reads historical_prices for all universe tickers, computes buy signal indicators
// (MACD, RSI, Bollinger, SMA, patterns, buySignalScore) and upserts to technical_signals.
// No live API calls — pure DB reads + in-process computation.
// Scheduled after price-gap-fill so bars are fresh.

import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { computeSMA, computeRSI } from '../analysis-service.js';
import { detectAllPatterns } from '../pattern-detector.js';
import { findRecentDemandZone } from '../support-resistance.js';
import type { Bar } from '@shared/types.js';
import { withTransaction, type DbHandle } from '../../db/connection.js';

// ─── EMA helpers (mirrors ValidateAllService private methods) ─────────────────

function emaSeries(closes: number[], period: number): (number | null)[] {
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

function emaFromNullable(values: (number | null)[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let ema: number | null = null;
  let validCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { result[i] = null; continue; }
    validCount++;
    ema = ema == null ? v : v * k + ema * (1 - k);
    if (validCount >= period) result[i] = ema;
  }
  return result;
}

// ─── Per-ticker signal computation ───────────────────────────────────────────

interface TechnicalResult {
  ticker: string;
  price: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi: number | null;
  macdValue: number | null;
  macdSignalLine: number | null;
  macdBullishCross: boolean;
  bollingerPosition: number | null;
  trendLabel: 'Bullish' | 'Sideways' | 'Bearish';
  buySignalScore: number;
  buySignalStrength: 'strong' | 'moderate' | 'none';
  patternNames: string[];
}

// Mirrors validate-all-service.ts buildValidateResult() buy signal logic.
// see docs/formulas.md#buy-signal-score
function computeSignals(ticker: string, bars: Bar[]): TechnicalResult | null {
  if (bars.length < 26) return null; // need at least 26 for MACD

  const currentPrice = bars[bars.length - 1]!.c;

  // SMAs
  const sma20Arr = computeSMA(bars, 20);
  const sma50Arr = computeSMA(bars, 50);
  const sma200Arr = computeSMA(bars, 200);
  const sma20 = sma20Arr[sma20Arr.length - 1] ?? null;
  const sma50 = sma50Arr[sma50Arr.length - 1] ?? null;
  const sma200 = sma200Arr[sma200Arr.length - 1] ?? null;

  // Trend label
  let trendLabel: TechnicalResult['trendLabel'] = 'Sideways';
  if (sma50 !== null && sma200 !== null) {
    if (currentPrice > sma50 && sma50 > sma200) trendLabel = 'Bullish';
    else if (currentPrice < sma50 && sma50 < sma200) trendLabel = 'Bearish';
  }

  // RSI
  const rsiArr = computeRSI(bars, 14);
  const rsi = rsiArr[rsiArr.length - 1] ?? null;

  // Bollinger Bands (20-period, 2 std dev)
  const bbPeriod = 20;
  let bollingerPosition: number | null = null;
  if (bars.length >= bbPeriod) {
    const slice = bars.slice(-bbPeriod).map(b => b.c);
    const mid = slice.reduce((a, b) => a + b, 0) / bbPeriod;
    const std = Math.sqrt(slice.map(c => (c - mid) ** 2).reduce((a, b) => a + b, 0) / bbPeriod);
    const upper = mid + 2 * std;
    const lower = mid - 2 * std;
    if (upper !== lower) {
      bollingerPosition = ((currentPrice - lower) / (upper - lower)) * 100;
    }
  }

  // MACD (12/26/9)
  const closes = bars.map(b => b.c);
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macd: (number | null)[] = ema12.map((e12, i) => {
    const e26 = ema26[i];
    return e12 != null && e26 != null ? e12 - e26 : null;
  });
  const macdSignalArr = emaFromNullable(macd, 9);
  const macdValue = macd[macd.length - 1] ?? null;
  const macdSignalLine = macdSignalArr[macdSignalArr.length - 1] ?? null;

  // MACD bullish crossover in last 5 bars
  let macdBullishCross = false;
  for (let i = Math.max(1, macd.length - 5); i < macd.length; i++) {
    const pm = macd[i - 1]; const ps = macdSignalArr[i - 1];
    const cm = macd[i];     const cs = macdSignalArr[i];
    if (pm != null && ps != null && cm != null && cs != null && pm < ps && cm > cs) {
      macdBullishCross = true; break;
    }
  }

  // Patterns + demand zone
  const patterns = detectAllPatterns(bars, 5);
  const demandZone = findRecentDemandZone(bars, 50);

  // ── Buy signal scoring (mirrors validate-all-service.ts §343–435) ───────────
  // see docs/formulas.md#buy-signal-score
  let buyScore = 0;

  // 1. MACD bullish crossover (20 pts)
  if (macdBullishCross) buyScore += 20;

  // 2. MACD above zero (10 pts, only if no crossover)
  if (!macdBullishCross && macdValue !== null && macdValue > 0) buyScore += 10;

  // 3. RSI zone (up to 20 pts)
  if (rsi !== null) {
    const recentRsi = rsiArr.slice(-11).filter((v): v is number => v != null);
    const wasOversold = recentRsi.slice(0, -1).some(v => v < 30);
    if (wasOversold && rsi > 30 && rsi < 65) {
      buyScore += 20;
    } else if (rsi >= 35 && rsi <= 65) {
      buyScore += 10;
    }
  }

  // 4. Bollinger Band position (up to 15 pts)
  if (bollingerPosition !== null) {
    if (bollingerPosition < 15) buyScore += 15;
    else if (bollingerPosition < 30) buyScore += 8;
  }

  // 5. Bullish candlestick pattern (up to 20 pts)
  const strongBullish = new Set(['morning_star', 'three_white_soldiers', 'bullish_engulfing']);
  const moderateBullish = new Set(['hammer', 'dragonfly_doji', 'piercing_line', 'inverted_hammer']);
  const recentBullishPattern = patterns.find(p => p.direction === 'bullish');
  const bullishPatternNames = patterns.filter(p => p.direction === 'bullish').map(p => p.name);
  if (recentBullishPattern) {
    if (strongBullish.has(recentBullishPattern.name)) buyScore += 20;
    else if (moderateBullish.has(recentBullishPattern.name)) buyScore += 12;
    else buyScore += 6;
  }

  // 6. Price near demand zone (up to 15 pts)
  if (currentPrice > 0 && demandZone !== null) {
    const distPct = Math.abs(currentPrice - demandZone.price) / demandZone.price * 100;
    if (distPct <= 2) buyScore += 15;
    else if (distPct <= 5) buyScore += 8;
  }

  // 7. Trend alignment (up to 15 pts)
  if (trendLabel === 'Bullish') buyScore += 15;
  else if (trendLabel === 'Sideways') buyScore += 5;

  // 8. Bullish SMA structure (10 pts)
  if (trendLabel !== 'Bullish' && sma50 !== null && sma200 !== null && sma50 > sma200) buyScore += 10;

  // 9. Testing SMA50 support (8 pts)
  if (sma50 !== null && sma200 !== null && sma50 > sma200 &&
      currentPrice < sma50 && (sma50 - currentPrice) / sma50 <= 0.05) {
    buyScore += 8;
  }

  buyScore = Math.min(100, buyScore);
  const buySignalStrength: TechnicalResult['buySignalStrength'] =
    buyScore >= 50 ? 'strong' : buyScore >= 25 ? 'moderate' : 'none';

  return {
    ticker,
    price: currentPrice,
    sma20,
    sma50,
    sma200,
    rsi,
    macdValue,
    macdSignalLine,
    macdBullishCross,
    bollingerPosition,
    trendLabel,
    buySignalScore: buyScore,
    buySignalStrength,
    patternNames: bullishPatternNames,
  };
}

// ─── Job ─────────────────────────────────────────────────────────────────────

export class DailyTechnicalSignalsJob implements BatchJobHandler {
  readonly name = 'Daily Technical Signals';
  readonly description = 'Compute MACD, RSI, Bollinger, buy signal score for all universe tickers from cached price bars.';

  constructor(private readonly db: DbHandle) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const emit = (attempted: number, updated: number, total: number, message?: string) => {
      onProgress({
        jobId: 'daily-technical-signals',
        runId: 0,
        ticker: '',
        status: 'updated',
        attempted,
        updated,
        skipped: attempted - updated,
        failed: 0,
        total,
        message,
      });
    };

    emit(0, 0, 0, 'Loading tickers…');

    type TickerRow = { ticker: string; bar_count: number };
    const tickerRows = this.db.prepare(`
      SELECT ticker, COUNT(*) AS bar_count
      FROM historical_prices
      GROUP BY ticker
      HAVING bar_count >= 26
      ORDER BY ticker
    `).all() as TickerRow[];

    if (tickerRows.length === 0) {
      return { status: 'skipped', notes: 'No tickers with sufficient price history (≥26 bars)', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 };
    }

    const tickers = tickerRows.map(r => r.ticker);
    const total = tickers.length;
    let processed = 0;
    let written = 0;

    const upsertStmt = this.db.prepare(`
      INSERT INTO technical_signals
        (ticker, computed_at, price, sma20, sma50, sma200, rsi,
         macd_value, macd_signal_line, macd_bullish_cross,
         bollinger_position, trend_label,
         buy_signal_score, buy_signal_strength, pattern_names)
      VALUES
        (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?,
         ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        computed_at         = excluded.computed_at,
        price               = excluded.price,
        sma20               = excluded.sma20,
        sma50               = excluded.sma50,
        sma200              = excluded.sma200,
        rsi                 = excluded.rsi,
        macd_value          = excluded.macd_value,
        macd_signal_line    = excluded.macd_signal_line,
        macd_bullish_cross  = excluded.macd_bullish_cross,
        bollinger_position  = excluded.bollinger_position,
        trend_label         = excluded.trend_label,
        buy_signal_score    = excluded.buy_signal_score,
        buy_signal_strength = excluded.buy_signal_strength,
        pattern_names       = excluded.pattern_names
    `);

    const BATCH = 100;
    for (let i = 0; i < tickers.length; i += BATCH) {
      const chunk = tickers.slice(i, i + BATCH);
      const ph = chunk.map(() => '?').join(',');

      type BarRow = { ticker: string; date: string; open: number; high: number; low: number; close: number; volume: number };
      const barRows = this.db.prepare(`
        SELECT ticker, date, open, high, low, close, volume
        FROM historical_prices
        WHERE ticker IN (${ph})
        ORDER BY ticker, date ASC
      `).all(...chunk) as BarRow[];

      const barsByTicker = new Map<string, Bar[]>();
      for (const r of barRows) {
        if (!barsByTicker.has(r.ticker)) barsByTicker.set(r.ticker, []);
        barsByTicker.get(r.ticker)!.push({
          t: new Date(r.date).getTime(),
          o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume,
        });
      }

      withTransaction(this.db, () => {
        for (const ticker of chunk) {
          const bars = barsByTicker.get(ticker);
          processed++;
          if (!bars || bars.length < 26) continue;

          const result = computeSignals(ticker, bars);
          if (!result) continue;

          upsertStmt.run(
            result.ticker,
            result.price,
            result.sma20,
            result.sma50,
            result.sma200,
            result.rsi,
            result.macdValue,
            result.macdSignalLine,
            result.macdBullishCross ? 1 : 0,
            result.bollingerPosition,
            result.trendLabel,
            result.buySignalScore,
            result.buySignalStrength,
            JSON.stringify(result.patternNames),
          );
          written++;
        }
      });

      if (i % (BATCH * 5) === 0 || i + BATCH >= tickers.length) {
        emit(processed, written, total);
      }
    }

    return {
      status: 'success',
      notes: `${written} / ${total} tickers computed`,
      tickersAttempted: processed,
      tickersUpdated: written,
      tickersSkipped: processed - written,
      tickersFailed: 0,
    };
  }
}
