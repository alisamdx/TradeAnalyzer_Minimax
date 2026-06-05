// Daily IV Capture job — fetches today's ATM IV from E*Trade for all universe
// tickers and stores it in iv_history. Used to compute IV Rank across the app
// without a paid IV data subscription.
// v0.21.0

import type { DbHandle } from '../../db/connection.js';
import type { ETradeDataProvider } from '../etrade-data-provider.js';
import type { IvHistoryService } from '../iv-history-service.js';
import { isTradingDay } from '../iv-history-service.js';
import type { ConstituentsService } from '../constituents-service.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';

/** 1100ms sleep between E*Trade calls — stays under rate limits. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class DailyIvCaptureJob implements BatchJobHandler {
  readonly name = 'Daily IV Update';
  readonly description =
    "Fetches today's ATM IV from E*Trade for all universe tickers and stores it in iv_history. " +
    'Used to compute IV Rank across the app without a paid IV data subscription.';

  constructor(
    private readonly db: DbHandle,
    private readonly optionsProvider: ETradeDataProvider,
    private readonly ivHistoryService: IvHistoryService,
    private readonly constituentsService: ConstituentsService
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // 1. Skip non-trading days
    if (!isTradingDay(today)) {
      return {
        status: 'skipped',
        notes: 'Non-trading day — nothing to do',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    // 2. Validate E*Trade connectivity. On auth failure, attempt a token renewal
    //    first (covers the "dormant after 2 h inactivity" case). If renewal also
    //    fails, the token has rolled over midnight and needs manual re-auth.
    const isAuthError = (e: unknown): boolean => {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      return msg.includes('401') || msg.includes('token') || msg.includes('auth') || msg.includes('oauth');
    };

    try {
      await this.optionsProvider.getOptionsExpirations('SPY');
    } catch (err) {
      if (!isAuthError(err)) {
        return {
          status: 'failed',
          errorMessage: `E*Trade connectivity check failed: ${err instanceof Error ? err.message : String(err)}`,
          tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
        };
      }

      // Auth failure — try renewing the dormant token before giving up.
      try {
        await this.optionsProvider.renewToken();
        // Verify the renewal actually worked
        await this.optionsProvider.getOptionsExpirations('SPY');
      } catch {
        // Renewal failed too — token has expired past midnight, needs manual re-auth.
        return {
          status: 'failed',
          errorMessage: 'E*Trade token expired. Open the app and go to Settings → E*Trade Connection to reconnect.',
          tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
          notification: {
            id: `etrade-expired-${Date.now()}`,
            type: 'error',
            message: 'E*Trade token expired — Daily IV update skipped.',
            cta: { label: 'Reconnect', view: 'settings' },
          },
        };
      }
    }

    // 4. Gather all unique tickers across universes
    const sp500 = this.constituentsService.getConstituents('sp500').map(r => r.ticker.toUpperCase());
    const russell = this.constituentsService.getConstituents('russell1000').map(r => r.ticker.toUpperCase());
    const etf = this.constituentsService.getConstituents('etf').map(r => r.ticker.toUpperCase());
    const allTickers = [...new Set([...sp500, ...russell, ...etf])];

    // 5. Filter to tickers missing today's iv_history row
    type TickerRow = { ticker: string };
    const alreadyDone = new Set<string>(
      (this.db.prepare(
        `SELECT DISTINCT ticker FROM iv_history WHERE date = ?`
      ).all(today) as TickerRow[]).map(r => r.ticker.toUpperCase())
    );
    const missing = allTickers.filter(t => !alreadyDone.has(t));
    const total = missing.length;

    if (total === 0) {
      return {
        status: 'success',
        notes: 'All tickers already have today\'s IV data.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    let attempted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    // 6. Process each missing ticker
    for (const ticker of missing) {
      if (signal.aborted) break;

      attempted++;

      try {
        // 4a. Get expirations, pick closest to 30 DTE (between 20–45 DTE preferred)
        const expirations = await this.optionsProvider.getOptionsExpirations(ticker);

        if (expirations.length === 0) {
          skipped++;
          onProgress({
            jobId: 'daily-iv-update',
            runId: 0, // will be overwritten by BatchService
            ticker,
            status: 'skipped',
            attempted,
            updated,
            skipped,
            failed,
            total,
            message: 'No expirations available',
          });
          await sleep(1100);
          continue;
        }

        // Pick expiration closest to 30 DTE, preferring 20–45 DTE range
        const nowMs = Date.now();
        const withDte = expirations.map(exp => {
          const expMs = new Date(exp + 'T00:00:00Z').getTime();
          const dte = Math.max(0, Math.round((expMs - nowMs) / 86_400_000));
          return { exp, dte };
        });

        // Prefer range 20-45 DTE, else pick nearest 30 DTE overall
        const inRange = withDte.filter(x => x.dte >= 20 && x.dte <= 45);
        const candidates = inRange.length > 0 ? inRange : withDte;
        const best = candidates.reduce((a, b) =>
          Math.abs(a.dte - 30) <= Math.abs(b.dte - 30) ? a : b
        );
        const expiration = best.exp;

        // 4b. Fetch options chain
        const chain = await this.optionsProvider.getOptionsChain(ticker, expiration);
        const underlyingPx = chain.underlyingPrice;

        // 4c. Capture IV
        this.ivHistoryService.captureFromEtradeChain(ticker, chain.contracts, underlyingPx);

        // 4d. Check if row was actually written
        type IvRow = { atm_iv: number } | undefined;
        const written = this.db.prepare(
          `SELECT atm_iv FROM iv_history WHERE ticker = ? AND date = ?`
        ).get(ticker, today) as IvRow;

        if (written) {
          updated++;
          onProgress({
            jobId: 'daily-iv-update',
            runId: 0,
            ticker,
            status: 'updated',
            attempted,
            updated,
            skipped,
            failed,
            total,
          });
        } else {
          // captureFromEtradeChain returned nothing (insufficient data or existing ivolatility row)
          onProgress({
            jobId: 'daily-iv-update',
            runId: 0,
            ticker,
            status: 'no-data',
            attempted,
            updated,
            skipped,
            failed,
            total,
            message: 'Could not compute ATM IV from chain',
          });
          skipped++;
        }
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        onProgress({
          jobId: 'daily-iv-update',
          runId: 0,
          ticker,
          status: 'failed',
          attempted,
          updated,
          skipped,
          failed,
          total,
          message,
        });
      }

      // 4g. Rate limit
      if (!signal.aborted) await sleep(1100);
    }

    const finalStatus = signal.aborted ? 'failed' : 'success';

    return {
      status: finalStatus,
      notes: `${updated} updated, ${skipped} skipped, ${failed} failed out of ${attempted} attempted.`,
      errorMessage: signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated: updated,
      tickersSkipped: skipped,
      tickersFailed: failed,
    };
  }
}
