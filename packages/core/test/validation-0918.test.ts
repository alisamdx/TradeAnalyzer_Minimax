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
import { runInsiderSweep, insiderIndexDates, runEtradeEarnings, factsQueue } from '../src/collector/phases/events.js';
import { QC910_INSIDER_INDEX_COVERAGE } from '../src/qa/checks/macro.js';
import { QC603_EARNINGS_FRESHNESS, QC701_FILING_FRESHNESS } from '../src/qa/checks/earnings-fundamentals.js';
import { etradeEarningDate } from '../src/ingest/events.js';

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

describe('E*Trade as the second earnings source (v1.1.270)', () => {
  const quote = (date: string) =>
    JSON.stringify({ QuoteResponse: { QuoteData: [{ Product: { symbol: 'X' }, All: { nextEarningDate: date } }] } });

  function capture(provider: 'polygon' | 'finnhub', endpoint: string, params: Record<string, string>, body: string, recipe: ReturnType<typeof recipes.snapshot>) {
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider, endpoint,
      slug: endpoint.replace(/\W+/g, '-'), params, response: response(body),
      captureRuleId: captureRuleId(db(), makeHost(), provider, { v: 1 }, 'test'), recipe
    });
    expect(r.parseStatus, JSON.stringify(r)).toBe('ok');
  }

  /** A subset member with a reference row of the given type. */
  function member(ticker: string, type: string) {
    capture('polygon', `/v3/reference/tickers/${ticker}`, { ticker }, JSON.stringify({
      results: { ticker, name: ticker, type, weighted_shares_outstanding: 1_000_000 }
    }), recipes.tickerReference());
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    const rule = captureRuleId(db(), makeHost(), 'chain_subset', { v: 1 }, 'test');
    raw.prepare(
      `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
       VALUES (?, ?, ?, ?, ?, ?, '2026-09-01', 'rule_pass', ?, '{}')`
    ).run(run.runId, DATE, `${DATE}T17:00:00-04:00`, rule, src, ticker, rule);
  }

  /** This run's Finnhub sweep dating `ticker`. */
  function finnhub(ticker: string, date: string) {
    capture('finnhub', '/calendar/earnings', { from: DATE, to: '2026-12-16', t: ticker }, JSON.stringify({
      earningsCalendar: [{ symbol: ticker, date, hour: 'amc', year: 2026, quarter: 3 }]
    }), recipes.earnings({ sweepFrom: DATE, sweepTo: '2026-12-16' }));
  }

  it('parses E*Trade\'s MM/DD/YYYY, reads an empty date as none, and refuses a format it does not know', () => {
    expect(etradeEarningDate('11/05/2026')).toBe('2026-11-05');
    expect(etradeEarningDate('1/5/2027')).toBe('2027-01-05');
    expect(etradeEarningDate('2026-11-05')).toBe('2026-11-05');
    expect(etradeEarningDate('')).toBeNull();
    expect(etradeEarningDate(undefined)).toBeNull();
    expect(() => etradeEarningDate('Nov 5, 2026')).toThrow(/unrecognised/);
  });

  it('asks for the stocks Finnhub did not date plus an overlap sample, skips funds, and clears QC-603', async () => {
    member('SWKS', 'CS'); // a Finnhub gap on 2026-09-18
    member('NVDA', 'CS'); // Finnhub-dated: the overlap sample
    member('SPY', 'ETF'); // a fund: no earnings, never asked
    finnhub('NVDA', '2026-11-18');
    expect(QC603_EARNINGS_FRESHNESS.run(ctx()).find((e) => e.key === 'SWKS')?.fired).toBe(true);

    const asked: string[] = [];
    const host = makeHost({
      etradeGet: async (path: string, params: Record<string, string>) => {
        asked.push(path);
        expect(params).toEqual({ detailFlag: 'ALL', requireEarningsDate: 'true' });
        return response(quote(path.endsWith('SWKS') ? '11/05/2026' : '11/18/2026'));
      }
    });
    const result = await runEtradeEarnings(host, db(), run);

    expect(asked).toEqual(['/v1/market/quote/SWKS', '/v1/market/quote/NVDA']);
    expect(result).toEqual({ stored: 2, calls: 2, failed: 0 });
    const rows = raw
      .prepare("SELECT ticker, report_date FROM raw_earnings_event WHERE source = 'etrade' ORDER BY ticker")
      .all();
    // Keyed on the ticker asked, not the body's `Product.symbol` ('X').
    expect(rows).toEqual([
      { ticker: 'NVDA', report_date: '2026-11-18' },
      { ticker: 'SWKS', report_date: '2026-11-05' }
    ]);
    expect(QC603_EARNINGS_FRESHNESS.run(ctx()).find((e) => e.key === 'SWKS')?.fired).toBe(false);
  });

  it('stores nothing for a ticker with no announced date, and records a format change as a failure', async () => {
    member('HONA', 'CS');
    member('JAN', 'CS');
    const host = makeHost({
      etradeGet: async (path: string) => response(quote(path.endsWith('HONA') ? '' : 'Q4 2026'))
    });
    const result = await runEtradeEarnings(host, db(), run);
    expect(result).toEqual({ stored: 0, calls: 2, failed: 1 });
    const failures = raw
      .prepare("SELECT params_json FROM meta_response WHERE provider = 'etrade' AND parse_status = 'failed'")
      .all() as { params_json: string }[];
    expect(failures.map((f) => (JSON.parse(f.params_json) as { symbol: string }).symbol)).toEqual(['JAN']);
  });
});

describe('the EDGAR fact pull when SEC companyfacts lags a filing (v1.1.271)', () => {
  const rule = () => captureRuleId(db(), makeHost(), 'edgar', { v: 1 }, 'test');

  /** A submissions response listing one report filing for `cik`. */
  function filing(cik: string, ticker: string, accession: string, filed: string) {
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/submissions/CIK{cik}.json', slug: 'edgar-submissions', params: { cik, n: accession },
      response: response(JSON.stringify({ filings: { recent: {
        accessionNumber: [accession], form: ['10-Q'], filingDate: [filed], reportDate: ['2026-06-30'],
        primaryDocument: ['q.htm']
      } } })),
      captureRuleId: rule(), recipe: recipes.submissions({ cik, ticker })
    });
    expect(r.parseStatus).toBe('ok');
  }

  /** A companyfacts response for `cik` fetched on `fetchedOn`, holding one fact from `accession`. */
  function facts(cik: string, accession: string, filed: string, end: string, fetchedOn: string) {
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/api/xbrl/companyfacts/CIK{cik}.json', slug: 'edgar-companyfacts', params: { cik },
      response: { status: 200, requestedAt: `${fetchedOn}T22:00:00Z`, respondedAt: `${fetchedOn}T22:00:01Z`,
        body: JSON.stringify({ facts: { 'us-gaap': { Revenues: { units: { USD: [
          { end, val: 1, accn: accession, fy: 2026, fp: 'Q1', form: '10-Q', filed }
        ] } } } } }) },
      captureRuleId: rule(), recipe: recipes.companyFacts({ cik })
    });
    expect(r.parseStatus).toBe('ok');
  }

  it('asks a new filing first, retries a lagging filer weekly, and never re-asks one checked this week', () => {
    // IQV shape: companyfacts fetched AFTER the July 10-Q and still missing it.
    filing('0001478242', 'IQV', 'A-IQV-JUL', '2026-07-28');
    facts('0001478242', 'A-IQV-MAY', '2026-05-05', '2026-03-31', '2026-09-09');
    // JBS shape: fetched two days ago, still missing — not due again yet.
    filing('0001791942', 'JBS', 'A-JBS-AUG', '2026-08-10');
    facts('0001791942', 'A-JBS-MAR', '2026-03-25', '2025-12-31', '2026-09-16');
    // A filer never fetched at all.
    filing('0000000001', 'NEW', 'A-NEW', '2026-08-01');

    expect(factsQueue(db(), DATE)).toEqual([{ cik: '0000000001' }, { cik: '0001478242' }]);
  });

  it('QC-701 names SEC\'s aggregate as the cause when companyfacts was fetched after the filing', () => {
    captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
      endpoint: '/v3/reference/tickers/IQV', slug: 'ref', params: { ticker: 'IQV' },
      response: response(JSON.stringify({ results: { ticker: 'IQV', name: 'IQVIA', type: 'CS', cik: '0001478242' } })),
      captureRuleId: rule(), recipe: recipes.tickerReference()
    });
    raw.prepare(
      `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
       VALUES (?, ?, ?, ?, (SELECT MAX(source_response_id) FROM meta_response), 'IQV', '2026-09-01', 'rule_pass', ?, '{}')`
    ).run(run.runId, DATE, `${DATE}T17:00:00-04:00`, rule(), rule());
    filing('0001478242', 'IQV', 'A-IQV-JUL', '2026-07-28');
    facts('0001478242', 'A-IQV-MAY', '2026-05-05', '2026-04-30', '2026-09-16');

    const [e] = QC701_FILING_FRESHNESS.run(ctx());
    expect(e?.fired).toBe(true);
    expect(e?.evidence?.['cause']).toBe('sec_companyfacts_missing');
    expect(e?.detail).toContain('SEC companyfacts fetched 2026-09-16 still has no facts for the 10-Q filed 2026-07-28');
  });
});
