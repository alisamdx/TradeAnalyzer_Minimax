// Persist the whole Stage-4 candidate pool — including the candidates that did NOT survive.
//
// The brief keeps only the top `PICKS_PER_STRATEGY` of a `STAGE4_POOL_SIZE` pool, so the cut
// itself has never been measurable: when a ranking's quality is in question, the losers are the
// data you need, and this pipeline threw them away. That matters now because the wheel composite
// was found anti-predictive at the top (v1.1.173) and this cut is where that would bite.
//
// Slim relative to a brief, deliberately broad within that. `daily_briefs` averages 147.7 KB per
// row because it stores the full strategyLabResult per pick, which is why it is pruned at 90 days
// and why every study in this project reports "one regime". These rows cost ~20 MB per trading
// year against the briefs' ~229 MB, so they outlive that window cheaply.
//
// The column set goes beyond what the top-5-cut question strictly needs, because CAPTURE IS
// ONE-DIRECTIONAL — what is not written today cannot be recovered. Three studies here were
// blocked by capture rather than analysis: the liquidity A/B ran on income because wheel rows had
// no bid/ask/open_interest until v1.1.132, the ETF gate was unsatisfiable because no ETF outcome
// had ever been generated, and this cut discarded its losers. `signals_json` in particular
// answers the follow-up every study ended on — WHICH signal — instead of leaving it inferred, and
// `earnings_date` makes the earnings gate testable for the first time: it is the one rule here
// that no study has ever been able to evaluate, because `earnings_calendar` has no history and
// `analysis_snapshots.daysToEarnings` is null on every row.
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
  /** Per-signal {raw, normalized, weight, missing}, same shape daily_briefs keeps for picks. */
  signalsJson: string | null;
  structureSlug: string | null;
  grade: string | null;
  strike: number | null;
  premium: number | null;
  expiration: string | null;
  dte: number | null;
  liquidityScore: number | null;
  spot: number | null;
  // Short-leg option economics — delta because v1.1.171 showed it drives outcomes; bid/ask/OI
  // because their absence on wheel rows is what forced the v1.1.170 liquidity A/B onto income.
  delta: number | null;
  legIv: number | null;
  bid: number | null;
  ask: number | null;
  openInterest: number | null;
  // Trade economics as the lab computed them.
  netCredit: number | null;
  maxLoss: number | null;
  annualizedReturn: number | null;
  popEstimate: number | null;
  atmIv: number | null;
  /** Next report date as KNOWN ON THE PICK DATE, and the gap in days. Null means unknown or
   *  stale — the same fail-closed state `roll-the-dice.ts` treats as "reject", never as "clear".
   *  This is the only way the earnings gate ever becomes testable: `earnings_calendar` keeps one
   *  row per ticker with no history, so a replay sees today's date rather than that day's. */
  earningsDate: string | null;
  daysToEarnings: number | null;
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
         signals_json, structure_slug, grade, strike, premium, expiration, dte, liquidity_score,
         spot, delta, leg_iv, bid, ask, open_interest,
         net_credit, max_loss, annualized_return, pop_estimate, atm_iv,
         earnings_date, days_to_earnings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const run = db.transaction((batch: readonly BriefCandidateRow[]) => {
      for (const r of batch) {
        stmt.run(
          r.asOfDate, r.generatedAt, r.strategy, r.ticker, r.compositeScore, r.rank, r.disposition,
          r.signalsJson, r.structureSlug, r.grade, r.strike, r.premium, r.expiration, r.dte,
          r.liquidityScore, r.spot, r.delta, r.legIv, r.bid, r.ask, r.openInterest,
          r.netCredit, r.maxLoss, r.annualizedReturn, r.popEstimate, r.atmIv,
          r.earningsDate, r.daysToEarnings,
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
 * one regime, and at ~20 MB per trading year two years costs ~40 MB against a database already
 * past 500 MB. Pruning exists only so the table cannot grow without bound.
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
