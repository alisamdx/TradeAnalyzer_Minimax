// IPC handlers for the Conviction List feature.
// v0.24.0

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ConvictionService } from '../services/conviction-service.js';
import type { EmailService } from '../services/email-service.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'CONVICTION_ERROR', message } };
}
function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try { return ok(fn(...args)); } catch (err) { return fail(err); }
  };
}

export function registerConvictionIpc(service: ConvictionService, emailService: EmailService): void {
  ipcMain.handle('conviction:list',    wrap(() => service.list()));
  ipcMain.handle('conviction:add',     wrap((input) => service.add(input)));
  ipcMain.handle('conviction:update',  wrap((ticker, input) => service.update(ticker, input)));
  ipcMain.handle('conviction:remove',  wrap((ticker: string) => service.remove(ticker)));
  ipcMain.handle('conviction:set-in-play', wrap((ticker: string, inPlay: boolean) => service.setInPlay(ticker, inPlay)));
  ipcMain.handle('conviction:history', wrap((ticker: string) => service.getHistory(ticker)));
  ipcMain.handle('conviction:recommend', wrap((ticker: string) => service.recommend(ticker)));
  ipcMain.handle('conviction:sync-default-watchlist', wrap(() => service.syncFromDefaultWatchlist()));
  ipcMain.handle('conviction:email-configured', wrap(() => emailService.isConfigured()));

  ipcMain.handle('conviction:send-email', async (_e) => {
    try {
      const { subject, html } = service.buildEmailReport();
      await emailService.send(subject, html);
      return ok(true);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('conviction:ai-review', async (_e) => {
    try {
      return ok(await service.aiReview());
    } catch (err) {
      return fail(err);
    }
  });
}
