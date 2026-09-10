import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { logError } from '../logger.js';
import {
  claimNextJob,
  finishJob,
  markJobRunning,
  runBackfillBars,
  runBootstrapIv,
  runUniverseSeed,
  stalledRequests,
  expireAcceptances,
  type OneShotKind
} from '@tradeanalyzer/core';
import {
  ElectronCollectorHost,
  generationExists,
  readSharedPointer,
  type ElectronCollectorHostOptions
} from '../../collector-host/electron-collector-host.js';

/**
 * `collector-oneshot` — NewApp 04 §1.1, 06 §5 change #4.
 *
 * Claims at most one queued `meta_job_request` row per tick and executes it.
 * The operator never launches these from this app: the **new exe's Jobs view is
 * the only UI**, and it queues by inserting a row (05 §7). This app executes
 * because it holds the provider transports and the E*Trade token (Q4).
 *
 * One request per tick, deliberately. A loop draining the whole backlog would
 * hold the batch mutex for as long as the backlog took, and these jobs include
 * `backfill_bars` at ~1,600 calls.
 */

export type HostFactory = (
  opts: Pick<ElectronCollectorHostOptions, 'signal' | 'onProgress'>
) => ElectronCollectorHost;

export interface OneShotDeps {
  readonly makeHost: HostFactory;
  /** Supplies the universe lists for `universe_seed`, which are host-side config. */
  readonly universeSources: Parameters<typeof runUniverseSeed>[1]['sources'];
  readonly todayET: () => string;
}

const IMPLEMENTED: ReadonlySet<OneShotKind> = new Set<OneShotKind>(['universe_seed', 'backfill_bars', 'bootstrap_iv']);

export function createCollectorOneShotJob(deps: OneShotDeps): BatchJobHandler {
  return {
    name: 'Collector one-shot jobs',
    description:
      'Claims one queued job from the new application and runs it. The queue table is the ' +
      'entire interface between the two apps — no IPC, no socket, no shared process.',

    async run(
      onProgress: (evt: BatchProgressEvent) => void,
      signal: AbortSignal
    ): Promise<BatchJobResult> {
      const empty: BatchJobResult = {
        status: 'skipped',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0
      };

      const pointer = readSharedPointer();
      if (!pointer) {
        // Not an error. The new exe has not been run yet, so there is no
        // generation to collect into — and inventing one here would create a
        // second, empty generation indistinguishable from the real one having
        // lost its data.
        return { ...empty, notes: 'No generation pointer yet — the new application has not been run.' };
      }
      if (!generationExists(pointer)) {
        // The pointer exists but the generation does not, which happens after a
        // reset. Reported, never repaired: `new Database(path)` would create the
        // file, and the 2-minute tick would then manufacture a generation with
        // no `meta_generation` row — healthy-looking from every angle except
        // whose it is. Observed 2026-09-07, immediately after the corrupt
        // gen-001 was deleted.
        return {
          ...empty,
          notes: 'No generation yet — TradeAnalyzer 2 has not created one. Run it once.'
        };
      }

      const host = deps.makeHost({
        signal,
        onProgress: (phase, done, total, note) =>
          onProgress({
            jobId: 'collector-oneshot',
            runId: 0,
            ticker: note ?? phase,
            status: 'updated',
            attempted: done,
            updated: done,
            skipped: 0,
            failed: 0,
            total,
            message: `${phase}${note ? `: ${note}` : ''}`
          })
      });

      try {
        const db = host.openGenerationDb();

        // What this tick actually sees, written to the error log at INFO.
        //
        // Added 2026-09-07 after a queued row sat unclaimed through a dozen
        // ticks while the handler reported "No queued jobs." — with no way to
        // tell whether it was looking at the wrong database, reading a stale
        // snapshot, or genuinely seeing an empty table. Those want completely
        // different fixes, and the note alone could not distinguish them.
        let seen: { total: number; queued: number; maxId: number | null } = {
          total: 0, queued: 0, maxId: null
        };
        try {
          const row = db
            .prepare(
              `SELECT COUNT(*) AS total,
                      SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
                      MAX(request_id) AS maxId
                 FROM meta_job_request`
            )
            .get() as { total: number; queued: number | null; maxId: number | null };
          seen = { total: row.total, queued: row.queued ?? 0, maxId: row.maxId };
        } catch { /* diagnostics must never break the job */ }

        logError({
          timestamp: new Date().toISOString(),
          appVersion: '0.1.2',
          errorClass: 'CollectorOneShotTick',
          message:
            `dataRoot=${pointer.dataRoot} gen=${pointer.currentGeneration} ` +
            `requests total=${seen.total} queued=${seen.queued} maxId=${seen.maxId}`,
          stack: null,
          operation: 'collector-oneshot:tick',
          ticker: null,
          correlationId: null,
          level: 'INFO'
        });

        // A request stuck at `queued` means THIS handler is not running — which
        // it plainly is, so report anything old as a finding rather than
        // swallowing it. Hiding a stalled queue behind a spinner is the failure
        // mode a queue introduces (P9).
        const stalled = stalledRequests(db, host.nowET());

        const request = claimNextJob(db, host);
        if (!request) {
          return {
            ...empty,
            notes: stalled.length > 0
              ? `No claimable job. ${stalled.length} request(s) have been queued over 10 minutes.`
              : `No queued jobs (saw ${seen.total} request row(s), ${seen.queued} queued, ` +
                `max id ${seen.maxId ?? 'none'}, gen-${pointer.currentGeneration}).`
          };
        }

        if (!IMPLEMENTED.has(request.runKind)) {
          // Explicitly failed, never left claimed. A request that vanishes into
          // `claimed` and never moves looks identical to a crashed host.
          finishJob(db, host, request.requestId, {
            state: 'failed',
            error:
              `\`${request.runKind}\` is queued but not implemented yet. ` +
              `Implemented so far: ${[...IMPLEMENTED].join(', ')}.`
          });
          return {
            ...empty,
            status: 'failed',
            tickersFailed: 1,
            errorMessage: `Job kind ${request.runKind} is not implemented yet.`
          };
        }

        try {
          const tradingDate = deps.todayET();

          // An acceptance that has run out becomes `expired_review` before any
          // job reports, so the email and the review queue reflect what is
          // actually outstanding rather than what was outstanding yesterday.
          expireAcceptances(db, host, tradingDate);

          if (request.runKind === 'bootstrap_iv') {
            const report = await runBootstrapIv(host, { tradingDate });
            markJobRunning(db, request.requestId, report.runId);
            finishJob(db, host, request.requestId, {
              state: 'complete',
              result: report as unknown as Record<string, unknown>
            });
            return {
              status: 'success',
              notes:
                `bootstrap_iv: ${report.rowsStored} rows for ${report.tickersStored}/${report.tickersAttempted} ` +
                `tickers, ${report.from}..${report.to}` +
                // Surfaced in the operator's own line, not buried in the report
                // JSON. If this equals the row count the unit is wrong, not the
                // data — and those want opposite responses.
                (report.outOfBand > 0
                  ? `; ${report.outOfBand} value(s) OUTSIDE the fraction band — check the unit before accepting`
                  : ''),
              tickersAttempted: report.tickersAttempted,
              tickersUpdated: report.tickersStored,
              tickersSkipped: 0,
              tickersFailed: report.tickersFailed
            };
          }

          if (request.runKind === 'backfill_bars') {
            const report = await runBackfillBars(host, { tradingDate });
            markJobRunning(db, request.requestId, report.runId);
            finishJob(db, host, request.requestId, {
              state: 'complete',
              result: report as unknown as Record<string, unknown>
            });
            return {
              // A red verdict is the gate working, not the job failing. The
              // review queue it opens is the deliverable, not an error.
              status: 'success',
              notes:
                `backfill_bars: ${report.barsStored} bars for ${report.tickersStored}/${report.tickersAttempted} ` +
                `tickers, ${report.splitsStored} splits; ${report.verdict.toUpperCase()}, ` +
                `${report.reviewQueue.length} finding(s) awaiting a ruling.`,
              tickersAttempted: report.tickersAttempted,
              tickersUpdated: report.tickersStored,
              tickersSkipped: 0,
              tickersFailed: report.tickersFailed
            };
          }

          const report = await runUniverseSeed(host, {
            tradingDate,
            sources: deps.universeSources
          });
          markJobRunning(db, request.requestId, report.runId);
          finishJob(db, host, request.requestId, {
            state: 'complete',
            result: report as unknown as Record<string, unknown>
          });
          return {
            status: 'success',
            notes:
              `universe_seed: ${report.distinctTickers} tickers, ` +
              `${report.membershipsOpened} memberships opened, ` +
              `${report.referenceFetched} reference rows.`,
            tickersAttempted: report.distinctTickers,
            tickersUpdated: report.referenceFetched,
            tickersSkipped: 0,
            tickersFailed: report.referenceFailed
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finishJob(db, host, request.requestId, { state: 'failed', error: message });
          return {
            ...empty, status: 'failed', tickersFailed: 1, errorMessage: message
          };
        }
      } finally {
        host.close();
      }
    }
  };
}
