#!/usr/bin/env node
// Day report — everything recorded about one trading day, on one page (v1.1.245).
//
//   node scripts/day-report.mjs                 # today (ET)
//   node scripts/day-report.mjs --date 2026-09-14
//   node scripts/day-report.mjs --date 2026-09-14 --json   # also save the raw JSON
//
// Reads GET /api/v1/diagnostics/day from the RUNNING app, so every number comes from the
// app's own database connection and log files — never from opening a SQLite file here
// (CLAUDE.md: a containerised shell sees a redirected %APPDATA%, and a second SQLite
// writer has corrupted a generation before). Writes Markdown to
// ~/.tradeanalyzer/day-reports/day-<date>.md and prints it.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const DATE = argOf('--date', etToday);
const SAVE_JSON = args.includes('--json');

const DATA_DIR = join(homedir(), '.tradeanalyzer');
const TOKEN = readFileSync(join(DATA_DIR, 'agent.token'), 'utf8').trim();
let PORT = '7432';
try { PORT = readFileSync(join(DATA_DIR, 'api.port'), 'utf8').trim() || PORT; } catch { /* default */ }
const API = `http://127.0.0.1:${PORT}/api/v1`;

const res = await fetch(`${API}/diagnostics/day?date=${encodeURIComponent(DATE)}`, { headers: { 'X-Agent-Token': TOKEN } }).catch((err) => {
  console.error(`API server not reachable on 127.0.0.1:${PORT} — the app must be RUNNING. (${err.message})`);
  process.exit(1);
});
const body = await res.json().catch(() => null);
if (!res.ok || !body?.ok) {
  console.error(`diagnostics/day failed: HTTP ${res.status} ${body?.error ?? ''}`);
  if (res.status === 404) console.error('This app build predates the route (v1.1.245). Install the new build.');
  process.exit(1);
}
const d = body.data;

// ── formatting ─────────────────────────────────────────────────────────────
const etTime = (iso) => {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
};
const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\s+/g, ' '));
const table = (headers, rows) => {
  if (rows.length === 0) return '_none_\n';
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
};

const out = [];
out.push(`# TradeAnalyzer day report — ${d.date}`, '');
out.push(`Generated ${d.generatedAt} from the running app.`, '');

out.push(`## Needs attention (${d.attention.length})`, '');
out.push(d.attention.length ? d.attention.map((a) => `- ${a}`).join('\n') : '- Nothing flagged.', '');

out.push(`## Batch runs (${d.batchRuns.length})`, '');
out.push(table(
  ['started ET', 'job', 'trigger / slot', 'status', 'secs', 'notes / error'],
  d.batchRuns.map((r) => [etTime(r.startedAt), r.jobId, `${r.trigger}${r.slotTime ? ` / ${r.slotTime}` : ''}`, r.status, r.durationSec, [r.errorMessage ? `ERROR: ${r.errorMessage}` : '', r.notes ?? ''].filter(Boolean).join(' · ')])
));

out.push('## TradeAnalyzer 2 collector', '');
const c = d.collector;
if (c.unavailable) {
  out.push(`_Not read: ${c.unavailable}_`, '');
} else {
  out.push(`Trading day: **${c.tradingDay === null ? 'unknown' : c.tradingDay ? 'yes' : 'no'}**`, '');
  out.push('### Runs', '', table(
    ['run', 'kind', 'slot', 'status', 'started', 'finished', 'host', 'collector'],
    c.runs.map((r) => [r.run_id, r.run_kind, r.slot, r.status, r.started_at, r.finished_at, `${r.host_app ?? ''} ${r.host_version ?? ''}`, r.collector_version])
  ));
  out.push('### Gate reports and email', '', table(
    ['report', 'run', 'kind', 'verdict', 'generated', 'email', 'sent at', 'email error'],
    c.reports.map((q) => [q.reportId, q.runId, q.runKind, q.overall.toUpperCase(), q.generatedAt, q.emailStatus, q.emailSentAt, q.emailError])
  ));
  for (const q of c.reports) {
    const domains = q.domains && typeof q.domains === 'object' ? Object.entries(q.domains) : [];
    if (domains.length === 0) continue;
    out.push(`Domains in report ${q.reportId}:`, '', table(
      ['domain', 'expected', 'stored', 'status'],
      domains.map(([name, v]) => [name, v?.expected, v?.stored, v?.status])
    ));
  }
  out.push('### Domain status', '', table(
    ['domain', 'status', 'blocking open', 'warning open', 'computed'],
    c.domainStatus.map((s) => [s.domain, s.status, s.blocking_open, s.warning_open, s.computed_at])
  ));
  out.push('### Responses by provider', '', table(
    ['provider', 'parse', 'responses', 'non-2xx', 'rows parsed', 'at cap'],
    c.responses.map((r) => [r.provider, r.parse_status, r.responses, r.non_2xx, r.rows_parsed, r.at_cap])
  ));
  out.push('### Failed or non-2xx responses', '', table(
    ['provider', 'endpoint', 'http', 'parse', 'error', 'n'],
    c.responseFailures.map((r) => [r.provider, r.endpoint, r.http_status, r.parse_status, r.parse_error, r.responses])
  ));
  out.push('### Exceptions seen in these runs', '', table(
    ['check', 'severity', 'state', 'findings', 'example'],
    c.exceptions.map((e) => [e.check_id, e.severity, e.state, e.findings, e.example])
  ));
  const errs = Object.entries(c.errors ?? {});
  if (errs.length) out.push('Unreadable sections:', '', errs.map(([k, v]) => `- ${k}: ${v}`).join('\n'), '');
}

out.push(`## Errors log`, '');
const e = d.errorsLog;
if (!e.present) {
  out.push(`_Missing: ${e.file}_`, '');
} else {
  out.push(`${e.file} — ${Object.entries(e.counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'empty'}${e.unparseable ? `, ${e.unparseable} unparseable` : ''}`, '');
  out.push(table(['time ET', 'level', 'operation', 'message'], e.entries.map((x) => [etTime(x.timestamp), x.level, x.operation, x.message.slice(0, 300)])));
}

out.push('## API log', '');
const a = d.apiLog;
if (!a.present) {
  out.push(`_Missing: ${a.file}_`, '');
} else {
  out.push(`${a.file} — ${a.lines} calls${a.unparseable ? `, ${a.unparseable} unparseable` : ''}`, '');
  out.push(table(['provider', 'calls', '2xx', 'HTTP error', 'no response'], Object.entries(a.byProvider).map(([p, v]) => [p, v.calls, v.ok, v.httpError, v.network])));
  const hours = [...new Set(Object.values(a.byHourEt).flatMap((h) => Object.keys(h)))].sort();
  out.push('Calls per ET hour:', '', table(['provider', ...hours], Object.entries(a.byHourEt).map(([p, h]) => [p, ...hours.map((x) => h[x] ?? '')])));
  out.push(`Failures (${a.failureGroups} group(s), top ${a.failures.length}):`, '', table(
    ['provider', 'http', 'endpoint', 'message', 'n', 'first ET', 'last ET', 'symbols'],
    a.failures.map((f) => [f.provider, f.status ?? 'none', f.endpoint, f.message, f.count, etTime(f.firstAt), etTime(f.lastAt), f.symbols.join(', ')])
  ));
}

const text = out.join('\n');
const dir = join(DATA_DIR, 'day-reports');
mkdirSync(dir, { recursive: true });
const mdPath = join(dir, `day-${d.date}.md`);
writeFileSync(mdPath, text);
if (SAVE_JSON) writeFileSync(join(dir, `day-${d.date}.json`), JSON.stringify(d, null, 2));
console.log(text);
console.log(`\nSaved ${mdPath}${SAVE_JSON ? ' (+ .json)' : ''}`);
