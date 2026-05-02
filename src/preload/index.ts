import { contextBridge, ipcRenderer } from 'electron';
import type {
  Watchlist,
  WatchlistItem,
  CsvImportResult,
  CsvExportResult,
  IpcResult,
  ScreenPreset,
  ScreenCriteria,
  ScreenRunResult,
  ScreenResultRow,
  Universe,
  ConstituentsMeta,
  ConstituentRow,
  Quote as CachedQuote,
  AnalysisModeInfo,
  AnalysisRunResult,
  AnalysisSnapshotRow,
  ValidateDashboardResult,
  JobRunInfo,
  TickerStatusRow,
  ValidateAllResult,
  AppSettings,
  DiagnosticsResult
} from '@shared/types.js';
export type {
  ScreenPreset, ScreenCriteria, ScreenRunResult, ScreenResultRow, Universe,
  ConstituentsMeta, ConstituentRow, CachedQuote, AnalysisModeInfo, AnalysisRunResult,
  AnalysisSnapshotRow, ValidateDashboardResult, JobRunInfo, TickerStatusRow, ValidateAllResult,
  AppSettings, DiagnosticsResult
};
export type Api = ReturnType<typeof buildApi>['api'];

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) {
    const err = new Error(result.error.message) as Error & { code?: string };
    err.code = result.error.code;
    throw err;
  }
  return result.value;
}

function buildApi() {
  const watchlists = {
    list: () => invoke<Watchlist[]>('watchlists:list'),
    get: (id: number) => invoke<Watchlist>('watchlists:get', id),
    create: (name: string) => invoke<Watchlist>('watchlists:create', name),
    rename: (id: number, newName: string) => invoke<Watchlist>('watchlists:rename', id, newName),
    delete: (id: number) => invoke<true>('watchlists:delete', id),
    items: {
      list: (id: number) => invoke<WatchlistItem[]>('watchlists:items:list', id),
      add: (id: number, ticker: string, notes: string | null = null) =>
        invoke<WatchlistItem>('watchlists:items:add', id, ticker, notes),
      addBulk: (id: number, items: Array<{ ticker: string; notes?: string | null }>) =>
        invoke<{
          added: WatchlistItem[];
          skipped: Array<{ ticker: string; reason: string }>;
        }>('watchlists:items:add-bulk', id, items),
      remove: (id: number, itemIds: number[]) =>
        invoke<number>('watchlists:items:remove', id, itemIds)
    },
    csv: {
      export: (watchlistId: number) =>
        invoke<CsvExportResult | null>('watchlists:csv:export', watchlistId),
      import: (args: { watchlistId?: number; createWithName?: string }) =>
        invoke<CsvImportResult>('watchlists:csv:import', args)
    }
  };

  const screen = {
    listPresets: () => invoke<ScreenPreset[]>('screen:list-presets'),
    savePreset: (preset: Omit<ScreenPreset, 'id' | 'createdAt'>) =>
      invoke<ScreenPreset>('screen:save-preset', preset),
    deletePreset: (id: number) => invoke<void>('screen:delete-preset', id),
    getConstituents: (index: Universe) =>
      invoke<ConstituentRow[]>('screen:get-constituents', index),
    getMeta: (index: 'sp500' | 'russell1000') =>
      invoke<ConstituentsMeta | null>('screen:get-meta', index),
    refreshConstituents: (index: 'sp500' | 'russell1000') =>
      invoke<ConstituentsMeta>('screen:refresh-constituents', index),
    importConstituents: (filePath: string, index: 'sp500' | 'russell1000') =>
      invoke<{ count: number }>('screen:import-constituents', { filePath, index }),
    run: (criteria: ScreenCriteria) =>
      invoke<ScreenRunResult>('screen:run', criteria),
    getRuns: () => invoke<ScreenRunResult[]>('screen:get-runs'),
    getResults: (runId: number) => invoke<ScreenResultRow[]>('screen:get-results', runId),
    saveAsWatchlist: (runId: number, resultIds: number[], name: string) =>
      invoke<Watchlist>('screen:save-as-watchlist', runId, resultIds, name)
  };

  const quotes = {
    refresh: (ticker: string) => invoke<CachedQuote>('quotes:refresh', ticker),
    refreshBulk: (tickers: string[]) => invoke<CachedQuote[]>('quotes:refresh-bulk', tickers),
    getCached: (ticker: string) => invoke<CachedQuote | null>('quotes:get-cached', ticker)
  };

  const analysis = {
    listModes: () => invoke<AnalysisModeInfo[]>('analysis:list-modes'),
    run: (watchlistId: number, mode: string, tickerSubset?: string[]) =>
      invoke<AnalysisRunResult>('analysis:run', { watchlistId, mode: mode as Parameters<typeof analysis.run>[1], tickerSubset }),
    getSnapshots: (watchlistId: number) => invoke<AnalysisSnapshotRow[]>('analysis:get-snapshots', watchlistId),
    getSnapshot: (id: number) => invoke<{ id: number; watchlistId: number; mode: string; runAt: string; resultCount: number; results: unknown[] } | null>('analysis:get-snapshot', id),
    saveAsWatchlist: (snapshotId: number, resultIndices: number[], name: string) =>
      invoke<Watchlist>('analysis:save-as-watchlist', snapshotId, resultIndices, name),
    cancel: () => invoke<boolean>('analysis:cancel')
  };

  const validateAll = {
    run: (watchlistId: number) => invoke<ValidateAllResult>('validate-all:run', { watchlistId }),
    getStatus: (jobRunId: number) => invoke<{ run: JobRunInfo; progress: TickerStatusRow[] } | null>('validate-all:get-status', jobRunId),
    cancel: () => invoke<boolean>('validate-all:cancel')
  };

  const validate = {
    openTickerById: (ticker: string) =>
      invoke<ValidateDashboardResult>('validate:open-ticker-by-id', ticker),
    getTickers: (watchlistId: number) =>
      invoke<string[]>('validate:get-tickers', watchlistId),
    runValidateAll: (watchlistId: number) =>
      invoke<ValidateAllResult>('validate:run-all', { watchlistId }),
    getStatus: (watchlistId: number) =>
      invoke<{ run: JobRunInfo; progress: TickerStatusRow[] } | null>('validate:get-status', watchlistId),
    cancel: () => invoke<boolean>('validate:cancel')
  };

  const jobs = {
    listIncomplete: () => invoke<JobRunInfo[]>('job:list-incomplete'),
    resume: (jobRunId: number) => invoke<JobRunInfo | null>('job:resume', jobRunId),
    discard: (jobRunId: number) => invoke<boolean>('job:discard', jobRunId)
  };

  const settings = {
    getAll: () => invoke<AppSettings>('settings:get-all'),
    setAll: (partial: Partial<AppSettings>) => invoke<boolean>('settings:set-all', partial),
    getApiKey: () => invoke<string>('settings:get-api-key'),
    setApiKey: (key: string) => invoke<boolean>('settings:set-api-key', key),
    openLogsDir: () => invoke<boolean>('settings:open-logs-dir'),
    backup: () => invoke<{ backupPath: string; message: string } | null>('settings:backup-everything'),
    restore: () => invoke<{ restored: boolean; message: string } | null>('settings:restore-backup')
  };

  const diagnostics = {
    run: () => invoke<DiagnosticsResult>('diagnostics:run')
  };

  return { api: { watchlists, screen, quotes, analysis, validateAll, validate, jobs, settings, diagnostics } };
}

const { api } = buildApi();
contextBridge.exposeInMainWorld('api', api);