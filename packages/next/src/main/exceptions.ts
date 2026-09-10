import {
  acknowledge,
  accept,
  bulkAcknowledge,
  recordTickerReuse,
  resolve,
  type ResolutionKind
} from '@tradeanalyzer/core';
import { currentDb } from './generation.js';
import { operatorHost } from './operator.js';
import type {
  BulkAckResultDto,
  ExceptionDetailDto,
  ExceptionFilterDto,
  ExceptionListDto,
  ExceptionRowDto,
  ZeroFireDto
} from '../shared/types.js';

/**
 * The Exceptions workbench's main-process half — 05 §5, B9a.
 *
 * **Every write goes through `core`'s operator functions**, the ones
 * `scripts/exception.mjs` has driven since B5. Nothing here decides whether an
 * action is allowed: the refusals (resolving while still firing, accepting past
 * 180 days, a missing note) live in `core`, so the workbench and the script can
 * never disagree about what is permitted — a rule enforced by the form is
 * enforced only for the callers who use the form.
 *
 * Every table and column name lives here (AC-13); the renderer sees a UI
 * vocabulary.
 */

/** Needs a ruling: open, acknowledged, or an acceptance that has run out. */
const ACTIVE_STATES = ['open', 'acknowledged', 'expired_review'] as const;
const ALL_STATES = ['open', 'acknowledged', 'expired_review', 'accepted', 'resolved'] as const;
const RESOLUTION_KINDS: readonly ResolutionKind[] = ['data_corrected', 'provider_fixed', 'rule_changed', 'false_positive'];

/** QC-204 is the step itself, QC-205 the volume-regime shift; either can be the evidence for a reuse ruling (03 §6). */
const REUSE_CHECKS = new Set(['QC-204', 'QC-205']);

interface ExceptionRow {
  exception_id: number;
  check_id: string;
  domain: string;
  key: string;
  severity: string;
  base_severity: string;
  state: string;
  detail: string;
  first_seen_run_id: number;
  last_seen_run_id: number;
  consecutive_runs: number;
  still_firing: number;
  affects_trading_dates_json: string;
  accepted_until: string | null;
  first_at: string | null;
  last_at: string | null;
}

const SELECT_ROWS = `
  SELECT e.exception_id, e.check_id, e.domain, e.key, e.severity, e.base_severity, e.state, e.detail,
         e.first_seen_run_id, e.last_seen_run_id, e.consecutive_runs, e.still_firing,
         e.affects_trading_dates_json, e.accepted_until,
         f.started_at AS first_at, l.started_at AS last_at
    FROM qa_exception e
    LEFT JOIN meta_run f ON f.run_id = e.first_seen_run_id
    LEFT JOIN meta_run l ON l.run_id = e.last_seen_run_id`;

function datesOf(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function toRow(r: ExceptionRow): ExceptionRowDto {
  return {
    id: r.exception_id,
    checkId: r.check_id,
    domain: r.domain,
    key: r.key,
    severity: r.severity,
    // Shown as its own flag because severity never drops automatically: a
    // warning that has become blocking by recurring is a different fact from
    // one that started blocking, and the operator should see which.
    escalated: r.severity !== r.base_severity,
    state: r.state,
    detail: r.detail,
    firstSeenRun: r.first_seen_run_id,
    lastSeenRun: r.last_seen_run_id,
    firstSeenAt: r.first_at,
    lastSeenAt: r.last_at,
    runsInARow: r.consecutive_runs,
    stillSeen: r.still_firing === 1,
    daysAffected: datesOf(r.affects_trading_dates_json).length,
    acceptedUntil: r.accepted_until
  };
}

export function listExceptions(filter: ExceptionFilterDto): ExceptionListDto {
  const db = currentDb();
  const where: string[] = [];
  const params: unknown[] = [];

  const state = filter.state ?? 'active';
  if (state === 'active') {
    where.push(`e.state IN (${ACTIVE_STATES.map(() => '?').join(',')})`);
    params.push(...ACTIVE_STATES);
  } else if (state !== 'all') {
    if (!(ALL_STATES as readonly string[]).includes(state)) throw new Error(`Unknown exception state: ${state}`);
    where.push('e.state = ?');
    params.push(state);
  }
  if (filter.severity) { where.push('e.severity = ?'); params.push(filter.severity); }
  if (filter.checkId) { where.push('e.check_id = ?'); params.push(filter.checkId); }
  if (filter.domain) { where.push('e.domain = ?'); params.push(filter.domain); }
  // The status email's link: what that run saw. `last_seen_run_id` rather than
  // `first_seen`, because the email lists everything still firing on the run,
  // not only what it discovered.
  if (filter.runId != null) { where.push('e.last_seen_run_id = ?'); params.push(filter.runId); }

  const rows = db
    .prepare(
      `${SELECT_ROWS}
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE e.severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                e.check_id, e.key
       LIMIT 2000`
    )
    .all(...params) as ExceptionRow[];

  const tally = db
    .prepare('SELECT state, severity, COUNT(*) AS n FROM qa_exception GROUP BY state, severity')
    .all() as { state: string; severity: string; n: number }[];
  const count = (pred: (t: { state: string; severity: string }) => boolean): number =>
    tally.filter(pred).reduce((n, t) => n + t.n, 0);

  return {
    rows: rows.map(toRow),
    truncated: rows.length === 2000,
    checks: (db.prepare('SELECT DISTINCT check_id AS c FROM qa_exception ORDER BY c').all() as { c: string }[]).map((r) => r.c),
    domains: (db.prepare('SELECT DISTINCT domain AS d FROM qa_exception ORDER BY d').all() as { d: string }[]).map((r) => r.d),
    counts: {
      open: count((t) => t.state === 'open'),
      acknowledged: count((t) => t.state === 'acknowledged'),
      expiredReview: count((t) => t.state === 'expired_review'),
      blockingActive: count((t) => t.severity === 'blocking' && (ACTIVE_STATES as readonly string[]).includes(t.state))
    }
  };
}

function pretty(json: string | null): string {
  if (json === null) return '';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

export function exceptionDetail(id: number): ExceptionDetailDto {
  const db = currentDb();
  const row = db.prepare(`${SELECT_ROWS} WHERE e.exception_id = ?`).get(id) as ExceptionRow | undefined;
  if (!row) throw new Error(`No exception ${id}.`);

  const full = db
    .prepare(
      `SELECT evidence_json, remediations_json, resolved_at, resolution_kind, resolution_note,
              accepted_at, accepted_note
         FROM qa_exception WHERE exception_id = ?`
    )
    .get(id) as {
    evidence_json: string; remediations_json: string; resolved_at: string | null;
    resolution_kind: string | null; resolution_note: string | null;
    accepted_at: string | null; accepted_note: string | null;
  };

  const events = db
    .prepare(
      `SELECT at, actor, from_state, to_state, note FROM qa_exception_event
        WHERE exception_id = ? ORDER BY row_id`
    )
    .all(id) as { at: string; actor: string; from_state: string | null; to_state: string; note: string | null }[];

  const check = db
    .prepare(
      `SELECT description, thresholds_json, evaluated_total, fired_total, last_fired_at
         FROM qa_check_registry WHERE check_id = ? AND valid_to IS NULL
        ORDER BY registry_version DESC LIMIT 1`
    )
    .get(row.check_id) as
    | { description: string; thresholds_json: string; evaluated_total: number; fired_total: number; last_fired_at: string | null }
    | undefined;

  const dates = datesOf(row.affects_trading_dates_json);
  const statusByDate = new Map<string, string>();
  if (dates.length > 0) {
    const found = db
      .prepare(
        `SELECT trading_date, status FROM qa_domain_day_status
          WHERE domain = ? AND trading_date IN (${dates.map(() => '?').join(',')})`
      )
      .all(row.domain, ...dates) as { trading_date: string; status: string }[];
    for (const f of found) statusByDate.set(f.trading_date, f.status);
  }

  const [keyTicker, keyDate] = row.key.split(' ');
  return {
    row: toRow(row),
    evidence: pretty(full.evidence_json),
    remediations: pretty(full.remediations_json),
    events: events.map((e) => ({ at: e.at, actor: e.actor, fromState: e.from_state, toState: e.to_state, note: e.note })),
    affected: dates.map((d) => ({ date: d, usability: statusByDate.get(d) ?? null })),
    check: check
      ? {
          description: check.description,
          thresholds: pretty(check.thresholds_json),
          evaluatedTotal: check.evaluated_total,
          firedTotal: check.fired_total,
          lastFiredAt: check.last_fired_at
        }
      : null,
    resolvedAt: full.resolved_at,
    resolvedHow: full.resolution_kind,
    resolvedNote: full.resolution_note,
    acceptedAt: full.accepted_at,
    acceptedNote: full.accepted_note,
    reuseCandidate:
      REUSE_CHECKS.has(row.check_id) && keyTicker
        ? { ticker: keyTicker, spliceDate: keyDate && /^\d{4}-\d{2}-\d{2}$/.test(keyDate) ? keyDate : null }
        : null
  };
}

// ── actions ──────────────────────────────────────────────────────────────────
// Each is one `core` call. A refusal arrives as an `OperatorActionRefused`
// message and reaches the renderer as `{ ok: false, error }` through the IPC
// wrapper — the explanation is the deliverable, so it is never swallowed.

export function acknowledgeException(id: number, note: string | null): void {
  acknowledge(currentDb() as never, operatorHost(), id, note?.trim() ? note.trim() : undefined);
}

export function bulkAcknowledgeExceptions(ids: readonly number[], note: string | null): BulkAckResultDto {
  if (ids.length === 0) return { acknowledged: [], skipped: [] };
  if (ids.length > 2000) throw new Error('Refusing to acknowledge more than 2,000 exceptions in one action.');
  const result = bulkAcknowledge(currentDb() as never, operatorHost(), ids, note?.trim() ? note.trim() : undefined);
  return { acknowledged: [...result.acknowledged], skipped: result.skipped.map((s) => ({ ...s })) };
}

export function resolveException(id: number, how: string, note: string): void {
  if (!(RESOLUTION_KINDS as readonly string[]).includes(how)) throw new Error(`Unknown resolution: ${how}`);
  resolve(currentDb() as never, operatorHost(), id, how as ResolutionKind, note);
}

export function acceptException(id: number, note: string, until: string | null): string {
  return accept(currentDb() as never, operatorHost(), id, note, until ?? undefined);
}

export function recordReuse(id: number, ticker: string, spliceDate: string | null, note: string): string {
  const result = recordTickerReuse(currentDb() as never, operatorHost(), {
    exceptionId: id,
    ticker: ticker.trim().toUpperCase(),
    ...(spliceDate ? { spliceDate } : {}),
    note
  });
  return (
    `Closed ${result.closed} membership range(s) the day before ${result.spliceDate} and opened ${result.opened}. ` +
    'No bars were deleted — a reader intersecting bars with membership now sees one entity at a time.'
  );
}

/**
 * Checks that have never fired (QC-952, P10) — read-only at B9a.
 *
 * Listed with how much they have looked at, because zero fires over ten
 * evaluations and zero over ten thousand are different findings. The
 * keep / fix / drop ruling needs somewhere to be recorded that the append-only
 * registry does not offer, and it is B10's pilot-exit review, so it lands there.
 */
export function zeroFireChecks(): readonly ZeroFireDto[] {
  const rows = currentDb()
    .prepare(
      `SELECT check_id, domain, default_severity, description, evaluated_total
         FROM qa_check_registry
        WHERE valid_to IS NULL AND fired_total = 0
        ORDER BY evaluated_total DESC, check_id`
    )
    .all() as { check_id: string; domain: string; default_severity: string; description: string; evaluated_total: number }[];
  return rows.map((r) => ({
    checkId: r.check_id,
    domain: r.domain,
    severity: r.default_severity,
    description: r.description,
    evaluatedTotal: r.evaluated_total
  }));
}
