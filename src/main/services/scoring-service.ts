// Trade Scoring Engine — configurable per-strategy composite scorer.
// Reads only from local DB (no live API calls). Config lives in scoring_strategy_configs.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4

import type { Database } from 'better-sqlite3';
import type { ScreenResultPayload, SignalWeightSuggestion, ScoringStrategy as ScoringStrategyType } from '@shared/types.js';
import type { BuyResult, WheelResult, StrategyResult, OptionsIncomeResult } from './analysis-service.js';

// ─── Sector ETF mapping ───────────────────────────────────────────────────────
// GICS sector name (as stored in ScreenResultPayload.sector) → SPDR sector ETF ticker.
// Used by loadSectorMomentum() to assign sector 90-day return to each scored ticker.
// see docs/formulas.md#sector-momentum

const SECTOR_ETF: Record<string, string> = {
  'Technology':             'XLK',
  'Financials':             'XLF',
  'Health Care':            'XLV',
  'Energy':                 'XLE',
  'Industrials':            'XLI',
  'Consumer Staples':       'XLP',
  'Consumer Discretionary': 'XLY',
  'Materials':              'XLB',
  'Real Estate':            'XLRE',
  'Utilities':              'XLU',
  'Communication Services': 'XLC',
};

// ─── Public types ─────────────────────────────────────────────────────────────

export type ScoringStrategy = 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy';

export interface ScoringSignal {
  key: string;
  label: string;
  weight: number;
  enabled: boolean;
  description: string;
  dataSource: string;
  direction: 'higher_better' | 'lower_better' | 'target_range';
  targetMin?: number;
  targetMax?: number;
  /** Expected max value for higher_better / lower_better normalization. */
  normMax?: number;
}

export interface SignalBreakdown {
  raw: number | null;
  normalized: number;
  weight: number;
  missing: boolean;
}

export interface ScoredTicker {
  ticker: string;
  compositeScore: number;
  signals: Record<string, SignalBreakdown>;
}

export interface ScoringConfig {
  strategy: ScoringStrategy;
  signals: ScoringSignal[];
  version: string;
  updatedAt: string;
}

// ─── Baseline configs ─────────────────────────────────────────────────────────
// Expert-backed starting weights. Sources: tastytrade (Tom Sosnoff),
// IBD CANSLIM (O'Neil), McMillan's Options as a Strategic Investment, Zacks.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4.5

// Weights sum = 100. Includes recentVolatility (v0.23.1) — high 20d vol = bad for CSP selling.
const BASELINE_WHEEL: ScoringSignal[] = [
  {
    key: 'ivRank', label: 'IV Rank (30-day)', weight: 25, enabled: true,
    description: 'tastytrade rule #1: IVR < 30 = don\'t sell. Higher IVR = more edge in premium.',
    dataSource: 'iv_history.atm_iv → IvHistoryService.getIvRank()',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'premiumYield', label: 'Premium Yield (annualized)', weight: 21, enabled: true,
    description: 'Premium / strike × (365 / DTE). You\'re a yield business — this is your return.',
    dataSource: 'analysis_snapshots wheel.annualizedReturn',
    direction: 'higher_better', normMax: 60,
  },
  {
    key: 'fundamentalScore', label: 'Fundamental Quality', weight: 18, enabled: true,
    description: 'Wheel requires owning the stock — never sell a CSP on a stock you wouldn\'t hold.',
    dataSource: 'screen_results.payload_json → scoreFundamentals()',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'technicalNeutral', label: 'Technical Neutral (RSI 40–60)', weight: 13, enabled: true,
    description: 'Don\'t sell puts into a downtrend; neutral trend = safer assignment zone.',
    dataSource: 'analysis_snapshots buy.rsi',
    direction: 'target_range', targetMin: 40, targetMax: 60,
  },
  {
    key: 'recentVolatility', label: 'Recent Volatility (20-day realized vol)', weight: 10, enabled: true,
    description: 'Stocks making large recent moves carry higher assignment risk. 20-day annualized realized vol — lower is better for CSP selling.',
    dataSource: 'historical_prices 20-day log-return std dev × √252 × 100',
    direction: 'lower_better', normMax: 60,
  },
  {
    key: 'optionLiquidity', label: 'Option Liquidity', weight: 9, enabled: true,
    description: 'Wide bid-ask spreads kill theoretical edge; OI + spread composite.',
    dataSource: 'analysis_snapshots wheel.optionLiquidityScore (0–10)',
    direction: 'higher_better', normMax: 10,
  },
  {
    key: 'leverageQuality', label: 'Leverage Quality (ND/EBITDA)', weight: 4, enabled: true,
    description: 'CSP assignment risk: highly leveraged companies can spiral on bad news. ND/EBITDA < 3 = safer stock to hold.',
    dataSource: 'screen_results.payload_json netDebtToEbitda',
    direction: 'lower_better', normMax: 5,
  },
]; // sum = 100

// Weights sum = 100. All signals trimmed proportionally to fit 8 signals.
const BASELINE_BULLISH: ScoringSignal[] = [
  {
    key: 'trendStrength', label: 'Price Trend (above 50MA + 200MA, ADX > 20)', weight: 24, enabled: true,
    description: 'Institutional consensus — big money is already positioned long.',
    dataSource: 'analysis_snapshots buy.smaStack + bullish.trendStrength (ADX)',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'earningsGrowth', label: 'Earnings / Revenue Growth Quality', weight: 20, enabled: true,
    description: 'CANSLIM: EPS + sales growth are the primary fundamental trigger for institutional buying.',
    dataSource: 'screen_results.payload_json epsGrowth + revenueGrowth',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'rsiMomentum', label: 'RSI Momentum (45–70 zone)', weight: 15, enabled: true,
    description: 'Want momentum without being overextended. Below 45 = lagging; above 70 = chasing.',
    dataSource: 'analysis_snapshots buy.rsi',
    direction: 'target_range', targetMin: 45, targetMax: 70,
  },
  {
    key: 'buySignalScore', label: 'Buy Signal Score (technical composite)', weight: 12, enabled: true,
    description: 'Composite of MACD, RSI zone, Bollinger, patterns, demand zone, trend alignment — nightly computed from historical_prices.',
    dataSource: 'technical_signals.buy_signal_score (0–100)',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'relativeStrength', label: 'Relative Performance vs SPY (90-day)', weight: 12, enabled: true,
    description: 'Leaders lead — if it\'s lagging SPY in an up move, it\'s weak. Excess 90-day return vs S&P 500.',
    dataSource: 'historical_prices SPY vs ticker 90-day return (ticker_90d − spy_90d)',
    direction: 'higher_better', normMax: 50,
  },
  {
    key: 'priceMomentumPct', label: 'Price Momentum % (52-week return)', weight: 7, enabled: true,
    description: 'Confirms sustained directional move, not just a 1-day spike.',
    dataSource: 'historical_prices (currentPrice - price_52w_ago) / price_52w_ago × 100',
    direction: 'higher_better', normMax: 150,
  },
  {
    key: 'sectorMomentum', label: 'Sector Momentum (SPDR ETF 90-day return)', weight: 5, enabled: true,
    description: 'Rising sector = institutional tailwind. Uses SPDR sector ETF (XLK, XLF, etc.) mapped from screener sector tag.',
    dataSource: 'historical_prices SECTOR_ETF 90-day return',
    direction: 'higher_better', normMax: 30,
  },
  {
    key: 'revenueGrowth5Y', label: '5-Year Revenue CAGR', weight: 5, enabled: true,
    description: 'CANSLIM: sustained multi-year revenue growth distinguishes compounders from one-hit wonders.',
    dataSource: 'screen_results.payload_json revenueGrowth5Y',
    direction: 'higher_better', normMax: 30,
  },
]; // sum = 100

// Weights sum = 100. All signals trimmed proportionally to fit 7 signals.
const BASELINE_BEARISH: ScoringSignal[] = [
  {
    key: 'downtrendScore', label: 'Downtrend Confirmation (below 50MA + 200MA)', weight: 26, enabled: true,
    description: 'Don\'t fight institutional selling — wait for MA confirmation.',
    dataSource: 'analysis_snapshots buy.smaStack + bearish.trendStrength (ADX)',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'fundamentalWeakness', label: 'Fundamental Deterioration', weight: 22, enabled: true,
    description: 'Earnings-driven declines are sustained; pure technical breakdowns often reverse.',
    dataSource: 'screen_results.payload_json → inverted scoreFundamentals()',
    direction: 'lower_better', normMax: 100,
  },
  {
    key: 'rsiOverbought', label: 'RSI Overbought / Rolling Over (60–80 zone)', weight: 17, enabled: true,
    description: 'Overextended but not yet collapsed = best short entry window.',
    dataSource: 'analysis_snapshots buy.rsi',
    direction: 'target_range', targetMin: 60, targetMax: 80,
  },
  {
    key: 'relativeWeakness', label: 'Relative Weakness vs SPY (90-day)', weight: 13, enabled: true,
    description: 'Weakest stocks in a weak market fall hardest. Underperforming SPY confirms bearish thesis.',
    dataSource: 'historical_prices SPY vs ticker 90-day return (ticker_90d − spy_90d, lower = more underperformance)',
    direction: 'lower_better', normMax: 100,
  },
  {
    key: 'priceDecayPct', label: 'Price Decay % (negative 52-week return)', weight: 9, enabled: true,
    description: 'Confirms sustained downtrend, not a brief pullback.',
    dataSource: 'historical_prices (currentPrice - price_52w_ago) / price_52w_ago × 100 (inverted)',
    direction: 'lower_better', normMax: 150,
  },
  {
    key: 'sectorWeakness', label: 'Sector Weakness (SPDR ETF 90-day, inverted)', weight: 7, enabled: true,
    description: 'Declining sector = institutional headwind confirming short thesis. Higher score = sector down more.',
    dataSource: 'historical_prices SECTOR_ETF 90-day return (inverted)',
    direction: 'higher_better', normMax: 20,
  },
  {
    key: 'leverageRisk', label: 'Leverage Risk (ND/EBITDA)', weight: 6, enabled: true,
    description: 'High leverage amplifies drawdowns — overleveraged companies fall hardest in downturns. ND/EBITDA > 5 = elevated risk.',
    dataSource: 'screen_results.payload_json netDebtToEbitda (higher = more risk = stronger bearish signal)',
    direction: 'higher_better', normMax: 8,
  },
]; // sum = 100

// Includes recentVolatility (v0.23.1) — the primary screen for income: is the stock actually range-bound?
// ADX (trendNeutral) catches directional trend; recentVolatility catches realized choppiness/momentum.
const BASELINE_INCOME: ScoringSignal[] = [
  {
    key: 'ivRank', label: 'IV Rank (30-day)', weight: 30, enabled: true,
    description: 'Higher weight than Wheel: no ownership backstop — IV edge is the entire thesis.',
    dataSource: 'iv_history.atm_iv → IvHistoryService.getIvRank()',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'premiumRiskRatio', label: 'Premium / Max Risk Ratio', weight: 22, enabled: true,
    description: 'tastytrade: credit ≥ 1/3 of spread width. Below that, not worth the risk.',
    dataSource: 'analysis_snapshots options_income.annualizedReturn',
    direction: 'higher_better', normMax: 60,
  },
  {
    key: 'recentVolatility', label: 'Recent Volatility (20-day realized vol)', weight: 20, enabled: true,
    description: 'Stock making large recent moves = strangle at risk on day 1. 20-day annualized realized vol — lower is better. Catches earnings runners, gap stocks, and trending names that ADX may miss.',
    dataSource: 'historical_prices 20-day log-return std dev × √252 × 100',
    direction: 'lower_better', normMax: 60,
  },
  {
    key: 'trendNeutral', label: 'Underlying Trend Neutrality (range-bound)', weight: 15, enabled: true,
    description: 'Short strangles need the stock to stay in a range; strong trends kill this trade.',
    dataSource: 'analysis_snapshots bullish/bearish.trendStrength (ADX < 20 = range-bound)',
    direction: 'lower_better', normMax: 60,
  },
  {
    key: 'optionLiquidity', label: 'Option Liquidity (OI, volume, tight spreads)', weight: 13, enabled: true,
    description: 'Multi-leg structures: slippage compounds. Liquidity is non-negotiable.',
    dataSource: 'analysis_snapshots wheel.optionLiquidityScore (0–10)',
    direction: 'higher_better', normMax: 10,
  },
]; // sum = 100

// Weights sum = 100. All signals trimmed proportionally to fit 8 signals.
const BASELINE_BUY: ScoringSignal[] = [
  {
    key: 'priceMomentumPct', label: 'Price Momentum % (52-week return)', weight: 24, enabled: true,
    description: 'Momentum is the strongest documented return factor (Jegadeesh-Titman 1993).',
    dataSource: 'historical_prices (currentPrice - price_52w_ago) / price_52w_ago × 100',
    direction: 'higher_better', normMax: 150,
  },
  {
    key: 'earningsGrowth', label: 'Earnings Quality (EPS consistency + growth)', weight: 18, enabled: true,
    description: 'Fundamental anchor — momentum without earnings support is speculation.',
    dataSource: 'screen_results.payload_json epsGrowth + revenueGrowth',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'breakoutScore', label: 'Breakout Quality Score', weight: 14, enabled: true,
    description: 'Entry timing: price near support, volume anomaly, MA alignment = defined risk entry.',
    dataSource: 'analysis_snapshots buy.smaStack + entryZoneLow + lastPrice',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'buySignalScore', label: 'Buy Signal Score (technical composite)', weight: 14, enabled: true,
    description: 'Composite of MACD crossover, RSI zone, Bollinger position, patterns, trend, demand zone — from DailyTechnicalSignalsJob.',
    dataSource: 'technical_signals.buy_signal_score (0–100)',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'relativeStrength', label: 'Relative Performance vs SPY (90-day)', weight: 14, enabled: true,
    description: 'Confirms the stock is leading, not lagging — buy leaders. Excess 90-day return vs S&P 500.',
    dataSource: 'historical_prices SPY vs ticker 90-day return (ticker_90d − spy_90d)',
    direction: 'higher_better', normMax: 50,
  },
  {
    key: 'revenueGrowth5Y', label: '5-Year Revenue CAGR', weight: 7, enabled: true,
    description: 'Long-term compounders outperform — filters out cyclical YoY spikes. Sustained growth attracts institutional buying.',
    dataSource: 'screen_results.payload_json revenueGrowth5Y',
    direction: 'higher_better', normMax: 30,
  },
  {
    key: 'sectorMomentum', label: 'Sector Momentum (SPDR ETF 90-day return)', weight: 6, enabled: true,
    description: 'Rising sector confirms trade direction — buy stocks in rising sectors.',
    dataSource: 'historical_prices SECTOR_ETF 90-day return',
    direction: 'higher_better', normMax: 30,
  },
  {
    key: 'epsGrowth5Y', label: '5-Year EPS CAGR', weight: 3, enabled: true,
    description: 'Sustained earnings growth is the primary driver of long-term stock returns (Novy-Marx 2013).',
    dataSource: 'screen_results.payload_json epsGrowth5Y',
    direction: 'higher_better', normMax: 40,
  },
]; // sum = 100

export const BASELINE_CONFIGS: Record<ScoringStrategy, ScoringSignal[]> = {
  wheel:   BASELINE_WHEEL,
  bullish: BASELINE_BULLISH,
  bearish: BASELINE_BEARISH,
  income:  BASELINE_INCOME,
  buy:     BASELINE_BUY,
};

export const STRATEGIES: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy'];

// ─── Normalization helpers ────────────────────────────────────────────────────
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4.6

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeSignal(raw: number, signal: ScoringSignal): number {
  const max = signal.normMax ?? 100;
  if (signal.direction === 'higher_better') {
    return clamp((raw / max) * 100);
  }
  if (signal.direction === 'lower_better') {
    return clamp((1 - raw / max) * 100);
  }
  // target_range: 100 at center, linear decay to 0 at boundaries
  const lo = signal.targetMin ?? 0;
  const hi = signal.targetMax ?? 100;
  if (raw < lo) {
    const halfWidth = hi - lo;
    return clamp(100 - ((lo - raw) / halfWidth) * 100);
  }
  if (raw > hi) {
    const halfWidth = hi - lo;
    return clamp(100 - ((raw - hi) / halfWidth) * 100);
  }
  return 100;
}

// ─── Gathered signal data per ticker ─────────────────────────────────────────

interface TickerSignalData {
  ticker: string;
  // IV
  ivRank: number | null;
  // Fundamentals
  fundamentalScore: number | null;
  epsGrowth: number | null;
  revenueGrowth: number | null;
  // Analysis snapshots
  rsi: number | null;
  trendStrengthAdx: number | null;
  trendLabel: 'bullish' | 'bearish' | 'sideways' | null;
  smaStack: { sma20: number | null; sma50: number | null; sma200: number | null } | null;
  lastPrice: number | null;
  annualizedReturn: number | null;    // wheel / income
  optionLiquidityScore: number | null;
  suitabilityScore: number | null;
  entryZoneLow: number | null;        // buy result — used for breakout
  snapshotAgeHours: number | null;
  // Computed
  priceMomentumPct: number | null;
  /** Excess 90-day return vs SPY: ticker_90d_return − spy_90d_return (percentage points). */
  relativeStrengthVsSpy: number | null;
  /** 90-day return of the ticker's SPDR sector ETF (XLK, XLF, etc.). */
  sectorMomentumPct: number | null;
  // 20-day annualized realized volatility (std dev of daily log returns × √252 × 100)
  recentVolatility: number | null;
  // From technical_signals (DailyTechnicalSignalsJob)
  buySignalScore: number | null;
  // Quality signals (v0.22.21) — from screen_results.payload_json
  fcfToNetIncome: number | null;
  roic: number | null;
  netDebtToEbitda: number | null;
  revenueGrowth5Y: number | null;
  epsGrowth5Y: number | null;
  stockGrade: number | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ScoringService {
  constructor(private readonly db: Database) {}

  // ── Config management ─────────────────────────────────────────────────────

  seedBaselines(): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO scoring_strategy_configs (strategy, signals, version, updated_at)
      VALUES (?, ?, 'baseline_v2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);
    for (const [strategy, signals] of Object.entries(BASELINE_CONFIGS)) {
      stmt.run(strategy, JSON.stringify(signals));
    }
  }

  getConfig(strategy: ScoringStrategy): ScoringConfig {
    type Row = { strategy: string; signals: string; version: string; updated_at: string };
    const row = this.db.prepare(
      'SELECT strategy, signals, version, updated_at FROM scoring_strategy_configs WHERE strategy = ?'
    ).get(strategy) as Row | undefined;

    if (!row) {
      // Fallback to baseline if not seeded yet
      return {
        strategy,
        signals: BASELINE_CONFIGS[strategy],
        version: 'baseline_v2',
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      strategy: row.strategy as ScoringStrategy,
      signals: JSON.parse(row.signals) as ScoringSignal[],
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  getAllConfigs(): ScoringConfig[] {
    return STRATEGIES.map(s => this.getConfig(s));
  }

  updateConfig(strategy: ScoringStrategy, signals: ScoringSignal[], version: string): void {
    this.db.prepare(`
      INSERT INTO scoring_strategy_configs (strategy, signals, version, updated_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(strategy) DO UPDATE SET
        signals = excluded.signals,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(strategy, JSON.stringify(signals), version);
  }

  resetToBaseline(strategy: ScoringStrategy): void {
    this.db.prepare(`
      UPDATE scoring_strategy_configs
      SET signals = ?, version = 'baseline_v1', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE strategy = ?
    `).run(JSON.stringify(BASELINE_CONFIGS[strategy]), strategy);
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /** Score a batch of tickers for a single strategy. Returns all tickers sorted by score desc. */
  scoreTickers(tickers: string[], strategy: ScoringStrategy): ScoredTicker[] {
    if (tickers.length === 0) return [];

    const config = this.getConfig(strategy);
    const enabledSignals = config.signals.filter(s => s.enabled);

    // Gather all signal data in batched DB queries
    const signalData = this.gatherSignalData(tickers);

    return tickers
      .map(ticker => this.scoreTicker(ticker, signalData.get(ticker) ?? null, enabledSignals, config.signals))
      .sort((a, b) => b.compositeScore - a.compositeScore);
  }

  private scoreTicker(
    ticker: string,
    data: TickerSignalData | null,
    enabledSignals: ScoringSignal[],
    allSignals: ScoringSignal[],
  ): ScoredTicker {
    const signals: Record<string, SignalBreakdown> = {};

    // Initialize all signals
    for (const sig of allSignals) {
      signals[sig.key] = { raw: null, normalized: 0, weight: sig.weight, missing: true };
    }

    if (!data) {
      return { ticker, compositeScore: 0, signals };
    }

    let weightedSum = 0;
    let totalWeight = 0;

    for (const sig of enabledSignals) {
      const raw = this.extractSignalRaw(sig.key, data);
      const missing = raw === null;
      const normalized = raw !== null ? normalizeSignal(raw, sig) : 0;

      signals[sig.key] = { raw, normalized, weight: sig.weight, missing };

      // FR-SE-03: missing signal contributes 0 to composite
      if (!missing) {
        weightedSum += normalized * sig.weight;
      }
      totalWeight += sig.weight;
    }

    const compositeScore = totalWeight > 0
      ? Math.round((weightedSum / totalWeight) * 10) / 10
      : 0;

    return { ticker, compositeScore, signals };
  }

  private extractSignalRaw(key: string, d: TickerSignalData): number | null {
    switch (key) {
      case 'ivRank':
        return d.ivRank;

      case 'premiumYield':
      case 'premiumRiskRatio':
        return d.annualizedReturn;

      case 'fundamentalScore':
        return d.fundamentalScore;

      case 'fundamentalWeakness':
        return d.fundamentalScore;  // direction=lower_better handles the inversion

      case 'technicalNeutral':
        return d.rsi;

      case 'optionLiquidity':
        return d.optionLiquidityScore !== null
          ? d.optionLiquidityScore  // already 0–10
          : null;

      case 'trendStrength':
        return this.computeTrendStrengthScore(d);

      case 'downtrendScore':
        return this.computeDowntrendScore(d);

      case 'trendNeutral':
        return d.trendStrengthAdx;  // direction=lower_better: low ADX = range-bound = good

      case 'earningsGrowth':
        return this.computeEarningsGrowthScore(d);

      case 'rsiMomentum':
        return d.rsi;

      case 'rsiOverbought':
        return d.rsi;

      case 'priceMomentumPct':
        return d.priceMomentumPct;

      case 'priceDecayPct':
        return d.priceMomentumPct;  // direction=lower_better: negative momentum = good for bears

      case 'breakoutScore':
        return this.computeBreakoutScore(d);

      case 'buySignalScore':
        return d.buySignalScore;

      case 'relativeStrength':
        // Excess 90-day return vs SPY. direction=higher_better, normMax=50.
        // +50pp outperformance = score 100; underperformers clamp to 0.
        // see docs/formulas.md#relative-strength
        return d.relativeStrengthVsSpy;

      case 'relativeWeakness':
        // Same underlying data; direction=lower_better, normMax=100 inverts it.
        // Underperforming SPY by 30pp → raw=-30 → score=(1-(-30)/100)*100=130→100.
        // see docs/formulas.md#relative-strength
        return d.relativeStrengthVsSpy;

      case 'sectorMomentum':
        // Sector ETF 90-day return. direction=higher_better, normMax=30.
        // Sector up 30% = max score; flat/down = low score for bullish strategies.
        // see docs/formulas.md#sector-momentum
        return d.sectorMomentumPct;

      case 'sectorWeakness':
        // Inverted sector momentum for bearish strategies. direction=higher_better, normMax=20.
        // Sector down 20% → raw=+20 → score=(20/20)*100=100.
        // see docs/formulas.md#sector-momentum
        return d.sectorMomentumPct !== null ? -d.sectorMomentumPct : null;

      case 'recentVolatility':
        // 20-day annualized realized vol (%). lower_better: high vol = bad for income/wheel.
        // see docs/formulas.md#recent-volatility
        return d.recentVolatility;

      // Quality signals (v0.22.21)
      case 'leverageQuality':
        // Wheel: direction=lower_better, normMax=5.
        // ND/EBITDA=1 → score=(1-1/5)*100=80. ND/EBITDA=5 → score=0. Net cash (<0) → clamped 100.
        return d.netDebtToEbitda;

      case 'leverageRisk':
        // Bearish: direction=higher_better, normMax=8.
        // ND/EBITDA=5 → score=(5/8)*100=62.5. Net cash → clamped 0.
        return d.netDebtToEbitda;

      case 'revenueGrowth5Y':
        return d.revenueGrowth5Y;

      case 'epsGrowth5Y':
        return d.epsGrowth5Y;

      default:
        return null;
    }
  }

  // Bullish trend strength: composite of ADX + MA stack (0–100)
  // see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4.5.2
  private computeTrendStrengthScore(d: TickerSignalData): number | null {
    let components = 0;
    let score = 0;

    // ADX component (0–50 range → 0–50 score)
    if (d.trendStrengthAdx !== null) {
      score += clamp((d.trendStrengthAdx / 50) * 50, 0, 50);
      components++;
    }

    // MA stack component: price > sma50 > sma200 → up to 50 points
    if (d.smaStack && d.lastPrice !== null) {
      const { sma20: _sma20, sma50, sma200 } = d.smaStack;
      const price = d.lastPrice;
      let maScore = 0;
      if (sma50 !== null && price > sma50) maScore += 25;
      if (sma200 !== null && price > sma200) maScore += 25;
      score += maScore;
      components++;
    }

    return components > 0 ? clamp(score) : null;
  }

  // Bearish downtrend score: composite of ADX + below-MA confirmation (0–100)
  private computeDowntrendScore(d: TickerSignalData): number | null {
    let components = 0;
    let score = 0;

    if (d.trendStrengthAdx !== null) {
      score += clamp((d.trendStrengthAdx / 50) * 50, 0, 50);
      components++;
    }

    if (d.smaStack && d.lastPrice !== null) {
      const { sma50, sma200 } = d.smaStack;
      const price = d.lastPrice;
      let maScore = 0;
      if (sma50 !== null && price < sma50) maScore += 25;
      if (sma200 !== null && price < sma200) maScore += 25;
      score += maScore;
      components++;
    }

    return components > 0 ? clamp(score) : null;
  }

  // Earnings growth score: blends 1Y and 5Y EPS + revenue CAGR (0–100)
  // 5Y signals get 1.5× weight when available — more reliable than YoY spikes.
  // see docs/formulas.md#earnings-growth-score
  private computeEarningsGrowthScore(d: TickerSignalData): number | null {
    const hasAny = d.epsGrowth !== null || d.revenueGrowth !== null
                || d.epsGrowth5Y !== null || d.revenueGrowth5Y !== null;
    if (!hasAny) return null;

    let total = 0, weight = 0;
    // 1-year growth (YoY)
    if (d.epsGrowth !== null)     { total += clamp((d.epsGrowth / 50) * 100) * 1;    weight += 1; }
    if (d.revenueGrowth !== null) { total += clamp((d.revenueGrowth / 30) * 100) * 1; weight += 1; }
    // 5-year CAGR (1.5× weight — filters cyclical spikes, rewards compounders)
    if (d.epsGrowth5Y !== null)     { total += clamp((d.epsGrowth5Y / 40) * 100) * 1.5;    weight += 1.5; }
    if (d.revenueGrowth5Y !== null) { total += clamp((d.revenueGrowth5Y / 25) * 100) * 1.5; weight += 1.5; }

    return weight > 0 ? Math.round(total / weight) : null;
  }

  // Breakout quality score: priceNearSupport × 0.4 + maAlignment × 0.3 (volume omitted — not in snapshot)
  // Remaining weight re-normalized: 0.4/(0.4+0.3)=0.571, 0.3/(0.4+0.3)=0.429
  // see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4.7.2, FR-SE-05
  private computeBreakoutScore(d: TickerSignalData): number | null {
    if (d.snapshotAgeHours !== null && d.snapshotAgeHours > 168) return null; // FR-SE-05: > 7 days old

    let total = 0;
    let totalWeight = 0;

    // Price near support: use entryZoneLow as support proxy
    if (d.entryZoneLow !== null && d.lastPrice !== null && d.lastPrice > 0) {
      const distPct = Math.abs(d.lastPrice - d.entryZoneLow) / d.lastPrice;
      const priceNearSupport = distPct <= 0.03
        ? 100
        : clamp(100 - ((distPct - 0.03) / 0.07) * 100);
      total += priceNearSupport * 0.4;
      totalWeight += 0.4;
    }

    // MA alignment: price > sma20 > sma50 (bullish stack)
    if (d.smaStack && d.lastPrice !== null) {
      const { sma20, sma50 } = d.smaStack;
      let maScore = 0;
      if (sma20 !== null && d.lastPrice > sma20) maScore += 50;
      if (sma50 !== null && sma20 !== null && sma20 > sma50) maScore += 50;
      total += maScore * 0.3;
      totalWeight += 0.3;
    }

    return totalWeight > 0
      ? clamp(Math.round((total / totalWeight) * 10) / 10)
      : null;
  }

  // ── Batch signal data gathering ───────────────────────────────────────────

  gatherSignalData(tickers: string[]): Map<string, TickerSignalData> {
    if (tickers.length === 0) return new Map();

    const result = new Map<string, TickerSignalData>(
      tickers.map(t => [t, {
        ticker: t,
        ivRank: null, fundamentalScore: null, epsGrowth: null, revenueGrowth: null,
        rsi: null, trendStrengthAdx: null, trendLabel: null, smaStack: null,
        lastPrice: null, annualizedReturn: null, optionLiquidityScore: null,
        suitabilityScore: null, entryZoneLow: null, snapshotAgeHours: null,
        priceMomentumPct: null,
        relativeStrengthVsSpy: null,
        sectorMomentumPct: null,
        recentVolatility: null,
        buySignalScore: null,
        fcfToNetIncome: null, roic: null, netDebtToEbitda: null,
        revenueGrowth5Y: null, epsGrowth5Y: null, stockGrade: null,
      }])
    );

    this.loadIvRanks(tickers, result);
    this.loadFundamentals(tickers, result);
    this.loadAnalysisSnapshots(tickers, result);
    this.loadPriceMomentum(tickers, result);
    this.loadRelativeStrength(tickers, result);
    this.loadSectorMomentum(tickers, result);
    this.loadTechnicalSignals(tickers, result);
    this.loadRecentVolatility(tickers, result);
    // Always override lastPrice with the freshest available quote so the Daily Brief
    // never shows a stale EOD price when a live intraday quote is in quote_cache.
    this.loadLivePrice(tickers, result);

    return result;
  }

  private loadIvRanks(tickers: string[], result: Map<string, TickerSignalData>): void {
    const ph = tickers.map(() => '?').join(',');
    type RawRow = { ticker: string; atm_iv: number; rn: number };
    const rawRows = this.db.prepare(`
      SELECT ticker, atm_iv,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM iv_history WHERE ticker IN (${ph})
    `).all(...tickers) as RawRow[];

    const byTicker = new Map<string, number[]>();
    for (const r of rawRows) {
      if (r.rn > 252) continue;
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker)!.push(r.atm_iv);
    }

    for (const [ticker, ivs] of byTicker) {
      const d = result.get(ticker);
      if (!d || ivs.length < 21) continue;
      const currentIv = ivs[0]!;
      const minIv = Math.min(...ivs);
      const maxIv = Math.max(...ivs);
      d.ivRank = maxIv === minIv ? 50 : ((currentIv - minIv) / (maxIv - minIv)) * 100;
    }
  }

  private loadFundamentals(tickers: string[], result: Map<string, TickerSignalData>): void {
    // Source: fundamentals_cache — populated daily by market-sync batch jobs for the full
    // constituent universe. Decoupled from screen_results so brief quality is independent
    // of which screener preset the user ran last.
    const ph = tickers.map(() => '?').join(',');
    type CacheRow = { ticker: string; payload_json: string };
    const rows = this.db.prepare(`
      SELECT ticker, payload_json FROM fundamentals_cache
      WHERE ticker IN (${ph})
    `).all(...tickers) as CacheRow[];

    for (const row of rows) {
      const d = result.get(row.ticker);
      if (!d) continue;
      const p = JSON.parse(row.payload_json) as ScreenResultPayload;
      d.epsGrowth = p.epsGrowth;
      d.revenueGrowth = p.revenueGrowth;
      d.fcfToNetIncome = p.fcfToNetIncome ?? null;
      d.roic = p.roic ?? null;
      d.netDebtToEbitda = p.netDebtToEbitda ?? null;
      d.revenueGrowth5Y = p.revenueGrowth5Y ?? null;
      d.epsGrowth5Y = p.epsGrowth5Y ?? null;
      d.stockGrade = p.stockGrade ?? null;
      d.fundamentalScore = this.scoreFundamentals(p);
    }
  }

  private scoreFundamentals(data: ScreenResultPayload): number | null {
    // see docs/formulas.md#fundamental-quality-score
    let score = 0, max = 0;
    // Profitability
    if (data.roe !== null) { max += 15; score += clamp((data.roe / 20) * 15, 0, 15); }
    if (data.profitMargin !== null) { max += 10; score += clamp((data.profitMargin / 15) * 10, 0, 10); }
    // Capital efficiency (v0.22.21: ROIC replaces part of ROE weight — more informative)
    if (data.roic !== null) { max += 15; score += clamp((data.roic / 20) * 15, 0, 15); }
    // Cash quality (v0.22.21: FCF/NI confirms earnings quality)
    if (data.fcfToNetIncome !== null) { max += 15; score += clamp((data.fcfToNetIncome / 100) * 15, 0, 15); }
    // Growth (1Y)
    if (data.epsGrowth !== null) { max += 15; score += clamp((data.epsGrowth / 20) * 15, 0, 15); }
    if (data.revenueGrowth !== null) { max += 10; score += clamp((data.revenueGrowth / 15) * 10, 0, 10); }
    // Balance sheet
    if (data.debtToEquity !== null) { max += 10; score += clamp((1 - data.debtToEquity / 2) * 10, 0, 10); }
    if (data.freeCashFlow !== null && data.freeCashFlow > 0) { max += 10; score += 10; }
    return max > 0 ? Math.round((score / max) * 100) : null;
  }

  private loadAnalysisSnapshots(tickers: string[], result: Map<string, TickerSignalData>): void {
    const tickerSet = new Set(tickers);
    const nowMs = Date.now();

    // Look at last 20 snapshots; prefer 'all' mode but also accept individual modes
    type SnapRow = { id: number; mode: string; run_at: string; payload_json: string };
    const snaps = this.db.prepare(`
      SELECT id, mode, run_at, payload_json
      FROM analysis_snapshots
      ORDER BY id DESC LIMIT 20
    `).all() as SnapRow[];

    const seen = new Set<string>();

    for (const snap of snaps) {
      const ageHours = (nowMs - new Date(snap.run_at).getTime()) / 3_600_000;

      try {
        if (snap.mode === 'all') {
          type AllPayload = { results?: { buy?: BuyResult[]; wheel?: WheelResult[]; bullish?: StrategyResult[]; bearish?: StrategyResult[]; options_income?: OptionsIncomeResult[] }; buy?: BuyResult[]; wheel?: WheelResult[]; bullish?: StrategyResult[]; bearish?: StrategyResult[]; options_income?: OptionsIncomeResult[] };
          const parsed = JSON.parse(snap.payload_json) as AllPayload;
          const r = parsed.results ?? parsed;

          for (const item of r.buy ?? []) {
            if (!tickerSet.has(item.ticker)) continue;
            const d = result.get(item.ticker)!;
            if (!seen.has(`buy:${item.ticker}`)) {
              seen.add(`buy:${item.ticker}`);
              d.rsi = item.rsi;
              d.smaStack = item.smaStack;
              d.lastPrice = item.lastPrice;
              d.entryZoneLow = item.entryZoneLow;
              d.trendLabel = item.trend === 'bullish' ? 'bullish' : item.trend === 'bearish' ? 'bearish' : 'sideways';
              d.snapshotAgeHours = ageHours;
            }
          }
          for (const item of [...(r.bullish ?? []), ...(r.bearish ?? [])]) {
            const d = result.get(item.ticker);
            if (!d) continue;
            if (!seen.has(`adx:${item.ticker}`)) {
              seen.add(`adx:${item.ticker}`);
              d.trendStrengthAdx = item.trendStrength;
            }
          }
          for (const item of r.wheel ?? []) {
            const d = result.get(item.ticker);
            if (!d) continue;
            if (!seen.has(`wheel:${item.ticker}`)) {
              seen.add(`wheel:${item.ticker}`);
              d.annualizedReturn = item.annualizedReturn;
              d.optionLiquidityScore = item.optionLiquidityScore;
              d.suitabilityScore = item.suitabilityScore;
              if (d.lastPrice === null) d.lastPrice = item.lastPrice;
            }
          }
          for (const item of r.options_income ?? []) {
            const d = result.get(item.ticker);
            if (!d) continue;
            if (!seen.has(`income:${item.ticker}`)) {
              seen.add(`income:${item.ticker}`);
              if (d.annualizedReturn === null) d.annualizedReturn = item.annualizedReturn;
            }
          }
        } else if (snap.mode === 'buy') {
          type BuyPayload = { results?: BuyResult[] } | BuyResult[];
          const parsed = JSON.parse(snap.payload_json) as BuyPayload;
          const items: BuyResult[] = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
          for (const item of items) {
            if (!tickerSet.has(item.ticker) || seen.has(`buy:${item.ticker}`)) continue;
            seen.add(`buy:${item.ticker}`);
            const d = result.get(item.ticker)!;
            d.rsi = item.rsi;
            d.smaStack = item.smaStack;
            d.lastPrice = item.lastPrice;
            d.entryZoneLow = item.entryZoneLow;
            d.trendLabel = item.trend === 'bullish' ? 'bullish' : item.trend === 'bearish' ? 'bearish' : 'sideways';
            d.snapshotAgeHours = ageHours;
          }
        } else if (snap.mode === 'wheel') {
          type WheelPayload = { results?: WheelResult[] } | WheelResult[];
          const parsed = JSON.parse(snap.payload_json) as WheelPayload;
          const items: WheelResult[] = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
          for (const item of items) {
            if (!tickerSet.has(item.ticker) || seen.has(`wheel:${item.ticker}`)) continue;
            seen.add(`wheel:${item.ticker}`);
            const d = result.get(item.ticker)!;
            d.annualizedReturn = item.annualizedReturn;
            d.optionLiquidityScore = item.optionLiquidityScore;
            d.suitabilityScore = item.suitabilityScore;
          }
        } else if (snap.mode === 'bullish' || snap.mode === 'bearish') {
          type StratPayload = { results?: StrategyResult[] } | StrategyResult[];
          const parsed = JSON.parse(snap.payload_json) as StratPayload;
          const items: StrategyResult[] = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
          for (const item of items) {
            if (!tickerSet.has(item.ticker) || seen.has(`adx:${item.ticker}`)) continue;
            seen.add(`adx:${item.ticker}`);
            result.get(item.ticker)!.trendStrengthAdx = item.trendStrength;
          }
        }
      } catch {
        // Malformed snapshot — skip
      }
    }
  }

  // relativeStrengthVsSpy = ticker_90d_return − spy_90d_return (percentage points).
  // Uses rn=90 as the 90-day base; falls back to oldest available row when < 90 bars exist.
  // Minimum 60 bars required for SPY and for each ticker.
  // see docs/formulas.md#relative-strength, FR-SE-06
  private loadRelativeStrength(tickers: string[], result: Map<string, TickerSignalData>): void {
    const allTickers = ['SPY', ...tickers];
    const ph = allTickers.map(() => '?').join(',');

    type RSRow = {
      ticker: string;
      current_close: number | null;
      base_close: number | null;
      row_count: number;
    };

    // CTE pulls rn=1 (current) and rn=90 (base) per ticker in a single scan.
    // When fewer than 90 rows exist but ≥ 60, the oldest available row (rn=cnt) is used
    // so new-to-DB tickers aren't always null.
    const rows = this.db.prepare(`
      WITH ranked AS (
        SELECT ticker, close,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn,
               COUNT(*) OVER (PARTITION BY ticker)                         AS cnt
        FROM historical_prices
        WHERE ticker IN (${ph})
      )
      SELECT
        ticker,
        MAX(CASE WHEN rn = 1                                       THEN close END) AS current_close,
        MAX(CASE WHEN rn = 90                                      THEN close
                 WHEN cnt BETWEEN 60 AND 89 AND rn = cnt           THEN close
                 END)                                                              AS base_close,
        MAX(cnt)                                                                   AS row_count
      FROM ranked
      GROUP BY ticker
    `).all(...allTickers) as RSRow[];

    const toReturn = (row: RSRow): number | null => {
      if (row.current_close === null || row.base_close === null ||
          row.base_close <= 0 || row.row_count < 60) return null;
      return ((row.current_close - row.base_close) / row.base_close) * 100;
    };

    const spyRow = rows.find(r => r.ticker === 'SPY');
    const spyReturn = spyRow ? toReturn(spyRow) : null;
    if (spyReturn === null) return;  // SPY bars unavailable — signal stays null

    for (const row of rows) {
      if (row.ticker === 'SPY') continue;
      const d = result.get(row.ticker);
      if (!d) continue;
      const tickerReturn = toReturn(row);
      if (tickerReturn !== null) {
        d.relativeStrengthVsSpy = tickerReturn - spyReturn;
      }
    }
  }

  // sectorMomentumPct = 90-day return of the ticker's SPDR sector ETF.
  // Sector is read from ScreenResultPayload.sector in the latest screen run.
  // ETF bars come from historical_prices (maintained by PriceGapFillJob).
  // see docs/formulas.md#sector-momentum, FR-SE-07
  private loadSectorMomentum(tickers: string[], result: Map<string, TickerSignalData>): void {
    const etfTickers = Object.values(SECTOR_ETF);
    const etfPh = etfTickers.map(() => '?').join(',');

    type EtfRow = {
      ticker: string;
      current_close: number | null;
      base_close: number | null;
      row_count: number;
    };

    // Same 90d-return CTE pattern as loadRelativeStrength
    const etfRows = this.db.prepare(`
      WITH ranked AS (
        SELECT ticker, close,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn,
               COUNT(*) OVER (PARTITION BY ticker)                         AS cnt
        FROM historical_prices
        WHERE ticker IN (${etfPh})
      )
      SELECT
        ticker,
        MAX(CASE WHEN rn = 1                                       THEN close END) AS current_close,
        MAX(CASE WHEN rn = 90                                      THEN close
                 WHEN cnt BETWEEN 60 AND 89 AND rn = cnt           THEN close
                 END)                                                              AS base_close,
        MAX(cnt)                                                                   AS row_count
      FROM ranked
      GROUP BY ticker
    `).all(...etfTickers) as EtfRow[];

    // Build ETF → 90d return map
    const etfReturns = new Map<string, number>();
    for (const row of etfRows) {
      if (row.current_close !== null && row.base_close !== null &&
          row.base_close > 0 && row.row_count >= 60) {
        etfReturns.set(row.ticker, ((row.current_close - row.base_close) / row.base_close) * 100);
      }
    }
    if (etfReturns.size === 0) return;  // No ETF bars yet

    // Look up each ticker's sector from fundamentals_cache — batch-populated daily,
    // full constituent coverage, independent of screener run scope.
    const tickerPh = tickers.map(() => '?').join(',');
    type SectorRow = { ticker: string; sector: string | null };
    const cacheRows = this.db.prepare(`
      SELECT ticker, json_extract(payload_json, '$.sector') AS sector
      FROM fundamentals_cache
      WHERE ticker IN (${tickerPh})
    `).all(...tickers) as SectorRow[];

    for (const row of cacheRows) {
      const d = result.get(row.ticker);
      if (!d || !row.sector) continue;
      const etf = SECTOR_ETF[row.sector];
      if (!etf) continue;
      const etfReturn = etfReturns.get(etf);
      if (etfReturn !== undefined) {
        d.sectorMomentumPct = etfReturn;
      }
    }
  }

  private loadTechnicalSignals(tickers: string[], result: Map<string, TickerSignalData>): void {
    // Source: technical_signals — populated nightly by DailyTechnicalSignalsJob for the
    // full constituent universe. Also provides rsi, smaStack, lastPrice, adx, and
    // supportLevel as fallbacks for tickers not covered by analysis_snapshots.
    const ph = tickers.map(() => '?').join(',');
    type TsRow = {
      ticker: string;
      buy_signal_score: number | null;
      rsi: number | null;
      sma20: number | null; sma50: number | null; sma200: number | null;
      price: number | null;
      adx: number | null;
      support_level: number | null;
    };
    const rows = this.db.prepare(`
      SELECT ticker, buy_signal_score, rsi, sma20, sma50, sma200, price, adx, support_level
      FROM technical_signals
      WHERE ticker IN (${ph})
    `).all(...tickers) as TsRow[];

    for (const row of rows) {
      const d = result.get(row.ticker);
      if (!d) continue;
      d.buySignalScore = row.buy_signal_score;
      // Fill only when analysis_snapshots had no data for this ticker
      if (d.rsi === null) d.rsi = row.rsi;
      if (d.smaStack === null && (row.sma20 !== null || row.sma50 !== null || row.sma200 !== null)) {
        d.smaStack = { sma20: row.sma20, sma50: row.sma50, sma200: row.sma200 };
      }
      if (d.lastPrice === null && row.price !== null && row.price > 0) d.lastPrice = row.price;
      // ADX → trendStrengthAdx (trendNeutral signal for income; trendStrength for bullish/bearish)
      if (d.trendStrengthAdx === null) d.trendStrengthAdx = row.adx;
      // 20-day low → entryZoneLow proxy for breakoutScore priceNearSupport component
      if (d.entryZoneLow === null) d.entryZoneLow = row.support_level;
    }
  }

  // 20-day realized volatility — annualized std dev of daily log returns × 100 (as %).
  // Requires ≥ 21 closing prices (20 returns). Minimum 15 required to produce a value.
  // Income & Wheel use this as lower_better: high vol = stock making large moves = bad for premium selling.
  // see docs/formulas.md#recent-volatility
  private loadRecentVolatility(tickers: string[], result: Map<string, TickerSignalData>): void {
    const ph = tickers.map(() => '?').join(',');
    type PRow = { ticker: string; close: number; rn: number };
    const rows = this.db.prepare(`
      SELECT ticker, close,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM historical_prices
      WHERE ticker IN (${ph})
    `).all(...tickers) as PRow[];

    const byTicker = new Map<string, number[]>();
    for (const r of rows) {
      if (r.rn > 22) continue;  // only need 21 closes for 20 returns
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker)!.push(r.close);
    }

    for (const [ticker, closes] of byTicker) {
      const d = result.get(ticker);
      if (!d || closes.length < 16) continue;  // need ≥ 15 returns

      // closes are newest-first (rn=1 first); compute log returns oldest→newest
      const sorted = [...closes].reverse();
      const logReturns: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const curr = sorted[i]!;
        if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev));
      }
      if (logReturns.length < 15) continue;

      const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
      const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
      // Annualize: × √252 × 100 to express as percentage
      d.recentVolatility = Math.sqrt(variance * 252) * 100;
    }
  }

  // priceMomentumPct = (currentClose - close_52w_ago) / close_52w_ago × 100
  // see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4.7.1, FR-SE-04
  private loadPriceMomentum(tickers: string[], result: Map<string, TickerSignalData>): void {
    const ph = tickers.map(() => '?').join(',');

    type PriceRow = { ticker: string; close: number; rn: number };
    // Pull up to 253 most recent prices per ticker (current + ~252 trading days)
    const rows = this.db.prepare(`
      SELECT ticker, close,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM historical_prices
      WHERE ticker IN (${ph})
    `).all(...tickers) as PriceRow[];

    const byTicker = new Map<string, { current: number | null; old252: number | null; count: number }>();
    for (const r of rows) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, { current: null, old252: null, count: 0 });
      const entry = byTicker.get(r.ticker)!;
      entry.count++;
      if (r.rn === 1) entry.current = r.close;
      if (r.rn === 252) entry.old252 = r.close;
    }

    for (const [ticker, entry] of byTicker) {
      const d = result.get(ticker);
      if (!d) continue;
      // FR-SE-04: need at least 30 days; use available if < 252
      if (entry.count < 30) continue;
      if (entry.current === null) continue;
      // Use oldest available price if we don't have exactly 252
      if (entry.old252 !== null) {
        d.priceMomentumPct = ((entry.current - entry.old252) / entry.old252) * 100;
      } else {
        // Find the furthest available row
        const furthest = rows
          .filter(r => r.ticker === ticker)
          .reduce((max, r) => r.rn > max.rn ? r : max, { rn: 0, close: 0, ticker });
        if (furthest.rn >= 30 && furthest.close > 0) {
          d.priceMomentumPct = ((entry.current - furthest.close) / furthest.close) * 100;
        }
      }
      if (d.lastPrice === null) d.lastPrice = entry.current;
    }
  }

  // Override lastPrice with the most recent Polygon quote from quote_cache.
  // quote_cache.last is refreshed whenever a ticker is viewed or market-synced,
  // so it reflects intraday prices — unlike analysis_snapshots or historical_prices
  // which only update overnight. This prevents the Daily Brief showing yesterday's
  // EOD price during a mid-day run.
  private loadLivePrice(tickers: string[], result: Map<string, TickerSignalData>): void {
    if (tickers.length === 0) return;
    const ph = tickers.map(() => '?').join(',');
    type QuoteRow = { ticker: string; last: number };
    const rows = this.db.prepare(
      `SELECT ticker, last FROM quote_cache WHERE ticker IN (${ph}) AND last IS NOT NULL AND last > 0`
    ).all(...tickers) as QuoteRow[];
    for (const row of rows) {
      const d = result.get(row.ticker);
      if (d) d.lastPrice = row.last;
    }
  }

  // ── Brief persistence helpers ─────────────────────────────────────────────

  persistBrief(
    strategy: ScoringStrategy,
    picks: object[],
    validUntil: string,
    runMeta: object,
  ): number {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Delete any records for this strategy generated today in ET.
    // generated_at is stored as UTC, so we convert each row's timestamp to ET
    // and compare — handles DST correctly via the JS Intl API.
    type IdRow = { id: number; generated_at: string };
    const existing = this.db.prepare(
      `SELECT id, generated_at FROM daily_briefs WHERE strategy = ?`
    ).all(strategy) as IdRow[];

    const toDelete = existing
      .filter(r => new Date(r.generated_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === todayET)
      .map(r => r.id);

    if (toDelete.length > 0) {
      const placeholders = toDelete.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM daily_briefs WHERE id IN (${placeholders})`).run(...toDelete);
    }

    const result = this.db.prepare(`
      INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta)
      VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?, ?, ?)
    `).run(validUntil, strategy, JSON.stringify(picks), JSON.stringify(runMeta));
    return result.lastInsertRowid as number;
  }

  getLatestBrief(strategy?: ScoringStrategy): { id: number; generated_at: string; valid_until: string; strategy: string; picks: string; run_meta: string | null }[] {
    if (strategy) {
      return this.db.prepare(`
        SELECT id, generated_at, valid_until, strategy, picks, run_meta
        FROM daily_briefs
        WHERE strategy = ?
        ORDER BY generated_at DESC LIMIT 1
      `).all(strategy) as ReturnType<typeof this.getLatestBrief>;
    }
    // One per strategy (latest)
    return this.db.prepare(`
      SELECT b.id, b.generated_at, b.valid_until, b.strategy, b.picks, b.run_meta
      FROM daily_briefs b
      INNER JOIN (
        SELECT strategy, MAX(generated_at) AS max_gen
        FROM daily_briefs
        GROUP BY strategy
      ) latest ON b.strategy = latest.strategy AND b.generated_at = latest.max_gen
      ORDER BY b.strategy
    `).all() as ReturnType<typeof this.getLatestBrief>;
  }

  getBriefHistory(limit = 30): { id: number; generated_at: string; valid_until: string; strategy: string; picks: string; run_meta: string | null }[] {
    return this.db.prepare(`
      SELECT id, generated_at, valid_until, strategy, picks, run_meta
      FROM daily_briefs
      ORDER BY generated_at DESC LIMIT ?
    `).all(limit) as ReturnType<typeof this.getBriefHistory>;
  }

  pruneStaleBriefs(retentionDays = 90): void {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM daily_briefs WHERE generated_at < ?').run(cutoff);
  }

  // ── 1e: Signal weight suggestions from Pearson correlation ────────────────
  // Joins paper_trades.signals (SignalBreakdown per key) with the first-snapshot
  // Day+1 verdict for each trade. For each signal key, computes Pearson r between
  // the normalised signal value (0–1) and a binary outcome (positive=1, else=0).
  // Compares to current config weights and suggests direction of adjustment.
  // Requires ≥ 10 trades with snapshots per strategy to report.
  computeSignalCorrelations(strategy: ScoringStrategyType): SignalWeightSuggestion[] {
    type Row = { signals: string; verdict: string };
    const rows = this.db.prepare(`
      SELECT pt.signals, pts.verdict
      FROM paper_trades pt
      JOIN (
        SELECT paper_trade_id, MIN(days_held) AS min_held
        FROM paper_trade_snapshots
        GROUP BY paper_trade_id
      ) ms ON ms.paper_trade_id = pt.id
      JOIN paper_trade_snapshots pts
        ON pts.paper_trade_id = pt.id AND pts.days_held = ms.min_held
      WHERE pt.brief_strategy = ?
    `).all(strategy) as Row[];

    if (rows.length < 10) return [];

    // Parse signals JSON and build per-key arrays of (normalised, binary_outcome)
    type SignalBreakdownRow = { normalized: number; weight: number; missing: boolean };
    const signalData = new Map<string, { values: number[]; outcomes: number[] }>();

    for (const row of rows) {
      const binaryOutcome = row.verdict === 'positive' ? 1 : 0;
      let signals: Record<string, SignalBreakdownRow>;
      try { signals = JSON.parse(row.signals) as Record<string, SignalBreakdownRow>; }
      catch { continue; }

      for (const [key, sig] of Object.entries(signals)) {
        if (sig.missing || sig.normalized == null) continue;
        if (!signalData.has(key)) signalData.set(key, { values: [], outcomes: [] });
        signalData.get(key)!.values.push(sig.normalized);
        signalData.get(key)!.outcomes.push(binaryOutcome);
      }
    }

    // Get current config for this strategy
    const config = this.getConfig(strategy);
    const signalMap = new Map(config.signals.map(s => [s.key, s]));

    // Compute total positive correlation mass for proportional weight suggestions
    const correlations: Array<{ key: string; r: number; n: number }> = [];
    for (const [key, data] of signalData) {
      if (data.values.length < 10) continue;
      const r = pearsonR(data.values, data.outcomes);
      correlations.push({ key, r, n: data.values.length });
    }

    const totalPosMass = correlations.reduce((s, c) => s + Math.max(0, c.r), 0);

    return correlations
      .filter(c => signalMap.has(c.key))
      .map(({ key, r, n }) => {
        const sig  = signalMap.get(key)!;
        const curr = sig.weight;
        // Proportional suggested weight based on positive correlation share
        const suggested = totalPosMass > 0
          ? Math.round((Math.max(0, r) / totalPosMass) * 100 * 10) / 10
          : curr;
        const diff = suggested - curr;
        const direction: 'increase' | 'decrease' | 'hold' =
          diff > 2 ? 'increase' : diff < -2 ? 'decrease' : 'hold';
        return {
          strategy,
          signalKey:       key,
          signalLabel:     sig.label ?? key,
          currentWeight:   curr,
          correlation:     Math.round(r * 100) / 100,
          sampleSize:      n,
          suggestedWeight: suggested,
          direction,
        };
      })
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }
}

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const xm = xs.reduce((s, v) => s + v, 0) / n;
  const ym = ys.reduce((s, v) => s + v, 0) / n;
  const num  = xs.reduce((s, x, i) => s + (x - xm) * ((ys[i] ?? 0) - ym), 0);
  const denX = Math.sqrt(xs.reduce((s, x) => s + (x - xm) ** 2, 0));
  const denY = Math.sqrt(ys.reduce((s, y) => s + (y - ym) ** 2, 0));
  return denX * denY === 0 ? 0 : num / (denX * denY);
}
