// IPC handlers for the LEAPS + CSP Strategy Screener
// Exposes run-screen, get-runs, get-run, mark-opened, get-opened

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { DbHandle } from '../db/connection.js';
import { LeapsCspService } from '../services/leaps-csp-service.js';
import type { DataProvider } from '../services/data-provider.js';
import type { OptionsProvider } from '../services/options-provider.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { IpcResult, LeapsCspProgressDetail } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'LEAPS_CSP_ERROR', message } };
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

export function registerLeapsCspIpc(
  db: DbHandle,
  dataProvider: DataProvider,
  optionsProvider: OptionsProvider,
  rateLimiter: TokenBucketRateLimiter,
): void {
  const service = new LeapsCspService(db, dataProvider, optionsProvider, rateLimiter);

  // Run a full LEAPS+CSP screen. Streams progress via 'leaps-csp:progress' events.
  ipcMain.handle(
    'leaps-csp:run-screen',
    wrapAsync(async (universe: 'sp500' | 'russell1000' | 'both' | 'etf', forceRun?: boolean, watchlistId?: number | null) => {
      const win = (await import('electron')).BrowserWindow.getAllWindows()[0];
      return service.runScreen(universe, msg => {
        win?.webContents.send('leaps-csp:progress', msg);
      }, forceRun ?? false, (detail: LeapsCspProgressDetail) => {
        win?.webContents.send('leaps-csp:progress-detail', detail);
      }, watchlistId ?? undefined);
    }),
  );

  // List the 20 most recent runs (summary only, no opportunities)
  ipcMain.handle('leaps-csp:get-runs', wrap(() => service.getRecentRuns()));

  // Full run result including all opportunities
  ipcMain.handle('leaps-csp:get-run', wrap((runId: number) => service.getRun(runId)));

  // Mark an opportunity as opened
  ipcMain.handle(
    'leaps-csp:mark-opened',
    wrap((opportunityId: number, entry: { leapsEntryDebit?: number; notes?: string }) => {
      service.markOpened(opportunityId, entry);
      return true;
    }),
  );

  // Get all opened positions
  ipcMain.handle('leaps-csp:get-opened', wrap(() => service.getOpenedPositions()));

  // Delete a run (cascades to opportunities via FK)
  ipcMain.handle('leaps-csp:delete-run', wrap((runId: number) => {
    service.deleteRun(runId);
    return true;
  }));
}
