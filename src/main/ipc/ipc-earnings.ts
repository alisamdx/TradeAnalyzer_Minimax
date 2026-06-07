// IPC handlers for earnings calendar feature.
// v0.31.0

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { EarningsService } from '../services/earnings-service.js';
import type { OAuthCredentials } from '../services/etrade-auth.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(err: unknown): IpcResult<never> {
  return { ok: false, error: { code: 'EARNINGS_ERROR', message: err instanceof Error ? err.message : String(err) } };
}

export function registerEarningsIpc(
  service: EarningsService,
  getEtradeCreds: () => OAuthCredentials | null,
): void {
  // Get earnings for a single ticker
  ipcMain.handle('earnings:get', (_e: IpcMainInvokeEvent, ticker: string): IpcResult<ReturnType<EarningsService['getForTicker']>> => {
    try { return ok(service.getForTicker(ticker)); } catch (e) { return fail(e); }
  });

  // Get all upcoming earnings within N days
  ipcMain.handle('earnings:upcoming', (_e: IpcMainInvokeEvent, days = 60): IpcResult<ReturnType<EarningsService['getUpcoming']>> => {
    try { return ok(service.getUpcoming(days)); } catch (e) { return fail(e); }
  });

  // Refresh specific tickers (or all relevant if none supplied)
  ipcMain.handle('earnings:refresh', async (
    _e: IpcMainInvokeEvent,
    tickers?: string[],
    force?: boolean,
  ): Promise<IpcResult<{ updated: number; skipped: number; failed: number; errors: string[] }>> => {
    try {
      const creds = getEtradeCreds();
      const result = tickers && tickers.length > 0
        ? await service.refreshTickers(tickers, creds, force ?? false)
        : await service.refreshAllRelevant(creds, force ?? false);
      return ok(result);
    } catch (e) { return fail(e); }
  });

  // Manual override
  ipcMain.handle('earnings:setManual', (
    _e: IpcMainInvokeEvent,
    ticker: string,
    reportDate: string,
    reportTime?: 'bmo' | 'amc' | null,
  ): IpcResult<ReturnType<EarningsService['setManual']>> => {
    try { return ok(service.setManual(ticker, reportDate, reportTime)); } catch (e) { return fail(e); }
  });

  // Delete entry
  ipcMain.handle('earnings:delete', (_e: IpcMainInvokeEvent, ticker: string): IpcResult<void> => {
    try { service.deleteTicker(ticker); return ok(undefined); } catch (e) { return fail(e); }
  });
}
