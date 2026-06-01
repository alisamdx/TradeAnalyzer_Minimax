// IV History Service — builds and queries the daily ATM IV history table.
// Computes 30-day constant-maturity ATM IV from options chains, stores daily
// readings, detects gaps, runs backfills, and returns IV rank/percentile.
// see docs/formulas.md#iv-history

import type { DbHandle } from '../db/connection.js';
import type { IVolatilityProvider } from './ivolatility-provider.js';
import type { OptionContract } from '@shared/types.js';
import type { IvHistoryCoverage, IvHistoryGapSummary, IvRankResult, IvHistoryProgressEvent, IvHistoryBackfillPhase } from '@shared/types.js';

// ─── NYSE holiday calendar (2023 – 2027) ────────────────────────────────────
// Dates are UTC midnight strings (YYYY-MM-DD). Extend when needed.
// see docs/formulas.md#trading-days

const NYSE_HOLIDAYS = new Set([
  // 2023
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07',
  '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04',
  '2023-11-23', '2023-12-25',
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29',
  '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02',
  '2024-11-28', '2024-12-25',
  // 2025
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17',
  '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04',
  '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
]);

/** Returns true if the given YYYY-MM-DD string is a NYSE trading day. */
export function isTradingDay(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  return dow !== 0 && dow !== 6 && !NYSE_HOLIDAYS.has(dateStr);
}

/** Returns yesterday's date in ET as YYYY-MM-DD (safe cutoff — today may still be open). */
function yesterdayET(): string {
  const now = new Date();
  // Subtract 1 day then format in ET
  now.setDate(now.getDate() - 1);
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Generate all trading days in [fromDate, toDate] inclusive, in ascending order. */
function tradingDaysInRange(fromDate: string, toDate: string): string[] {
  const result: string[] = [];
  const cur = new Date(fromDate + 'T12:00:00Z');
  const end = new Date(toDate   + 'T12:00:00Z');
  while (cur <= end) {
    const s = cur.toISOString().slice(0, 10);
    if (isTradingDay(s)) result.push(s);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

/** Subtract N trading days from today (for the 252-day backfill window). */
function tradingDaysAgo(n: number): string {
  let count = 0;
  const cur = new Date();
  cur.setUTCHours(12, 0, 0, 0);
  while (count < n) {
    cur.setUTCDate(cur.getUTCDate() - 1);
    const s = cur.toISOString().slice(0, 10);
    if (isTradingDay(s)) count++;
  }
  return cur.toISOString().slice(0, 10);
}

/** Advance a YYYY-MM-DD string by one calendar day. */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─── ATM IV computation ───────────────────────────────────────────────────────

interface AtmIvResult {
  atmIv:   number;
  expNear: string | null;
  expFar:  string | null;
  dteNear: number | null;
  dteFar:  number | null;
}

/**
 * Compute 30-day constant-maturity ATM IV from a set of option contracts.
 * see docs/formulas.md#atm-iv-interpolation
 *
 * Algorithm:
 * 1. Group contracts by expiration.
 * 2. For each expiration find the ATM strike (nearest to underlyingPx) that has
 *    both a call IV and a put IV.  ATM IV = (call_iv + put_iv) / 2.
 * 3. Identify the expiration nearest to 30 DTE from below (near) and above (far).
 * 4. Interpolate: weight_near = (dte_far − 30) / (dte_far − dte_near).
 */
export function computeAtmIv(
  contracts: Array<{ expiration: string; strike: number; side: 'call' | 'put'; iv: number | null; dte: number | null }>,
  underlyingPx: number,
): AtmIvResult | null {
  // Group by expiration
  const byExp = new Map<string, { dte: number; callsByStrike: Map<number, number>; putsByStrike: Map<number, number> }>();
  for (const c of contracts) {
    if (c.iv === null || c.dte === null || c.dte < 0) continue;
    let group = byExp.get(c.expiration);
    if (!group) {
      group = { dte: c.dte, callsByStrike: new Map(), putsByStrike: new Map() };
      byExp.set(c.expiration, group);
    }
    if (c.side === 'call') group.callsByStrike.set(c.strike, c.iv);
    else                   group.putsByStrike.set(c.strike, c.iv);
  }

  // Compute ATM IV for each expiration
  const expIvs: Array<{ exp: string; dte: number; iv: number }> = [];
  for (const [exp, group] of byExp) {
    // Find strikes that have both call and put IV
    const strikes = [...group.callsByStrike.keys()].filter(s => group.putsByStrike.has(s));
    if (strikes.length === 0) continue;

    // Pick the ATM strike (closest to underlying price)
    const atmStrike = strikes.reduce((best, s) =>
      Math.abs(s - underlyingPx) < Math.abs(best - underlyingPx) ? s : best
    );

    const callIv = group.callsByStrike.get(atmStrike)!;
    const putIv  = group.putsByStrike.get(atmStrike)!;
    expIvs.push({ exp, dte: group.dte, iv: (callIv + putIv) / 2 });
  }

  if (expIvs.length === 0) return null;

  // Sort by DTE ascending
  expIvs.sort((a, b) => a.dte - b.dte);

  // Find the pair bracketing 30 DTE
  const nearIdx = (() => {
    let best = -1;
    for (let i = 0; i < expIvs.length; i++) {
      if (expIvs[i]!.dte <= 30) best = i;
    }
    return best;
  })();

  const farIdx = expIvs.findIndex(e => e.dte > 30);

  if (nearIdx === -1 && farIdx === -1) return null;

  // Only one side available — use it directly
  if (nearIdx === -1) {
    const far = expIvs[farIdx]!;
    return { atmIv: far.iv, expNear: null, expFar: far.exp, dteNear: null, dteFar: far.dte };
  }
  if (farIdx === -1) {
    const near = expIvs[nearIdx]!;
    return { atmIv: near.iv, expNear: near.exp, expFar: null, dteNear: near.dte, dteFar: null };
  }

  const near = expIvs[nearIdx]!;
  const far  = expIvs[farIdx]!;

  // Interpolate by DTE weight
  const dteDiff = far.dte - near.dte;
  if (dteDiff === 0) return { atmIv: (near.iv + far.iv) / 2, expNear: near.exp, expFar: far.exp, dteNear: near.dte, dteFar: far.dte };
  const weightNear = (far.dte - 30) / dteDiff;
  const weightFar  = 1 - weightNear;
  const atmIv = near.iv * weightNear + far.iv * weightFar;

  return { atmIv, expNear: near.exp, expFar: far.exp, dteNear: near.dte, dteFar: far.dte };
}

// ─── Service ──────────────────────────────────────────────────────────────────

type ConstituentRow = { ticker: string };

export class IvHistoryService {
  private cancelled = false;

  constructor(
    private readonly db: DbHandle,
    private readonly ivolatility: IVolatilityProvider,
    private readonly getConstituents: (u: 'sp500' | 'russell1000' | 'etf') => ConstituentRow[],
  ) {}

  // ── Storage ──────────────────────────────────────────────────────────────────

  storeReading(
    ticker: string,
    date: string,
    atmIv: number,
    meta: {
      underlyingPx?: number | null;
      expNear?: string | null;
      expFar?: string | null;
      dteNear?: number | null;
      dteFar?: number | null;
      source: string;
    },
  ): void {
    this.db.prepare(`
      INSERT INTO iv_history (ticker, date, atm_iv, underlying_px, exp_near, exp_far, dte_near, dte_far, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, date) DO UPDATE SET
        atm_iv       = excluded.atm_iv,
        underlying_px = excluded.underlying_px,
        exp_near     = excluded.exp_near,
        exp_far      = excluded.exp_far,
        dte_near     = excluded.dte_near,
        dte_far      = excluded.dte_far,
        source       = excluded.source
    `).run(
      ticker.toUpperCase(),
      date,
      atmIv,
      meta.underlyingPx ?? null,
      meta.expNear ?? null,
      meta.expFar  ?? null,
      meta.dteNear ?? null,
      meta.dteFar  ?? null,
      meta.source,
    );
  }

  // ── IV Rank / Percentile ──────────────────────────────────────────────────────

  /** All stored IV readings for a ticker, newest first. */
  getRows(ticker: string): Array<{ date: string; atm_iv: number; underlying_px: number | null; source: string }> {
    type Row = { date: string; atm_iv: number; underlying_px: number | null; source: string };
    return this.db.prepare(
      `SELECT date, atm_iv, underlying_px, source FROM iv_history WHERE ticker = ? ORDER BY date DESC`
    ).all(ticker.toUpperCase()) as Row[];
  }

  getIvRank(ticker: string): IvRankResult {
    type Row = { date: string; atm_iv: number };
    const rows = this.db.prepare(
      `SELECT date, atm_iv FROM iv_history WHERE ticker = ? ORDER BY date DESC LIMIT 252`
    ).all(ticker.toUpperCase()) as Row[];

    if (rows.length < 21) {
      return { ticker: ticker.toUpperCase(), ivRank: null, ivPercentile: null, currentIv: null, dataPoints: rows.length, oldestDate: rows.at(-1)?.date ?? null, newestDate: rows[0]?.date ?? null };
    }

    const ivs = rows.map(r => r.atm_iv);
    const currentIv = ivs[0]!;
    const minIv  = Math.min(...ivs);
    const maxIv  = Math.max(...ivs);
    const ivRank = maxIv === minIv ? 50 : ((currentIv - minIv) / (maxIv - minIv)) * 100;
    const ivPercentile = (ivs.filter(v => v < currentIv).length / ivs.length) * 100;

    return {
      ticker: ticker.toUpperCase(),
      ivRank:       Math.round(ivRank * 10) / 10,
      ivPercentile: Math.round(ivPercentile * 10) / 10,
      currentIv,
      dataPoints: rows.length,
      oldestDate: rows.at(-1)?.date ?? null,
      newestDate: rows[0]?.date ?? null,
    };
  }

  // ── Coverage stats ────────────────────────────────────────────────────────────

  getCoverage(universe: 'sp500' | 'russell1000' | 'both' | 'etf'): IvHistoryCoverage {
    type CountRow = { ticker: string; cnt: number };

    const universes: Array<'sp500' | 'russell1000' | 'etf'> =
      universe === 'both' ? ['sp500', 'russell1000'] : [universe];

    const tickers = new Set<string>();
    for (const u of universes) {
      for (const r of this.getConstituents(u)) tickers.add(r.ticker.toUpperCase());
    }

    const rows = this.db.prepare(
      `SELECT ticker, COUNT(*) as cnt FROM iv_history WHERE ticker IN (${
        [...tickers].map(() => '?').join(',')
      }) GROUP BY ticker`
    ).all(...[...tickers]) as CountRow[];

    const countsByTicker = new Map(rows.map(r => [r.ticker, r.cnt]));

    let complete = 0, partial = 0, none = 0;
    for (const t of tickers) {
      const cnt = countsByTicker.get(t) ?? 0;
      if (cnt >= 252) complete++;
      else if (cnt > 0) partial++;
      else none++;
    }

    type LastRow = { last_date: string | null };
    const lastRow = this.db.prepare(
      `SELECT MAX(date) as last_date FROM iv_history WHERE ticker IN (${
        [...tickers].map(() => '?').join(',')
      })`
    ).get(...[...tickers]) as LastRow | undefined;

    type TotalRow = { total: number };
    const totalRow = this.db.prepare(`SELECT COUNT(*) as total FROM iv_history`).get() as TotalRow;

    return {
      complete,
      partial,
      none,
      lastRefreshDate: lastRow?.last_date ?? null,
      totalReadings: totalRow.total,
    };
  }

  // ── Gap detection ─────────────────────────────────────────────────────────────

  getGaps(universe: 'sp500' | 'russell1000' | 'both' | 'etf'): { pairs: Array<{ ticker: string; date: string }>; summary: IvHistoryGapSummary } {
    const universes: Array<'sp500' | 'russell1000' | 'etf'> =
      universe === 'both' ? ['sp500', 'russell1000'] : [universe];

    const tickers = new Set<string>();
    for (const u of universes) {
      for (const r of this.getConstituents(u)) tickers.add(r.ticker.toUpperCase());
    }

    if (tickers.size === 0) return { pairs: [], summary: { missingDays: 0, missingPairs: 0, oldestGapDate: null, newestGapDate: null, estimatedCalls: 0 } };

    type MaxRow = { ticker: string; max_date: string | null };
    const tickerArr = [...tickers];
    const maxRows = this.db.prepare(
      `SELECT ticker, MAX(date) as max_date FROM iv_history WHERE ticker IN (${
        tickerArr.map(() => '?').join(',')
      }) GROUP BY ticker`
    ).all(...tickerArr) as MaxRow[];

    const maxByTicker = new Map(maxRows.map(r => [r.ticker, r.max_date]));

    // For tickers with no history, start from 252 trading days ago
    const backfillStart = tradingDaysAgo(252);
    const yesterday = yesterdayET();

    const pairs: Array<{ ticker: string; date: string }> = [];
    const missingDates = new Set<string>();

    for (const ticker of tickers) {
      const maxDate = maxByTicker.get(ticker) ?? null;
      const fromDate = maxDate
        ? (() => {
            // Day after maxDate
            const d = new Date(maxDate + 'T12:00:00Z');
            d.setUTCDate(d.getUTCDate() + 1);
            return d.toISOString().slice(0, 10);
          })()
        : backfillStart;

      if (fromDate > yesterday) continue;

      const days = tradingDaysInRange(fromDate, yesterday);
      for (const date of days) {
        pairs.push({ ticker, date });
        missingDates.add(date);
      }
    }

    // Sort by date ascending, then ticker
    pairs.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

    const sortedDates = [...missingDates].sort();

    return {
      pairs,
      summary: {
        missingDays:    missingDates.size,
        missingPairs:   pairs.length,
        oldestGapDate:  sortedDates[0] ?? null,
        newestGapDate:  sortedDates.at(-1) ?? null,
        estimatedCalls: pairs.length,
      },
    };
  }

  // ── Initial backfill ──────────────────────────────────────────────────────────

  /** Returns the list of tickers for the given phase (Russell skips tickers already in iv_history). */
  private getBackfillTickers(phase: IvHistoryBackfillPhase): string[] {
    if (phase === 'initial_sp500') {
      return this.getConstituents('sp500').map(r => r.ticker.toUpperCase());
    }
    if (phase === 'initial_russell') {
      const sp500 = new Set(this.getConstituents('sp500').map(r => r.ticker.toUpperCase()));
      const russell = this.getConstituents('russell1000').map(r => r.ticker.toUpperCase());
      // Skip tickers that are in S&P 500 (already have history)
      type HasRow = { ticker: string };
      const existingRows = this.db.prepare(
        `SELECT DISTINCT ticker FROM iv_history WHERE ticker IN (${
          [...sp500].map(() => '?').join(',')
        })`
      ).all(...[...sp500]) as HasRow[];
      const hasHistory = new Set(existingRows.map(r => r.ticker));
      return russell.filter(t => !hasHistory.has(t));
    }
    if (phase === 'initial_etf') {
      return this.getConstituents('etf').map(r => r.ticker.toUpperCase());
    }
    return []; // gap_fill handled separately
  }

  cancel(): void { this.cancelled = true; }

  /**
   * Determine the earliest date to fetch for a ticker.
   * If we have existing data, start from the day after the latest reading.
   * Otherwise start from `fallback` (252 trading days ago).
   */
  private tickerFromDate(ticker: string, fallback: string): string {
    type Row = { max_date: string | null };
    const row = this.db.prepare(
      `SELECT MAX(date) as max_date FROM iv_history WHERE ticker = ?`
    ).get(ticker) as Row | undefined;
    const maxDate = row?.max_date ?? null;
    return maxDate ? nextDay(maxDate) : fallback;
  }

  async runBackfill(
    phase: IvHistoryBackfillPhase,
    onProgress: (evt: IvHistoryProgressEvent) => void,
  ): Promise<{ processed: number; skipped: number; failed: number }> {
    this.cancelled = false;

    const backfillStart = tradingDaysAgo(252);
    const yesterday     = yesterdayET();

    // Build per-ticker work list: { ticker, from, to }
    // IVolatility fetches an entire date range in one call — no per-day loop.
    let tickerWork: Array<{ ticker: string; from: string }>;

    if (phase === 'gap_fill') {
      const sp500    = this.getConstituents('sp500').map(r => r.ticker.toUpperCase());
      const russell  = this.getConstituents('russell1000').map(r => r.ticker.toUpperCase());
      const etf      = this.getConstituents('etf').map(r => r.ticker.toUpperCase());
      const allTickers = [...new Set([...sp500, ...russell, ...etf])];
      tickerWork = allTickers
        .map(ticker => ({ ticker, from: this.tickerFromDate(ticker, backfillStart) }))
        .filter(w => w.from <= yesterday);
    } else {
      const tickers = this.getBackfillTickers(phase);
      tickerWork = tickers.map(ticker => ({
        ticker,
        from: this.tickerFromDate(ticker, backfillStart),
      })).filter(w => w.from <= yesterday);
    }

    const total = tickerWork.length;
    // processed = tickers where ≥1 row stored; skipped = no data; failed = API error
    let processed = 0, skipped = 0, failed = 0;
    const startMs = Date.now();

    // Throttle: IVolatility allows 1 req/sec sustained (burst 5), 20k req/month.
    // 1,100ms between calls = ~55/min — stays safely under the 1/sec limit.
    // On 429, back off 15 s before retrying once.
    const CALL_DELAY_MS = 1_100;

    for (const { ticker, from } of tickerWork) {
      if (this.cancelled) break;

      let lastError: string | undefined;

      try {
        const result = await this.ivolatility.getIvx(ticker, from, yesterday);

        if (result.s === 'no_data' || result.rows.length === 0) {
          skipped++;
        } else {
          let rowsStored = 0;
          for (const row of result.rows) {
            if (row.iv30 === null) continue;
            // IVolatility returns decimal fractions (0.285 = 28.5%) — convert to pct before storing.
            // see docs/formulas.md#atm-iv-storage
            this.storeReading(ticker, row.date, row.iv30 * 100, { source: 'ivolatility' });
            rowsStored++;
          }
          if (rowsStored > 0) processed++;
          else skipped++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;

        // 429 rate-limit: wait 15 s and retry once before counting as failure
        if (msg.includes('429')) {
          console.warn(`[iv-history] 429 on ${ticker} — pausing 15 s`);
          await new Promise(r => setTimeout(r, 15_000));
          try {
            const retry = await this.ivolatility.getIvx(ticker, from, yesterday);
            if (retry.s !== 'no_data' && retry.rows.length > 0) {
              let rowsStored = 0;
              for (const row of retry.rows) {
                if (row.iv30 === null) continue;
                this.storeReading(ticker, row.date, row.iv30 * 100, { source: 'ivolatility' });
                rowsStored++;
              }
              if (rowsStored > 0) { processed++; lastError = undefined; }
              else skipped++;
            } else {
              skipped++;
              lastError = undefined;
            }
          } catch (retryErr) {
            lastError = retryErr instanceof Error ? retryErr.message : String(retryErr);
            failed++;
          }
        } else {
          failed++;
        }
      }

      const done = processed + skipped + failed;
      const elapsedMin = (Date.now() - startMs) / 60_000;
      const callsPerMin = elapsedMin > 0 ? Math.round(done / elapsedMin) : 0;

      onProgress({ phase, ticker, date: yesterday, processed, total, skipped, failed, callsPerMin, lastError });

      // Throttle between calls
      if (!this.cancelled) await new Promise(r => setTimeout(r, CALL_DELAY_MS));
    }

    return { processed, skipped, failed };
  }

  // ── E*Trade auto-capture ──────────────────────────────────────────────────────

  /**
   * Silently store today's ATM IV from an E*Trade options chain.
   * Called automatically whenever the app fetches a chain — no extra API cost.
   */
  captureFromEtradeChain(
    ticker: string,
    contracts: OptionContract[],
    underlyingPx: number | null,
  ): void {
    if (!underlyingPx || contracts.length === 0) return;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (!isTradingDay(today)) return;

    // Map OptionContract → the shape computeAtmIv expects
    const mapped = contracts.map(c => ({
      expiration: c.expiration,
      strike:     c.strike,
      side:       c.side as 'call' | 'put',
      iv:         c.iv,  // OptionContract.iv is already a percentage (28.5) — pass as-is so computeAtmIv works in pct space
      dte:        (() => {
        const exp = new Date(c.expiration + 'T00:00:00Z');
        return Math.max(0, Math.round((exp.getTime() - Date.now()) / 86_400_000));
      })(),
    }));

    const result = computeAtmIv(mapped, underlyingPx);
    if (!result) return;

    // Don't overwrite an existing IVolatility reading for today (higher quality)
    type ExRow = { source: string } | undefined;
    const existing = this.db.prepare(
      `SELECT source FROM iv_history WHERE ticker = ? AND date = ?`
    ).get(ticker.toUpperCase(), today) as ExRow;
    if (existing?.source === 'ivolatility') return;

    this.storeReading(ticker, today, result.atmIv, {
      underlyingPx,
      expNear: result.expNear,
      expFar:  result.expFar,
      dteNear: result.dteNear,
      dteFar:  result.dteFar,
      source: 'etrade',
    });
  }

  // ── Initial load status ───────────────────────────────────────────────────────

  getInitialLoadStatus(): {
    sp500:   { complete: boolean; completedAt: string | null };
    russell: { complete: boolean; completedAt: string | null; newTickers: number };
    etf:     { complete: boolean; completedAt: string | null; totalTickers: number };
  } {
    const sp500Tickers = this.getConstituents('sp500').map(r => r.ticker.toUpperCase());
    const russell1000Tickers = this.getConstituents('russell1000').map(r => r.ticker.toUpperCase());
    const etfTickers = this.getConstituents('etf').map(r => r.ticker.toUpperCase());

    type CovRow = { ticker: string; cnt: number; max_date: string | null };

    const sp500Coverage = sp500Tickers.length > 0
      ? this.db.prepare(
          `SELECT ticker, COUNT(*) as cnt, MAX(date) as max_date FROM iv_history WHERE ticker IN (${
            sp500Tickers.map(() => '?').join(',')
          }) GROUP BY ticker`
        ).all(...sp500Tickers) as CovRow[]
      : [];

    const sp500Complete = sp500Coverage.filter(r => r.cnt >= 20).length >= sp500Tickers.length * 0.9;
    const sp500Date = sp500Coverage.length > 0
      ? sp500Coverage.reduce((best, r) => (r.max_date ?? '') > (best.max_date ?? '') ? r : best).max_date
      : null;

    const sp500Set = new Set(sp500Tickers);
    const russellUnique = russell1000Tickers.filter(t => !sp500Set.has(t));
    const russellCoverage = russellUnique.length > 0
      ? this.db.prepare(
          `SELECT ticker, COUNT(*) as cnt, MAX(date) as max_date FROM iv_history WHERE ticker IN (${
            russellUnique.map(() => '?').join(',')
          }) GROUP BY ticker`
        ).all(...russellUnique) as CovRow[]
      : [];

    const russellComplete = russellCoverage.filter(r => r.cnt >= 20).length >= russellUnique.length * 0.9;
    const russellDate = russellCoverage.length > 0
      ? russellCoverage.reduce((best, r) => (r.max_date ?? '') > (best.max_date ?? '') ? r : best).max_date
      : null;

    const etfCoverage = etfTickers.length > 0
      ? this.db.prepare(
          `SELECT ticker, COUNT(*) as cnt, MAX(date) as max_date FROM iv_history WHERE ticker IN (${
            etfTickers.map(() => '?').join(',')
          }) GROUP BY ticker`
        ).all(...etfTickers) as CovRow[]
      : [];

    const etfComplete = etfCoverage.filter(r => r.cnt >= 20).length >= etfTickers.length * 0.9;
    const etfDate = etfCoverage.length > 0
      ? etfCoverage.reduce((best, r) => (r.max_date ?? '') > (best.max_date ?? '') ? r : best).max_date
      : null;

    return {
      sp500:   { complete: sp500Complete,   completedAt: sp500Date },
      russell: { complete: russellComplete, completedAt: russellDate, newTickers: russellUnique.length },
      etf:     { complete: etfComplete,     completedAt: etfDate,    totalTickers: etfTickers.length },
    };
  }
}
