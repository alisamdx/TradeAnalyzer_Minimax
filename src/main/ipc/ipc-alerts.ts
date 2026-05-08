// IPC handlers for Alerts System
// Exposes alert CRUD and checking functionality
// see SPEC: Priority 8 - Alerts System

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { AlertsService, type AlertInput } from '../services/alerts-service.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'ALERTS_ERROR', message } };
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

export function registerAlertsIpc(db: Database): void {
  const service = new AlertsService(db);

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  ipcMain.handle('alerts:create', wrap((input: AlertInput) => {
    const alert = service.createAlert(input);
    return { success: true, data: alert };
  }));

  ipcMain.handle('alerts:list', wrap((activeOnly: boolean = false) => {
    const alerts = activeOnly ? service.listActive() : [...service.listActive(), ...service.listTriggered()];
    return { success: true, data: alerts };
  }));

  ipcMain.handle('alerts:get', wrap((id: number) => {
    const alert = service.getById(id);
    return { success: true, data: alert };
  }));

  ipcMain.handle('alerts:update', wrap((id: number, input: Partial<AlertInput>) => {
    const alert = service.updateAlert(id, input);
    return { success: true, data: alert };
  }));

  ipcMain.handle('alerts:delete', wrap((id: number) => {
    service.deleteAlert(id);
    return { success: true };
  }));

  // ─── Trigger Management ─────────────────────────────────────────────────────

  ipcMain.handle('alerts:markTriggered', wrap((id: number) => {
    service.markTriggered(id);
    return { success: true };
  }));

  ipcMain.handle('alerts:resetTriggered', wrap((id: number) => {
    service.resetTriggered(id);
    return { success: true };
  }));

  // ─── Alert Checking ─────────────────────────────────────────────────────────

  ipcMain.handle('alerts:checkPrice', wrap((alertId: number, currentPrice: number) => {
    const alert = service.getById(alertId);
    if (!alert) {
      return { success: false, error: 'Alert not found' };
    }
    const result = service.checkPriceAlert(alert, currentPrice);
    if (result.triggered) {
      service.markTriggered(alertId);
    }
    return { success: true, data: result };
  }));
}
