// Daily Screener batch job — re-runs the screener after Market Sync so that
// screen_results is always fresh when the Daily Brief and Options Snapshot run.
//
// Runs TWO passes in sequence and saves each as its own screen_run row:
//   Pass 1: universe='both' (S&P 500 + Russell 1000), mode='strict'
//           Uses the user's saved default preset filters; falls back to
//           DEFAULT_FILTER_SPECS enabled defaults if no preset is saved.
//   Pass 2: universe='etf', mode='soft'
//           Uses ETF-appropriate filters: avg_volume ≥ 500 k and price ≥ 10.
//           Soft mode means a ticker passes if it meets at least one filter.
//
// Downstream consumers (DailyIntelligenceBriefJob, DailyOptionsSnapshotJob)
// read ALL screen_runs created on today's ET date, so both passes feed into
// the candidate pool automatically.

import type { DbHandle } from '../../db/connection.js';
import type { ScreenerService } from '../screener-service.js';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent, ScreenCriteria } from '@shared/types.js';
import { DEFAULT_FILTER_SPECS } from '@shared/screener-filters.js';
import { isTradingDay } from '../iv-history-service.js';

// ETF filter — soft mode with a single very permissive price floor (≥ $1).
// In soft mode a ticker passes if it meets AT LEAST ONE enabled filter.
// Using min: 1 means any ETF with a non-null price passes, regardless of whether
// quote_cache has volume data. Our ETF list is 61 curated major names (SPY,
// QQQ, IWM, etc.) so there is no need to aggressively filter them out — the
// scoring engine handles weighting when they run through the Daily Brief.
const ETF_FILTERS: ScreenCriteria['filters'] = [
  { id: 'price', enabled: true, value: { min: 1 } },
];

export class DailyScreenerJob implements BatchJobHandler {
  readonly name = 'Daily Screener';
  readonly description =
    'Re-runs the stock screener after Market Sync so the Daily Brief always works from ' +
    "today's fresh data. Pass 1: S&P 500 + Russell 1000 strict (default preset). " +
    'Pass 2: ETFs soft (volume + price).';

  constructor(
    private readonly db: DbHandle,
    private readonly screenerService: ScreenerService
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    if (!isTradingDay(today)) {
      return {
        status: 'skipped',
        notes: 'Non-trading day — nothing to do',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    // Track each pass separately for clear reporting.
    let stockScanned = 0;
    let stockPassed  = 0;
    let etfScanned   = 0;
    let etfPassed    = 0;
    let failed       = 0;

    // ── Pass 1: S&P 500 + Russell 1000, strict mode ────────────────────────
    try {
      const stockCriteria = this.buildStockCriteria();
      const enabledCount = stockCriteria.filters.filter(f => f.enabled).length;

      onProgress({
        jobId: 'daily-screener', runId: 0, ticker: '',
        status: 'updated', attempted: 0, updated: 0, skipped: 0, failed, total: 0,
        message: `Pass 1/2: Screening S&P 500 + Russell 1000 (strict, ${enabledCount} filters)…`,
      });

      const stockResult = await this.screenerService.runScreen(
        stockCriteria,
        (scanned, total, ticker) => {
          if (signal.aborted) return;
          onProgress({
            jobId: 'daily-screener', runId: 0,
            ticker: ticker ?? '',
            status: 'updated',
            attempted: scanned, updated: 0, skipped: 0, failed, total,
            message: ticker ? `Stocks: ${ticker}` : undefined,
          });
        },
        () => signal.aborted
      );

      if (!signal.aborted) {
        this.screenerService.saveRun(stockCriteria, 'both', stockResult.rows, null, 'Daily Screener — Stocks');
        stockScanned = stockResult.scanned;
        stockPassed  = stockResult.passed;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'updated',
          attempted: stockScanned, updated: stockPassed, skipped: stockScanned - stockPassed, failed,
          total: stockScanned,
          message: `Pass 1 done: ${stockPassed} stocks passed / ${stockScanned} scanned`,
        });
      }
    } catch (err) {
      if (!signal.aborted) {
        failed++;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'failed', attempted: 0, updated: 0, skipped: 0, failed, total: 0,
          message: `Pass 1 failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (signal.aborted) {
      return {
        status: 'failed', errorMessage: 'Cancelled',
        tickersAttempted: stockScanned, tickersUpdated: stockPassed,
        tickersSkipped: stockScanned - stockPassed, tickersFailed: failed,
      };
    }

    // ── Pass 2: ETFs, soft mode ────────────────────────────────────────────
    // Uses a single permissive price ≥ $1 filter in soft mode so any ETF
    // with quote_cache data passes.  Our ETF list is 61 curated major names
    // — no aggressive gating needed; the scoring engine handles ranking.
    try {
      const etfCriteria: ScreenCriteria = {
        universe: 'etf',
        mode: 'soft',
        filters: ETF_FILTERS,
      };

      onProgress({
        jobId: 'daily-screener', runId: 0, ticker: '',
        status: 'updated',
        attempted: stockScanned, updated: stockPassed, skipped: stockScanned - stockPassed, failed,
        total: stockScanned,
        message: 'Pass 2/2: Screening ETFs (soft, price ≥ $1)…',
      });

      const etfResult = await this.screenerService.runScreen(
        etfCriteria,
        (scanned, total, ticker) => {
          if (signal.aborted) return;
          onProgress({
            jobId: 'daily-screener', runId: 0,
            ticker: ticker ?? '',
            status: 'updated',
            attempted: stockScanned + scanned,
            updated: stockPassed, skipped: stockScanned - stockPassed, failed,
            total: stockScanned + total,
            message: ticker ? `ETFs: ${ticker}` : undefined,
          });
        },
        () => signal.aborted
      );

      if (!signal.aborted) {
        this.screenerService.saveRun(etfCriteria, 'etf', etfResult.rows, null, 'Daily Screener — ETFs');
        etfScanned = etfResult.scanned;
        etfPassed  = etfResult.passed;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'updated',
          attempted: stockScanned + etfScanned,
          updated: stockPassed + etfPassed,
          skipped: (stockScanned - stockPassed) + (etfScanned - etfPassed),
          failed,
          total: stockScanned + etfScanned,
          message: `Pass 2 done: ${etfPassed} ETFs passed / ${etfScanned} scanned`,
        });
      }
    } catch (err) {
      if (!signal.aborted) {
        failed++;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'failed',
          attempted: stockScanned, updated: stockPassed, skipped: stockScanned - stockPassed, failed,
          total: stockScanned,
          message: `Pass 2 failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const totalAttempted = stockScanned + etfScanned;
    const totalPassed    = stockPassed  + etfPassed;
    const totalSkipped   = totalAttempted - totalPassed;
    const finalStatus    = signal.aborted ? 'failed' : (failed > 0 ? 'failed' : 'success');

    return {
      status: finalStatus,
      notes: `Pass 1: ${stockPassed} stocks passed strict (${stockScanned} scanned). Pass 2: ${etfPassed} ETFs passed soft (${etfScanned} scanned).`,
      errorMessage: signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: totalAttempted,
      tickersUpdated:   totalPassed,
      tickersSkipped:   totalSkipped,
      tickersFailed:    failed,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Build the stock screening criteria. Uses the user's saved default preset
   * if one exists; falls back to the DEFAULT_FILTER_SPECS enabled defaults.
   */
  private buildStockCriteria(): ScreenCriteria {
    type PresetRow = { criteria_json: string };
    const defaultPreset = this.db.prepare(
      `SELECT criteria_json FROM screen_presets WHERE is_default = 1 LIMIT 1`
    ).get() as PresetRow | undefined;

    if (defaultPreset) {
      return JSON.parse(defaultPreset.criteria_json) as ScreenCriteria;
    }

    // No saved default — use the built-in filter spec defaults (strict, enabled filters only)
    return {
      universe: 'both',
      mode: 'strict',
      filters: DEFAULT_FILTER_SPECS
        .filter(f => f.defaultEnabled)
        .map(f => ({
          id:      f.id,
          enabled: true,
          value: {
            min: f.defaultMin,
            ...(f.defaultMax !== Infinity ? { max: f.defaultMax } : {}),
          },
        })),
    };
  }
}
