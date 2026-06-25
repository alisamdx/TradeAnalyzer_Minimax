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
    'Bulk-fetches upcoming earnings dates via Finnhub (two calls: today→+90d and +90d→+180d). ' +
    'Covers tickers E*Trade API misses. Tickers without announced dates simply have nothing to ' +
    'return yet — they appear automatically on the next run once companies publish them. ' +
    'Manual entries are never overwritten.';

  constructor(
    private readonly db: DbHandle,
    private readonly earningsService: EarningsService,
    private readonly getCreds: () => OAuthCredentials | null,
  ) {}

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    _force = false,
  ): Promise<BatchJobResult> {
    // Full S&P 500 + Russell 1000 universe — unique tickers only
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM constituents ORDER BY ticker
    `).all() as Row[];

    const tickers = rows.map(r => r.ticker);
    const todayStr = new Date().toISOString().slice(0, 10);

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

    // ── Phase 1: Finnhub bulk pre-fill (two 90-day windows = 180 days) ──────
    // Free tier returns ~1500 entries per call. Two calls cover more of the
    // universe than a single call and avoid result-cap cut-offs (e.g. ABNB).
    // Delta query runs AFTER this so E*Trade only sees tickers Finnhub missed.
    const finnhubKey = secureGet(this.db, 'finnhubApiKey');
    let finnhubFilled = 0;
    let finnhubErrors = 0;
    // Only store entries for tickers in our universe — bulk returns global companies
    const constituentSet = new Set(tickers);
    if (finnhubKey) {
      const windows = [
        { from: 0,  to: 90  },   // today → +90d
        { from: 90, to: 180 },   // +90d  → +180d
      ];
      for (const win of windows) {
        if (signal.aborted) break;
        try {
          const fromDate = new Date(Date.now() + win.from * 86_400_000).toISOString().slice(0, 10);
          const toDate   = new Date(Date.now() + win.to   * 86_400_000).toISOString().slice(0, 10);
          const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${finnhubKey}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const json = await resp.json() as { earningsCalendar?: FinnhubEntry[] };
            for (const e of json.earningsCalendar ?? []) {
              if (!e.symbol || !e.date) continue;
              if (!constituentSet.has(e.symbol)) continue;   // skip non-constituents
              if (e.date <= todayStr) continue;              // ignore past/today dates
              const existing = this.earningsService.getForTicker(e.symbol);
              if (existing?.source === 'manual') continue;
              // Keep the NEAREST future earnings date. The two windows are fetched in
              // order (0–90d, then 90–180d), and the upsert overwrites unconditionally,
              // so without this guard a quarterly reporter that appears in BOTH windows
              // would have its near date (window 1, e.g. an Aug report) overwritten by
              // the FOLLOWING quarter (window 2, e.g. Nov) — silently hiding the next
              // earnings from the earnings-before-expiry risk gate (critic +
              // brief-entry-source), the single most important gate for a premium-selling
              // book. Only overwrite when there is no stored future date, the stored date
              // has already passed, or this candidate is strictly nearer.
              if (existing?.reportDate && existing.reportDate > todayStr && e.date >= existing.reportDate) {
                continue;
              }
              const reportTime: 'bmo' | 'amc' | null =
                e.hour === 'bmo' ? 'bmo' : e.hour === 'amc' ? 'amc' : null;
              this.earningsService.upsertFromProvider(e.symbol, e.date, reportTime, 'finnhub', true);
              finnhubFilled++;
            }
          } else {
            finnhubErrors++;
          }
        } catch {
          finnhubErrors++;
        }
        // Small pause between Finnhub calls to be polite to the rate limiter
        if (!signal.aborted) await sleep(1000);
      }
    }

    onProgress({
      jobId: JOB_ID, runId: 0, ticker: '',
      status: finnhubKey ? 'updated' : 'skipped',
      attempted: 0, updated: finnhubFilled, skipped: 0, failed: finnhubErrors,
      total: tickers.length,
      message: finnhubKey
        ? `Finnhub bulk: ${finnhubFilled} entries (0–180d). Now querying missing tickers individually…`
        : 'Finnhub key not configured — add key in Settings → API & Data',
    });

    if (!finnhubKey || signal.aborted) {
      return {
        status: signal.aborted ? 'failed' : 'skipped',
        notes: 'No Finnhub key configured — add key in Settings → API & Data',
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: tickers.length, tickersFailed: 0,
      };
    }

    // ── Phase 2: per-ticker Finnhub fallback ─────────────────────────────────
    // The bulk call has a result cap (~1500 global entries). Tickers like AAPL
    // that have confirmed dates but weren't returned in the bulk are fetched here.
    // Rate-limited to 1 call/second (well within Finnhub free tier 60/min).
    const needsLookup = tickers.filter(t => {
      const e = this.earningsService.getForTicker(t);
      return !e || (e.source !== 'manual' && e.reportDate <= todayStr);
    });

    let perTickerFilled = 0;
    let perTickerFailed = 0;
    const perTotal = needsLookup.length;

    for (let i = 0; i < needsLookup.length; i++) {
      if (signal.aborted) break;
      const ticker = needsLookup[i]!;
      try {
        // Finnhub requires from/to — use a wide 365-day window to catch any quarter
        const fromDate = new Date().toISOString().slice(0, 10);
        const toDate   = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
        const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&from=${fromDate}&to=${toDate}&token=${finnhubKey}`;
        const resp = await fetch(url);
        if (resp.ok) {
          const json = await resp.json() as { earningsCalendar?: FinnhubEntry[] };
          const entries = (json.earningsCalendar ?? []).filter(e => e.date > todayStr);
          if (entries.length > 0) {
            // Pick the nearest future date
            entries.sort((a, b) => a.date.localeCompare(b.date));
            const e = entries[0]!;
            const reportTime: 'bmo' | 'amc' | null =
              e.hour === 'bmo' ? 'bmo' : e.hour === 'amc' ? 'amc' : null;
            this.earningsService.upsertFromProvider(ticker, e.date, reportTime, 'finnhub', true);
            perTickerFilled++;
            onProgress({
              jobId: JOB_ID, runId: 0, ticker,
              status: 'updated',
              attempted: i + 1, updated: perTickerFilled, skipped: 0, failed: perTickerFailed,
              total: perTotal,
            });
          } else {
            // Finnhub has no announced date for this ticker yet — normal during quiet periods
            onProgress({
              jobId: JOB_ID, runId: 0, ticker,
              status: 'skipped',
              attempted: i + 1, updated: perTickerFilled, skipped: 0, failed: perTickerFailed,
              total: perTotal,
            });
          }
        } else {
          perTickerFailed++;
        }
      } catch {
        perTickerFailed++;
      }
      // 1 call/second — well within 60/min free tier limit
      if (!signal.aborted) await sleep(1000);
    }

    return {
      status: signal.aborted ? 'failed' : 'success',
      notes: `Bulk: ${finnhubFilled} entries · Per-ticker: ${perTickerFilled} found, ${needsLookup.length - perTickerFilled} not yet announced`,
      tickersAttempted: tickers.length,
      tickersUpdated: finnhubFilled + perTickerFilled,
      tickersSkipped: tickers.length - needsLookup.length,
      tickersFailed: finnhubErrors + perTickerFailed,
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
