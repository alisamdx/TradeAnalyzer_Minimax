// IPC handlers for Filter Templates — pre-built criteria scanning watchlist/universe tickers.

import { ipcMain, type IpcMainInvokeEvent, BrowserWindow } from 'electron';
import type { IpcResult, Universe } from '@shared/types.js';
import { FilterTemplatesService, type FilterProgress } from '../services/filter-templates-service.js';
import type { DataProvider } from '../services/data-provider.js';
import type { OptionsProvider } from '../services/options-provider.js';
import type { QuoteCache, FundamentalsCache } from '../services/cache-service.js';
import type { ConstituentsService } from '../services/constituents-service.js';
import type { DbHandle } from '../db/connection.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'FILTERS_ERROR', message } };
}

export function registerFiltersIpc(
  db: DbHandle,
  dataProvider: DataProvider,
  optionsProvider: OptionsProvider | null,
  quoteCache: QuoteCache,
  fundamentalsCache: FundamentalsCache,
  constituentsService: ConstituentsService
): void {
  const service = new FilterTemplatesService(db, dataProvider, optionsProvider, quoteCache, fundamentalsCache, constituentsService);

  ipcMain.handle('filters:list-templates', () => {
    return ok(service.listTemplates());
  });

  ipcMain.handle('filters:run-template', async (
    _e: IpcMainInvokeEvent,
    templateId: string,
    source?: 'watchlist' | 'universe',
    universe?: Universe,
    watchlistIds?: number[]
  ) => {
    try {
      const win = BrowserWindow.getAllWindows()[0];
      const results = await service.runTemplate(templateId, source, universe, watchlistIds, (progress: FilterProgress) => {
        win?.webContents.send('filters:progress', progress);
      });
      return ok(results);
    } catch (err) {
      return fail(err);
    }
  });
}