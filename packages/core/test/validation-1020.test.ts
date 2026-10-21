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
import { QC603_EARNINGS_FRESHNESS } from '../src/qa/checks/earnings-fundamentals.js';

/**
 * Faults found going through the 2026-10-20 gate's 16 blocking findings (v1.1.371). QC-705 and
 * QC-701 are covered in filing-facts.test.ts; this file holds QC-603.
 */

let dir: string;
let raw: Database.Database;
let run: RunHandle;
const DATE = '2026-10-20';

const db = (): SqliteLike => raw as unknown as SqliteLike;
const response = (body: string, on: string): ProviderResponse => ({
  status: 200, body, requestedAt: `${on}T22:00:00Z`, respondedAt: `${on}T22:00:01Z`
});

function makeHost(): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => response('{"results":[]}', DATE),
    etradeGet: async () => response('{}', DATE),
    httpGet: async () => response('{}', DATE),
    nowET: () => `${DATE}T18:00:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' }
  };
}

const rule = () => captureRuleId(db(), makeHost(), 'test', { v: 1 }, 'test');

function reference(ticker: string) {
  const r = captureResponse({
    host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
    endpoint: `/v3/reference/tickers/${ticker}`, slug: 'ref', params: { ticker },
    response: response(JSON.stringify({ results: { ticker, name: ticker, type: 'CS', list_date: '2007-05-04' } }), DATE),
    captureRuleId: rule(), recipe: recipes.tickerReference()
  });
  expect(r.parseStatus).toBe('ok');
  raw.prepare(
    `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
       ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
     VALUES (?, ?, ?, ?, (SELECT MAX(source_response_id) FROM meta_response), ?, '2026-09-01', 'rule_pass', ?, '{}')`
  ).run(run.runId, DATE, `${DATE}T17:00:00-04:00`, rule(), ticker, rule());
}

/** A Finnhub sweep observed `on` that lists `dates` for `ticker`. */
function finnhub(ticker: string, on: string, dates: string[]) {
  const r = captureResponse({
    host: makeHost(), db: db(), runId: run.runId, asOfDate: on, provider: 'finnhub',
    endpoint: '/calendar/earnings', slug: `fh-${ticker}-${on}`, params: { from: on, t: ticker },
    response: response(JSON.stringify({
      earningsCalendar: dates.map((date, i) => ({ symbol: ticker, date, hour: 'amc', year: 2026, quarter: 3 + i }))
    }), on),
    captureRuleId: rule(), recipe: recipes.earnings({ sweepFrom: on, sweepTo: on })
  });
  expect(r.parseStatus).toBe('ok');
}

const ctx = () => ({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
const judge = (ticker: string) => QC603_EARNINGS_FRESHNESS.run(ctx()).find((e) => e.key === ticker);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-1020-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (2, '2026-09-11T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
  run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('QC-603 — a superseded estimate is not a future date observed', () => {
  it('IBKR: dated 10-20 until 09-24, then 10-15 and reported — the just-reported grace applies', () => {
    // Finnhub's rows for IBKR in gen-002: report_date 2026-10-20 observed 09-21..09-24, then 2026-10-15
    // from 10-14 on; IBKR reported 10-15 after the close. On 10-20 the gate read "last observed 09-24".
    reference('IBKR');
    finnhub('IBKR', '2026-09-24', ['2026-10-20']);
    finnhub('IBKR', '2026-10-14', ['2026-10-15']);
    const e = judge('IBKR');
    expect(e).toMatchObject({ fired: false, value: 0 });
    expect(e?.evidence).toMatchObject({ lastObserved: null, lastReported: '2026-10-15', justReported: true });
  });

  it('still fires on an estimate nothing has replaced, however old', () => {
    reference('QUIET');
    finnhub('QUIET', '2026-09-24', ['2026-10-20']);
    expect(judge('QUIET')).toMatchObject({ fired: true, value: 26 });
  });

  it('keeps every date one response lists — two dates seen together supersede neither', () => {
    // FDXF: Finnhub lists 10-28 and 10-29 in the same response.
    reference('FDXF');
    finnhub('FDXF', '2026-10-19', ['2026-10-28', '2026-10-29']);
    expect(judge('FDXF')).toMatchObject({ fired: false, value: 1 });
  });

  it('a later reading of the SAME date does not supersede it', () => {
    reference('SAME');
    finnhub('SAME', '2026-10-01', ['2026-11-05']);
    finnhub('SAME', '2026-10-19', ['2026-11-05']);
    expect(judge('SAME')).toMatchObject({ fired: false, value: 1 });
  });
});
