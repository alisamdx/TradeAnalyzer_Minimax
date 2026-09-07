import { createHash } from 'node:crypto';
import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from '../collector/host.js';
import {
  primaryThreshold,
  summarise,
  type CheckDefinition,
  type Evaluation,
  type Severity
} from './check.js';

/**
 * The gate — 03 §1, §2, §5.
 *
 * It runs inside the collector, on the same run, before the run is marked
 * complete, and its verdict is the only way a day's data becomes usable to
 * anything downstream.
 */

export type Verdict = 'green' | 'amber' | 'red';

const SEVERITY_ORDER: readonly Severity[] = ['info', 'warning', 'blocking'];

function promote(severity: Severity): Severity {
  const i = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(i + 1, SEVERITY_ORDER.length - 1)] as Severity;
}

export function fingerprint(checkId: string, domain: string, key: string): string {
  return createHash('sha1').update(`${checkId}\n${domain}\n${key}`).digest('hex');
}

/** How many consecutive firing runs promote an open exception one level (03 §5.4). */
export const ESCALATE_AFTER_RUNS = 3;

export interface GateResult {
  readonly verdict: Verdict;
  readonly reportId: number;
  readonly blocking: number;
  readonly warnings: number;
  readonly info: number;
  readonly resolvedByGate: number;
  readonly checksRun: number;
  readonly checksFired: number;
  /** Checks that evaluated nothing at all — they had no data to look at. */
  readonly checksVacuous: readonly string[];
}

/** Materialises the check registry, versioning a definition that has changed (03 §4). */
export function syncRegistry(
  db: SqliteLike,
  host: CollectorHost,
  checks: readonly CheckDefinition[]
): Map<string, number> {
  const versions = new Map<string, number>();
  const now = host.nowET();

  for (const def of checks) {
    const payload = JSON.stringify({
      domain: def.domain,
      severity: def.severity,
      description: def.description,
      readsTables: def.readsTables,
      testedQuantity: def.testedQuantity,
      testedUnit: def.testedUnit,
      thresholds: def.thresholds
    });

    const current = db
      .prepare(
        `SELECT row_id, registry_version, thresholds_json, description, default_severity
           FROM qa_check_registry WHERE check_id = ? AND valid_to IS NULL`
      )
      .get(def.id) as
      | { row_id: number; registry_version: number; thresholds_json: string; description: string; default_severity: string }
      | undefined;

    const unchanged =
      current &&
      current.thresholds_json === JSON.stringify(def.thresholds) &&
      current.description === def.description &&
      current.default_severity === def.severity;

    if (unchanged) {
      versions.set(def.id, current.registry_version);
      continue;
    }

    // A changed definition is a NEW registry version. Editing in place would
    // make a past `qa_check_result` reference a threshold that no longer exists,
    // and the whole point of storing the distribution is to be able to ask later
    // what the boundary was at the time.
    const nextVersion = (current?.registry_version ?? 0) + 1;
    const write = db.transaction(() => {
      if (current) {
        db.prepare('UPDATE qa_check_registry SET valid_to = ? WHERE row_id = ?').run(now, current.row_id);
      }
      db.prepare(
        `INSERT INTO qa_check_registry (
           check_id, domain, default_severity, description, reads_tables_json,
           tested_quantity, tested_unit, thresholds_json, registry_version, valid_from,
           evaluated_total, fired_total
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        def.id, def.domain, def.severity, def.description, JSON.stringify(def.readsTables),
        def.testedQuantity, def.testedUnit, JSON.stringify(def.thresholds), nextVersion, now,
        0, 0
      );
    });
    write();
    versions.set(def.id, nextVersion);
    void payload;
  }
  return versions;
}

interface RaisedFinding {
  readonly def: CheckDefinition;
  readonly evaluation: Evaluation;
  readonly severity: Severity;
}

/**
 * Runs every check, records what each measured, and reconciles the exceptions.
 *
 * The order inside is deliberate: results and distributions are written for
 * **every** check whether or not it fired, then exceptions are raised, then the
 * ones that stopped firing are reconciled, then domain-day status is recomputed
 * from what is actually open.
 */
export function runGate(
  db: SqliteLike,
  host: CollectorHost,
  args: {
    readonly runId: number;
    readonly tradingDate: string;
    readonly checks: readonly CheckDefinition[];
    readonly domainsExpected?: Readonly<Record<string, { expected: number; stored: number }>>;
  }
): GateResult {
  const versions = syncRegistry(db, host, args.checks);
  const observedAt = host.nowET();
  const ctx = { db, runId: args.runId, tradingDate: args.tradingDate, observedAt };

  const raised: RaisedFinding[] = [];
  const firedFingerprints = new Set<string>();
  const vacuous: string[] = [];
  let checksFired = 0;

  for (const def of args.checks) {
    const started = Date.now();
    let evaluations: readonly Evaluation[] = [];
    let failure: string | undefined;
    try {
      evaluations = def.run(ctx);
    } catch (err) {
      // A check that throws is itself a finding. Swallowing it would make a
      // broken check indistinguishable from a clean one — the exact failure the
      // gate exists to prevent, one level up.
      failure = err instanceof Error ? err.message : String(err);
      evaluations = [
        { key: 'check_error', fired: true, detail: `check threw: ${failure}`, evidence: { error: failure } }
      ];
    }

    const durationMs = Date.now() - started;
    const fired = evaluations.filter((e) => e.fired);
    if (fired.length > 0) checksFired++;
    if (evaluations.length === 0) vacuous.push(def.id);

    // A magnitude check's distribution covers EVERY evaluation, fired or not.
    const values = evaluations.map((e) => e.value).filter((v): v is number => typeof v === 'number');
    const threshold = primaryThreshold(def);
    const distribution = def.testedQuantity === null ? null : summarise(values, threshold);

    const extremes = evaluations
      .filter((e) => typeof e.value === 'number')
      .sort((a, b) => (b.value as number) - (a.value as number))
      .slice(0, 20)
      .map((e) => ({ key: e.key, value: e.value }));

    db.prepare(
      `INSERT INTO qa_check_result (
         run_id, check_id, registry_version, evaluated_count, fired_count, duration_ms,
         sample_keys_json, distribution_json, extreme_keys_json
       ) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id, check_id) DO UPDATE SET
         evaluated_count = excluded.evaluated_count,
         fired_count = excluded.fired_count,
         duration_ms = excluded.duration_ms,
         sample_keys_json = excluded.sample_keys_json,
         distribution_json = excluded.distribution_json,
         extreme_keys_json = excluded.extreme_keys_json`
    ).run(
      args.runId,
      def.id,
      versions.get(def.id) ?? 1,
      evaluations.length,
      fired.length,
      durationMs,
      JSON.stringify(fired.slice(0, 20).map((e) => e.key)),
      distribution === null ? null : JSON.stringify(distribution),
      def.testedQuantity === null ? null : JSON.stringify(extremes)
    );

    db.prepare(
      `UPDATE qa_check_registry
          SET evaluated_total = evaluated_total + ?,
              fired_total = fired_total + ?,
              first_fired_at = COALESCE(first_fired_at, ?),
              last_fired_at = ?
        WHERE check_id = ? AND valid_to IS NULL`
    ).run(
      evaluations.length,
      fired.length,
      fired.length > 0 ? observedAt : null,
      fired.length > 0 ? observedAt : null,
      def.id
    );

    // A per-item warning becomes blocking when it affects enough of the
    // population — a drift on one ticker is noise, on 2 % of them the feed moved.
    const firedFraction = evaluations.length > 0 ? fired.length / evaluations.length : 0;
    const promotedByFraction =
      def.promoteToBlockingAtFiredFraction !== undefined &&
      firedFraction > def.promoteToBlockingAtFiredFraction;

    for (const e of fired) {
      const promotedByValue =
        def.promoteToBlockingAtValue !== undefined &&
        e.value !== undefined &&
        e.value > def.promoteToBlockingAtValue;
      const promoted = promotedByFraction || promotedByValue;
      raised.push({ def, evaluation: e, severity: promoted ? 'blocking' : def.severity });
      firedFingerprints.add(fingerprint(def.id, def.domain, e.key));
    }
  }

  const counts = { blocking: 0, warning: 0, info: 0 };
  for (const finding of raised) {
    const severity = upsertException(db, host, args.runId, args.tradingDate, finding);
    counts[severity]++;
  }

  const resolvedByGate = reconcileStoppedFiring(db, host, args.runId, firedFingerprints, args.checks);
  recomputeDomainDayStatus(db, host, args.runId, args.tradingDate);

  const verdict: Verdict = counts.blocking > 0 ? 'red' : counts.warning > 0 ? 'amber' : 'green';

  const info = db
    .prepare(
      `INSERT INTO qa_quality_report (
         run_id, generated_at, overall, domains_json, checks_json, email_status
       ) VALUES (?,?,?,?,?, 'pending')`
    )
    .run(
      args.runId,
      observedAt,
      verdict,
      JSON.stringify(args.domainsExpected ?? {}),
      JSON.stringify(
        args.checks.map((c) => ({ id: c.id, domain: c.domain, severity: c.severity }))
      )
    );

  return {
    verdict,
    reportId: Number(info.lastInsertRowid),
    blocking: counts.blocking,
    warnings: counts.warning,
    info: counts.info,
    resolvedByGate,
    checksRun: args.checks.length,
    checksFired,
    checksVacuous: vacuous
  };
}

function upsertException(
  db: SqliteLike,
  host: CollectorHost,
  runId: number,
  tradingDate: string,
  finding: RaisedFinding
): Severity {
  const { def, evaluation } = finding;
  const fp = fingerprint(def.id, def.domain, evaluation.key);
  const now = host.nowET();
  const affects = JSON.stringify(evaluation.affects ?? [tradingDate]);

  const existing = db
    .prepare(
      `SELECT exception_id, state, severity, consecutive_runs, last_seen_run_id
         FROM qa_exception WHERE fingerprint = ?`
    )
    .get(fp) as
    | { exception_id: number; state: string; severity: Severity; consecutive_runs: number; last_seen_run_id: number }
    | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO qa_exception (
           fingerprint, check_id, domain, key, severity, base_severity, state, detail,
           evidence_json, first_seen_run_id, last_seen_run_id, consecutive_runs,
           remediations_json, affects_trading_dates_json, still_firing
         ) VALUES (?,?,?,?,?,?, 'open', ?,?,?,?,1,'[]',?,1)`
      )
      .run(
        fp, def.id, def.domain, evaluation.key, finding.severity, def.severity,
        evaluation.detail ?? def.description,
        JSON.stringify(evaluation.evidence ?? {}),
        runId, runId, affects
      );
    recordEvent(db, Number(info.lastInsertRowid), now, 'gate', null, 'open', null, finding.severity, 'first observed');
    return finding.severity;
  }

  // A recurrence after a resolution is not a new exception: same fingerprint,
  // reopened, with the counter reset so the email can call it out as a
  // recurrence rather than as a first sighting.
  const reopened = existing.state === 'resolved';
  const consecutive = existing.last_seen_run_id === runId
    ? existing.consecutive_runs
    : reopened ? 1 : existing.consecutive_runs + 1;

  let severity = existing.severity;
  if (!reopened && consecutive >= ESCALATE_AFTER_RUNS && (existing.state === 'open' || existing.state === 'acknowledged')) {
    const next = promote(existing.severity);
    if (next !== existing.severity) {
      severity = next;
      recordEvent(db, existing.exception_id, now, 'escalation', existing.state, existing.state, existing.severity, next,
        `fired on ${consecutive} consecutive runs`);
    }
  }

  const nextState = reopened ? 'open' : existing.state;
  db.prepare(
    `UPDATE qa_exception
        SET last_seen_run_id = ?, consecutive_runs = ?, severity = ?, state = ?,
            detail = ?, evidence_json = ?, affects_trading_dates_json = ?, still_firing = 1
      WHERE exception_id = ?`
  ).run(
    runId, consecutive, severity, nextState,
    evaluation.detail ?? def.description,
    JSON.stringify(evaluation.evidence ?? {}),
    affects,
    existing.exception_id
  );

  if (reopened) {
    recordEvent(db, existing.exception_id, now, 'gate', 'resolved', 'open', existing.severity, severity,
      'recurrence — the same fingerprint fired again');
  }
  return severity;
}

/**
 * Marks exceptions that did not fire this run.
 *
 * **They stay open.** An exception whose fingerprint stops firing without a
 * remediation is listed as "no longer observed, unresolved" — because "it went
 * away" is exactly how the earnings-date bug hid for a quarter. The gate may
 * resolve only when a remediation in `remediations_json` succeeded *and* the
 * fingerprint now evaluates clean; anything else is an operator's call.
 */
function reconcileStoppedFiring(
  db: SqliteLike,
  host: CollectorHost,
  runId: number,
  firedFingerprints: ReadonlySet<string>,
  checks: readonly CheckDefinition[]
): number {
  const checkIds = new Set(checks.map((c) => c.id));
  const openOnes = db
    .prepare(
      `SELECT exception_id, fingerprint, check_id, severity, state, remediations_json
         FROM qa_exception WHERE state IN ('open', 'acknowledged')`
    )
    .all() as {
    exception_id: number; fingerprint: string; check_id: string; severity: Severity;
    state: string; remediations_json: string;
  }[];

  const now = host.nowET();
  let resolved = 0;

  for (const e of openOnes) {
    if (!checkIds.has(e.check_id)) continue;           // its check did not run
    if (firedFingerprints.has(e.fingerprint)) continue; // still firing

    const remediations = JSON.parse(e.remediations_json) as { outcome?: string }[];
    const remediationSucceeded = remediations.some((r) => r.outcome === 'success');

    if (remediationSucceeded) {
      db.prepare(
        `UPDATE qa_exception
            SET state = 'resolved', resolved_at = ?, resolution_kind = 'data_corrected',
                resolution_note = ?, still_firing = 0
          WHERE exception_id = ?`
      ).run(now, 'remediation succeeded and the check now evaluates clean', e.exception_id);
      recordEvent(db, e.exception_id, now, 'gate', e.state, 'resolved', e.severity, e.severity,
        'remediation succeeded and the fingerprint evaluates clean');
      resolved++;
    } else {
      db.prepare('UPDATE qa_exception SET still_firing = 0 WHERE exception_id = ?').run(e.exception_id);
    }
    void runId;
  }
  return resolved;
}

/**
 * Recomputes usability from the exceptions that are actually open.
 *
 * Derived, never stored on the run: a `meta_run.usable` column would be correct
 * for one day and then drift every time an exception was resolved — the same
 * denormalisation trap that let a stale earnings date suppress its own
 * corrections.
 */
export function recomputeDomainDayStatus(
  db: SqliteLike,
  host: CollectorHost,
  runId: number | null,
  tradingDate: string
): void {
  const rows = db
    .prepare(
      `SELECT domain, severity, state, affects_trading_dates_json FROM qa_exception
        WHERE state IN ('open', 'acknowledged')`
    )
    .all() as { domain: string; severity: Severity; state: string; affects_trading_dates_json: string }[];

  const tally = new Map<string, { blocking: number; warning: number }>();
  for (const r of rows) {
    const dates = JSON.parse(r.affects_trading_dates_json) as string[];
    for (const date of dates.length > 0 ? dates : [tradingDate]) {
      const k = `${r.domain}\n${date}`;
      const t = tally.get(k) ?? { blocking: 0, warning: 0 };
      if (r.severity === 'blocking') t.blocking++;
      else if (r.severity === 'warning') t.warning++;
      tally.set(k, t);
    }
  }

  const domains = new Set<string>([
    ...(db.prepare('SELECT DISTINCT domain FROM qa_check_registry WHERE valid_to IS NULL').all() as { domain: string }[])
      .map((r) => r.domain)
  ]);

  const now = host.nowET();
  const write = db.transaction(() => {
    for (const domain of domains) {
      const t = tally.get(`${domain}\n${tradingDate}`) ?? { blocking: 0, warning: 0 };
      const status =
        t.blocking > 0 ? 'unusable' : t.warning > 0 ? 'usable_with_warnings' : 'usable';
      db.prepare(
        `INSERT INTO qa_domain_day_status (domain, trading_date, status, blocking_open, warning_open, computed_at, by_run_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(domain, trading_date) DO UPDATE SET
           status = excluded.status, blocking_open = excluded.blocking_open,
           warning_open = excluded.warning_open, computed_at = excluded.computed_at,
           by_run_id = excluded.by_run_id`
      ).run(domain, tradingDate, status, t.blocking, t.warning, now, runId);
    }
  });
  write();
}

/** Writes `not_run` for every domain on a day no run covered (03 §7.3). */
export function markNotRun(db: SqliteLike, host: CollectorHost, tradingDate: string): number {
  const domains = (
    db.prepare('SELECT DISTINCT domain FROM qa_check_registry WHERE valid_to IS NULL').all() as { domain: string }[]
  ).map((r) => r.domain);
  const now = host.nowET();
  const write = db.transaction(() => {
    for (const domain of domains) {
      db.prepare(
        `INSERT INTO qa_domain_day_status (domain, trading_date, status, blocking_open, warning_open, computed_at, by_run_id)
         VALUES (?,?, 'not_run', 0, 0, ?, NULL)
         ON CONFLICT(domain, trading_date) DO NOTHING`
      ).run(domain, tradingDate, now);
    }
  });
  write();
  return domains.length;
}

function recordEvent(
  db: SqliteLike,
  exceptionId: number,
  at: string,
  actor: 'gate' | 'operator' | 'escalation',
  fromState: string | null,
  toState: string,
  fromSeverity: string | null,
  toSeverity: string,
  note: string
): void {
  db.prepare(
    `INSERT INTO qa_exception_event (exception_id, at, actor, from_state, to_state, from_severity, to_severity, note)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(exceptionId, at, actor, fromState, toState, fromSeverity, toSeverity, note);
}

/**
 * Consecutive trading days with no open or acknowledged blocking exception.
 *
 * An `expired_review` exception does **not** break the streak (03 §5.2): an
 * acceptance expiring is a prompt to re-examine a known fact, not the discovery
 * of a new one. Letting it reset the streak would mean an acceptance taken on
 * pilot day 1 wipes the count around day 21, every time, so the 20-day criterion
 * would be defeated by its own escape valve. It blocks promotion instead.
 */
export function cleanDayStreak(db: SqliteLike, upToDate: string): number {
  const days = (
    db
      .prepare(
        `SELECT DISTINCT trading_date FROM qa_domain_day_status
          WHERE trading_date <= ? ORDER BY trading_date DESC`
      )
      .all(upToDate) as { trading_date: string }[]
  ).map((r) => r.trading_date);

  let streak = 0;
  for (const day of days) {
    const bad = db
      .prepare(
        `SELECT COUNT(*) AS n FROM qa_domain_day_status
          WHERE trading_date = ? AND status IN ('unusable', 'not_run')`
      )
      .get(day) as { n: number };
    if (bad.n > 0) break;
    streak++;
  }
  return streak;
}
