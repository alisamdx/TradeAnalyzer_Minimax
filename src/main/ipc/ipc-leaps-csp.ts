// IPC handlers for the LEAPS + CSP Strategy Screener
// Exposes run-screen, get-runs, get-run, mark-opened, get-opened

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { DbHandle } from '../db/connection.js';
import { LeapsCspService } from '../services/leaps-csp-service.js';
import { PolygonDataProvider } from '../services/polygon-provider.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { IpcResult } from '@shared/types.js';

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
  getApiKey: () => string,
  rateLimiter: TokenBucketRateLimiter,
): void {
  const provider = new PolygonDataProvider(getApiKey);
  const service = new LeapsCspService(db, provider, rateLimiter);

  // Run a full LEAPS+CSP screen. Streams progress via 'leaps-csp:progress' events.
  ipcMain.handle(
    'leaps-csp:run-screen',
    wrapAsync(async (universe: 'sp500' | 'russell1000' | 'both', forceRun?: boolean) => {
      const win = (await import('electron')).BrowserWindow.getAllWindows()[0];
      return service.runScreen(universe, msg => {
        win?.webContents.send('leaps-csp:progress', msg);
      }, forceRun ?? false);
    }),
  );

  // List the 20 most recent runs (summary only, no opportunities)
  ipcMain.handle('leaps-csp:get-runs', wrap(() => service.getRecentRuns()));

  // Full run result including all opportunities
  ipcMain.handle('leaps-csp:get-run', wrap((runId: number) => service.getRun(runId)));

  // Mark an opportunity as opened (for exit-rule monitoring in Phase 2)
  ipcMain.handle(
    'leaps-csp:mark-opened',
    wrap((opportunityId: number, entry: { leapsEntryDebit?: number; cspEntryCredit?: number; notes?: string }) => {
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
