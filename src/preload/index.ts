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
  DiagnosticsResult,
  CacheStatus,
  CacheStats
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
    getMeta: (index: 'sp500' | 'russell1000') =>
      invoke<ConstituentsMeta | null>('screen:get-meta', index),
    refreshConstituents: (index: 'sp500' | 'russell1000') =>
      invoke<ConstituentsMeta>('screen:refresh-constituents', index),
    importConstituents: (filePath: string, index: 'sp500' | 'russell1000') =>
      invoke<{ count: number }>('screen:import-constituents', { filePath, index }),
    run: (criteria: ScreenCriteria) =>
      invoke<{ resultCount: number; rows: ScreenResultRow[] }>('screen:run', criteria),
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
    openTickerById: (args: { ticker: string }) =>
      invoke<ValidateDashboardResult>('validate:open-ticker-by-id', args),
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

  const cache = {
    getStatus: () => invoke<CacheStatus>('cache:getStatus'),
    getStats: () => invoke<CacheStats>('cache:getStats'),
    updateLastRun: (recordCount?: number) => invoke<boolean>('cache:updateLastRun', recordCount),
    reset: () => invoke<boolean>('cache:reset'),
    refresh: () => invoke<boolean>('cache:refresh'),
    isStale: () => invoke<boolean>('cache:isStale')
  };

  const websocket = {
    connect: () => invoke<boolean>('websocket:connect'),
    disconnect: () => invoke<boolean>('websocket:disconnect'),
    subscribe: (ticker: string) => invoke<boolean>('websocket:subscribe', ticker),
    unsubscribe: (ticker: string) => invoke<boolean>('websocket:unsubscribe', ticker),
    isConnected: () => invoke<boolean>('websocket:isConnected'),
    getSubscribed: () => invoke<string[]>('websocket:getSubscribed'),
    onPrice: (callback: (data: { ticker: string; price: number; change: number; changePct: number }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('websocket:price', handler);
      return () => ipcRenderer.removeListener('websocket:price', handler);
    },
    onConnected: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('websocket:connected', handler);
      return () => ipcRenderer.removeListener('websocket:connected', handler);
    },
    onDisconnected: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('websocket:disconnected', handler);
      return () => ipcRenderer.removeListener('websocket:disconnected', handler);
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_: any, error: string) => callback(error);
      ipcRenderer.on('websocket:error', handler);
      return () => ipcRenderer.removeListener('websocket:error', handler);
    },
    onAlert: (callback: (data: { alertId: number; ticker: string; alertType: string; triggered: boolean; message: string; playSound: boolean }) => void) => {
      const handler = (_: any, data: any) => callback(data);
      ipcRenderer.on('websocket:alert', handler);
      return () => ipcRenderer.removeListener('websocket:alert', handler);
    }
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
      invoke<boolean>('historical:needsRefresh', ticker, dataType, maxAgeDays)
  };

  const briefing = {
    getMarketRegime: () => invoke<{
      success: boolean;
      data?: {
        spyTrend: 'bullish' | 'bearish' | 'neutral';
        spyPrice: number | null;
        spySma20: number | null;
        spySma50: number | null;
        vixLevel: 'low' | 'normal' | 'high';
        vixValue: number | null;
        summary: string;
      };
      error?: string;
    }>('briefing:getMarketRegime'),
    getActionItems: () => invoke<{
      success: boolean;
      data?: {
        type: 'expiring' | 'delta_breach' | 'earnings';
        ticker: string;
        details: string;
        priority: 'high' | 'medium' | 'low';
        positionId?: number;
        daysRemaining?: number;
        delta?: number;
        expirationDate?: string;
      }[];
      error?: string;
    }>('briefing:getActionItems'),
    getTopSetups: () => invoke<{
      success: boolean;
      data?: {
        ticker: string;
        roe: number | null;
        peRatio: number | null;
        debtToEquity: number | null;
        marketCap: number | null;
        fcfYield: number | null;
        wheelSuitability: number | null;
        targetStrike: number | null;
        estimatedPremium: number | null;
        lastPrice: number | null;
      }[];
      error?: string;
    }>('briefing:getTopSetups'),
    getFull: () => invoke<{
      success: boolean;
      data?: {
        generatedAt: string;
        marketRegime: {
          spyTrend: 'bullish' | 'bearish' | 'neutral';
          spyPrice: number | null;
          spySma20: number | null;
          spySma50: number | null;
          vixLevel: 'low' | 'normal' | 'high';
          vixValue: number | null;
          summary: string;
        };
        actionItems: {
          type: 'expiring' | 'delta_breach' | 'earnings';
          ticker: string;
          details: string;
          priority: 'high' | 'medium' | 'low';
          positionId?: number;
          daysRemaining?: number;
          delta?: number;
          expirationDate?: string;
        }[];
        topSetups: {
          ticker: string;
          roe: number | null;
          peRatio: number | null;
          debtToEquity: number | null;
          marketCap: number | null;
          fcfYield: number | null;
          wheelSuitability: number | null;
          targetStrike: number | null;
          estimatedPremium: number | null;
          lastPrice: number | null;
        }[];
      };
      error?: string;
    }>('briefing:getFull')
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
    }[]; error?: string }>('portfolio:listByTicker', ticker)
  };

  return {
    api: { watchlists, screen, quotes, analysis, validateAll, validate, jobs, settings, diagnostics, cache, websocket, historical, portfolio, briefing, alerts },
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