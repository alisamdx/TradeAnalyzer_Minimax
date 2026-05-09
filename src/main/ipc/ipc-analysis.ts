// IPC handlers for the Analysis Engine (FR-3) and Validate All (FR-4.4).
// see SPEC: FR-3, FR-4.4

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { AnalysisService } from '../services/analysis-service.js';
import type { ValidateAllService } from '../services/validate-all-service.js';
import type { JobQueue } from '../services/job-queue.js';
import type { WatchlistService } from '../services/watchlist-service.js';
import type {
  AnalysisMode,
  AnalysisModeInfo,
  AnalysisRunResult,
  ValidateAllResult,
  TickerStatusRow,
  JobRunInfo
} from '@shared/types.js';

function ok<T>(value: T) { return { ok: true as const, value }; }
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false as const, error: { code, message } };
}
function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args) => {
    try { return ok(fn(...args)); }
    catch (err) { return fail(err); }
  };
}

// ─── Static mode descriptors ─────────────────────────────────────────────────

export const ANALYSIS_MODES: AnalysisModeInfo[] = [
  {
    id: 'buy',
    label: 'Buy Opportunities',
    icon: '📈',
    description: 'Stocks in a buy zone: bullish SMA stack, RSI 40–65, pullback from recent swing low, strong fundamentals.',
    outputColumns: ['Ticker', 'Price', 'Score', 'Trend', 'RSI', 'Entry Zone', 'Stop', 'Target', 'R:R', 'Fundamentals']
  },
  {
    id: 'options_income',
    label: 'Options Income',
    icon: '💰',
    description: 'CSP and CC candidates at 30–45 DTE with delta 0.20–0.35. Shows premium, annualized return, breakeven.',
    outputColumns: ['Ticker', 'Price', 'Strategy', 'Strike', 'Exp', 'DTE', 'Delta', 'Premium', 'Ann. Return', 'Capital']
  },
  {
    id: 'wheel',
    label: 'Wheel Strategy',
    icon: '🎯',
    description: 'Wheel candidates: stable trend, IV rank ≥ 30, no earnings soon, liquid options. Suitability score 1–10.',
    outputColumns: ['Ticker', 'Price', 'Strike', 'Exp', 'DTE', 'Delta', 'Premium', 'Ann. Return', 'IV Rank', 'Suitability']
  },
  {
    id: 'bullish',
    label: 'Bullish Strategies',
    icon: '🐂',
    description: 'Bullish-trending stocks with appropriate options strategy: long call, bull call spread, or short put.',
    outputColumns: ['Ticker', 'Price', 'ADX', 'Strategy', 'Structure', 'Max Profit', 'Max Loss', 'Breakeven', 'POP']
  },
  {
    id: 'bearish',
    label: 'Bearish Strategies',
    icon: '🐻',
    description: 'Bearish-trending stocks with appropriate options strategy: long put, bear put spread, or short call.',
    outputColumns: ['Ticker', 'Price', 'ADX', 'Strategy', 'Structure', 'Max Profit', 'Max Loss', 'Breakeven', 'POP']
  }
];

export function registerAnalysisIpc(
  analysisService: AnalysisService,
  validateAllService: ValidateAllService,
  jobQueue: JobQueue,
  watchlistService: WatchlistService
): void {
  // ── Analysis modes ─────────────────────────────────────────────────────────
  ipcMain.handle('analysis:list-modes', () => ok(ANALYSIS_MODES));

  // ── Run analysis ───────────────────────────────────────────────────────────
  ipcMain.handle(
    'analysis:run',
    async (
      _e,
      args: { watchlistId: number; mode: AnalysisMode; tickerSubset?: string[] }
    ): Promise<{ ok: true; value: AnalysisRunResult } | { ok: false; error: { code: string; message: string } }> => {
      try {
        const items = watchlistService.listItems(args.watchlistId);
        const tickers = args.tickerSubset ?? items.map((i: import('@shared/types.js').WatchlistItem) => i.ticker);
        if (tickers.length === 0) return fail(new Error('No tickers to analyze.'));

        const onProgress = (_current: number, _total: number, _ticker: string) => {
          // Progress events would be sent via webContents.send in a real implementation.
          // For now, analysis is synchronous enough that the IPC handler handles it.
        };

        const results = await analysisService.analyzeWatchlist(
          args.watchlistId,
          tickers,
          args.mode,
          onProgress
        );

        const failedTickers: string[] = [];
        const snapshot = analysisService.saveSnapshot(args.watchlistId, args.mode, results);

        return ok({
          snapshotId: snapshot.id,
          mode: args.mode,
          resultCount: results.length,
          runAt: snapshot.runAt,
          resultsJson: JSON.stringify(results),
          failedTickers
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Snapshots ──────────────────────────────────────────────────────────────
  ipcMain.handle(
    'analysis:get-snapshots',
    wrap((watchlistId: number) => analysisService.listSnapshots(watchlistId))
  );

  ipcMain.handle(
    'analysis:get-snapshot',
    wrap((id: number) => {
      const snap = analysisService.getSnapshot(id);
      if (!snap) return null;
      const payload = JSON.parse(snap.payloadJson) as { jobRunId: number | null; results: unknown[] };
      return { ...snap, results: payload.results };
    })
  );

  ipcMain.handle(
    'analysis:delete-snapshot',
    wrap((id: number) => {
      analysisService.deleteSnapshot(id);
      return { success: true };
    })
  );

  ipcMain.handle(
    'analysis:clear-snapshots',
    wrap((watchlistId: number) => {
      analysisService.clearSnapshots(watchlistId);
      return { success: true };
    })
  );

  // ── Save as watchlist ──────────────────────────────────────────────────────
  ipcMain.handle(
    'analysis:save-as-watchlist',
    wrap((snapshotId: number, resultIndices: number[], name: string) => {
      const snap = analysisService.getSnapshot(snapshotId);
      if (!snap) throw new Error('Snapshot not found.');
      const payload = JSON.parse(snap.payloadJson) as { results: Array<{ ticker: string }> };
      const tickers = resultIndices.map((idx) => payload.results[idx]!.ticker);
      const wl = watchlistService.create(name);
      const added = watchlistService.addItemsBulk(wl.id, tickers.map((t) => ({ ticker: t, notes: null as string | null })));
      if (added.skipped.length > 0) {
        console.warn('[analysis:save-as-watchlist] skipped:', added.skipped);
      }
      return watchlistService.get(wl.id);
    })
  );

  // ── Cancel ─────────────────────────────────────────────────────────────────
  ipcMain.handle('analysis:cancel', () => {
    analysisService.cancel();
    return ok(true);
  });

  // ── Validate All ────────────────────────────────────────────────────────────
  ipcMain.handle(
    'validate-all:run',
    async (
      _e,
      args: { watchlistId: number }
    ): Promise<{ ok: true; value: ValidateAllResult } | { ok: false; error: { code: string; message: string } }> => {
      try {
        const items = watchlistService.listItems(args.watchlistId);
        const tickers = items.map((i: import('@shared/types.js').WatchlistItem) => i.ticker);
        if (tickers.length === 0) return fail(new Error('No tickers to validate.'));

        const results = await validateAllService.validateWatchlist(args.watchlistId, tickers);
        // Job status is available via validateAll:get-status IPC call.
        void results;

        return ok({
          jobRunId: 0,
          totalCount: tickers.length,
          succeededCount: results.length,
          failedCount: tickers.length - results.length,
          status: 'completed'
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  ipcMain.handle(
    'validate-all:get-status',
    wrap((jobRunId: number) => {
      const { run, progress } = validateAllService.getJobStatus(jobRunId);
      if (!run) return null;
      return {
        run: run as JobRunInfo,
        progress: progress as TickerStatusRow[]
      };
    })
  );

  ipcMain.handle('validate-all:cancel', () => {
    validateAllService.cancel();
    return ok(true);
  });

  // ── Job queue (for resume on startup) ─────────────────────────────────────
  ipcMain.handle(
    'job:list-incomplete',
    wrap(() => jobQueue.getIncompleteRuns())
  );

  ipcMain.handle(
    'job:resume',
    wrap((jobRunId: number) => {
      jobQueue.resumeRun(jobRunId);
      return jobQueue.getRun(jobRunId);
    })
  );

  ipcMain.handle(
    'job:discard',
    wrap((jobRunId: number) => {
      // Mark as stopped so it doesn't appear in incomplete runs.
      jobQueue.stopRun(jobRunId);
      jobQueue.finalizeRun(jobRunId, 'stopped');
      return true;
    })
  );
}
