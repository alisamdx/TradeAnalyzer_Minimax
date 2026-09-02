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
  ConstituentWithMeta,
  Quote as CachedQuote,
  AnalysisModeInfo,
  AnalysisRunResult,
  AnalysisAllModesRunResult,
  AnalysisAllModesPayload,
  AnalysisSnapshotRow,
  AnalysisProgressEvent,
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
  AgentTradeLearning,
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
  FilterSavedRun,
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
  RollPositionInput,
  RollMetric,
  RollAnalysis,
  PretradeValidateInput,
  PretradeValidationResult,
  PretradeValidationRow,
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
  BatchJob,
  BatchRun,
  AppNotification,
  BatchProgressEvent,
  ScoringSignal,
  ScoringConfig,
  ScoringStrategy,
  DailyBriefEntry,
  PaperTrade,
  PaperTradeWithPnl,
  PaperTradeSummary,
  StrategyBreakdown,
  RetroSettings,
  BriefAccuracy,
  SnapshotAccuracy,
  BriefPerformanceSummary,
  BriefHealthTrend,
  BriefPickDetail,
  BriefLearningRecommendation,
  SignalWeightSuggestion,
  ConvictionStock,
  ConvictionBandHistory,
  ConvictionInput,
  ConvictionRecommendation,
  ConvictionAiReview,
  NewsResearchResult,
  MacroEvent,
  NewsBatchProgressEvent,
  ReplayProgressEvent,
  ReplayPickRow,
  ReplaySummary,
  ExecConfig,
  ExecRiskState,
  ExecEngineStateView,
  ExecEngineEvent,
  ExecPositionRow,
  ExecProposalRow,
  ExecAuditRow,
  ExecDryRunRow,
  ExecApproveResult,
  ExecStartResult,
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
    },
    /** Subscribe to push notifications from the main process when a watchlist is
     *  created or modified by a background job (e.g. Daily Brief auto-watchlist).
     *  Returns an unsubscribe function. */
    onUpdated: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on('watchlists:updated', handler);
      return () => ipcRenderer.removeListener('watchlists:updated', handler);
    },
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
    getConstituentsWithMeta: (index: 'sp500' | 'russell1000') =>
      invoke<ConstituentWithMeta[]>('screen:get-constituents-with-meta', index),
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
    runAll: (watchlistId: number, tickerSubset?: string[]) =>
      invoke<AnalysisAllModesRunResult>('analysis:run-all', { watchlistId, tickerSubset }),
    getSnapshots: (watchlistId: number) => invoke<AnalysisSnapshotRow[]>('analysis:get-snapshots', watchlistId),
    getSnapshot: (id: number) => invoke<{ id: number; watchlistId: number; mode: string; runAt: string; resultCount: number; results: unknown[] } | null>('analysis:get-snapshot', id),
    getAllModesSnapshot: (id: number) => invoke<{ tickerCount: number; results: AnalysisAllModesPayload } | null>('analysis:get-all-modes-snapshot', id),
    deleteSnapshot: (id: number) => invoke<{ success: boolean }>('analysis:delete-snapshot', id),
    clearSnapshots: (watchlistId: number) => invoke<{ success: boolean }>('analysis:clear-snapshots', watchlistId),
    saveAsWatchlist: (snapshotId: number, resultIndices: number[], name: string) =>
      invoke<Watchlist>('analysis:save-as-watchlist', snapshotId, resultIndices, name),
    cancel: () => invoke<boolean>('analysis:cancel'),
    onProgress: (callback: (data: AnalysisProgressEvent) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data as AnalysisProgressEvent);
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
    getFinnhubKey: () => invoke<string>('settings:get-finnhub-key'),
    setFinnhubKey: (key: string) => invoke<boolean>('settings:set-finnhub-key', key),
    openLogsDir: () => invoke<boolean>('settings:open-logs-dir'),
    backup: () => invoke<{ backupPath: string; message: string } | null>('settings:backup-everything'),
    restore: () => invoke<{ restored: boolean; message: string } | null>('settings:restore-backup'),
    /** Opens a folder picker; returns the chosen absolute path, or null if cancelled. */
    pickDirectory: () => invoke<string | null>('settings:pick-directory'),
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      delta: number | null;
      theta: number | null;
      vega: number | null;
    }[]; error?: string }>('portfolio:list', status),
    get: (id: number) => invoke<{ success: boolean; data?: {
      id: number;
      ticker: string;
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
      positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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

    fetchGreeks: () => invoke<{ updated: number; failed: number; errors: string[] }>('portfolio:fetchGreeks'),
    capitalEfficiency: () => invoke<{
      portfolio: Record<string, number | null>;
      positions: Array<Record<string, string | number | boolean | null>>;
      portfolioValue: number | null;
    }>('portfolio:capitalEfficiency'),

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
      invoke<{ expirations: OptionsChainExpirationSummary[]; allExpirations: string[]; currentPrice: number | null; currentIv: number | null }>('options:get-near-expirations', ticker),
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
    /**
     * LIVE connection test — actually calls E*Trade and renews-and-retries if the token is
     * dormant, so the result reflects whether the token works right now (not just its date).
     * 'renewed' = was dormant, auto-revived; 'error' = transient network/E*Trade issue.
     */
    testConnection: () => invoke<{
      status: 'ok' | 'renewed' | 'no_credentials' | 'no_token' | 'expired' | 'error';
      detail?: string;
    }>('etrade:test-connection'),
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

    getMarketDataLiveChain: (ticker: string) =>
      invoke<{
        ticker: string; date: string; status: string;
        contractCount: number; underlyingPrice: number | null;
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
      }>('test-api:get-marketdata-live-chain', ticker),

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

    saveFinnhubKey: (key: string) =>
      invoke<boolean>('test-api:save-finnhub-key', key),

    getFinnhubKeyConfigured: () =>
      invoke<boolean>('test-api:get-finnhub-key-configured'),

    getFinnhubEarnings: (from: string, to: string, symbol?: string) =>
      invoke<{
        from: string; to: string;
        totalEntries: number;
        matchedConstituents: number;
        constituentCount: number;
        entries: Array<{
          date: string; symbol: string;
          epsActual: number | null; epsEstimate: number | null;
          hour: string | null; quarter: number | null; year: number | null;
          revenueActual: number | null; revenueEstimate: number | null;
        }>;
        rawSample: string;
      }>('test-api:get-finnhub-earnings', from, to, symbol),

    getEdgarFundamentals: (ticker: string) =>
      invoke<{
        ticker: string;
        cik: string;
        entityName: string;
        fields: Array<{
          role: string;
          label: string;
          conceptUsed: string | null;
          conceptsTried: string[];
          unit: string | null;
          found: boolean;
          latestAnnualVal: number | null;
          latestAnnualDate: string | null;
          latestQtrVal: number | null;
          latestQtrDate: string | null;
          annualCount: number;
          quarterlyCount: number;
        }>;
        totalConceptCount: number;
        topGaapConcepts: string[];
        rawSample: string;
      }>('test-api:edgar-fundamentals', ticker),
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
    captureTradeLearning: (trade: AgentTrade) =>
      invoke<AgentTradeLearning>('agent:capture-trade-learning', trade),
    getTradeLearnings: () => invoke<AgentTradeLearning[]>('agent:get-trade-learnings'),
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
    },
    replayPicks: (strategy: 'wheel' | 'income' | 'inflection' | 'buy' | 'bullish' | 'bearish') =>
      invoke<import('@shared/types.js').AggregatePickBacktest>('backtest:replay-picks', strategy),
    ivCoverage: () => invoke<string | null>('backtest:iv-coverage'),
  };

  const filters = {
    listTemplates: () => invoke<FilterTemplate[]>('filters:list-templates'),
    runTemplate: (templateId: string, source?: 'watchlist' | 'universe', universe?: Universe, watchlistIds?: number[]) =>
      invoke<FilterTemplateResult[]>('filters:run-template', templateId, source, universe, watchlistIds),
    getSavedRuns: () => invoke<FilterSavedRun[]>('filters:get-saved-runs'),
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

  const pretradeValidator = {
    validate: (input: PretradeValidateInput) =>
      invoke<PretradeValidationResult>('pretradeValidator:validate', input),
    history: (limit?: number) =>
      invoke<PretradeValidationRow[]>('pretradeValidator:history', limit),
  };

  const roll = {
    analyze: (input: RollPositionInput, metric: RollMetric) =>
      invoke<RollAnalysis>('roll:analyze', input, metric),
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

  const scoring = {
    getConfig: (strategy?: ScoringStrategy) =>
      strategy
        ? invoke<ScoringConfig>('scoring:get-config', strategy)
        : invoke<ScoringConfig[]>('scoring:get-config'),
    updateConfig: (strategy: ScoringStrategy, signals: ScoringSignal[], version: string) =>
      invoke<boolean>('scoring:update-config', strategy, signals, version),
    resetToBaseline: (strategy: ScoringStrategy) =>
      invoke<ScoringConfig>('scoring:reset-to-baseline', strategy),
    getLatestBrief: (strategy?: ScoringStrategy) =>
      invoke<DailyBriefEntry[]>('scoring:get-latest-brief', strategy),
    getBriefHistory: (limit?: number) =>
      invoke<DailyBriefEntry[]>('scoring:get-brief-history', limit),
    resendBriefEmail: () =>
      invoke<{ sent: boolean; message: string }>('scoring:resend-brief-email'),
    /** Roll the Dice: one wheel entry from the latest brief, or an explicit nothing. */
    rollTheDice: (maxPrice?: number) => invoke<{
      pick: {
        ticker: string; price: number; compositeScore: number; briefRank: number;
        strike: number; expiration: string; dte: number;
        premiumPerShare: number; creditTotal: number; capitalRequired: number;
        effectiveCostBasis: number; discountToSpotPct: number;
        annualizedReturn: number | null; popEstimate: number | null;
        liquidityScore: number; grade: string;
        criticRationale: string | null; aiRationale: string | null;
      } | null;
      noPickReason: string | null;
      briefDate: string | null;
      briefAgeDays: number | null;
      staleWarning: string | null;
      considered: number;
      rejections: Array<{ ticker: string; reason: string }>;
      runnerUp: { ticker: string; compositeScore: number } | null;
    }>('scoring:roll-the-dice', maxPrice),
    signalCorrelations: (strategy: ScoringStrategy) =>
      invoke<SignalWeightSuggestion[]>('scoring:signal-correlations', strategy),
    briefHealthTrend: () =>
      invoke<BriefHealthTrend[]>('scoring:brief-health-trend'),
  };

  const batch = {
    listJobs:   () => invoke<BatchJob[]>('batch:list-jobs'),
    listRuns:   (jobId: string) => invoke<BatchRun[]>('batch:list-runs', jobId),
    briefFreshness: () => invoke<{ generatedAt: string | null; etDate: string | null; isToday: boolean }>('batch:brief-freshness'),
    runNow:     (jobId: string) => invoke<boolean>('batch:run-now', jobId),
    runNowSync: (jobId: string) => invoke<boolean>('batch:run-now-sync', jobId),
    cancel:     (jobId: string) => invoke<boolean>('batch:cancel', jobId),
    updateJob:    (jobId: string, patch: Partial<BatchJob>) => invoke<boolean>('batch:update-job', jobId, patch),
    reorderJobs:  (jobIds: string[]) => invoke<boolean>('batch:reorder', jobIds),
    setEnabled: (enabled: boolean) => invoke<boolean>('batch:set-enabled', enabled),
    getEnabled: () => invoke<boolean>('batch:get-enabled'),
    onProgress: (cb: (evt: BatchProgressEvent) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, evt: BatchProgressEvent) => cb(evt);
      ipcRenderer.on('batch:progress', handler);
      return () => ipcRenderer.removeAllListeners('batch:progress');
    },
    onNotification: (cb: (n: AppNotification) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, n: AppNotification) => cb(n);
      ipcRenderer.on('app:notification', handler);
      return () => ipcRenderer.removeAllListeners('app:notification');
    },
  };

  const paper = {
    listOpen:          (): Promise<PaperTradeWithPnl[]>  => invoke('paper:list-open'),
    listClosed:        (limit?: number): Promise<PaperTrade[]> => invoke('paper:list-closed', limit),
    close:             (id: number, notes?: string): Promise<boolean> => invoke('paper:close', id, notes),
    closeBulk:         (ids: number[], notes?: string): Promise<number> => invoke('paper:close-bulk', ids, notes),
    delete:            (id: number): Promise<boolean> => invoke('paper:delete', id),
    summary:           (): Promise<PaperTradeSummary> => invoke('paper:summary'),
    strategyBreakdown: (): Promise<StrategyBreakdown[]> => invoke('paper:strategy-breakdown'),
    expireStale:       (): Promise<number> => invoke('paper:expire-stale'),
    getSettings:       (): Promise<RetroSettings> => invoke('paper:get-settings'),
    saveSettings:      (settings: RetroSettings): Promise<boolean> => invoke('paper:save-settings', settings),
    briefAccuracy:     (briefDates: string[]): Promise<BriefAccuracy[]> => invoke('paper:brief-accuracy', briefDates),
    snapshotAccuracy:             (): Promise<SnapshotAccuracy> => invoke('paper:snapshot-accuracy'),
    briefPerformanceSummary:      (): Promise<BriefPerformanceSummary | null> => invoke('paper:brief-performance-summary'),
    briefDates:                   (): Promise<string[]> => invoke('paper:brief-dates'),
    briefPickDrilldown:           (briefDate: string): Promise<BriefPickDetail[]> => invoke('paper:brief-pick-drilldown', briefDate),
    getLearningRecommendations: (): Promise<BriefLearningRecommendation[]> => invoke('paper:get-learning-recommendations'),
    acknowledgeRecommendation:  (id: number): Promise<boolean> => invoke('paper:acknowledge-recommendation', id),
  };

  const conviction = {
    list:                () => invoke<ConvictionStock[]>('conviction:list'),
    add:                 (input: ConvictionInput) => invoke<ConvictionStock>('conviction:add', input),
    update:              (ticker: string, input: Omit<ConvictionInput, 'ticker'>) => invoke<ConvictionStock>('conviction:update', ticker, input),
    remove:              (ticker: string) => invoke<void>('conviction:remove', ticker),
    setInPlay:           (ticker: string, inPlay: boolean) => invoke<ConvictionStock>('conviction:set-in-play', ticker, inPlay),
    emailConfigured:     () => invoke<boolean>('conviction:email-configured'),
    sendEmail:           () => invoke<boolean>('conviction:send-email'),
    history:             (ticker: string) => invoke<ConvictionBandHistory[]>('conviction:history', ticker),
    recommend:           (ticker: string) => invoke<ConvictionRecommendation>('conviction:recommend', ticker),
    syncDefaultWatchlist: () => invoke<{ added: string[]; skipped: string[] }>('conviction:sync-default-watchlist'),
    aiReview:            () => invoke<ConvictionAiReview[]>('conviction:ai-review'),
  };

  const news = {
    fetchTicker:    (ticker: string) => invoke<NewsResearchResult>('news:fetch-ticker', ticker),
    refreshTicker:  (ticker: string) => invoke<NewsResearchResult>('news:refresh-ticker', ticker),
    fetchWatchlist: (tickers: string[], forceRefresh?: boolean) =>
      invoke<NewsResearchResult[]>('news:fetch-watchlist', tickers, forceRefresh),
    getCached:      (ticker: string) => invoke<NewsResearchResult | null>('news:get-cached', ticker),
    getMacroEvents: (daysAhead?: number) => invoke<MacroEvent[]>('news:get-macro-events', daysAhead),
    onBatchProgress: (cb: (p: NewsBatchProgressEvent) => void): (() => void) => {
      const handler = (_: unknown, p: NewsBatchProgressEvent) => cb(p);
      ipcRenderer.on('news:batch-progress', handler as Parameters<typeof ipcRenderer.on>[1]);
      return () => ipcRenderer.removeListener('news:batch-progress', handler as Parameters<typeof ipcRenderer.removeListener>[1]);
    },
  };

  const earnings = {
    get:       (ticker: string) =>
      invoke<{ ticker: string; reportDate: string; reportTime: 'bmo'|'amc'|null; source: string; confirmed: boolean; dte: number|null } | null>('earnings:get', ticker),
    upcoming:  (days?: number) =>
      invoke<{ ticker: string; reportDate: string; reportTime: 'bmo'|'amc'|null; source: string; confirmed: boolean; dte: number|null }[]>('earnings:upcoming', days),
    refresh:   (tickers?: string[], force?: boolean) =>
      invoke<{ updated: number; skipped: number; failed: number; errors: string[] }>('earnings:refresh', tickers, force),
    setManual: (ticker: string, reportDate: string, reportTime?: 'bmo'|'amc'|null) =>
      invoke<{ ticker: string; reportDate: string; reportTime: 'bmo'|'amc'|null; source: string; confirmed: boolean; dte: number|null }>('earnings:setManual', ticker, reportDate, reportTime),
    delete:        (ticker: string) => invoke<void>('earnings:delete', ticker),
    clearNonManual: () => invoke<number>('earnings:clearNonManual'),
  };

  const briefReplay = {
    runRange:   (from: string, to: string) =>
      invoke<{ started: boolean }>('replay:run-range', from, to),
    cancel:     () => invoke<{ cancelled: boolean }>('replay:cancel'),
    clear:      () => invoke<{ cleared: boolean }>('replay:clear'),
    getSummaries: () => invoke<ReplaySummary[]>('replay:get-summaries'),
    getPicks:   (strategy?: string, limit?: number) =>
      invoke<ReplayPickRow[]>('replay:get-picks', strategy, limit),
    getDateRange: () => invoke<{ from: string | null; to: string | null }>('replay:get-date-range'),
    getChartData: () => invoke<import('@shared/types.js').ReplayChartData | null>('replay:get-chart-data'),
    premiumHistoryReadiness: () => invoke<import('@shared/types.js').PremiumHistoryReadiness>('replay:premium-history-readiness'),
    onProgress: (cb: (p: ReplayProgressEvent) => void): (() => void) => {
      const handler = (_: unknown, p: ReplayProgressEvent) => cb(p);
      ipcRenderer.on('replay:progress', handler as Parameters<typeof ipcRenderer.on>[1]);
      return () => ipcRenderer.removeListener('replay:progress', handler as Parameters<typeof ipcRenderer.removeListener>[1]);
    },
  };

  const execution = {
    // reads
    getState:     () => invoke<ExecEngineStateView>('execution:get-state'),
    getConfig:    () => invoke<ExecConfig>('execution:get-config'),
    getRiskState: () => invoke<ExecRiskState>('execution:get-risk-state'),
    getPositions: () => invoke<ExecPositionRow[]>('execution:get-positions'),
    getRecentPositions: (limit?: number) => invoke<ExecPositionRow[]>('execution:get-recent-positions', limit),
    getProposals: () => invoke<ExecProposalRow[]>('execution:get-proposals'),
    getAudit:     (limit?: number) => invoke<ExecAuditRow[]>('execution:get-audit', limit),
    getDryRunLog: (limit?: number) => invoke<ExecDryRunRow[]>('execution:get-dry-run-log', limit),
    // config
    updateConfig: (patch: Partial<ExecConfig>) => invoke<ExecConfig>('execution:update-config', patch),
    // lifecycle / control
    start:     () => invoke<ExecStartResult>('execution:start'),
    stop:      () => invoke<{ ok: true }>('execution:stop'),
    pause:     () => invoke<{ ok: true }>('execution:pause'),
    killTrip:  () => invoke<{ ok: true }>('execution:kill-trip'),
    killClear: () => invoke<{ ok: true }>('execution:kill-clear'),
    // approvals
    approveProposal: (proposalId: number) => invoke<ExecApproveResult>('execution:approve-proposal', proposalId),
    rejectProposal:  (proposalId: number) => invoke<{ ok: boolean }>('execution:reject-proposal', proposalId),
    /** Subscribe to live engine events (state/cycle/health/reconcile). Returns an unsubscribe fn. */
    onEvent: (cb: (evt: ExecEngineEvent) => void): (() => void) => {
      const handler = (_: unknown, evt: ExecEngineEvent) => cb(evt);
      ipcRenderer.on('execution:event', handler as Parameters<typeof ipcRenderer.on>[1]);
      return () => ipcRenderer.removeListener('execution:event', handler as Parameters<typeof ipcRenderer.removeListener>[1]);
    },
  };

  return {
    api: { watchlists, screen, quotes, analysis, validateAll, validate, jobs, settings, diagnostics, cache, historical, portfolio, alerts, optionsChain, agent, backtest, leapsCsp, collaredLeaps, testApi, etrade, filters, payoff, roll, pretradeValidator, ivHistory, opportunity, strategyLab, batch, scoring, paper, conviction, news, earnings, briefReplay, execution },
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