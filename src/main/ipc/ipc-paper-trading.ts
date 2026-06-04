// IPC handlers for Paper Trading / Retrospect screen.
// see Requirements/paper-trading.md

import { ipcMain } from 'electron';
import type { PaperTradingService } from '../services/paper-trading-service.js';
import type { RetroSettings } from '@shared/types.js';

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

function wrap<T>(fn: () => T): IpcResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerPaperTradingIpc(svc: PaperTradingService): void {
  ipcMain.handle('paper:list-open', () =>
    wrap(() => svc.getOpenPositions())
  );

  ipcMain.handle('paper:list-closed', (_e, limit?: number) =>
    wrap(() => svc.getClosedPositions(limit))
  );

  ipcMain.handle('paper:close', (_e, id: number, notes?: string) =>
    wrap(() => { svc.closePosition(id, notes); return true; })
  );

  ipcMain.handle('paper:delete', (_e, id: number) =>
    wrap(() => { svc.deleteTrade(id); return true; })
  );

  ipcMain.handle('paper:summary', () =>
    wrap(() => svc.getSummary())
  );

  ipcMain.handle('paper:strategy-breakdown', () =>
    wrap(() => svc.getStrategyBreakdown())
  );

  ipcMain.handle('paper:expire-stale', () =>
    wrap(() => svc.expireStalePositions())
  );

  ipcMain.handle('paper:get-settings', () =>
    wrap(() => svc.getSettings())
  );

  ipcMain.handle('paper:save-settings', (_e, settings: RetroSettings) =>
    wrap(() => { svc.saveSettings(settings); return true; })
  );

  ipcMain.handle('paper:brief-accuracy', (_e, briefDates: string[]) =>
    wrap(() => svc.getBriefAccuracyBatch(briefDates))
  );
}
