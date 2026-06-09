// IPC handlers for Paper Trading / Retrospect screen.
// see Requirements/paper-trading.md

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { PaperTradingService } from '../services/paper-trading-service.js';
import type { IpcResult, RetroSettings } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'PAPER_TRADING_ERROR', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try { return ok(fn(...args)); }
    catch (err) { return fail(err); }
  };
}

export function registerPaperTradingIpc(svc: PaperTradingService): void {
  ipcMain.handle('paper:list-open',          wrap(() => svc.getOpenPositions()));
  ipcMain.handle('paper:list-closed',        wrap((limit?: number) => svc.getClosedPositions(limit)));
  ipcMain.handle('paper:close',              wrap((id: number, notes?: string) => { svc.closePosition(id, notes); return true; }));
  ipcMain.handle('paper:delete',             wrap((id: number) => { svc.deleteTrade(id); return true; }));
  ipcMain.handle('paper:summary',            wrap(() => svc.getSummary()));
  ipcMain.handle('paper:strategy-breakdown', wrap(() => svc.getStrategyBreakdown()));
  ipcMain.handle('paper:expire-stale',       wrap(() => svc.expireStalePositions()));
  ipcMain.handle('paper:get-settings',       wrap(() => svc.getSettings()));
  ipcMain.handle('paper:save-settings',      wrap((settings: RetroSettings) => { svc.saveSettings(settings); return true; }));
  ipcMain.handle('paper:brief-accuracy',     wrap((briefDates: string[]) => svc.getBriefAccuracyBatch(briefDates)));
  ipcMain.handle('paper:snapshot-accuracy',              wrap(() => svc.getSnapshotAccuracy()));
  ipcMain.handle('paper:brief-performance-summary',      wrap(() => svc.getBriefPerformanceSummary()));
  ipcMain.handle('paper:get-learning-recommendations',   wrap(() => svc.getLearningRecommendations()));
  ipcMain.handle('paper:acknowledge-recommendation',     wrap((id: number) => { svc.acknowledgeLearningRecommendation(id); return true; }));
}
