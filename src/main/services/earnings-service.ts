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
  source:      'etrade' | 'polygon_est' | 'manual' | 'finnhub' | 'share_class';
  confirmed:   boolean;
  cachedAt:    string;
  dte:         number | null;   // days from today to reportDate (computed at read time)
}

// How near a stored earnings date must be for `refreshTickers` to trust it without
// re-confirming against E*Trade. Deliberately wider than the brief's 45-day penalty
// window so that ANY date inside that window is trusted (the gate is already engaged
// and re-checking cannot change the outcome), while every date claiming to be outside
// it gets confirmed — that is the direction a wrong value disables the gate. v1.1.138
const TRUST_STORED_WITHIN_DAYS = 60;

/**
 * Share classes of ONE issuer, which report on the same day (v1.1.321). The earnings sources date
 * one class and not the other — on 2026-09-23 Finnhub had GOOGL 10-27 and NWSA 11-04 and nothing
 * for GOOG or NWS, and E*Trade returned no date for either — so every consumer read GOOG as
 * having no earnings and passed it. Symmetric: whichever class is dated supplies the other.
 */
export const SHARE_CLASS_SIBLINGS: ReadonlyArray<readonly [string, string]> = [
  ['GOOG', 'GOOGL'],
  ['NWS', 'NWSA'],
  ['BRK.B', 'BRK.A'],
  ['FOX', 'FOXA'],
  ['UA', 'UAA'],
  ['LEN', 'LEN.B'],
  ['HEI', 'HEI.A'],
  ['BF.A', 'BF.B'],
  ['Z', 'ZG'],
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Whether an earnings event on `reportDate`/`reportTime` is still ahead of `todayET` — i.e.
 * hasn't happened yet. A same-day 'bmo' (before market open) report has already occurred by
 * the time any batch job runs; a same-day 'amc' (after close) or unknown-time report has NOT
 * — it still carries same-day gap/IV-crush risk for anything traded off today's brief.
 *
 * Both the brief's earnings penalty (Stage 3) and the critic's earnings-in-window check used
 * to compare with a strict `report_date > today`, which silently treated today's amc/unknown
 * earnings as "no earnings" — a stock reporting after today's close could surface in the
 * 10:15 morning brief with no penalty and no warning. Fixed v1.1.116.
 */
export function isEarningsPending(
  reportDate: string,
  reportTime: 'bmo' | 'amc' | null,
  todayET: string,
): boolean {
  if (reportDate > todayET) return true;
  if (reportDate < todayET) return false;
  return reportTime !== 'bmo';
}

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

  /**
   * Copies a dated share class's next report onto its undated sibling, as source 'share_class'
   * (v1.1.321). Done at the WRITER because ten readers query earnings_calendar directly — patching
   * each would leave the next one out. A sibling with its own future provider or manual date is
   * never overwritten; a stale or share_class row is replaced. Returns how many rows it wrote.
   */
  syncShareClassSiblings(todayStr: string): number {
    // A provider or manual date that has not passed. Plain boolean, not a type guard: a guard's
    // false branch would narrow `dst` to null and hide the share_class comparison below.
    const live = (e: EarningsEntry): boolean => e.source !== 'share_class' && e.reportDate >= todayStr;
    let written = 0;
    for (const [a, b] of SHARE_CLASS_SIBLINGS) {
      for (const [from, to] of [[a, b], [b, a]] as const) {
        const src = this.getForTicker(from);
        const dst = this.getForTicker(to);
        if (!src || !live(src)) continue;
        if (dst && dst.source === 'manual') continue;
        if (dst && live(dst)) continue;                // it has its own date — keep it
        if (dst && dst.source === 'share_class' && dst.reportDate === src.reportDate && dst.reportTime === src.reportTime) continue;
        this.upsert(to, src.reportDate, src.reportTime, null, 'share_class', src.confirmed);
        written++;
      }
    }
    return written;
  }

  // Refresh a batch of tickers via E*Trade — an INDEPENDENT second source used to
  // confirm the Finnhub-derived calendar for a small, high-stakes ticker list.
  //
  // Skip logic (unless force=true):
  //   - Manual entries are never overwritten (this holds even when force=true).
  //   - A stored date NEAR enough to already engage the risk gates is trusted and
  //     skipped. If the true date is even nearer, the -20 penalty fires either way;
  //     if it is later, we over-penalise, which is the fail-safe direction.
  //   - Everything else is fetched: no row, a past row, or — critically — a stored
  //     date BEYOND the horizon. A far date is the one that silently says "no
  //     earnings risk here", so it is exactly what must be confirmed rather than
  //     trusted. Before v1.1.138 this skipped ANY stored future date, which made the
  //     brief's earnings net inert: NVDA held a bogus 2026-11-17 (true 2026-08-26)
  //     and was skipped as "still valid" on the day it reported.
  //
  // Verify exactly the rows claiming there is nothing to worry about.
  async refreshTickers(
    tickers: string[],
    etradeCreds: OAuthCredentials | null,
    force = false,
  ): Promise<{ updated: number; skipped: number; failed: number; errors: string[] }> {
    let updated = 0, skipped = 0, failed = 0;
    const errors: string[] = [];

    const todayStr = new Date().toISOString().slice(0, 10);

    const trustedThroughStr = new Date(Date.now() + TRUST_STORED_WITHIN_DAYS * 86_400_000)
      .toISOString().slice(0, 10);

    for (const ticker of tickers) {
      const t = ticker.toUpperCase();
      try {
        const existing = this.getForTicker(t);
        // Never overwrite a manual entry — this is unconditional, force included.
        // (Before v1.1.138 `force` bypassed this check along with the rest of the
        // skip block, contradicting the documented contract.)
        if (existing?.source === 'manual') { skipped++; continue; }

        if (!force) {
          // Trust a stored date that is already inside the risk horizon; verify
          // anything that claims there is no near-term earnings event.
          if (existing?.reportDate
              && existing.reportDate > todayStr
              && existing.reportDate <= trustedThroughStr) {
            skipped++;
            continue;
          }
          // No row, a past row, or a date beyond the horizon → fetch and confirm.
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
