// PriceGapFillJob — batch job that replicates the manual Data Sync → Price Gap Fill flow.
// Finds tickers in historical_prices whose latest bar is missing yesterday's close and backfills 1 month.
// Also bootstraps SPY + 11 SPDR sector ETFs so ScoringService can compute relative strength
// and sector momentum without separate fetch steps.
// Runs on any day (including weekends) since it backfills historical data, not today's prices.

import type { DbHandle } from '../../db/connection.js';
import { HistoricalDataService, fetchAndStorePrices } from '../historical-service.js';
import { detectAndRepairSplits } from '../split-repair.js';
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
    // ── Always re-fetch the recent window (incl. today), every run ─────────────
    // The batch runs twice a day: ~10:15 ET (45 min after open, intraday
    // opportunity scan) and ~16:30+ ET (after close). The morning run stores a
    // PARTIAL same-day bar (only the session-so-far volume + an intraday "close").
    // The old gate (`HAVING MAX(date) < date('now')`) then treated that partial
    // bar as "fresh" and the evening run SKIPPED the ticker — so the brief reused
    // the morning's partial bar (volume read ~10-25% of average, breakouts fired
    // on a non-final close). We now re-fetch the recent window for EVERY ticker on
    // EVERY run; `historical_prices` is `INSERT OR REPLACE` keyed on (ticker,date),
    // so the finalized end-of-day bar overwrites the partial morning one. Bounded
    // to a small window (from max_date − 3 days), so this is cheap per ticker.
    const refPh = SCORING_REFERENCE_TICKERS.map(() => '?').join(',');
    const FROM_BUFFER_DAYS = 3;
    const fromDateFor = (maxDate: string): string =>
      new Date(new Date(maxDate + 'T12:00:00Z').getTime() - FROM_BUFFER_DAYS * 86_400_000)
        .toISOString().slice(0, 10);

    // Reference tickers (SPY + sector ETFs) — re-fetch recent window if they have
    // history, bootstrap full 1Y if they don't.
    type RefMaxRow = { ticker: string; max_date: string };
    const refWithHistory = this.db.prepare(`
      SELECT ticker, MAX(date) AS max_date FROM historical_prices
      WHERE ticker IN (${refPh})
      GROUP BY ticker
    `).all(...SCORING_REFERENCE_TICKERS) as RefMaxRow[];
    const refWithHistorySet = new Set(refWithHistory.map(r => r.ticker));
    const bootstrapRef = (SCORING_REFERENCE_TICKERS as readonly string[]).filter(t => !refWithHistorySet.has(t));

    const staleRef: { ticker: string; range: TimeRange; fromDate?: string }[] = [
      ...bootstrapRef.map(t => ({ ticker: t, range: '1Y' as TimeRange, fromDate: undefined })),
      ...refWithHistory.map(r => ({ ticker: r.ticker, range: '1M' as TimeRange, fromDate: fromDateFor(r.max_date) })),
    ];

    // ── Universe tickers — re-fetch the recent window for every ticker with history.
    type TickerRow = { ticker: string; max_date: string };
    const staleUniverse: { ticker: string; range: TimeRange; fromDate: string }[] = (this.db
      .prepare(`
        SELECT ticker, MAX(date) AS max_date FROM historical_prices
        GROUP BY ticker
        ORDER BY ticker
      `)
      .all() as TickerRow[])
      .filter(r => !(SCORING_REFERENCE_TICKERS as readonly string[]).includes(r.ticker))
      .map(r => ({ ticker: r.ticker, range: '1M' as TimeRange, fromDate: fromDateFor(r.max_date) }));

    const jobs: { ticker: string; range: TimeRange; fromDate?: string }[] = [
      ...staleRef,
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

    // ── Split-adjustment repair pass (v1.1.139) ────────────────────────────────
    // The window re-fetch above keeps the LAST few days fresh but never revisits older
    // bars, so a split leaves the stored series permanently inconsistent: pre-split
    // prices before the event, post-split prices after. Polygon returns a fully adjusted
    // series on every fetch, so re-fetching a flagged ticker's whole history repairs it.
    // Runs after the gap fill so it scans the freshest data. Never fails the job — a
    // stale-but-present price history is far better than a halted orchestrator chain.
    let splitNote = '';
    try {
      const rep = await detectAndRepairSplits(this.db, this.historicalService, this.provider, {
        signal,
        onProgress: (ticker, note) => onProgress({
          jobId: JOB_ID, runId: 0, ticker, status: 'updated',
          attempted, updated, skipped, failed, total, message: `split repair: ${note}`,
        }),
      });
      if (rep.flagged > 0) {
        splitNote = ` Split scan: ${rep.repaired} repaired, ${rep.confirmedReal} confirmed real`
                  + (rep.failed ? `, ${rep.failed} failed` : '') + '.';
        for (const d of rep.details) console.log(`[price-gap-fill] ${d}`);
      }
    } catch (err) {
      splitNote = ` Split scan errored: ${err instanceof Error ? err.message : String(err)}.`;
    }

    return {
      status:           signal.aborted ? 'failed' : 'success',
      notes:            `${updated} updated, ${skipped} skipped, ${failed} failed of ${attempted} attempted.${splitNote}`,
      errorMessage:     signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated:   updated,
      tickersSkipped:   skipped,
      tickersFailed:    failed,
    };
  }
}
