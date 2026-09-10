import {
  cancelJob,
  etTimestamp,
  queueJob,
  resetPreview,
  STALL_THRESHOLD_MINUTES
} from '@tradeanalyzer/core';
import { currentDb, currentGeneration, generationDir } from './generation.js';
import { operatorHost } from './operator.js';
import { isQueueableKind, QUEUEABLE_KINDS } from '../shared/deeplink.js';
import type { JobCardDto, JobRequestDto, JobsDto, ResetPreviewDto } from '../shared/types.js';

/**
 * The Jobs view's main-process half — 05 §7, B9a.
 *
 * **This view queues; it does not execute.** The old app holds the provider
 * transports and the E*Trade token (Q4), so a Run here inserts a
 * `meta_job_request` row and nothing more.
 *
 * And — the thing 05 §7 was drafted without — **nothing claims that row on its
 * own any more.** The spec describes `collector-oneshot` claiming within ~2
 * minutes; that claim loop was removed in v1.1.206 after it re-ran one request
 * ~70 times and sent a RED email each time. A queued job therefore waits until
 * the operator runs "Collector one-shot jobs" in TradeAnalyzer's Batch view.
 * The cards say so in plain words, because a spinner in front of a job that
 * will never start on its own is exactly the lie P9 forbids.
 *
 * Reset is not queued at all: the new exe executes it (04 §7.6). See
 * `generation.ts`.
 */

const CARDS: readonly Omit<JobCardDto, 'last'>[] = [
  {
    kind: 'universe_seed',
    title: 'Seed the universe',
    what: 'Opens a membership row for every ticker in the host app\'s own index lists and fetches its reference data.',
    cost: 'Polygon — about one call per ticker (~1,100).',
    queueable: true,
    notYet: null
  },
  {
    kind: 'backfill_bars',
    title: 'Backfill five years of bars',
    what: 'One five-year daily-bar request per universe ticker, with splits fetched first. Discontinuities open exceptions on arrival — the review queue it produces is the deliverable.',
    cost: 'Polygon — about one call per ticker (~1,100), a few minutes.',
    queueable: true,
    notYet: null
  },
  {
    kind: 'bootstrap_iv',
    title: 'Load the external IV history',
    what: 'Pulls a year of 30-day IV per chain-subset ticker into the external table, unaccepted until 20 paired days of overlap exist.',
    cost: 'IVolatility — about one call per subset ticker (~500). Needs a subscription; without one every call fails.',
    queueable: true,
    notYet: null
  },
  {
    kind: 'legacy_import',
    title: 'Import the existing app\'s record',
    what: 'Copies configuration through validators and the stored brief decisions, marked pre-collector. It reads the old app\'s database live and writes nothing to it.',
    cost: 'No provider calls.',
    queueable: true,
    notYet: null
  },
  {
    kind: 'replay',
    title: 'Replay the archive',
    what: 'Re-ingests archived responses with the current code and compares the result over the dictionary\'s fact columns (AC-4).',
    cost: 'No provider calls.',
    queueable: false,
    // Not decorative: the archive holds each response's bytes but not the
    // arguments its parser was built with (the rule's expiration selection,
    // the sticky set, the ids already stored, the account key), so a replay
    // today would have to guess them — and a guessed replay reporting "equal"
    // is a check that cannot fail on the case it exists for.
    notYet:
      'B9b. The archive keeps every response\'s bytes but not the arguments each parser was built with, ' +
      'so a replay today would have to guess them. They will be recorded at capture first.'
  }
];

interface RequestRow {
  request_id: number;
  run_kind: string;
  requested_at: string;
  requested_by: string;
  state: string;
  claimed_at: string | null;
  claimed_by_host: string | null;
  finished_at: string | null;
  run_id: number | null;
  result_json: string | null;
  error: string | null;
  gate_verdict: string | null;
  run_status: string | null;
}

const SELECT_REQUESTS = `
  SELECT q.request_id, q.run_kind, q.requested_at, q.requested_by, q.state, q.claimed_at,
         q.claimed_by_host, q.finished_at, q.run_id, q.result_json, q.error,
         r.gate_verdict, r.status AS run_status
    FROM meta_job_request q
    LEFT JOIN meta_run r ON r.run_id = q.run_id`;

function toRequest(r: RequestRow, nowMs: number): JobRequestDto {
  const waitingMinutes =
    r.state === 'queued' ? Math.max(0, Math.floor((nowMs - Date.parse(r.requested_at)) / 60_000)) : null;
  let result: string | null = null;
  if (r.result_json !== null) {
    try {
      result = JSON.stringify(JSON.parse(r.result_json), null, 2);
    } catch {
      result = r.result_json;
    }
  }
  return {
    id: r.request_id,
    kind: r.run_kind,
    queuedAt: r.requested_at,
    queuedBy: r.requested_by,
    state: r.state,
    claimedAt: r.claimed_at,
    claimedBy: r.claimed_by_host,
    finishedAt: r.finished_at,
    runId: r.run_id,
    waitingMinutes,
    stalled: waitingMinutes !== null && waitingMinutes >= STALL_THRESHOLD_MINUTES,
    error: r.error,
    result,
    gate: r.gate_verdict,
    runOutcome: r.run_status
  };
}

export function jobsOverview(): JobsDto {
  const db = currentDb();
  const nowMs = Date.parse(etTimestamp());
  const lastOf = db.prepare(`${SELECT_REQUESTS} WHERE q.run_kind = ? ORDER BY q.request_id DESC LIMIT 1`);

  return {
    cards: CARDS.map((c) => {
      const last = lastOf.get(c.kind) as RequestRow | undefined;
      return { ...c, last: last ? toRequest(last, nowMs) : null };
    }),
    requests: (db.prepare(`${SELECT_REQUESTS} ORDER BY q.request_id DESC LIMIT 60`).all() as RequestRow[]).map((r) =>
      toRequest(r, nowMs)
    ),
    stallMinutes: STALL_THRESHOLD_MINUTES
  };
}

/**
 * Queues one job. Refuses a kind that is not on the allow-list, and refuses a
 * second request for a kind that already has one waiting or running — a double
 * click would otherwise queue two backfills, and the operator would run the
 * batch job twice without knowing why the first press "did nothing".
 */
export function queueOneShot(kind: string): number {
  if (!isQueueableKind(kind)) {
    throw new Error(
      `"${kind}" cannot be queued from here. Queueable: ${QUEUEABLE_KINDS.join(', ')}. ` +
        'Reset is performed by this app directly; replay arrives with B9b.'
    );
  }
  const db = currentDb();
  const pending = db
    .prepare(
      `SELECT request_id, state FROM meta_job_request
        WHERE run_kind = ? AND state IN ('queued', 'claimed', 'running')
        ORDER BY request_id LIMIT 1`
    )
    .get(kind) as { request_id: number; state: string } | undefined;
  if (pending) {
    throw new Error(`${kind} is already ${pending.state} as request ${pending.request_id}.`);
  }
  return queueJob(db as never, operatorHost(), kind);
}

export function cancelRequest(requestId: number): boolean {
  const won = cancelJob(currentDb() as never, operatorHost(), requestId);
  if (!won) {
    throw new Error(
      `Request ${requestId} is no longer queued, so it cannot be withdrawn — a host has it, or it has finished.`
    );
  }
  return won;
}

export function previewReset(): ResetPreviewDto {
  const g = currentGeneration();
  const p = resetPreview(currentDb() as never, etTimestamp(), g.generationNo);
  return {
    generationNo: p.generationNo,
    status: p.status,
    openedAt: p.openedAt,
    dataDays: p.dataDays,
    blockers: [...p.blockers],
    presumedDead: [...p.presumedDead],
    queuedToWithdraw: p.queuedToWithdraw,
    confirmation: p.confirmation,
    successorDir: generationDir(g.dataRoot, g.generationNo + 1)
  };
}
