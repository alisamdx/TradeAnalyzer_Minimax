/**
 * The BPS-2 pool-selection panel — what `scripts/fr-spread-pool-selection-study.mjs` reads, served
 * through GET /diagnostics/pool-selection-panel so the study runs against the live app instead of
 * opening `trade-analyzer.sqlite` itself (which a redirected shell, such as the Claude app's, must
 * never do — CLAUDE.md). Same pattern as spread-study-panel (v1.1.338) and spread-capture-panel
 * (v1.1.339).
 *
 * Returns what the study's SQL selected, reduced the way the study reduces it:
 *   • `snapshots` — one wheel `analysis_snapshots` payload per DATE, the latest `run_at` winning (the
 *     batch runs twice a day), each row projected to the eight fields the study reads. An unparsable
 *     payload is kept as an empty date, as the study skipped it. A non-object row is kept (it counts
 *     toward the study's raw-row total and then fails its structure check), never dropped.
 *   • `series` — each snapshot ticker's closes from SERIES_LOOKBACK_DAYS before the earliest snapshot.
 *     The study's signals look back by bar index (SMA200 at most), and 400 calendar days is ~275
 *     sessions, so every lookback on every snapshot date sees the same bars as the full series.
 *
 * Read-only: SELECTs only.
 */

import type { PanelDb } from './settled-csp-panel';

export const SERIES_LOOKBACK_DAYS = 400;

export interface PoolRow {
  readonly ticker: string | null;
  readonly recommendedStrike: number | null;
  readonly premium: number | null;
  readonly expiration: string | null;
  readonly lastPrice: number | null;
  readonly optionLiquidityScore: number | null;
  readonly ivRank: number | null;
  readonly annualizedReturn: number | null;
}

export interface PoolSelectionPanel {
  readonly maxPx: string | null;
  readonly snapshots: readonly { date: string; rows: readonly PoolRow[] }[];
  /** ticker → [date, close][] ascending. */
  readonly series: Readonly<Record<string, readonly (readonly [string, number])[]>>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function project(x: unknown): PoolRow {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
  return {
    ticker: str(o.ticker),
    recommendedStrike: num(o.recommendedStrike),
    premium: num(o.premium),
    expiration: str(o.expiration),
    lastPrice: num(o.lastPrice),
    optionLiquidityScore: num(o.optionLiquidityScore),
    ivRank: num(o.ivRank),
    annualizedReturn: num(o.annualizedReturn)
  };
}

function addDays(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export function poolSelectionPanel(db: PanelDb): PoolSelectionPanel {
  const maxPx = (db.prepare('SELECT MAX(date) AS d FROM historical_prices').get() as { d: string | null } | undefined)?.d ?? null;

  // Latest run per date wins — iterate in run_at order and overwrite, exactly as the study did.
  const perDate = new Map<string, string>();
  for (const r of db.prepare(
    `SELECT run_at, payload_json FROM analysis_snapshots WHERE mode = 'wheel' ORDER BY run_at`
  ).all() as { run_at: string; payload_json: string }[]) {
    perDate.set(r.run_at.slice(0, 10), r.payload_json);
  }

  const snapshots: { date: string; rows: PoolRow[] }[] = [];
  const tickers = new Set<string>();
  for (const [date, payload] of perDate) {
    let p: unknown;
    try { p = JSON.parse(payload); } catch { snapshots.push({ date, rows: [] }); continue; }
    const list: unknown[] = Array.isArray(p)
      ? p
      : Array.isArray((p as { results?: unknown } | null)?.results) ? (p as { results: unknown[] }).results : [];
    const rows = list.map(project);
    for (const r of rows) if (r.ticker) tickers.add(r.ticker);
    snapshots.push({ date, rows });
  }

  const series: Record<string, (readonly [string, number])[]> = {};
  const first = snapshots.length ? snapshots.map(s => s.date).sort()[0]! : null;
  if (first !== null) {
    const from = addDays(first, -SERIES_LOOKBACK_DAYS);
    const stmt = db.prepare('SELECT date, close FROM historical_prices WHERE ticker = ? AND date >= ? ORDER BY date');
    for (const t of tickers) {
      series[t] = (stmt.all(t, from) as { date: string; close: number }[]).map(b => [b.date, b.close] as const);
    }
  }

  return { maxPx, snapshots, series };
}
