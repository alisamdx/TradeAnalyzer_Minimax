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

    // ── Universe tickers — include actual max date for targeted fetching ──────
    type TickerRow = { ticker: string; max_date: string };
    const staleUniverse: { ticker: string; range: TimeRange; fromDate: string }[] = (this.db
      .prepare(`
        SELECT ticker, MAX(date) AS max_date FROM historical_prices
        GROUP BY ticker
        HAVING MAX(date) < date('now', '-1 day')
        ORDER BY ticker
      `)
      .all() as TickerRow[])
      .filter(r => !(SCORING_REFERENCE_TICKERS as readonly string[]).includes(r.ticker))
      .map(r => {
        // Fetch from (max_date + 1 day) with a 3-day lookback buffer for safety.
        // A 1-day gap → ~5 bars fetched instead of ~22 (1M). Capped at 1M.
        const maxDateMs = new Date(r.max_date + 'T12:00:00Z').getTime();
        const fromMs    = maxDateMs - 3 * 86_400_000; // 3-day buffer
        const fromDate  = new Date(fromMs).toISOString().slice(0, 10);
        return { ticker: r.ticker, range: '1M' as TimeRange, fromDate };
      });

    // Reference tickers always use the full 1Y range (no fromDate override)
    const jobs: { ticker: string; range: TimeRange; fromDate?: string }[] = [
      ...staleRef.map(r => ({ ...r, fromDate: undefined })),
      ...staleUniverse,
    ];
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

    // Process in concurrent batches of 5.
    // Each Polygon aggs call takes ~150-300ms; 5 in parallel = ~350ms per batch.
    // With 150ms between batches we stay well under any Polygon plan limit.
    const CONCURRENCY  = 5;
    const BATCH_DELAY  = 150; // ms between batches

    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      if (signal.aborted) break;

      const batch = jobs.slice(i, i + CONCURRENCY);

      await Promise.allSettled(
        batch.map(async ({ ticker, range, fromDate }) => {
          attempted++;
          try {
            const count = await fetchAndStorePrices(
              this.historicalService, this.provider, ticker, range, fromDate,
            );
            if (count > 0) {
              updated++;
              onProgress({ jobId: JOB_ID, runId: 0, ticker, status: 'updated', attempted, updated, skipped, failed, total });
            } else {
              skipped++;
              onProgress({ jobId: JOB_ID, runId: 0, ticker, status: 'skipped', attempted, updated, skipped, failed, total, message: 'No new bars' });
            }
          } catch (err) {
            failed++;
            onProgress({ jobId: JOB_ID, runId: 0, ticker, status: 'failed', attempted, updated, skipped, failed, total, message: err instanceof Error ? err.message : String(err) });
          }
        })
      );

      if (!signal.aborted && i + CONCURRENCY < jobs.length) await sleep(BATCH_DELAY);
    }

    return {
      status:           signal.aborted ? 'failed' : 'success',
      notes:            `${updated} updated, ${skipped} skipped, ${failed} failed of ${attempted} attempted.`,
      errorMessage:     signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated:   updated,
      tickersSkipped:   skipped,
      tickersFailed:    failed,
    };
  }
}
