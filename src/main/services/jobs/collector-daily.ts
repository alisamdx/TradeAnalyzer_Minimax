import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { beginRun, finishRun, runPreflight } from '@tradeanalyzer/core';
import { readSharedPointer } from '../../collector-host/electron-collector-host.js';
import type { HostFactory } from './collector-oneshot.js';

/**
 * `data-collector` — the daily run (NewApp 04 §2, 06 §5 change #4).
 *
 * At B3 this is **phase 0 only**: preflight, and a `meta_run` row that records
 * what the day looked like. Phases 1 through 10 land at B4 onward.
 *
 * Registered at 17:05, after-close only. That places it after this app's own
 * after-close chain has started; if that chain is still running the batch mutex
 * makes the collector wait its turn, and the 19:30 watchdog catches the case
 * where the wait swallowed the day.
 *
 * 17:00 rather than 16:30 because Polygon keeps settling the day's bar past
 * 16:00 ET — the existing app learned that by storing partial bars and scoring
 * breakouts off them.
 */
export function createCollectorDailyJob(deps: {
  readonly makeHost: HostFactory;
  readonly todayET: () => string;
}): BatchJobHandler {
  return {
    name: 'Data collector (new application)',
    description:
      'The daily collection run for the rebuild: preflight and the run record. Writes only into ' +
      'the new generation, never into this application\'s own database.',

    async run(
      onProgress: (evt: BatchProgressEvent) => void,
      signal: AbortSignal
    ): Promise<BatchJobResult> {
      const base: BatchJobResult = {
        status: 'skipped',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0
      };

      const pointer = readSharedPointer();
      if (!pointer) {
        return { ...base, notes: 'No generation pointer yet — the new application has not been run.' };
      }

      const host = deps.makeHost({
        signal,
        onProgress: (phase, done, total, note) =>
          onProgress({
            jobId: 'data-collector', runId: 0, ticker: note ?? phase, status: 'updated',
            attempted: done, updated: done, skipped: 0, failed: 0, total,
            message: `${phase}${note ? `: ${note}` : ''}`
          })
      });

      try {
        const db = host.openGenerationDb();
        const tradingDate = deps.todayET();
        const run = beginRun(db, host, { kind: 'daily', tradingDate, slot: 'after_close' });

        const preflight = await runPreflight(host, db, run);
        if (!preflight.proceed) {
          finishRun(db, host, run, 'complete');
          return { ...base, notes: `Preflight stopped the run: ${preflight.detail}` };
        }

        finishRun(db, host, run, 'complete');
        return {
          ...base,
          status: 'success',
          notes:
            `Preflight passed for ${tradingDate} on generation ${preflight.generationNo} ` +
            `(${preflight.generationStatus}); E*Trade ${preflight.etrade}` +
            `${preflight.etradeDetail ? ` — ${preflight.etradeDetail}` : ''}. ` +
            'Phases 1-10 arrive at B4.'
        };
      } catch (err) {
        return {
          ...base,
          status: 'failed',
          tickersFailed: 1,
          errorMessage: err instanceof Error ? err.message : String(err)
        };
      } finally {
        host.close();
      }
    }
  };
}

/**
 * `collector-watchdog` — 03 §7.3.
 *
 * Runs at 19:30 and asks one question: did today produce a completed run? It
 * exists because the failure it catches is **silence**. A collector that never
 * started, or that was still waiting on the batch mutex when the evening ended,
 * looks exactly like a quiet day — and a green inbox that means "nothing ran" is
 * worse than a red one.
 */
export function createCollectorWatchdogJob(deps: {
  readonly makeHost: HostFactory;
  readonly todayET: () => string;
}): BatchJobHandler {
  return {
    name: 'Collector watchdog',
    description: 'Verifies the daily collection actually ran, and reports if it did not.',

    async run(
      _onProgress: (evt: BatchProgressEvent) => void,
      signal: AbortSignal
    ): Promise<BatchJobResult> {
      const base: BatchJobResult = {
        status: 'skipped',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0
      };

      const pointer = readSharedPointer();
      if (!pointer) return { ...base, notes: 'No generation pointer yet.' };

      const host = deps.makeHost({ signal, onProgress: () => undefined });
      try {
        const db = host.openGenerationDb();
        const today = deps.todayET();

        const trading = db
          .prepare('SELECT is_trading_day FROM ref_trading_day WHERE date = ?')
          .get(today) as { is_trading_day: number } | undefined;
        if (trading?.is_trading_day === 0) {
          return { ...base, notes: `${today} is not a trading day.` };
        }

        const runs = db
          .prepare("SELECT status FROM meta_run WHERE trading_date = ? AND run_kind = 'daily'")
          .all(today) as { status: string }[];

        if (runs.some((r) => r.status === 'complete')) {
          return { ...base, status: 'success', notes: `Daily collection completed for ${today}.` };
        }

        // Reported, not retried. A watchdog that quietly re-ran the job would
        // turn "the collector did not run" into "the collector ran late", and
        // the second is much harder to notice going wrong repeatedly.
        const detail = runs.length === 0
          ? 'no daily run exists for today'
          : `runs exist but none completed (${runs.map((r) => r.status).join(', ')})`;
        return {
          ...base,
          status: 'failed',
          tickersFailed: 1,
          errorMessage: `Collector watchdog: ${detail} for ${today}.`
        };
      } finally {
        host.close();
      }
    }
  };
}
