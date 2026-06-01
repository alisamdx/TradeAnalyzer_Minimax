// PriceGapFillJob — batch job that replicates the manual Data Sync → Price Gap Fill flow.
// Finds tickers in historical_prices whose latest bar is > 2 days old and backfills 1 month.
// Runs on any day (including weekends) since it backfills historical data, not today's prices.

import type { DbHandle } from '../../db/connection.js';
import { HistoricalDataService, fetchAndStorePrices } from '../historical-service.js';
import { PolygonDataProvider } from '../polygon-provider.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';

const JOB_ID = 'daily-price-gap-fill';

/** Pause between Polygon calls — keeps us well under the 100 req/min free tier limit. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class PriceGapFillJob implements BatchJobHandler {
  readonly name = 'Daily Price Gap Fill';
  readonly description =
    'Backfills missing daily price bars for all tickers already in the price history database. ' +
    'Fetches the last 1 month of OHLCV data from Polygon for each stale ticker.';

  private readonly historicalService: HistoricalDataService;
  private readonly provider: PolygonDataProvider;

  constructor(
    private readonly db: DbHandle,
    getApiKey: () => string,
  ) {
    this.historicalService = new HistoricalDataService(db);
    this.provider          = new PolygonDataProvider(getApiKey);
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<BatchJobResult> {
    // Tickers already tracked in historical_prices whose latest bar is > 2 days old
    type TickerRow = { ticker: string };
    const stale = this.db
      .prepare(`
        SELECT ticker FROM historical_prices
        GROUP BY ticker
        HAVING MAX(date) < date('now', '-2 day')
        ORDER BY ticker
      `)
      .all() as TickerRow[];

    const total = stale.length;

    if (total === 0) {
      return {
        status: 'success',
        notes: 'Price history is already up to date — no gaps found.',
        tickersAttempted: 0,
        tickersUpdated:   0,
        tickersSkipped:   0,
        tickersFailed:    0,
      };
    }

    let attempted = 0;
    let updated   = 0;
    let skipped   = 0;
    let failed    = 0;

    for (const { ticker } of stale) {
      if (signal.aborted) break;

      attempted++;

      try {
        const count = await fetchAndStorePrices(this.historicalService, this.provider, ticker, '1M');

        if (count > 0) {
          updated++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'updated', attempted, updated, skipped, failed, total,
          });
        } else {
          skipped++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'skipped', attempted, updated, skipped, failed, total,
            message: 'No new bars returned from Polygon',
          });
        }
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        onProgress({
          jobId: JOB_ID, runId: 0, ticker,
          status: 'failed', attempted, updated, skipped, failed, total,
          message,
        });
      }

      // ~120 tickers/min — well under Polygon's 100 req/min for the free tier
      // (fetchAndStorePrices uses a single aggregates call per ticker)
      if (!signal.aborted) await sleep(500);
    }

    return {
      status:          signal.aborted ? 'failed' : 'success',
      notes:           `${updated} updated, ${skipped} skipped, ${failed} failed of ${attempted} attempted.`,
      errorMessage:    signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated:   updated,
      tickersSkipped:   skipped,
      tickersFailed:    failed,
    };
  }
}
