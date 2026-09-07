import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';
import { throwIfCancelled } from './host.js';
import { captureResponse } from './capture.js';
import { beginRun, finishRun, captureRuleId, type RunHandle } from './run.js';
import { makeBarIngest, ingestSplits } from '../ingest/market.js';
import { QC202_OHLC_ORDER, QC204_DISCONTINUITY, QC205_VOLUME_REGIME } from '../qa/checks/bars.js';
import { runGate } from '../qa/gate.js';
import { reviewQueue } from '../qa/operator.js';
import { buildStatusEmail } from '../qa/email.js';
import { COLLECTOR_VERSION } from '../version.js';

/**
 * `backfill_bars` — 04 §7.2.
 *
 * One `aggs` call per universe member for the last five years. Roughly 1,600
 * calls; the whole history arrives in a single pass per ticker, so
 * `adjusted_as_of` is the same date for every row and the series is internally
 * consistent by construction.
 *
 * **That consistency is the point of doing it as one job.** The existing app
 * built its history incrementally and re-fetched only a three-day tail, so a
 * split occurring later left pre-split bars sitting next to post-split ones — a
 * permanent step mid-series, 153 of them across 126 tickers. Freshness of the
 * tail never implies consistency of the history.
 *
 * The job ends with an email whose blocking list **is** the operator's review
 * queue: QC-205 ticker-reuse candidates must be ruled on before the pilot's
 * first daily run counts toward the 20-day streak.
 */

export const BACKFILL_RULE = { scope: 'universe_all', adjusted: true, depthYears: 5 } as const;

export interface BackfillReport {
  readonly runId: number;
  readonly tickersAttempted: number;
  readonly tickersStored: number;
  readonly tickersFailed: number;
  readonly barsStored: number;
  readonly splitsStored: number;
  readonly reviewQueue: readonly { readonly exceptionId: number; readonly checkId: string; readonly key: string; readonly detail: string }[];
  readonly verdict: 'green' | 'amber' | 'red';
  readonly emailSent: boolean;
  readonly emailError?: string;
}

function fiveYearsBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

export async function runBackfillBars(
  host: CollectorHost,
  args: {
    readonly tradingDate: string;
    readonly tickers?: readonly string[];
    readonly generationNo?: number;
  }
): Promise<BackfillReport> {
  const db: SqliteLike = host.openGenerationDb();
  const run: RunHandle = beginRun(db, host, { kind: 'backfill_bars', tradingDate: args.tradingDate });

  try {
    const ruleId = captureRuleId(
      db, host, 'bars_backfill', BACKFILL_RULE,
      'One-time five-year bar history for every universe member, fetched in a single pass per ticker.'
    );

    const tickers =
      args.tickers ??
      (
        db
          .prepare('SELECT DISTINCT ticker FROM ref_universe_membership ORDER BY ticker')
          .all() as { ticker: string }[]
      ).map((r) => r.ticker);

    const from = fiveYearsBefore(args.tradingDate);

    // Splits first, so a discontinuity found during the sweep has something to
    // be explained BY. Fetching them afterwards would open exceptions the very
    // next statement could have closed, and an exception raised and immediately
    // resolved still costs the operator a reading.
    host.progress('backfill:splits', 0, 1, 'five-year split sweep');
    const splitResponse = await host.polygonGet('/v3/reference/splits', {
      'execution_date.gte': from, 'execution_date.lte': args.tradingDate, limit: '1000'
    });
    const splits = captureResponse({
      host, db, runId: run.runId, asOfDate: args.tradingDate, provider: 'polygon',
      endpoint: '/v3/reference/splits', slug: 'reference-splits-backfill',
      params: { from, to: args.tradingDate }, response: splitResponse, captureRuleId: ruleId,
      ingest: ingestSplits
    });

    let stored = 0;
    let failed = 0;
    let bars = 0;

    for (const [i, ticker] of tickers.entries()) {
      throwIfCancelled(host, 'backfill_bars');
      host.progress('backfill:bars', i, tickers.length, ticker);

      const path = `/v2/aggs/ticker/${ticker}/range/1/day/${from}/${args.tradingDate}`;
      const response = await host.polygonGet(path, { adjusted: 'true', sort: 'asc', limit: '50000' });

      const result = captureResponse({
        host, db, runId: run.runId, asOfDate: args.tradingDate, provider: 'polygon',
        endpoint: path, slug: 'aggs-day-backfill', params: { ticker, from, to: args.tradingDate },
        response, captureRuleId: ruleId,
        ingest: makeBarIngest({ ticker, fetchKind: 'backfill', adjustedAsOf: args.tradingDate })
      });

      if (result.parseStatus === 'ok' && result.rowsWritten > 0) {
        stored++;
        bars += result.rowsWritten;
      } else {
        failed++;
      }
    }

    // The series checks run over everything this run wrote. Running them here
    // rather than only in the next daily run is what makes the review queue land
    // with the backfill email instead of a day later.
    const gate = runGate(db, host, {
      runId: run.runId,
      tradingDate: args.tradingDate,
      checks: [QC202_OHLC_ORDER, QC204_DISCONTINUITY, QC205_VOLUME_REGIME],
      domainsExpected: { bars: { expected: tickers.length, stored } }
    });

    const queue = reviewQueue(db);
    const finishedAt = host.nowET();
    finishRun(db, host, run, 'complete', gate.verdict);

    const email = buildStatusEmail(db, {
      runId: run.runId,
      tradingDate: args.tradingDate,
      slot: 'backfill_bars',
      verdict: gate.verdict,
      generationNo: args.generationNo ?? 1,
      generationStatus: 'pilot',
      collectorVersion: COLLECTOR_VERSION,
      startedAt: run.startedAt,
      finishedAt,
      domains: { bars: { expected: tickers.length, stored } }
    });

    let emailSent = false;
    let emailError: string | undefined;
    try {
      await host.sendEmail(email);
      emailSent = true;
      db.prepare("UPDATE qa_quality_report SET email_sent_at = ?, email_status = 'sent' WHERE report_id = ?")
        .run(finishedAt, gate.reportId);
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE qa_quality_report SET email_status = 'failed', email_error = ? WHERE report_id = ?")
        .run(emailError, gate.reportId);
    }

    return {
      runId: run.runId,
      tickersAttempted: tickers.length,
      tickersStored: stored,
      tickersFailed: failed,
      barsStored: bars,
      splitsStored: splits.rowsWritten,
      reviewQueue: queue.map((q) => ({ exceptionId: q.exceptionId, checkId: q.checkId, key: q.key, detail: q.detail })),
      verdict: gate.verdict,
      emailSent,
      ...(emailError ? { emailError } : {})
    };
  } catch (err) {
    finishRun(db, host, run, host.signal.aborted ? 'cancelled' : 'failed');
    throw err;
  }
}

/**
 * Whether the backfill's review queue is clear — B5's gate, and a precondition
 * on the pilot's clean-day streak (04 §7.2).
 *
 * A ticker-reuse candidate left unruled means the bar history for that symbol
 * still splices two companies, and every indicator computed across the boundary
 * inherits that silently. Counting such a day toward the streak would certify a
 * generation whose history is known to be wrong.
 */
export function backfillQueueClear(db: SqliteLike): {
  readonly clear: boolean;
  readonly outstanding: readonly { readonly exceptionId: number; readonly checkId: string; readonly key: string }[];
} {
  const outstanding = reviewQueue(db)
    .filter((q) => q.checkId === 'QC-204' || q.checkId === 'QC-205')
    .map((q) => ({ exceptionId: q.exceptionId, checkId: q.checkId, key: q.key }));
  return { clear: outstanding.length === 0, outstanding };
}
