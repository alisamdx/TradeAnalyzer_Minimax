import type { SqliteLike } from '../db/sqlite-like.js';
import type { Severity } from './check.js';
import { cleanDayStreak, type Verdict } from './gate.js';

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
  accepted_until: string | null;
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
      `SELECT check_id, domain, key, severity, state, detail, consecutive_runs, still_firing, accepted_until
         FROM qa_exception
        WHERE state IN ('open', 'acknowledged')
        ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, check_id, key`
    )
    .all() as ExceptionRow[];

  const blocking = open.filter((e) => e.severity === 'blocking');
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

  const streak = cleanDayStreak(db, args.tradingDate);
  const target = args.pilotTargetDays ?? 20;

  const verdictLabel =
    args.verdict === 'red'
      ? `RED (${blocking.length} blocking)`
      : args.verdict === 'amber'
        ? `AMBER (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
        : 'GREEN';

  const subject = `[TA-Data] ${args.tradingDate} ${args.slot} — ${verdictLabel}`;

  const lines: string[] = [];
  lines.push(
    `Run #${args.runId}  gen-${String(args.generationNo).padStart(3, '0')} ` +
      `(${args.generationStatus}, clean-day streak ${streak}/${target})  ` +
      `${args.startedAt.slice(11, 16)}–${args.finishedAt.slice(11, 16)} ET  collector ${args.collectorVersion}`
  );
  lines.push('');

  if (blocking.length > 0) {
    lines.push(`BLOCKING (${blocking.length})`);
    for (const e of blocking) {
      lines.push(`  ${e.check_id} ${e.domain}  ${e.key}  ${e.detail} · open ${e.consecutive_runs} run${e.consecutive_runs === 1 ? '' : 's'}`);
    }
    lines.push('');
  }

  if (repeats.length > 0) {
    lines.push(`REPEAT OFFENDERS (${repeats.length})`);
    for (const e of repeats) {
      lines.push(`  ${e.check_id} ${e.domain}  ${e.key}  ${e.detail} · ${e.consecutive_runs} consecutive runs`);
    }
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
    for (const e of stopped) lines.push(`  ${e.check_id} ${e.domain}  ${e.key}  ${e.detail}`);
    lines.push('');
  }

  if (expired.length > 0) {
    lines.push(`EXPIRED ACCEPTANCES (${expired.length})               ← needs a ruling; blocks promotion, not the day`);
    for (const e of expired) {
      lines.push(`  ${e.check_id} ${e.domain}  ${e.key}  ${e.detail} · expired ${e.accepted_until ?? '?'}`);
    }
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
