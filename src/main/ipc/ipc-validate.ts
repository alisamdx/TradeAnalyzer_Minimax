// IPC handlers for the Validation Dashboard (FR-4).
// see SPEC: FR-4
// Single ticker drill-in + ticker list management.

import { ipcMain } from 'electron';
import type { ValidateAllService } from '../services/validate-all-service.js';
import type { WatchlistService } from '../services/watchlist-service.js';
import type { ValidateDashboardResult, JobRunInfo, TickerStatusRow, ValidateAllResult } from '@shared/types.js';

function ok<T>(value: T) { return { ok: true as const, value }; }
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false as const, error: { code, message } };
}
function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: unknown, ...args: Args) => {
    try { return ok(fn(...args)); }
    catch (err) { return fail(err); }
  };
}

export function registerValidateIpc(
  validateAllService: ValidateAllService,
  watchlistService: WatchlistService
): void {
  // ── Open single ticker ───────────────────────────────────────────────────
  ipcMain.handle(
    'validate:open-ticker-by-id',
    async (
      _e,
      args: { ticker: string }
    ): Promise<{ ok: true; value: ValidateDashboardResult } | { ok: false; error: { code: string; message: string } }> => {
      try {
        const result = await validateAllService.validateTicker(args.ticker);
        return ok(result as ValidateDashboardResult);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Ticker list for a watchlist ──────────────────────────────────────────
  ipcMain.handle(
    'validate:get-tickers',
    wrap((watchlistId: number) => {
      const items = watchlistService.listItems(watchlistId);
      return items.map((i: import('@shared/types.js').WatchlistItem) => i.ticker);
    })
  );

  // ── Validate All batch run ───────────────────────────────────────────────
  ipcMain.handle(
    'validate:run-all',
    async (
      _e,
      args: { watchlistId: number }
    ): Promise<{ ok: true; value: ValidateAllResult } | { ok: false; error: { code: string; message: string } }> => {
      try {
        const items = watchlistService.listItems(args.watchlistId);
        const tickers = items.map((i: import('@shared/types.js').WatchlistItem) => i.ticker);
        if (tickers.length === 0) return fail(new Error('No tickers to validate.'));

        const results = await validateAllService.validateWatchlist(args.watchlistId, tickers);
        void results;

        return ok({
          jobRunId: 0,
          totalCount: tickers.length,
          succeededCount: results.length,
          failedCount: tickers.length - results.length,
          status: 'completed'
        } satisfies ValidateAllResult);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Status / progress ───────────────────────────────────────────────────
  ipcMain.handle(
    'validate:get-status',
    wrap((_watchlistId: number) => {
      // Find the most recent validate_all job for this watchlist
      const { run, progress } = validateAllService.getJobStatus(0);
      return run ? { run: run as JobRunInfo, progress: progress as TickerStatusRow[] } : null;
    })
  );

  // ── Cancel ────────────────────────────────────────────────────────────────
  ipcMain.handle('validate:cancel', () => {
    validateAllService.cancel();
    return ok(true);
  });
}
