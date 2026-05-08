// IPC handlers for Alerts System
// Exposes alert CRUD and checking functionality
// see SPEC: Priority 8 - Alerts System

import { ipcMain } from 'electron';
import type { Database } from 'better-sqlite3';
import { AlertsService, type AlertInput } from '../services/alerts-service.js';

export function registerAlertsIpc(db: Database): void {
  const service = new AlertsService(db);

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  ipcMain.handle('alerts:create', (_event, input: AlertInput) => {
    try {
      const alert = service.createAlert(input);
      return { success: true, data: alert };
    } catch (err) {
      console.error('[alerts:create] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('alerts:list', (_event, activeOnly: boolean = false) => {
    try {
      const alerts = activeOnly ? service.listActive() : [...service.listActive(), ...service.listTriggered()];
      return { success: true, data: alerts };
    } catch (err) {
      console.error('[alerts:list] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('alerts:get', (_event, id: number) => {
    try {
      const alert = service.getById(id);
      return { success: true, data: alert };
    } catch (err) {
      console.error('[alerts:get] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('alerts:update', (_event, id: number, input: Partial<AlertInput>) => {
    try {
      const alert = service.updateAlert(id, input);
      return { success: true, data: alert };
    } catch (err) {
      console.error('[alerts:update] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('alerts:delete', (_event, id: number) => {
    try {
      service.deleteAlert(id);
      return { success: true };
    } catch (err) {
      console.error('[alerts:delete] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── Trigger Management ─────────────────────────────────────────────────────

  ipcMain.handle('alerts:markTriggered', (_event, id: number) => {
    try {
      service.markTriggered(id);
      return { success: true };
    } catch (err) {
      console.error('[alerts:markTriggered] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('alerts:resetTriggered', (_event, id: number) => {
    try {
      service.resetTriggered(id);
      return { success: true };
    } catch (err) {
      console.error('[alerts:resetTriggered] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── Alert Checking ─────────────────────────────────────────────────────────

  ipcMain.handle('alerts:checkPrice', (_event, alertId: number, currentPrice: number) => {
    try {
      const alert = service.getById(alertId);
      if (!alert) {
        return { success: false, error: 'Alert not found' };
      }
      const result = service.checkPriceAlert(alert, currentPrice);
      if (result.triggered) {
        service.markTriggered(alertId);
      }
      return { success: true, data: result };
    } catch (err) {
      console.error('[alerts:checkPrice] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });
}
