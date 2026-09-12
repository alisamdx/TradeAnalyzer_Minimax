import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import { logError } from '../logger.js';
import {
  claimNextJob,
  finishJob,
  markJobRunning,
  runBackfillBars,
  runBootstrapIv,
  runLegacyImport,
  runReplayJob,
  runUniverseSeed,
  stalledRequests,
  expireAcceptances,
  sessionOnOrBefore,
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

// `reset` is deliberately absent: TradeAnalyzer 2 performs it itself (NewApp 04
// §7.6), because generation creation belongs to that application alone. A reset
// request reaching this handler is failed explicitly, like any unknown kind.
//
// `replay` runs HERE rather than in the new exe for one reason: account-domain
// archive lines are encrypted with this app's safeStorage key, and only this
// app can read them back (B9b).
const IMPLEMENTED: ReadonlySet<OneShotKind> = new Set<OneShotKind>([
  'universe_seed', 'backfill_bars', 'bootstrap_iv', 'legacy_import', 'replay'
]);

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
          // The session the run belongs to, not the calendar date: run on a
          // weekend or after midnight, the calendar date is a day with no session.
          const tradingDate = sessionOnOrBefore(deps.todayET());

          // An acceptance that has run out becomes `expired_review` before any
          // job reports, so the email and the review queue reflect what is
          // actually outstanding rather than what was outstanding yesterday.
          expireAcceptances(db, host, tradingDate);

          if (request.runKind === 'replay') {
            // Which run to replay; the latest completed daily run when omitted.
            // Read defensively — the params are whatever the queueing app wrote.
            const requested = request.params['runId'];
            const runId = typeof requested === 'number' && Number.isInteger(requested) && requested > 0
              ? requested
              : undefined;
            const report = runReplayJob(host, { tradingDate, ...(runId !== undefined ? { runId } : {}) });
            markJobRunning(db, request.requestId, report.jobRunId);
            finishJob(db, host, request.requestId, {
              state: 'complete',
              result: report as unknown as Record<string, unknown>
            });
            const c = report.coverage;
            return {
              // A `different` verdict is the replay working, not the job
              // failing — the same rule as a red gate. The diff is the
              // deliverable, and it is in the report the new exe reads.
              status: 'success',
              notes:
                `replay of run ${report.sourceRunIds.join(', ')}: ${report.verdict.toUpperCase()} — ` +
                `${c.replayed}/${c.considered} responses replayed` +
                (c.beforeRecipes > 0 ? `, ${c.beforeRecipes} captured before recipes were recorded` : '') +
                (report.scratchPath ? `; scratch database kept at ${report.scratchPath}` : ''),
              tickersAttempted: c.considered,
              tickersUpdated: c.replayed,
              tickersSkipped: c.noIngest + c.beforeRecipes,
              tickersFailed: c.unreadable + c.digestMismatch + c.badRecipe
            };
          }

          if (request.runKind === 'legacy_import') {
            // The old app's own connection is handed straight in — this job
            // runs inside that app, so there is nothing to attach (04 §7.4).
            const report = runLegacyImport(host, { legacyDb: db as never, tradingDate });
            markJobRunning(db, request.requestId, report.runId);
            finishJob(db, host, request.requestId, {
              state: 'complete',
              result: report as unknown as Record<string, unknown>
            });
            return {
              status: 'success',
              notes:
                `legacy_import: ${report.configRows} config rows, ${report.decisionRows} decisions` +
                // Rejections are the deliverable, not an error: an inverted
                // conviction band caught here is one that never reaches the
                // new generation.
                (report.rejected > 0 ? `; ${report.rejected} row(s) REJECTED — see the import log` : ''),
              tickersAttempted: report.tables.length,
              tickersUpdated: report.configRows + report.decisionRows,
              tickersSkipped: 0,
              tickersFailed: report.rejected
            };
          }

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
                `tickers, ${report.splitsStored} splits over ${report.splitPages} page(s)` +
                // Said plainly, because a truncated split list makes every QC-204
                // discontinuity in this run unreliable: a split we never fetched
                // cannot explain the step it caused, and the operator would be
                // ruling on artifacts.
                (report.splitsTruncated ? ' — SPLIT LIST TRUNCATED, do not rule on QC-204 findings' : '') +
                `; ${report.verdict.toUpperCase()}, ` +
                // Generation-wide, and said so: this is every open blocking
                // finding, not the count this run raised (2026-09-12 read 512
                // on a run whose QC-204 fired 151).
                `${report.reviewQueue.length} blocking finding(s) awaiting a ruling across the generation.`,
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
