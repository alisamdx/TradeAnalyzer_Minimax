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
// Capped at MAX_TICKERS (top candidates by screener pass-score) so the job
// completes in ≤ 10 minutes even for large universes.

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

const MAX_TICKERS      = 300;    // cap to keep runtime ≤ ~10 min
const ETRADE_DELAY     = 1_100;  // ms between chain calls (rate limit)
const PER_TICKER_TIMEOUT = 30_000; // ms — guards against hung HTTP (e.g. expired E*Trade token)

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

    emit(`Running Wheel analysis on ${candidates.length} tickers…`, 0, candidates.length);

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
          this.analysisService.analyzeTicker(ticker, 'wheel') as Promise<AnalysisResult>,
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

      // Rate-limit E*Trade calls — ~1.1 s gap between tickers
      if (i < candidates.length - 1 && !signal.aborted) {
        await new Promise(r => setTimeout(r, ETRADE_DELAY));
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

  /** Load top screener candidates sorted by pass-score descending. */
  private loadTopCandidates(limit: number): string[] {
    // Prefer all screen_runs created today (ET) — captures both the stocks run
    // and ETF run written by DailyScreenerJob.  Falls back to the single most-
    // recent run when no today-runs exist.
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    type RunRow = { id: number };

    let runIds: number[] = (this.db.prepare(`
      SELECT id FROM screen_runs
      WHERE substr(run_at, 1, 10) = ?
      ORDER BY id ASC
    `).all(todayET) as RunRow[]).map(r => r.id);

    if (runIds.length === 0) {
      const latestRun = this.db.prepare(
        'SELECT id FROM screen_runs ORDER BY id DESC LIMIT 1'
      ).get() as RunRow | undefined;
      if (!latestRun) return [];
      runIds = [latestRun.id];
    }

    type SRow = { ticker: string; payload_json: string };
    const ph = runIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT ticker, payload_json
      FROM screen_results
      WHERE screen_run_id IN (${ph})
      ORDER BY ticker ASC
    `).all(...runIds) as SRow[];

    // Exclude scoring reference tickers (SPY + sector ETFs) — infrastructure only.
    const refSet = new Set<string>(SCORING_REFERENCE_TICKERS);

    const best = new Map<string, number>(); // ticker → best passScore
    for (const row of rows) {
      const p = JSON.parse(row.payload_json) as { passScore?: number };
      const score = p.passScore ?? 0;
      if (score > 0 && !refSet.has(row.ticker)) {
        const prev = best.get(row.ticker) ?? -1;
        if (score > prev) best.set(row.ticker, score);
      }
    }

    return [...best.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([ticker]) => ticker);
  }
}
