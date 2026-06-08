// EarningsRefreshJob — batch job that refreshes upcoming earnings dates for the full
// S&P 500 + Russell 1000 universe (unique tickers from the constituents table).
//
// Two-phase approach:
//   Phase 1 (Finnhub, optional): one bulk API call for a 90-day window → pre-fills
//     earnings_calendar for every ticker in the response. Covers tickers that
//     E*Trade's per-ticker API silently drops (e.g. ABNB, ADBE). Source='finnhub',
//     confirmed=false. Key stored in secure settings as 'finnhubApiKey'.
//   Phase 2 (E*Trade): delta loop — only tickers still missing a future date after
//     Phase 1. E*Trade results overwrite Finnhub entries and mark confirmed=true.
//
// Manual entries are never overwritten. Delta filter applied before both phases.
// v0.32.28

import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent } from '@shared/types.js';
import type { EarningsService } from '../earnings-service.js';
import type { OAuthCredentials } from '../etrade-auth.js';
import type { DbHandle } from '../../db/connection.js';
import { secureGet } from '../secure-settings.js';

const JOB_ID = 'earnings-refresh';
const DEFAULT_CALL_DELAY_MS = 500; // conservative default — avoids E*Trade 429s
const MIN_CALL_DELAY_MS = 0;       // 0 = no artificial delay; E*Trade API ~250ms natural rate
const MAX_CALL_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readCallDelay(db: DbHandle): number {
  type Row = { config_json: string | null };
  const row = db.prepare(`SELECT config_json FROM batch_jobs WHERE id = ?`).get(JOB_ID) as Row | undefined;
  if (!row?.config_json) return DEFAULT_CALL_DELAY_MS;
  try {
    const cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    const v = cfg['callDelayMs'];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return Math.max(MIN_CALL_DELAY_MS, Math.min(MAX_CALL_DELAY_MS, Math.round(v)));
    }
  } catch { /* ignore */ }
  return DEFAULT_CALL_DELAY_MS;
}

export class EarningsRefreshJob implements BatchJobHandler {
  readonly name = 'Earnings Refresh';
  readonly description =
    'Phase 1: Finnhub bulk fetch (1 API call, 90-day window) pre-fills earnings dates for ' +
    'the full universe including tickers E*Trade API misses. ' +
    'Phase 2: E*Trade delta loop for tickers still missing a future date — overwrites Finnhub ' +
    'entries with confirmed dates. Manual entries never overwritten.';

  constructor(
    private readonly db: DbHandle,
    private readonly earningsService: EarningsService,
    private readonly getCreds: () => OAuthCredentials | null,
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
  ): Promise<BatchJobResult> {
    const callDelayMs = readCallDelay(this.db);

    // Full S&P 500 + Russell 1000 universe — unique tickers only
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM constituents ORDER BY ticker
    `).all() as Row[];

    const tickers = rows.map(r => r.ticker);

    if (tickers.length === 0) {
      return {
        status: 'skipped',
        notes: 'No constituents loaded. Run a Data Sync first.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    const creds = this.getCreds();

    if (!creds?.accessToken) {
      return {
        status: 'skipped',
        notes: 'E*Trade not connected — reconnect in Settings to fetch earnings dates.',
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: 0,
        tickersFailed: 0,
      };
    }

    // ── Phase 1: Finnhub bulk pre-fill ──────────────────────────────────────
    // One API call for the next 90 days fills earnings_calendar for all tickers
    // the Finnhub response covers, including tickers E*Trade's API silently drops.
    // E*Trade will overwrite these in Phase 2 when it has a confirmed date.
    const finnhubKey = secureGet(this.db, 'finnhubApiKey');
    let finnhubFilled = 0;
    let finnhubErrors = 0;
    if (finnhubKey) {
      try {
        const todayIso  = new Date().toISOString().slice(0, 10);
        const ninetyOut = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
        const url = `https://finnhub.io/api/v1/calendar/earnings?from=${todayIso}&to=${ninetyOut}&token=${finnhubKey}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const json = await resp.json() as { earningsCalendar?: FinnhubEntry[] };
          const entries = json.earningsCalendar ?? [];
          for (const e of entries) {
            if (!e.symbol || !e.date) continue;
            // Only store if the ticker is in our universe and not already a manual entry
            const existing = this.earningsService.getForTicker(e.symbol);
            if (existing?.source === 'manual') continue;
            // Map Finnhub hour to our report_time
            const reportTime: 'bmo' | 'amc' | null =
              e.hour === 'bmo' ? 'bmo' : e.hour === 'amc' ? 'amc' : null;
            this.earningsService.upsertFromProvider(e.symbol, e.date, reportTime, 'finnhub', false);
            finnhubFilled++;
          }
        } else {
          finnhubErrors++;
        }
      } catch {
        finnhubErrors++;
      }
    }

    onProgress({
      jobId: JOB_ID, runId: 0, ticker: '',
      status: finnhubKey ? 'updated' : 'skipped',
      attempted: 0, updated: finnhubFilled, skipped: 0, failed: finnhubErrors,
      total: tickers.length,
      message: finnhubKey
        ? `Finnhub pre-fill: ${finnhubFilled} entries stored`
        : 'Finnhub key not configured — skipping Phase 1',
    });

    // ── Phase 2: E*Trade delta loop ──────────────────────────────────────────
    // Delta filter: only fetch tickers that have no stored date, or whose stored date
    // is today/past (earnings occurred → need the next cycle date).
    // Manual entries are never overwritten — excluded here, not just in refreshTickers.
    // Note: the `force` flag bypasses non-trading-day guards in other jobs but should NOT
    // bypass this delta filter — use the Earnings Calendar's own "Force Refresh" button
    // if you want to re-fetch all dates regardless of cache.
    const todayStr = new Date().toISOString().slice(0, 10);
    type DeltaRow = { ticker: string };
    const deltaRows = this.db.prepare(`
      SELECT DISTINCT c.ticker
      FROM constituents c
      LEFT JOIN earnings_calendar ec ON ec.ticker = c.ticker
      WHERE ec.ticker IS NULL
         OR (ec.source != 'manual' AND ec.report_date <= ?)
      ORDER BY c.ticker
    `).all(todayStr) as DeltaRow[];

    const deltaCount = deltaRows.length;
    const cachedCount = tickers.length - deltaCount;

    if (deltaCount === 0) {
      return {
        status: 'skipped',
        notes: `All ${tickers.length} tickers already have future dates cached — nothing to refresh`,
        tickersAttempted: 0,
        tickersUpdated: 0,
        tickersSkipped: tickers.length,
        tickersFailed: 0,
      };
    }

    let attempted = 0, updated = 0, skipped = 0, failed = 0;

    for (const { ticker } of deltaRows) {
      if (signal.aborted) break;

      attempted++;

      try {
        const result = await this.earningsService.refreshTickers([ticker], creds, force);

        if (result.updated > 0) {
          updated++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'updated',
            attempted, updated, skipped, failed, total: deltaCount,
          });
          // Delay after a real API call to respect E*Trade rate limits
          if (!signal.aborted) await sleep(callDelayMs);
        } else if (result.failed > 0) {
          failed++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'no-data',
            attempted, updated, skipped, failed, total: deltaCount,
            message: result.errors[0],
          });
          // Still delay — even a failed call hit the API
          if (!signal.aborted) await sleep(callDelayMs);
        } else {
          // Skipped — manual entry slipped through (safety net)
          skipped++;
          onProgress({
            jobId: JOB_ID, runId: 0, ticker,
            status: 'skipped',
            attempted, updated, skipped, failed, total: deltaCount,
          });
        }
      } catch (err) {
        failed++;
        onProgress({
          jobId: JOB_ID, runId: 0, ticker,
          status: 'failed',
          attempted, updated, skipped, failed, total: deltaCount,
          message: err instanceof Error ? err.message : String(err),
        });
        if (!signal.aborted) await sleep(callDelayMs);
      }
    }

    return {
      status: signal.aborted ? 'failed' : 'success',
      notes: [
        finnhubKey ? `Finnhub: ${finnhubFilled} pre-filled` : null,
        `E*Trade: ${updated} updated, ${failed} no-data`,
        `${cachedCount} of ${tickers.length} already cached`,
      ].filter(Boolean).join(' · '),
      tickersAttempted: attempted,
      tickersUpdated: updated + finnhubFilled,
      tickersSkipped: skipped + cachedCount,
      tickersFailed: failed + finnhubErrors,
    };
  }
}

interface FinnhubEntry {
  date: string;
  symbol: string;
  hour: string | null;
  epsActual: number | null;
  epsEstimate: number | null;
  quarter: number | null;
  year: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}
