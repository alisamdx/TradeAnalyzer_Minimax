import type { SqliteLike } from '../db/sqlite-like.js';
import type { Severity } from './check.js';

/**
 * What changed since the previous gate run — 03 §7.2c.
 *
 * **Why this exists.** The gate reports state, and state has been RED on every
 * daily run this generation has had. A signal that is always on carries no
 * information: with 773 findings in one email, a check that fired for the first
 * time at 92 % looked exactly like 151 price discontinuities that had been sitting
 * there for weeks. The only way to tell them apart was for a person to read all
 * 773 rows and remember yesterday's, which is why the operator ended up asking
 * for a manual review every evening rather than reading the alert.
 *
 * This is the same failure the project has catalogued twice already — the
 * conviction band that could never fire, the liquidity gate that always did. A
 * threshold is only informative where it can go both ways, and so is a verdict.
 *
 * So the delta is computed from what the gate already records: an exception
 * carries `first_seen_run_id`, `last_seen_run_id` and `still_firing`, which is
 * enough to say, per check, what this run **added**, what **stopped**, and what
 * merely persists. Nothing new is stored — a snapshot table would be a second
 * source of truth to keep honest.
 *
 * **The baseline is the previous gate run, not the previous calendar day**, so a
 * re-run of the same day compares against the run before it. That is the correct
 * reading: the question is "what did this run change", not "what did today do".
 */

/** Present only when a check's population moved; `unchanged` is counted, not listed. */
export type DeltaKind =
  | 'new'
  | 'growing'
  | 'shrinking'
  | 'churned'
  | 'gone'
  | 'resolved'
  | 'unchanged';

export interface CheckDelta {
  readonly checkId: string;
  readonly domain: string;
  readonly severity: Severity;
  readonly kind: DeltaKind;
  /** Findings firing now. */
  readonly firing: number;
  /** Findings firing at the baseline run, derived rather than stored. */
  readonly previousFiring: number;
  /** Raised for the first time ever by this run. */
  readonly added: number;
  /** Fired at the baseline and did not fire now — still open, just quiet. */
  readonly stopped: number;
  /** Closed by the gate this run because a remediation worked. */
  readonly resolved: number;
  /** One concrete row, preferring a newly added one — a count alone is not actionable. */
  readonly example: string;
}

export interface RunDelta {
  /**
   * The run compared against. **Null means there is no baseline**, which is a
   * different fact from "nothing changed" and must never be rendered as one —
   * an absence reading as a pass is this project's most repeated bug.
   */
  readonly baselineRunId: number | null;
  readonly baselineTradingDate: string | null;
  /** Checks whose population moved, ordered blocking-first then by size of move. */
  readonly changed: readonly CheckDelta[];
  /** Checks still firing with exactly the same findings as the baseline. */
  readonly unchangedChecks: number;
  readonly unchangedFindings: number;
}

interface ExceptionRow {
  check_id: string;
  domain: string;
  severity: Severity;
  state: string;
  detail: string;
  first_seen_run_id: number;
  last_seen_run_id: number;
  still_firing: number;
}

/** Display order: what needs a decision first, then by how much it moved. */
const KIND_RANK: Record<DeltaKind, number> = {
  new: 0,
  growing: 1,
  churned: 2,
  shrinking: 3,
  gone: 4,
  resolved: 5,
  unchanged: 6
};

/**
 * The previous run that reached the gate.
 *
 * `qa_quality_report` has one row per gate run and the current run's row is
 * already written by the time the email is built, so the baseline is the most
 * recent report belonging to a different run.
 */
export function baselineRun(
  db: SqliteLike,
  runId: number
): { runId: number; tradingDate: string | null } | null {
  const row = db
    .prepare(
      `SELECT r.run_id AS run_id, m.trading_date AS trading_date
         FROM qa_quality_report r
         LEFT JOIN meta_run m ON m.run_id = r.run_id
        WHERE r.run_id <> ?
        ORDER BY r.report_id DESC
        LIMIT 1`
    )
    .get(runId) as { run_id: number; trading_date: string | null } | undefined;
  return row ? { runId: row.run_id, tradingDate: row.trading_date } : null;
}

export function computeRunDelta(db: SqliteLike, runId: number): RunDelta {
  const baseline = baselineRun(db, runId);
  if (baseline === null) {
    return { baselineRunId: null, baselineTradingDate: null, changed: [], unchangedChecks: 0, unchangedFindings: 0 };
  }

  // Open and acknowledged findings are the live population. A resolved one is
  // included only when the gate closed it at THIS run, which it signals by
  // leaving `last_seen_run_id` at the run where it last fired — the baseline.
  const rows = db
    .prepare(
      `SELECT check_id, domain, severity, state, detail,
              first_seen_run_id, last_seen_run_id, still_firing
         FROM qa_exception
        WHERE state IN ('open', 'acknowledged')
           OR (state = 'resolved' AND last_seen_run_id = ?)`
    )
    .all(baseline.runId) as ExceptionRow[];

  const byCheck = new Map<string, ExceptionRow[]>();
  for (const r of rows) {
    const list = byCheck.get(r.check_id);
    if (list) list.push(r);
    else byCheck.set(r.check_id, [r]);
  }

  const changed: CheckDelta[] = [];
  let unchangedChecks = 0;
  let unchangedFindings = 0;

  for (const [checkId, list] of byCheck) {
    const live = list.filter((r) => r.state !== 'resolved');
    const firingRows = live.filter((r) => r.still_firing === 1);
    const addedRows = firingRows.filter((r) => r.first_seen_run_id === runId);
    // Fired at the baseline and not now. A finding that went quiet several runs
    // ago is not news, so the baseline run id has to match exactly.
    const stopped = live.filter(
      (r) => r.still_firing === 0 && r.last_seen_run_id === baseline.runId
    ).length;
    const resolved = list.filter((r) => r.state === 'resolved').length;

    const firing = firingRows.length;
    const added = addedRows.length;
    const previousFiring = firing - added + stopped + resolved;

    const kind: DeltaKind =
      previousFiring === 0 && firing > 0
        ? 'new'
        : firing === 0 && previousFiring > 0
          ? (resolved > 0 && stopped === 0 ? 'resolved' : 'gone')
          : firing > previousFiring
            ? 'growing'
            : firing < previousFiring
              ? 'shrinking'
              // Same count, different rows — a check that swaps one ticker for
              // another has not "stayed the same", and reporting it as unchanged
              // would hide a moving population behind a stable number.
              : added > 0 || stopped > 0 || resolved > 0
                ? 'churned'
                : 'unchanged';

    if (kind === 'unchanged') {
      unchangedChecks += 1;
      unchangedFindings += firing;
      continue;
    }

    const sample = addedRows[0] ?? firingRows[0] ?? list[0]!;
    changed.push({
      checkId,
      domain: sample.domain,
      severity: sample.severity,
      kind,
      firing,
      previousFiring,
      added,
      stopped,
      resolved,
      example: sample.detail
    });
  }

  changed.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : b.severity === 'blocking' ? 1 : 0;
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return Math.abs(b.firing - b.previousFiring) - Math.abs(a.firing - a.previousFiring);
  });

  return {
    baselineRunId: baseline.runId,
    baselineTradingDate: baseline.tradingDate,
    changed,
    unchangedChecks,
    unchangedFindings
  };
}

/** The subject-line suffix — the part read on a phone without opening anything. */
export function deltaHeadline(delta: RunDelta): string {
  if (delta.baselineRunId === null) return 'first run, no baseline';
  if (delta.changed.length === 0) return 'no change';

  const count = (kind: DeltaKind): number => delta.changed.filter((c) => c.kind === kind).length;
  const parts: string[] = [];
  // Upper-cased because it is the one word that should make somebody open the
  // email; the rest are lower case so it stands out at a glance.
  if (count('new') > 0) parts.push(`${count('new')} NEW`);
  if (count('growing') > 0) parts.push(`${count('growing')} growing`);
  if (count('churned') > 0) parts.push(`${count('churned')} churned`);
  if (count('shrinking') > 0) parts.push(`${count('shrinking')} shrinking`);
  if (count('gone') > 0) parts.push(`${count('gone')} gone`);
  if (count('resolved') > 0) parts.push(`${count('resolved')} resolved`);
  return parts.join(', ');
}

/** The block that opens the email body. */
export function deltaLines(delta: RunDelta): string[] {
  if (delta.baselineRunId === null) {
    return [
      'CHANGED SINCE THE PREVIOUS RUN',
      '  No previous gate run to compare against — every finding below is a first sighting.',
      ''
    ];
  }

  const where = delta.baselineTradingDate ?? 'unknown date';
  const lines = [`CHANGED SINCE RUN #${delta.baselineRunId} (${where})`];

  if (delta.changed.length === 0) {
    lines.push(
      `  Nothing changed. ${delta.unchangedChecks} check${delta.unchangedChecks === 1 ? '' : 's'} ` +
        `still firing, ${delta.unchangedFindings} finding${delta.unchangedFindings === 1 ? '' : 's'} — ` +
        'the same set as the previous run.'
    );
    lines.push('');
    return lines;
  }

  for (const c of delta.changed) {
    const label = c.kind.toUpperCase().padEnd(9);
    const move =
      c.kind === 'new'
        ? `×${c.firing} first seen`
        : c.kind === 'gone'
          ? `×${c.previousFiring} stopped firing (still open)`
          : c.kind === 'resolved'
            ? `×${c.resolved} closed by the gate`
            : c.kind === 'churned'
              ? `×${c.firing} (${c.added} in, ${c.stopped + c.resolved} out)`
              : `${c.previousFiring} → ${c.firing} (${c.firing > c.previousFiring ? '+' : ''}${c.firing - c.previousFiring})`;
    // Blocking is the default concern and carries no marker; anything else is
    // labelled, so a growing warning cannot read as alarming as a growing
    // blocking check purely because both moved.
    const sev = c.severity === 'blocking' ? '' : `  [${c.severity}]`;
    lines.push(`  ${label} ${c.checkId} ${c.domain}  ${move}${sev}`);
    lines.push(`      ${c.example}`);
  }

  if (delta.unchangedChecks > 0) {
    lines.push(
      `  unchanged: ${delta.unchangedChecks} check${delta.unchangedChecks === 1 ? '' : 's'}, ` +
        `${delta.unchangedFindings} finding${delta.unchangedFindings === 1 ? '' : 's'}`
    );
  }
  lines.push('');
  return lines;
}
