/**
 * The bull-put-spread study panel — everything `scripts/fr-bull-put-spread-study.mjs` reads, served
 * through GET /diagnostics/spread-study-panel so the study runs against the live app instead of
 * opening `trade-analyzer.sqlite` itself.
 *
 * The script opened the production database write-capable from its own shell. Inside the Claude app
 * that shell is MSIX-redirected, so its redirect guard (correctly) refused, and the study could only
 * run from a separate terminal (CLAUDE.md: "Opening a WAL database from a redirected shell MOVES it").
 * Same fix as settled-csp-panel (v1.1.267) and the wheel A/B (v1.1.220).
 *
 * Returns the rows the script's SQL selected, unchanged in meaning: replay picks, per-ticker bars over
 * the span the study can touch, per-ticker iv_history, and — when asked — the three quote sources the
 * quoted-slippage model reads. A quote table that cannot be read is `null` (the script prints it as
 * unavailable), never an empty list, so "no table" and "no rows" stay distinguishable.
 *
 * Read-only: SELECTs only.
 */

import type { PanelDb } from './settled-csp-panel';

/** Calendar days of bars before a pick the study reads (its 20-day vol and SMA50 lookbacks). */
export const BARS_BEFORE_DAYS = 90;
/** Calendar days after a pick: MAX_DTE (35) + 40, the reuse test's look past the window. */
export const BARS_AFTER_DAYS = 75;

export interface SpreadStudyPick {
  readonly ticker: string;
  readonly date: string;
  readonly rank: number;
}

/** [date, close, volume] — compact, since a run carries ~150k bars. */
export type StudyBar = readonly [string, number, number | null];
/** [date, atm_iv] exactly as stored (the script normalises percent vs decimal per row). */
export type StudyIv = readonly [string, number];

export interface SpreadStudyQuotes {
  readonly briefCandidates: readonly { ticker: string; bid: number; ask: number; slot: string | null }[] | null;
  readonly spreadChains: readonly { ticker: string; slot: string | null; puts_json: string }[] | null;
  readonly premiumHistory: readonly { ticker: string; bid: number; ask: number }[] | null;
}

export interface SpreadStudyPanel {
  readonly strategy: string;
  readonly maxPx: string | null;
  readonly picks: readonly SpreadStudyPick[];
  readonly bars: Readonly<Record<string, readonly StudyBar[]>>;
  readonly iv: Readonly<Record<string, readonly StudyIv[]>>;
  readonly quotes: SpreadStudyQuotes | null;
}

function addDays(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function tryAll<T>(db: PanelDb, sql: string): T[] | null {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return null;
  }
}

export function spreadStudyPanel(db: PanelDb, strategy: string, includeQuotes: boolean): SpreadStudyPanel {
  const picks = db
    .prepare(
      `SELECT ro.ticker AS ticker, rb.as_of_date AS date, MIN(ro.rank) AS rank
         FROM replay_outcomes ro JOIN replay_briefs rb ON rb.id = ro.replay_brief_id
        WHERE rb.strategy = ? GROUP BY ro.ticker, rb.as_of_date ORDER BY ro.ticker, rb.as_of_date`
    )
    .all(strategy) as SpreadStudyPick[];
  const maxPx = (db.prepare('SELECT MAX(date) AS d FROM historical_prices').get() as { d: string | null } | undefined)?.d ?? null;

  // Per ticker, the union of every pick's [date − 90, date + 75] — one query per ticker.
  const span = new Map<string, { lo: string; hi: string }>();
  for (const p of picks) {
    const s = span.get(p.ticker);
    if (!s) span.set(p.ticker, { lo: p.date, hi: p.date });
    else {
      if (p.date < s.lo) s.lo = p.date;
      if (p.date > s.hi) s.hi = p.date;
    }
  }
  const barsStmt = db.prepare(
    'SELECT date, close, volume FROM historical_prices WHERE ticker = ? AND date >= ? AND date <= ? AND close > 0 ORDER BY date'
  );
  const ivStmt = db.prepare('SELECT date, atm_iv FROM iv_history WHERE ticker = ? AND atm_iv > 0 ORDER BY date');
  const bars: Record<string, StudyBar[]> = {};
  const iv: Record<string, StudyIv[]> = {};
  for (const [ticker, s] of span) {
    bars[ticker] = (barsStmt.all(ticker, addDays(s.lo, -BARS_BEFORE_DAYS), addDays(s.hi, BARS_AFTER_DAYS)) as {
      date: string; close: number; volume: number | null;
    }[]).map((b) => [b.date, b.close, b.volume] as const);
    iv[ticker] = (ivStmt.all(ticker) as { date: string; atm_iv: number }[]).map((r) => [r.date, r.atm_iv] as const);
  }

  const quotes: SpreadStudyQuotes | null = includeQuotes
    ? {
        briefCandidates: tryAll(db, 'SELECT ticker, bid, ask, slot FROM brief_candidates WHERE bid > 0 AND ask > 0'),
        spreadChains: tryAll(db, 'SELECT ticker, slot, puts_json FROM spread_chain_capture'),
        premiumHistory: tryAll(db, 'SELECT ticker, bid, ask FROM options_premium_history WHERE bid > 0 AND ask > 0')
      }
    : null;

  return { strategy, maxPx, picks, bars, iv, quotes };
}
