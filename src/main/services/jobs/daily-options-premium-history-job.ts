// DailyOptionsPremiumHistoryJob — captures a daily, query-friendly snapshot of the
// recommended option structure (strike, expiry, premium, delta, IV) per ticker for
// premium-based strategies into the options_premium_history table.
//
// Why this exists
// ───────────────
// analysis_snapshots stores the wheel result as a JSON blob and is overwritten in
// spirit (only the latest ~20 are read); income/wheel premium has no durable, queryable
// time series. Without this, a year from now we still couldn't compute TRUE income/wheel
// return-on-capital — only the stayed-above-strike proxy used by Brief Replay. This job
// accumulates one row per (date, ticker, strategy), NEVER pruned.
//
// Data sourcing (efficient — avoids double-fetching the chain)
// ────────────────────────────────────────────────────────────
//   • Wheel  — read from TODAY's wheel global snapshot that DailyOptionsSnapshotJob
//              already produced earlier in the batch sequence (zero extra E*Trade calls).
//   • Income — fetched live via analyzeTicker('options_income') (the genuinely-missing
//              data; the snapshot job does not compute it).
// Registered LAST in the batch sequence so the wheel snapshot is already fresh.

import type { Database } from 'better-sqlite3';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import type { AnalysisService, AnalysisResult, WheelResult, OptionsIncomeResult } from '../analysis-service.js';
import type { OptionsProvider } from '../options-provider.js';
import { withTransaction } from '../../db/connection.js';
import { isTradingDay } from '../iv-history-service.js';
import { SCORING_REFERENCE_TICKERS } from './price-gap-fill-job.js';

function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('401') || msg.includes('token') || msg.includes('auth') || msg.includes('oauth');
}

const MAX_TICKERS      = 1_500;  // full S&P 500 + Russell 1000 universe (~1,100)
const DEFAULT_DELAY_MS = 1_100;  // safe default — stays under E*Trade rate limit
const MIN_DELAY_MS     =   200;
const MAX_DELAY_MS     = 2_000;
const PER_TICKER_TIMEOUT = 30_000;

/** A single options_premium_history row (sans id/captured_at). */
export interface PremiumHistoryRow {
  asOfDate: string;
  ticker: string;
  strategy: 'wheel' | 'income';
  structure: string | null;
  lastPrice: number | null;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  delta: number | null;
  bid: number | null;
  ask: number | null;
  premium: number | null;
  annualizedReturn: number | null;
  iv: number | null;
  ivRank: number | null;
  openInterest: number | null;
  volume: number | null;
  breakeven: number | null;
}

/** Map a WheelResult (recommended CSP or CC) to a history row. Pure — unit-tested. */
export function wheelResultToRow(r: WheelResult, asOfDate: string): PremiumHistoryRow {
  // A wheel rec is a cash-secured put unless findSuitableChain found no suitable
  // put and fell back to a covered call (analysis-service findSuitableChain). The
  // contract's put/call side isn't carried on WheelResult, but delta sign is a
  // robust proxy: puts are ≤0, calls >0 (sign survives E*Trade stale-greek drift,
  // which only skews magnitude). findSuitableChain guarantees a non-null delta on
  // any real recommendation. see docs/formulas.md#wheel-structure-label
  const structure: 'CSP' | 'CC' = r.delta != null && r.delta > 0 ? 'CC' : 'CSP';
  return {
    asOfDate, ticker: r.ticker, strategy: 'wheel', structure,
    lastPrice: r.lastPrice, strike: r.recommendedStrike, expiration: r.expiration,
    dte: r.dte, delta: r.delta, bid: r.bid, ask: r.ask, premium: r.premium,
    annualizedReturn: r.annualizedReturn, iv: r.currentIv, ivRank: r.ivRank,
    openInterest: r.openInterest, volume: r.volume, breakeven: null,
  };
}

/** Map an OptionsIncomeResult (CSP/CC) to a history row. Pure — unit-tested. */
export function incomeResultToRow(r: OptionsIncomeResult, asOfDate: string): PremiumHistoryRow {
  return {
    asOfDate, ticker: r.ticker, strategy: 'income', structure: r.strategy,
    lastPrice: r.lastPrice, strike: r.strike, expiration: r.expiration,
    dte: r.dte, delta: r.delta, bid: r.bid, ask: r.ask, premium: r.premium,
    annualizedReturn: r.annualizedReturn, iv: null, ivRank: r.ivRank,
    openInterest: r.openInterest, volume: r.volume, breakeven: r.breakeven,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, ticker: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms / 1000}s (${ticker})`)), ms)
    ),
  ]);
}

interface JobConfig {
  callDelayMs: number;
  maxTickers: number;
  captureWheel: boolean;
  captureIncome: boolean;
}

export class DailyOptionsPremiumHistoryJob implements BatchJobHandler {
  readonly name        = 'Daily Options Premium History';
  readonly description =
    'Captures the recommended option structure (strike, expiry, premium, delta, IV) ' +
    'per ticker per trading day for premium-based strategies — wheel CSP (reused from ' +
    "the day's options snapshot) + income CSP/CC (fetched live) — into " +
    'options_premium_history for long-term return-on-capital analysis. Never pruned.';

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
    const zero = { tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 };

    if (!force && !isTradingDay(today)) {
      return { status: 'skipped', notes: 'Non-trading day', ...zero };
    }

    const emit = (msg: string, attempted = 0, total = 0) =>
      onProgress({
        jobId: 'daily-options-premium-history', runId: 0, ticker: '', status: 'updated',
        attempted, updated: 0, skipped: 0, failed: 0, total, message: msg,
      });

    const cfg = this.readConfig();

    // ── E*Trade connectivity probe (income needs live chains) ─────────────────
    if (cfg.captureIncome) {
      try {
        await this.optionsProvider.getOptionsExpirations('SPY');
      } catch (err) {
        if (isAuthError(err)) {
          return { status: 'skipped', notes: 'Options provider not connected (E*Trade token expired). Reconnect in Settings → E*Trade Connection.', ...zero };
        }
        return { status: 'skipped', notes: `Options provider unavailable: ${err instanceof Error ? err.message : String(err)}`, ...zero };
      }
    }

    const rows: PremiumHistoryRow[] = [];
    let attempted = 0, failed = 0;

    // ── Wheel: reuse today's wheel global snapshot (no extra E*Trade calls) ────
    let wheelNote = '';
    if (cfg.captureWheel) {
      const wheelResults = this.loadTodayWheelSnapshot(today);
      if (wheelResults === null) {
        wheelNote = 'wheel skipped (no same-day snapshot)';
      } else {
        for (const w of wheelResults) {
          if (w.recommendedStrike != null && w.premium != null) rows.push(wheelResultToRow(w, today));
        }
        wheelNote = `${rows.length} wheel`;
      }
    }

    // ── Income: fetch live (the genuinely-missing premium data) ────────────────
    if (cfg.captureIncome) {
      const candidates = this.loadTopCandidates(cfg.maxTickers);
      if (candidates.length === 0) {
        return { status: 'skipped', notes: 'No constituents available — run the screener first', ...zero };
      }
      const estMins = Math.round((candidates.length * cfg.callDelayMs) / 60_000);
      emit(`Capturing income premium on ${candidates.length} tickers (${cfg.callDelayMs}ms, ~${estMins}min)…`, 0, candidates.length);

      for (let i = 0; i < candidates.length; i++) {
        if (signal.aborted) break;
        const ticker = candidates[i]!;
        attempted++;
        onProgress({
          jobId: 'daily-options-premium-history', runId: 0, ticker, status: 'updated',
          attempted, updated: rows.length, skipped: 0, failed, total: candidates.length,
          message: `Income premium: ${ticker} (${i + 1}/${candidates.length})`,
        });

        try {
          const result = await withTimeout(
            this.analysisService.analyzeTicker(ticker, 'options_income', { forceCache: true }) as Promise<AnalysisResult>,
            PER_TICKER_TIMEOUT, ticker,
          );
          if (result.mode === 'options_income' && result.strike != null && result.premium != null) {
            rows.push(incomeResultToRow(result, today));
          }
        } catch (err) {
          failed++;
          console.warn(`[premium-history] ${ticker} income failed:`, err instanceof Error ? err.message : String(err));
        }

        if (i < candidates.length - 1 && !signal.aborted) {
          await new Promise(r => setTimeout(r, cfg.callDelayMs));
        }
      }
    }

    if (signal.aborted) {
      // Persist whatever we captured before cancellation.
      this.persist(rows);
      return { status: 'failed', errorMessage: 'Cancelled', tickersAttempted: attempted, tickersUpdated: rows.length, tickersSkipped: 0, tickersFailed: failed };
    }

    // ── Persist ────────────────────────────────────────────────────────────────
    emit(`Saving ${rows.length} premium rows…`, attempted, attempted);
    try {
      this.persist(rows);
    } catch (err) {
      return { status: 'failed', errorMessage: `Save failed: ${err instanceof Error ? err.message : String(err)}`, tickersAttempted: attempted, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: failed };
    }

    const incomeCount = rows.filter(r => r.strategy === 'income').length;
    const notes = [wheelNote, `${incomeCount} income`, failed > 0 ? `${failed} failed` : null]
      .filter(Boolean).join(' | ');
    emit(`Saved ${rows.length} premium rows`, attempted, attempted);

    return {
      status: 'success', notes,
      tickersAttempted: attempted,
      tickersUpdated: rows.length,
      tickersSkipped: 0,
      tickersFailed: failed,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private readConfig(): JobConfig {
    const fallback: JobConfig = { callDelayMs: DEFAULT_DELAY_MS, maxTickers: MAX_TICKERS, captureWheel: true, captureIncome: true };
    type Row = { config_json: string | null };
    const row = this.db.prepare(`SELECT config_json FROM batch_jobs WHERE id = 'daily-options-premium-history'`).get() as Row | undefined;
    if (!row?.config_json) return fallback;
    try {
      const c = JSON.parse(row.config_json) as Record<string, unknown>;
      const delay = typeof c['callDelayMs'] === 'number' && Number.isFinite(c['callDelayMs'])
        ? Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(c['callDelayMs'] as number)))
        : DEFAULT_DELAY_MS;
      const max = typeof c['maxTickers'] === 'number' && Number.isFinite(c['maxTickers'])
        ? Math.max(1, Math.round(c['maxTickers'] as number)) : MAX_TICKERS;
      return {
        callDelayMs: delay,
        maxTickers: max,
        captureWheel: c['captureWheel'] !== false,
        captureIncome: c['captureIncome'] !== false,
      };
    } catch {
      return fallback;
    }
  }

  /** Latest global wheel snapshot, but only if it was produced TODAY (ET). Else null. */
  private loadTodayWheelSnapshot(today: string): WheelResult[] | null {
    type Row = { run_at: string; payload_json: string };
    const row = this.db.prepare(`
      SELECT run_at, payload_json FROM analysis_snapshots
      WHERE watchlist_id IS NULL AND mode = 'wheel'
      ORDER BY id DESC LIMIT 1
    `).get() as Row | undefined;
    if (!row) return null;

    const runEtDate = new Date(row.run_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (runEtDate !== today) return null; // stale — snapshot job didn't run today

    try {
      const parsed = JSON.parse(row.payload_json) as { results?: WheelResult[] } | WheelResult[];
      const results = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
      return results.filter(r => r && r.mode === 'wheel');
    } catch {
      return null;
    }
  }

  private persist(rows: PremiumHistoryRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO options_premium_history
        (as_of_date, ticker, strategy, structure, last_price, strike, expiration, dte,
         delta, bid, ask, premium, annualized_return, iv, iv_rank, open_interest, volume, breakeven)
      VALUES (@asOfDate, @ticker, @strategy, @structure, @lastPrice, @strike, @expiration, @dte,
              @delta, @bid, @ask, @premium, @annualizedReturn, @iv, @ivRank, @openInterest, @volume, @breakeven)
    `);
    withTransaction(this.db, () => {
      for (const r of rows) stmt.run(r);
    });
  }

  /** Full S&P 500 + Russell 1000 universe, highest-IV first (mirrors the snapshot job). */
  private loadTopCandidates(limit: number): string[] {
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      WITH latest_iv AS (
        SELECT ticker, atm_iv FROM iv_history
        WHERE (ticker, date) IN (SELECT ticker, MAX(date) FROM iv_history GROUP BY ticker)
      )
      SELECT DISTINCT c.ticker
      FROM constituents c
      LEFT JOIN latest_iv iv ON iv.ticker = c.ticker
      LEFT JOIN technical_signals ts ON ts.ticker = c.ticker
      WHERE c.index_name IN ('sp500', 'russell1000')
      ORDER BY
        CASE WHEN iv.atm_iv IS NULL THEN 1 ELSE 0 END ASC,
        COALESCE(iv.atm_iv, 0) DESC,
        COALESCE(ts.buy_signal_score, 0) DESC,
        c.ticker ASC
      LIMIT ?
    `).all(limit) as Row[];
    const refSet = new Set<string>(SCORING_REFERENCE_TICKERS);
    return rows.map(r => r.ticker).filter(t => !refSet.has(t));
  }
}
