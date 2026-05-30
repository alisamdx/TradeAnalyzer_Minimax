// IPC handlers for the IV History feature (v0.17.0).
// Exposes coverage, gap detection, backfill orchestration, IV rank queries,
// and MarketData.app token management.
// Progress events stream via 'iv-history:progress'.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { DbHandle } from '../db/connection.js';
import type { IvHistoryService } from '../services/iv-history-service.js';
import type { MarketDataProvider } from '../services/marketdata-provider.js';
import { secureGet, secureSet } from '../services/secure-settings.js';
import type { IpcResult, IvHistoryBackfillPhase } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'IV_HISTORY_ERROR', message } };
}

function wrapAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  return async (_e: IpcMainInvokeEvent, ...args: Args): Promise<IpcResult<R>> => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
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

export function registerIvHistoryIpc(
  db: DbHandle,
  service: IvHistoryService,
  marketdata: MarketDataProvider,
): void {

  // Coverage summary for a universe
  ipcMain.handle(
    'iv-history:get-coverage',
    wrap((universe: 'sp500' | 'russell1000' | 'both') =>
      service.getCoverage(universe)
    ),
  );

  // Gap detection — returns summary + pair count (pairs not sent over IPC to keep payload small)
  ipcMain.handle(
    'iv-history:get-gaps',
    wrap((universe: 'sp500' | 'russell1000' | 'both') => {
      const { summary } = service.getGaps(universe);
      return summary;
    }),
  );

  // Start a backfill — streams progress events, returns final stats
  ipcMain.handle(
    'iv-history:start-backfill',
    wrapAsync(async (phase: IvHistoryBackfillPhase) => {
      const { BrowserWindow } = await import('electron');
      const win = BrowserWindow.getAllWindows()[0];
      return service.runBackfill(phase, evt => {
        win?.webContents.send('iv-history:progress', evt);
      });
    }),
  );

  // Cancel the running backfill
  ipcMain.handle('iv-history:cancel', wrap(() => {
    service.cancel();
    return true;
  }));

  // IV rank/percentile for a single ticker
  ipcMain.handle(
    'iv-history:get-rank',
    wrap((ticker: string) => service.getIvRank(ticker)),
  );

  // IV rank for multiple tickers (batch)
  ipcMain.handle(
    'iv-history:get-ranks',
    wrap((tickers: string[]) => tickers.map(t => service.getIvRank(t))),
  );

  // Status of the two initial load phases (for the management screen badges)
  ipcMain.handle(
    'iv-history:get-initial-load-status',
    wrap(() => service.getInitialLoadStatus()),
  );

  // MarketData.app token management
  ipcMain.handle('iv-history:save-token', wrap((token: string) => {
    secureSet(db, 'marketdataApiToken', token.trim());
    return true;
  }));

  ipcMain.handle('iv-history:get-token-configured', wrap(() => {
    const token = secureGet(db, 'marketdataApiToken');
    return Boolean(token);
  }));

  // Update MarketData.app rate limit (requests per minute)
  ipcMain.handle('iv-history:set-rate', wrap((rpm: number) => {
    marketdata.updateRate(rpm);
    return true;
  }));
}
