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
import { runInsiderSweep, insiderIndexDates, runEtradeEarnings, factsQueue, factsBatch, runEdgarFilings, runSecTickerMap } from '../src/collector/phases/events.js';
import { lastFactsFetchEt } from '../src/collector/facts-queue.js';
import { QC910_INSIDER_INDEX_COVERAGE } from '../src/qa/checks/macro.js';
import { QC603_EARNINGS_FRESHNESS, QC701_FILING_FRESHNESS, QC702_FACT_SANITY, QC703_CIK_SOURCE_DISAGREEMENT, QC704_FILING_WITHOUT_FACTS } from '../src/qa/checks/earnings-fundamentals.js';
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

  it('QC-701 names the unread filing instance — not SEC\'s aggregate — as the cause (v1.1.365)', () => {
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
    // IQV on 2026-09-18: companyfacts read 50 days after the 10-Q and still without it. Under the
    // filing-first design that is no longer a cause — the filing's own instance is, and it is due.
    expect(e?.evidence?.['cause']).toBe('awaiting_instance_read');
    expect(e?.detail).toContain('the 10-Q filed 2026-07-28 (A-IQV-JUL) is queued for its own XBRL instance; due on the next run');
    expect(e?.detail).not.toContain('SEC companyfacts');
  });

  // v1.1.332: effectiveCikSql named its inner tables `s` and `r`, and QC-701 passes `r.ticker` from its
  // own `raw_ticker_reference r` — so `r.ticker = r.ticker` bound both sides to the inner table and every
  // stock got the newest reference row's CIK. QC-701 evaluated 0 of 69 on rehearsal. The test above
  // holds ONE ticker, for which "the newest row" is the right one, so it could not see it.
  it('QC-701 reads each stock\'s OWN CIK when several are listed', () => {
    const listIn = (ticker: string, cik: string) => {
      captureResponse({
        host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
        endpoint: `/v3/reference/tickers/${ticker}`, slug: 'ref', params: { ticker },
        response: response(JSON.stringify({ results: { ticker, name: ticker, type: 'CS', cik } })),
        captureRuleId: rule(), recipe: recipes.tickerReference()
      });
      raw.prepare(
        `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
         VALUES (?, ?, ?, ?, (SELECT MAX(source_response_id) FROM meta_response), ?, '2026-09-01', 'rule_pass', ?, '{}')`
      ).run(run.runId, DATE, `${DATE}T17:00:00-04:00`, rule(), ticker, rule());
    };
    listIn('IQV', '0001478242');
    listIn('KO', '0000021344');
    facts('0001478242', 'A-IQV-MAY', '2026-05-05', '2026-04-30', '2026-09-16');
    facts('0000021344', 'A-KO-JUL', '2026-07-29', '2026-07-03', '2026-09-16');
    const byKey = new Map(QC701_FILING_FRESHNESS.run(ctx()).map((e) => [e.key, e]));
    expect([...byKey.keys()].sort()).toEqual(['IQV', 'KO']);
    expect(byKey.get('IQV')!.evidence?.['newestPeriodEnd']).toBe('2026-04-30');
    expect(byKey.get('KO')!.evidence?.['newestPeriodEnd']).toBe('2026-07-03');
  });

  // v1.1.332 built QC-704 for filings SEC's companyfacts dropped (most 10-Qs filed 2026-07-28/29).
  // v1.1.365 made the filing's own instance the primary source, so QC-704 now asks the question
  // that matters: does the filing have facts from ANY source a few days after it was filed?
  describe('QC-704 — a report filing without facts from any source', () => {
    const byKey = () => new Map(QC704_FILING_WITHOUT_FACTS.run(ctx()).map((e) => [e.key, e]));

    it('fires on a filing still without facts, naming why, and closes one that has them', () => {
      filing('0001478242', 'IQV', 'A-IQV-JUL', '2026-07-28');
      filing('0001478242', 'IQV', 'A-IQV-MAY', '2026-05-05');
      facts('0001478242', 'A-IQV-MAY', '2026-05-05', '2026-04-30', '2026-09-16');
      const e = byKey();
      expect(e.get('A-IQV-JUL')).toMatchObject({ fired: true, value: 52, evidence: { cause: 'awaiting_instance_read' } });
      expect(e.get('A-IQV-MAY')).toMatchObject({ fired: false, closesAs: { kind: 'data_corrected', note: expect.stringContaining('SEC companyfacts') } });
      expect(QC704_FILING_WITHOUT_FACTS.escalatesOnRepeat).toBe(false);
    });

    it('judges a filing after three days whether or not companyfacts was ever read', () => {
      filing('0001791942', 'JBS', 'A-JBS-SEP', '2026-09-17');                         // filed yesterday
      expect(byKey().has('A-JBS-SEP')).toBe(false);
      filing('0000000009', 'NEW', 'A-NEW', '2026-08-01');                            // never read at all
      expect(byKey().get('A-NEW')?.fired).toBe(true);
    });
  });

  // v1.1.322. IQV and JCI were fetched once, 2026-09-15, and sat 34th and 35th in the queue a week
  // later — every never-fetched filer sorted ahead of every retry, and a run fetched ten.
  it('reserves slots for due retries, and lends unused slots either way', () => {
    for (let i = 0; i < 25; i++) filing(String(i + 1).padStart(10, '0'), `N${i}`, `A-N${i}`, '2026-08-01');
    filing('0001478242', 'IQV', 'A-IQV-JUL', '2026-07-28');
    facts('0001478242', 'A-IQV-MAY', '2026-05-05', '2026-03-31', '2026-09-09');
    filing('0000833444', 'JCI', 'A-JCI-JUL', '2026-07-29');
    facts('0000833444', 'A-JCI-MAY', '2026-05-06', '2026-03-31', '2026-09-10');

    const batch = factsBatch(db(), DATE, 20, 3);
    expect(batch).toHaveLength(20);
    expect(batch.filter((e) => e.kind === 'retry').map((e) => e.cik)).toEqual(['0001478242', '0000833444']);
    expect(batch.filter((e) => e.kind === 'fresh')).toHaveLength(18);
    // The whole queue is still in priority order: every new filer, then the retries.
    expect(factsQueue(db(), DATE).slice(-2)).toEqual([{ cik: '0001478242' }, { cik: '0000833444' }]);
    // More retries than the reserve: they take whatever new filers leave.
    expect(factsBatch(db(), DATE, 30, 3)).toHaveLength(27);
  });

  it('counts the retry age in ET days, so an evening fetch is not a day younger than it is', () => {
    // The real IQV fetch: 2026-09-15 21:46 ET, stored as 2026-09-16T01:46:48Z.
    filing('0001478242', 'IQV', 'A-IQV-JUL', '2026-07-28');
    const r = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/api/xbrl/companyfacts/CIK{cik}.json', slug: 'edgar-companyfacts', params: { cik: '0001478242' },
      response: { status: 200, requestedAt: '2026-09-16T01:46:48.483Z', respondedAt: '2026-09-16T01:46:49.000Z',
        body: JSON.stringify({ facts: { 'us-gaap': { Revenues: { units: { USD: [
          { end: '2026-03-31', val: 1, accn: 'A-IQV-MAY', fy: 2026, fp: 'Q1', form: '10-Q', filed: '2026-05-05' }
        ] } } } } }) },
      captureRuleId: rule(), recipe: recipes.companyFacts({ cik: '0001478242' })
    });
    expect(r.parseStatus).toBe('ok');
    expect(lastFactsFetchEt(db()).get('0001478242')).toBe('2026-09-15');
    expect(factsQueue(db(), '2026-09-21')).toEqual([]);                           // six days: not due
    expect(factsQueue(db(), '2026-09-22')).toEqual([{ cik: '0001478242' }]);      // seven: due (the UTC date made it eight)
  });
});

describe('QC-702 compares share counts observed on different dates (v1.1.309)', () => {
  const rule2 = () => captureRuleId(db(), makeHost(), 'test', { v: 1 }, 'test');

  /** A reference row carrying a share count, through the real ingest. */
  function referenceShares(ticker: string, cik: string, shares: number) {
    captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
      endpoint: `/v3/reference/tickers/${ticker}`, slug: 'ref', params: { ticker },
      response: response(JSON.stringify({
        results: { ticker, name: ticker, type: 'CS', cik, weighted_shares_outstanding: shares }
      })),
      captureRuleId: rule2(), recipe: recipes.tickerReference()
    });
  }

  /** The dei cover-page share count, as filed on `periodEnd`. */
  function coverShares(cik: string, periodEnd: string, shares: number) {
    captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: `/api/xbrl/companyfacts/CIK${cik}.json`, slug: 'facts', params: { cik },
      response: response(JSON.stringify({ cik, facts: { dei: { EntityCommonStockSharesOutstanding: {
        units: { shares: [{ end: periodEnd, val: shares, fy: 2026, fp: 'Q3', form: '10-Q', accn: `${cik}-26-000130`, filed: periodEnd }] }
      } } } })),
      captureRuleId: rule2(), recipe: recipes.companyFacts({ cik })
    });
  }

  function split(ticker: string, executionDate: string, from: number, to: number) {
    captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
      endpoint: '/v3/reference/splits', slug: 'splits', params: {},
      response: response(JSON.stringify({ results: [
        { id: `${ticker}-${executionDate}`, ticker, execution_date: executionDate, split_from: from, split_to: to }
      ] })),
      captureRuleId: rule2(), recipe: recipes.splits()
    });
  }

  const evaluate = () =>
    QC702_FACT_SANITY.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: `${DATE}T17:05:00-04:00` });

  it('carries the EDGAR figure across a split between the two observations', () => {
    // IESC, measured 2026-09-22: EDGAR 19,924,356 stated 2026-07-27, Polygon
    // 39,848,712 observed 2026-09-11, and a 1:2 split on 2026-08-24 sits
    // between them. Both numbers are exactly right; the check was measuring the
    // corporate action. It read 50.0%.
    referenceShares('IESC', '0001048268', 39_848_712);
    coverShares('0001048268', '2026-07-27', 19_924_356);
    split('IESC', '2026-08-24', 1, 2);

    const [e] = evaluate();
    expect(e?.fired).toBe(false);
    expect(e?.value).toBe(0);
    // Named, not applied silently — a carried figure must be checkable back
    // against the filing.
    expect(e?.detail).toContain('×2');
    expect(e?.evidence?.['edgarSharesAsFiled']).toBe(19_924_356);
    expect(e?.evidence?.['edgarShares']).toBe(39_848_712);
  });

  it('takes only the splits between the filing date and the reference observation', () => {
    // One on or before the filing's date is already in the EDGAR figure, and
    // one after the reference observation is in neither. Applying either would
    // manufacture the disagreement it exists to remove.
    referenceShares('AAA', '0000000001', 1_000_000);
    coverShares('0000000001', '2026-07-27', 1_000_000);
    split('AAA', '2026-07-01', 1, 2);          // before the filing
    split('AAA', `${DATE}`, 1, 2);             // on the reference observation...
    const [e] = evaluate();
    // The second split lands ON as_of_date, which IS inside the window: the
    // reference was observed that day and so already reflects it.
    expect(e?.evidence?.['splitsBetween']).toEqual([DATE]);
  });

  it('still fires when a split cannot explain the gap', () => {
    // The failure direction that matters: an incomplete raw_split under-adjusts
    // and therefore fires, so a missing corporate action is loud rather than
    // silently corrected.
    referenceShares('BBB', '0000000002', 90_000_000);
    coverShares('0000000002', '2026-07-27', 10_000_000);
    const [e] = evaluate();
    expect(e?.fired).toBe(true);
    expect(e?.detail).not.toContain('×');
  });
});

describe('the EDGAR filings sweep asks for what EDGAR\'s `recent` block always holds (v1.1.275)', () => {
  const rule = () => captureRuleId(db(), makeHost(), 'test', { v: 1 }, 'test');

  /** A universe member with a reference row. */
  function listed(ticker: string, type: string, cik: string) {
    captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'polygon',
      endpoint: `/v3/reference/tickers/${ticker}`, slug: 'ref', params: { ticker },
      response: response(JSON.stringify({ results: { ticker, name: ticker, type, cik } })),
      captureRuleId: rule(), recipe: recipes.tickerReference()
    });
    raw.prepare(
      `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, list_source, valid_from, change_reason)
       VALUES (?, ?, ?, ?, (SELECT MAX(source_response_id) FROM meta_response), ?, 'sp500', '2026-09-01', 'initial')`
    ).run(run.runId, DATE, `${DATE}T17:00:00-04:00`, rule(), ticker);
  }

  /** A submissions body whose `recent` holds `n` filings spread evenly from `oldest` to DATE. */
  function submissions(n: number, oldest: string): string {
    const from = Date.parse(`${oldest}T00:00:00Z`);
    const span = Date.parse(`${DATE}T00:00:00Z`) - from;
    const dates = Array.from({ length: n }, (_, i) =>
      new Date(from + Math.round((span * (n - 1 - i)) / Math.max(n - 1, 1))).toISOString().slice(0, 10));
    return JSON.stringify({ filings: { recent: {
      accessionNumber: dates.map((_, i) => `A-${i}`), form: dates.map(() => '424B2'), filingDate: dates,
      reportDate: dates.map(() => ''), primaryDocument: dates.map(() => 'x.htm')
    }, files: [] } });
  }

  const capped = () =>
    raw.prepare("SELECT json_extract(params_json, '$.ticker') AS t, at_provider_cap AS cap FROM meta_response WHERE endpoint = '/submissions/CIK{cik}.json' ORDER BY t").all();

  it('skips funds and asks each CIK once', async () => {
    listed('IVV', 'ETF', '0001100663');
    listed('IWM', 'ETF', '0001100663');
    listed('GOOG', 'CS', '0001652044');
    listed('GOOGL', 'CS', '0001652044');
    listed('JPM', 'CS', '0000019617');
    const asked: string[] = [];
    const host = makeHost({ httpGet: async (url: string) => { asked.push(url.slice(url.lastIndexOf("/") + 1)); return response(submissions(3, '2026-06-01')); } });
    await runEdgarFilings(host, db(), run);
    expect(asked.sort()).toEqual(['CIK0000019617.json', 'CIK0001652044.json']);
  });

  it('reads a large filer\'s one-year `recent` block as complete, and still flags a truly truncated one', async () => {
    // JPM on 2026-09-15: 26,192 filings in `recent`, oldest exactly one year back.
    listed('JPM', 'CS', '0000019617');
    listed('JEF', 'CS', '0000096223');
    const host = makeHost({
      httpGet: async (url: string) =>
        response(url.includes('0000019617') ? submissions(1500, '2025-09-18') : submissions(1000, '2026-08-20'))
    });
    await runEdgarFilings(host, db(), run);
    // JEF's shape here is 1,000 filings in four weeks: that one IS cut short of the window.
    expect(capped()).toEqual([{ t: 'JEF', cap: 1 }, { t: 'JPM', cap: 0 }]);
  });

  it('a second run on one trading date re-asks the same filers and must not lose the response (v1.1.308)', async () => {
    // `raw_edgar_filing` is append-only yet UNIQUE on `accession_no` alone, and
    // the transaction is the WHOLE response — so one already-stored filing
    // discarded every filing beside it and reported
    // `UNIQUE constraint failed: raw_edgar_filing.accession_no`, which reads as
    // "the parser broke". The filers' slice is keyed on the trading date, so any
    // day with two collector runs asks the identical twenty: HSY was stored at
    // 17:05 on 2026-09-22 and re-asked at 20:47.
    listed('HSY', 'CS', '0000047111');
    const body = (accessions: readonly string[], dates: readonly string[]) =>
      JSON.stringify({ filings: { recent: {
        accessionNumber: accessions, form: accessions.map(() => '10-Q'), filingDate: dates,
        reportDate: dates.map(() => ''), primaryDocument: dates.map(() => 'x.htm')
      }, files: [] } });

    const first = makeHost({ httpGet: async () => response(body(['A-1', 'A-2'], ['2026-07-30', '2026-04-30'])) });
    expect((await runEdgarFilings(first, db(), run)).stored).toBe(2);

    // The same two come back, plus one genuinely new filing.
    const second = makeHost({
      httpGet: async () => response(body(['A-3', 'A-1', 'A-2'], ['2026-09-17', '2026-07-30', '2026-04-30']))
    });
    const again = await runEdgarFilings(second, db(), run);

    // The duplicate is a no-op and the NEW filing survives. Before the fix this
    // was `failed: 1, stored: 0` and A-3 was thrown away with the duplicates —
    // QC-701 would then call the filer stale with no trace of why.
    expect(again.failed).toBe(0);
    expect(again.stored).toBe(1);
    const held = raw.prepare("SELECT accession_no a FROM raw_edgar_filing WHERE cik = '0000047111' ORDER BY a").all();
    expect(held.map((r: { a: string }) => r.a)).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('asks the filers asked longest ago, so no filer is skipped and a re-run asks the next ones (v1.1.325)', async () => {
    // The old slice was `(calendar day × 20) mod filers`: weekend slices were never asked, and
    // v1.1.275 changing the filer count sent the pointer back over filers read nine days earlier.
    for (const [t, cik] of [['AAA', '0000000001'], ['BBB', '0000000002'], ['CCC', '0000000003'], ['DDD', '0000000004'], ['EEE', '0000000005']] as const) {
      listed(t, 'CS', cik);
    }
    const asked: string[] = [];
    let clock = 0;
    const host = makeHost({
      httpGet: async (url: string) => {
        asked.push(/CIK(\d+)/.exec(url)?.[1] ?? '');
        // A distinct body per call: an identical body on the same date is deduplicated at
        // capture, which would keep the earlier ask's timestamp.
        const body = submissions(1, '2026-06-01').replace('"files":[]', `"files":[],"call":${clock}`);
        return { ...response(body), requestedAt: new Date(Date.UTC(2026, 8, 18, 22, 0, clock++)).toISOString() };
      }
    });
    const round = async () => { asked.length = 0; await runEdgarFilings(host, db(), run, { maxFilers: 2 }); return [...asked]; };
    expect(await round()).toEqual(['0000000001', '0000000002']);
    expect(await round()).toEqual(['0000000003', '0000000004']);
    // EEE has never been asked; AAA is now the longest ago.
    expect(await round()).toEqual(['0000000005', '0000000001']);
    // A filer joining the universe goes to the front — it has never been asked.
    listed('ABC', 'CS', '0000000009');
    expect(await round()).toEqual(['0000000009', '0000000002']);
  });

  describe("SEC's ticker map overrides a stale Polygon CIK (v1.1.331)", () => {
    // 2026-09-27: Polygon gave FWONA, LLYVA and LLYVK CIK 0000869614, the old Liberty Media
    // Corporation, with no 10-Q or 10-K. SEC's company_tickers.json maps them to 1560385 / 2078416.
    const SEC_MAP = JSON.stringify({
      0: { cik_str: 2078416, ticker: 'LLYVA', title: 'Liberty Live Holdings, Inc.' },
      1: { cik_str: 2078416, ticker: 'LLYVK', title: 'Liberty Live Holdings, Inc.' },
      2: { cik_str: 19617, ticker: 'JPM', title: 'JPMORGAN CHASE & CO' },
      3: { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
      4: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' }            // not in the universe
    });
    const secHost = (asked: string[] = []) => makeHost({
      httpGet: async (url: string) => {
        asked.push(url);
        return url.includes('company_tickers') ? response(SEC_MAP) : response(submissions(1, '2026-06-01'));
      }
    });

    it('stores the universe\'s rows only, in our spelling, zero-padded', async () => {
      listed('LLYVA', 'CS', '0000869614');
      listed('BRK.B', 'CS', '0001067983');
      listed('JPM', 'CS', '0000019617');
      const r = await runSecTickerMap(secHost(), db(), run);
      expect(r).toMatchObject({ calls: 1, failed: 0, stored: 3 });
      const rows = raw.prepare('SELECT ticker, cik FROM raw_sec_ticker_map ORDER BY ticker').all();
      expect(rows).toEqual([
        { ticker: 'BRK.B', cik: '0001067983' }, { ticker: 'JPM', cik: '0000019617' }, { ticker: 'LLYVA', cik: '0002078416' }
      ]);
      // Weekly: a second run inside the cadence asks nothing.
      const asked: string[] = [];
      expect((await runSecTickerMap(secHost(asked), db(), run)).calls).toBe(0);
      expect(asked).toEqual([]);
    });

    it('makes the filings sweep ask EDGAR about SEC\'s CIK, not Polygon\'s', async () => {
      listed('LLYVA', 'CS', '0000869614');
      await runSecTickerMap(secHost(), db(), run);
      const asked: string[] = [];
      await runEdgarFilings(secHost(asked), db(), run);
      expect(asked.filter((u) => u.includes('/submissions/'))).toEqual(['https://data.sec.gov/submissions/CIK0002078416.json']);
    });

    it('falls back to Polygon for a ticker SEC does not list', async () => {
      listed('XYZ', 'CS', '0000000042');
      await runSecTickerMap(secHost(), db(), run);
      const asked: string[] = [];
      await runEdgarFilings(secHost(asked), db(), run);
      expect(asked.some((u) => u.includes('CIK0000000042'))).toBe(true);
    });

    it('QC-703 reports the disagreement, and closes when Polygon agrees', async () => {
      listed('LLYVA', 'CS', '0000869614');
      listed('JPM', 'CS', '0000019617');
      await runSecTickerMap(secHost(), db(), run);
      const byKey = new Map(QC703_CIK_SOURCE_DISAGREEMENT.run(ctx()).map((e) => [e.key, e]));
      expect(byKey.get('LLYVA')).toMatchObject({ fired: true });
      expect(byKey.get('LLYVA')!.detail).toContain('0002078416');
      expect(byKey.get('JPM')).toMatchObject({ fired: false, closesAs: { kind: 'provider_fixed' } });
      expect(QC703_CIK_SOURCE_DISAGREEMENT.escalatesOnRepeat).toBe(false);
    });
  });

  it('stores the universe\'s report filings from the daily form index, before the rotation reaches them (v1.1.325)', async () => {
    listed('KR', 'CS', '0000056873');
    listed('IVV', 'ETF', '0001100663');
    parsedIndex('2026-09-17');
    const index =
      HEADER +
      '10-Q    KROGER CO           56873      20260918    edgar/data/56873/0000056873-26-000074.txt\n' +
      '10-Q    ISHARES TRUST       1100663    20260918    edgar/data/1100663/0001100663-26-000001.txt\n' +
      '8-K     KROGER CO           56873      20260918    edgar/data/56873/0000056873-26-000073.txt\n';
    const host = makeHost({ httpGet: async () => response(index) });

    const first = await runInsiderSweep(host, db(), run);
    expect(first.failed).toBe(0);
    expect(first.reportFilings).toBe(1);
    const rows = raw.prepare('SELECT ticker, form, filed_date, report_date FROM raw_edgar_filing').all();
    expect(rows).toEqual([{ ticker: 'KR', form: '10-Q', filed_date: '2026-09-18', report_date: null }]);

    // The rotation then reads KR's own list, which repeats the filing: a no-op, not a failure.
    const again = await runEdgarFilings(makeHost({
      httpGet: async () => response(JSON.stringify({ filings: { recent: {
        accessionNumber: ['0000056873-26-000074'], form: ['10-Q'], filingDate: ['2026-09-18'],
        reportDate: ['2026-08-15'], primaryDocument: ['kr-20260815.htm']
      }, files: [] } }))
    }), db(), run);
    expect(again).toMatchObject({ failed: 0, stored: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_edgar_filing').get()).toEqual({ n: 1 });
  });
});
