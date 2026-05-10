// IPC handlers for Morning Briefing Dashboard
// Exposes market regime, action items, and top setups
// see SPEC: Priority 7 - Morning Briefing Dashboard

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { BriefingService } from '../services/briefing-service.js';
import { HistoricalDataService } from '../services/historical-service.js';
import { PolygonDataProvider } from '../services/polygon-provider.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'BRIEFING_ERROR', message } };
}

// Async wrap for async functions
function wrapAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  return async (_e: IpcMainInvokeEvent, ...args: Args): Promise<IpcResult<R>> => {
    try {
      const result = await fn(...args);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerBriefingIpc(
  db: Database,
  getApiKey: () => string,
  rateLimiter: TokenBucketRateLimiter
): void {
  const historicalService = new HistoricalDataService(db);
  const dataProvider = new PolygonDataProvider(getApiKey);
  const service = new BriefingService(db, historicalService, dataProvider, rateLimiter);

  // ─── Market Regime ──────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getMarketRegime', wrapAsync(async () => {
    const regime = await service.getMarketRegime();
    return { success: true, data: regime };
  }));

  // ─── Action Items ───────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getActionItems', wrapAsync(async () => {
    const items = await service.getActionItems();
    return { success: true, data: items };
  }));

  // ─── Top Setups ─────────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getTopSetups', wrapAsync(async () => {
    const setups = await service.getTopSetups();
    return { success: true, data: setups };
  }));

  // ─── Full Briefing ────────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getFull', wrapAsync(async () => {
    const briefing = await service.getFullBriefing();
    return { success: true, data: briefing };
  }));
}
