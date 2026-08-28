// EarningsRefreshJob — batch job that refreshes upcoming earnings dates for the full
// S&P 500 + Russell 1000 universe (unique tickers from the constituents table).
//
// Two-phase approach:
//   Phase 1 (Finnhub, optional): an ADAPTIVE bulk sweep over the next 180 days.
//     Finnhub's free tier caps each bulk response at 1500 entries and truncates
//     from the FRONT, so any full response is a truncated tail, not a whole window.
//     sweepBulkWindow() recursively halves the range until every slice fits under
//     the cap, then the nearest future date per ticker is written in one pass.
//     Covers tickers that E*Trade's per-ticker API silently drops (e.g. ABNB, ADBE).
//     Source='finnhub'. Key stored in secure settings as 'finnhubApiKey'.
//   Phase 2 (Finnhub per-ticker): delta loop over tickers with no row, a stale row,
//     or a row dated beyond the swept horizon (the signature of the old truncation
//     bug, which the sweep cannot see far enough to correct).
//
// Manual entries are never overwritten. Delta filter applied before Phase 2.
// v1.1.136 — fixed-window bulk replaced by the adaptive sweep after a truncated
// window stored NVDA's 2026-08-26 report as 2026-11-17, hiding it from the -20
// earnings penalty on the day it printed.

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

// ── Finnhub bulk-sweep tuning ────────────────────────────────────────────────
// Finnhub's free-tier bulk calendar caps each response at 1500 entries and
// truncates from the FRONT — a from=today&to=+90d call during earnings season
// comes back holding only the LAST two weeks of the range. See sweepBulk().
const FINNHUB_BULK_CAP   = 1500;
const BULK_HORIZON_DAYS  = 180;  // how far ahead the sweep looks
const MAX_BULK_CALLS     = 160;  // runaway guard for the recursive subdivision
const BULK_CALL_DELAY_MS = 1100; // 1 call/s — inside the 60/min free-tier limit
// How far a COMPLETE sweep may push a stored future date LATER. Covers an issuer
// refining a scheduled date by a day or two; well under the ~90-day jump that would
// mean a coverage gap hid the near date and returned the following quarter. v1.1.137
const MAX_LATER_SLIP_DAYS = 14;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
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
    'Sweeps upcoming earnings dates via Finnhub over the next 180 days, subdividing the ' +
    'window until every slice fits under the API result cap so near-term dates are never ' +
    'truncated away. Covers tickers the E*Trade API misses. Tickers without announced dates ' +
    'simply have nothing to return yet — they appear automatically on the next run once ' +
    'companies publish them. Manual entries are never overwritten.';

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

    // ── Phase 1: Finnhub bulk sweep (adaptive subdivision over 0–180d) ──────
    // Finnhub's free-tier bulk calendar caps a response at FINNHUB_BULK_CAP (1500)
    // entries and truncates from the FRONT — it returns the TAIL of the requested
    // range. A fixed from=today&to=+90d call therefore comes back holding only the
    // last two weeks of that window during earnings season, silently dropping every
    // near-term date. That is how NVDA's 2026-08-26 report was stored as 2026-11-17
    // (one quarter late) and slipped past the -20 earnings penalty on the very day
    // it printed — see CLAUDE.md Known quirks.
    //
    // sweepBulk() therefore treats a full response as evidence of truncation and
    // recursively halves the window until every slice comes back under the cap, so
    // the sweep is complete over the whole horizon regardless of season density.
    const finnhubKey = secureGet(this.db, 'finnhubApiKey');
    let finnhubFilled = 0;
    let finnhubErrors = 0;
    // Only store entries for tickers in our universe — bulk returns global companies
    const constituentSet = new Set(tickers);
    let sweepComplete = false;
    if (finnhubKey) {
      const collected: FinnhubEntry[] = [];
      const state = { calls: 0, errors: 0 };
      sweepComplete = await sweepBulkWindow(
        todayStr,
        addDays(todayStr, BULK_HORIZON_DAYS),
        finnhubKey,
        collected,
        state,
        signal,
      );
      finnhubErrors = state.errors;

      // Reduce the sweep to the NEAREST future date per ticker before writing.
      // Doing this in one pass (rather than upserting as results stream in) makes
      // the result independent of slice order — a quarterly reporter appearing in
      // both an Aug and a Nov slice always resolves to Aug.
      const nearest = new Map<string, { date: string; hour: string | null }>();
      for (const e of collected) {
        if (!e.symbol || !e.date) continue;
        if (!constituentSet.has(e.symbol)) continue;   // skip non-constituents
        if (e.date <= todayStr) continue;              // ignore past/today dates
        const cur = nearest.get(e.symbol);
        if (!cur || e.date < cur.date) nearest.set(e.symbol, { date: e.date, hour: e.hour });
      }

      for (const [symbol, hit] of nearest) {
        const existing = this.earningsService.getForTicker(symbol);
        if (existing?.source === 'manual') continue;   // never overwrite a manual entry
        if (existing?.reportDate === hit.date) continue;
        // Moving a stored future date NEARER is always allowed — it is fail-safe (the
        // -20 penalty engages earlier) and it is what heals rows poisoned by the old
        // truncated-bulk behaviour, since poison always reads too FAR.
        //
        // Moving one LATER is allowed only when the sweep is COMPLETE and the slip is
        // small (<= MAX_LATER_SLIP_DAYS). Issuers routinely refine a scheduled date by a
        // day or two, and refusing those left rows stale-early for weeks (measured
        // 2026-08-28: 19 of 69 names reporting within 45d were 1-8 days early, some
        // written two months prior). But a LARGE later jump is the signature of a
        // Finnhub coverage gap hiding the near date and returning the following quarter
        // — roughly a 90-day leap — which is exactly the failure this job exists to
        // prevent, so it is still refused. An incomplete sweep is never trusted to push
        // a date out at all. Anything refused here is corrected by Phase 2 once the
        // stored date goes stale.
        if (existing?.reportDate && existing.reportDate > todayStr && hit.date > existing.reportDate) {
          const slipDays = daysBetween(existing.reportDate, hit.date);
          if (!sweepComplete || slipDays > MAX_LATER_SLIP_DAYS) continue;
        }
        const reportTime: 'bmo' | 'amc' | null =
          hit.hour === 'bmo' ? 'bmo' : hit.hour === 'amc' ? 'amc' : null;
        this.earningsService.upsertFromProvider(symbol, hit.date, reportTime, 'finnhub', true);
        finnhubFilled++;
      }
    }

    onProgress({
      jobId: JOB_ID, runId: 0, ticker: '',
      status: finnhubKey ? 'updated' : 'skipped',
      attempted: 0, updated: finnhubFilled, skipped: 0, failed: finnhubErrors,
      total: tickers.length,
      message: finnhubKey
        ? `Finnhub sweep (0–180d${sweepComplete ? '' : ', INCOMPLETE'}): ${finnhubFilled} dates written. ` +
          'Now querying remaining tickers individually…'
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
    // Delta filter. Historically this trusted ANY stored future date and skipped the
    // ticker — which meant a bogus far date written by the old truncated bulk call
    // permanently suppressed the per-ticker lookup that would have corrected it
    // (the per-ticker endpoint returns every quarter and picks the nearest, so it
    // always had the right answer; it was simply never asked). A stored date beyond
    // the swept horizon is exactly that failure's signature — the bulk sweep cannot
    // see far enough to correct it, so re-verify it per ticker.
    const horizonStr = addDays(todayStr, BULK_HORIZON_DAYS);
    const needsLookup = tickers.filter(t => {
      const e = this.earningsService.getForTicker(t);
      if (!e) return true;
      if (e.source === 'manual') return false;
      if (e.reportDate <= todayStr) return true;      // stale — last report has passed
      if (e.reportDate > horizonStr) return true;     // beyond the sweep's reach — unverifiable
      return false;
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
      notes: `Sweep${sweepComplete ? '' : ' (INCOMPLETE)'}: ${finnhubFilled} dates · ` +
             `Per-ticker: ${perTickerFilled} found, ${needsLookup.length - perTickerFilled} not yet announced`,
      tickersAttempted: tickers.length,
      tickersUpdated: finnhubFilled + perTickerFilled,
      tickersSkipped: tickers.length - needsLookup.length,
      tickersFailed: finnhubErrors + perTickerFailed,
    };
  }
}

/**
 * Recursively sweeps the Finnhub bulk earnings calendar over [from, to].
 *
 * Finnhub caps a bulk response at FINNHUB_BULK_CAP entries and truncates from the
 * front, so a full response means "this window overflowed and you are only seeing
 * its tail" — never "here is the whole window". We therefore treat a full response
 * as a subdivision signal and halve the range until every slice fits under the cap.
 *
 * Collected entries are appended to `out`. Returns true only if EVERY slice was
 * fetched successfully and came back under the cap — i.e. the sweep is complete and
 * can be trusted as authoritative for the range.
 */
async function sweepBulkWindow(
  from: string,
  to: string,
  apiKey: string,
  out: FinnhubEntry[],
  state: { calls: number; errors: number },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  if (state.calls >= MAX_BULK_CALLS) return false;   // runaway guard

  state.calls++;
  let entries: FinnhubEntry[];
  try {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) { state.errors++; return false; }
    const json = await resp.json() as { earningsCalendar?: FinnhubEntry[] };
    entries = json.earningsCalendar ?? [];
  } catch {
    state.errors++;
    return false;
  }
  if (!signal.aborted) await sleep(BULK_CALL_DELAY_MS);

  if (entries.length < FINNHUB_BULK_CAP) {
    out.push(...entries);
    return true;
  }

  // Capped → the response is a truncated tail. Split and retry each half.
  const span = daysBetween(from, to);
  if (span < 1) {
    // A single day that still overflows the cap: nothing left to subdivide. Keep
    // what we have but report the sweep as incomplete so callers stay conservative.
    out.push(...entries);
    return false;
  }
  const mid = addDays(from, Math.floor(span / 2));
  const left  = await sweepBulkWindow(from, mid, apiKey, out, state, signal);
  const right = await sweepBulkWindow(addDays(mid, 1), to, apiKey, out, state, signal);
  return left && right;
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
