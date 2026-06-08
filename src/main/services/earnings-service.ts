// Earnings calendar service — fetches upcoming earnings dates per ticker.
// Primary source: E*Trade FUNDAMENTAL quote (nextEarningDate / earningsDate field).
// No fallback — if E*Trade doesn't return a date, the ticker is left as no-data.
//
// Smart caching: a ticker is skipped if it already has a future report_date stored.
// Only re-fetched after that date passes (i.e. earnings have occurred → need next date).
// Manual entries (source='manual') are never auto-overwritten.
// v0.31.4

import type { DbHandle } from '../db/connection.js';
import { etradeGet, type OAuthCredentials } from './etrade-auth.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EarningsEntry {
  ticker:      string;
  reportDate:  string;          // ISO YYYY-MM-DD
  reportTime:  'bmo' | 'amc' | null;
  epsEstimate: number | null;
  source:      'etrade' | 'polygon_est' | 'manual' | 'finnhub';
  confirmed:   boolean;
  cachedAt:    string;
  dte:         number | null;   // days from today to reportDate (computed at read time)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toIso(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  // Unix ms timestamp (13 digits, > year 2001)
  if (typeof raw === 'number' && raw > 1_000_000_000_000) {
    return new Date(raw).toISOString().slice(0, 10);
  }
  // Unix seconds timestamp (10 digits, > year 2001 and < year 2100)
  if (typeof raw === 'number' && raw > 1_000_000_000 && raw < 4_102_444_800) {
    return new Date(raw * 1000).toISOString().slice(0, 10);
  }

  if (typeof raw === 'string' && raw.trim().length > 0) {
    const s = raw.trim();

    // MM/DD/YYYY — E*Trade nextEarningDate format. Parse directly to avoid
    // new Date() treating it as local time and shifting the date on UTC conversion.
    const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (mdy) {
      return `${mdy[3]}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}`;
    }

    // ISO YYYY-MM-DD or any other parseable string (treated as UTC noon to avoid tz drift)
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    // Last resort: let JS parse it (e.g. "Jun 18, 2026") — UTC noon avoids drift
    const d = new Date(s + 'T12:00:00Z');
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  return null;
}

function computeDte(reportDate: string): number | null {
  const ms = new Date(reportDate).getTime() - Date.now();
  if (isNaN(ms)) return null;
  return Math.round(ms / 86_400_000);
}

function rowToEntry(r: Record<string, unknown>): EarningsEntry {
  return {
    ticker:      r['ticker'] as string,
    reportDate:  r['report_date'] as string,
    reportTime:  (r['report_time'] as 'bmo' | 'amc' | null) ?? null,
    epsEstimate: (r['eps_estimate'] as number | null) ?? null,
    source:      r['source'] as EarningsEntry['source'],
    confirmed:   (r['confirmed'] as number) === 1,
    cachedAt:    r['cached_at'] as string,
    dte:         computeDte(r['report_date'] as string),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class EarningsService {
  constructor(private readonly db: DbHandle) {}

  // ── Public API ────────────────────────────────────────────────────────────

  getForTicker(ticker: string): EarningsEntry | null {
    const row = this.db.prepare(
      `SELECT * FROM earnings_calendar WHERE ticker = ?`
    ).get(ticker.toUpperCase()) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : null;
  }

  getUpcoming(withinDays = 60): EarningsEntry[] {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() + withinDays * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db.prepare(`
      SELECT * FROM earnings_calendar
      WHERE report_date >= ? AND report_date <= ?
      ORDER BY report_date ASC
    `).all(today, cutoff) as Record<string, unknown>[];
    return rows.map(rowToEntry);
  }

  setManual(ticker: string, reportDate: string, reportTime?: 'bmo' | 'amc' | null): EarningsEntry {
    const t = ticker.toUpperCase();
    this.db.prepare(`
      INSERT INTO earnings_calendar (ticker, report_date, report_time, source, confirmed)
      VALUES (?, ?, ?, 'manual', 1)
      ON CONFLICT(ticker) DO UPDATE SET
        report_date = excluded.report_date,
        report_time = excluded.report_time,
        source      = 'manual',
        confirmed   = 1,
        cached_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(t, reportDate, reportTime ?? null);
    return this.getForTicker(t)!;
  }

  deleteTicker(ticker: string): void {
    this.db.prepare(`DELETE FROM earnings_calendar WHERE ticker = ?`).run(ticker.toUpperCase());
  }

  /** Delete all non-manual entries — used for a clean reset before a full re-fetch. */
  clearNonManual(): number {
    const result = this.db.prepare(`DELETE FROM earnings_calendar WHERE source != 'manual'`).run();
    return result.changes;
  }

  /** Public write for external providers (e.g. Finnhub bulk pre-fill).
   *  Never overwrites manual entries. */
  upsertFromProvider(
    ticker: string,
    reportDate: string,
    reportTime: 'bmo' | 'amc' | null,
    source: EarningsEntry['source'],
    confirmed: boolean,
  ): void {
    this.upsert(ticker.toUpperCase(), reportDate, reportTime, null, source, confirmed);
  }

  // Refresh a batch of tickers via E*Trade only (no fallback).
  //
  // Smart skip logic (unless force=true):
  //   - Manual entries are never auto-overwritten.
  //   - If a future report_date is already stored, skip — the date is still valid.
  //   - If the stored date is in the past (earnings have occurred), fetch the next date.
  //   - If no date stored at all, fetch.
  async refreshTickers(
    tickers: string[],
    etradeCreds: OAuthCredentials | null,
    force = false,
  ): Promise<{ updated: number; skipped: number; failed: number; errors: string[] }> {
    let updated = 0, skipped = 0, failed = 0;
    const errors: string[] = [];

    const todayStr = new Date().toISOString().slice(0, 10);

    for (const ticker of tickers) {
      const t = ticker.toUpperCase();
      try {
        if (!force) {
          const existing = this.getForTicker(t);
          // Never overwrite a manual entry
          if (existing?.source === 'manual') { skipped++; continue; }
          // Skip if we already have a future date — still valid
          if (existing?.reportDate && existing.reportDate > todayStr) { skipped++; continue; }
          // If date is in the past (or missing), fall through to fetch the next date
        }

        if (!etradeCreds?.accessToken) {
          // No E*Trade connection — nothing to do
          failed++;
          errors.push(`${t}: E*Trade not connected`);
          continue;
        }

        let entry: { date: string | null; time: 'bmo' | 'amc' | null; source: EarningsEntry['source']; confirmed: boolean } | null = null;

        try {
          entry = await this.fetchFromEtrade(t, etradeCreds);
        } catch (err) {
          failed++;
          errors.push(`${t}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        if (entry?.date) {
          this.upsert(t, entry.date, entry.time, null, entry.source, entry.confirmed);
          updated++;
        } else {
          failed++;
          errors.push(`${t}: no earnings date returned by E*Trade`);
        }
      } catch (err) {
        failed++;
        errors.push(`${t}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { updated, skipped, failed, errors };
  }

  // Refresh all tickers currently in portfolio (open) + watchlists + conviction list.
  async refreshAllRelevant(
    etradeCreds: OAuthCredentials | null,
    force = false,
  ): Promise<{ updated: number; skipped: number; failed: number; errors: string[] }> {
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM (
        SELECT ticker FROM positions WHERE status = 'open'
        UNION
        SELECT wi.ticker FROM watchlist_items wi
        UNION
        SELECT ticker FROM conviction_stocks
      )
      ORDER BY ticker
    `).all() as Row[];
    const tickers = rows.map(r => r.ticker);
    if (tickers.length === 0) return { updated: 0, skipped: 0, failed: 0, errors: [] };
    return this.refreshTickers(tickers, etradeCreds, force);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async fetchFromEtrade(
    ticker: string,
    creds: OAuthCredentials,
  ): Promise<{ date: string | null; time: 'bmo' | 'amc' | null; source: EarningsEntry['source']; confirmed: boolean } | null> {
    // E*Trade: GET /v1/market/quote/{ticker}?detailFlag=ALL&requireEarningsDate=true
    // requireEarningsDate=true is required to populate nextEarningDate in the All block.
    // Without it the field is returned as "" per the official API docs:
    // https://apisb.etrade.com/docs/api/market/api-quote-v1.html
    const raw = await etradeGet(
      `/v1/market/quote/${encodeURIComponent(ticker)}`,
      { detailFlag: 'ALL', requireEarningsDate: 'true' },
      creds,
    ) as Record<string, unknown>;

    const resp     = raw['QuoteResponse'] as Record<string, unknown> | undefined;
    const quoteData = resp?.['QuoteData'];
    const first    = Array.isArray(quoteData) ? quoteData[0] : quoteData;
    const all      = (first as Record<string, unknown> | undefined)?.['All'] as Record<string, unknown> | undefined;
    if (!all) return null;

    // Primary: nextEarningDate (may be empty string, ISO string, or Unix seconds)
    const rawDate = all['nextEarningDate'] ?? all['earningsDate'];
    const date = toIso(rawDate);
    if (!date) return null;

    // E*Trade does not expose a time-of-day flag for earnings through this endpoint
    const time: 'bmo' | 'amc' | null = null;

    // Timezone correction: E*Trade's API returns dates in UTC. Companies report
    // after ET market close, so a date that is "Saturday UTC" is actually "Friday ET".
    // Shift Saturday → Friday (subtract 1 day). Mark as unconfirmed since adjusted.
    // Sunday dates are rare — leave as-is but also mark unconfirmed for the UI warning.
    const d = new Date(`${date}T12:00:00Z`);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 6) {
      const friday = new Date(d.getTime() - 86_400_000);
      const fridayStr = friday.toISOString().slice(0, 10);
      return { date: fridayStr, time, source: 'etrade', confirmed: false };
    }

    return { date, time, source: 'etrade', confirmed: dow !== 0 };
  }

  private upsert(
    ticker: string,
    reportDate: string,
    reportTime: 'bmo' | 'amc' | null,
    epsEstimate: number | null,
    source: EarningsEntry['source'],
    confirmed: boolean,
  ): void {
    this.db.prepare(`
      INSERT INTO earnings_calendar (ticker, report_date, report_time, eps_estimate, source, confirmed)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker) DO UPDATE SET
        report_date  = excluded.report_date,
        report_time  = excluded.report_time,
        eps_estimate = excluded.eps_estimate,
        source       = excluded.source,
        confirmed    = excluded.confirmed,
        cached_at    = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `).run(ticker, reportDate, reportTime, epsEstimate, source, confirmed ? 1 : 0);
  }
}
