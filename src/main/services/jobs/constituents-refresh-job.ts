// ConstituentsRefreshJob — keeps the S&P 500 and Russell 1000 constituent lists current
// without the manual Wikipedia-refresh / CSV-import step. Runs first in the orchestrator
// (before Market Sync) so every downstream job sees today's membership.
//
// Source: Vanguard fund holdings (VOO / VONE) primary, Wikipedia fallback — both gated
// in ConstituentsService so a broken feed can never wipe a known-good list.
//
// New members get 1 year of daily bars bootstrapped from Polygon immediately, so the
// same evening's technical signals / scoring can price them. IV history cannot be
// backfilled from Polygon — it accumulates from the daily IV capture (IV rank appears
// after 21 trading days) or via the manual IVolatility backfill in the IV History view.
//
// A source outage returns status 'success' with a warning note (never 'failed') — the
// orchestrator halts the whole nightly chain on a failed sub-job, and running against a
// slightly stale constituent list is strictly better than skipping the brief.

import type { DbHandle } from '../../db/connection.js';
import type { ConstituentsService, ConstituentsRefreshOutcome } from '../constituents-service.js';
import { HistoricalDataService, fetchAndStorePrices } from '../historical-service.js';
import { PolygonDataProvider } from '../polygon-provider.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';

const JOB_ID = 'constituents-refresh';

const INDICES = ['sp500', 'russell1000'] as const;

/** Pause between Polygon bootstrap batches — same pacing as PriceGapFillJob. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ConstituentsRefreshJob implements BatchJobHandler {
  readonly name = 'Constituents Refresh';
  readonly description =
    'Refreshes the S&P 500 and Russell 1000 constituent lists from Vanguard fund holdings ' +
    '(VOO/VONE, Wikipedia fallback) and bootstraps 1 year of price history for newly added members.';

  private readonly historicalService: HistoricalDataService;
  private readonly provider: PolygonDataProvider;

  constructor(
    private readonly db: DbHandle,
    private readonly constituentsService: ConstituentsService,
    getApiKey: () => string,
  ) {
    this.historicalService = new HistoricalDataService(db);
    this.provider          = new PolygonDataProvider(getApiKey);
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<BatchJobResult> {
    const noteParts: string[] = [];
    const allAdded = new Set<string>();
    let refreshFailures = 0;

    // ── 1. Refresh each index (Vanguard primary, Wikipedia fallback, gated) ──
    for (const index of INDICES) {
      if (signal.aborted) break;
      try {
        const outcome: ConstituentsRefreshOutcome = await this.constituentsService.refreshIndexAuto(index);
        for (const t of outcome.added) allAdded.add(t);
        noteParts.push(
          `${index}: ${outcome.total} via ${outcome.source}` +
          (outcome.asOf ? ` (holdings as of ${outcome.asOf})` : '') +
          (outcome.added.length || outcome.removed.length
            ? ` (+${outcome.added.length}${outcome.added.length ? ` [${outcome.added.join(', ')}]` : ''}` +
              ` / −${outcome.removed.length}${outcome.removed.length ? ` [${outcome.removed.join(', ')}]` : ''})`
            : ' (no changes)') +
          // Holdings the source listed without a ticker cannot be members, but they are named (v1.1.366):
          // DDS left the Russell 1000 on 2026-10-15 because Vanguard listed it with a blank ticker.
          (outcome.untickered?.length
            ? ` · ${outcome.untickered.length} holding(s) without a ticker skipped: ${outcome.untickered.join('; ')}`
            : '')
        );
        onProgress({
          jobId: JOB_ID, runId: 0, ticker: index.toUpperCase(), status: 'updated',
          attempted: 0, updated: 0, skipped: 0, failed: 0, total: 0,
          message: noteParts[noteParts.length - 1],
        });
      } catch (err) {
        refreshFailures++;
        const message = err instanceof Error ? err.message : String(err);
        noteParts.push(`${index}: refresh FAILED — kept existing list (${message})`);
        onProgress({
          jobId: JOB_ID, runId: 0, ticker: index.toUpperCase(), status: 'failed',
          attempted: 0, updated: 0, skipped: 0, failed: 0, total: 0, message,
        });
      }
    }

    // ── 1b. Sectors from Wikipedia (v1.1.342) ─────────────────────────────────
    // Vanguard carries no sector, so without this new members never get one and the stored values
    // stay whatever the last Wikipedia parse wrote — which until v1.1.342 was the GICS SUB-INDUSTRY.
    // A failure keeps the stored sectors and is a warning, never a chain-halting failure.
    let sectorFailure = false;
    if (!signal.aborted) {
      try {
        const s = await this.constituentsService.refreshSectorsFromWikipedia();
        noteParts.push(`sectors: ${s.updated} rows set from Wikipedia (${s.parsed} S&P 500 names)`);
      } catch (err) {
        sectorFailure = true;
        noteParts.push(`sectors: refresh FAILED — kept stored sectors (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    // ── 2. Bootstrap 1Y price history for genuinely new tickers ──────────────
    // "New to an index" ≠ "new to the DB" — a ticker moving between lists (or already
    // tracked via a watchlist) has bars; only fetch those with no history at all.
    const toBootstrap = [...allAdded].filter((t) => {
      const row = this.db
        .prepare(`SELECT 1 AS present FROM historical_prices WHERE ticker = ? LIMIT 1`)
        .get(t) as { present: number } | undefined;
      return row === undefined;
    }).sort();

    let attempted = 0;
    let updated   = 0;
    let failed    = 0;

    const CONCURRENCY = 3;
    const BATCH_DELAY = 250; // ms between batches — well under Polygon plan limits

    for (let i = 0; i < toBootstrap.length; i += CONCURRENCY) {
      if (signal.aborted) break;
      const batch = toBootstrap.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (ticker) => {
          attempted++;
          try {
            const count = await fetchAndStorePrices(this.historicalService, this.provider, ticker, '1Y');
            // Zero bars is not a bootstrap. On 2026-10-15 six malformed tickers
            // (BRKB, BFB, …) each got a Polygon 404 and the note still read
            // "bootstrapped 1Y prices for 10/10 new members".
            if (count === 0) throw new Error('no daily bars returned');
            updated++;
            onProgress({
              jobId: JOB_ID, runId: 0, ticker, status: 'updated',
              attempted, updated, skipped: 0, failed, total: toBootstrap.length,
              message: `bootstrapped ${count} daily bars`,
            });
          } catch (err) {
            failed++;
            onProgress({
              jobId: JOB_ID, runId: 0, ticker, status: 'failed',
              attempted, updated, skipped: 0, failed, total: toBootstrap.length,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        })
      );
      if (!signal.aborted && i + CONCURRENCY < toBootstrap.length) await sleep(BATCH_DELAY);
    }

    if (toBootstrap.length > 0) {
      noteParts.push(`bootstrapped 1Y prices for ${updated}/${toBootstrap.length} new members${failed ? ` (${failed} failed)` : ''}`);
    }

    if (signal.aborted) {
      return {
        status: 'failed', errorMessage: 'Job was cancelled.', notes: noteParts.join(' · '),
        tickersAttempted: attempted, tickersUpdated: updated, tickersSkipped: 0, tickersFailed: failed,
      };
    }

    // A refresh that failed for any index leaves that stored list untouched and still
    // usable, so the chain must continue — but it is NOT a success. Reported as 'warning'
    // (v1.1.246): from ~2026-09-08 both sources failed every run for a week while the
    // Batch view showed green.
    return {
      status: refreshFailures > 0 || sectorFailure ? 'warning' : 'success',
      notes: noteParts.join(' · '),
      tickersAttempted: attempted,
      tickersUpdated:   updated,
      tickersSkipped:   0,
      tickersFailed:    failed + refreshFailures,
    };
  }
}
