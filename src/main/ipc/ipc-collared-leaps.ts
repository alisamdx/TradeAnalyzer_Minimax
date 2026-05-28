// IPC handlers for the Collared LEAPS Strategy Screener
// Position = long deep-ITM LEAPS call + long OTM protective put on same underlying.
// Exposes run-screen, get-runs, get-run, mark-opened, get-opened, delete-run.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { DbHandle } from '../db/connection.js';
import { CollaredLeapsService } from '../services/collared-leaps-service.js';
import type { DataProvider } from '../services/data-provider.js';
import type { OptionsProvider } from '../services/options-provider.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { IpcResult, CollaredLeapsProgressDetail } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'COLLARED_LEAPS_ERROR', message } };
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

export function registerCollaredLeapsIpc(
  db: DbHandle,
  dataProvider: DataProvider,
  optionsProvider: OptionsProvider,
  rateLimiter: TokenBucketRateLimiter,
): void {
  const service = new CollaredLeapsService(db, dataProvider, optionsProvider, rateLimiter);

  // Run a full Collared LEAPS screen. Streams progress via 'collared-leaps:progress' events.
  ipcMain.handle(
    'collared-leaps:run-screen',
    wrapAsync(async (universe: 'sp500' | 'russell1000' | 'both', forceRun?: boolean, watchlistId?: number | null) => {
      const win = (await import('electron')).BrowserWindow.getAllWindows()[0];
      return service.runScreen(
        universe,
        msg => { win?.webContents.send('collared-leaps:progress', msg); },
        forceRun ?? false,
        (detail: CollaredLeapsProgressDetail) => {
          win?.webContents.send('collared-leaps:progress-detail', detail);
        },
        watchlistId ?? undefined,
      );
    }),
  );

  // List the 20 most recent runs (summary only, no opportunities)
  ipcMain.handle('collared-leaps:get-runs', wrap(() => service.getRecentRuns()));

  // Full run result including all opportunities
  ipcMain.handle('collared-leaps:get-run', wrap((runId: number) => service.getRun(runId)));

  // Mark an opportunity as opened (for exit-rule monitoring)
  ipcMain.handle(
    'collared-leaps:mark-opened',
    wrap((opportunityId: number, entry: { leapsEntryDebit?: number; putEntryDebit?: number; notes?: string }) => {
      service.markOpened(opportunityId, entry);
      return true;
    }),
  );

  // Get all opened positions
  ipcMain.handle('collared-leaps:get-opened', wrap(() => service.getOpenedPositions()));

  // Delete a run (cascades to opportunities via FK)
  ipcMain.handle('collared-leaps:delete-run', wrap((runId: number) => {
    service.deleteRun(runId);
    return true;
  }));
}
