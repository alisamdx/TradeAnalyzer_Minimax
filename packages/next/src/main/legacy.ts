import { currentDb } from './generation.js';
import type { LegacyRunDto, LegacyCandidateDto, LegacySummaryDto } from '../shared/types.js';

/**
 * The Legacy view's main-process half — 05, B8.
 *
 * **Every table and column name lives here** (AC-13); what crosses the bridge
 * is a UI vocabulary.
 *
 * The view exists to make one distinction impossible to miss: rows **handed
 * over live** carry every candidate the brief scored, and rows **imported
 * backwards** are survivors-only and incomplete. Pooling them silently would
 * put a biased sample and an unbiased one in the same chart, so the split is
 * the first thing the screen shows rather than a footnote.
 */

const RUNS = 'legacy_brief_run';
const CANDIDATES = 'legacy_brief_candidate';

/**
 * The counts that decide whether a study of this data is possible at all.
 *
 * `withLosers` is the number that matters: a run holding only survivors cannot
 * answer whether the ranking was any good, however many of them there are.
 */
export function legacySummary(): LegacySummaryDto {
  const rows = currentDb()
    .prepare(
      `SELECT r.pre_collector AS imported,
              COUNT(DISTINCT r.legacy_run_id) AS runs,
              COUNT(c.row_id) AS candidates,
              SUM(CASE WHEN c.survived = 0 THEN 1 ELSE 0 END) AS losers
         FROM ${RUNS} r
         LEFT JOIN ${CANDIDATES} c ON c.legacy_run_id = r.legacy_run_id
        GROUP BY r.pre_collector`
    )
    .all() as { imported: number; runs: number; candidates: number; losers: number | null }[];

  const of = (imported: number) => rows.find((r) => r.imported === imported);
  const live = of(0);
  const back = of(1);

  return {
    live: {
      runs: live?.runs ?? 0,
      candidates: live?.candidates ?? 0,
      losers: live?.losers ?? 0
    },
    imported: {
      runs: back?.runs ?? 0,
      candidates: back?.candidates ?? 0,
      losers: back?.losers ?? 0
    }
  };
}

export function legacyRuns(): readonly LegacyRunDto[] {
  const rows = currentDb()
    .prepare(
      `SELECT r.legacy_run_id AS id, r.trading_date AS date, r.slot AS slot,
              r.pre_collector AS imported, r.legacy_app_version AS appVersion,
              COUNT(c.row_id) AS candidates,
              SUM(CASE WHEN c.survived = 1 THEN 1 ELSE 0 END) AS survivors
         FROM ${RUNS} r
         LEFT JOIN ${CANDIDATES} c ON c.legacy_run_id = r.legacy_run_id
        GROUP BY r.legacy_run_id
        ORDER BY r.trading_date DESC, r.slot`
    )
    .all() as {
    id: string; date: string; slot: string; imported: number;
    appVersion: string; candidates: number; survivors: number | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    phase: r.slot,
    imported: r.imported === 1,
    appVersion: r.appVersion,
    candidates: r.candidates,
    survivors: r.survivors ?? 0,
    // Computed here rather than in the renderer: "how many did it reject" is
    // the question this whole table exists to answer, and a view that made the
    // reader subtract would bury it.
    rejected: r.candidates - (r.survivors ?? 0)
  }));
}

/**
 * One run's candidates, **rejected ones included and marked**.
 *
 * Ordered by the rank the brief considered them at, so the cut is visible as a
 * position in the list rather than as a flag to be filtered on.
 */
export function legacyCandidates(runId: string): readonly LegacyCandidateDto[] {
  const rows = currentDb()
    .prepare(
      `SELECT c.row_id AS rowId, c.ticker AS ticker, c.mode AS mode,
              c.considered_rank AS rank, c.survived AS survived,
              c.composite_score AS score, c.composite_score_status AS scoreStatus,
              c.final_disposition AS disposition,
              (SELECT COUNT(*) FROM legacy_brief_candidate_gate g
                WHERE g.candidate_row_id = c.row_id AND g.passed = 0) AS gatesFailed,
              (SELECT g.reason FROM legacy_brief_candidate_gate g
                WHERE g.candidate_row_id = c.row_id AND g.passed = 0
                ORDER BY g.row_id LIMIT 1) AS firstFailure
         FROM ${CANDIDATES} c
        WHERE c.legacy_run_id = ?
        ORDER BY c.mode, c.considered_rank`
    )
    .all(runId) as {
    rowId: number; ticker: string; mode: string; rank: number; survived: number;
    score: number | null; scoreStatus: string; disposition: string | null;
    gatesFailed: number; firstFailure: string | null;
  }[];

  return rows.map((r) => ({
    rowId: r.rowId,
    ticker: r.ticker,
    strategy: r.mode,
    rank: r.rank,
    picked: r.survived === 1,
    score: r.score,
    // The status travels with the value, so a missing score is shown as a
    // declared gap rather than as a blank the reader has to interpret.
    scoreStatus: r.scoreStatus,
    disposition: r.disposition,
    gatesFailed: r.gatesFailed,
    firstFailure: r.firstFailure
  }));
}
