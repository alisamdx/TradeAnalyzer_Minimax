// Filter Templates Service — pre-built criteria that scan watchlist or universe tickers.
// Each template defines what data to fetch and a condition to evaluate.
// Results include matching tickers with their metric values.

import type { DbHandle } from '../db/connection.js';
import type { DataProvider } from './data-provider.js';
import type { OptionsProvider } from './options-provider.js';
import type { IvHistoryService } from './iv-history-service.js';
import type { Universe, Quote, OptionContract } from '@shared/types.js';
import { QuoteCache, FundamentalsCache } from './cache-service.js';
import { computeRSI, computeSMA } from './analysis-service.js';
import { calculateWheelSuitability } from './wheel-calculator.js';
import { FILTER_TEMPLATES, FILTER_RESULTS_SHAPE_VERSION } from '@shared/filter-templates.js';
import type { FilterTemplate, FilterTemplateResult, FilterSavedRun } from '@shared/types.js';
import type { ConstituentsService } from './constituents-service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TickerSource {
  ticker: string;
  watchlists: string[];
  /** ETF names get ETF-calibrated thresholds (lower IV bars, no fundamentals gate). */
  isEtf: boolean;
}

export interface FilterProgress {
  current: number;
  total: number;
  ticker: string;
}

// ─── Wheel (Vetted) — pure helpers + thresholds (unit-tested) ──────────────────

export interface WheelVettedThresholds {
  minSuitability: number;       // fundamentals gate (Tier 1)
  minDte: number;               // nearest monthly at least this many calendar days out
  targetDelta: number;          // target short-put |delta| (e.g. 0.30)
  minOi: number;                // open-interest floor on the target put
  maxSpreadPct: number;         // max bid/ask spread as % of mid
  minAnnualizedReturn: number;  // "real premium" floor — annualized CSP yield % (individual names)
  minAnnualizedReturnEtf: number; // lower premium floor for ETFs (much lower risk → accept less yield)
  maxIvPct: number;             // IV ceiling (%) on the target put — excludes vol-bombs
}

// Balanced defaults (user-selected). No IV gate at Tier 1: iv_history only covers tracked
// names, so a universe-wide IV floor would reject almost everything — the annualized-return
// floor (computed from the live chain in Tier 2) is the premium gate instead.
export const WHEEL_VETTED_DEFAULTS: WheelVettedThresholds = {
  minSuitability: 75, minDte: 25, targetDelta: 0.30, minOi: 250, maxSpreadPct: 15,
  minAnnualizedReturn: 15, minAnnualizedReturnEtf: 8, maxIvPct: 80,
};

/** Nearest standard monthly expiry (3rd Friday) that is ≥ minDte calendar days out.
 *  All UTC — never mix local weekday math with toISOString (see CLAUDE.md weekly-expiry quirk). */
export function thirdFridayOnOrAfter(minDte: number, now: number = Date.now()): string {
  const earliest = now + minDte * 86_400_000;
  const d = new Date(earliest);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth();
  for (;;) {
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun … 6=Sat
    const toFirstFriday = (5 - firstDow + 7) % 7;
    const thirdFriday = Date.UTC(year, month, 1 + toFirstFriday + 14);
    if (thirdFriday >= earliest) return new Date(thirdFriday).toISOString().slice(0, 10);
    if (++month > 11) { month = 0; year++; }
  }
}

/** Pick the put whose |delta| is closest to targetDelta; fall back to the strike nearest
 *  to `spot × (1 − targetDelta)` (~ the OTM strike) when deltas are missing. Requires a two-sided quote. */
export function pickWheelPut(puts: OptionContract[], spot: number, targetDelta: number): OptionContract | null {
  const quoted = puts.filter(p => p.side === 'put' && p.bid > 0 && p.ask > 0);
  if (quoted.length === 0) return null;
  const withDelta = quoted.filter(p => p.delta != null);
  if (withDelta.length > 0) {
    return withDelta.reduce((best, p) =>
      Math.abs(Math.abs(p.delta!) - targetDelta) < Math.abs(Math.abs(best.delta!) - targetDelta) ? p : best);
  }
  const targetStrike = spot * (1 - targetDelta);
  return quoted.reduce((best, p) => (Math.abs(p.strike - targetStrike) < Math.abs(best.strike - targetStrike) ? p : best));
}

/** Annualized cash-secured-put yield on strike-secured capital: (credit/strike) × (365/DTE).
 *  see docs/formulas.md#annualized-options-return */
export function annualizedCspYield(creditPerShare: number, strike: number, dte: number): number | null {
  if (strike <= 0 || dte <= 0) return null;
  return (creditPerShare / strike) * (365 / dte) * 100;
}

/** Risk-adjusted CSP yield: annualized yield discounted by assignment probability (|delta|).
 *  With a fixed ~0.30Δ target this is a mild, near-uniform discount — it favors the further-OTM
 *  puts within the target cluster; the IV ceiling is the primary vol-risk control. */
export function riskAdjustedYield(annualized: number | null, delta: number | null): number | null {
  if (annualized == null) return null;
  const assignProb = delta != null ? Math.min(1, Math.abs(delta)) : 0.30;
  return annualized * (1 - assignProb);
}

export interface WheelPutAssessment {
  pass: boolean;
  oi: number;
  spreadPct: number;
  creditPerShare: number;
  annualizedReturn: number | null;
  riskAdjustedReturn: number | null;
  ivPct: number | null;
}

/** Apply the Tier-2 liquidity + premium + vol gate to a chosen put. Pure. */
export function assessWheelPut(put: OptionContract, dte: number, t: WheelVettedThresholds): WheelPutAssessment {
  const oi = put.openInterest ?? 0;
  const mid = (put.bid + put.ask) / 2;
  const spreadPct = mid > 0 ? ((put.ask - put.bid) / mid) * 100 : Infinity;
  const ivPct = put.iv > 0 ? put.iv * 100 : null;
  const annualizedReturn = annualizedCspYield(mid, put.strike, dte);
  const riskAdjustedReturn = riskAdjustedYield(annualizedReturn, put.delta);
  const pass = oi >= t.minOi
    && spreadPct <= t.maxSpreadPct
    && annualizedReturn != null && annualizedReturn >= t.minAnnualizedReturn
    && (ivPct == null || ivPct <= t.maxIvPct);     // exclude vol-bombs (IV unknown ⇒ don't gate on it)
  return { pass, oi, spreadPct, creditPerShare: mid, annualizedReturn, riskAdjustedReturn, ivPct };
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
    onProgress?: (progress: FilterProgress) => void,
    signal?: AbortSignal
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

    for (let i = 0; i < total; i++) {
      if (signal?.aborted) break;
      const { ticker, watchlists, isEtf } = tickers[i]!;
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

  // ─── Batch prefill persistence (filter_template_runs — latest run per template) ──

  /** Overwrite the stored batch run for a template (one row per template, latest only). */
  saveRun(templateId: string, universe: Universe, results: FilterTemplateResult[], ranAt = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO filter_template_runs (template_id, ran_at, universe, result_count, results_json, shape_version)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(template_id) DO UPDATE SET
        ran_at        = excluded.ran_at,
        universe      = excluded.universe,
        result_count  = excluded.result_count,
        results_json  = excluded.results_json,
        shape_version = excluded.shape_version
    `).run(templateId, ranAt, universe, results.length, JSON.stringify(results), FILTER_RESULTS_SHAPE_VERSION);
  }

  /** All stored batch runs whose shape matches the current build (stale shapes are ignored). */
  getSavedRuns(): FilterSavedRun[] {
    const rows = this.db.prepare(`
      SELECT template_id, ran_at, universe, result_count, results_json
      FROM filter_template_runs WHERE shape_version = ?
    `).all(FILTER_RESULTS_SHAPE_VERSION) as Array<{
      template_id: string; ran_at: string; universe: string; result_count: number; results_json: string;
    }>;
    const runs: FilterSavedRun[] = [];
    for (const r of rows) {
      try {
        runs.push({
          templateId: r.template_id,
          ranAt: r.ran_at,
          universe: r.universe as Universe,
          resultCount: r.result_count,
          results: JSON.parse(r.results_json) as FilterTemplateResult[],
        });
      } catch { /* unparseable row — skip */ }
    }
    return runs;
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

    // Watchlist scans keep stock calibration for every name (pre-existing behavior).
    return Array.from(map.entries()).map(([ticker, watchlists]) => ({ ticker, watchlists, isEtf: false }));
  }

  // ─── Private: gather tickers from screener universe ──────────────────────────

  private getUniverseTickers(universe: Universe): TickerSource[] {
    // For 'etf' and 'all', ETF membership drives per-ticker calibration (ETF thresholds,
    // no fundamentals gate). 'all' mixes stocks and ETFs in one scan, so the flag must be
    // per-ticker — a universe-wide flag would mis-calibrate one side or the other.
    const etfTickers = (universe === 'etf' || universe === 'all')
      ? new Set(this.constituentsService.getConstituents('etf').map(c => c.ticker))
      : new Set<string>();
    const constituents = this.constituentsService.getConstituents(universe);
    const label =
      universe === 'sp500'       ? 'S&P 500' :
      universe === 'russell1000' ? 'Russell 1000' :
      universe === 'etf'         ? 'ETFs' :
      universe === 'all'         ? 'All' :
      'Universe';
    return constituents.map(c => {
      const isEtf = etfTickers.has(c.ticker);
      return {
        ticker: c.ticker,
        watchlists: [universe === 'all' && isEtf ? 'ETF' : label],
        isEtf,
      };
    });
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
      case 'wheel_vetted':
        return this.evalWheelVetted(ticker, watchlists, isEtf);
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
      // Use IV rank as the suitability proxy so the Score column + sort still work
      // (higher IV rank = richer premium = better wheel opportunity for ETFs).
      if (quote.last === null) return null;
      const etfScore = ivRank !== null ? Math.round(ivRank) : 50;
      return {
        ticker,
        watchlists,
        lastPrice: quote.last,
        metrics: {
          suitabilityScore: etfScore,
          ...(currentIv !== null ? { currentIv: +currentIv.toFixed(1) } : {}),
          targetStrike: +(quote.last * 0.92).toFixed(2)
        },
        matchReason: `ETF — wheel eligible (score = IV Rank${ivRank !== null ? ` ${ivRank.toFixed(0)}` : '; no IV data, defaulted to 50'})`
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

  /**
   * Vetted wheel — a two-stage funnel (see WHEEL_VETTED_DEFAULTS):
   *   Tier 1 (cheap, cached): fundamentals → wheel suitability ≥ threshold. Rejects here cost no
   *          option-chain call, so only genuine foundation candidates reach Tier 2.
   *   Tier 2 (one option-chain call per survivor): fetch the nearest MONTHLY expiry, target the
   *          ~0.30Δ put, and require open interest ≥ 100, a tight bid/ask spread, and a real
   *          annualized premium. This is the liquidity + monthly-expiry gate the loose
   *          `wheel_opportunity` template lacks (which is why that one returns ~792 names).
   */
  private async evalWheelVetted(
    ticker: string,
    watchlists: string[],
    isEtf = false,
  ): Promise<FilterTemplateResult | null> {
    if (!this.optionsProvider) return null;

    const t = WHEEL_VETTED_DEFAULTS;

    const quote = await this.fetchQuote(ticker);
    if (quote.last == null || quote.last <= 0) return null;

    // ── Tier 1: foundation (no option call) ──
    // Individual names must clear the fundamentals bar. ETFs have no fundamentals (P/E, ROE, D/E)
    // but the curated ETF list is wheel-eligible by design — liquid, optionable, and free of
    // single-name blow-up risk — so we skip the suitability gate and use IV rank as a proxy score,
    // mirroring the loose `wheel_opportunity` template. The Tier-2 options gate does the real work.
    let suitabilityScore: number;
    if (isEtf) {
      let ivRank: number | null = null;
      if (this.ivHistoryService) {
        try { ivRank = this.ivHistoryService.getIvRank(ticker).ivRank; } catch { /* no iv_history */ }
      }
      suitabilityScore = ivRank !== null ? Math.round(ivRank) : 50;
    } else {
      const ratios = await this.fetchFundamentals(ticker);
      suitabilityScore = calculateWheelSuitability(ratios, quote);
      if (suitabilityScore < t.minSuitability) return null;
    }

    // ── Tier 2: monthly-expiry liquidity + premium gate (one chain fetch) ──
    const expiry = thirdFridayOnOrAfter(t.minDte);

    // Earnings gate (individual names only — ETFs don't report). A short put held through an
    // earnings report inside the expiry window carries the single biggest event risk (gap +
    // IV crush), so exclude names whose next earnings falls on/before the target expiry. Uses
    // the local earnings_calendar (free); a universe name with no stored earnings date can't be
    // gated here (see limitation — coverage is best for portfolio/watchlist/conviction tickers).
    if (!isEtf) {
      const nextEarnings = this.loadNextEarnings(ticker);
      if (nextEarnings && nextEarnings <= expiry) return null;
    }

    // Downtrend gate (all names): never sell a CSP into a confirmed downtrend — assignment at
    // the top of a decline is the wheel's core risk (falling knife), matching the Daily Brief's
    // "not in downtrend" signal. Confirmed downtrend = price < SMA50 < SMA200
    // (technical_signals.trend_label 'Bearish'); uptrend and sideways are both kept. Free DB
    // read; a name with no computed trend can't be gated (passes).
    const trend = this.loadTrendLabel(ticker);
    if (trend && trend.toLowerCase() === 'bearish') return null;

    let chain;
    try {
      chain = await this.optionsProvider.getOptionsChain(ticker, expiry);
    } catch {
      return null; // no chain for this monthly (unoptionable / illiquid) → reject
    }
    const puts = chain.contracts.filter(c => c.side === 'put');
    const put = pickWheelPut(puts, quote.last, t.targetDelta);
    if (!put) return null;

    const dte = this.dteDays(expiry);
    // ETFs carry far less risk (no single-name blow-up) → accept a lower premium floor.
    const gate: WheelVettedThresholds = isEtf ? { ...t, minAnnualizedReturn: t.minAnnualizedReturnEtf } : t;
    const a = assessWheelPut(put, dte, gate);
    if (!a.pass) return null;

    return {
      ticker,
      watchlists,
      lastPrice: quote.last,
      metrics: {
        suitabilityScore,
        ...(a.ivPct !== null ? { currentIv: +a.ivPct.toFixed(1) } : {}),
        expiry,
        putStrike: +put.strike.toFixed(2),
        credit: +a.creditPerShare.toFixed(2),
        annualizedReturn: a.annualizedReturn !== null ? +a.annualizedReturn.toFixed(1) : null,
        riskAdjustedReturn: a.riskAdjustedReturn !== null ? +a.riskAdjustedReturn.toFixed(1) : null,
        openInterest: a.oi,
        spread: +a.spreadPct.toFixed(1),
      },
      matchReason: `Vetted${isEtf ? ' (ETF)' : ''}: ${isEtf ? `IV-rank ${suitabilityScore}` : `score ${suitabilityScore}/100`};`
        + ` ${expiry} (${dte}d) $${put.strike} put`
        + ` Δ${put.delta != null ? Math.abs(put.delta).toFixed(2) : '?'}, $${a.creditPerShare.toFixed(2)} credit`
        + ` (${a.annualizedReturn != null ? a.annualizedReturn.toFixed(0) : '?'}% ann.,`
        + ` ${a.riskAdjustedReturn != null ? a.riskAdjustedReturn.toFixed(0) : '?'}% risk-adj.),`
        + ` IV ${a.ivPct != null ? a.ivPct.toFixed(0) : '?'}%, OI ${a.oi.toLocaleString()}, spread ${a.spreadPct.toFixed(0)}%`
        + (trend ? `, trend ${trend}` : ''),
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
        fcfToNetIncome: null, roic: null, netDebtToEbitda: null,
        revenueGrowth5Y: null, epsGrowth5Y: null,
        valueScore: null, growthScore: null, stockGrade: null,
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

  /** Next earnings date (YYYY-MM-DD) on/after today from the local earnings_calendar, or null. */
  private loadNextEarnings(ticker: string): string | null {
    try {
      const row = this.db.prepare(
        `SELECT report_date FROM earnings_calendar WHERE ticker = ? AND report_date >= date('now') ORDER BY report_date LIMIT 1`,
      ).get(ticker.toUpperCase()) as { report_date: string } | undefined;
      return row?.report_date ?? null;
    } catch { return null; }
  }

  /** Nightly trend label ('Bullish' | 'Sideways' | 'Bearish') from technical_signals, or null. */
  private loadTrendLabel(ticker: string): string | null {
    try {
      const row = this.db.prepare(
        `SELECT trend_label FROM technical_signals WHERE ticker = ?`,
      ).get(ticker.toUpperCase()) as { trend_label: string | null } | undefined;
      return row?.trend_label ?? null;
    } catch { return null; }
  }
}