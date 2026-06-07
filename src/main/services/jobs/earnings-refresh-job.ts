// EarningsRefreshJob — batch job that refreshes upcoming earnings dates for the full
// S&P 500 + Russell 1000 universe (unique tickers from the constituents table).
//
// Smart caching: a ticker is skipped if it already has a future report_date stored.
// Only re-fetched after that date passes (earnings occurred → need next date).
// Manual entries are never overwritten.
//
// Data source: E*Trade FUNDAMENTAL quote only. No fallback.
// Runs on startup with 60s delay (after E*Trade tokens load) + manually.
// v0.31.4

import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import type { EarningsService } from '../earnings-service.js';
import type { OAuthCredentials } from '../etrade-auth.js';
import type { DbHandle } from '../../db/connection.js';

const JOB_ID = 'earnings-refresh';
const DEFAULT_CALL_DELAY_MS = 500; // conservative default — avoids E*Trade 429s
const MIN_CALL_DELAY_MS = 200;
const MAX_CALL_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readCallDelay(db: DbHandle): number {
  type Row = { config_json: string | null };
  const row = db.prepare(`SELECT config_json FROM batch_jobs WHERE id = ?`).get(JOB_ID) as Row | undefined;
  if (!row?.config_json) return DEFAULT_CALL_DELAY_MS;
  try {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    const v = cfg['callDelayMs'];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(MIN_CALL_DELAY_MS, Math.min(MAX_CALL_DELAY_MS, Math.round(v)));
    }
  } catch { /* ignore */ }
  return DEFAULT_CALL_DELAY_MS;
}

export class EarningsRefreshJob implements BatchJobHandler {
  readonly name = 'Earnings Refresh';
  readonly description =
    'Refreshes upcoming earnings dates for all S&P 500 + Russell 1000 tickers via E*Trade. ' +
    'Smart caching: skips tickers that already have a future earnings date stored. ' +
    'Only re-fetches after a stored date passes (next earnings cycle).';

  constructor(
    private readonly db: DbHandle,
    private readonly earningsService: EarningsService,
    private readonly getCreds: () => OAuthCredentials | null,
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
  ): Promise<BatchJobResult> {
    const callDelayMs = readCallDelay(this.db);

    // Full S&P 500 + Russell 1000 universe — unique tickers only
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM constituents ORDER BY ticker
    `).all() as Row[];

    const tickers = rows.map(r => r.ticker);

    if (tickers.length === 0) {
      return {
        status: 'skipped',
        notes: 'No constituents loaded. Run a Data Sync first.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    const creds = this.getCreds();

    if (!creds?.accessToken) {
      return {
        status: 'skipped',
        notes: 'E*Trade not connected — reconnect in Settings to fetch earnings dates.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    let attempted = 0, updated = 0, skipped = 0, failed = 0;

    for (const ticker of tickers) {
      if (signal.aborted) break;

      attempted++;

      try {
        const result = await this.earningsService.refreshTickers([ticker], creds, force);

        if (result.updated > 0) {
          updated++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'updated',
            attempted, updated, skipped, failed, total: tickers.length,
          });
          // Delay after a real API call to respect E*Trade rate limits
          if (!signal.aborted) await sleep(callDelayMs);
        } else if (result.failed > 0) {
          failed++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'no-data',
            attempted, updated, skipped, failed, total: tickers.length,
            message: result.errors[0],
          });
          // Still delay — even a failed call hit the API
          if (!signal.aborted) await sleep(callDelayMs);
        } else {
          // Skipped — future date already cached or manual entry
          skipped++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'skipped',
            attempted, updated, skipped, failed, total: tickers.length,
          });
          // No delay needed — no API call was made
        }
      } catch (err) {
        failed++;
        onProgress({
          jobId: JOB_ID, runId: 0, ticker,
          status: 'failed',
          attempted, updated, skipped, failed, total: tickers.length,
          message: err instanceof Error ? err.message : String(err),
        });
        if (!signal.aborted) await sleep(callDelayMs);
      }
    }

    const allSkipped = attempted > 0 && updated === 0 && failed === 0;
    return {
      status: signal.aborted ? 'failed' : 'success',
      notes: allSkipped
        ? `All ${skipped} tickers have valid future dates cached`
        : `${updated} updated, ${skipped} cached (future date), ${failed} no-data`,
      tickersAttempted: attempted,
      tickersUpdated: updated,
      tickersSkipped: skipped,
      tickersFailed: failed,
    };
  }
}
