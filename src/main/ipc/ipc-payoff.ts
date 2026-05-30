// IPC handlers for Payoff Visualizer saved strategies.

import { ipcMain } from 'electron';
import type { Database } from 'better-sqlite3';
import { PayoffService } from '../services/payoff-service.js';
import type { IpcResult, PayoffLeg, SavedPayoffStrategy } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(err: unknown): IpcResult<never> {
  return { ok: false, error: { code: 'PAYOFF_ERROR', message: err instanceof Error ? err.message : String(err) } };
}

export function registerPayoffIpc(db: Database): void {
  const svc = new PayoffService();

  ipcMain.handle('payoff:save', (_e, name: string, ticker: string | null, legs: PayoffLeg[]): IpcResult<SavedPayoffStrategy> => {
    try { return ok(svc.save(db, name, ticker, legs)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('payoff:list', (_e): IpcResult<SavedPayoffStrategy[]> => {
    try { return ok(svc.list(db)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('payoff:delete', (_e, id: number): IpcResult<boolean> => {
    try { svc.delete(db, id); return ok(true); }
    catch (err) { return fail(err); }
  });
}
