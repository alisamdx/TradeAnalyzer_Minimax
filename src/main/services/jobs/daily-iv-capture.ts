// Daily IV Capture job — fetches today's ATM IV from MarketData.app for all
// universe tickers and stores it in iv_history. Used to compute IV Rank across
// the app. Uses a static API key (no OAuth) so the job runs fully unattended.
// v0.22.23

import type { DbHandle } from '../../db/connection.js';
import type { MarketDataProvider } from '../marketdata-provider.js';
import type { IvHistoryService } from '../iv-history-service.js';
import { isTradingDay, computeAtmIv } from '../iv-history-service.js';
import { nearestMonthlyExpFor30Dte } from '../marketdata-provider.js';
import type { ConstituentsService } from '../constituents-service.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class DailyIvCaptureJob implements BatchJobHandler {
  readonly name = 'Daily IV Update';
  readonly description =
    "Fetches today's ATM IV from MarketData.app for all universe tickers and stores " +
    'it in iv_history. Used to compute IV Rank across the app. Runs fully unattended ' +
    '(static API key — no OAuth token expiry).';

  constructor(
    private readonly db: DbHandle,
    private readonly marketdata: MarketDataProvider,
    private readonly ivHistoryService: IvHistoryService,
    private readonly constituentsService: ConstituentsService
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // Skip non-trading days unless forced
    if (!force && !isTradingDay(today)) {
      return {
        status: 'skipped',
        notes: 'Non-trading day — nothing to do',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    // Pick the expiration once for the whole run (nearest monthly 3rd Friday to 30 DTE)
    const expiration = nearestMonthlyExpFor30Dte();

    // Gather all unique tickers across universes
    const sp500   = this.constituentsService.getConstituents('sp500').map(r => r.ticker.toUpperCase());
    const russell = this.constituentsService.getConstituents('russell1000').map(r => r.ticker.toUpperCase());
    const etf     = this.constituentsService.getConstituents('etf').map(r => r.ticker.toUpperCase());
    const allTickers = [...new Set([...sp500, ...russell, ...etf])];

    // Always process all tickers — storeReading uses ON CONFLICT DO UPDATE so each
    // run overwrites with the latest snapshot. Supports multiple intraday runs and
    // ensures the 4:30pm job always writes EOD data even if a mid-day run already ran.
    const missing = allTickers;
    const total = missing.length;

    if (total === 0) {
      return {
        status: 'success',
        notes: 'All tickers already have today\'s IV data.',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    let attempted = 0, updated = 0, skipped = 0, failed = 0;

    for (const ticker of missing) {
      if (signal.aborted) break;
      attempted++;

      try {
        const chain = await this.marketdata.getLiveChain(ticker, expiration);

        if (chain.s === 'no_data' || chain.contracts.length === 0) {
          skipped++;
          onProgress({
            jobId: 'daily-iv-update', runId: 0, ticker, status: 'skipped',
            attempted, updated, skipped, failed, total,
            message: 'No contracts returned',
          });
          await sleep(1100);
          continue;
        }

        const underlyingPx = chain.underlyingPrice;
        if (!underlyingPx) {
          skipped++;
          onProgress({
            jobId: 'daily-iv-update', runId: 0, ticker, status: 'skipped',
            attempted, updated, skipped, failed, total,
            message: 'No underlying price in chain',
          });
          await sleep(1100);
          continue;
        }

        // Map to the shape computeAtmIv expects.
        // MarketData.app iv is a decimal fraction (0.23 = 23%) — multiply by 100
        // so computeAtmIv works in percentage space and the stored value is correct.
        // see docs/formulas.md#atm-iv-storage
        const mapped = chain.contracts.map(c => ({
          expiration: c.expiration,
          strike:     c.strike,
          side:       c.side as 'call' | 'put',
          iv:         c.iv !== null ? c.iv * 100 : null,
          dte:        c.dte,
        }));

        const result = computeAtmIv(mapped, underlyingPx);

        if (!result) {
          skipped++;
          onProgress({
            jobId: 'daily-iv-update', runId: 0, ticker, status: 'skipped',
            attempted, updated, skipped, failed, total,
            message: 'Could not compute ATM IV from chain',
          });
          await sleep(1100);
          continue;
        }

        // Don't overwrite an existing IVolatility reading for today (higher quality)
        type ExRow = { source: string } | undefined;
        const existing = this.db.prepare(
          `SELECT source FROM iv_history WHERE ticker = ? AND date = ?`
        ).get(ticker.toUpperCase(), today) as ExRow;

        if (existing?.source === 'ivolatility') {
          skipped++;
          onProgress({
            jobId: 'daily-iv-update', runId: 0, ticker, status: 'skipped',
            attempted, updated, skipped, failed, total,
            message: 'IVolatility reading already present — skipped',
          });
          await sleep(1100);
          continue;
        }

        this.ivHistoryService.storeReading(ticker, today, result.atmIv, {
          underlyingPx,
          expNear: result.expNear,
          expFar:  result.expFar,
          dteNear: result.dteNear,
          dteFar:  result.dteFar,
          source:  'marketdata',
        });

        updated++;
        onProgress({
          jobId: 'daily-iv-update', runId: 0, ticker, status: 'updated',
          attempted, updated, skipped, failed, total,
        });
      } catch (err) {
        failed++;
        onProgress({
          jobId: 'daily-iv-update', runId: 0, ticker, status: 'failed',
          attempted, updated, skipped, failed, total,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      if (!signal.aborted) await sleep(1100);
    }

    return {
      status: signal.aborted ? 'failed' : 'success',
      notes: `${updated} updated, ${skipped} skipped, ${failed} failed out of ${attempted} attempted.`,
      errorMessage: signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated:   updated,
      tickersSkipped:   skipped,
      tickersFailed:    failed,
    };
  }
}
