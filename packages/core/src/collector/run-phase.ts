import type { SqliteLike } from '../db/sqlite-like.js';

/**
 * Phase outcomes of a daily run, recorded in `meta_run_phase` (v1.1.361) — what QC-006 reads.
 *
 * The daily run always caught a phase that threw so the remaining phases could run, which is right.
 * The catch then appended the message to an array that `runDaily` returned and nothing stored. So
 * a generation, the gate, the email and every later rehearsal saw a crashed chains phase exactly as
 * they saw one that ran and found few contracts: "this domain is thin today", never "this domain
 * did not run". The record is now written as each phase ends.
 */

/** The phases a daily run schedules, in order (04 §2). A row for each is guaranteed by `recordNotReached`. */
export const DAILY_PHASES = [
  'bars', 'quotes', 'corporate_actions', 'account', 'chain_subset', 'chains', 'events', 'derive'
] as const;

export interface PhaseOutcome {
  readonly status: 'ok' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly error?: string;
}

/**
 * Writes one phase's outcome. Returns the write's own error rather than throwing: bookkeeping must
 * not stop a collection that is otherwise working, and the caller reports it with the phase errors.
 */
export function recordPhase(db: SqliteLike, runId: number, phase: string, o: PhaseOutcome): string | null {
  try {
    db.prepare(
      `INSERT INTO meta_run_phase (run_id, phase, status, started_at, finished_at, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(runId, phase, o.status, o.startedAt, o.finishedAt, o.error ?? null);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Marks every scheduled phase with no row as `not_reached` — after a cancellation, the phases
 * after the one that was interrupted. Written so that "did not run" is a row a check can read and
 * never merely an absence, which no check can tell from a run that predates the table.
 */
export function recordNotReached(db: SqliteLike, runId: number, phases: readonly string[] = DAILY_PHASES): number {
  const has = db.prepare('SELECT 1 AS x FROM meta_run_phase WHERE run_id = ? AND phase = ?');
  const insert = db.prepare(
    "INSERT INTO meta_run_phase (run_id, phase, status, started_at, finished_at, error) VALUES (?, ?, 'not_reached', NULL, NULL, NULL)"
  );
  let n = 0;
  for (const phase of phases) {
    if (has.get(runId, phase)) continue;
    insert.run(runId, phase);
    n++;
  }
  return n;
}
