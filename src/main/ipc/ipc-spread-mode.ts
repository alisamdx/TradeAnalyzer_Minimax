// IPC for the bull put spread mode: its settings (Settings → Strategies, v1.1.296) and the shadow
// report behind the Spread Shadow view (v1.1.295).
// Read-only: the same report `GET /api/v1/diagnostics/spread-shadow` serves to
// scripts/spread-shadow-report.mjs. see services/spread-mode-settle.ts

import { ipcMain } from 'electron';
import type { DbHandle } from '../db/connection.js';
import type { IpcResult } from '@shared/types.js';
import type { SpreadModeSettings, SpreadShadowReport } from '@shared/spread-mode.js';
import { buildSpreadShadowReport } from '../services/spread-mode-settle.js';
import { readSpreadModeSettings, writeSpreadModeSettings } from '../services/spread-mode.js';

const fail = (code: string, err: unknown) =>
  ({ ok: false as const, error: { code, message: err instanceof Error ? err.message : String(err) } });

export function registerSpreadModeIpc(db: DbHandle): void {
  ipcMain.handle('spread-mode:get-settings', (): IpcResult<SpreadModeSettings> => {
    try { return { ok: true, value: readSpreadModeSettings(db) }; } catch (err) { return fail('SPREAD_MODE_ERROR', err); }
  });

  // Returns what was STORED, not what was asked for: the service clamps, so the screen must
  // render the stored values rather than assume its input was kept.
  ipcMain.handle('spread-mode:set-settings', (_e, next: SpreadModeSettings): IpcResult<SpreadModeSettings> => {
    try { return { ok: true, value: writeSpreadModeSettings(db, next) }; } catch (err) { return fail('SPREAD_MODE_ERROR', err); }
  });

  ipcMain.handle('spread-mode:shadow-report', (): IpcResult<SpreadShadowReport> => {
    try {
      const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      return { ok: true, value: buildSpreadShadowReport(db, todayEt) };
    } catch (err) {
      return fail('SPREAD_MODE_ERROR', err);
    }
  });
}
