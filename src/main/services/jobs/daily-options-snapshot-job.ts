// DailyOptionsSnapshotJob — refreshes Wheel analysis snapshots for screener
// candidates so optionLiquidityScore in the Trade Scoring Engine stays current.
//
// Why this exists
// ───────────────
// ScoringService reads optionLiquidityScore from analysis_snapshots, which is
// only updated when a user manually runs Wheel analysis in the Analysis tab.
// Stale snapshots can score stocks as liquid when the actual OI has dried up.
// This job runs nightly (06:00 ET) so the scoring engine always uses same-day
// liquidity data from the live E*Trade chain.
//
// Scope
// ─────
// Runs analyzeTicker(ticker, 'wheel') only — this is the one mode that makes
// a live E*Trade options chain call. RSI/SMA/trend data is already covered by
// DailyTechnicalSignalsJob which reads from cached historical_prices.
// Runs against the full S&P 500 + Russell 1000 universe (~1,100 tickers) so
// the Daily Brief has options signals for every candidate. At 0.57s/ticker
// (200ms delay + ~370ms E*Trade response) this takes ~10-11 min.

import type { Database } from 'better-sqlite3';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import type { AnalysisService, WheelResult } from '../analysis-service.js';
import type { AnalysisResult } from '../analysis-service.js';
import type { OptionsProvider } from '../options-provider.js';
import { isTradingDay } from '../iv-history-service.js';
import { SCORING_REFERENCE_TICKERS } from './price-gap-fill-job.js';

function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('401') || msg.includes('token') || msg.includes('auth') || msg.includes('oauth');
}

const MAX_TICKERS        = 1_500;  // full universe (~1,100 tickers); at 0.57s/ticker ≈ 10-11 min
const DEFAULT_DELAY_MS   = 1_100;  // safe default — stays under E*Trade rate limit
const MIN_DELAY_MS       =   200;  // hard floor
const MAX_DELAY_MS       = 2_000;  // hard ceiling
const PER_TICKER_TIMEOUT = 30_000; // ms — guards against hung HTTP (e.g. expired E*Trade token)

/** Read callDelayMs from this job's config_json row, clamped to [200, 2000]. */
function readCallDelay(db: import('better-sqlite3').Database): number {
  type Row = { config_json: string | null };
  const row = db.prepare(`SELECT config_json FROM batch_jobs WHERE id = 'daily-options-snapshot'`).get() as Row | undefined;
  if (!row?.config_json) return DEFAULT_DELAY_MS;
  try {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    const v = cfg['callDelayMs'];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(v)));
    }
  } catch { /* ignore */ }
  return DEFAULT_DELAY_MS;
}

function withTimeout<T>(promise: Promise<T>, ms: number, ticker: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s — options provider may be unavailable (${ticker})`)), ms)
    ),
  ]);
}

export class DailyOptionsSnapshotJob implements BatchJobHandler {
  readonly name        = 'Daily Options Snapshot';
  readonly description =
    'Runs Wheel analysis on the top screener candidates to refresh ' +
    'optionLiquidityScore in analysis_snapshots. Keeps the Trade Scoring ' +
    'Engine liquidity data current without waiting for a manual analysis run.';

  constructor(
    private readonly db: Database,
    private readonly analysisService: AnalysisService,
    private readonly optionsProvider: OptionsProvider,
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    if (!force && !isTradingDay(today)) {
      return {
        status: 'skipped', notes: 'Non-trading day',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    const emit = (msg: string, attempted = 0, total = 0) =>
      onProgress({
        jobId: 'daily-options-snapshot', runId: 0, ticker: '', status: 'updated',
        attempted, updated: 0, skipped: 0, failed: 0, total, message: msg,
      });

    // ── Options provider connectivity check ───────────────────────────────────
    // Polygon works unattended; E*Trade tokens expire at midnight ET.
    // A quick probe avoids running 300 tickers only to time out on every one.
    try {
      await this.optionsProvider.getOptionsExpirations('SPY');
    } catch (err) {
      if (isAuthError(err)) {
        return {
          status: 'skipped',
          notes: 'Options provider not connected (E*Trade token expired). Reconnect in Settings → E*Trade Connection.',
          tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
        };
      }
      // Non-auth errors (network blip etc.) — still skip rather than running blind
      return {
        status: 'skipped',
        notes: `Options provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    // ── Load top screener candidates ──────────────────────────────────────────
    emit('Loading screener candidates…');
    const candidates = this.loadTopCandidates(MAX_TICKERS);

    if (candidates.length === 0) {
      return {
        status: 'skipped',
        notes: 'No screener results in cache — run the screener first',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    const callDelayMs = readCallDelay(this.db);
    const estMins = Math.round((candidates.length * callDelayMs) / 60_000);
    emit(`Running Wheel analysis on ${candidates.length} tickers (${callDelayMs}ms delay, ~${estMins}min)…`, 0, candidates.length);

    // ── Wheel analysis loop ───────────────────────────────────────────────────
    const results: WheelResult[] = [];
    let attempted = 0, failed = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (signal.aborted) break;
      const ticker = candidates[i]!;
      attempted++;

      onProgress({
        jobId: 'daily-options-snapshot', runId: 0,
        ticker, status: 'updated',
        attempted, updated: results.length, skipped: 0, failed,
        total: candidates.length,
        message: `Wheel analysis: ${ticker} (${i + 1}/${candidates.length})`,
      });

      try {
        const result = await withTimeout(
          // forceCache=true: reads quote/fundamentals/bars from local DB rather
          // than making 3 extra Polygon API calls per ticker. Market Sync runs
          // earlier in the batch sequence so the caches are already warm.
          this.analysisService.analyzeTicker(ticker, 'wheel', { forceCache: true }) as Promise<AnalysisResult>,
          PER_TICKER_TIMEOUT,
          ticker,
        );
        if (result.mode === 'wheel') {
          results.push(result as WheelResult);
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[options-snapshot] ${ticker} failed:`, msg);
      }

      // Rate-limit E*Trade calls — configurable delay (default 1100ms)
      if (i < candidates.length - 1 && !signal.aborted) {
        await new Promise(r => setTimeout(r, callDelayMs));
      }
    }

    if (signal.aborted) {
      return {
        status: 'failed', errorMessage: 'Cancelled',
        tickersAttempted: attempted, tickersUpdated: results.length, tickersSkipped: 0, tickersFailed: failed,
      };
    }

    // ── Persist snapshot ──────────────────────────────────────────────────────
    emit(`Saving snapshot (${results.length} Wheel results)…`, attempted, candidates.length);

    try {
      this.analysisService.saveGlobalSnapshot('wheel', results as AnalysisResult[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed', errorMessage: `Snapshot save failed: ${msg}`,
        tickersAttempted: attempted, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: failed,
      };
    }

    const notes = [
      `${results.length} Wheel results saved`,
      failed > 0 ? `${failed} failed` : null,
      `${attempted} tickers processed`,
    ].filter(Boolean).join(' | ');

    emit(`Snapshot saved — ${results.length} Wheel results`, attempted, candidates.length);

    return {
      status: 'success',
      notes,
      tickersAttempted: attempted,
      tickersUpdated: results.length,
      tickersSkipped: attempted - results.length - failed,
      tickersFailed: failed,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Load top candidates from the full universe, sorted by options quality. */
  private loadTopCandidates(limit: number): string[] {
    // Sort priority (descending quality for options premium hunting):
    //   1. Tickers WITH iv_history data first (nulls last)
    //   2. Most recent atm_iv DESC — high IV = rich premium
    //   3. buy_signal_score DESC — strong technicals as tiebreaker
    //   4. Alphabetical as final tiebreaker
    // This ensures the 300-ticker cap covers the most actionable candidates,
    // not just the first 300 alphabetically (the regression introduced in v0.24.4).
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      WITH latest_iv AS (
        SELECT ticker, atm_iv
        FROM iv_history
        WHERE (ticker, date) IN (
          SELECT ticker, MAX(date) FROM iv_history GROUP BY ticker
        )
      )
      SELECT DISTINCT c.ticker
      FROM constituents c
      LEFT JOIN latest_iv iv  ON iv.ticker  = c.ticker
      LEFT JOIN technical_signals ts ON ts.ticker = c.ticker
      WHERE c.index_name IN ('sp500', 'russell1000')
      ORDER BY
        CASE WHEN iv.atm_iv IS NULL THEN 1 ELSE 0 END ASC,
        COALESCE(iv.atm_iv, 0)            DESC,
        COALESCE(ts.buy_signal_score, 0)  DESC,
        c.ticker                          ASC
      LIMIT ?
    `).all(limit) as Row[];

    // Exclude scoring reference tickers (SPY + sector ETFs) — infrastructure only.
    const refSet = new Set<string>(SCORING_REFERENCE_TICKERS);
    return rows.map(r => r.ticker).filter(t => !refSet.has(t));
  }
}
