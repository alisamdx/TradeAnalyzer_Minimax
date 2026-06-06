// PriceGapFillJob — batch job that replicates the manual Data Sync → Price Gap Fill flow.
// Finds tickers in historical_prices whose latest bar is missing yesterday's close and backfills 1 month.
// Also bootstraps SPY + 11 SPDR sector ETFs so ScoringService can compute relative strength
// and sector momentum without separate fetch steps.
// Runs on any day (including weekends) since it backfills historical data, not today's prices.

import type { DbHandle } from '../../db/connection.js';
import { HistoricalDataService, fetchAndStorePrices } from '../historical-service.js';
import type { TimeRange } from '../historical-service.js';
import { PolygonDataProvider } from '../polygon-provider.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';

const JOB_ID = 'daily-price-gap-fill';

/**
 * SPY + 11 SPDR sector ETFs used by ScoringService for relative-strength and
 * sector-momentum signals. Always maintained in historical_prices regardless of
 * whether they appear in the screener universe.
 */
export const SCORING_REFERENCE_TICKERS = [
  'SPY',   // S&P 500 benchmark for relative strength
  'XLK',   // Technology
  'XLF',   // Financials
  'XLV',   // Health Care
  'XLE',   // Energy
  'XLI',   // Industrials
  'XLP',   // Consumer Staples
  'XLY',   // Consumer Discretionary
  'XLB',   // Materials
  'XLRE',  // Real Estate
  'XLU',   // Utilities
  'XLC',   // Communication Services
] as const;

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
    // ── Reference ticker bootstrap ─────────────────────────────────────────────
    // SPY + sector ETFs must always be fresh for ScoringService relative-strength
    // and sector-momentum signals. Fetch 6M (instead of 1M) so there are enough
    // bars for the 90-day return calculation even on first run.
    const refPh = SCORING_REFERENCE_TICKERS.map(() => '?').join(',');
    type RefRow = { ticker: string };
    const freshRef = new Set(
      (this.db.prepare(`
        SELECT ticker FROM historical_prices
        WHERE ticker IN (${refPh})
        GROUP BY ticker
        HAVING MAX(date) >= date('now', '-1 day')
      `).all(...SCORING_REFERENCE_TICKERS) as RefRow[]).map(r => r.ticker)
    );
    // Use '1Y' (≈252 trading days) for reference-ticker bootstrap — gives a comfortable
    // 162-day buffer over the 90-day return window, handles holiday gaps, and future-proofs
    // against any extension of the lookback period.  Cost: one extra Polygon call per ticker,
    // done only once (subsequent runs hit the stale-ticker path with '1M').
    const staleRef: { ticker: string; range: TimeRange }[] =
      (SCORING_REFERENCE_TICKERS as readonly string[])
        .filter(t => !freshRef.has(t))
        .map(t => ({ ticker: t, range: '1Y' }));

    // ── Universe tickers ───────────────────────────────────────────────────────
    type TickerRow = { ticker: string };
    const staleUniverse: { ticker: string; range: TimeRange }[] = (this.db
      .prepare(`
        SELECT ticker FROM historical_prices
        GROUP BY ticker
        HAVING MAX(date) < date('now', '-1 day')
        ORDER BY ticker
      `)
      .all() as TickerRow[])
      // Skip reference tickers here — already handled above
      .filter(r => !(SCORING_REFERENCE_TICKERS as readonly string[]).includes(r.ticker))
      .map(r => ({ ticker: r.ticker, range: '1M' as TimeRange }));

    const jobs = [...staleRef, ...staleUniverse];
    const total = jobs.length;

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

    for (const { ticker, range } of jobs) {
      if (signal.aborted) break;

      attempted++;

      try {
        const count = await fetchAndStorePrices(this.historicalService, this.provider, ticker, range);

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
