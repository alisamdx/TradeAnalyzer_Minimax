import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { beginRun, captureRuleId, type RunHandle } from '../src/collector/run.js';
import { captureResponse } from '../src/collector/capture.js';
import { recipes } from '../src/ingest/recipes.js';
import { ensureTradingCalendar } from '../src/collector/trading-calendar.js';
import { runInsiderSweep, insiderIndexDates } from '../src/collector/phases/events.js';
import { QC910_INSIDER_INDEX_COVERAGE } from '../src/qa/checks/macro.js';

/**
 * Faults found validating the 2026-09-18 collector run (v1.1.268):
 *  - the EDGAR daily form index answered HTTP 503, which the 404/403-only fallback did not
 *    recognise, so the run stored no insider rows, 09-17's filings could never be asked for
 *    again, and no check fired;
 *  - E*Trade's option-expirations endpoint answers 204 with an empty body for a symbol with no
 *    listed options, and that was recorded as a parse failure ("Unexpected end of JSON input").
 */

let dir: string;
let raw: Database.Database;
let run: RunHandle;
const DATE = '2026-09-18';
const HEADER = 'Form Type   Company Name   CIK   Date Filed   File Name\n';

const db = (): SqliteLike => raw as unknown as SqliteLike;
const response = (body: string, status: number | null = 200): ProviderResponse => ({
  status, body, requestedAt: `${DATE}T22:00:00Z`, respondedAt: status === null ? null : `${DATE}T22:00:01Z`
});

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => response('{"results":[]}'),
    etradeGet: async () => response('{}'),
    httpGet: async () => response('{}'),
    nowET: () => `${DATE}T18:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

/** A form index for `date` that parsed, written by an earlier run. */
function parsedIndex(date: string) {
  const r = captureResponse({
    host: makeHost(), db: db(), runId: run.runId, asOfDate: date, provider: 'edgar',
    endpoint: '/Archives/edgar/daily-index/form.idx', slug: 'edgar-form-index',
    params: { date }, response: response(HEADER),
    captureRuleId: captureRuleId(db(), makeHost(), 'insider', { v: 1 }, 'test')
  });
  expect(r.parseStatus).toBe('ok');
}

/** A host whose EDGAR index answers `status` for the dates listed and 200 for every other. */
function edgar(statusByDate: Record<string, number>, asked: string[]) {
  return makeHost({
    httpGet: async (url: string) => {
      const date = /form\.(\d{4})(\d{2})(\d{2})\.idx$/.exec(url);
      const iso = date ? `${date[1]}-${date[2]}-${date[3]}` : '';
      asked.push(iso);
      const status = statusByDate[iso];
      return status === undefined ? response(HEADER) : response('<html>Service Unavailable</html>', status);
    }
  });
}

const indexRows = () =>
  raw
    .prepare(
      `SELECT json_extract(params_json, '$.date') AS date, http_status AS status, parse_status AS parse
         FROM meta_response WHERE endpoint LIKE '%form.idx%' AND run_id = ? ORDER BY source_response_id`
    )
    .all(run.runId);

const ctx = () => ({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-0918-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (2, '2026-09-11T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
  ensureTradingCalendar(db(), makeHost(), DATE);
  run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the insider sweep catches up from the last parsed index', () => {
  it('recovers the session a 503 skipped, and does not record today\'s unpublished index', async () => {
    // The real 2026-09-18 shape: 09-17's run swept 09-16, today's index answered 503.
    parsedIndex('2026-09-16');
    const asked: string[] = [];
    const result = await runInsiderSweep(edgar({ '2026-09-18': 503 }, asked), db(), run);
    expect(asked).toEqual(['2026-09-17', '2026-09-18']);
    expect(result.failed).toBe(0);
    // 09-16 was captured by the helper above; this run adds only 09-17.
    expect(indexRows()).toEqual([
      { date: '2026-09-16', status: 200, parse: 'ok' },
      { date: '2026-09-17', status: 200, parse: 'ok' }
    ]);
  });

  it('stops at a past session that cannot be read, so it is asked for again next run', async () => {
    parsedIndex('2026-09-15');
    const asked: string[] = [];
    const result = await runInsiderSweep(edgar({ '2026-09-16': 503 }, asked), db(), run);
    expect(asked).toEqual(['2026-09-16']);
    expect(result.failed).toBe(1);
    expect(insiderIndexDates(db(), DATE)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
  });

  it('steps over a past session with no index at all, which is a federal holiday the NYSE trades through', async () => {
    parsedIndex('2026-09-15');
    const asked: string[] = [];
    const result = await runInsiderSweep(edgar({ '2026-09-16': 404, '2026-09-18': 403 }, asked), db(), run);
    expect(asked).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);
    expect(result.failed).toBe(0);
    expect(indexRows().map((r) => (r as { date: string }).date)).toEqual(['2026-09-15', '2026-09-17']);
  });

  it('asks for nothing it already has on a re-run of the same evening', () => {
    parsedIndex(DATE);
    expect(insiderIndexDates(db(), DATE)).toEqual([]);
  });

  it('catches up at most five past sessions', () => {
    parsedIndex('2026-08-28');
    const dates = insiderIndexDates(db(), DATE);
    expect(dates).toHaveLength(6);
    expect(dates[dates.length - 1]).toBe(DATE);
    expect(dates[0]).toBe('2026-09-11');
  });
});

describe('QC-910 — insider index coverage', () => {
  it('is quiet on the normal evening, when the last parsed index is yesterday\'s', () => {
    parsedIndex('2026-09-17');
    const [e] = QC910_INSIDER_INDEX_COVERAGE.run(ctx());
    expect(e?.fired).toBe(false);
    expect(e?.value).toBe(0);
  });

  it('tolerates one session behind, which the next run recovers', () => {
    parsedIndex('2026-09-16');
    expect(QC910_INSIDER_INDEX_COVERAGE.run(ctx())[0]?.fired).toBe(false);
  });

  it('fires when the catch-up is failing, and names the status that stopped it', async () => {
    parsedIndex('2026-09-15');
    await runInsiderSweep(edgar({ '2026-09-16': 503 }, []), db(), run);
    const [e] = QC910_INSIDER_INDEX_COVERAGE.run(ctx());
    expect(e?.fired).toBe(true);
    expect(e?.value).toBe(2);
    expect(e?.detail).toContain('2026-09-16 (HTTP 503)');
  });

  it('fires when a sweep was attempted and no index has ever parsed', async () => {
    await runInsiderSweep(edgar({ '2026-09-17': 503 }, []), db(), run);
    expect(QC910_INSIDER_INDEX_COVERAGE.run(ctx())[0]?.fired).toBe(true);
  });

  it('evaluates nothing where no sweep has ever run', () => {
    expect(QC910_INSIDER_INDEX_COVERAGE.run(ctx())).toEqual([]);
  });
});

describe('an HTTP 204 is an empty answer, not a parse failure', () => {
  it('stores zero expirations for a symbol E*Trade lists no options on', () => {
    // Measured 2026-09-18 in logs/api: optionexpiredate for NVR, YUM and DDS answered 204 with a
    // 0-byte body, ~25 a day since 2026-09-10.
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'etrade',
      endpoint: '/v1/market/optionexpiredate', slug: 'optionexpiredate',
      params: { symbol: 'NVR', expiryType: 'ALL' }, response: response('', 204),
      captureRuleId: captureRuleId(db(), makeHost(), 'chains', { v: 1 }, 'test'),
      recipe: recipes.expirations({ ticker: 'NVR', selection: new Map() })
    });
    expect(r.parseStatus).toBe('ok');
    expect(r.rowsWritten).toBe(0);
    const row = raw.prepare('SELECT http_status, parse_status, parsed_row_count FROM meta_response').get();
    expect(row).toEqual({ http_status: 204, parse_status: 'ok', parsed_row_count: 0 });
  });
});
