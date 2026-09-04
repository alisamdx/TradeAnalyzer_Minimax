// Persist the whole Stage-4 candidate pool — including the candidates that did NOT survive.
//
// The brief keeps only the top `PICKS_PER_STRATEGY` of a `STAGE4_POOL_SIZE` pool, so the cut
// itself has never been measurable: when a ranking's quality is in question, the losers are the
// data you need, and this pipeline threw them away. That matters now because the wheel composite
// was found anti-predictive at the top (v1.1.173) and this cut is where that would bite.
//
// Deliberately slim. `daily_briefs` averages 147.7 KB per row because it stores the full
// strategyLabResult per pick, which is why it is pruned at 90 days and why every study in this
// project reports "one regime". These rows carry only what a settlement study needs, so they can
// outlive that window at roughly 1/70th the storage.
//
// Outcomes are NOT stored: they are derived later by settling strike/premium against
// `historical_prices`, so a subsequent split repair corrects them instead of leaving a frozen
// wrong number. `spot` is stored precisely because the split scale guard needs the underlying at
// pick time, and that is the one input a repair makes unrecoverable.
//
// see migrations/076_brief_candidates.sql, docs/wheel-parameters.md

import type { DbHandle } from '../db/connection.js';

export type CandidateDisposition = 'picked' | 'capped_out' | 'failed_liquidity' | 'not_validated';

export interface BriefCandidateRow {
  asOfDate: string;
  generatedAt: string;
  strategy: string;
  ticker: string;
  compositeScore: number;
  rank: number;
  disposition: CandidateDisposition;
  structureSlug: string | null;
  strike: number | null;
  premium: number | null;
  expiration: string | null;
  dte: number | null;
  liquidityScore: number | null;
  spot: number | null;
}

/**
 * Replace this run's candidate rows.
 *
 * INSERT OR REPLACE on (as_of_date, strategy, ticker): the batch runs twice a trading day and the
 * after-close slot must overwrite what the morning wrote, exactly like every other job.
 * see CLAUDE.md "the batch runs twice a trading day"
 *
 * Never throws — this is instrumentation, and a study convenience must not be able to fail the
 * brief that produces the actual recommendations.
 */
export function saveBriefCandidates(db: DbHandle, rows: readonly BriefCandidateRow[]): number {
  if (rows.length === 0) return 0;
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO brief_candidates
        (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition,
         structure_slug, strike, premium, expiration, dte, liquidity_score, spot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = db.transaction((batch: readonly BriefCandidateRow[]) => {
      for (const r of batch) {
        stmt.run(
          r.asOfDate, r.generatedAt, r.strategy, r.ticker, r.compositeScore, r.rank, r.disposition,
          r.structureSlug, r.strike, r.premium, r.expiration, r.dte, r.liquidityScore, r.spot,
        );
      }
    });
    run(rows);
    return rows.length;
  } catch (err) {
    console.warn('[brief candidates] persist failed:',
      err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/**
 * Prune candidate rows older than `retentionDays`.
 *
 * Default 730 days rather than the briefs' 90: the whole point is a sample that spans more than
 * one regime, and at ~3.4 MB per trading year two years costs single-digit megabytes. Pruning
 * exists only so the table cannot grow without bound.
 */
export function pruneBriefCandidates(db: DbHandle, retentionDays = 730): number {
  try {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
    return db.prepare('DELETE FROM brief_candidates WHERE as_of_date < ?').run(cutoff).changes;
  } catch (err) {
    console.warn('[brief candidates] prune failed:',
      err instanceof Error ? err.message : String(err));
    return 0;
  }
}
