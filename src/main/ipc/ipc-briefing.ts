// IPC handlers for Morning Briefing Dashboard
// Exposes market regime, action items, and top setups
// see SPEC: Priority 7 - Morning Briefing Dashboard

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { BriefingService } from '../services/briefing-service.js';
import { HistoricalDataService } from '../services/historical-service.js';
import { PolygonDataProvider } from '../services/polygon-provider.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'BRIEFING_ERROR', message } };
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

export function registerBriefingIpc(
  db: Database,
  getApiKey: () => string
): void {
  const historicalService = new HistoricalDataService(db);
  const dataProvider = new PolygonDataProvider(getApiKey);
  const service = new BriefingService(db, historicalService, dataProvider);

  // ─── Market Regime ──────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getMarketRegime', wrap(async () => {
    const regime = await service.getMarketRegime();
    return { success: true, data: regime };
  }));

  // ─── Action Items ───────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getActionItems', wrap(async () => {
    const items = await service.getActionItems();
    return { success: true, data: items };
  }));

  // ─── Top Setups ─────────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getTopSetups', wrap(async () => {
    const setups = await service.getTopSetups();
    return { success: true, data: setups };
  }));

  // ─── Full Briefing ────────────────────────────────────────────────────────────

  ipcMain.handle('briefing:getFull', wrap(async () => {
    const briefing = await service.getFullBriefing();
    return { success: true, data: briefing };
  }));
}
