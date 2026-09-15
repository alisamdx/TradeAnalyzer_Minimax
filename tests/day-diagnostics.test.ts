import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary, type SqliteLike } from '@tradeanalyzer/core';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BatchService } from '../src/main/services/batch-service.js';
import {
  buildAttention,
  etDate,
  readBatchRunsForDate,
  readCollectorDay,
  summarizeApiLog,
  summarizeErrorLog,
  type CollectorDay,
} from '../src/main/services/day-diagnostics.js';

/**
 * Day diagnostics (v1.1.245) — "what happened on date X", from one call.
 *
 * Fixtures are the real line shapes from 2026-09-14's logs: E*Trade's XML error
 * envelope, Polygon's 404, and a network fault with no status at all.
 */

describe('etDate', () => {
  it('buckets a UTC instant into its New York calendar day across the UTC midnight', () => {
    expect(etDate('2026-09-14T21:29:25.887Z')).toBe('2026-09-14'); // 17:29 ET
    expect(etDate('2026-09-15T03:59:00.000Z')).toBe('2026-09-14'); // 23:59 ET
    expect(etDate('2026-09-15T04:00:00.000Z')).toBe('2026-09-15'); // 00:00 ET
    expect(etDate('2026-09-14T18:56:49-04:00')).toBe('2026-09-14');
    expect(etDate('not a date')).toBe('');
  });
});

describe('summarizeApiLog', () => {
  const lines = [
    JSON.stringify({ timestamp: '2026-09-14T21:10:00.000Z', provider: 'etrade', endpoint: '/v1/market/optionchains', requestParams: { symbol: 'NVST' }, responseStatus: 400, responseBodyPreview: '<Error>\n  <code>10033</code>\n  <message>There are no options for the given month.</message>\n</Error>' }),
    JSON.stringify({ timestamp: '2026-09-14T21:11:00.000Z', provider: 'etrade', endpoint: '/v1/market/optionchains', requestParams: { symbol: 'NWS' }, responseStatus: 400, responseBodyPreview: '<Error>\n  <code>10033</code>\n  <message>There are no options for the given month.</message>\n</Error>' }),
    JSON.stringify({ timestamp: '2026-09-14T14:37:00.000Z', provider: 'polygon', endpoint: '/v2/snapshot/locale/us/markets/stocks/tickers/EA', requestParams: {}, responseStatus: 404, errorMessage: 'HTTP 404' }),
    JSON.stringify({ timestamp: '2026-09-14T05:05:39.053Z', provider: 'etrade', endpoint: '/v1/market/quote/SPY', requestParams: {}, responseStatus: null, errorMessage: 'fetch failed' }),
    JSON.stringify({ timestamp: '2026-09-14T14:00:00.000Z', provider: 'polygon', endpoint: '/v2/aggs/ticker/AAPL', requestParams: {}, responseStatus: 200 }),
    '{not json',
    '',
  ];

  it('counts calls per provider, splitting 2xx, HTTP errors and no-response faults', async () => {
    const s = await summarizeApiLog(lines, 'api.jsonl');
    expect(s.lines).toBe(6);
    expect(s.unparseable).toBe(1);
    expect(s.byProvider['etrade']).toEqual({ calls: 3, ok: 0, httpError: 2, network: 1 });
    expect(s.byProvider['polygon']).toEqual({ calls: 2, ok: 1, httpError: 1, network: 0 });
    expect(s.byHourEt['polygon']).toEqual({ '10': 2 });
  });

  it("groups failures by the provider's own message, collecting the symbols", async () => {
    const s = await summarizeApiLog(lines, 'api.jsonl');
    const chains = s.failures.find((f) => f.endpoint === '/v1/market/optionchains');
    expect(chains).toMatchObject({ status: 400, count: 2, message: 'There are no options for the given month.' });
    expect(chains?.symbols).toEqual(['NVST', 'NWS']);
    expect(s.failures.find((f) => f.status === null)?.message).toBe('fetch failed');
    expect(s.failureGroups).toBe(3);
  });
});

describe('summarizeErrorLog', () => {
  it('keeps every entry with its level and operation', async () => {
    const s = await summarizeErrorLog([
      JSON.stringify({ timestamp: '2026-09-14T14:51:35.799Z', level: 'INFO', operation: 'brief-email:sent', message: '[brief] brief email sent' }),
      JSON.stringify({ timestamp: '2026-09-14T22:56:49.000Z', level: 'ERROR', operation: 'collector-email:failed', message: '[collector] email NOT sent: 552 message too large' }),
    ], 'errors.jsonl');
    expect(s.counts).toEqual({ INFO: 1, ERROR: 1 });
    expect(s.entries[1]?.operation).toBe('collector-email:failed');
  });
});

describe('readBatchRunsForDate', () => {
  it('returns the runs whose start falls on the ET date, including the evening after UTC midnight', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    // batch_runs.job_id references batch_jobs, so the jobs exist first.
    const batch = new BatchService(db, () => undefined, () => undefined);
    for (const id of ['daily-intelligence-brief', 'data-collector', 'collector-watchdog']) {
      batch.registerJob(id, { name: id, description: 'd', run: async () => ({ status: 'success', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 }) });
    }
    const insert = db.prepare(`INSERT INTO batch_runs (job_id, started_at, completed_at, status, trigger, slot_time, notes) VALUES (?,?,?,?,?,?,?)`);
    insert.run('daily-intelligence-brief', '2026-09-14T14:15:00.000Z', '2026-09-14T14:52:00.000Z', 'success', 'schedule', '10:15', 'morning');
    insert.run('data-collector', '2026-09-14T22:00:00.000Z', '2026-09-14T22:56:49.000Z', 'success', 'schedule', '17:00', 'RED — 3 blocking');
    insert.run('collector-watchdog', '2026-09-15T00:30:00.000Z', '2026-09-15T00:30:01.000Z', 'success', 'schedule', '19:30', 'completed'); // 20:30 ET, still the 14th
    insert.run('daily-intelligence-brief', '2026-09-15T14:15:00.000Z', null, 'running', 'schedule', '10:15', null); // the 15th

    const runs = readBatchRunsForDate(db, '2026-09-14');
    expect(runs.map((r) => r.jobId)).toEqual(['daily-intelligence-brief', 'data-collector', 'collector-watchdog']);
    expect(runs[1]).toMatchObject({ durationSec: 3409, notes: 'RED — 3 blocking' });
  });
});

describe('readCollectorDay — against a real generation schema', () => {
  let dir: string;
  let raw: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ta-daydiag-'));
    raw = new Database(join(dir, 'data.sqlite'));
    applyDictionary(raw as unknown as SqliteLike);
  });
  afterEach(() => {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the run, the gate report with its email status, and response outcomes', () => {
    const cols = (t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[]);
    // Fill every NOT NULL column generically, so the fixture follows the dictionary rather than a copy of it.
    const insertRow = (table: string, values: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...values };
      for (const c of cols(table)) {
        if (c.name in row || c.pk === 1 || c.notnull === 0 || c.dflt_value !== null) continue;
        row[c.name] = c.name.endsWith('_json') ? '{}' : c.name.endsWith('_at') ? '2026-09-14T17:05:00-04:00' : 0;
      }
      const names = Object.keys(row);
      raw.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => row[n]));
      return (raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    };

    const runId = insertRow('meta_run', {
      run_kind: 'daily', slot: 'after_close', trading_date: '2026-09-14', status: 'complete',
      host_app: 'TradeAnalyzer', host_version: '1.1.244', collector_version: '0.6.8', dictionary_version: 15,
    });
    insertRow('qa_quality_report', {
      run_id: runId, overall: 'red', domains_json: JSON.stringify({ bars: { expected: 1089, stored: 1083, status: 'usable' } }),
      checks_json: '{}', email_status: 'failed', email_error: '552 5.3.4 Message size exceeds fixed limit',
    });
    insertRow('meta_response', {
      run_id: runId, provider: 'polygon', endpoint: '/stocks/v1/short-interest', params_json: '{}', http_status: 200,
      archive_file: 'a', archive_offset: 0, dedup_hash: 'x1', encrypted: 0, at_provider_cap: 0, parse_status: 'ok', parsed_row_count: 67386,
    });
    insertRow('meta_response', {
      run_id: runId, provider: 'host_app', endpoint: 'legacy/brief-handoff', params_json: '{}', http_status: 200,
      archive_file: 'a', archive_offset: 1, dedup_hash: 'x2', encrypted: 0, at_provider_cap: 0, parse_status: 'failed', parsed_row_count: 0,
      parse_error: 'CHECK constraint failed: mode',
    });

    const day = readCollectorDay(raw, '2026-09-14');
    expect(day.errors).toEqual({});
    expect(day.runs).toHaveLength(1);
    expect(day.reports[0]).toMatchObject({ overall: 'red', emailStatus: 'failed', runKind: 'daily' });
    expect(day.reports[0]?.domains).toEqual({ bars: { expected: 1089, stored: 1083, status: 'usable' } });
    expect(day.responses).toContainEqual(expect.objectContaining({ provider: 'polygon', parse_status: 'ok', rows_parsed: 67386 }));
    expect(day.responseFailures).toContainEqual(expect.objectContaining({ endpoint: 'legacy/brief-handoff', parse_error: 'CHECK constraint failed: mode' }));

    // Another day reads empty, never another day's rows.
    expect(readCollectorDay(raw, '2026-09-15').reports).toEqual([]);
  });
});

describe('buildAttention', () => {
  const emptyLog = { file: 'f', present: true, counts: {}, entries: [], unparseable: 0 };
  const emptyApi = { file: 'f', present: true, lines: 0, unparseable: 0, byProvider: {}, byHourEt: {}, failureGroups: 0, failures: [] };
  const collector = (over: Partial<CollectorDay> = {}): CollectorDay => ({
    tradingDay: true, runs: [{ run_id: 1 }], reports: [], domainStatus: [], responses: [], responseFailures: [], exceptions: [], errors: {}, ...over,
  });
  const run = (jobId: string, status = 'success') => ({
    runId: 1, jobId, jobName: null, startedAt: '2026-09-14T22:00:00Z', completedAt: null, durationSec: null, status, trigger: 'schedule', slotTime: null, notes: null, errorMessage: 'boom',
  });

  it('names an unsent gate email and a non-green verdict — the 2026-09-14 case', () => {
    const a = buildAttention({
      date: '2026-09-14',
      batchRuns: [run('daily-intelligence-brief'), run('data-collector'), run('collector-watchdog')],
      errorsLog: emptyLog, apiLog: emptyApi,
      collector: collector({
        reports: [{ reportId: 7, runId: 1, runKind: 'daily', overall: 'red', generatedAt: '', emailStatus: 'failed', emailError: 'SMTP 552', emailSentAt: null, domains: {} }],
      }),
    });
    expect(a).toContain('Gate verdict RED (run 1, daily).');
    expect(a).toContain('Gate email for run 1 was NOT sent — status failed: SMTP 552.');
  });

  it('flags a failed job and an expected job with no run on a trading day', () => {
    const a = buildAttention({
      date: '2026-09-14',
      batchRuns: [run('daily-intelligence-brief', 'failed')],
      errorsLog: emptyLog, apiLog: emptyApi, collector: collector(),
    });
    expect(a.some((x) => x.startsWith('Batch job daily-intelligence-brief FAILED'))).toBe(true);
    expect(a).toContain('Expected job data-collector has no run on this trading day.');
    expect(a).toContain('Collector ran but wrote no daily gate report.');
  });

  it('does not expect the daily jobs on a non-trading day', () => {
    const a = buildAttention({
      date: '2026-09-13', batchRuns: [], errorsLog: emptyLog, apiLog: emptyApi,
      collector: collector({ tradingDay: false, runs: [] }),
    });
    expect(a).toEqual([]);
  });
});
