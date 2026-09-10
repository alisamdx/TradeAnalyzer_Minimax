import { currentDb } from './generation.js';
import type { RunCallGroupDto, RunDetailDto, RunDomainDto, RunRowDto } from '../shared/types.js';

/**
 * The Runs view's main-process half — 05 §2, B9a.
 *
 * Every collector run and one-shot job: what it called, how the calls went,
 * and what the gate made of the result. Table and column names live here only
 * (AC-13).
 *
 * The report is shown as it was written. `meta_run.gate_verdict` is the verdict
 * **at the moment the run finished** and is never updated, so a run that went
 * red and whose exceptions were later resolved still reads red here — correctly.
 * Whether its data is usable NOW is `qa_domain_day_status`, which the
 * Exceptions view shows per affected day.
 */

interface RunRow {
  run_id: number;
  run_kind: string;
  trading_date: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  gate_verdict: string | null;
  host_app: string;
  host_version: string;
  collector_version: string;
  responses: number;
  failed: number;
  bytes: number;
}

const SELECT_RUNS = `
  SELECT r.run_id, r.run_kind, r.trading_date, r.started_at, r.finished_at, r.status, r.gate_verdict,
         r.host_app, r.host_version, r.collector_version,
         (SELECT COUNT(*) FROM meta_response m WHERE m.run_id = r.run_id) AS responses,
         (SELECT COUNT(*) FROM meta_response m WHERE m.run_id = r.run_id AND m.parse_status = 'failed') AS failed,
         (SELECT COALESCE(SUM(m.byte_length), 0) FROM meta_response m WHERE m.run_id = r.run_id) AS bytes
    FROM meta_run r`;

function toDto(r: RunRow): RunRowDto {
  return {
    runId: r.run_id,
    kind: r.run_kind,
    date: r.trading_date,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    outcome: r.status,
    gate: r.gate_verdict,
    host: `${r.host_app} ${r.host_version}`,
    collector: r.collector_version,
    responses: r.responses,
    failedParses: r.failed,
    bytes: r.bytes
  };
}

export function listRuns(): readonly RunRowDto[] {
  const rows = currentDb().prepare(`${SELECT_RUNS} ORDER BY r.run_id DESC LIMIT 300`).all() as RunRow[];
  return rows.map(toDto);
}

/** `archive/etrade/2026-09-05/optionchains.jsonl.gz` → `optionchains`. The slug names the call. */
function slugOf(archiveFile: string): string {
  const base = archiveFile.split('/').pop() ?? archiveFile;
  return base.split('.')[0] ?? base;
}

/**
 * `{ n, p50, p99, max, threshold, nearBoundary }` as one line.
 *
 * The distance to the threshold is the part a threshold review needs (P10), so
 * it stays in view rather than behind a click.
 */
function summariseDistribution(json: string | null): string | null {
  if (json === null) return null;
  try {
    const d = JSON.parse(json) as Record<string, unknown>;
    const parts = ['n', 'p50', 'p99', 'max', 'threshold', 'nearBoundary']
      .filter((k) => d[k] !== undefined && d[k] !== null)
      .map((k) => {
        const v = d[k];
        return `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toPrecision(4) : String(v)}`;
      });
    return parts.join(' ');
  } catch {
    return json;
  }
}

export function runDetail(runId: number): RunDetailDto {
  const db = currentDb();
  const run = db.prepare(`${SELECT_RUNS} WHERE r.run_id = ?`).get(runId) as RunRow | undefined;
  if (!run) throw new Error(`No run ${runId}.`);

  // Grouped by archive file in SQL (a file is one provider × date × slug), then
  // merged by slug here — a daily run's ~7,000 chain calls are one line, not
  // seven thousand.
  const files = db
    .prepare(
      `SELECT provider, archive_file, COUNT(*) AS n,
              SUM(CASE WHEN parse_status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN http_status IS NULL OR http_status < 200 OR http_status >= 300 THEN 1 ELSE 0 END) AS non2xx,
              SUM(at_provider_cap) AS capped,
              COALESCE(SUM(byte_length), 0) AS bytes
         FROM meta_response WHERE run_id = ?
        GROUP BY provider, archive_file`
    )
    .all(runId) as { provider: string; archive_file: string; n: number; failed: number; non2xx: number; capped: number; bytes: number }[];

  const groups = new Map<string, RunCallGroupDto>();
  for (const f of files) {
    const call = slugOf(f.archive_file);
    const id = `${f.provider}\n${call}`;
    const g = groups.get(id);
    groups.set(id, {
      provider: f.provider,
      call,
      count: (g?.count ?? 0) + f.n,
      failedParses: (g?.failedParses ?? 0) + f.failed,
      notOk: (g?.notOk ?? 0) + f.non2xx,
      atCap: (g?.atCap ?? 0) + f.capped,
      bytes: (g?.bytes ?? 0) + f.bytes
    });
  }

  const report = db
    .prepare(
      `SELECT overall, domains_json, email_status, email_error, email_sent_at
         FROM qa_quality_report WHERE run_id = ? ORDER BY report_id DESC LIMIT 1`
    )
    .get(runId) as
    | { overall: string; domains_json: string; email_status: string; email_error: string | null; email_sent_at: string | null }
    | undefined;

  const checks = db
    .prepare(
      `SELECT check_id, evaluated_count, fired_count, duration_ms, distribution_json
         FROM qa_check_result WHERE run_id = ?
        ORDER BY fired_count DESC, check_id`
    )
    .all(runId) as { check_id: string; evaluated_count: number; fired_count: number; duration_ms: number; distribution_json: string | null }[];

  const raised = db
    .prepare('SELECT COUNT(*) AS n FROM qa_exception WHERE first_seen_run_id = ?')
    .get(runId) as { n: number };
  const seen = db
    .prepare('SELECT COUNT(*) AS n FROM qa_exception WHERE last_seen_run_id = ?')
    .get(runId) as { n: number };
  const request = db
    .prepare('SELECT request_id FROM meta_job_request WHERE run_id = ? ORDER BY request_id DESC LIMIT 1')
    .get(runId) as { request_id: number } | undefined;

  return {
    run: toDto(run),
    calls: [...groups.values()].sort((a, b) => b.count - a.count),
    report: report
      ? {
          gate: report.overall,
          emailStatus: report.email_status,
          emailError: report.email_error,
          emailSentAt: report.email_sent_at,
          domains: domainsOf(report.domains_json)
        }
      : null,
    checks: checks.map((c) => ({
      checkId: c.check_id,
      evaluated: c.evaluated_count,
      fired: c.fired_count,
      durationMs: c.duration_ms,
      distribution: summariseDistribution(c.distribution_json)
    })),
    exceptionsRaised: raised.n,
    exceptionsSeen: seen.n,
    requestId: request?.request_id ?? null
  };
}

/**
 * The per-domain table the email prints, read without assuming its exact
 * shape: an object keyed by domain whose values carry `expected`/`stored` and
 * possibly a status. Anything that does not fit comes through as a row with
 * nulls rather than disappearing, so a format change shows as blanks instead
 * of as a shorter table.
 */
function domainsOf(json: string): RunDomainDto[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const entries: [string, unknown][] = Array.isArray(parsed)
    ? parsed.map((v, i) => [String((v as Record<string, unknown>)?.['domain'] ?? i), v])
    : parsed && typeof parsed === 'object'
      ? Object.entries(parsed as Record<string, unknown>)
      : [];
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return entries.map(([name, v]) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const verdict = o['status'] ?? o['verdict'];
    return {
      name,
      expected: num(o['expected']),
      stored: num(o['stored']),
      usability: typeof verdict === 'string' ? verdict : null
    };
  });
}
