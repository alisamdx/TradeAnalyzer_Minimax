// MarketSyncJob — batch job that replicates the manual Data Sync → Sync Market Data flow.
// Calls screenerService.syncUniverse() to populate quote_cache + fundamentals_cache.
// Skips on non-trading days (weekends + NYSE holidays) since no new data is available.

import type { ScreenerService } from '../screener-service.js';
import type { Universe, BatchProgressEvent } from '@shared/types.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import { isTradingDay } from '../iv-history-service.js';

export class MarketSyncJob implements BatchJobHandler {
  readonly name: string;
  readonly description: string;
  private readonly jobId: string;

  constructor(
    private readonly screenerService: ScreenerService,
    private readonly universe: Extract<Universe, 'both' | 'etf'>,
  ) {
    if (universe === 'etf') {
      this.jobId = 'daily-market-sync-etfs';
      this.name = 'Daily Market Sync (ETFs)';
      this.description =
        'Fetches latest quotes and data for all ETF constituents into the local cache. ' +
        'Runs post-market on trading days to keep the screener and agent data fresh.';
    } else {
      this.jobId = 'daily-market-sync-stocks';
      this.name = 'Daily Market Sync (Stocks)';
      this.description =
        'Fetches latest quotes and fundamentals for all S&P 500 + Russell 1000 stocks into the local cache. ' +
        'Runs post-market on trading days to keep the screener and agent data fresh.';
    }
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    if (!isTradingDay(today)) {
      return {
        status: 'skipped',
        notes: 'Non-trading day — no new market data available.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    let attempted = 0;

    try {
      const result = await this.screenerService.syncUniverse(
        this.universe,
        (scanned, total, ticker) => {
          attempted = scanned;
          // Only emit an event when we have a ticker name (not the final completion ping)
          if (ticker && !signal.aborted) {
            onProgress({
              jobId:     this.jobId,
              runId:     0,           // overwritten by BatchService
              ticker,
              status:    'updated',   // syncUniverse swallows individual errors internally
              attempted: scanned,
              updated:   scanned,
              skipped:   0,
              failed:    0,
              total,
            });
          }
        },
        () => signal.aborted,
      );

      if (signal.aborted) {
        return {
          status: 'failed',
          errorMessage: 'Job was cancelled.',
          tickersAttempted: attempted,
          tickersUpdated:   attempted,
          tickersSkipped:   0,
          tickersFailed:    0,
        };
      }

      return {
        status: 'success',
        notes: `${result.scanned} tickers synced into cache.`,
        tickersAttempted: result.scanned,
        tickersUpdated:   result.scanned,
        tickersSkipped:   0,
        tickersFailed:    0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        errorMessage: message,
        tickersAttempted: attempted,
        tickersUpdated:   attempted,
        tickersSkipped:   0,
        tickersFailed:    0,
      };
    }
  }
}
