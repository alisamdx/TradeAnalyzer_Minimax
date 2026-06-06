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

// ETF-appropriate filter set for soft-mode screening.
// ETFs lack fundamental data (P/E, ROE, etc.) so we only check liquidity + price.
// FilterDef.value shape mirrors what evaluateTicker reads: { min, max, enabled }.
const ETF_FILTERS: ScreenCriteria['filters'] = [
  { id: 'avg_volume', enabled: true, value: { min: 500_000 } },
  { id: 'price',      enabled: true, value: { min: 10 } },
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

    let attempted = 0;
    let updated   = 0;
    let skipped   = 0;
    let failed    = 0;

    // ── Pass 1: S&P 500 + Russell 1000, strict mode ────────────────────────
    try {
      const stockCriteria = this.buildStockCriteria();

      onProgress({
        jobId: 'daily-screener', runId: 0, ticker: '',
        status: 'updated', attempted, updated, skipped, failed, total: 0,
        message: `Pass 1/2: Screening S&P 500 + Russell 1000 (strict, ${stockCriteria.filters.filter(f => f.enabled).length} filters)…`,
      });

      const stockResult = await this.screenerService.runScreen(
        stockCriteria,
        (scanned, total, ticker) => {
          if (signal.aborted) return;
          attempted = scanned;
          updated   = scanned; // all evaluated rows count as processed
          onProgress({
            jobId: 'daily-screener', runId: 0,
            ticker: ticker ?? '',
            status: 'updated',
            attempted: scanned, updated: scanned, skipped, failed, total,
            message: ticker ? `Stocks: ${ticker}` : undefined,
          });
        },
        () => signal.aborted
      );

      if (!signal.aborted) {
        this.screenerService.saveRun(stockCriteria, 'both', stockResult.rows, null, 'Daily Screener — Stocks');
        updated = stockResult.passed;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'updated', attempted, updated, skipped, failed, total: stockResult.scanned,
          message: `Pass 1 done: ${stockResult.passed} passed / ${stockResult.scanned} scanned`,
        });
      }
    } catch (err) {
      if (!signal.aborted) {
        failed++;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'failed', attempted, updated, skipped: skipped + 1, failed, total: 0,
          message: `Pass 1 failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Non-fatal — still attempt ETF pass
      }
    }

    if (signal.aborted) {
      return {
        status: 'failed', errorMessage: 'Cancelled',
        tickersAttempted: attempted, tickersUpdated: updated, tickersSkipped: skipped, tickersFailed: failed,
      };
    }

    // ── Pass 2: ETFs, soft mode ────────────────────────────────────────────
    try {
      const etfCriteria: ScreenCriteria = {
        universe: 'etf',
        mode: 'soft',
        filters: ETF_FILTERS,
      };

      const etfBaseAttempted = attempted;

      onProgress({
        jobId: 'daily-screener', runId: 0, ticker: '',
        status: 'updated', attempted, updated, skipped, failed, total: 0,
        message: 'Pass 2/2: Screening ETFs (soft, volume + price)…',
      });

      const etfResult = await this.screenerService.runScreen(
        etfCriteria,
        (scanned, total, ticker) => {
          if (signal.aborted) return;
          onProgress({
            jobId: 'daily-screener', runId: 0,
            ticker: ticker ?? '',
            status: 'updated',
            attempted: etfBaseAttempted + scanned,
            updated, skipped, failed, total: etfBaseAttempted + total,
            message: ticker ? `ETFs: ${ticker}` : undefined,
          });
        },
        () => signal.aborted
      );

      if (!signal.aborted) {
        this.screenerService.saveRun(etfCriteria, 'etf', etfResult.rows, null, 'Daily Screener — ETFs');
        attempted += etfResult.scanned;
        skipped   += (etfResult.scanned - etfResult.passed);
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'updated', attempted, updated, skipped, failed, total: attempted,
          message: `Pass 2 done: ${etfResult.passed} passed / ${etfResult.scanned} ETFs scanned`,
        });
      }
    } catch (err) {
      if (!signal.aborted) {
        failed++;
        onProgress({
          jobId: 'daily-screener', runId: 0, ticker: '',
          status: 'failed', attempted, updated, skipped, failed, total: 0,
          message: `Pass 2 failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const finalStatus = signal.aborted ? 'failed' : (failed > 0 ? 'failed' : 'success');

    return {
      status: finalStatus,
      notes: `Stocks + ETFs screened. ${updated} stocks passed strict filters; ${attempted} total evaluated.`,
      errorMessage: signal.aborted ? 'Job was cancelled.' : undefined,
      tickersAttempted: attempted,
      tickersUpdated:   updated,
      tickersSkipped:   skipped,
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
