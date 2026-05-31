// Filter Templates Service — pre-built criteria that scan watchlist or universe tickers.
// Each template defines what data to fetch and a condition to evaluate.
// Results include matching tickers with their metric values.

import type { DbHandle } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import type { IvHistoryService } from './iv-history-service.js';
import type { Universe, Quote } from '@shared/types.js';
import { QuoteCache, FundamentalsCache } from './cache-service.js';
import { computeRSI, computeSMA } from './analysis-service.js';
import { calculateWheelSuitability } from './wheel-calculator.js';
import { FILTER_TEMPLATES } from '@shared/filter-templates.js';
import type { FilterTemplate, FilterTemplateResult } from '@shared/types.js';
import type { ConstituentsService } from './constituents-service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TickerSource {
  ticker: string;
  watchlists: string[];
}

export interface FilterProgress {
  current: number;
  total: number;
  ticker: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class FilterTemplatesService {
  private ivHistoryService?: IvHistoryService;

  constructor(
    private readonly db: DbHandle,
    private readonly dataProvider: DataProvider,
    private readonly optionsProvider: OptionsProvider | null,
    private readonly quoteCache: QuoteCache,
    private readonly fundamentalsCache: FundamentalsCache,
    private readonly constituentsService: ConstituentsService
  ) {}

  /** Wire up IV history after construction (avoids circular init ordering). */
  setIvHistoryService(svc: IvHistoryService): void {
    this.ivHistoryService = svc;
  }

  listTemplates(): FilterTemplate[] {
    return FILTER_TEMPLATES;
  }

  async runTemplate(
    templateId: string,
    source: 'watchlist' | 'universe' = 'watchlist',
    universe?: Universe,
    watchlistIds?: number[],
    onProgress?: (progress: FilterProgress) => void
  ): Promise<FilterTemplateResult[]> {
    const template = FILTER_TEMPLATES.find(t => t.id === templateId);
    if (!template) throw new Error(`Unknown filter template: ${templateId}`);

    let tickers: TickerSource[];
    if (source === 'universe') {
      tickers = this.getUniverseTickers(universe ?? 'both');
    } else {
      tickers = this.getWatchlistTickers(watchlistIds);
    }

    if (tickers.length === 0) return [];

    const results: FilterTemplateResult[] = [];
    const total = tickers.length;
    const isEtf = universe === 'etf';

    for (let i = 0; i < total; i++) {
      const { ticker, watchlists } = tickers[i]!;
      onProgress?.({ current: i + 1, total, ticker });
      try {
        const result = await this.evaluateTemplate(template, ticker, watchlists, isEtf);
        if (result) results.push(result);
      } catch {
        // Skip tickers where data fetch fails — they just won't appear in results.
      }
    }

    return results;
  }

  // ─── Private: gather tickers from watchlists ──────────────────────────────────

  private getWatchlistTickers(watchlistIds?: number[]): TickerSource[] {
    let rows: Array<{ ticker: string; watchlist_name: string }>;

    if (watchlistIds && watchlistIds.length > 0) {
      const placeholders = watchlistIds.map(() => '?').join(',');
      rows = this.db.prepare(`
        SELECT wi.ticker, w.name AS watchlist_name
        FROM watchlist_items wi
        JOIN watchlists w ON w.id = wi.watchlist_id
        WHERE wi.watchlist_id IN (${placeholders})
      `).all(...watchlistIds) as Array<{ ticker: string; watchlist_name: string }>;
    } else {
      rows = this.db.prepare(`
        SELECT wi.ticker, w.name AS watchlist_name
        FROM watchlist_items wi
        JOIN watchlists w ON w.id = wi.watchlist_id
      `).all() as Array<{ ticker: string; watchlist_name: string }>;
    }

    // Deduplicate tickers, collecting which watchlists they belong to.
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const existing = map.get(r.ticker) ?? [];
      if (!existing.includes(r.watchlist_name)) existing.push(r.watchlist_name);
      map.set(r.ticker, existing);
    }

    return Array.from(map.entries()).map(([ticker, watchlists]) => ({ ticker, watchlists }));
  }

  // ─── Private: gather tickers from screener universe ──────────────────────────

  private getUniverseTickers(universe: Universe): TickerSource[] {
    const constituents = this.constituentsService.getConstituents(universe);
    const label =
      universe === 'sp500'       ? 'S&P 500' :
      universe === 'russell1000' ? 'Russell 1000' :
      universe === 'etf'         ? 'ETFs' :
      'Universe';
    return constituents.map(c => ({ ticker: c.ticker, watchlists: [label] }));
  }

  // ─── Private: evaluate a single template for one ticker ──────────────────────

  private async evaluateTemplate(
    template: FilterTemplate,
    ticker: string,
    watchlists: string[],
    isEtf = false
  ): Promise<FilterTemplateResult | null> {
    switch (template.id) {
      case 'rsi_overbought':
        return this.evalRSI(ticker, watchlists, 'overbought');
      case 'rsi_oversold':
        return this.evalRSI(ticker, watchlists, 'oversold');
      case 'iv_rank_low':
        return this.evalIVRank(ticker, watchlists, 'low', isEtf);
      case 'iv_rank_high':
        return this.evalIVRank(ticker, watchlists, 'high', isEtf);
      case 'price_alert':
        return this.evalPriceAlert(ticker, watchlists);
      case 'assignment_risk':
        return this.evalAssignmentRisk(ticker, watchlists);
      case 'wheel_opportunity':
        return this.evalWheelOpportunity(ticker, watchlists, isEtf);
      default:
        return null;
    }
  }

  // ─── Template evaluators ─────────────────────────────────────────────────────

  private async evalRSI(
    ticker: string,
    watchlists: string[],
    direction: 'overbought' | 'oversold'
  ): Promise<FilterTemplateResult | null> {
    const bars = await this.fetchBars(ticker);
    if (!bars || bars.length < 15) return null;

    const rsiArr = computeRSI(bars, 14);
    const rsi = rsiArr[rsiArr.length - 1] ?? null;
    if (rsi === null) return null;

    const threshold = direction === 'overbought' ? 70 : 30;
    const matches = direction === 'overbought' ? rsi >= threshold : rsi <= threshold;
    if (!matches) return null;

    const label = direction === 'overbought' ? 'Overbought' : 'Oversold';
    return {
      ticker,
      watchlists,
      lastPrice: bars[bars.length - 1]?.c ?? null,
      metrics: { rsi: +rsi.toFixed(1) },
      matchReason: `RSI ${label} at ${rsi.toFixed(1)} (threshold: ${threshold})`
    };
  }

  private async evalIVRank(
    ticker: string,
    watchlists: string[],
    direction: 'low' | 'high',
    isEtf = false
  ): Promise<FilterTemplateResult | null> {
    // Always fetch quote for last price; use it for IV fallbacks too.
    const quote = await this.fetchQuote(ticker);

    // Resolution order — prefer local DB over live API calls:
    //   1. iv_history DB (our own computed IvRankResult — most reliable, zero API cost)
    //   2. quote_cache.iv_rank / current_iv (Polygon snapshot — usually null per CLAUDE.md)
    //   3. Live optionsProvider.getOptionsIV() — last resort, one API call per ticker

    let ivRank:    number | null = null;  // 0–100 rank
    let currentIv: number | null = null;  // ATM IV as percentage (28.5 = 28.5%)

    // 1. iv_history (fast SQLite read, no API call)
    if (this.ivHistoryService) {
      try {
        const ivh = this.ivHistoryService.getIvRank(ticker);
        ivRank    = ivh.ivRank;    // null if < 21 data points
        currentIv = ivh.currentIv; // already a percentage
      } catch { /* no iv_history data for this ticker */ }
    }

    // 2. Quote cache fallback
    if (ivRank === null && currentIv === null) {
      ivRank    = quote.ivRank;
      currentIv = quote.currentIv;
    }

    // 3. Live options API — only if still nothing
    if (ivRank === null && currentIv === null && this.optionsProvider) {
      try {
        const ivData = await this.optionsProvider.getOptionsIV(ticker);
        if (ivData.currentIv !== null) {
          currentIv = ivData.currentIv;
        }
      } catch { /* options data unavailable */ }
    }

    // Prefer IV rank (normalized 0-100) for comparison; fall back to raw IV %
    const useIvRank    = ivRank !== null;
    const compareValue = useIvRank ? ivRank! : currentIv;
    if (compareValue === null) return null;

    // Thresholds: IV Rank uses 0-100 scale; raw IV % uses absolute % thresholds.
    // ETFs have structurally lower IV than individual stocks — compress the "high" threshold
    // to 30 (matching the Opportunity Dashboard calibration: IVR 30 = elevated for ETFs).
    const threshold = useIvRank
      ? (direction === 'low' ? 20 : isEtf ? 30 : 70)
      : (direction === 'low' ? 20 : isEtf ? 20 : 35);

    const matches = direction === 'low' ? compareValue < threshold : compareValue > threshold;
    if (!matches) return null;

    const label = direction === 'low'
      ? 'low — cheap options, wait for IV expansion'
      : isEtf
        ? 'elevated for ETF — good for selling premium (ETF-calibrated threshold)'
        : 'high — elevated premium, good for selling';
    const metricLabel = useIvRank ? 'IV Rank' : 'Current IV';
    const op          = direction === 'low' ? '<' : '>';
    const suffix      = useIvRank ? '' : '% (ATM IV; IV rank unavailable)';

    // Build metrics — include both when available
    const metrics: Record<string, number | null> = {};
    if (ivRank    !== null) metrics.ivRank    = +ivRank.toFixed(1);
    if (currentIv !== null) metrics.currentIv = +currentIv.toFixed(1);

    return {
      ticker,
      watchlists,
      lastPrice: quote.last,
      metrics,
      matchReason: `${metricLabel} ${label}: ${compareValue.toFixed(1)}${useIvRank ? '' : '%'} (${op}${threshold}${useIvRank ? '' : '%'})${suffix}`
    };
  }

  private async evalPriceAlert(
    ticker: string,
    watchlists: string[]
  ): Promise<FilterTemplateResult | null> {
    const bars = await this.fetchBars(ticker);
    if (!bars || bars.length < 60) return null;

    const quote = await this.fetchQuote(ticker);
    const price = quote.last ?? bars[bars.length - 1]?.c ?? null;
    if (price === null) return null;

    const sma50Arr = computeSMA(bars, 50);
    const sma200Arr = computeSMA(bars, 200);
    const sma50 = sma50Arr[sma50Arr.length - 1] ?? null;
    const sma200 = sma200Arr[sma200Arr.length - 1] ?? null;

    // Match if price is within 5% of SMA50 or SMA200 (near key level),
    // or if SMA50 just crossed SMA200 (golden/death cross).
    const priceVsSma50 = sma50 !== null ? +((price - sma50) / sma50 * 100).toFixed(1) : null;
    const priceVsSma200 = sma200 !== null ? +((price - sma200) / sma200 * 100).toFixed(1) : null;

    const nearSma50 = priceVsSma50 !== null && Math.abs(priceVsSma50) <= 5;
    const nearSma200 = priceVsSma200 !== null && Math.abs(priceVsSma200) <= 5;

    // Detect SMA50/SMA200 crossover (golden cross or death cross) in last 5 bars.
    let crossType: 'golden' | 'death' | null = null;
    if (sma50 !== null && sma200 !== null && bars.length >= 200) {
      for (let i = bars.length - 1; i >= Math.max(0, bars.length - 5); i--) {
        const prev50 = sma50Arr[i - 1] ?? null;
        const prev200 = sma200Arr[i - 1] ?? null;
        const curr50 = sma50Arr[i] ?? null;
        const curr200 = sma200Arr[i] ?? null;
        if (prev50 !== null && prev200 !== null && curr50 !== null && curr200 !== null) {
          if (prev50 <= prev200 && curr50 > curr200) { crossType = 'golden'; break; }
          if (prev50 >= prev200 && curr50 < curr200) { crossType = 'death'; break; }
        }
      }
    }

    if (!nearSma50 && !nearSma200 && !crossType) return null;

    const reasons: string[] = [];
    if (nearSma50) reasons.push(`within 5% of SMA50 ($${sma50?.toFixed(2)})`);
    if (nearSma200) reasons.push(`within 5% of SMA200 ($${sma200?.toFixed(2)})`);
    if (crossType === 'golden') reasons.push('Golden cross (SMA50 crossed above SMA200)');
    if (crossType === 'death') reasons.push('Death cross (SMA50 crossed below SMA200)');

    return {
      ticker,
      watchlists,
      lastPrice: price,
      metrics: {
        priceVsSma50,
        priceVsSma200
      },
      matchReason: reasons.join('; ')
    };
  }

  private async evalAssignmentRisk(
    ticker: string,
    watchlists: string[]
  ): Promise<FilterTemplateResult | null> {
    if (!this.optionsProvider) return null;

    try {
      const expirations = await this.getNearTermExpirations(ticker, 4);
      for (const exp of expirations) {
        const chain = await this.optionsProvider.getOptionsChain(ticker, exp);
        const dte = this.dteDays(exp);
        // Look for short puts with delta <= -0.70 (absolute >= 0.70).
        const riskyPuts = chain.contracts.filter(
          c => c.side === 'put' && c.delta !== null && Math.abs(c.delta) >= 0.70 && c.bid > 0
        );
        if (riskyPuts.length === 0) continue;

        // Pick the one closest to ATM (highest absolute delta).
        const worst = riskyPuts.reduce((a, b) =>
          Math.abs(a.delta ?? 0) > Math.abs(b.delta ?? 0) ? a : b
        );

        return {
          ticker,
          watchlists,
          lastPrice: worst.bid ?? null,
          metrics: {
            delta: +(Math.abs(worst.delta ?? 0)).toFixed(2),
            strike: worst.strike,
            dte
          },
          matchReason: `Short put at $${worst.strike} strike, delta ${Math.abs(worst.delta ?? 0).toFixed(2)}, ${dte} DTE — assignment risk`
        };
      }
    } catch {
      // No options data available for this ticker.
    }
    return null;
  }

  private async evalWheelOpportunity(
    ticker: string,
    watchlists: string[],
    isEtf = false
  ): Promise<FilterTemplateResult | null> {
    const quote = await this.fetchQuote(ticker);

    // Prefer iv_history currentIv (already %) over quote cache
    let currentIv: number | null = quote.currentIv;
    let ivRank: number | null = null;
    if (this.ivHistoryService) {
      try {
        const ivh = this.ivHistoryService.getIvRank(ticker);
        if (ivh.currentIv !== null) currentIv = ivh.currentIv;
        ivRank = ivh.ivRank;
      } catch { /* no iv_history data */ }
    }

    if (isEtf) {
      // ETFs don't have P/E, ROE, D/E etc. — skip calculateWheelSuitability.
      // All ETFs in our curated list are wheel-eligible by design (liquid, optionable).
      // Require at minimum that we have a valid price.
      if (quote.last === null) return null;
      return {
        ticker,
        watchlists,
        lastPrice: quote.last,
        metrics: {
          suitabilityScore: null,
          ...(currentIv !== null ? { currentIv: +currentIv.toFixed(1) } : {}),
          ...(ivRank !== null ? { ivRank: +ivRank.toFixed(1) } : {}),
          targetStrike: +(quote.last * 0.92).toFixed(2)
        },
        matchReason: `ETF — wheel eligible by default (liquid, optionable)${ivRank !== null ? `; IV Rank ${ivRank.toFixed(0)}` : ''}`
      };
    }

    const ratios = await this.fetchFundamentals(ticker);
    const suitabilityScore = calculateWheelSuitability(ratios, quote);
    if (suitabilityScore < 60) return null;

    return {
      ticker,
      watchlists,
      lastPrice: quote.last,
      metrics: {
        suitabilityScore,
        ...(currentIv !== null ? { currentIv: +currentIv.toFixed(1) } : {}),
        targetStrike: quote.last !== null ? +(quote.last * 0.92).toFixed(2) : null
      },
      matchReason: `Wheel suitability score: ${suitabilityScore}/100`
    };
  }

  // ─── Data fetch helpers ──────────────────────────────────────────────────────

  private async fetchQuote(ticker: string): Promise<Quote> {
    // Try cache first.
    try {
      const cached = this.quoteCache.get(ticker);
      if (cached && !this.quoteCache.isStale(ticker)) {
        return {
          ticker: cached.ticker,
          last: cached.last,
          prevClose: cached.prevClose,
          bid: cached.bid,
          ask: cached.ask,
          volume: cached.volume,
          dayHigh: cached.dayHigh,
          dayLow: cached.dayLow,
          ivRank: cached.ivRank,
          ivPercentile: cached.ivPercentile,
          currentIv: cached.currentIv,
          fetchedAt: cached.fetchedAt
        };
      }
    } catch { /* fall through */ }

    const snap = await this.dataProvider.getQuote(ticker);
    const q: Quote = {
      ticker,
      last: snap.last ?? null,
      prevClose: snap.prevClose ?? null,
      bid: snap.bid ?? null,
      ask: snap.ask ?? null,
      volume: snap.volume ?? null,
      dayHigh: snap.dayHigh ?? null,
      dayLow: snap.dayLow ?? null,
      ivRank: snap.ivRank ?? null,
      ivPercentile: snap.ivPercentile ?? null,
      currentIv: null,
      fetchedAt: new Date().toISOString()
    };
    try { this.quoteCache.upsert(q); } catch { /* best effort */ }
    return q;
  }

  private async fetchBars(ticker: string) {
    // Request 400 calendar days — getHistoricalBars converts lookback to a date
    // range using calendar days, so 400 ≈ 285 trading bars, enough for SMA-200.
    const bars = await this.dataProvider.getHistoricalBars(ticker, 'day', 400);
    return bars.length >= 15 ? bars : null;
  }

  private async fetchFundamentals(ticker: string) {
    try {
      const cached = this.fundamentalsCache.get(ticker);
      if (cached && !this.fundamentalsCache.isStale(ticker)) return cached.ratios;
      const ratios = await this.dataProvider.getFundamentals(ticker);
      try { this.fundamentalsCache.upsert(ticker, ratios); } catch { /* best effort */ }
      return ratios;
    } catch {
      return {
        peRatio: null, eps: null, marketCap: null, debtToEquity: null,
        roe: null, profitMargin: null, revenueGrowth: null, epsGrowth: null,
        freeCashFlow: null, currentRatio: null, dividendYield: null, beta: null,
        sector: null, industry: null, companyName: null
      };
    }
  }

  private async getNearTermExpirations(ticker: string, count = 7): Promise<string[]> {
    const expirations: string[] = [];
    const now = new Date();
    const day = now.getUTCDay();
    const daysUntilFriday = (5 - day + 7) % 7;
    const firstFriday = new Date(now);
    firstFriday.setUTCDate(now.getUTCDate() + daysUntilFriday);
    for (let w = 0; w < count; w++) {
      const d = new Date(firstFriday);
      d.setUTCDate(firstFriday.getUTCDate() + w * 7);
      expirations.push(d.toISOString().slice(0, 10));
    }
    return expirations;
  }

  private dteDays(expiration: string): number {
    const exp = new Date(expiration);
    const now = new Date();
    return Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  }
}