// EarningsRefreshJob — batch job that refreshes earnings dates for all relevant tickers.
// Relevant tickers = open positions + all watchlist items + conviction stocks.
// Respects the 24h TTL in EarningsService — most tickers will be "skipped" (cached).
// Runs on startup (60s delay, after E*Trade tokens load) and is triggerable manually.
// v0.31.2

import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import type { EarningsService } from '../earnings-service.js';
import type { OAuthCredentials } from '../etrade-auth.js';
import type { DbHandle } from '../../db/connection.js';

const JOB_ID = 'earnings-refresh';

export class EarningsRefreshJob implements BatchJobHandler {
  readonly name = 'Earnings Refresh';
  readonly description =
    'Refreshes upcoming earnings dates for all portfolio, watchlist, and conviction tickers. ' +
    '24h cache — already-fresh entries are skipped. Uses E*Trade FUNDAMENTAL quote when connected, ' +
    'falls back to analysis_snapshots estimate.';

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
    // Collect all relevant tickers (open positions + watchlists + conviction)
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM (
        SELECT ticker FROM positions WHERE status = 'open'
        UNION
        SELECT ticker FROM watchlist_items
        UNION
        SELECT ticker FROM conviction_stocks
      )
      ORDER BY ticker
    `).all() as Row[];

    const tickers = rows.map(r => r.ticker);

    if (tickers.length === 0) {
      return {
        status: 'skipped',
        notes: 'No tickers in portfolio, watchlists, or conviction list.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    const creds = this.getCreds();
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
        } else if (result.failed > 0) {
          // No date found — not a hard error, just no data available
          failed++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'no-data',
            attempted, updated, skipped, failed, total: tickers.length,
            message: result.errors[0],
          });
        } else {
          // Skipped — within 24h TTL (or manual entry, never auto-refreshed)
          skipped++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'skipped',
            attempted, updated, skipped, failed, total: tickers.length,
          });
        }
      } catch (err) {
        failed++;
        onProgress({
          jobId: JOB_ID, runId: 0, ticker,
          status: 'failed',
          attempted, updated, skipped, failed, total: tickers.length,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      status: signal.aborted ? 'failed' : 'success',
      notes: `${updated} updated, ${skipped} cached/skipped, ${failed} no-data`,
      tickersAttempted: attempted,
      tickersUpdated: updated,
      tickersSkipped: skipped,
      tickersFailed: failed,
    };
  }
}
