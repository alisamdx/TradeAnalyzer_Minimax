// Trade Scoring Engine — configurable per-strategy composite scorer.
// Reads only from local DB (no live API calls). Config lives in scoring_strategy_configs.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4

import type { Database } from 'better-sqlite3';
import type { ScreenResultPayload } from '@shared/types.js';
import type { BuyResult, WheelResult, StrategyResult, OptionsIncomeResult } from './analysis-service.js';

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
  /** Phase 2 placeholder — not computed in Phase 1; always scores 0. */
  phase2?: boolean;
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

const BASELINE_WHEEL: ScoringSignal[] = [
  {
    key: 'ivRank', label: 'IV Rank (30-day)', weight: 30, enabled: true,
    description: 'tastytrade rule #1: IVR < 30 = don\'t sell. Higher IVR = more edge in premium.',
    dataSource: 'iv_history.atm_iv → IvHistoryService.getIvRank()',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'premiumYield', label: 'Premium Yield (annualized)', weight: 25, enabled: true,
    description: 'Premium / strike × (365 / DTE). You\'re a yield business — this is your return.',
    dataSource: 'analysis_snapshots wheel.annualizedReturn',
    direction: 'higher_better', normMax: 60,
  },
  {
    key: 'fundamentalScore', label: 'Fundamental Quality', weight: 20, enabled: true,
    description: 'Wheel requires owning the stock — never sell a CSP on a stock you wouldn\'t hold.',
    dataSource: 'screen_results.payload_json → scoreFundamentals()',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'technicalNeutral', label: 'Technical Neutral (RSI 40–60)', weight: 15, enabled: true,
    description: 'Don\'t sell puts into a downtrend; neutral trend = safer assignment zone.',
    dataSource: 'analysis_snapshots buy.rsi',
    direction: 'target_range', targetMin: 40, targetMax: 60,
  },
  {
    key: 'optionLiquidity', label: 'Option Liquidity', weight: 10, enabled: true,
    description: 'Wide bid-ask spreads kill theoretical edge; OI + spread composite.',
    dataSource: 'analysis_snapshots wheel.optionLiquidityScore (0–10)',
    direction: 'higher_better', normMax: 10,
  },
];

const BASELINE_BULLISH: ScoringSignal[] = [
  {
    key: 'trendStrength', label: 'Price Trend (above 50MA + 200MA, ADX > 20)', weight: 30, enabled: true,
    description: 'Institutional consensus — big money is already positioned long.',
    dataSource: 'analysis_snapshots buy.smaStack + bullish.trendStrength (ADX)',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'earningsGrowth', label: 'Earnings / Revenue Growth Quality', weight: 25, enabled: true,
    description: 'CANSLIM: EPS + sales growth are the primary fundamental trigger for institutional buying.',
    dataSource: 'screen_results.payload_json epsGrowth + revenueGrowth',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'rsiMomentum', label: 'RSI Momentum (45–70 zone)', weight: 20, enabled: true,
    description: 'Want momentum without being overextended. Below 45 = lagging; above 70 = chasing.',
    dataSource: 'analysis_snapshots buy.rsi',
    direction: 'target_range', targetMin: 45, targetMax: 70,
  },
  {
    key: 'relativeStrength', label: 'Relative Performance vs Universe', weight: 15, enabled: false,
    description: 'Leaders lead — if it\'s lagging peers in an up move, it\'s weak. Available in Phase 2 — requires SPY price bars in price_history.',
    dataSource: 'Phase 2: price_history SPY bars',
    direction: 'higher_better', normMax: 100, phase2: true,
  },
  {
    key: 'priceMomentumPct', label: 'Price Momentum % (52-week return)', weight: 10, enabled: true,
    description: 'Confirms sustained directional move, not just a 1-day spike.',
    dataSource: 'historical_prices (currentPrice - price_52w_ago) / price_52w_ago × 100',
    direction: 'higher_better', normMax: 150,
  },
];

const BASELINE_BEARISH: ScoringSignal[] = [
  {
    key: 'downtrendScore', label: 'Downtrend Confirmation (below 50MA + 200MA)', weight: 30, enabled: true,
    description: 'Don\'t fight institutional selling — wait for MA confirmation.',
    dataSource: 'analysis_snapshots buy.smaStack + bearish.trendStrength (ADX)',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'fundamentalWeakness', label: 'Fundamental Deterioration', weight: 25, enabled: true,
    description: 'Earnings-driven declines are sustained; pure technical breakdowns often reverse.',
    dataSource: 'screen_results.payload_json → inverted scoreFundamentals()',
    direction: 'lower_better', normMax: 100,
  },
  {
    key: 'rsiOverbought', label: 'RSI Overbought / Rolling Over (60–80 zone)', weight: 20, enabled: true,
    description: 'Overextended but not yet collapsed = best short entry window.',
    dataSource: 'analysis_snapshots buy.rsi',
    direction: 'target_range', targetMin: 60, targetMax: 80,
  },
  {
    key: 'relativeWeakness', label: 'Relative Weakness vs Universe', weight: 15, enabled: false,
    description: 'Weakest stocks in a weak market fall hardest. Available in Phase 2 — requires SPY price bars in price_history.',
    dataSource: 'Phase 2: price_history SPY bars',
    direction: 'lower_better', normMax: 100, phase2: true,
  },
  {
    key: 'priceDecayPct', label: 'Price Decay % (negative 52-week return)', weight: 10, enabled: true,
    description: 'Confirms sustained downtrend, not a brief pullback.',
    dataSource: 'historical_prices (currentPrice - price_52w_ago) / price_52w_ago × 100 (inverted)',
    direction: 'lower_better', normMax: 150,
  },
];

const BASELINE_INCOME: ScoringSignal[] = [
  {
    key: 'ivRank', label: 'IV Rank (30-day)', weight: 35, enabled: true,
    description: 'Higher weight than Wheel: no ownership backstop — IV edge is the entire thesis.',
    dataSource: 'iv_history.atm_iv → IvHistoryService.getIvRank()',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'premiumRiskRatio', label: 'Premium / Max Risk Ratio', weight: 25, enabled: true,
    description: 'tastytrade: credit ≥ 1/3 of spread width. Below that, not worth the risk.',
    dataSource: 'analysis_snapshots options_income.annualizedReturn',
    direction: 'higher_better', normMax: 60,
  },
  {
    key: 'trendNeutral', label: 'Underlying Trend Neutrality (range-bound)', weight: 20, enabled: true,
    description: 'Short strangles need the stock to stay in a range; strong trends kill this trade.',
    dataSource: 'analysis_snapshots bullish/bearish.trendStrength (ADX < 20 = range-bound)',
    direction: 'lower_better', normMax: 60,
  },
  {
    key: 'optionLiquidity', label: 'Option Liquidity (OI, volume, tight spreads)', weight: 20, enabled: true,
    description: 'Multi-leg structures: slippage compounds. Liquidity is non-negotiable.',
    dataSource: 'analysis_snapshots wheel.optionLiquidityScore (0–10)',
    direction: 'higher_better', normMax: 10,
  },
];

const BASELINE_BUY: ScoringSignal[] = [
  {
    key: 'priceMomentumPct', label: 'Price Momentum % (52-week return)', weight: 35, enabled: true,
    description: 'Momentum is the strongest documented return factor (Jegadeesh-Titman 1993).',
    dataSource: 'historical_prices (currentPrice - price_52w_ago) / price_52w_ago × 100',
    direction: 'higher_better', normMax: 150,
  },
  {
    key: 'earningsGrowth', label: 'Earnings Quality (EPS consistency + growth)', weight: 25, enabled: true,
    description: 'Fundamental anchor — momentum without earnings support is speculation.',
    dataSource: 'screen_results.payload_json epsGrowth + revenueGrowth',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'breakoutScore', label: 'Breakout Quality Score', weight: 20, enabled: true,
    description: 'Entry timing: price near support, volume anomaly, MA alignment = defined risk entry.',
    dataSource: 'analysis_snapshots buy.smaStack + entryZoneLow + lastPrice',
    direction: 'higher_better', normMax: 100,
  },
  {
    key: 'relativeStrength', label: 'Relative Performance vs Universe', weight: 20, enabled: false,
    description: 'Confirms the stock is leading, not lagging — buy leaders. Available in Phase 2 — requires SPY price bars in price_history.',
    dataSource: 'Phase 2: price_history SPY bars',
    direction: 'higher_better', normMax: 100, phase2: true,
  },
];

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
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ScoringService {
  constructor(private readonly db: Database) {}

  // ── Config management ─────────────────────────────────────────────────────

  seedBaselines(): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO scoring_strategy_configs (strategy, signals, version, updated_at)
      VALUES (?, ?, 'baseline_v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
        version: 'baseline_v1',
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
    const enabledSignals = config.signals.filter(s => s.enabled && !s.phase2);

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

    // Initialize all signals (including phase2 placeholders)
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

      // Phase 2 placeholders — should never reach here since phase2=true signals are excluded
      case 'relativeStrength':
      case 'relativeWeakness':
      case 'sectorMomentum':
      case 'relativeStrengthVsSpy':
        return null;

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

  // Earnings growth score: combined EPS + revenue growth (0–100)
  private computeEarningsGrowthScore(d: TickerSignalData): number | null {
    if (d.epsGrowth === null && d.revenueGrowth === null) return null;
    let total = 0;
    let weight = 0;
    if (d.epsGrowth !== null) { total += clamp((d.epsGrowth / 50) * 100); weight++; }
    if (d.revenueGrowth !== null) { total += clamp((d.revenueGrowth / 30) * 100); weight++; }
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
      }])
    );

    this.loadIvRanks(tickers, result);
    this.loadFundamentals(tickers, result);
    this.loadAnalysisSnapshots(tickers, result);
    this.loadPriceMomentum(tickers, result);

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
    type RunRow = { id: number };
    const latestRun = this.db.prepare(
      'SELECT id FROM screen_runs ORDER BY id DESC LIMIT 1'
    ).get() as RunRow | undefined;
    if (!latestRun) return;

    const ph = tickers.map(() => '?').join(',');
    type SRow = { ticker: string; payload_json: string };
    const rows = this.db.prepare(`
      SELECT ticker, payload_json FROM screen_results
      WHERE screen_run_id = ? AND ticker IN (${ph})
    `).all(latestRun.id, ...tickers) as SRow[];

    for (const row of rows) {
      const d = result.get(row.ticker);
      if (!d) continue;
      const p = JSON.parse(row.payload_json) as ScreenResultPayload;
      d.epsGrowth = p.epsGrowth;
      d.revenueGrowth = p.revenueGrowth;
      d.fundamentalScore = this.scoreFundamentals(p);
    }
  }

  private scoreFundamentals(data: ScreenResultPayload): number | null {
    let score = 0, max = 0;
    if (data.roe !== null) { max += 20; score += clamp((data.roe / 20) * 20, 0, 20); }
    if (data.epsGrowth !== null) { max += 20; score += clamp((data.epsGrowth / 20) * 20, 0, 20); }
    if (data.profitMargin !== null) { max += 15; score += clamp((data.profitMargin / 15) * 15, 0, 15); }
    if (data.revenueGrowth !== null) { max += 15; score += clamp((data.revenueGrowth / 15) * 15, 0, 15); }
    if (data.debtToEquity !== null) { max += 15; score += clamp((1 - data.debtToEquity / 2) * 15, 0, 15); }
    if (data.freeCashFlow !== null && data.freeCashFlow > 0) { max += 15; score += 15; }
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

  // ── Brief persistence helpers ─────────────────────────────────────────────

  persistBrief(
    strategy: ScoringStrategy,
    picks: object[],
    validUntil: string,
    runMeta: object,
  ): number {
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
}
