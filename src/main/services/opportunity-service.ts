// ENH-2 Opportunity Dashboard service.
// Composes IV rank, cached fundamentals, quote cache, and analysis snapshots
// into a ranked opportunity score for each universe ticker.
// see docs/formulas.md#opportunity-score

import type { Database } from 'better-sqlite3';
import type { ConstituentRow, ScreenResultPayload } from '@shared/types.js';

export type StrategyMode = 'wheel' | 'csp' | 'spreads' | 'bullish' | 'bearish';
export type OpportunityUniverse = 'sp500' | 'russell1000' | 'both';

export interface OpportunityRow {
  rank: number;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  lastPrice: number | null;
  dayChangePct: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  currentIv: number | null;      // ATM IV as percentage (e.g. 38.5)
  dataPoints: number;            // how many IV history rows exist
  fundamentalsScore: number | null;   // 0-100 derived from screener fundamentals
  technicalScore: number | null;      // 0-100 from latest analysis snapshot
  premiumYieldScore: number | null;   // 0-100 derived from estimated premium vs price
  ivRankScore: number | null;         // 0-100 strategy-adjusted IV rank score
  compositeScore: number;             // 0-100 weighted composite
  passScore: number | null;           // raw filter pass count from screener
  estimatedPremium: number | null;    // rough ~1.5% of strike/month
  targetStrike: number | null;        // ~92% of last price
  priceAge: string | null;            // ISO timestamp of last quote_cache fetch
}

export interface OpportunityRunOptions {
  universe: OpportunityUniverse;
  strategy: StrategyMode;
  minCompositeScore?: number;
  limit?: number;
}

type GetConstituents = (u: 'sp500' | 'russell1000' | 'both') => ConstituentRow[];

// ── Score thresholds ──────────────────────────────────────────────────────────
// Premium selling (wheel/csp/spreads): high IV rank = favorable entry
// Directional (bullish/bearish): low IV = cheaper options, better risk/reward
const PREMIUM_SELLING_MODES: StrategyMode[] = ['wheel', 'csp', 'spreads'];

export class OpportunityService {
  constructor(
    private readonly db: Database,
    private readonly getConstituents: GetConstituents,
  ) {}

  run(opts: OpportunityRunOptions): OpportunityRow[] {
    const { universe, strategy, minCompositeScore = 0, limit = 100 } = opts;

    // 1. Universe tickers
    const constituents = this.getConstituents(universe);
    if (constituents.length === 0) return [];

    const tickers = [...new Set(constituents.map(c => c.ticker.toUpperCase()))];
    const constituentMap = new Map(constituents.map(c => [c.ticker.toUpperCase(), c]));

    // 2. IV ranks — one batch SQL query (avoids N separate prepared statements)
    const ivMap = this.batchIvRanks(tickers);

    // 3. Quote cache — prices + current_iv
    const quoteMap = this.batchQuotes(tickers);

    // 4. Fundamentals from latest screen run (payload already has price + lastPrice)
    const fundamentalsMap = this.latestScreenFundamentals(tickers);

    // 5. Technical scores from latest analysis snapshots
    const technicalMap = this.latestTechnicalScores(tickers);

    // 6. Compose and rank
    const rows: OpportunityRow[] = [];
    for (const ticker of tickers) {
      const constituent = constituentMap.get(ticker);
      const ivData = ivMap.get(ticker);
      const quote = quoteMap.get(ticker);
      const fund = fundamentalsMap.get(ticker);
      const tech = technicalMap.get(ticker) ?? null;

      const price = quote?.last ?? fund?.lastPrice ?? fund?.price ?? null;  // see docs/formulas.md#opportunity-price
      const prevClose = quote?.prevClose ?? null;

      const fundamentalsScore = this.scoreFundamentals(fund);
      const ivRankScore = this.scoreIvRank(ivData?.ivRank, strategy);
      const technicalScore = tech;
      const targetStrike = price ? +(price * 0.92).toFixed(2) : null;
      const estimatedPremium = targetStrike ? +(targetStrike * 0.015).toFixed(2) : null;
      const premiumYieldScore = this.scorePremiumYield(estimatedPremium, price);
      const compositeScore = this.composite(fundamentalsScore, ivRankScore, technicalScore, premiumYieldScore);

      if (compositeScore < minCompositeScore) continue;

      const dayChangePct =
        price !== null && prevClose !== null && prevClose !== 0
          ? +((price - prevClose) / prevClose * 100).toFixed(2)
          : null;

      rows.push({
        rank: 0,
        ticker,
        companyName: constituent?.companyName ?? null,
        sector: constituent?.sector ?? null,
        lastPrice: price,
        dayChangePct,
        ivRank: ivData?.ivRank ?? null,
        ivPercentile: ivData?.ivPercentile ?? null,
        currentIv: ivData?.currentIv ?? quote?.currentIv ?? null,
        dataPoints: ivData?.dataPoints ?? 0,
        fundamentalsScore,
        technicalScore,
        premiumYieldScore,
        ivRankScore,
        compositeScore,
        passScore: fund?.passScore ?? null,
        estimatedPremium,
        targetStrike,
        priceAge: quote?.fetchedAt ?? null,
      });
    }

    // Sort by composite desc → only return tickers with data
    rows.sort((a, b) => b.compositeScore - a.compositeScore);
    const top = rows.slice(0, limit).filter(r => r.compositeScore > 0);
    top.forEach((r, i) => { r.rank = i + 1; });
    return top;
  }

  // ── Private: batch data fetchers ──────────────────────────────────────────

  private batchIvRanks(tickers: string[]): Map<string, {
    ivRank: number | null;
    ivPercentile: number | null;
    currentIv: number | null;
    dataPoints: number;
  }> {
    if (tickers.length === 0) return new Map();
    const ph = tickers.map(() => '?').join(',');

    // Pull at most 252 most-recent rows per ticker in one query using ROW_NUMBER window function.
    // SQLite 3.25+ (bundled in Electron) supports window functions.
    type RawRow = { ticker: string; atm_iv: number; rn: number };
    const rawRows = this.db.prepare(`
      SELECT ticker, atm_iv,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM iv_history
      WHERE ticker IN (${ph})
    `).all(...tickers) as RawRow[];

    // Group by ticker — keep only first 252 rows (ordered newest→oldest)
    const byTicker = new Map<string, number[]>();
    for (const r of rawRows) {
      if (r.rn > 252) continue;
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker)!.push(r.atm_iv);
    }

    const result = new Map<string, {
      ivRank: number | null; ivPercentile: number | null; currentIv: number | null; dataPoints: number;
    }>();

    for (const [ticker, ivs] of byTicker) {
      if (ivs.length < 21) {
        result.set(ticker, { ivRank: null, ivPercentile: null, currentIv: ivs[0] ?? null, dataPoints: ivs.length });
        continue;
      }
      const currentIv = ivs[0]!;
      const minIv = Math.min(...ivs);
      const maxIv = Math.max(...ivs);
      const ivRank = maxIv === minIv ? 50 : ((currentIv - minIv) / (maxIv - minIv)) * 100;
      const ivPercentile = (ivs.filter(v => v < currentIv).length / ivs.length) * 100;
      result.set(ticker, {
        ivRank:       Math.round(ivRank * 10) / 10,
        ivPercentile: Math.round(ivPercentile * 10) / 10,
        currentIv,
        dataPoints:   ivs.length,
      });
    }
    return result;
  }

  private batchQuotes(tickers: string[]): Map<string, {
    last: number | null;
    prevClose: number | null;
    currentIv: number | null;
    fetchedAt: string;
  }> {
    if (tickers.length === 0) return new Map();
    const ph = tickers.map(() => '?').join(',');
    type QRow = {
      ticker: string;
      last: number | null;
      prev_close: number | null;
      current_iv: number | null;
      fetched_at: string;
    };
    const rows = this.db.prepare(`
      SELECT ticker, last, prev_close, current_iv, fetched_at
      FROM quote_cache
      WHERE ticker IN (${ph})
    `).all(...tickers) as QRow[];

    return new Map(rows.map(r => [r.ticker, {
      last:      r.last,
      prevClose: r.prev_close,
      currentIv: r.current_iv,
      fetchedAt: r.fetched_at,
    }]));
  }

  private latestScreenFundamentals(tickers: string[]): Map<string, ScreenResultPayload> {
    type RunRow = { id: number };
    const latestRun = this.db.prepare(`
      SELECT id FROM screen_runs ORDER BY id DESC LIMIT 1
    `).get() as RunRow | undefined;

    if (!latestRun) return new Map();

    const ph = tickers.map(() => '?').join(',');
    type SRow = { ticker: string; payload_json: string };
    const rows = this.db.prepare(`
      SELECT ticker, payload_json
      FROM screen_results
      WHERE screen_run_id = ? AND ticker IN (${ph})
    `).all(latestRun.id, ...tickers) as SRow[];

    return new Map(rows.map(r => {
      const p = JSON.parse(r.payload_json) as ScreenResultPayload;
      return [r.ticker, p] as [string, ScreenResultPayload];
    }));
  }

  private latestTechnicalScores(tickers: string[]): Map<string, number> {
    // Pull the 20 most-recent analysis snapshots; take first composite/suitability score seen per ticker.
    // Modes that have a 0-100 score: 'buy' (compositeScore), 'wheel' (suitabilityScore), 'options_income' (no score — skip)
    type SnapRow = { mode: string; payload_json: string };
    const snaps = this.db.prepare(`
      SELECT mode, payload_json
      FROM analysis_snapshots
      ORDER BY id DESC LIMIT 20
    `).all() as SnapRow[];

    const tickerSet = new Set(tickers);
    const scores = new Map<string, number>();

    for (const snap of snaps) {
      if (snap.mode !== 'buy' && snap.mode !== 'wheel') continue;
      // payload_json is stored as { jobRunId, results: [...] } by AnalysisService
      type ResultItem = { ticker: string; compositeScore?: number; suitabilityScore?: number };
      let results: ResultItem[];
      try {
        const parsed = JSON.parse(snap.payload_json) as ResultItem[] | { results?: ResultItem[] };
        results = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
      } catch { continue; }

      for (const r of results) {
        if (!tickerSet.has(r.ticker)) continue;
        if (scores.has(r.ticker)) continue; // already have a score (from a newer snapshot)
        const score = r.compositeScore ?? r.suitabilityScore;
        if (score !== undefined && score !== null) scores.set(r.ticker, score);
      }
    }
    return scores;
  }

  // ── Private: scoring functions ────────────────────────────────────────────

  private scoreFundamentals(data: ScreenResultPayload | undefined): number | null {
    if (!data) return null;
    let score = 0;
    let max = 0;

    // ROE — see docs/formulas.md#roe
    if (data.roe !== null) {
      max += 20;
      if      (data.roe >= 20) score += 20;
      else if (data.roe >= 15) score += 15;
      else if (data.roe >= 10) score += 8;
    }
    // P/E ratio — see docs/formulas.md#pe-ratio
    if (data.peRatio !== null && data.peRatio > 0) {
      max += 20;
      if      (data.peRatio <= 15) score += 20;
      else if (data.peRatio <= 20) score += 15;
      else if (data.peRatio <= 25) score += 10;
      else if (data.peRatio <= 35) score += 5;
    }
    // Debt-to-equity — see docs/formulas.md#debt-to-equity
    if (data.debtToEquity !== null) {
      max += 20;
      if      (data.debtToEquity <= 0.5) score += 20;
      else if (data.debtToEquity <= 1.0) score += 15;
      else if (data.debtToEquity <= 2.0) score += 8;
    }
    // Profit margin — see docs/formulas.md#profit-margin
    if (data.profitMargin !== null) {
      max += 20;
      if      (data.profitMargin >= 20) score += 20;
      else if (data.profitMargin >= 15) score += 15;
      else if (data.profitMargin >= 10) score += 10;
      else if (data.profitMargin >=  5) score += 5;
    }
    // Revenue growth — see docs/formulas.md#revenue-growth
    if (data.revenueGrowth !== null) {
      max += 20;
      if      (data.revenueGrowth >= 15) score += 20;
      else if (data.revenueGrowth >= 10) score += 15;
      else if (data.revenueGrowth >=  5) score += 10;
      else if (data.revenueGrowth >=  0) score += 5;
    }

    return max === 0 ? null : Math.round((score / max) * 100);
  }

  private scoreIvRank(ivRank: number | null | undefined, strategy: StrategyMode): number | null {
    if (ivRank === null || ivRank === undefined) return null;
    // Premium selling → high IV rank = rich premium → score matches rank
    // Directional     → low IV = cheaper options → invert
    // see docs/formulas.md#iv-rank-score
    if (PREMIUM_SELLING_MODES.includes(strategy)) return Math.round(ivRank);
    return Math.round(100 - ivRank);
  }

  private scorePremiumYield(premium: number | null, price: number | null): number | null {
    if (!premium || !price || price <= 0) return null;
    // Annualized monthly yield as % of stock price.
    // Target: 3%/month annualized (36%/yr) = perfect score.
    // see docs/formulas.md#premium-yield-score
    const annualYield = (premium / price) * 12 * 100;
    return Math.min(100, Math.round(annualYield / 3));
  }

  private composite(
    fundamentals: number | null,
    ivRank: number | null,
    technical: number | null,
    premiumYield: number | null,
  ): number {
    // Weights: fundamentals 25%, IV rank 30%, technical 25%, premium yield 20%
    // see docs/formulas.md#opportunity-score
    const components: Array<[number | null, number]> = [
      [fundamentals, 0.25],
      [ivRank,       0.30],
      [technical,    0.25],
      [premiumYield, 0.20],
    ];
    let sum = 0;
    let totalWeight = 0;
    for (const [v, w] of components) {
      if (v !== null) { sum += v * w; totalWeight += w; }
    }
    return totalWeight === 0 ? 0 : Math.round(sum / totalWeight);
  }
}
