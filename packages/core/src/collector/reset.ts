import type { SqliteLike } from '../db/sqlite-like.js';
import type { OperatorHost } from './host.js';
import { queueJob, type OneShotKind } from './jobs.js';
import { OperatorActionRefused } from '../qa/operator.js';

/**
 * `reset` — 04 §7.6, P14, AC-14.
 *
 * Closes the current generation, opens `gen-(N+1)`, moves the shared pointer
 * and queues the follow-up jobs into the new one. The previous generation is
 * left exactly where it is: nothing is renamed, nothing is deleted, and its
 * `meta_generation` row says `closed`.
 *
 * **It executes in the new exe, not the old app** — the opposite of what 04
 * §7.6 was drafted to say, and the draft was the older of two rules that
 * disagree. Q4 routes one-shot jobs through the old app because it holds the
 * provider transports and the E*Trade token; a reset calls no provider, so that
 * reason does not reach it. And since 2026-09-07 **generation creation belongs
 * to the new exe alone**: `ElectronCollectorHost` refuses to create a database
 * at all, because the time it did, it manufactured a generation with no
 * `meta_generation` row that looked healthy from every angle except whose it
 * was. A reset executed by the old app would have had to undo that refusal.
 *
 * Everything file-shaped — where a generation directory lives, how the pointer
 * is written — stays with the application, supplied as the two callbacks. What
 * is here is the order, the refusals and the record, which is the part a test
 * can hold to account.
 */

/** A run or a claim older than this is presumed dead rather than in flight. */
export const IN_FLIGHT_HOURS = 6;

/** What a reset queues into the new generation (04 §7.6). Backfill and the IV bootstrap are offered, not automatic. */
export const RESET_FOLLOW_UPS: readonly OneShotKind[] = ['universe_seed', 'legacy_import'];

/** The exact text the operator must type (05 §7). */
export function resetConfirmationText(generationNo: number): string {
  return `RESET gen-${String(generationNo).padStart(3, '0')}`;
}

export interface ResetPreview {
  readonly generationNo: number;
  readonly status: string;
  readonly openedAt: string;
  /** Distinct trading days with a completed daily run — what a reset costs (05 §7). */
  readonly dataDays: number;
  /** Reasons the reset would be refused right now. Empty means it may proceed. */
  readonly blockers: readonly string[];
  /** Runs and claims marked in flight that are too old to be — shown, never blocking. */
  readonly presumedDead: readonly string[];
  /** Queued requests that would be withdrawn: nothing would ever claim them once the pointer moves. */
  readonly queuedToWithdraw: number;
  readonly confirmation: string;
}

function hoursBetween(laterIso: string, earlierIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 3_600_000;
}

/**
 * What a reset would do and what stands in its way.
 *
 * **A run marked `running` blocks only while it could plausibly be running.**
 * `meta_run.status` stays `running` forever when the host dies mid-run (the
 * dictionary says so), so a literal reading would let one crash block every
 * reset after it — and the operator, who cannot edit `meta_run`, would have no
 * way out. Older than `IN_FLIGHT_HOURS`, it is listed as presumed dead instead:
 * visible, and not a veto.
 */
export function resetPreview(db: SqliteLike, nowIso: string, generationNo: number): ResetPreview {
  const gen = db
    .prepare('SELECT status, opened_at FROM meta_generation WHERE generation_no = ?')
    .get(generationNo) as { status: string; opened_at: string } | undefined;

  const blockers: string[] = [];
  const presumedDead: string[] = [];

  if (!gen) blockers.push(`gen-${generationNo} has no meta_generation row, so there is nothing recorded to close`);
  else if (gen.status === 'closed') blockers.push(`gen-${generationNo} is already closed`);

  const running = db
    .prepare("SELECT run_id, run_kind, started_at FROM meta_run WHERE status = 'running' ORDER BY run_id")
    .all() as { run_id: number; run_kind: string; started_at: string }[];
  for (const r of running) {
    const age = hoursBetween(nowIso, r.started_at);
    const label = `run ${r.run_id} (${r.run_kind}, started ${r.started_at})`;
    if (age < IN_FLIGHT_HOURS) blockers.push(`${label} is still running`);
    else presumedDead.push(`${label} — marked running for ${Math.floor(age)}h, presumed dead`);
  }

  const claimed = db
    .prepare(
      `SELECT request_id, run_kind, state, claimed_at FROM meta_job_request
        WHERE state IN ('claimed', 'running') ORDER BY request_id`
    )
    .all() as { request_id: number; run_kind: string; state: string; claimed_at: string | null }[];
  for (const r of claimed) {
    const label = `request ${r.request_id} (${r.run_kind}) is ${r.state}`;
    const age = r.claimed_at ? hoursBetween(nowIso, r.claimed_at) : Number.POSITIVE_INFINITY;
    if (age < IN_FLIGHT_HOURS) blockers.push(label);
    else presumedDead.push(`${label} — claimed ${r.claimed_at ?? 'at an unrecorded time'}, presumed dead`);
  }

  const dataDays = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT trading_date) AS n FROM meta_run
          WHERE run_kind = 'daily' AND status = 'complete'`
      )
      .get() as { n: number }
  ).n;

  const queuedToWithdraw = (
    db.prepare("SELECT COUNT(*) AS n FROM meta_job_request WHERE state = 'queued'").get() as { n: number }
  ).n;

  return {
    generationNo,
    status: gen?.status ?? 'unknown',
    openedAt: gen?.opened_at ?? '',
    dataDays,
    blockers,
    presumedDead,
    queuedToWithdraw,
    confirmation: resetConfirmationText(generationNo)
  };
}

/** The two things a reset may never proceed without (05 §7). */
export function validateResetRequest(generationNo: number, reason: string, confirmation: string): void {
  if (!reason.trim()) {
    throw new OperatorActionRefused('A reset needs a reason. It is recorded on the new generation for good.');
  }
  const expected = resetConfirmationText(generationNo);
  if (confirmation.trim() !== expected) {
    throw new OperatorActionRefused(`Type "${expected}" exactly to confirm the reset.`);
  }
}

export interface ResetArgs {
  /** The generation being closed, open and write-capable. */
  readonly db: SqliteLike;
  readonly host: OperatorHost;
  readonly generationNo: number;
  readonly reason: string;
  readonly confirmation: string;
  /**
   * Creates and opens `gen-(N+1)` with its schema applied and its own
   * `meta_generation` row written. Must refuse when that generation already
   * exists — opening an existing one would "reset" into data that is not new.
   */
  readonly openSuccessor: (generationNo: number) => SqliteLike;
  /** Moves the shared pointer. **The commit point**: until this returns, nothing has changed for either application. */
  readonly commitPointer: (generationNo: number) => void;
}

export interface ResetReport {
  readonly predecessorNo: number;
  readonly successorNo: number;
  readonly withdrawn: number;
  readonly queued: readonly { readonly kind: OneShotKind; readonly requestId: number }[];
}

/**
 * Performs the reset.
 *
 * **The order is what makes a crash survivable**, and every step before the
 * pointer moves is invisible to both applications:
 *
 * 1. Refuse on a bad confirmation, a missing reason, or anything in flight.
 * 2. Create the successor, record its predecessor and reason, queue its
 *    follow-ups. A crash here leaves an unused `gen-(N+1)` directory and
 *    nothing pointing at it.
 * 3. Move the pointer. From here both applications follow the new generation
 *    — the old app re-reads the pointer for every job.
 * 4. Close the old generation and withdraw its queued requests. A crash between
 *    3 and 4 leaves the old one saying `pilot` while nothing writes to it —
 *    untidy, harmless, and visible. Closing *before* the pointer moved would
 *    have left the reverse: a `closed` generation still being written.
 */
export function performReset(args: ResetArgs): ResetReport {
  const { db, host, generationNo } = args;
  validateResetRequest(generationNo, args.reason, args.confirmation);

  const preview = resetPreview(db, host.nowET(), generationNo);
  if (preview.blockers.length > 0) {
    throw new OperatorActionRefused(`Reset refused: ${preview.blockers.join('; ')}.`);
  }

  const successorNo = generationNo + 1;
  const successor = args.openSuccessor(successorNo);

  const row = successor
    .prepare('SELECT generation_no FROM meta_generation WHERE generation_no = ?')
    .get(successorNo) as { generation_no: number } | undefined;
  if (!row) {
    throw new Error(
      `openSuccessor returned gen-${successorNo} without its meta_generation row. A generation that ` +
        'does not describe itself is the signature of one the wrong application created.'
    );
  }

  successor
    .prepare('UPDATE meta_generation SET predecessor_no = ?, reset_reason = ? WHERE generation_no = ?')
    .run(generationNo, args.reason.trim(), successorNo);

  const queued = RESET_FOLLOW_UPS.map((kind) => ({
    kind,
    requestId: queueJob(successor, host, kind, { afterResetOf: generationNo })
  }));

  args.commitPointer(successorNo);

  const now = host.nowET();
  let withdrawn = 0;
  const close = db.transaction(() => {
    // Nothing would ever claim these once the pointer has moved: the old app
    // resolves the pointer per job and will never open this file again.
    withdrawn = db
      .prepare(
        `UPDATE meta_job_request SET state = 'cancelled', finished_at = ?
          WHERE state = 'queued'`
      )
      .run(now).changes;
    db.prepare(
      "UPDATE meta_generation SET status = 'closed', closed_at = ? WHERE generation_no = ?"
    ).run(now, generationNo);
  });
  close();

  return { predecessorNo: generationNo, successorNo, withdrawn, queued };
}
