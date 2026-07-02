// Structure-liquidity instrumentation (NEW_FRONTIER §11) — persists every Stage-4
// Strategy Lab liquidity measurement so intraday (≈10:15) vs after-close (≈17:00)
// pairs accumulate across days. Motivation: the evening brief deletes the same-day
// morning brief rows (ScoringService.storeBrief), which destroyed the intraday
// measurements; the artifact study had only 19 paired observations from one date.
// Pure instrumentation — nothing on the live path reads this table.
// Analysis: scripts/fr-liquidity-slot-comparison.mjs (slot bucketed from captured_at).

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';

const RETENTION_DAYS = 120;

export interface StructureLiquidityRow {
  ticker: string;
  slug: string;
  liquidityScore: number | null;
  grade: string | null;
  noBidLeg: boolean;
}

// Minimal lab-result shape (subset of StrategyLabValidateResult).
interface LabScoreLike {
  slug: string;
  grade?: string;
  liquidityScore?: number;
  setup: { unavailableReason?: string | null; legs?: Array<{ bid?: number | null }> } | null;
}

/** Rows worth logging from a lab result: constructible (non-unavailable) structures only. */
export function extractLoggableScores(ticker: string, labResult: object | null): StructureLiquidityRow[] {
  const scores = (labResult as { scores?: LabScoreLike[] } | null)?.scores;
  if (!Array.isArray(scores)) return [];
  const rows: StructureLiquidityRow[] = [];
  for (const s of scores) {
    if (!s.setup || s.setup.unavailableReason) continue;
    rows.push({
      ticker,
      slug: s.slug,
      liquidityScore: s.liquidityScore ?? null,
      grade: s.grade ?? null,
      noBidLeg: (s.setup.legs ?? []).some((l) => (l.bid ?? 0) <= 0),
    });
  }
  return rows;
}

/** Append measurements for one validated ticker (single transaction). */
export function logStructureLiquidity(db: DbHandle, rows: StructureLiquidityRow[]): void {
  if (rows.length === 0) return;
  const capturedAt = new Date().toISOString();
  const dateEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  withTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT INTO structure_liquidity_log (captured_at, date_et, ticker, slug, liquidity_score, grade, no_bid_leg)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of rows) {
      stmt.run(capturedAt, dateEt, r.ticker.toUpperCase(), r.slug, r.liquidityScore, r.grade, r.noBidLeg ? 1 : 0);
    }
  });
}

/** Drop rows older than the retention window (called once per brief run). */
export function pruneStructureLiquidityLog(db: DbHandle, retentionDays = RETENTION_DAYS): void {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.prepare(`DELETE FROM structure_liquidity_log WHERE captured_at < ?`).run(cutoff);
}
