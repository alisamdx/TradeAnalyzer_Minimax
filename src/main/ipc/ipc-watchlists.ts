import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { WatchlistService, WatchlistError } from '../services/watchlist-service.js';
import { parseCsv, buildCsv } from '../services/csv.js';
import type { CsvImportResult, CsvExportResult, IpcResult } from '@shared/types.js';
import type { DataProvider } from '../services/data-provider.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  if (err instanceof WatchlistError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'UNKNOWN', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try {
      return ok(fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerWatchlistIpc(service: WatchlistService, dataProvider: DataProvider): void {
  ipcMain.handle('watchlists:list', wrap(() => service.list()));
  ipcMain.handle(
    'watchlists:get',
    wrap((id: number) => service.get(id))
  );
  ipcMain.handle(
    'watchlists:create',
    wrap((name: string) => service.create(name))
  );
  ipcMain.handle(
    'watchlists:rename',
    wrap((id: number, newName: string) => service.rename(id, newName))
  );
  ipcMain.handle(
    'watchlists:delete',
    wrap((id: number) => {
      service.delete(id);
      return true as const;
    })
  );
  ipcMain.handle(
    'watchlists:items:list',
    wrap((id: number) => service.listItems(id))
  );
  ipcMain.handle(
    'watchlists:items:add',
    async (_e: IpcMainInvokeEvent, id: number, ticker: string, notes: string | null): Promise<IpcResult<import('@shared/types.js').WatchlistItem>> => {
      try {
        // Normalize ticker to uppercase before validation
        const normalizedTicker = ticker.trim().toUpperCase();
        // Validate that the ticker exists via the data provider
        try {
          const quote = await dataProvider.getQuote(normalizedTicker);
          // If we got a valid response with data, ticker exists
          if (quote.last === null && quote.prevClose === null) {
            throw new WatchlistError('INVALID_TICKER', `Ticker "${normalizedTicker}" not found or has no trading data`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('404') || msg.includes('NotFound') || msg.includes('not found')) {
            throw new WatchlistError('INVALID_TICKER', `Ticker "${normalizedTicker}" not found. Please verify the symbol is correct.`);
          }
          throw err;
        }
        const item = service.addItem(id, normalizedTicker, notes);
        return ok(item);
      } catch (err) {
        return fail(err);
      }
    }
  );
  ipcMain.handle(
    'watchlists:items:add-bulk',
    wrap((id: number, items: Array<{ ticker: string; notes?: string | null }>) =>
      service.addItemsBulk(id, items)
    )
  );
  ipcMain.handle(
    'watchlists:items:remove',
    wrap((id: number, itemIds: number[]) => service.removeItems(id, itemIds))
  );

  ipcMain.handle('watchlists:csv:export', async (_e, watchlistId: number) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const wl = service.get(watchlistId);
      const items = service.listItems(watchlistId);
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export watchlist',
        defaultPath: `${wl.name.replace(/[^A-Za-z0-9_-]+/g, '_')}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      });
      if (result.canceled || !result.filePath) return ok<CsvExportResult | null>(null);
      const csv = buildCsv(
        items.map((i) => ({
          ticker: i.ticker,
          addedDate: i.addedAt,
          notes: i.notes
        }))
      );
      writeFileSync(result.filePath, csv, 'utf8');
      return ok<CsvExportResult>({ filePath: result.filePath, rowCount: items.length });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle(
    'watchlists:csv:import',
    async (
      _e,
      args: { watchlistId?: number; createWithName?: string }
    ): Promise<IpcResult<CsvImportResult>> => {
      try {
        const win = BrowserWindow.getFocusedWindow();
        const result = await dialog.showOpenDialog(win!, {
          title: 'Import watchlist CSV',
          properties: ['openFile'],
          filters: [{ name: 'CSV', extensions: ['csv'] }]
        });
        if (result.canceled || !result.filePaths[0]) {
          return fail(new Error('Import cancelled'));
        }
        const text = readFileSync(result.filePaths[0], 'utf8');
        const parsed = parseCsv(text);

        let watchlistId: number;
        if (args.watchlistId !== undefined) {
          watchlistId = args.watchlistId;
        } else if (args.createWithName) {
          watchlistId = service.create(args.createWithName).id;
        } else {
          return fail(new Error('Either watchlistId or createWithName is required'));
        }

        const bulk = service.addItemsBulk(
          watchlistId,
          parsed.rows.map((r) => ({ ticker: r.ticker, notes: r.notes, addedAt: r.addedDate }))
        );

        const skipped = [
          ...parsed.errors.map((e) => ({ row: e.row, ticker: e.ticker, reason: e.reason })),
          ...bulk.skipped.map((s) => ({ row: -1, ticker: s.ticker, reason: s.reason }))
        ];

        return ok<CsvImportResult>({
          watchlistId,
          imported: bulk.added.length,
          skipped
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // Show a prompt dialog from the renderer via main process.
  ipcMain.handle('dialog:prompt', async (_e, opts: { title: string; defaultValue?: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return ok(null);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: opts.title,
      message: opts.title,
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 1) return ok(null);
    return ok(opts.defaultValue ?? '');
  });

  // Show a confirm dialog from the renderer via main process.
  ipcMain.handle('dialog:confirm', async (_e, opts: { title: string; message: string }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return ok(false);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: opts.title,
      message: opts.message,
      buttons: ['Yes', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    });
    return ok(response === 0);
  });
}
