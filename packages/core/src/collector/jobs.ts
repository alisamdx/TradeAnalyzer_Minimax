import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost, OperatorHost } from './host.js';

/**
 * The one-shot job queue — 04 §1.1, §7, and 02 §1's `meta_job_request`.
 *
 * In stage 1 the operator drives one-shot jobs from the **new** exe, and the
 * **old** app executes them, because the old app holds the provider transports
 * and the E*Trade token (Q4). This table is the entire interface between the two
 * applications: no IPC, no socket, no shared process. That is what makes
 * cut-over later just "the new exe stops queueing and runs them itself".
 */

export type OneShotKind =
  | 'universe_seed'
  | 'backfill_bars'
  | 'bootstrap_iv'
  | 'legacy_import'
  | 'replay'
  | 'reset';

export interface JobRequest {
  readonly requestId: number;
  readonly runKind: OneShotKind;
  readonly params: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
  readonly requestedBy: string;
}

/** Queues a request. The only way the new exe starts a job (05 §7). */
export function queueJob(
  db: SqliteLike,
  host: OperatorHost,
  kind: OneShotKind,
  params: Readonly<Record<string, unknown>> = {}
): number {
  const info = db
    .prepare(
      `INSERT INTO meta_job_request (requested_at, requested_by, run_kind, params_json, state)
       VALUES (?,?,?,?, 'queued')`
    )
    .run(host.nowET(), `${host.hostApp.name} ${host.hostApp.version}`, kind, JSON.stringify(params));
  return Number(info.lastInsertRowid);
}

/**
 * Claims at most one queued request, or returns undefined.
 *
 * **The claim is a single conditional UPDATE.** `WHERE request_id = ? AND state
 * = 'queued'` either changes one row or zero; zero means someone else took it,
 * and the loser yields rather than retrying. Reading-then-writing would leave a
 * window in which two hosts both see `queued` and both run the job — and the
 * jobs this queue carries include `reset`, which destroys a generation.
 *
 * One request per tick, so a backlog drains in order and a slow job cannot
 * starve the mutex the old app's other batch jobs share.
 */
export function claimNextJob(db: SqliteLike, host: CollectorHost): JobRequest | undefined {
  const candidate = db
    .prepare(
      `SELECT request_id, run_kind, params_json, requested_at, requested_by
         FROM meta_job_request
        WHERE state = 'queued'
        ORDER BY requested_at ASC, request_id ASC
        LIMIT 1`
    )
    .get() as
    | {
        request_id: number;
        run_kind: OneShotKind;
        params_json: string;
        requested_at: string;
        requested_by: string;
      }
    | undefined;

  if (!candidate) return undefined;

  const claimed = db
    .prepare(
      `UPDATE meta_job_request
          SET state = 'claimed', claimed_at = ?, claimed_by_host = ?
        WHERE request_id = ? AND state = 'queued'`
    )
    .run(host.nowET(), `${host.hostApp.name} ${host.hostApp.version}`, candidate.request_id);

  // Zero rows changed: another host claimed it between the SELECT and the
  // UPDATE. Yield — do not loop looking for another, because the next tick is
  // two minutes away and a busy-wait here would hold the batch mutex.
  if (claimed.changes === 0) return undefined;

  return {
    requestId: candidate.request_id,
    runKind: candidate.run_kind,
    params: JSON.parse(candidate.params_json) as Record<string, unknown>,
    requestedAt: candidate.requested_at,
    requestedBy: candidate.requested_by
  };
}

export function markJobRunning(db: SqliteLike, requestId: number, runId: number): void {
  db.prepare("UPDATE meta_job_request SET state = 'running', run_id = ? WHERE request_id = ?").run(
    runId,
    requestId
  );
}

export function finishJob(
  db: SqliteLike,
  host: CollectorHost,
  requestId: number,
  outcome:
    | { readonly state: 'complete'; readonly result: Readonly<Record<string, unknown>> }
    | { readonly state: 'failed'; readonly error: string }
): void {
  db.prepare(
    `UPDATE meta_job_request
        SET state = ?, finished_at = ?, result_json = ?, error = ?
      WHERE request_id = ?`
  ).run(
    outcome.state,
    host.nowET(),
    outcome.state === 'complete' ? JSON.stringify(outcome.result) : null,
    outcome.state === 'failed' ? outcome.error : null,
    requestId
  );
}

/**
 * Withdraws a request no host has claimed yet — 05 §7.
 *
 * Conditional on `state = 'queued'`, the same shape as the claim, so a cancel
 * and a claim that race can never both win: one of the two UPDATEs changes a
 * row and the other changes none. Returns whether this one won. A request that
 * was already claimed is not cancelled here — it is running, and stopping it is
 * the executing host's abort signal, not a row edit made behind its back.
 */
export function cancelJob(db: SqliteLike, host: OperatorHost, requestId: number): boolean {
  const info = db
    .prepare(
      `UPDATE meta_job_request SET state = 'cancelled', finished_at = ?
        WHERE request_id = ? AND state = 'queued'`
    )
    .run(host.nowET(), requestId);
  return info.changes === 1;
}

/** Minutes a request may sit `queued` before the Jobs view calls it stalled (05 §7). */
export const STALL_THRESHOLD_MINUTES = 10;

/**
 * Requests that have waited too long.
 *
 * Surfaced rather than retried. A request stuck at `queued` means **the
 * collector host is not running** — that is the failure mode a queue introduces,
 * and hiding it behind a spinner would make it look like a slow job (P9). A
 * silent retry would hide it even better.
 */
export function stalledRequests(
  db: SqliteLike,
  nowIso: string,
  thresholdMinutes: number = STALL_THRESHOLD_MINUTES
): readonly { readonly requestId: number; readonly waitingMinutes: number }[] {
  const now = Date.parse(nowIso);
  const rows = db
    .prepare("SELECT request_id, requested_at FROM meta_job_request WHERE state = 'queued'")
    .all() as { request_id: number; requested_at: string }[];
  return rows
    .map((r) => ({
      requestId: r.request_id,
      waitingMinutes: Math.floor((now - Date.parse(r.requested_at)) / 60_000)
    }))
    .filter((r) => r.waitingMinutes >= thresholdMinutes);
}
