// Briefing Service - Morning Briefing Dashboard data provider
// Supports Phase 7: Morning Briefing Dashboard
// see SPEC: Priority 7 - Morning Briefing

import type { DbHandle } from '../db/connection.js';
import type { HistoricalDataService } from './historical-service.js';
import type { PolygonDataProvider } from './polygon-provider.js';
import type { TokenBucketRateLimiter } from './rate-limiter.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Trend = 'bullish' | 'bearish' | 'neutral';
export type VixLevel = 'low' | 'normal' | 'high';

export interface MarketRegime {
  spyTrend: Trend;
  spyPrice: number | null;
  spySma20: number | null;
  spySma50: number | null;
  vixLevel: VixLevel;
  vixValue: number | null;
  summary: string;
}

export interface ActionItem {
  type: 'expiring' | 'delta_breach' | 'earnings';
  ticker: string;
  details: string;
  priority: 'high' | 'medium' | 'low';
  positionId?: number;
  daysRemaining?: number;
  delta?: number;
  expirationDate?: string;
}

export interface TopSetup {
  ticker: string;
  roe: number | null;
  peRatio: number | null;
  debtToEquity: number | null;
  marketCap: number | null;
  fcfYield: number | null;
  currentIv: number | null;       // ATM implied volatility as percentage (e.g., 28.5)
  wheelSuitability: number | null;
  targetStrike: number | null;
  estimatedPremium: number | null;
  expiryDate: string | null;
  lastPrice: number | null;
}

export interface BriefingData {
  generatedAt: string;
  marketRegime: MarketRegime;
  actionItems: ActionItem[];
  topSetups: TopSetup[];
}

// ─── Service Implementation ───────────────────────────────────────────────────

export class BriefingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefingError';
  }
}

export class BriefingService {
  private readonly getPositionsExpiringStmt;
  private readonly getPositionsByTickerStmt;
  private readonly getScreenResultsStmt;

  constructor(
    private readonly db: DbHandle,
    private readonly historicalService: HistoricalDataService,
    private readonly dataProvider: PolygonDataProvider,
    private readonly rateLimiter: TokenBucketRateLimiter
  ) {
    // Get positions expiring within days
    this.getPositionsExpiringStmt = db.prepare(`
      SELECT * FROM positions
      WHERE status = 'open'
        AND expiration_date IS NOT NULL
        AND julianday(expiration_date) - julianday('now') <= ?
      ORDER BY expiration_date ASC
    `);

    // Get positions by ticker
    this.getPositionsByTickerStmt = db.prepare(`
      SELECT * FROM positions
      WHERE ticker = ? AND status = 'open'
    `);

    // Get top screen results for quality stocks
    this.getScreenResultsStmt = db.prepare(`
      SELECT sr.* FROM screen_results sr
      JOIN screen_runs s ON sr.screen_run_id = s.id
      WHERE json_extract(sr.payload_json, '$.roe') > 15
        AND json_extract(sr.payload_json, '$.debtToEquity') < 1.0
        AND json_extract(sr.payload_json, '$.marketCap') > 10000000000
      ORDER BY s.run_at DESC
      LIMIT 50
    `);
  }

  // ─── Market Regime Detection ─────────────────────────────────────────────────

  async getMarketRegime(): Promise<MarketRegime> {
    try {
      // Fetch SPY data for trend calculation
      await this.rateLimiter.acquire(1);
      const spyQuote = await this.dataProvider.getQuote('SPY');
      const spyPrice = spyQuote?.last ?? null;

      // Get historical SPY prices for SMA calculation
      const spyPrices = await this.historicalService.getPrices({
        ticker: 'SPY',
        fromDate: this.getDateDaysAgo(60),
        toDate: new Date().toISOString().slice(0, 10)
      });

      // Calculate SMAs
      const sma20 = this.calculateSMA(spyPrices.map(p => p.close), 20);
      const sma50 = this.calculateSMA(spyPrices.map(p => p.close), 50);

      // Determine trend
      let spyTrend: Trend = 'neutral';
      if (spyPrice && sma20 && sma50) {
        if (spyPrice > sma20 && sma20 > sma50) {
          spyTrend = 'bullish';
        } else if (spyPrice < sma20 && sma20 < sma50) {
          spyTrend = 'bearish';
        }
      }

      // Fetch VIX
      let vixValue: number | null = null;
      let vixLevel: VixLevel = 'normal';
      try {
        await this.rateLimiter.acquire(1);
        const vixQuote = await this.dataProvider.getQuote('VIX');
        vixValue = vixQuote?.last ?? null;
        if (vixValue !== null) {
          if (vixValue < 15) vixLevel = 'low';
          else if (vixValue > 25) vixLevel = 'high';
          else vixLevel = 'normal';
        }
      } catch {
        // VIX may not be available from all providers
      }

      // Generate summary
      let summary = '';
      if (spyTrend === 'bullish') {
        summary = vixLevel === 'low'
          ? 'Strong bullish environment - consider wheel strategies'
          : 'Bullish trend with elevated volatility - defensive positioning recommended';
      } else if (spyTrend === 'bearish') {
        summary = 'Bearish trend - focus on cash-secured puts and defensive plays';
      } else {
        summary = 'Neutral market - stock picking matters';
      }

      return {
        spyTrend,
        spyPrice,
        spySma20: sma20,
        spySma50: sma50,
        vixLevel,
        vixValue,
        summary
      };
    } catch (err) {
      console.error('[BriefingService] Market regime error:', err);
      return {
        spyTrend: 'neutral',
        spyPrice: null,
        spySma20: null,
        spySma50: null,
        vixLevel: 'normal',
        vixValue: null,
        summary: 'Market data unavailable'
      };
    }
  }

  // ─── Action Items ───────────────────────────────────────────────────────────

  async getActionItems(): Promise<ActionItem[]> {
    const actions: ActionItem[] = [];

    // 1. Positions expiring within 5 days
    try {
      const expiringPositions = this.getPositionsExpiringStmt.all(5) as Array<{
        id: number;
        ticker: string;
        expiration_date: string;
        position_type: string;
      }>;

      for (const pos of expiringPositions) {
        const daysRemaining = Math.ceil(
          (new Date(pos.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );

        actions.push({
          type: 'expiring',
          ticker: pos.ticker,
          details: `${pos.position_type} expires in ${daysRemaining} days`,
          priority: daysRemaining <= 2 ? 'high' : 'medium',
          positionId: pos.id,
          daysRemaining,
          expirationDate: pos.expiration_date
        });
      }
    } catch (err) {
      console.error('[BriefingService] Expiring positions error:', err);
    }

    // 2. Delta breach alerts (simplified - would need options data)
    // This is a placeholder for when options data is available

    // 3. Earnings alerts (simplified - would need earnings calendar)
    // This is a placeholder for when earnings data is available

    return actions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  // ─── Top Setups ─────────────────────────────────────────────────────────────

  async getTopSetups(): Promise<TopSetup[]> {
    // US market holidays (month is 1-based). Juneteenth added 2022.
    function isMarketHoliday(d: Date): boolean {
      const m = d.getMonth() + 1, day = d.getDate(), dow = d.getDay();
      // Fixed-date holidays — if they fall on Saturday observe Friday, Sunday observe Monday
      const fixedHolidays: [number, number][] = [
        [1, 1],   // New Year's Day
        [6, 19],  // Juneteenth
        [7, 4],   // Independence Day
        [12, 25], // Christmas
      ];
      for (const [hm, hd] of fixedHolidays) {
        if (m === hm) {
          // Falls on Saturday → observed Friday (day-1)
          if (day === hd - 1 && dow === 5) return true;
          // Falls on actual date (weekday)
          if (day === hd && dow >= 1 && dow <= 5) return true;
          // Falls on Sunday → observed Monday (day+1)
          if (day === hd + 1 && dow === 1) return true;
        }
      }
      // Floating holidays
      const y = d.getFullYear();
      // MLK Day — 3rd Monday of January
      if (m === 1 && dow === 1 && day >= 15 && day <= 21) return true;
      // Presidents Day — 3rd Monday of February
      if (m === 2 && dow === 1 && day >= 15 && day <= 21) return true;
      // Memorial Day — last Monday of May
      if (m === 5 && dow === 1 && day >= 25) return true;
      // Labor Day — 1st Monday of September
      if (m === 9 && dow === 1 && day <= 7) return true;
      // Thanksgiving — 4th Thursday of November
      if (m === 11 && dow === 4 && day >= 22 && day <= 28) return true;
      void y;
      return false;
    }

    // Nearest 3rd-Friday monthly expiry at least 25 days out, shifted back for holidays.
    function nextMonthlyExpiry(): string {
      const earliest = new Date();
      earliest.setDate(earliest.getDate() + 25);
      let year = earliest.getFullYear();
      let month = earliest.getMonth();
      for (;;) {
        const firstDow = new Date(year, month, 1).getDay();
        let expiry = new Date(year, month, 1 + ((5 - firstDow + 7) % 7) + 14);
        // If the 3rd Friday is a market holiday, use the preceding Thursday
        if (isMarketHoliday(expiry)) expiry.setDate(expiry.getDate() - 1);
        if (expiry >= earliest) return expiry.toISOString().split('T')[0]!;
        if (++month > 11) { month = 0; year++; }
      }
    }
    try {
      // Query quality stocks from recent screener runs
      const results = this.db.prepare(`
        SELECT DISTINCT
          sr.ticker,
          json_extract(sr.payload_json, '$.roe') as roe,
          json_extract(sr.payload_json, '$.peRatio') as pe_ratio,
          json_extract(sr.payload_json, '$.debtToEquity') as debt_to_equity,
          json_extract(sr.payload_json, '$.marketCap') as market_cap,
          json_extract(sr.payload_json, '$.freeCashFlow') as fcf,
          json_extract(sr.payload_json, '$.lastPrice') as last_price
        FROM screen_results sr
        JOIN screen_runs s ON sr.screen_run_id = s.id
        WHERE s.run_at = (
          SELECT MAX(run_at) FROM screen_runs
        )
        AND json_extract(sr.payload_json, '$.roe') IS NOT NULL
        AND CAST(json_extract(sr.payload_json, '$.roe') AS REAL) > 15
        AND json_extract(sr.payload_json, '$.debtToEquity') IS NOT NULL
        AND CAST(json_extract(sr.payload_json, '$.debtToEquity') AS REAL) < 1.0
        AND json_extract(sr.payload_json, '$.marketCap') IS NOT NULL
        AND CAST(json_extract(sr.payload_json, '$.marketCap') AS REAL) > 10000000000
        ORDER BY CAST(json_extract(sr.payload_json, '$.roe') AS REAL) DESC
        LIMIT 15
      `).all() as Array<{
        ticker: string;
        roe: string;
        pe_ratio: string;
        debt_to_equity: string;
        market_cap: string;
        fcf: string;
        last_price: string;
      }>;

      const expiryDate = nextMonthlyExpiry();

      // Compute per-ticker strikes upfront so the premium fetch has a target
      const tickerMeta = results.map(r => ({
        ticker:      r.ticker,
        roe:         parseFloat(r.roe)           || null,
        peRatio:     parseFloat(r.pe_ratio)      || null,
        debtToEquity:parseFloat(r.debt_to_equity)|| null,
        marketCap:   parseFloat(r.market_cap)    || null,
        fcf:         parseFloat(r.fcf)           || null,
        lastPrice:   parseFloat(r.last_price)    || null,
        targetStrike:(parseFloat(r.last_price) || 0) * 0.92 || null
      }));

      // Single options snapshot call per ticker → extracts IV + nearest put premium
      const marketDataPromises = tickerMeta.map(async (m) => {
        const result = await this.dataProvider
          .getOptionsIVAndPremium(m.ticker, expiryDate, m.targetStrike)
          .catch(() => ({ currentIv: null, iv52WkHigh: null, iv52WkLow: null, putPremium: null }));
        return { ticker: m.ticker, currentIv: result.currentIv, livePremium: result.putPremium };
      });
      const marketData = await Promise.all(marketDataPromises);
      const mdMap = new Map(marketData.map(d => [d.ticker, d]));

      const setups: TopSetup[] = tickerMeta.map(m => {
        const md = mdMap.get(m.ticker);
        const currentIv = md?.currentIv ?? null;
        const wheelSuitability = this.calculateWheelSuitability(m.roe, m.debtToEquity, m.marketCap);
        const estimatedPremium = md?.livePremium ?? (m.targetStrike ? m.targetStrike * 0.012 : null);
        const fcfYield = m.marketCap && m.fcf ? (m.fcf / m.marketCap) * 100 : null;

        return {
          ticker:        m.ticker,
          roe:           m.roe,
          peRatio:       m.peRatio,
          debtToEquity:  m.debtToEquity,
          marketCap:     m.marketCap,
          fcfYield,
          currentIv,
          wheelSuitability,
          targetStrike:  m.targetStrike,
          estimatedPremium,
          expiryDate,
          lastPrice:     m.lastPrice
        };
      });

      return setups;
    } catch (err) {
      console.error('[BriefingService] Top setups error:', err);
      return [];
    }
  }

  // ─── Full Briefing ──────────────────────────────────────────────────────────

  async getFullBriefing(): Promise<BriefingData> {
    const [marketRegime, actionItems, topSetups] = await Promise.all([
      this.getMarketRegime(),
      this.getActionItems(),
      this.getTopSetups()
    ]);

    return {
      generatedAt: new Date().toISOString(),
      marketRegime,
      actionItems,
      topSetups
    };
  }

  // ─── Helper Methods ─────────────────────────────────────────────────────────

  private calculateSMA(prices: number[], period: number): number | null {
    if (prices.length < period) return null;
    const recent = prices.slice(-period);
    const sum = recent.reduce((a, b) => a + b, 0);
    return sum / period;
  }

  private getDateDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  }

  private calculateWheelSuitability(
    roe: number | null,
    de: number | null,
    marketCap: number | null
  ): number | null {
    if (!roe || !de || !marketCap) return null;

    // Simplified wheel suitability calculation
    const roeComponent = Math.min((roe / 30) * 100, 100) * 0.30;
    const deComponent = de < 1.0 ? 100 : Math.max(0, 100 - (de - 1) * 50) * 0.30;

    let marketCapScore = 25;
    if (marketCap > 50_000_000_000) marketCapScore = 100;
    else if (marketCap > 10_000_000_000) marketCapScore = 75;
    else if (marketCap > 1_000_000_000) marketCapScore = 50;
    const marketCapComponent = marketCapScore * 0.20;

    // Stability component (simplified)
    const stabilityComponent = 25 * 0.25;

    return Math.round(roeComponent + deComponent + marketCapComponent + stabilityComponent);
  }
}
