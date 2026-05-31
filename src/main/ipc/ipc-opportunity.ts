// IPC handlers for ENH-2 Opportunity Dashboard.
// Exposes the composite opportunity scoring engine.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { OpportunityService } from '../services/opportunity-service.js';
import type { IpcResult, OpportunityRunOptions } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'OPPORTUNITY_ERROR', message } };
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

export function registerOpportunityIpc(service: OpportunityService): void {
  // Run opportunity scoring — returns ranked rows
  ipcMain.handle(
    'opportunity:run',
    wrap((opts: OpportunityRunOptions) => service.run(opts)),
  );
}
