import { ipcMain, BrowserWindow } from 'electron';
import type { BriefReplayService } from '../services/brief-replay-service.js';
import type { IpcResult, ReplayProgressEvent } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(message: string): IpcResult<never> { return { ok: false, error: { code: 'ERR', message } }; }

let runAbort: AbortController | null = null;

export function registerBriefReplayIpc(service: BriefReplayService): void {
  // Trigger a replay run; returns immediately with {started:true}. Progress events
  // are pushed to the renderer via 'replay:progress' until done or cancelled.
  ipcMain.handle('replay:run-range', async (_evt, from: string, to: string): Promise<IpcResult<{ started: boolean }>> => {
    try {
      // Cancel any in-flight run
      if (runAbort) runAbort.abort();
      runAbort = new AbortController();
      const signal = runAbort.signal;

      const win = BrowserWindow.getAllWindows()[0];

      const push = (evt: ReplayProgressEvent) => {
        if (!win?.isDestroyed()) {
          win?.webContents.send('replay:progress', evt);
        }
      };

      // Run async — don't await so IPC returns immediately
      service.runRange(from, to, push, signal).catch(err => {
        push({
          phase: 'error',
          current: 0,
          total: 0,
          currentDate: '',
          message: err instanceof Error ? err.message : String(err),
        });
      });

      return ok({ started: true });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle('replay:cancel', (): IpcResult<{ cancelled: boolean }> => {
    if (runAbort) {
      runAbort.abort();
      runAbort = null;
    }
    return ok({ cancelled: true });
  });

  ipcMain.handle('replay:clear', (): IpcResult<{ cleared: boolean }> => {
    try {
      service.clearAll();
      return ok({ cleared: true });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle('replay:get-summaries', (): IpcResult<ReturnType<BriefReplayService['getSummaries']>> => {
    try {
      return ok(service.getSummaries());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle('replay:get-picks', (_evt, strategy?: string, limit?: number): IpcResult<ReturnType<BriefReplayService['getPickRows']>> => {
    try {
      return ok(service.getPickRows(strategy, limit));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle('replay:get-date-range', (): IpcResult<ReturnType<BriefReplayService['getDateRange']>> => {
    try {
      return ok(service.getDateRange());
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}
