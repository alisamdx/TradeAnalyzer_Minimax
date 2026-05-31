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
  ValidateTickerItem,
  AppSettings,
  DiagnosticsResult,
  CacheStatus,
  CacheStats,
  OptionsChainExpirationSummary,
  OptionsChainViewData,
  OptionContract,
  AgentStatus,
  AgentTrade,
  AgentLesson,
  AgentTheoryCheck,
  AgentNativeLesson,
  AgentDashboard,
  AgentRecommendation,
  AgentMemorySnapshot,
  AgentConfig,
  AgentStrategy,
  AgentStrategiesState,
  BacktestConfig,
  BacktestRun,
  BacktestTrade,
  BacktestMetrics,
  BacktestProgressEvent,
  LeapsCspRunResult,
  LeapsCspRunSummary,
  LeapsCspOpenedEntry,
  LeapsCspProgressDetail,
  CollaredLeapsRunResult,
  CollaredLeapsRunSummary,
  CollaredLeapsOpenedEntry,
  CollaredLeapsProgressDetail,
  FilterTemplate,
  FilterTemplateResult,
  EtradeAccount,
  EtradeSyncResult,
  PositionEtrade,
  PositionAnalysis,
  AdvisorSession,
  AdvisorProgressEvent,
  PayoffLeg,
  SavedPayoffStrategy,
  PayoffAssessInput,
  PayoffAssessment,
  IvHistoryBackfillPhase,
  IvRankResult,
  IvHistoryCoverage,
  IvHistoryGapSummary,
  IvHistoryProgressEvent,
  OpportunityRow,
  OpportunityRunOptions,
  StrategyLabValidateResult,
  StrategySetup,
  StrategyScore,
  StrategyLabContext,
} from '@shared/types.js';
export type {
  ScreenPreset, ScreenCriteria, ScreenRunResult, ScreenResultRow, Universe,
  ConstituentsMeta, ConstituentRow, CachedQuote, AnalysisModeInfo, AnalysisRunResult,
  AnalysisSnapshotRow, ValidateDashboardResult, JobRunInfo, TickerStatusRow, ValidateAllResult,
  AppSettings, DiagnosticsResult, CacheStatus, CacheStats
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
    getMeta: (index: 'sp500' | 'russell1000' | 'etf') =>
      invoke<ConstituentsMeta | null>('screen:get-meta', index),
    refreshConstituents: (index: 'sp500' | 'russell1000') =>
      invoke<ConstituentsMeta>('screen:refresh-constituents', index),
    importConstituents: (filePath: string, index: 'sp500' | 'russell1000' | 'etf') =>
      invoke<{ count: number }>('screen:import-constituents', { filePath, index }),
    run: (criteria: ScreenCriteria) =>
      invoke<{ runId: number; resultCount: number; passedCount: number; rows: ScreenResultRow[] }>('screen:run', criteria),
    syncUniverse: (universe: Universe) =>
      invoke<{ scanned: number }>('screen:sync-universe', universe),
    syncCancel: () => invoke<boolean>('screen:sync-cancel'),
    onSyncProgress: (callback: (data: { scanned: number; total: number; ticker?: string }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('screen:sync-progress', handler);
      return () => ipcRenderer.removeListener('screen:sync-progress', handler);
    },
    getRuns: () => invoke<ScreenRunResult[]>('screen:get-runs'),
    getResults: (runId: number) => invoke<ScreenResultRow[]>('screen:get-results', runId),
    getDbCounts: () => invoke<{ quotesCache: number; fundamentalsCache: number; screenResults: number; constituents: number }>('screen:get-db-counts'),
    saveAsWatchlist: (runId: number, resultIds: number[], name: string) =>
      invoke<Watchlist>('screen:save-as-watchlist', runId, resultIds, name),
    cancel: () => invoke<boolean>('screen:cancel'),
    onProgress: (callback: (data: { scanned: number; total: number; ticker?: string }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('screen:progress', handler);
      return () => ipcRenderer.removeListener('screen:progress', handler);
    }
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
    deleteSnapshot: (id: number) => invoke<{ success: boolean }>('analysis:delete-snapshot', id),
    clearSnapshots: (watchlistId: number) => invoke<{ success: boolean }>('analysis:clear-snapshots', watchlistId),
    saveAsWatchlist: (snapshotId: number, resultIndices: number[], name: string) =>
      invoke<Watchlist>('analysis:save-as-watchlist', snapshotId, resultIndices, name),
    cancel: () => invoke<boolean>('analysis:cancel'),
    onProgress: (callback: (data: { current: number; total: number; ticker: string }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('analysis:progress', handler);
      return () => ipcRenderer.removeListener('analysis:progress', handler);
    }
  };

  const validateAll = {
    run: (watchlistId: number) => invoke<ValidateAllResult>('validate-all:run', { watchlistId }),
    getStatus: (jobRunId: number) => invoke<{ run: JobRunInfo; progress: TickerStatusRow[] } | null>('validate-all:get-status', jobRunId),
    cancel: () => invoke<boolean>('validate-all:cancel')
  };

  const validate = {
    openTickerById: (args: { ticker: string }) =>
      invoke<ValidateDashboardResult>('validate:open-ticker-by-id', args),
    getTickers: (watchlistId: number) =>
      invoke<ValidateTickerItem[]>('validate:get-tickers', watchlistId),
    runValidateAll: (watchlistId: number) =>
      invoke<ValidateAllResult>('validate:run-all', { watchlistId }),
    getStatus: (watchlistId: number) =>
      invoke<{ run: JobRunInfo; progress: TickerStatusRow[] } | null>('validate:get-status', watchlistId),
    cancel: () => invoke<boolean>('validate:cancel'),
    onTickerSignal: (callback: (data: {
      ticker: string; companyName: string | null; lastPrice: number | null;
      strength: 'strong' | 'moderate' | 'none'; score: number; reasons: string[];
      trend: 'Bullish' | 'Bearish' | 'Sideways';
      entryZoneLow: number | null; entryZoneHigh: number | null;
      stopLoss: number | null; target: number | null;
      analystBuy: number | null; analystHold: number | null; analystSell: number | null;
      avgPriceTarget: number | null; upsidePct: number | null;
      analystBadge: 'BUY' | 'HOLD' | 'SELL' | null;
    }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('validate:ticker-signal', handler);
      return () => ipcRenderer.removeListener('validate:ticker-signal', handler);
    }
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
    getIvolatilityKey: () => invoke<string>('settings:get-ivolatility-key'),
    setIvolatilityKey: (key: string) => invoke<boolean>('settings:set-ivolatility-key', key),
    openLogsDir: () => invoke<boolean>('settings:open-logs-dir'),
    backup: () => invoke<{ backupPath: string; message: string } | null>('settings:backup-everything'),
    restore: () => invoke<{ restored: boolean; message: string } | null>('settings:restore-backup'),
    /** Returns which options data provider is active ('polygon' or 'etrade'). */
    getOptionsProvider: () => invoke<'polygon' | 'etrade'>('settings:get-options-provider'),
    /** Saves the options provider selection. Takes effect after next app restart. */
    setOptionsProvider: (provider: 'polygon' | 'etrade') => invoke<boolean>('settings:set-options-provider', provider),
  };

  const diagnostics = {
    run: () => invoke<DiagnosticsResult>('diagnostics:run')
  };

  const cache = {
    getStatus: () => invoke<CacheStatus>('cache:getStatus'),
    getStats: () => invoke<CacheStats>('cache:getStats'),
    updateLastRun: (recordCount?: number) => invoke<boolean>('cache:updateLastRun', recordCount),
    reset: () => invoke<boolean>('cache:reset'),
    refresh: () => invoke<boolean>('cache:refresh'),
    isStale: () => invoke<boolean>('cache:isStale')
  };

  const historical = {
    getFinancials: (ticker: string, periodType: 'quarterly' | 'annual', limit?: number) =>
      invoke<{
        ticker: string;
        filingDate: string;
        periodType: 'quarterly' | 'annual';
        periodEndDate: string;
        revenues: number | null;
        netIncome: number | null;
        grossProfit: number | null;
        operatingIncome: number | null;
        earningsPerShare: number | null;
        sharesOutstanding: number | null;
        totalAssets: number | null;
        totalLiabilities: number | null;
        shareholdersEquity: number | null;
        longTermDebt: number | null;
        currentAssets: number | null;
        currentLiabilities: number | null;
        operatingCashFlow: number | null;
        freeCashFlow: number | null;
        ebitda: number | null;
      }[]>('historical:getFinancials', ticker, periodType, limit),
    getFinancialsLatestDate: (ticker: string, periodType: 'quarterly' | 'annual') =>
      invoke<string | null>('historical:getFinancialsLatestDate', ticker, periodType),
    fetchFinancials: (ticker: string, periodType: 'quarterly' | 'annual') =>
      invoke<{ success: boolean; count?: number; error?: string }>('historical:fetchFinancials', ticker, periodType),
    getPrices: (ticker: string, fromDate: string, toDate: string) =>
      invoke<{
        ticker: string;
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        adjustedClose: number | null;
      }[]>('historical:getPrices', ticker, fromDate, toDate),
    getPricesWithSMA: (ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') =>
      invoke<{
        ticker: string;
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        adjustedClose: number | null;
        sma50: number | null;
      }[]>('historical:getPricesWithSMA', ticker, range),
    getPricesLatestDate: (ticker: string) =>
      invoke<string | null>('historical:getPricesLatestDate', ticker),
    fetchPrices: (ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') =>
      invoke<{ success: boolean; count?: number; error?: string }>('historical:fetchPrices', ticker, range),
    fetchAndStore: (ticker: string, type: 'financials' | 'prices', options?: { periodType?: 'quarterly' | 'annual'; range?: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' }) =>
      invoke<{ success: boolean; count?: number; error?: string; type: string }>('historical:fetchAndStore', ticker, type, options),
    needsRefresh: (ticker: string, dataType: 'financials' | 'prices', maxAgeDays?: number) =>
      invoke<boolean>('historical:needsRefresh', ticker, dataType, maxAgeDays),
    getUniverseTickers: (universe: 'sp500' | 'russell1000' | 'both' | 'etf') =>
      invoke<string[]>('historical:getUniverseTickers', universe),
    getStalePriceTickers: () =>
      invoke<string[]>('historical:getStalePriceTickers'),
    getPriceTickerCount: () =>
      invoke<number>('historical:getPriceTickerCount'),
  };

  const alerts = {
    create: (input: {
      ticker: string;
      alertType: 'price' | 'expiration' | 'delta';
      priceThreshold?: number;
      priceCondition?: 'above' | 'below';
      daysBeforeExpiration?: number;
      deltaThreshold?: number;
      deltaDirection?: 'above' | 'below';
      playSound?: boolean;
    }) => invoke<{
      success: boolean;
      data?: {
        id: number;
        ticker: string;
        alertType: 'price' | 'expiration' | 'delta';
        priceThreshold: number | null;
        priceCondition: 'above' | 'below' | null;
        daysBeforeExpiration: number | null;
        deltaThreshold: number | null;
        deltaDirection: 'above' | 'below' | null;
        isActive: boolean;
        isTriggered: boolean;
        triggeredAt: string | null;
        playSound: boolean;
        createdAt: string;
        updatedAt: string;
      };
      error?: string;
    }>('alerts:create', input),
    list: (activeOnly?: boolean) => invoke<{
      success: boolean;
      data?: {
        id: number;
        ticker: string;
        alertType: 'price' | 'expiration' | 'delta';
        priceThreshold: number | null;
        priceCondition: 'above' | 'below' | null;
        daysBeforeExpiration: number | null;
        deltaThreshold: number | null;
        deltaDirection: 'above' | 'below' | null;
        isActive: boolean;
        isTriggered: boolean;
        triggeredAt: string | null;
        playSound: boolean;
        createdAt: string;
        updatedAt: string;
      }[];
      error?: string;
    }>('alerts:list', activeOnly),
    get: (id: number) => invoke<{
      success: boolean;
      data?: {
        id: number;
        ticker: string;
        alertType: 'price' | 'expiration' | 'delta';
        priceThreshold: number | null;
        priceCondition: 'above' | 'below' | null;
        daysBeforeExpiration: number | null;
        deltaThreshold: number | null;
        deltaDirection: 'above' | 'below' | null;
        isActive: boolean;
        isTriggered: boolean;
        triggeredAt: string | null;
        playSound: boolean;
        createdAt: string;
        updatedAt: string;
      } | null;
      error?: string;
    }>('alerts:get', id),
    update: (id: number, update: Partial<{
      ticker?: string;
      alertType?: 'price' | 'expiration' | 'delta';
      priceThreshold?: number;
      priceCondition?: 'above' | 'below';
      daysBeforeExpiration?: number;
      deltaThreshold?: number;
      deltaDirection?: 'above' | 'below';
      playSound?: boolean;
    }>) => invoke<{
      success: boolean;
      data?: {
        id: number;
        ticker: string;
        alertType: 'price' | 'expiration' | 'delta';
        priceThreshold: number | null;
        priceCondition: 'above' | 'below' | null;
        daysBeforeExpiration: number | null;
        deltaThreshold: number | null;
        deltaDirection: 'above' | 'below' | null;
        isActive: boolean;
        isTriggered: boolean;
        triggeredAt: string | null;
        playSound: boolean;
        createdAt: string;
        updatedAt: string;
      };
      error?: string;
    }>('alerts:update', id, update),
    delete: (id: number) => invoke<{ success: boolean; error?: string }>('alerts:delete', id),
    markTriggered: (id: number) => invoke<{ success: boolean; error?: string }>('alerts:markTriggered', id),
    resetTriggered: (id: number) => invoke<{ success: boolean; error?: string }>('alerts:resetTriggered', id)
  };

  const portfolio = {
    add: (input: {
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes?: string | null;
      strikePrice?: number | null;
      expirationDate?: string | null;
      premiumReceived?: number | null;
    }) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
    }; error?: string }>('portfolio:add', input),
    list: (status?: 'open' | 'closed') => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
    }[]; error?: string }>('portfolio:list', status),
    get: (id: number) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
    } | null; error?: string }>('portfolio:get', id),
    update: (id: number, update: {
      quantity?: number;
      entryPrice?: number;
      entryDate?: string;
      entryNotes?: string | null;
      strikePrice?: number | null;
      expirationDate?: string | null;
      premiumReceived?: number | null;
    }) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
    }; error?: string }>('portfolio:update', id, update),
    close: (id: number, input: { exitPrice: number; exitDate: string; exitNotes?: string | null }) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
    }; error?: string }>('portfolio:close', id, input),
    delete: (id: number) => invoke<{ success: boolean; error?: string }>('portfolio:delete', id),
    pnlSummary: () => invoke<{ success: boolean; data?: {
      totalPositions: number;
      openPositions: number;
      closedPositions: number;
      totalUnrealizedPnl: number;
      totalRealizedPnl: number;
      totalCapitalDeployed: number;
      winRate: number;
      averageReturnPct: number;
    }; error?: string }>('portfolio:pnlSummary'),
    getWithMetrics: (id: number) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
      capitalRequired: number;
      daysHeld: number | null;
      returnPct: number | null;
      annualizedReturn: number | null;
    } | null; error?: string }>('portfolio:getWithMetrics', id),
    updatePrice: (ticker: string, price: number) => invoke<{ success: boolean; error?: string }>('portfolio:updatePrice', ticker, price),
    listByTicker: (ticker: string) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock';
      quantity: number;
      entryPrice: number;
      entryDate: string;
      entryNotes: string | null;
      exitPrice: number | null;
      exitDate: string | null;
      exitNotes: string | null;
      strikePrice: number | null;
      expirationDate: string | null;
      premiumReceived: number | null;
      currentPrice: number | null;
      unrealizedPnl: number | null;
      realizedPnl: number | null;
      status: 'open' | 'closed';
      createdAt: string;
      updatedAt: string;
    }[]; error?: string }>('portfolio:listByTicker', ticker),

    // ── Phase 1: E*Trade Sync ─────────────────────────────────────────────────
    etrade: {
      listAccounts: () => invoke<EtradeAccount[]>('portfolio:etrade:listAccounts'),
      sync: (accountIdKey?: string) => invoke<EtradeSyncResult>('portfolio:etrade:sync', accountIdKey),
      syncClosed: (accountIdKey?: string) => invoke<EtradeSyncResult>('portfolio:etrade:sync-closed', accountIdKey),
      lastSync: () => invoke<string | null>('portfolio:etrade:lastSync'),
      listPositions: () => invoke<PositionEtrade[]>('portfolio:etrade:listPositions'),
    },

    // ── Phase 2: Per-Position Analysis ────────────────────────────────────────
    analysis: {
      run: (positionId: number) => invoke<PositionAnalysis>('portfolio:analysis:run', positionId),
      runAll: () => invoke<PositionAnalysis[]>('portfolio:analysis:runAll'),
      get: (positionId: number) => invoke<PositionAnalysis | null>('portfolio:analysis:get', positionId),
    },

    // ── Phase 3: AI Advisor ───────────────────────────────────────────────────
    advisor: {
      run: () => invoke<AdvisorSession>('portfolio:advisor:run'),
      history: (limit?: number) => invoke<AdvisorSession[]>('portfolio:advisor:history', limit),
      setApiKey: (key: string) => invoke<boolean>('portfolio:advisor:setApiKey', key),
      hasApiKey: () => invoke<boolean>('portfolio:advisor:hasApiKey'),
      /** Subscribe to streaming progress events. Returns an unsubscribe function. */
      onProgress: (callback: (evt: AdvisorProgressEvent) => void) => {
        const handler = (_: unknown, evt: AdvisorProgressEvent) => callback(evt);
        ipcRenderer.on('portfolio:advisor:progress', handler);
        return () => ipcRenderer.removeListener('portfolio:advisor:progress', handler);
      },
    },
  };

  const optionsChain = {
    getNearExpirations: (ticker: string) =>
      invoke<{ expirations: OptionsChainExpirationSummary[]; currentPrice: number | null; currentIv: number | null }>('options:get-near-expirations', ticker),
    getChain: (ticker: string, expiration: string) =>
      invoke<OptionsChainViewData>('options:get-chain', ticker, expiration)
  };

  const etrade = {
    /**
     * Startup freshness check — date-based, no API call.
     * 'ok'             — token issued today (ET), still valid
     * 'expired'        — token crossed a midnight ET boundary, re-auth required
     * 'no_token'       — credentials saved but never authenticated
     * 'no_credentials' — no consumer key/secret saved
     */
    checkConnection: () => invoke<{
      status: 'ok' | 'no_credentials' | 'no_token' | 'expired';
    }>('etrade:check-connection'),
    getStatus: () => invoke<{
      status: { hasConsumerKey: boolean; hasConsumerSecret: boolean; hasAccessToken: boolean; isConfigured: boolean; isAuthenticated: boolean };
      consumerKey: string;
      consumerSecret: string;
    }>('etrade:get-status'),
    saveCredentials: (consumerKey: string, consumerSecret: string) =>
      invoke<boolean>('etrade:save-credentials', consumerKey, consumerSecret),
    startAuth: () => invoke<{ authUrl: string }>('etrade:start-auth'),
    submitVerifier: (verifier: string) => invoke<boolean>('etrade:submit-verifier', verifier),
    renewToken: () => invoke<boolean>('etrade:renew-token'),
    disconnect: () => invoke<boolean>('etrade:disconnect'),
    getExpirations: (symbol: string) => invoke<Array<{
      year: number; month: number; day: number; expiryType: string; dateStr: string;
    }>>('etrade:get-expirations', symbol),
    getOptionsChain: (symbol: string, expiration: { year: number; month: number; day: number; expiryType: string; dateStr: string }) =>
      invoke<{
        ticker: string; expiration: string; underlyingPrice: number | null;
        totalContracts: number; withGreeks: number; withBidAsk: number;
        rawTopLevelKeys: string[]; rawResponseKeys: string[]; pairsCount: number;
        rawSampleCall: string; rawSamplePut: string;
        calls: Array<{
          symbol: string; osiKey: string; optionType: 'CALL' | 'PUT'; strikePrice: number;
          bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null;
          lastPrice: number | null; volume: number | null; openInterest: number | null; inTheMoney: boolean;
          greek: { delta: number | null; gamma: number | null; theta: number | null; vega: number | null; rho: number | null; iv: number | null };
          hasGreeks: boolean; hasBidAsk: boolean;
        }>;
        puts: Array<{
          symbol: string; osiKey: string; optionType: 'CALL' | 'PUT'; strikePrice: number;
          bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null;
          lastPrice: number | null; volume: number | null; openInterest: number | null; inTheMoney: boolean;
          greek: { delta: number | null; gamma: number | null; theta: number | null; vega: number | null; rho: number | null; iv: number | null };
          hasGreeks: boolean; hasBidAsk: boolean;
        }>;
      }>('etrade:get-options-chain', symbol, expiration),
    /** Fetch a raw quote with detailFlag=ALL — used in the Test API screen to inspect every field E*Trade returns. */
    getRawQuote: (symbol: string) =>
      invoke<{ rawJson: string; topLevelKeys: string[] }>('etrade:get-raw-quote', symbol),
  };

  const testApi = {
    getRawOptions: (ticker: string, expiration: string) =>
      invoke<{
        ticker: string;
        expiration: string;
        underlyingPrice: number | null;
        totalContracts: number;
        contractsWithGreeks: number;
        contractsWithLastQuote: number;
        pages: number;
        polygonStatus: string;
        rawResultsType: string;
        rawResultsCount: number;
        firstPageKeys: string[];
        contracts: Array<{
          ticker: string; strike: number; expiration: string; contractType: string; exerciseStyle: string;
          impliedVolatility: number | null; openInterest: number | null; breakEvenPrice: number | null; fmv: number | null;
          delta: number | null; gamma: number | null; theta: number | null; vega: number | null; hasGreeks: boolean;
          bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null; quoteMidpoint: number | null; hasLastQuote: boolean;
          dayClose: number | null; dayVolume: number | null; dayVwap: number | null;
          lastTradePrice: number | null; underlyingPrice: number | null;
        }>;
      }>('test-api:get-raw-options', ticker, expiration),

    getMarketDataChain: (ticker: string, date: string) =>
      invoke<{
        ticker: string;
        date: string;
        status: string;
        contractCount: number;
        underlyingPrice: number | null;
        sample: Array<{
          optionSymbol: string; expiration: string; side: string;
          strike: number; iv: number | null; delta: number | null;
          underlyingPrice: number | null; dte: number | null;
        }>;
        atmIvResult: {
          atmIv: number | null; atmIvPct: number | null;
          expNear: string | null; expFar: string | null;
          dteNear: number | null; dteFar: number | null;
          estimatedFromDelta: boolean;
        } | null;
        withIv: number; withBsIv: number; withDelta: number; withUndPx: number;
        rawTopLevelKeys: string[];
        rawFieldTypes: Record<string, string>;
        rawContractSample: string;
        rawJsonSample: string;
      }>('test-api:get-marketdata-chain', ticker, date),

    saveIVolatilityKey: (key: string) =>
      invoke<boolean>('test-api:save-ivolatility-key', key),

    getIVolatilityKeyConfigured: () =>
      invoke<boolean>('test-api:get-ivolatility-key-configured'),

    getIVolatilityIvx: (symbol: string, from: string, to: string) =>
      invoke<{
        symbol: string; from: string; to: string;
        status: string; rowCount: number;
        rows: Array<{
          date: string;
          iv30: number | null; iv60: number | null; iv90: number | null;
          iv7: number | null; iv14: number | null; iv21: number | null;
          iv120: number | null; iv180: number | null; iv360: number | null;
        }>;
        iv30Min: number | null; iv30Max: number | null;
        iv30Latest: number | null; iv30LatestDate: string | null;
        rawTopLevelKeys: string[];
        rawFieldTypes: Record<string, string>;
        rawSample: string;
      }>('test-api:get-ivolatility-ivx', symbol, from, to),
  };

  const agent = {
    openDb: (dbPath: string) => invoke<boolean>('agent:open-db', dbPath),
    closeDb: () => invoke<boolean>('agent:close-db'),
    getStatus: () => invoke<AgentStatus>('agent:get-status'),
    getTrades: (statusFilter?: 'open' | 'closed' | 'all') =>
      invoke<AgentTrade[]>('agent:get-trades', statusFilter),
    getLessons: (limit?: number) => invoke<AgentLesson[]>('agent:get-lessons', limit),
    getTheoryChecks: (limit?: number) => invoke<AgentTheoryCheck[]>('agent:get-theory-checks', limit),
    getNativeLessons: () => invoke<AgentNativeLesson[]>('agent:get-native-lessons'),
    getDashboard: () => invoke<AgentDashboard>('agent:get-dashboard'),
    getLiveRecommendations: () => invoke<AgentRecommendation[]>('agent:get-live-recommendations'),
    getRecommendations: () => invoke<AgentRecommendation[]>('agent:get-recommendations'),
    getMemory: () => invoke<AgentMemorySnapshot | null>('agent:get-memory'),
    runPhase: (phase: string, projectPath: string) =>
      invoke<{ pid: number; phase: string }>('agent:run-phase', phase, projectPath),
    closeTrade: (tradeId: number, reason: string, projectPath: string) =>
      invoke<{ pid: number; tradeId: number }>('agent:close-trade', tradeId, reason, projectPath),
    readConfig: (projectPath: string) => invoke<AgentConfig>('agent:read-config', projectPath),
    writeConfig: (projectPath: string, config: AgentConfig) =>
      invoke<boolean>('agent:write-config', projectPath, config),
    sendPositionsEmail: (projectPath: string) =>
      invoke<{ sent: number }>('agent:send-positions-email', projectPath),
    deleteTrade: (id: number) => invoke<true>('agent:delete-trade', id),
    listStrategies: () => invoke<AgentStrategiesState>('agent:list-strategies'),
    saveStrategy: (strategy: AgentStrategy) => invoke<AgentStrategy>('agent:save-strategy', strategy),
    deleteStrategy: (id: string) => invoke<boolean>('agent:delete-strategy', id),
    setActiveStrategy: (id: string) => invoke<boolean>('agent:set-active-strategy', id),
    onLog: (callback: (data: { pid: number; phase: string; line: string }) => void) => {
      const handler = (_: unknown, data: { pid: number; phase: string; line: string }) => callback(data);
      ipcRenderer.on('agent:log', handler);
      return () => ipcRenderer.removeListener('agent:log', handler);
    },
    onPhaseDone: (callback: (data: { pid: number; phase: string; code: number | null }) => void) => {
      const handler = (_: unknown, data: { pid: number; phase: string; code: number | null }) => callback(data);
      ipcRenderer.on('agent:phase-done', handler);
      return () => ipcRenderer.removeListener('agent:phase-done', handler);
    }
  };

  const leapsCsp = {
    runScreen: (universe: 'sp500' | 'russell1000' | 'both' | 'etf', forceRun?: boolean, watchlistId?: number | null) =>
      invoke<LeapsCspRunResult>('leaps-csp:run-screen', universe, forceRun, watchlistId),
    getRuns: () => invoke<LeapsCspRunSummary[]>('leaps-csp:get-runs'),
    getRun: (runId: number) => invoke<LeapsCspRunResult | null>('leaps-csp:get-run', runId),
    markOpened: (opportunityId: number, entry: { leapsEntryDebit?: number; cspEntryCredit?: number; notes?: string }) =>
      invoke<boolean>('leaps-csp:mark-opened', opportunityId, entry),
    getOpened: () => invoke<LeapsCspOpenedEntry[]>('leaps-csp:get-opened'),
    deleteRun: (runId: number) => invoke<boolean>('leaps-csp:delete-run', runId),
    onProgress: (callback: (msg: string) => void) => {
      const handler = (_: unknown, msg: string) => callback(msg);
      ipcRenderer.on('leaps-csp:progress', handler);
      return () => ipcRenderer.removeListener('leaps-csp:progress', handler);
    },
    onProgressDetail: (callback: (detail: LeapsCspProgressDetail) => void) => {
      const handler = (_: unknown, detail: LeapsCspProgressDetail) => callback(detail);
      ipcRenderer.on('leaps-csp:progress-detail', handler);
      return () => ipcRenderer.removeListener('leaps-csp:progress-detail', handler);
    },
  };

  const collaredLeaps = {
    runScreen: (universe: 'sp500' | 'russell1000' | 'both' | 'etf', forceRun?: boolean, watchlistId?: number | null) =>
      invoke<CollaredLeapsRunResult>('collared-leaps:run-screen', universe, forceRun, watchlistId),
    getRuns: () => invoke<CollaredLeapsRunSummary[]>('collared-leaps:get-runs'),
    getRun: (runId: number) => invoke<CollaredLeapsRunResult | null>('collared-leaps:get-run', runId),
    markOpened: (opportunityId: number, entry: { leapsEntryDebit?: number; putEntryDebit?: number; notes?: string }) =>
      invoke<boolean>('collared-leaps:mark-opened', opportunityId, entry),
    getOpened: () => invoke<CollaredLeapsOpenedEntry[]>('collared-leaps:get-opened'),
    deleteRun: (runId: number) => invoke<boolean>('collared-leaps:delete-run', runId),
    onProgress: (callback: (msg: string) => void) => {
      const handler = (_: unknown, msg: string) => callback(msg);
      ipcRenderer.on('collared-leaps:progress', handler);
      return () => ipcRenderer.removeListener('collared-leaps:progress', handler);
    },
    onProgressDetail: (callback: (detail: CollaredLeapsProgressDetail) => void) => {
      const handler = (_: unknown, detail: CollaredLeapsProgressDetail) => callback(detail);
      ipcRenderer.on('collared-leaps:progress-detail', handler);
      return () => ipcRenderer.removeListener('collared-leaps:progress-detail', handler);
    },
  };

  const backtest = {
    config: {
      list: () => invoke<BacktestConfig[]>('backtest:config:list'),
      create: (cfg: Omit<BacktestConfig, 'id' | 'createdAt'>) => invoke<number>('backtest:config:create', cfg),
      delete: (configId: number) => invoke<boolean>('backtest:config:delete', configId)
    },
    run: {
      list: (configId?: number) => invoke<BacktestRun[]>('backtest:run:list', configId),
      get: (runId: number) => invoke<BacktestRun | null>('backtest:run:get', runId),
      start: (configId: number) => invoke<{ runId: number }>('backtest:run:start', configId),
      cancel: () => invoke<boolean>('backtest:run:cancel'),
      delete: (runId: number) => invoke<boolean>('backtest:run:delete', runId),
      metrics: (runId: number) => invoke<BacktestMetrics | null>('backtest:run:metrics', runId),
      trades: (runId: number) => invoke<BacktestTrade[]>('backtest:run:trades', runId),
      onProgress: (callback: (evt: BacktestProgressEvent) => void) => {
        const handler = (_: any, evt: any) => callback(evt);
        ipcRenderer.on('backtest:progress', handler);
        return () => ipcRenderer.removeListener('backtest:progress', handler);
      }
    }
  };

  const filters = {
    listTemplates: () => invoke<FilterTemplate[]>('filters:list-templates'),
    runTemplate: (templateId: string, source?: 'watchlist' | 'universe', universe?: Universe, watchlistIds?: number[]) =>
      invoke<FilterTemplateResult[]>('filters:run-template', templateId, source, universe, watchlistIds),
    onProgress: (callback: (data: { current: number; total: number; ticker: string }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('filters:progress', handler);
      return () => ipcRenderer.removeListener('filters:progress', handler);
    }
  };

  const payoff = {
    save:   (name: string, ticker: string | null, legs: PayoffLeg[]) => invoke<SavedPayoffStrategy>('payoff:save', name, ticker, legs),
    list:   () => invoke<SavedPayoffStrategy[]>('payoff:list'),
    delete: (id: number) => invoke<boolean>('payoff:delete', id),
    assess: (legs: PayoffLeg[], input: PayoffAssessInput) =>
      invoke<PayoffAssessment>('payoff:assess', legs, input),
    onAssessProgress: (callback: (chunk: string) => void) => {
      const handler = (_: unknown, chunk: string) => callback(chunk);
      ipcRenderer.on('payoff:assess:progress', handler);
      return () => ipcRenderer.removeListener('payoff:assess:progress', handler);
    },
  };

  const ivHistory = {
    getCoverage:         (universe: 'sp500' | 'russell1000' | 'both' | 'etf') => invoke<IvHistoryCoverage>('iv-history:get-coverage', universe),
    getGaps:             (universe: 'sp500' | 'russell1000' | 'both' | 'etf') => invoke<IvHistoryGapSummary>('iv-history:get-gaps', universe),
    startBackfill:       (phase: IvHistoryBackfillPhase) => invoke<{ processed: number; skipped: number; failed: number }>('iv-history:start-backfill', phase),
    cancel:              () => invoke<boolean>('iv-history:cancel'),
    getRank:             (ticker: string) => invoke<IvRankResult>('iv-history:get-rank', ticker),
    getRanks:            (tickers: string[]) => invoke<IvRankResult[]>('iv-history:get-ranks', tickers),
    getRows:             (ticker: string) => invoke<Array<{ date: string; atm_iv: number; underlying_px: number | null; source: string }>>('iv-history:get-rows', ticker),
    getInitialLoadStatus: () => invoke<{
      sp500:   { complete: boolean; completedAt: string | null };
      russell: { complete: boolean; completedAt: string | null; newTickers: number };
      etf:     { complete: boolean; completedAt: string | null; totalTickers: number };
    }>('iv-history:get-initial-load-status'),
    onProgress: (callback: (evt: IvHistoryProgressEvent) => void) => {
      const handler = (_: unknown, evt: IvHistoryProgressEvent) => callback(evt);
      ipcRenderer.on('iv-history:progress', handler);
      return () => ipcRenderer.removeListener('iv-history:progress', handler);
    },
  };

  const opportunity = {
    run: (opts: OpportunityRunOptions) => invoke<OpportunityRow[]>('opportunity:run', opts),
  };

  const strategyLab = {
    validate:    (ticker: string) =>
      invoke<StrategyLabValidateResult>('strategyLab:validate', ticker),
    explore:     (ticker: string, slug: string) =>
      invoke<StrategySetup>('strategyLab:explore', ticker, slug),
    aiRationale: (score: StrategyScore, ctx: StrategyLabContext) =>
      invoke<string>('strategyLab:aiRationale', score, ctx),
  };

  return {
    api: { watchlists, screen, quotes, analysis, validateAll, validate, jobs, settings, diagnostics, cache, historical, portfolio, alerts, optionsChain, agent, backtest, leapsCsp, collaredLeaps, testApi, etrade, filters, payoff, ivHistory, opportunity, strategyLab },
    dialog: {
      prompt: (opts: { title: string; defaultValue?: string }) =>
        invoke<string | null>('dialog:prompt', opts),
      confirm: (opts: { title: string; message: string }) =>
        invoke<boolean>('dialog:confirm', opts)
    }
  };
}

const { api, dialog } = buildApi();
contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('dialog', dialog);