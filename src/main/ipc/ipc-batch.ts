// IPC handlers for the Batch job system.
// Exposes job listing, run history, manual triggers, cancellation, and config updates.
// Progress events stream via 'batch:progress'. Notifications via 'app:notification'.
// v0.21.0

import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { BatchService } from '../services/batch-service.js';
import type { IpcResult, BatchJob } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'BATCH_ERROR', message } };
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

function wrapAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  return async (_e: IpcMainInvokeEvent, ...args: Args): Promise<IpcResult<R>> => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerBatchIpc(
  batchService: BatchService,
  getWindow: () => BrowserWindow | null
): void {
  // List all registered batch jobs
  ipcMain.handle(
    'batch:list-jobs',
    wrap(() => batchService.getJobs())
  );

  // List run history for a job (last 30 days)
  ipcMain.handle(
    'batch:list-runs',
    wrap((jobId: string) => batchService.getRuns(jobId))
  );

  // Trigger a job manually (fire-and-forget; returns immediately)
  ipcMain.handle(
    'batch:run-now',
    wrapAsync(async (jobId: string) => {
      batchService.runJob(jobId, 'manual').catch(err =>
        console.error(`[batch] manual run error for "${jobId}":`, err)
      );
      return true;
    })
  );

  // Cancel a running job
  ipcMain.handle(
    'batch:cancel',
    wrap((jobId: string) => {
      batchService.cancelJob(jobId);
      return true;
    })
  );

  // Update job configuration (schedule, enabled, etc.)
  ipcMain.handle(
    'batch:update-job',
    wrap((jobId: string, patch: Partial<BatchJob>) => {
      batchService.updateJobConfig(jobId, patch);
      return true;
    })
  );

  // Global session toggle (in-memory, resets to true on every app start)
  ipcMain.handle(
    'batch:set-enabled',
    wrap((enabled: boolean) => {
      batchService.setEnabled(enabled);
      return true;
    })
  );

  ipcMain.handle(
    'batch:get-enabled',
    wrap(() => batchService.isEnabled())
  );

  // Wire batch:progress and app:notification callbacks → renderer IPC events
  // (These are set up in index.ts via the callback injection, not here.
  //  This function only registers the invoke handlers above.)
  void getWindow; // used by index.ts wiring — kept for discoverability
}
