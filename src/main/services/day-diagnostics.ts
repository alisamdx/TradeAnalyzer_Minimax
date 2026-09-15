// Day diagnostics — one answer to "what happened on date X?" (v1.1.245).
//
// On 2026-09-14 the collector's gate email never arrived, and establishing even what HAD
// happened took a 30,000-line API log, a directory listing of the generation archive, the
// errors log, and questions to the operator — while the one record of whether the email was
// sent sat in the generation database, which the tooling shell cannot open safely. This module
// gathers every source of that answer behind one call, so the route (and
// `scripts/day-report.mjs`) can report any day from inside the app that owns the data:
//
//   - batch_runs for the ET date (every job, both slots, notes and errors)
//   - logs/errors/errors_<date>.jsonl (email outcomes, batch run lines, collector closes)
//   - logs/api/api_<date>.jsonl summarised (calls per provider, failures grouped by message)
//   - the TradeAnalyzer 2 generation: runs, gate report + email status, domain status,
//     response parse outcomes, exceptions
//
// Pure except for file reads, and Electron-free, so it is tested directly.

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/** The subset of better-sqlite3 / core's SqliteLike this module needs. */
export interface QueryableDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ET_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });

/** The America/New_York calendar date of an instant, `YYYY-MM-DD`; '' when unparseable. */
export function etDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : ET_DATE.format(new Date(ms));
}

function etHour(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '??' : ET_HOUR.format(new Date(ms)).padStart(2, '0');
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── batch runs ──────────────────────────────────────────────────────────────

export interface DayBatchRun {
  runId: number;
  jobId: string;
  jobName: string | null;
  startedAt: string;
  completedAt: string | null;
  durationSec: number | null;
  status: string;
  trigger: string;
  slotTime: string | null;
  notes: string | null;
  errorMessage: string | null;
}

export function readBatchRunsForDate(db: QueryableDb, date: string): DayBatchRun[] {
  // `started_at` is UTC ISO; an ET day spans two UTC dates, so read a wide window and
  // filter on the ET date rather than trusting a string range.
  const rows = db
    .prepare(
      `SELECT r.id, r.job_id, j.name AS job_name, r.started_at, r.completed_at, r.status, r.trigger,
              r.slot_time, r.notes, r.error_message
         FROM batch_runs r LEFT JOIN batch_jobs j ON j.id = r.job_id
        WHERE r.started_at >= ? AND r.started_at < ?
        ORDER BY r.started_at, r.id`
    )
    .all(addDays(date, -1), addDays(date, 2)) as Array<{
      id: number; job_id: string; job_name: string | null; started_at: string; completed_at: string | null;
      status: string; trigger: string; slot_time: string | null; notes: string | null; error_message: string | null;
    }>;
  return rows
    .filter((r) => etDate(r.started_at) === date)
    .map((r) => ({
      runId: r.id,
      jobId: r.job_id,
      jobName: r.job_name,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      durationSec: r.completed_at ? Math.round((Date.parse(r.completed_at) - Date.parse(r.started_at)) / 1000) : null,
      status: r.status,
      trigger: r.trigger,
      slotTime: r.slot_time,
      notes: r.notes,
      errorMessage: r.error_message,
    }));
}

// ─── logs ────────────────────────────────────────────────────────────────────

async function* fileLines(path: string): AsyncGenerator<string> {
  // Shared read: the app holds these files open for append.
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

export interface ErrorLogLine {
  timestamp: string;
  level: string;
  operation: string;
  message: string;
}

export interface ErrorLogSummary {
  file: string;
  present: boolean;
  counts: Record<string, number>;
  entries: ErrorLogLine[];
  unparseable: number;
}

export async function summarizeErrorLog(lines: AsyncIterable<string> | Iterable<string>, file: string): Promise<ErrorLogSummary> {
  const out: ErrorLogSummary = { file, present: true, counts: {}, entries: [], unparseable: 0 };
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Partial<ErrorLogLine>;
      const level = String(o.level ?? 'ERROR');
      out.counts[level] = (out.counts[level] ?? 0) + 1;
      out.entries.push({
        timestamp: String(o.timestamp ?? ''),
        level,
        operation: String(o.operation ?? ''),
        message: String(o.message ?? '').replace(/\s+/g, ' ').slice(0, 600),
      });
    } catch {
      out.unparseable++;
    }
  }
  return out;
}

export interface ApiFailureGroup {
  provider: string;
  status: number | null;
  endpoint: string;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** Up to 25 symbols/tickers seen in the failing calls' params. */
  symbols: string[];
}

export interface ApiLogSummary {
  file: string;
  present: boolean;
  lines: number;
  unparseable: number;
  byProvider: Record<string, { calls: number; ok: number; httpError: number; network: number }>;
  /** Calls per provider per ET hour ("14" = 14:00–14:59 ET). */
  byHourEt: Record<string, Record<string, number>>;
  failureGroups: number;
  failures: ApiFailureGroup[];
}

interface ApiLine {
  timestamp?: string;
  provider?: string;
  endpoint?: string;
  requestParams?: Record<string, unknown>;
  responseStatus?: number | null;
  errorMessage?: string | null;
  responseBodyPreview?: string | null;
}

/** The provider's own words for a failure: E*Trade's `<message>`, else the body, else the error. */
function failureMessage(o: ApiLine): string {
  const body = typeof o.responseBodyPreview === 'string' ? o.responseBodyPreview : '';
  const xml = /<message>([\s\S]*?)<\/message>/i.exec(body)?.[1];
  const raw = xml ?? (body && !body.trim().startsWith('<') ? body : '') ?? '';
  return (raw || o.errorMessage || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export async function summarizeApiLog(lines: AsyncIterable<string> | Iterable<string>, file: string): Promise<ApiLogSummary> {
  const out: ApiLogSummary = { file, present: true, lines: 0, unparseable: 0, byProvider: {}, byHourEt: {}, failureGroups: 0, failures: [] };
  const groups = new Map<string, ApiFailureGroup>();

  for await (const line of lines) {
    if (!line.trim()) continue;
    out.lines++;
    let o: ApiLine;
    try {
      o = JSON.parse(line) as ApiLine;
    } catch {
      out.unparseable++;
      continue;
    }
    const provider = o.provider ?? 'unknown';
    const status = typeof o.responseStatus === 'number' ? o.responseStatus : null;
    const p = (out.byProvider[provider] ??= { calls: 0, ok: 0, httpError: 0, network: 0 });
    p.calls++;
    if (status === null) p.network++;
    else if (status >= 200 && status < 300) p.ok++;
    else p.httpError++;

    const hour = etHour(o.timestamp ?? '');
    const h = (out.byHourEt[provider] ??= {});
    h[hour] = (h[hour] ?? 0) + 1;

    if (status !== null && status >= 200 && status < 300) continue;
    const endpoint = String(o.endpoint ?? '').replace(/\?.*$/, '');
    const message = failureMessage(o);
    const key = `${provider}|${status}|${endpoint}|${message}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider, status, endpoint, message, count: 0, firstAt: o.timestamp ?? '', lastAt: o.timestamp ?? '', symbols: [] };
      groups.set(key, g);
    }
    g.count++;
    if (o.timestamp) g.lastAt = o.timestamp;
    const params = o.requestParams ?? {};
    const sym = params['symbol'] ?? params['ticker'] ?? params['symbols'];
    if (typeof sym === 'string' && sym && g.symbols.length < 25 && !g.symbols.includes(sym)) g.symbols.push(sym);
  }

  out.failureGroups = groups.size;
  out.failures = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  return out;
}

// ─── the TradeAnalyzer 2 generation ─────────────────────────────────────────

export interface CollectorDay {
  tradingDay: boolean | null;
  runs: unknown[];
  reports: Array<{
    reportId: number; runId: number; runKind: string | null; overall: string; generatedAt: string;
    emailStatus: string; emailError: string | null; emailSentAt: string | null; domains: unknown;
  }>;
  domainStatus: unknown[];
  responses: unknown[];
  responseFailures: unknown[];
  exceptions: unknown[];
  /** Sections that could not be read, with why — a schema change must not blank the whole report. */
  errors: Record<string, string>;
}

export function readCollectorDay(db: QueryableDb, date: string): CollectorDay {
  const errors: Record<string, string> = {};
  const safe = <T>(name: string, fallback: T, fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      errors[name] = err instanceof Error ? err.message : String(err);
      return fallback;
    }
  };

  const tradingDay = safe('tradingDay', null as boolean | null, () => {
    const r = db.prepare('SELECT is_trading_day FROM ref_trading_day WHERE date = ?').get(date) as { is_trading_day: number } | undefined;
    return r === undefined ? null : r.is_trading_day === 1;
  });

  const runs = safe('runs', [] as Array<Record<string, unknown>>, () =>
    db.prepare(
      `SELECT run_id, run_kind, slot, status, started_at, finished_at, host_app, host_version, collector_version
         FROM meta_run WHERE trading_date = ? ORDER BY run_id`
    ).all(date) as Array<Record<string, unknown>>
  );
  const runIds = runs.map((r) => Number(r['run_id'])).filter((n) => Number.isFinite(n));
  const inRuns = runIds.length > 0 ? `(${runIds.join(',')})` : '(NULL)';

  const reports = safe('reports', [] as CollectorDay['reports'], () =>
    (db.prepare(
      `SELECT q.report_id, q.run_id, r.run_kind, q.overall, q.generated_at, q.email_status, q.email_error,
              q.email_sent_at, q.domains_json
         FROM qa_quality_report q JOIN meta_run r ON r.run_id = q.run_id
        WHERE r.trading_date = ? ORDER BY q.report_id`
    ).all(date) as Array<{
      report_id: number; run_id: number; run_kind: string | null; overall: string; generated_at: string;
      email_status: string; email_error: string | null; email_sent_at: string | null; domains_json: string;
    }>).map((q) => ({
      reportId: q.report_id,
      runId: q.run_id,
      runKind: q.run_kind,
      overall: q.overall,
      generatedAt: q.generated_at,
      emailStatus: q.email_status,
      emailError: q.email_error,
      emailSentAt: q.email_sent_at,
      domains: (() => { try { return JSON.parse(q.domains_json) as unknown; } catch { return q.domains_json; } })(),
    }))
  );

  const domainStatus = safe('domainStatus', [] as unknown[], () =>
    db.prepare(
      `SELECT domain, status, blocking_open, warning_open, computed_at, by_run_id
         FROM qa_domain_day_status
        WHERE row_id IN (SELECT MAX(row_id) FROM qa_domain_day_status WHERE trading_date = ? GROUP BY domain)
        ORDER BY domain`
    ).all(date)
  );

  const responses = safe('responses', [] as unknown[], () =>
    db.prepare(
      `SELECT provider, parse_status, COUNT(*) AS responses,
              SUM(CASE WHEN http_status BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS non_2xx,
              SUM(COALESCE(parsed_row_count, 0)) AS rows_parsed,
              SUM(at_provider_cap) AS at_cap
         FROM meta_response WHERE run_id IN ${inRuns}
        GROUP BY provider, parse_status ORDER BY provider, parse_status`
    ).all()
  );

  const responseFailures = safe('responseFailures', [] as unknown[], () =>
    db.prepare(
      `SELECT provider, endpoint, http_status, parse_status, parse_error, COUNT(*) AS responses
         FROM meta_response
        WHERE run_id IN ${inRuns} AND (parse_status <> 'ok' OR http_status IS NULL OR http_status NOT BETWEEN 200 AND 299)
        GROUP BY provider, endpoint, http_status, parse_status, parse_error
        ORDER BY responses DESC LIMIT 40`
    ).all()
  );

  const exceptions = safe('exceptions', [] as unknown[], () =>
    db.prepare(
      `SELECT check_id, severity, state, COUNT(*) AS findings, MIN(detail) AS example
         FROM qa_exception WHERE last_seen_run_id IN ${inRuns}
        GROUP BY check_id, severity, state ORDER BY findings DESC`
    ).all()
  );

  return { tradingDay, runs, reports, domainStatus, responses, responseFailures, exceptions, errors };
}

// ─── the report ──────────────────────────────────────────────────────────────

export interface DayReport {
  date: string;
  generatedAt: string;
  attention: string[];
  batchRuns: DayBatchRun[];
  errorsLog: ErrorLogSummary;
  apiLog: ApiLogSummary;
  collector: CollectorDay | { unavailable: string };
}

export interface DayReportDeps {
  batchDb: QueryableDb;
  logsDir: string;
  readCollectorDay: (date: string) => CollectorDay | { unavailable: string };
}

/** What a person should look at first. Plain sentences, most serious first. */
export function buildAttention(r: Omit<DayReport, 'attention' | 'generatedAt'>): string[] {
  const out: string[] = [];
  const collector = 'unavailable' in r.collector ? null : r.collector;
  const weekday = new Date(`${r.date}T12:00:00Z`).getUTCDay() % 6 !== 0;
  const tradingDay = collector?.tradingDay ?? weekday;

  for (const run of r.batchRuns) {
    if (run.status === 'failed') out.push(`Batch job ${run.jobId} FAILED at ${run.startedAt}: ${run.errorMessage ?? run.notes ?? 'no message'}`);
    if (run.status === 'warning') out.push(`Batch job ${run.jobId} finished with a WARNING at ${run.startedAt}: ${run.notes ?? 'no note'}`);
    if (run.status === 'running') out.push(`Batch job ${run.jobId} is still marked running (started ${run.startedAt}).`);
  }

  if (tradingDay) {
    const ran = new Set(r.batchRuns.map((b) => b.jobId));
    for (const job of ['daily-intelligence-brief', 'data-collector', 'collector-watchdog']) {
      if (!ran.has(job)) out.push(`Expected job ${job} has no run on this trading day.`);
    }
  }

  if (!collector) {
    out.push(`TradeAnalyzer 2 generation not read: ${(r.collector as { unavailable: string }).unavailable}`);
  } else {
    const daily = collector.reports.filter((q) => q.runKind === 'daily');
    if (tradingDay && collector.runs.length > 0 && daily.length === 0) out.push('Collector ran but wrote no daily gate report.');
    if (tradingDay && collector.runs.length === 0) out.push('No collector run is recorded for this date.');
    for (const q of collector.reports) {
      if (q.overall !== 'green') out.push(`Gate verdict ${q.overall.toUpperCase()} (run ${q.runId}, ${q.runKind ?? '?'}).`);
      if (q.emailStatus !== 'sent') out.push(`Gate email for run ${q.runId} was NOT sent — status ${q.emailStatus}${q.emailError ? `: ${q.emailError}` : ''}.`);
    }
    for (const [section, why] of Object.entries(collector.errors)) out.push(`Collector section ${section} unreadable: ${why}`);
  }

  if (!r.errorsLog.present) out.push(`No errors log for this date (${r.errorsLog.file}).`);
  const bad = r.errorsLog.entries.filter((e) => e.level === 'ERROR' || e.level === 'FATAL');
  for (const e of bad.slice(0, 15)) out.push(`Log ${e.level} ${e.operation}: ${e.message.slice(0, 240)}`);
  if (bad.length > 15) out.push(`…and ${bad.length - 15} more ERROR lines in the errors log.`);

  if (!r.apiLog.present) out.push(`No API log for this date (${r.apiLog.file}).`);
  for (const [provider, p] of Object.entries(r.apiLog.byProvider)) {
    if (p.network > 0) out.push(`${provider}: ${p.network} call(s) with no HTTP response (network fault or terminated stream).`);
  }
  for (const f of r.apiLog.failures) {
    if (f.status === 401 || f.status === 403) out.push(`${f.provider} ${f.status} ×${f.count} on ${f.endpoint}: ${f.message}`);
  }
  return out;
}

export async function buildDayReport(deps: DayReportDeps, date: string): Promise<DayReport> {
  const errorsFile = join(deps.logsDir, 'errors', `errors_${date}.jsonl`);
  const apiFile = join(deps.logsDir, 'api', `api_${date}.jsonl`);

  const errorsLog = existsSync(errorsFile)
    ? await summarizeErrorLog(fileLines(errorsFile), errorsFile)
    : { file: errorsFile, present: false, counts: {}, entries: [], unparseable: 0 };
  const apiLog = existsSync(apiFile)
    ? await summarizeApiLog(fileLines(apiFile), apiFile)
    : { file: apiFile, present: false, lines: 0, unparseable: 0, byProvider: {}, byHourEt: {}, failureGroups: 0, failures: [] };

  let collector: CollectorDay | { unavailable: string };
  try {
    collector = deps.readCollectorDay(date);
  } catch (err) {
    collector = { unavailable: err instanceof Error ? err.message : String(err) };
  }

  const base = { date, batchRuns: readBatchRunsForDate(deps.batchDb, date), errorsLog, apiLog, collector };
  return { ...base, generatedAt: new Date().toISOString(), attention: buildAttention(base) };
}
