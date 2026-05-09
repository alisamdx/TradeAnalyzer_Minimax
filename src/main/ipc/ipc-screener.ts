// IPC handlers for the Screener (FR-2) and Quote refresh (FR-1.7).
// see SPEC: FR-2, FR-1.7

import { ipcMain, BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron';
import type { ScreenerService } from '../services/screener-service.js';
import type { ConstituentsService } from '../services/constituents-service.js';
import type { WatchlistService } from '../services/watchlist-service.js';
import type { QuoteCache, CachedQuote, FundamentalsCache } from '../services/cache-service.js';
import type { DataProvider } from '../services/data-provider.js';
import { calculateWheelMetrics } from '../services/wheel-calculator.js';
import type {
  Universe,
  ScreenCriteria,
  ScreenPreset,
  ScreenRunResult,
  ScreenResultRow,
  ConstituentsMeta,
  IpcResult,
  CachedQuote as QuoteWithWheel
} from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}
function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false, error: { code, message } };
}
function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try { return ok(fn(...args)); }
    catch (err) { return fail(err); }
  };
}

export function registerScreenerIpc(
  screenerService: ScreenerService,
  constituentsService: ConstituentsService,
  watchlistService: WatchlistService,
  quoteCache: QuoteCache,
  fundamentalsCache: FundamentalsCache,
  dataProvider: DataProvider
): void {
  // ── Presets ──────────────────────────────────────────────────────────────
  ipcMain.handle('screen:list-presets', wrap(() => screenerService.listPresets()));
  ipcMain.handle(
    'screen:save-preset',
    wrap((preset: Omit<ScreenPreset, 'id' | 'createdAt'>) => screenerService.savePreset(preset))
  );
  ipcMain.handle('screen:delete-preset', wrap((id: number) => { screenerService.deletePreset(id); }));

  // ── Constituents ───────────────────────────────────────────────────────
  ipcMain.handle(
    'screen:get-constituents',
    wrap((index: Universe) => constituentsService.getConstituents(index))
  );
  ipcMain.handle('screen:get-meta', wrap((index: 'sp500' | 'russell1000') =>
    constituentsService.getMeta(index))
  );
  ipcMain.handle(
    'screen:refresh-constituents',
    async (_e, index: 'sp500' | 'russell1000'): Promise<IpcResult<ConstituentsMeta>> => {
      try {
        const result = await constituentsService.refreshFromWikipedia(index);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );
  ipcMain.handle(
    'screen:import-constituents',
    async (
      _e,
      args: { filePath?: string; index?: 'sp500' | 'russell1000' }
    ): Promise<IpcResult<{ count: number }>> => {
      try {
        const win = BrowserWindow.getFocusedWindow();
        const result = await dialog.showOpenDialog(win!, {
          title: 'Import constituents CSV',
          properties: ['openFile'],
          filters: [{ name: 'CSV', extensions: ['csv'] }]
        });
        if (result.canceled || !result.filePaths[0]) return fail(new Error('Cancelled'));
        const index = args.index ?? 'sp500';
        const count = constituentsService.importFromCsv(result.filePaths[0], index);
        return ok({ count });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Screen run ──────────────────────────────────────────────────────────
  ipcMain.handle(
    'screen:run',
    async (_e, criteria: ScreenCriteria): Promise<IpcResult<{ resultCount: number; rows: ScreenResultRow[] }>> => {
      try {
        const output = await screenerService.runScreen(criteria);
        // Map the backend TickerScreenData to the frontend ScreenResultRow format
        const rows: ScreenResultRow[] = output.rows.map(r => ({
          id: Math.random(), // Temporary ID for React keys since we don't save to DB
          screenRunId: 0,
          ticker: r.ticker,
          companyName: r.companyName,
          sector: r.sector,
          marketCap: r.marketCap,
          peRatio: r.peRatio,
          eps: r.eps,
          revenueGrowth: r.revenueGrowth,
          epsGrowth: r.epsGrowth,
          debtToEquity: r.debtToEquity,
          roe: r.roe,
          profitMargin: r.profitMargin,
          freeCashFlow: r.freeCashFlow,
          currentRatio: r.currentRatio,
          avgVolume: r.avgVolume,
          avgOptionVolume: r.avgOptionVolume,
          price: r.price,
          distance52WkHigh: r.distance52WkHigh,
          distance52WkLow: r.distance52WkLow,
          beta: r.beta,
          passedFilters: Array.from(r.passedFilters),
          failedFilters: r.failedFilters,
          passScore: r.passScore,
          payload: r
        }));
        
        return ok({ resultCount: rows.length, rows });
      } catch (err) {
        return fail(err);
      }
    }
  );

  let isSyncCancelled = false;

  ipcMain.handle(
    'screen:sync-universe',
    async (e, universe: Universe): Promise<IpcResult<{ scanned: number }>> => {
      isSyncCancelled = false;
      try {
        const output = await screenerService.syncUniverse(
          universe,
          (scanned, total, ticker) => {
            if (scanned % 5 === 0 || scanned === total) {
              e.sender.send('screen:sync-progress', { scanned, total, ticker });
            }
          },
          () => isSyncCancelled
        );
        return ok(output);
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle('screen:sync-cancel', async () => {
    isSyncCancelled = true;
    return ok(true);
  });

  ipcMain.handle('screen:get-runs', wrap(() => screenerService.getRuns()));
  ipcMain.handle('screen:get-results', wrap((runId: number) => screenerService.getResults(runId)));

  // ── Save as watchlist ────────────────────────────────────────────────────
  ipcMain.handle(
    'screen:save-as-watchlist',
    wrap((runId: number, resultIds: number[], name: string) => {
      const results = screenerService.getResults(runId)
        .filter((r) => resultIds.includes(r.id));
      const tickers = results.map((r) => ({ ticker: r.ticker, notes: null as string | null }));
      const wl = watchlistService.create(name);
      const added = watchlistService.addItemsBulk(wl.id, tickers);
      if (added.skipped.length > 0) {
        console.warn('[screen:save-as-watchlist] skipped tickers:', added.skipped);
      }
      return watchlistService.get(wl.id);
    })
  );

  // ── Quote refresh (FR-1.7) ─────────────────────────────────────────────
  ipcMain.handle(
    'quotes:refresh',
    async (_e, ticker: string): Promise<IpcResult<CachedQuote>> => {
      try {
        const snapshot = await dataProvider.getQuote(ticker);
        const cached: CachedQuote = {
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
          fetchedAt: snapshot.fetchedAt
        };
        quoteCache.upsert(cached);
        return ok(cached);
      } catch (err) {
        return fail(err);
      }
    }
  );
  ipcMain.handle(
    'quotes:refresh-bulk',
    async (_e, tickers: string[]): Promise<IpcResult<QuoteWithWheel[]>> => {
      const results: QuoteWithWheel[] = [];
      for (const ticker of tickers) {
        try {
          // Fetch both quote and fundamentals for wheel calculations
          const snapshot = await dataProvider.getQuote(ticker);
          let ratios = fundamentalsCache.get(ticker)?.ratios;
          if (!ratios) {
            ratios = await dataProvider.getFundamentals(ticker);
            fundamentalsCache.upsert(ticker, ratios);
          }

          // Calculate wheel metrics
          const wheelMetrics = calculateWheelMetrics(ratios, snapshot);

          const cached: QuoteWithWheel = {
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
            fetchedAt: snapshot.fetchedAt,
            wheelSuitability: wheelMetrics.suitabilityScore,
            targetStrike: wheelMetrics.targetStrike,
            estimatedPremium: wheelMetrics.estimatedPremium
          };
          quoteCache.upsert(cached);
          results.push(cached);
        } catch {
          // Skip individual failures.
        }
      }
      return ok(results);
    }
  );
  ipcMain.handle(
    'quotes:get-cached',
    wrap((ticker: string) => quoteCache.get(ticker))
  );
}
