// Types crossing the IPC boundary. Imported by main, preload, and renderer.

// ─── Watchlists (Phase 1) ───────────────────────────────────────────────────────

export interface Watchlist {
  id: number;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface WatchlistItem {
  id: number;
  watchlistId: number;
  ticker: string;
  notes: string | null;
  addedAt: string;
}

export interface CsvImportResult {
  watchlistId: number;
  imported: number;
  skipped: Array<{ row: number; ticker: string; reason: string }>;
}

export interface CsvExportResult {
  filePath: string;
  rowCount: number;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

// ─── Screener (Phase 2) ────────────────────────────────────────────────────────

export type Universe = 'sp500' | 'russell1000' | 'both';

/** One enabled filter with its threshold(s). */
export interface FilterDef {
  id: string;
  enabled: boolean;
  /** Varies by filter — a number, [min, max], string[], etc. */
  value: unknown;
}

/** Full criteria shape serialised to JSON for storage. */
export interface ScreenCriteria {
  universe: Universe;
  mode: 'strict' | 'soft';
  filters: FilterDef[];
}

export interface ScreenPreset {
  id: number;
  name: string;
  universe: Universe;
  criteria: ScreenCriteria;
  isDefault: boolean;
  createdAt: string;
}

export interface ConstituentsMeta {
  indexName: 'sp500' | 'russell1000';
  refreshedAt: string;
  source: 'bundled' | 'wikipedia' | 'csv';
}

export interface ConstituentRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
}

export interface ScreenRunResult {
  id: number;
  presetId: number | null;
  presetName: string | null;
  universe: Universe;
  resultCount: number;
  runAt: string;
}

export interface ScreenResultRow {
  id: number;
  screenRunId: number;
  ticker: string;
  companyName: string | null;
  sector: string | null;
  payload: ScreenResultPayload;
}

export interface ScreenResultPayload {
  // Fundamental fields
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
  sector: string | null;
  // Quote fields
  lastPrice: number | null;
  dayChangePct: number | null;
  // Derived
  ivRank: number | null;
  ivPercentile: number | null;
  // Pass score
  passScore: number;       // count of filters passed (soft mode)
  failedFilters: string[]; // ids of filters that failed
}

// ─── Quote & Fundamentals (Phase 2) ───────────────────────────────────────────

export interface Quote {
  ticker: string;
  last: number | null;
  prevClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  fetchedAt: string;
}

/** Alias of Quote — used by the cache service IPC bridge. */
export type CachedQuote = Quote;

/** Derived ratios computed from raw Polygon financials data.
 *  Computed by src/main/services/fundamentals-computer.ts — see docs/formulas.md */
export interface DerivedRatios {
  peRatio: number | null;
  eps: number | null;
  marketCap: number | null;
  debtToEquity: number | null;
  roe: number | null;
  profitMargin: number | null;
  revenueGrowth: number | null;
  epsGrowth: number | null;
  freeCashFlow: number | null;
  currentRatio: number | null;
  dividendYield: number | null;
  beta: number | null;
  sector: string | null;
  industry: string | null;
}

export interface FundamentalsCache {
  ticker: string;
  ratios: DerivedRatios;
  fetchedAt: string;
}

// ─── Screener IPC ─────────────────────────────────────────────────────────────

export interface ScreenerIpc {
  'screen:list-presets': () => Promise<ScreenPreset[]>;
  'screen:save-preset': (preset: Omit<ScreenPreset, 'id' | 'createdAt'>) => Promise<ScreenPreset>;
  'screen:delete-preset': (id: number) => Promise<void>;
  'screen:get-constituents': (index: Universe) => Promise<ConstituentRow[]>;
  'screen:refresh-constituents': (index: 'sp500' | 'russell1000') => Promise<ConstituentsMeta>;
  'screen:run': (criteria: ScreenCriteria) => Promise<ScreenRunResult>;
  'screen:get-results': (runId: number) => Promise<ScreenResultRow[]>;
  'screen:save-as-watchlist': (runId: number, tickerIds: number[], name: string) => Promise<Watchlist>;
  'screen:get-runs': () => Promise<ScreenRunResult[]>;
}
