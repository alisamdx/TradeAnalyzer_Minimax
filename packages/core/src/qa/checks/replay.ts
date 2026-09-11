import type { SqliteLike } from '../../db/sqlite-like.js';
import type { CheckDefinition } from '../check.js';
import { tradingDaysInRange } from '../../collector/trading-calendar.js';

/**
 * Replay checks — 03 §3.9 QC-951, and QC-956 (B10a).
 *
 * A replay is run by hand (the operator queues it from the Jobs view and runs
 * *Collector one-shot jobs* in the host app — nothing claims a request on its
 * own since v1.1.206). So the gate cannot run one; it reads what the replays
 * that WERE run reported, from `meta_job_request.result_json`.
 *
 * Two checks rather than one, because they are different findings with
 * different severities: a replay that came back **different** is evidence the
 * stored data cannot be rebuilt from its own archive (blocking, AC-4), while
 * **no recent replay** is only the absence of that evidence (a warning — it
 * says look, not that anything is wrong).
 */

/** Sessions a passing replay stays current for. Weekly cadence with two days of slack. */
export const REPLAY_MAX_AGE_TRADING_DAYS = 7;

const PASSING = new Set(['equal', 'equal_on_replayed']);

export interface CompletedReplay {
  readonly requestId: number;
  /** The ET date the replay finished on. */
  readonly finishedDate: string;
  readonly finishedAt: string;
  readonly verdict: string;
  /** The trading days whose runs were replayed. */
  readonly tradingDates: readonly string[];
}

/** Every completed replay with a readable report, oldest first. */
export function completedReplays(db: SqliteLike): readonly CompletedReplay[] {
  const rows = db
    .prepare(
      `SELECT request_id, finished_at, result_json FROM meta_job_request
        WHERE run_kind = 'replay' AND state = 'complete' AND result_json IS NOT NULL AND finished_at IS NOT NULL
        ORDER BY finished_at, request_id`
    )
    .all() as { request_id: number; finished_at: string; result_json: string }[];

  const out: CompletedReplay[] = [];
  for (const r of rows) {
    let report: { verdict?: unknown; tradingDates?: unknown };
    try {
      report = JSON.parse(r.result_json) as typeof report;
    } catch {
      continue;
    }
    if (typeof report.verdict !== 'string') continue;
    const dates = Array.isArray(report.tradingDates)
      ? report.tradingDates.filter((d): d is string => typeof d === 'string')
      : [];
    out.push({
      requestId: r.request_id,
      finishedDate: r.finished_at.slice(0, 10),
      finishedAt: r.finished_at,
      verdict: report.verdict,
      tradingDates: dates
    });
  }
  return out;
}

/**
 * The latest replay of each replayed trading day.
 *
 * Latest, not every: a day replayed `different` and then replayed again `equal`
 * after a parser fix is no longer different, and if every historical request
 * kept firing the exception could never be resolved — the workbench refuses to
 * resolve anything still firing on the latest run.
 */
export function latestReplayPerDate(db: SqliteLike): ReadonlyMap<string, CompletedReplay> {
  const latest = new Map<string, CompletedReplay>();
  for (const r of completedReplays(db)) for (const d of r.tradingDates) latest.set(d, r);
  return latest;
}

/**
 * Sessions since the last passing replay, as of `asOf` — or since the first
 * daily run when no replay has ever passed. `null` when there is no daily run
 * yet, i.e. nothing that could have been replayed.
 */
export function sessionsSincePassingReplay(
  db: SqliteLike,
  asOf: string
): { readonly sessions: number; readonly since: string; readonly lastPassing: CompletedReplay | null } | null {
  const passing = completedReplays(db).filter((r) => PASSING.has(r.verdict));
  const lastPassing = passing.length > 0 ? (passing[passing.length - 1] as CompletedReplay) : null;
  const since =
    lastPassing?.finishedDate ??
    (db.prepare("SELECT MIN(trading_date) AS d FROM meta_run WHERE run_kind = 'daily'").get() as { d: string | null }).d;
  if (since === null) return null;
  const sessions = tradingDaysInRange(db, since, asOf).filter((d) => d > since).length;
  return { sessions, since, lastPassing };
}

export const QC951_REPLAY_EQUIVALENCE: CheckDefinition = {
  id: 'QC-951',
  domain: 'cross_cutting',
  severity: 'blocking',
  description:
    'The latest replay of each replayed trading day came back equal to what is stored. A replay that ' +
    'differs means the stored rows cannot be rebuilt from the archive with current code (AC-4), so that ' +
    'day is not trusted until the difference is explained. Reads the reports of replays the operator ran; ' +
    'the gate never runs one itself.',
  readsTables: ['meta_job_request'],
  testedQuantity: null,
  testedUnit: null,
  thresholds: {},
  thresholdBasis: 'not_applicable',
  run(ctx) {
    // No replay yet is QC-956's finding, not an evaluation of this one: counting
    // "nothing to look at" as a clean look would make this check's
    // `evaluated_total` climb every day with nothing replayed.
    return [...latestReplayPerDate(ctx.db)].map(([date, r]) => {
      const fired = r.verdict === 'different';
      return {
        key: date,
        fired,
        detail: fired
          ? `the replay of ${date} (request ${r.requestId}, ${r.finishedAt}) differs from what is stored — open its diff in Jobs`
          : undefined,
        evidence: { requestId: r.requestId, verdict: r.verdict, finishedAt: r.finishedAt },
        affects: [date]
      };
    });
  }
};

export const QC956_REPLAY_OVERDUE: CheckDefinition = {
  id: 'QC-956',
  domain: 'cross_cutting',
  severity: 'warning',
  description:
    'A replay has come back equal within the last few trading sessions. QC-951 can only judge replays that ' +
    'were run, and running one is a manual step, so this is the reminder that makes a skipped week visible ' +
    'rather than silent. Counted from the first daily run until a replay first passes.',
  readsTables: ['meta_job_request', 'meta_run', 'ref_trading_day'],
  testedQuantity: 'trading_days_since_passing_replay',
  testedUnit: 'count',
  thresholds: { max_trading_days: REPLAY_MAX_AGE_TRADING_DAYS },
  thresholdBasis: 'working',
  run(ctx) {
    const age = sessionsSincePassingReplay(ctx.db, ctx.tradingDate);
    if (age === null) return [];
    const fired = age.sessions > REPLAY_MAX_AGE_TRADING_DAYS;
    return [
      {
        key: 'replay',
        value: age.sessions,
        fired,
        detail: fired
          ? age.lastPassing
            ? `no replay has passed in ${age.sessions} sessions (last passing: request ${age.lastPassing.requestId}, ${age.lastPassing.finishedAt})`
            : `no replay has passed since the first daily run on ${age.since} (${age.sessions} sessions)`
          : undefined,
        evidence: {
          sessions: age.sessions,
          since: age.since,
          lastPassingRequest: age.lastPassing?.requestId ?? null
        }
      }
    ];
  }
};

export const REPLAY_CHECKS: readonly CheckDefinition[] = [QC951_REPLAY_EQUIVALENCE, QC956_REPLAY_OVERDUE];
