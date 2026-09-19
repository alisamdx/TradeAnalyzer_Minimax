// IPC for the bull put spread mode's shadow report — the Spread Shadow view (v1.1.295).
// Read-only: the same report `GET /api/v1/diagnostics/spread-shadow` serves to
// scripts/spread-shadow-report.mjs. see services/spread-mode-settle.ts

import { ipcMain } from 'electron';
import type { DbHandle } from '../db/connection.js';
import type { IpcResult } from '@shared/types.js';
import type { SpreadShadowReport } from '@shared/spread-mode.js';
import { buildSpreadShadowReport } from '../services/spread-mode-settle.js';

export function registerSpreadModeIpc(db: DbHandle): void {
  ipcMain.handle('spread-mode:shadow-report', (): IpcResult<SpreadShadowReport> => {
    try {
      const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return { ok: true, value: buildSpreadShadowReport(db, todayEt) };
    } catch (err) {
      return { ok: false, error: { code: 'SPREAD_MODE_ERROR', message: err instanceof Error ? err.message : String(err) } };
    }
  });
}
