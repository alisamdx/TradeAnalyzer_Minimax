// Screener service — runs screen filters against an index universe.
// Implements FR-2 (strict + soft-match modes) and FR-2.5 (presets).
// All filter logic is unit-testable (EP-6.1).
// Financial formula references: docs/formulas.md
// see SPEC: FR-2, §5.2

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type {
  Universe,
  ScreenCriteria,
  ScreenPreset,
  ScreenRunResult,
  ScreenResultRow,
  ScreenResultPayload
} from '@shared/types.js';
import type { DerivedRatios, Quote } from '@shared/types.js';
import type { DataProvider } from './data-provider.js';
import { QuoteCache, FundamentalsCache } from './cache-service.js';
import { CacheManager } from './cache-manager.js';

// ─── Filter definitions ───────────────────────────────────────────────────────
// Default filter values tuned for options-income retail traders.
// Mirrored in the UI so the user sees the same defaults.
// see SPEC: §5.2.2 table

export interface FilterSpec {
  id: string;
  label: string;
  enabled: boolean;
  defaultMin: number;
  defaultMax: number;
  defaultEnabled: boolean;
  format: 'percent' | 'ratio' | 'dollars' | 'count' | 'bool';
  description: string;
}

export const DEFAULT_FILTER_SPECS: FilterSpec[] = [
  { id: 'market_cap',       label: 'Market Cap',        enabled: true,  defaultMin: 10_000_000_000,  defaultMax: Infinity,       defaultEnabled: true,  format: 'dollars',  description: '≥ $10B — large-cap only' },
  { id: 'pe_ratio',         label: 'P/E Ratio',          enabled: true,  defaultMin: 5,              defaultMax: 30,             defaultEnabled: true,  format: 'ratio',    description: '5–30: profitable but not stretched' },
  { id: 'eps',              label: 'EPS (TTM)',          enabled: true,  defaultMin: 0.01,          defaultMax: Infinity,       defaultEnabled: true,  format: 'dollars',  description: '> 0: profitable today' },
  { id: 'revenue_growth',   label: 'Revenue Growth YoY',enabled: true,  defaultMin: 5,             defaultMax: Infinity,       defaultEnabled: true,  format: 'percent',  description: '≥ 5%: top line growing' },
  { id: 'eps_growth',       label: 'EPS Growth YoY',    enabled: true,  defaultMin: 5,             defaultMax: Infinity,       defaultEnabled: true,  format: 'percent',  description: '≥ 5%: earnings growing with or ahead of revenue' },
  { id: 'debt_to_equity',   label: 'Debt / Equity',     enabled: true,  defaultMin: 0,             defaultMax: 1.5,            defaultEnabled: true,  format: 'ratio',    description: '< 1.5: manageable leverage (financials exempt)' },
  { id: 'roe',              label: 'ROE',               enabled: true,  defaultMin: 15,            defaultMax: Infinity,       defaultEnabled: true,  format: 'percent',  description: '≥ 15%: capital efficient' },
  { id: 'profit_margin',    label: 'Profit Margin',     enabled: true,  defaultMin: 8,             defaultMax: Infinity,       defaultEnabled: true,  format: 'percent',  description: '≥ 8%: pricing power and operational discipline' },
  { id: 'free_cash_flow',   label: 'Free Cash Flow',    enabled: true,  defaultMin: 0,             defaultMax: Infinity,       defaultEnabled: true,  format: 'dollars',  description: 'Positive TTM: real cash, not just earnings' },
  { id: 'current_ratio',    label: 'Current Ratio',     enabled: true,  defaultMin: 1.0,          defaultMax: Infinity,       defaultEnabled: true,  format: 'ratio',    description: '≥ 1.0: can cover short-term obligations' },
  { id: 'avg_volume',       label: 'Avg Daily Volume',  enabled: true,  defaultMin: 1_000_000,    defaultMax: Infinity,       defaultEnabled: true,  format: 'count',    description: '≥ 1M shares: liquidity floor' },
  { id: 'avg_option_vol',   label: 'Avg Option Volume', enabled: false, defaultMin: 1_000,        defaultMax: Infinity,       defaultEnabled: false, format: 'count',    description: '≥ 1,000 contracts: options tradeable' },
  { id: 'price',            label: 'Price',             enabled: true,  defaultMin: 20,            defaultMax: Infinity,       defaultEnabled: true,  format: 'dollars',  description: '≥ $20: wheel/CSP math gets thin below this' },
  { id: 'dist_52wk_high',   label: 'Dist. 52-wk High', enabled: true,  defaultMin: 0,             defaultMax: 25,             defaultEnabled: true,  format: 'percent',  description: 'Within 25%: healthy uptrend' },
  { id: 'dist_52wk_low',    label: 'Dist. 52-wk Low',  enabled: true,  defaultMin: 15,            defaultMax: Infinity,       defaultEnabled: true,  format: 'percent',  description: '≥ 15%: not at the bottom of a freefall' },
  { id: 'beta',             label: 'Beta',              enabled: true,  defaultMin: 0.7,           defaultMax: 1.6,            defaultEnabled: true,  format: 'ratio',    description: '0.7–1.6: excludes flatliners and meme-vol names' },
  { id: 'exclude_earnings', label: 'Earnings ≤ 7 days',enabled: false, defaultMin: 0,             defaultMax: 7,              defaultEnabled: false, format: 'bool',     description: 'Exclude if earnings within 7 days (toggle)' },
  { id: 'sector_exclude',   label: 'Sector Exclude',    enabled: false, defaultMin: 0,             defaultMax: 0,              defaultEnabled: false, format: 'bool',     description: 'Exclude listed sectors' },
];

// ─── Screening result ─────────────────────────────────────────────────────────

export interface TickerScreenData {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCap: number | null;
  peRatio: number | null;
  eps: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  debtToEquity: number | null;
  roe: number | null;
  profitMargin: number | null;
  freeCashFlow: number | null;
  currentRatio: number | null;
  avgVolume: number | null;
  avgOptionVolume: number | null;
  price: number | null;
  distance52WkHigh: number | null;
  distance52WkLow: number | null;
  beta: number | null;
  lastPrice: number | null;
  dayChangePct: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  passedFilters: Set<string>;
  failedFilters: string[];
  passScore: number;
}

export interface ScreenRunOutput {
  scanned: number;
  passed: number;
  rows: TickerScreenData[];
}

// ─── Screener engine ──────────────────────────────────────────────────────────

export class ScreenerService {
  private readonly quoteCache: QuoteCache;
  private readonly fundamentalsCache: FundamentalsCache;

  private readonly cacheManager: CacheManager;

  constructor(
    private readonly db: DbHandle,
    private readonly dataProvider: DataProvider,
    private readonly getConstituents: (u: Universe) => Array<{ ticker: string; companyName: string | null; sector: string | null }>
  ) {
    this.quoteCache = new QuoteCache(db);
    this.fundamentalsCache = new FundamentalsCache(db);
    this.cacheManager = new CacheManager(db, 1);
  }

  /** Run the full screen against a universe. Progress is reported via the callback. */
  async runScreen(
    criteria: ScreenCriteria,
    onProgress?: (scanned: number, total: number, ticker?: string) => void,
    checkCancelled?: () => boolean
  ): Promise<ScreenRunOutput> {
    const universe = criteria.universe;
    const constituents = this.getConstituents(universe);
    const total = constituents.length;
    const rows: TickerScreenData[] = [];
    let passed = 0;

    for (let i = 0; i < constituents.length; i++) {
      if (checkCancelled && checkCancelled()) {
        throw new Error('Screening cancelled by user');
      }

      const { ticker, companyName, sector } = constituents[i]!;
      onProgress?.(i, total, ticker);

      try {
        const result = this.evaluateTicker(ticker, companyName, sector, criteria);
        if (criteria.mode === 'strict') {
          if (result.failedFilters.length === 0) {
            rows.push(result);
            passed++;
          }
        } else {
          rows.push(result);
          if (result.passedFilters.size > 0) passed++;
        }
      } catch {
        // Individual ticker failures are logged and skipped per §4.4.6.
      }
    }

    onProgress?.(total, total);
    this.cacheManager.updateLastRun(total);
    return { scanned: total, passed, rows };
  }

  /** Sync data for all constituents in a universe from the remote API into the local DB. */
  async syncUniverse(
    universe: Universe,
    onProgress?: (scanned: number, total: number, ticker?: string) => void,
    checkCancelled?: () => boolean
  ): Promise<{ scanned: number }> {
    const constituents = this.getConstituents(universe);
    const total = constituents.length;

    if (total === 0) {
      throw new Error(`The ${universe === 'both' ? 'S&P 500 and Russell 1000 lists are' : universe + ' list is'} empty. Please click "Update Ticker Lists" above first.`);
    }

    for (let i = 0; i < total; i++) {
      if (checkCancelled && checkCancelled()) {
        throw new Error('Data sync cancelled by user');
      }

      const ticker = constituents[i]!.ticker;
      onProgress?.(i, total, ticker);

      // Fetch and cache Fundamentals
      try {
        if (this.fundamentalsCache.isStale(ticker)) {
          const ratios = await this.dataProvider.getFundamentals(ticker);
          this.fundamentalsCache.upsert(ticker, ratios);
        }
      } catch (err) {
        if (err instanceof Error && (err.message.includes('401') || err.message.toLowerCase().includes('unauthorized') || err.message.toLowerCase().includes('api key'))) {
          throw new Error('Invalid or missing Polygon API Key. Please update it in Settings.');
        }
        // Silently skip failed fundamentals, typical for OTC or delisted
      }

      // Fetch and cache Quotes
      try {
        if (this.quoteCache.isStale(ticker)) {
          const snapshot = await this.dataProvider.getQuote(ticker);
          this.quoteCache.upsert({
            ticker,
            last: snapshot.last,
            prevClose: snapshot.prevClose,
            bid: snapshot.bid,
            ask: snapshot.ask,
            volume: snapshot.volume,
            dayHigh: snapshot.dayHigh,
            dayLow: snapshot.dayLow,
            ivRank: snapshot.ivRank,
            ivPercentile: snapshot.ivPercentile,
            distance52WkHigh: snapshot.distance52WkHigh,
            distance52WkLow: snapshot.distance52WkLow,
            fetchedAt: snapshot.fetchedAt
          });
        }
      } catch (err) {
        if (err instanceof Error && (err.message.includes('401') || err.message.toLowerCase().includes('unauthorized') || err.message.toLowerCase().includes('api key'))) {
          throw new Error('Invalid or missing Polygon API Key. Please update it in Settings.');
        }
        // Silently skip failed quotes
      }
    }

    onProgress?.(total, total);
    this.cacheManager.updateLastRun(total);
    return { scanned: total };
  }

  /** Evaluate a single ticker against the screen criteria. */
  evaluateTicker(
    ticker: string,
    companyName: string | null,
    sector: string | null,
    criteria: ScreenCriteria
  ): TickerScreenData {
    const passedFilters = new Set<string>();
    const failedFilters: string[] = [];

    // Helper to record a filter result.
    const check = (filterId: string, passed: boolean) => {
      if (criteria.mode === 'strict') {
        if (!passed) failedFilters.push(filterId);
      } else {
        if (passed) passedFilters.add(filterId);
        else failedFilters.push(filterId);
      }
    };

    // ── Fundamentals ───────────────────────────────────────────────────────
    let ratios: DerivedRatios;
    const cachedFundamentals = this.fundamentalsCache.get(ticker);
    if (cachedFundamentals) {
      ratios = cachedFundamentals.ratios;
    } else {
      ratios = {
        marketCap: null,
        peRatio: null,
        eps: null,
        epsGrowth: null,
        revenueGrowth: null,
        debtToEquity: null,
        roe: null,
        profitMargin: null,
        freeCashFlow: null,
        currentRatio: null,
        dividendYield: null,
        beta: null,
        sector: null,
        industry: null
      };
    }

    // ── Quote ───────────────────────────────────────────────────────────────
    let quote: Quote | null = null;
    const cachedQuote = this.quoteCache.get(ticker);
    if (cachedQuote) {
      quote = cachedQuote as unknown as Quote;
    } else {
      quote = { ticker, last: null, prevClose: null, bid: null, ask: null,
        volume: null, dayHigh: null, dayLow: null, ivRank: null, ivPercentile: null,
        distance52WkHigh: null, distance52WkLow: null, fetchedAt: '' };
    }

    const price = quote?.last ?? null;
    const dayChangePct = quote?.prevClose && quote.last
      ? ((quote.last - quote.prevClose) / quote.prevClose) * 100
      : null;
    const avgVolume = quote?.volume ?? null;

    // ── Apply filters ──────────────────────────────────────────────────────
    for (const fd of criteria.filters) {
      if (!fd.enabled) continue;
      const v = fd.value as Record<string, unknown>;
      const enabled = (v['enabled'] as boolean | undefined) ?? true;
      if (!enabled) continue;

      switch (fd.id) {
        case 'market_cap':
          check(fd.id, ratios.marketCap !== null && ratios.marketCap >= (v['min'] as number ?? 0));
          break;
        case 'pe_ratio': {
          const [mn, mx] = [(v['min'] as number) ?? 0, (v['max'] as number) ?? Infinity];
          check(fd.id, ratios.peRatio !== null && ratios.peRatio >= mn && ratios.peRatio <= mx);
          break;
        }
        case 'eps':
          check(fd.id, ratios.eps !== null && ratios.eps >= (v['min'] as number ?? 0));
          break;
        case 'revenue_growth':
          check(fd.id, ratios.revenueGrowth !== null && ratios.revenueGrowth >= (v['min'] as number ?? 0));
          break;
        case 'eps_growth':
          check(fd.id, ratios.epsGrowth !== null && ratios.epsGrowth >= (v['min'] as number ?? 0));
          break;
        case 'debt_to_equity': {
          // Null means financials sector — pass to avoid false negatives.
          if (ratios.debtToEquity === null) { check(fd.id, true); break; }
          const [mn, mx] = [(v['min'] as number) ?? 0, (v['max'] as number) ?? Infinity];
          check(fd.id, ratios.debtToEquity >= mn && ratios.debtToEquity <= mx);
          break;
        }
        case 'roe':
          check(fd.id, ratios.roe !== null && ratios.roe >= (v['min'] as number ?? 0));
          break;
        case 'profit_margin':
          check(fd.id, ratios.profitMargin !== null && ratios.profitMargin >= (v['min'] as number ?? 0));
          break;
        case 'free_cash_flow':
          check(fd.id, ratios.freeCashFlow !== null && ratios.freeCashFlow > 0);
          break;
        case 'current_ratio':
          check(fd.id, ratios.currentRatio !== null && ratios.currentRatio >= (v['min'] as number ?? 0));
          break;
        case 'avg_volume':
          check(fd.id, avgVolume !== null && avgVolume >= (v['min'] as number ?? 0));
          break;
        case 'price':
          check(fd.id, price !== null && price >= (v['min'] as number ?? 0));
          break;
        case 'beta': {
          const [mn, mx] = [(v['min'] as number) ?? 0, (v['max'] as number) ?? Infinity];
          const beta = ratios.beta ?? 1.0; // Default beta of 1 if unavailable.
          check(fd.id, beta >= mn && beta <= mx);
          break;
        }
        case 'sector_exclude': {
          const excluded = (v['sectors'] as string[] | undefined) ?? [];
          check(fd.id, sector === null || !excluded.some((s) => sector!.toLowerCase().includes(s.toLowerCase())));
          break;
        }
        default:
          // Unknown filter — skip.
          break;
      }
    }

    const passScore = criteria.mode === 'strict' ? (failedFilters.length === 0 ? criteria.filters.filter(f => f.enabled).length : 0) : passedFilters.size;

    return {
      ticker,
      companyName,
      sector,
      marketCap: ratios.marketCap,
      peRatio: ratios.peRatio,
      eps: ratios.eps,
      revenueGrowth: ratios.revenueGrowth,
      epsGrowth: ratios.epsGrowth,
      debtToEquity: ratios.debtToEquity,
      roe: ratios.roe,
      profitMargin: ratios.profitMargin,
      freeCashFlow: ratios.freeCashFlow,
      currentRatio: ratios.currentRatio,
      avgVolume,
      avgOptionVolume: null,
      price,
      distance52WkHigh: quote?.distance52WkHigh ?? null,
      distance52WkLow: quote?.distance52WkLow ?? null,
      beta: ratios.beta,
      lastPrice: quote?.last ?? null,
      dayChangePct: dayChangePct,
      ivRank: quote?.ivRank ?? null,
      ivPercentile: quote?.ivPercentile ?? null,
      passedFilters,
      failedFilters,
      passScore
    };
  }

  // ─── Preset CRUD ─────────────────────────────────────────────────────────

  private readonly listPresetsStmt = `
    SELECT id, name, universe, criteria_json, is_default, created_at
    FROM screen_presets ORDER BY is_default DESC, lower(name) ASC`;

  private readonly insertPresetStmt = `INSERT INTO screen_presets (name, universe, criteria_json, is_default) VALUES (?, ?, ?, ?)`;
  private readonly deletePresetStmt = `DELETE FROM screen_presets WHERE id = ?`;
  private readonly getPresetStmt    = `SELECT * FROM screen_presets WHERE id = ?`;
  private readonly clearDefaultStmt = `UPDATE screen_presets SET is_default = 0`;

  listPresets(): ScreenPreset[] {
    const rows = this.db.prepare(this.listPresetsStmt).all() as Array<{
      id: number; name: string; universe: string; criteria_json: string;
      is_default: number; created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      universe: r.universe as Universe,
      criteria: JSON.parse(r.criteria_json) as ScreenCriteria,
      isDefault: r.is_default === 1,
      createdAt: r.created_at
    }));
  }

  getPreset(id: number): ScreenPreset | null {
    const r = this.db.prepare(this.getPresetStmt).get(id) as {
      id: number; name: string; universe: string; criteria_json: string;
      is_default: number; created_at: string;
    } | undefined;
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      universe: r.universe as Universe,
      criteria: JSON.parse(r.criteria_json) as ScreenCriteria,
      isDefault: r.is_default === 1,
      createdAt: r.created_at
    };
  }

  savePreset(preset: Omit<ScreenPreset, 'id' | 'createdAt'>): ScreenPreset {
    const criteriaJson = JSON.stringify(preset.criteria);
    if (preset.isDefault) {
      this.db.prepare(this.clearDefaultStmt).run();
    }
    const result = this.db.prepare(this.insertPresetStmt).run(
      preset.name, preset.universe, criteriaJson, preset.isDefault ? 1 : 0
    );
    return this.getPreset(Number(result.lastInsertRowid))!;
  }

  deletePreset(id: number): void {
    this.db.prepare(this.deletePresetStmt).run(id);
  }

  // ─── Screen run persistence ───────────────────────────────────────────────

  saveRun(
    criteria: ScreenCriteria,
    universe: Universe,
    rows: TickerScreenData[],
    presetId: number | null = null,
    presetName: string | null = null
  ): ScreenRunResult {
    return withTransaction(this.db, () => {
      const criteriaJson = JSON.stringify(criteria);
      const insertRun = this.db.prepare(
        `INSERT INTO screen_runs (preset_id, preset_name, criteria_json, universe, result_count, run_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
      );
      const insertResult = this.db.prepare(
        `INSERT INTO screen_results (screen_run_id, ticker, company_name, sector, payload_json)
         VALUES (?, ?, ?, ?, ?)`
      );
      const runRes = insertRun.run(
        presetId ?? null, presetName ?? null, criteriaJson, universe, rows.length
      );
      const runId = Number(runRes.lastInsertRowid);
      for (const row of rows) {
        const payload: ScreenResultPayload = {
          marketCap: row.marketCap, peRatio: row.peRatio, eps: row.eps,
          revenueGrowth: row.revenueGrowth, epsGrowth: row.epsGrowth,
          debtToEquity: row.debtToEquity, roe: row.roe, profitMargin: row.profitMargin,
          freeCashFlow: row.freeCashFlow, currentRatio: row.currentRatio,
          avgVolume: row.avgVolume, avgOptionVolume: row.avgOptionVolume,
          price: row.price, distance52WkHigh: row.distance52WkHigh,
          distance52WkLow: row.distance52WkLow, beta: row.beta,
          sector: row.sector, lastPrice: row.lastPrice, dayChangePct: row.dayChangePct,
          ivRank: row.ivRank, ivPercentile: row.ivPercentile,
          passScore: row.passScore, failedFilters: row.failedFilters
        };
        insertResult.run(runId, row.ticker, row.companyName, row.sector, JSON.stringify(payload));
      }

      // Update cache metadata after successful screen run
      this.cacheManager.updateLastRun(rows.length);

      return {
        id: runId,
        presetId,
        presetName,
        universe,
        resultCount: rows.length,
        runAt: new Date().toISOString()
      };
    });
  }

  getRun(id: number): ScreenRunResult | null {
    const r = this.db.prepare(
      `SELECT id, preset_id, preset_name, universe, result_count, run_at
         FROM screen_runs WHERE id = ?`
    ).get(id) as { id: number; preset_id: number | null; preset_name: string | null;
      universe: string; result_count: number; run_at: string } | undefined;
    if (!r) return null;
    return {
      id: r.id, presetId: r.preset_id, presetName: r.preset_name,
      universe: r.universe as Universe, resultCount: r.result_count, runAt: r.run_at
    };
  }

  getRuns(): ScreenRunResult[] {
    const rows = this.db.prepare(
      `SELECT id, preset_id, preset_name, universe, result_count, run_at
         FROM screen_runs ORDER BY run_at DESC LIMIT 50`
    ).all() as Array<{ id: number; preset_id: number | null; preset_name: string | null;
      universe: string; result_count: number; run_at: string }>;
    return rows.map((r) => ({
      id: r.id, presetId: r.preset_id, presetName: r.preset_name,
      universe: r.universe as Universe, resultCount: r.result_count, runAt: r.run_at
    }));
  }

  getResults(runId: number): ScreenResultRow[] {
    const rows = this.db.prepare(
      `SELECT id, screen_run_id, ticker, company_name, sector, payload_json
         FROM screen_results WHERE screen_run_id = ? ORDER BY id ASC`
    ).all(runId) as Array<{ id: number; screen_run_id: number; ticker: string;
      company_name: string | null; sector: string | null; payload_json: string }>;
    return rows.map((r) => ({
      id: r.id,
      screenRunId: r.screen_run_id,
      ticker: r.ticker,
      companyName: r.company_name,
      sector: r.sector,
      payload: JSON.parse(r.payload_json) as ScreenResultPayload
    }));
  }
}