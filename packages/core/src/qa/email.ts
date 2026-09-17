import type { SqliteLike } from '../db/sqlite-like.js';
import type { Severity } from './check.js';
import { cleanDayStreak, type Verdict } from './gate.js';
import { computeRunDelta, deltaHeadline, deltaLines } from './delta.js';

/**
 * The status email — 03 §7.
 *
 * Sent after **every** run that reaches the gate, including one-shot jobs and
 * including green days. That is the whole design: an email only on failure makes
 * silence ambiguous, and the failure this system most needs to catch is a
 * collector that stopped running. A green email is how you know the machinery is
 * alive.
 *
 * One screen. Blocking first, one line per exception with its key, evidence,
 * remediation outcome and age; counts only for warnings; the domain table
 * always present; the open-exception totals always present, because **nothing
 * ages out silently** (P9).
 */

export interface EmailModel {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface ExceptionRow {
  check_id: string;
  domain: string;
  key: string;
  severity: Severity;
  state: string;
  detail: string;
  consecutive_runs: number;
  still_firing: number;
  last_seen_run_id: number;
  accepted_until: string | null;
}

/**
 * How many individual rows a single check may contribute before it collapses to
 * a count and an example.
 *
 * The lists here used to be uncapped, one line per finding. On 2026-09-15 that
 * made a body of 773 blocking rows — past the ~102 KB where Gmail clips a
 * message, and unreadable long before that. **An alert that cannot be read has
 * already failed**, whatever the delivery log says: 415 identical QC-409 lines
 * are one fact about one bug, and printing them 415 times buried the eight other
 * checks that each needed a different decision.
 */
const MAX_ROWS_PER_CHECK = 3;

/**
 * Collapses a list of findings to one line per check, plus up to
 * `MAX_ROWS_PER_CHECK` real rows so the reader still sees concrete evidence.
 *
 * The count is never dropped or rounded — "and 412 more" is the part that says
 * how big the problem is, and a summary that hides the tail would repeat the
 * mistake this file is fixing.
 */
function summariseByCheck(rows: readonly ExceptionRow[]): string[] {
  const byCheck = new Map<string, ExceptionRow[]>();
  for (const r of rows) {
    const list = byCheck.get(r.check_id);
    if (list) list.push(r);
    else byCheck.set(r.check_id, [r]);
  }

  const out: string[] = [];
  for (const [checkId, list] of [...byCheck.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const first = list[0]!;
    out.push(
      `  ${checkId} ${first.domain} ×${list.length}` +
        (list.length === 1 ? '' : `  (open ${first.consecutive_runs} run${first.consecutive_runs === 1 ? '' : 's'})`)
    );
    for (const e of list.slice(0, MAX_ROWS_PER_CHECK)) {
      out.push(`      ${e.key}  ${e.detail}`);
    }
    if (list.length > MAX_ROWS_PER_CHECK) {
      out.push(`      … and ${list.length - MAX_ROWS_PER_CHECK} more`);
    }
  }
  return out;
}

export function buildStatusEmail(
  db: SqliteLike,
  args: {
    readonly runId: number;
    readonly tradingDate: string;
    readonly slot: string;
    readonly verdict: Verdict;
    readonly generationNo: number;
    readonly generationStatus: string;
    readonly collectorVersion: string;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly domains: Readonly<Record<string, { expected: number; stored: number }>>;
    readonly pilotTargetDays?: number;
  }
): EmailModel {
  const open = db
    .prepare(
      `SELECT check_id, domain, key, severity, state, detail, consecutive_runs, still_firing, last_seen_run_id, accepted_until
         FROM qa_exception
        WHERE state IN ('open', 'acknowledged')
        ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, check_id, key`
    )
    .all() as ExceptionRow[];

  const blocking = open.filter((e) => e.severity === 'blocking');
  // The subject counts what THIS run found. Counting every open exception in the
  // generation put 3,438 in the subject of a run whose gate counted 2,321 on
  // 2026-09-16, and the two numbers could not be reconciled from the email.
  const blockingThisRun = blocking.filter((e) => e.last_seen_run_id === args.runId && e.still_firing === 1);
  const warnings = open.filter((e) => e.severity === 'warning');
  const repeats = open.filter((e) => e.consecutive_runs >= 3);
  const stopped = open.filter((e) => e.still_firing === 0);

  const expired = db
    .prepare(
      `SELECT check_id, domain, key, detail, accepted_until FROM qa_exception
        WHERE state = 'expired_review' ORDER BY check_id, key`
    )
    .all() as { check_id: string; domain: string; key: string; detail: string; accepted_until: string | null }[];

  const totals = db
    .prepare(
      `SELECT
         SUM(state = 'open') AS open_n,
         SUM(state = 'acknowledged') AS ack_n,
         SUM(state = 'accepted') AS accepted_n,
         SUM(state = 'expired_review') AS expired_n,
         SUM(state = 'resolved' AND resolved_at IS NOT NULL) AS resolved_n
       FROM qa_exception`
    )
    .get() as Record<string, number | null>;

  const statuses = db
    .prepare('SELECT domain, status FROM qa_domain_day_status WHERE trading_date = ?')
    .all(args.tradingDate) as { domain: string; status: string }[];
  const statusByDomain = new Map(statuses.map((s) => [s.domain, s.status]));

  const zeroFire = db
    .prepare(
      `SELECT COUNT(*) AS n FROM qa_check_registry WHERE valid_to IS NULL AND fired_total = 0`
    )
    .get() as { n: number };
  const totalChecks = db
    .prepare('SELECT COUNT(*) AS n FROM qa_check_registry WHERE valid_to IS NULL')
    .get() as { n: number };

  // A check that evaluated nothing is not a clean check — it is a check that
  // COULD not have fired, and the zero-fire aggregate above cannot tell the two
  // apart. QC-602 sat at evaluated 0 for the whole generation because it joined
  // on a source the collector never fetches, and nothing ever said so: the gate
  // computed `checksVacuous`, the daily result carried it, and it was rendered
  // nowhere. Named per run, because the name is the entire value of the line.
  const vacuous = db
    .prepare(
      'SELECT check_id FROM qa_check_result WHERE run_id = ? AND evaluated_count = 0 ORDER BY check_id'
    )
    .all(args.runId) as { check_id: string }[];

  const streak = cleanDayStreak(db, args.tradingDate);
  const target = args.pilotTargetDays ?? 20;

  const verdictLabel =
    args.verdict === 'red'
      ? `RED (${blockingThisRun.length} blocking)`
      : args.verdict === 'amber'
        ? `AMBER (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
        : 'GREEN';

  // The delta goes in the SUBJECT, because the subject is what gets read on a
  // phone and it is what decides whether the email is opened at all. "RED" has
  // been true of every daily run this generation; "RED · 1 NEW" and "RED · no
  // change" are different pieces of news wearing the same verdict.
  const delta = computeRunDelta(db, args.runId);
  const subject = `[TA-Data] ${args.tradingDate} ${args.slot} — ${verdictLabel} · ${deltaHeadline(delta)}`;

  const lines: string[] = [];
  lines.push(
    `Run #${args.runId}  gen-${String(args.generationNo).padStart(3, '0')} ` +
      `(${args.generationStatus}, clean-day streak ${streak}/${target})  ` +
      `${args.startedAt.slice(11, 16)}–${args.finishedAt.slice(11, 16)} ET  collector ${args.collectorVersion}`
  );
  lines.push('');

  // First block in the body, above BLOCKING: the standing backlog is context,
  // and what this run changed is the news.
  for (const line of deltaLines(delta)) lines.push(line);

  if (blocking.length > 0) {
    lines.push(
      `BLOCKING (${blocking.length}: ${blockingThisRun.length} found by this run, ` +
        `${blocking.length - blockingThisRun.length} still open from earlier runs)`
    );
    for (const line of summariseByCheck(blocking)) lines.push(line);
    lines.push('');
  }

  if (repeats.length > 0) {
    lines.push(`REPEAT OFFENDERS (${repeats.length})`);
    for (const line of summariseByCheck(repeats)) lines.push(line);
    lines.push('');
  }

  if (warnings.length > 0) {
    const byCheck = new Map<string, number>();
    for (const w of warnings) byCheck.set(w.check_id, (byCheck.get(w.check_id) ?? 0) + 1);
    lines.push(
      `WARNINGS (${warnings.length})  ` +
        [...byCheck.entries()].map(([id, n]) => `${id} ×${n}`).join(', ')
    );
    lines.push('');
  }

  lines.push('DOMAINS                    expected   stored   status');
  for (const [domain, counts] of Object.entries(args.domains)) {
    lines.push(
      `  ${domain.padEnd(24)} ${String(counts.expected).padStart(8)} ${String(counts.stored).padStart(8)}   ` +
        (statusByDomain.get(domain) ?? 'usable')
    );
  }
  lines.push('');

  if (stopped.length > 0) {
    // Listed explicitly rather than quietly dropped. "It went away" is exactly
    // how the earnings-date bug hid for a quarter.
    lines.push(`NO LONGER OBSERVED, UNRESOLVED (${stopped.length})`);
    for (const line of summariseByCheck(stopped)) lines.push(line);
    lines.push('');
  }

  if (expired.length > 0) {
    lines.push(`EXPIRED ACCEPTANCES (${expired.length})               ← needs a ruling; blocks promotion, not the day`);
    for (const e of expired) {
      lines.push(`  ${e.check_id} ${e.domain}  ${e.key}  ${e.detail} · expired ${e.accepted_until ?? '?'}`);
    }
    lines.push('');
  }

  if (vacuous.length > 0) {
    lines.push(`EVALUATED NOTHING (${vacuous.length})                       ← could not fire; not the same as clean`);
    lines.push(`  ${vacuous.map((v) => v.check_id).join(', ')}`);
    lines.push('');
  }

  lines.push(
    `OPEN EXCEPTIONS  ${totals['open_n'] ?? 0} open · ${totals['ack_n'] ?? 0} acknowledged · ` +
      `${totals['accepted_n'] ?? 0} accepted · ${totals['expired_n'] ?? 0} expired_review · ` +
      `${totals['resolved_n'] ?? 0} resolved`
  );
  lines.push(`Zero-fire checks: ${zeroFire.n} of ${totalChecks.n}`);
  lines.push('');
  lines.push(`→ Exceptions view: tradeanalyzer-next://exceptions?run=${args.runId}`);

  const text = lines.join('\n');

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const colour = args.verdict === 'red' ? '#b3261e' : args.verdict === 'amber' ? '#8a6524' : '#1e7a4d';
  const html =
    `<div style="font-family:Consolas,Menlo,monospace;font-size:13px;line-height:1.5">` +
    `<div style="border-left:4px solid ${colour};padding-left:10px;margin-bottom:12px">` +
    `<strong style="font-size:15px">${esc(verdictLabel)}</strong><br>${esc(args.tradingDate)} ${esc(args.slot)}</div>` +
    `<pre style="white-space:pre-wrap;margin:0">${esc(text)}</pre></div>`;

  return { subject, text, html };
}

/** The watchdog's email: the one that reports the absence of an email (03 §7.3). */
export function buildNoRunEmail(tradingDate: string, detail: string): EmailModel {
  const subject = `[TA-Data] ${tradingDate} — NO RUN`;
  const text =
    `No completed collector run exists for ${tradingDate}.\n\n${detail}\n\n` +
    'Every domain for this date has been marked `not_run`, which is a declared gap rather than an ' +
    'absence of rows — a missing day and a day nobody looked at are different facts, and only one ' +
    'of them is recoverable by re-running.\n\n' +
    'This email exists because a dead scheduler produces no run, therefore no gate, therefore no ' +
    'status email. Silence is the failure mode this reports.';
  const html =
    `<div style="font-family:Consolas,Menlo,monospace;font-size:13px">` +
    `<div style="border-left:4px solid #b3261e;padding-left:10px"><strong>NO RUN</strong><br>${tradingDate}</div>` +
    `<pre style="white-space:pre-wrap">${text.replace(/</g, '&lt;')}</pre></div>`;
  return { subject, text, html };
}
