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
import {
  makeEarningsIngest,
  makeIndexQuoteIngest,
  ingestTreasuryYields,
  makeRecommendationIngest,
  finnhubHourToReportTime,
  earningsResponseAtCap,
  parseCsvLine
} from '../src/ingest/events.js';
import {
  parseFomcCalendar,
  parseBlsSchedule,
  BLS_RELEASES
} from '../src/ingest/macro-calendar.js';
import {
  makeSubmissionsIngest,
  makeCompanyFactsIngest,
  makeForm4Ingest,
  parseDailyFormIndex,
  dailyFormIndexUrl,
  submissionsAtCap
} from '../src/ingest/edgar.js';
import { runEarningsSweep, runShortInterest, runTreasuryYields } from '../src/collector/phases/events.js';
import { runGate } from '../src/qa/gate.js';
import { EARNINGS_FUNDAMENTALS_CHECKS, MACRO_CHECKS } from '../src/qa/registry.js';

/**
 * B7a — phase 8, the event and macro domains.
 *
 * Every fixture here is a reduction of a **live response fetched 2026-09-07**,
 * not an invention. That matters because four of the shapes below contradict
 * what the field name or the documentation suggests, and each of those is one
 * test:
 *
 * - the FOMC page names both months when a meeting straddles the boundary;
 * - Finnhub's `hour` is the empty string on 47 % of universe rows;
 * - EDGAR's `filings.recent` is parallel arrays, capped at 1,000;
 * - a Form 4 wraps every value in a `<value>` element and may omit the price.
 */

let dir: string;
let raw: Database.Database;
/** One run shared by the check fixtures, so their rows have a run to belong to. */
let fixtureRun: RunHandle;

const DATE = '2026-09-07';
const OBSERVED = '2026-09-07T17:05:01-04:00';

function response(body: string, status: number | null = 200): ProviderResponse {
  return { status, body, requestedAt: OBSERVED, respondedAt: status === null ? null : OBSERVED };
}

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => raw as unknown as SqliteLike,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => response('{"results":[]}'),
    etradeGet: async () => response('{}'),
    httpGet: async () => response('{}'),
    nowET: () => OBSERVED,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function newRun(): RunHandle {
  return beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
}

function ctx(run: RunHandle) {
  return { runId: run.runId, asOfDate: DATE, observedAt: OBSERVED, captureRuleId: null, sourceResponseId: 1 };
}

/** Rule-driven tables require a real rule id, so the direct inserts need one too. */
function ruleId(): number {
  return captureRuleId(db(), makeHost(), 'test', { kind: 'test' }, 'Fixture rule.');
}

/**
 * Every raw row points back at the response it came from (P2, AC-1), and the
 * schema enforces it — so a fixture that inserts rows directly has to mint a
 * response row too. That the tests cannot take a shortcut here is the provenance
 * rule working as intended.
 */
let responseSeq = 0;
function fixtureResponseId(): number {
  responseSeq++;
  raw
    .prepare(
      `INSERT INTO meta_response
         (run_id, provider, endpoint, params_json, requested_at, responded_at, http_status,
          byte_length, archive_file, archive_offset, sha256, dedup_hash, encrypted,
          at_provider_cap, parse_status, parsed_row_count)
       VALUES (?, 'finnhub', '/fixture', '{}', ?, ?, 200, 0, 'archive/fixture.jsonl', ?, NULL, ?, 0, 0, 'ok', 0)`
    )
    .run(fixtureRun.runId, OBSERVED, OBSERVED, responseSeq, `fixture-${responseSeq}`);
  return (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
}

beforeEach(() => {
  responseSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'ta-b7-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-07T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
  fixtureRun = newRun();
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── the FOMC calendar ──────────────────────────────────────────────────────

/**
 * Reduced from the live page. The three year panels reproduce the exact cases
 * the real markup contains, including the out-of-order 2027 panel — the page
 * lists 2026 first, then descends to 2021, then appends 2027.
 */
const FOMC_HTML = `
<div class="panel panel-default"><div class="panel-heading"><h4>2026 FOMC Meetings</h4></div>
  <div class="fomc-meeting"><div class="fomc-meeting__month col-md-2"><strong>January</strong></div>
    <div class="fomc-meeting__date col-md-10">27-28</div></div>
  <div class="fomc-meeting"><div class="fomc-meeting__month col-md-2"><strong>September</strong></div>
    <div class="fomc-meeting__date col-md-10">15-16*</div></div>
</div>
<div class="panel panel-default"><div class="panel-heading"><h4>2025 FOMC Meetings</h4></div>
  <div class="fomc-meeting"><div class="fomc-meeting__month col-md-2"><strong>August</strong></div>
    <div class="fomc-meeting__date col-md-10">22 (notation vote)</div></div>
</div>
<div class="panel panel-default"><div class="panel-heading"><h4>2024 FOMC Meetings</h4></div>
  <div class="fomc-meeting"><div class="fomc-meeting__month col-md-2"><strong>Apr/May</strong></div>
    <div class="fomc-meeting__date col-md-10">30-1</div></div>
</div>
`;

describe('the FOMC calendar', () => {
  it('dates a meeting on its decision day, not its first day', () => {
    const events = parseFomcCalendar(FOMC_HTML);
    const jan = events.find((e) => e.eventKey === 'FOMC-2026-01');
    expect(jan?.eventDate).toBe('2026-01-28');
  });

  it('puts a month-straddling meeting in the SECOND month', () => {
    // `Apr/May 30-1` is 2024-05-01. Taking the first named month with the last
    // day gives 2024-04-01 — a real date, wrong by a month, and nothing
    // downstream could tell. This is the case that makes the slash mandatory
    // reading rather than decoration.
    const events = parseFomcCalendar(FOMC_HTML);
    const straddle = events.find((e) => e.eventDate.startsWith('2024'));
    expect(straddle?.eventDate).toBe('2024-05-01');
    expect(straddle?.eventKey).toBe('FOMC-2024-05');
  });

  it('keeps a single-day meeting that is not a range', () => {
    // 2025's `August 22 (notation vote)` has no dash. A regex demanding `d-d`
    // drops it silently.
    const events = parseFomcCalendar(FOMC_HTML);
    expect(events.find((e) => e.eventKey === 'FOMC-2025-08')?.eventDate).toBe('2025-08-22');
  });

  it('takes each meeting\'s year from its own panel', () => {
    // The page's panels are not in chronological order, so a flat sweep would
    // attach every meeting to whichever year was parsed last.
    const years = new Set(parseFomcCalendar(FOMC_HTML).map((e) => e.eventDate.slice(0, 4)));
    expect([...years].sort()).toEqual(['2024', '2025', '2026']);
  });

  it('reports no time rather than inventing the usual one', () => {
    // 14:00 ET is when the statement normally lands, but the page does not say
    // so — and a value we believe is not a value the source published.
    expect(parseFomcCalendar(FOMC_HTML).every((e) => e.eventTime === null)).toBe(true);
  });
});

// ── the BLS schedules ──────────────────────────────────────────────────────

const BLS_HTML = `
<table class="release-list">
<tr><th>Reference Month</th><th>Release Date</th><th>Release Time</th></tr>
<tr><td><p>November 2025</p></td><td><p>Dec. 18, 2025</p></td><td><p>08:30 AM</p></td></tr>
<tr><td><p>October 2026</p></td><td><p>Nov. 04, 2026</p></td><td><p>08:30 AM</p></td></tr>
</table>
<table><tr><td>BY MONTH FEBRUARY 2026 ... navigation junk ...</td></tr></table>
`;

describe('the BLS release schedules', () => {
  const cpi = BLS_RELEASES.find((r) => r.type === 'CPI') as (typeof BLS_RELEASES)[number];

  it('keys an event on the REFERENCE month, so a reschedule is the same event', () => {
    const events = parseBlsSchedule(BLS_HTML, cpi);
    expect(events.map((e) => e.eventKey)).toEqual(['CPI-2025-11', 'CPI-2026-10']);
  });

  it('reads the release date and normalises the time to 24 hours', () => {
    const first = parseBlsSchedule(BLS_HTML, cpi)[0];
    expect(first?.eventDate).toBe('2025-12-18');
    expect(first?.eventTime).toBe('08:30');
  });

  it('rejects the navigation row by shape rather than by position', () => {
    // The page serialises its own nav into a <tr>. Skipping "the first row"
    // would break the day that markup changes; requiring three cells and a
    // date-shaped middle one does not.
    expect(parseBlsSchedule(BLS_HTML, cpi)).toHaveLength(2);
  });
});

// ── the treasury curve ─────────────────────────────────────────────────────

const TREASURY_CSV =
  'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"\n' +
  '09/04/2026,3.79,3.83,3.90,3.91,4.00,3.98,4.13,4.37,4.45,4.54,4.65,4.78,5.25,5.24\n' +
  '09/03/2026,3.83,3.82,3.91,3.89,3.99,3.95,4.11,4.34,4.41,4.52,4.63,4.77,5.25,5.25\n';

describe('the treasury par yield curve', () => {
  it('parses all 14 published tenors', () => {
    const rows = ingestTreasuryYields(TREASURY_CSV, ctx(newRun()));
    const tenors = new Set(rows.map((r) => r.values['tenor']));
    expect(tenors.size).toBe(14);
    expect(tenors.has('1.5M')).toBe(true);
  });

  it('converts percent to fraction once, at ingestion', () => {
    const rows = ingestTreasuryYields(TREASURY_CSV, ctx(newRun()));
    const threeMonth = rows.find(
      (r) => r.values['curve_date'] === '2026-09-04' && r.values['tenor'] === '3M'
    );
    // 3.91 % on 09/04/2026, read from the live CSV.
    expect(threeMonth?.values['yield']).toBeCloseTo(0.0391, 10);
  });

  it('maps tenors by header NAME, so a renamed column goes missing rather than mislabelled', () => {
    // `1.5 Month` spells the word out where every other tenor abbreviates,
    // which is the standing proof that positions are not a contract. A
    // positional reader survives this rename and silently shifts a whole curve.
    const renamed = TREASURY_CSV.replace('"1.5 Month"', '"1.5 Fortnights"');
    const rows = ingestTreasuryYields(renamed, ctx(newRun()));
    const tenors = new Set(rows.map((r) => r.values['tenor']));
    expect(tenors.size).toBe(13);
    // And the tenors that remain still carry their own values, not their
    // neighbours': 3M is still 3.91 %, not 4.00 %.
    const threeMonth = rows.find(
      (r) => r.values['curve_date'] === '2026-09-04' && r.values['tenor'] === '3M'
    );
    expect(threeMonth?.values['yield']).toBeCloseTo(0.0391, 10);
  });

  it('handles quoted CSV cells containing commas', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('stores the whole year from one call, which is what makes the pull idempotent', async () => {
    const run = newRun();
    const result = await runTreasuryYields(
      makeHost({ httpGet: async () => response(TREASURY_CSV) }),
      db(),
      run
    );
    expect(result.calls).toBe(1);
    const dates = raw
      .prepare('SELECT DISTINCT curve_date FROM raw_treasury_yield ORDER BY curve_date')
      .all() as { curve_date: string }[];
    expect(dates.map((d) => d.curve_date)).toEqual(['2026-09-03', '2026-09-04']);
    expect(result.stored).toBe(28);
  });
});

// ── short interest ─────────────────────────────────────────────────────────

describe('short interest', () => {
  it('sweeps the whole market even when the chain subset is empty', async () => {
    // A whole-market sweep names no tickers, so an empty subset (a fresh
    // generation before 20 bars exist) used to skip it for no reason.
    expect((raw.prepare('SELECT COUNT(*) AS n FROM ref_chain_subset_membership').get() as { n: number }).n).toBe(0);

    const paths: string[] = [];
    const body = JSON.stringify({
      status: 'OK',
      results: [
        { ticker: 'AAPL', settlement_date: '2026-08-29', short_interest: 101_000_000, avg_daily_volume: 50_000_000, days_to_cover: 2.02 },
        { ticker: 'MSFT', settlement_date: '2026-08-29', short_interest: 45_000_000 }
      ]
    });
    const result = await runShortInterest(
      makeHost({ polygonGet: async (path) => { paths.push(path); return response(body); } }),
      db(),
      newRun()
    );

    expect(paths).toEqual(['/stocks/v1/short-interest']);
    expect(result.stored).toBe(2);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM raw_short_interest').get() as { n: number }).n).toBe(2);
  });
});

// ── earnings ───────────────────────────────────────────────────────────────

function earningsBody(rows: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ earningsCalendar: rows });
}

describe('the earnings calendar', () => {
  it('maps an empty-string hour to null with status omitted', () => {
    // Measured over 520 universe reports: bmo 132, amc 144, '' on 244 (47 %).
    // Stored verbatim it would be a fourth enum member that every
    // `report_time IS NULL` filter silently misses.
    expect(finnhubHourToReportTime('')).toEqual({ value: null, status: 'omitted' });
    expect(finnhubHourToReportTime('bmo')).toEqual({ value: 'bmo', status: 'ok' });
  });

  it('reports an unrecognised hour as invalid rather than mapping it to a neighbour', () => {
    expect(finnhubHourToReportTime('premarket')).toEqual({ value: null, status: 'invalid' });
  });

  it('writes the estimate row from the same response, at no extra call', () => {
    const rows = makeEarningsIngest({ sweepFrom: DATE, sweepTo: DATE })(
      earningsBody([
        { symbol: 'NVDA', date: '2026-11-19', hour: 'amc', year: 2027, quarter: 3, epsEstimate: 1.42, revenueEstimate: 5.4e10 }
      ]),
      ctx(newRun())
    );
    expect(rows.map((r) => r.table)).toEqual(['raw_earnings_event', 'raw_analyst_estimate']);
    expect(rows[1]?.values['fiscal_period']).toBe('2027Q3');
  });

  it('writes no estimate row when there is no consensus, rather than a row of nulls', () => {
    const rows = makeEarningsIngest({ sweepFrom: DATE, sweepTo: DATE })(
      earningsBody([{ symbol: 'XYZ', date: '2026-11-19', hour: '', year: 2027, quarter: 3 }]),
      ctx(newRun())
    );
    expect(rows.map((r) => r.table)).toEqual(['raw_earnings_event']);
  });

  it('filters the all-market calendar down to the universe', () => {
    const rows = makeEarningsIngest({
      sweepFrom: DATE, sweepTo: DATE, universe: new Set(['NVDA'])
    })(
      earningsBody([
        { symbol: 'NVDA', date: '2026-11-19' },
        { symbol: 'TINYCO', date: '2026-11-19' }
      ]),
      ctx(newRun())
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values['ticker']).toBe('NVDA');
  });

  it('treats a response AT the cap as evidence of truncation', () => {
    const capped = earningsBody(Array.from({ length: 1500 }, () => ({ symbol: 'A', date: DATE })));
    expect(earningsResponseAtCap(capped)).toBe(true);
    expect(earningsResponseAtCap(earningsBody([{ symbol: 'A', date: DATE }]))).toBe(false);
  });

  it('subdivides a capped slice instead of trusting it', async () => {
    // The bug this reproduces: the cap drops the EARLIEST dates, so a capped
    // 90-day response holds only the tail of the window. The existing app
    // trusted one and stored NVDA's August report as November.
    const requested: string[] = [];
    const host = makeHost({
      httpGet: async (url: string) => {
        const from = /from=([\d-]+)/.exec(url)?.[1] ?? '';
        const to = /to=([\d-]+)/.exec(url)?.[1] ?? '';
        requested.push(`${from}..${to}`);
        const span = Math.round(
          (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
        );
        // Wide windows come back capped; narrow ones answer honestly.
        const n = span >= 10 ? 1500 : 3;
        return response(earningsBody(Array.from({ length: n }, () => ({ symbol: 'A', date: to }))));
      }
    });

    await runEarningsSweep(host, db(), newRun(), { windowDays: 30, sliceDays: 30 });

    // The first 30-day request came back at the cap, so it was halved, and the
    // halves halved again, until the responses stopped being capped.
    expect(requested[0]).toBe('2026-09-07..2026-10-06');
    expect(requested.length).toBeGreaterThan(1);
    const finalSpans = requested.slice(1).map((r) => {
      const [from, to] = r.split('..') as [string, string];
      return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    });
    expect(Math.max(...finalSpans)).toBeLessThan(30);
  });

  it('stops subdividing at a single day and leaves the cap recorded', async () => {
    // A one-day slice cannot be split further. The rows are kept and the cap
    // stays on the response row: knowing the answer is incomplete beats
    // believing it, and beats looping forever.
    const host = makeHost({
      httpGet: async () =>
        response(earningsBody(Array.from({ length: 1500 }, () => ({ symbol: 'A', date: DATE }))))
    });
    const result = await runEarningsSweep(host, db(), newRun(), { windowDays: 2, sliceDays: 2 });
    expect(result.calls).toBeLessThan(10);
    const capped = raw
      .prepare('SELECT COUNT(*) AS n FROM meta_response WHERE at_provider_cap = 1')
      .get() as { n: number };
    expect(capped.n).toBeGreaterThan(0);
  });
});

// ── index quotes ───────────────────────────────────────────────────────────

describe('index quotes', () => {
  it('reads all five All.* fields and the epoch-seconds timestamp', () => {
    const body = JSON.stringify({
      QuoteResponse: {
        QuoteData: [
          {
            dateTimeUTC: 1_788_552_898,
            Product: { symbol: 'VIX' },
            All: { lastTrade: 14.53, open: 15.1, high: 15.4, low: 14.4, previousClose: 15.02 }
          }
        ]
      }
    });
    const rows = makeIndexQuoteIngest({ symbol: 'VIX' })(body, ctx(newRun()));
    expect(rows[0]?.values['last']).toBe(14.53);
    expect(rows[0]?.values['prev_close']).toBe(15.02);
    expect(rows[0]?.values['last_status']).toBe('ok');
    expect(rows[0]?.values['session_status']).toBe('ok');
    // Seconds, not milliseconds: as ms this lands in January 1970.
    expect(String(rows[0]?.values['provider_timestamp'])).toContain('2026-09-04');
  });

  it('marks a quote with no last trade omitted rather than storing zero', () => {
    const body = JSON.stringify({ QuoteResponse: { QuoteData: [{ Product: { symbol: 'VIX' }, All: {} }] } });
    const rows = makeIndexQuoteIngest({ symbol: 'VIX' })(body, ctx(newRun()));
    expect(rows[0]?.values['last']).toBeNull();
    expect(rows[0]?.values['last_status']).toBe('omitted');
  });

  it('keeps a good last when only a session field is missing', () => {
    // `last` is what QC-901, the critic and the dashboard all read. Under the
    // drafted single shared status a missing `open` would have had to null it
    // too, and QC-901 treats an absent last as blocking — so one missing
    // context field would have taken out the market regime read.
    const body = JSON.stringify({
      QuoteResponse: {
        QuoteData: [{ Product: { symbol: 'VIX' }, All: { lastTrade: 14.53, high: 15.4, low: 14.4, previousClose: 15.02 } }]
      }
    });
    const rows = makeIndexQuoteIngest({ symbol: 'VIX' })(body, ctx(newRun()));
    expect(rows[0]?.values['last']).toBe(14.53);
    expect(rows[0]?.values['last_status']).toBe('ok');
    // The session group is all-or-nothing, because one status covers all four.
    expect(rows[0]?.values['session_status']).toBe('omitted');
    expect(rows[0]?.values['high']).toBeNull();
  });
});

// ── analyst recommendations ────────────────────────────────────────────────

describe('analyst recommendations', () => {
  it('reads the four monthly periods Finnhub returns per call', () => {
    const body = JSON.stringify([
      { symbol: 'NVDA', period: '2026-09-01', strongBuy: 30, buy: 12, hold: 4, sell: 1, strongSell: 0 },
      { symbol: 'NVDA', period: '2026-08-01', strongBuy: 29, buy: 13, hold: 4, sell: 1, strongSell: 0 }
    ]);
    const rows = makeRecommendationIngest({ ticker: 'NVDA' })(body, ctx(newRun()));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.values['strong_buy']).toBe(30);
    expect(rows[0]?.values['period_month']).toBe('2026-09-01');
  });

  it('drops a row with no period, which is the only field it is keyed on', () => {
    const rows = makeRecommendationIngest({ ticker: 'NVDA' })(
      JSON.stringify([{ symbol: 'NVDA', strongBuy: 30 }]),
      ctx(newRun())
    );
    expect(rows).toHaveLength(0);
  });

  it('survives the error envelope a rate-limited call returns instead of an array', () => {
    // Finnhub answers a 200 with an object when it is unhappy. Array.isArray is
    // the guard; without it this throws inside the capture transaction and the
    // whole response lands as a parse failure with no clue why.
    const rows = makeRecommendationIngest({ ticker: 'NVDA' })(
      JSON.stringify({ error: 'API limit reached' }),
      ctx(newRun())
    );
    expect(rows).toHaveLength(0);
  });
});

// ── EDGAR ──────────────────────────────────────────────────────────────────

describe('EDGAR submissions', () => {
  const body = JSON.stringify({
    filings: {
      recent: {
        accessionNumber: ['0000320193-26-000106', '0001140361-26-035636', '0000320193-26-000070'],
        filingDate: ['2026-08-01', '2026-09-03', '2026-05-02'],
        reportDate: ['2026-06-28', '2026-09-01', ''],
        form: ['10-Q', '4', '10-Q'],
        primaryDocument: ['aapl-20260628.htm', 'xslF345X06/form4.xml', 'aapl-20260329.htm']
      }
    }
  });

  it('zips the parallel arrays and keeps only the report forms asked for', () => {
    const rows = makeSubmissionsIngest({ cik: '0000320193', ticker: 'AAPL', forms: new Set(['10-Q']) })(
      body,
      ctx(newRun())
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.values['accession_no']).toBe('0000320193-26-000106');
    expect(rows[0]?.values['report_date']).toBe('2026-06-28');
  });

  it('maps an empty reportDate to null rather than storing the empty string', () => {
    // An empty date string sorts before every real date and would quietly win
    // any MIN() comparison.
    const rows = makeSubmissionsIngest({ cik: '0000320193', ticker: 'AAPL', forms: new Set(['10-Q']) })(
      body,
      ctx(newRun())
    );
    expect(rows[1]?.values['report_date']).toBeNull();
  });

  it('honours the since cutoff', () => {
    const rows = makeSubmissionsIngest({
      cik: '0000320193', ticker: 'AAPL', forms: new Set(['10-Q']), since: '2026-06-01'
    })(body, ctx(newRun()));
    expect(rows).toHaveLength(1);
  });

  it('detects the 1,000-entry cap the same way as Finnhub\'s', () => {
    const big = JSON.stringify({
      filings: { recent: { accessionNumber: Array.from({ length: 1000 }, (_, i) => `a-${i}`) } }
    });
    expect(submissionsAtCap(big)).toBe(true);
    expect(submissionsAtCap(body)).toBe(false);
  });

  it('reports the cap only when the truncation reaches into the stored window', () => {
    // EDGAR drops the OLDEST filings. A full list whose oldest kept filing
    // predates `since` lost nothing the phase stores — on gen-001's first day
    // flagging those anyway fired a blocking QC-008 on 16 of 20 filers.
    const full = (oldest: string) =>
      JSON.stringify({
        filings: {
          recent: {
            accessionNumber: Array.from({ length: 1000 }, (_, i) => `a-${i}`),
            filingDate: Array.from({ length: 1000 }, (_, i) => (i === 999 ? oldest : '2026-09-01'))
          }
        }
      });
    expect(submissionsAtCap(full('2024-01-02'), '2025-09-10')).toBe(false);
    expect(submissionsAtCap(full('2025-12-01'), '2025-09-10')).toBe(true);
    // The boundary day itself may have been cut part-way through.
    expect(submissionsAtCap(full('2025-09-10'), '2025-09-10')).toBe(true);
    // No dates to reason from is not evidence of completeness.
    const dateless = JSON.stringify({
      filings: { recent: { accessionNumber: Array.from({ length: 1000 }, (_, i) => `a-${i}`) } }
    });
    expect(submissionsAtCap(dateless, '2025-09-10')).toBe(true);
  });
});

describe('EDGAR company facts', () => {
  const body = JSON.stringify({
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              { start: '2018-07-01', end: '2018-09-29', val: 62_900_000_000, accn: '0000320193-18-000145', fy: 2018, fp: 'FY', form: '10-K', filed: '2018-11-05', frame: 'CY2018Q3' },
              { start: '2026-04-01', end: '2026-06-28', val: 85_000_000_000, accn: '0000320193-26-000106', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-08-01' }
            ]
          }
        },
        Assets: {
          units: { USD: [{ end: '2026-06-28', val: 331_000_000_000, accn: '0000320193-26-000106', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-08-01' }] }
        }
      },
      'made-up-taxonomy': { Nonsense: { units: { USD: [{ end: '2026-06-28', val: 1, accn: 'x', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-08-01' }] } } }
    }
  });

  it('stores an instant fact with a null period_start', () => {
    const rows = makeCompanyFactsIngest({ cik: '0000320193' })(body, ctx(newRun()));
    const assets = rows.find((r) => r.values['concept'] === 'Assets');
    // A balance-sheet fact has a point in time, not a period. That is the
    // column's declared null meaning, not a gap.
    expect(assets?.values['period_start']).toBeNull();
    expect(assets?.values['period_end']).toBe('2026-06-28');
  });

  it('keeps fy/fp verbatim even when they describe the filing rather than the fact', () => {
    // Apple's Q3-2018 revenue carries fp: "FY" because a 10-K reported it.
    // Anything wanting the fact's own period reads period_start/period_end.
    const rows = makeCompanyFactsIngest({ cik: '0000320193' })(body, ctx(newRun()));
    const old = rows.find((r) => r.values['period_end'] === '2018-09-29');
    expect(old?.values['fiscal_period']).toBe('FY');
  });

  it('drops a taxonomy the dictionary does not declare', () => {
    const rows = makeCompanyFactsIngest({ cik: '0000320193' })(body, ctx(newRun()));
    expect(rows.some((r) => r.values['taxonomy'] === 'made-up-taxonomy')).toBe(false);
  });
});

describe('the EDGAR daily form index', () => {
  const IDX =
    'Description:           Daily Index of EDGAR Dissemination Feed by Form Type\n' +
    'Form Type   Company Name                              CIK        Date Filed  File Name\n' +
    '-------------------------------------------------------------------------------------\n' +
    '1-A/A            Agentiq Sports 1 Series LLC          2105654    20260904    edgar/data/2105654/0001213900-26-097702.txt\n' +
    '4                ACACIA RESEARCH CORP                 934549     20260904    edgar/data/934549/0001111318-26-000012.txt\n' +
    '4                908 Devices Inc.                     1555279    20260904    edgar/data/1555279/0001836988-26-000025.txt\n';

  it('parses from the trailing path rather than from column offsets', () => {
    const filings = parseDailyFormIndex(IDX);
    expect(filings).toHaveLength(3);
    const acacia = filings.find((f) => f.cik === '0000934549');
    expect(acacia?.formType).toBe('4');
    expect(acacia?.accessionNo).toBe('0001111318-26-000012');
    expect(acacia?.filedDate).toBe('2026-09-04');
  });

  it('zero-pads the CIK so it joins against the reference table', () => {
    expect(parseDailyFormIndex(IDX).map((f) => f.cik)).toContain('0001555279');
  });

  it('skips the header and separator lines by shape', () => {
    expect(parseDailyFormIndex(IDX).every((f) => f.path.startsWith('edgar/data/'))).toBe(true);
  });

  it('builds the index URL with the right quarter', () => {
    expect(dailyFormIndexUrl('2026-09-04')).toContain('/2026/QTR3/form.20260904.idx');
    expect(dailyFormIndexUrl('2026-01-02')).toContain('/2026/QTR1/form.20260102.idx');
  });
});

describe('Form 4', () => {
  const FORM4 = `
<SEC-DOCUMENT>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-09-02</periodOfReport>
  <issuer><issuerCik>0000934549</issuerCik><issuerTradingSymbol>ACTG</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001111318</rptOwnerCik><rptOwnerName>OCONNELL MAUREEN</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTransaction>
    <securityTitle><value>ACTG Common Stock</value></securityTitle>
    <transactionDate><value>2026-09-02</value></transactionDate>
    <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>20534</value></transactionShares>
      <transactionPricePerShare><value>4.63</value><footnoteId id="F1"/></transactionPricePerShare>
    </transactionAmounts>
    <postTransactionAmounts><sharesOwnedFollowingTransaction><value>267121</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
  </nonDerivativeTransaction>
  <nonDerivativeTransaction>
    <transactionDate><value>2026-09-02</value></transactionDate>
    <transactionCoding><transactionCode>G</transactionCode></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>500</value></transactionShares>
      <transactionPricePerShare><value></value></transactionPricePerShare>
    </transactionAmounts>
  </nonDerivativeTransaction>
  <derivativeTransaction>
    <transactionDate><value>2026-09-02</value></transactionDate>
    <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
    <transactionAmounts><transactionShares><value>99999</value></transactionShares></transactionAmounts>
  </derivativeTransaction>
</ownershipDocument>
</SEC-DOCUMENT>`;

  const parse = () =>
    makeForm4Ingest({ accessionNo: '0001111318-26-000012' })(FORM4, ctx(newRun()));

  it('reads a price from inside the <value> wrapper, past the footnote', () => {
    // The field element holds both <value> and <footnoteId/>; reading its text
    // would concatenate them.
    expect(parse()[0]?.values['price']).toBe(4.63);
    expect(parse()[0]?.values['shares']).toBe(20534);
  });

  it('stores a gift with a null price, not a zero', () => {
    // Awards and gifts genuinely report no price. A zero there reads as a free
    // purchase.
    const gift = parse().find((r) => r.values['transaction_code'] === 'G');
    expect(gift?.values['price']).toBeNull();
    expect(gift?.values['shares']).toBe(500);
  });

  it('excludes derivative transactions, which have no column to distinguish them', () => {
    // An option grant's notional share count in the same `shares` column as an
    // open-market purchase would corrupt every insider-buying signal computed
    // from the table, undetectably.
    expect(parse().every((r) => r.values['shares'] !== 99999)).toBe(true);
    expect(parse()).toHaveLength(2);
  });

  it('keeps the transaction code verbatim', () => {
    // An `F` (shares withheld for tax) is not a sale, and a two-way buy/sell
    // mapping manufactures insider selling out of payroll.
    expect(parse().map((r) => r.values['transaction_code'])).toEqual(['S', 'G']);
  });

  it('joins non-exclusive relationship flags rather than taking the first', () => {
    expect(parse()[0]?.values['filer_role']).toBe('director; officer; CFO');
  });

  it('falls back to the issuer trading symbol when the CIK is not in our map', () => {
    expect(parse()[0]?.values['ticker']).toBe('ACTG');
  });

  it('prefers our own CIK mapping over the filing\'s symbol', () => {
    const rows = makeForm4Ingest({
      accessionNo: 'x',
      tickerByCik: new Map([['0000934549', 'ACTG.OLD']])
    })(FORM4, ctx(newRun()));
    expect(rows[0]?.values['ticker']).toBe('ACTG.OLD');
  });
});

// ── the checks ─────────────────────────────────────────────────────────────

function gate(checks: readonly (typeof EARNINGS_FUNDAMENTALS_CHECKS)[number][]) {
  return runGate(db(), makeHost(), {
    runId: fixtureRun.runId, tradingDate: DATE, checks, domainsExpected: {}
  });
}

function insertEarnings(rows: readonly {
  ticker: string; date: string; observedAt: string; source?: string;
}[]) {
  const stmt = raw.prepare(
    `INSERT INTO raw_earnings_event
       (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, report_date,
        report_time, report_time_status, eps_estimate_status, eps_actual_status,
        revenue_estimate_status, revenue_actual_status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'omitted', 'omitted', 'omitted', 'omitted', 'omitted', ?)`
  );
  const rule = ruleId();
  for (const r of rows) {
    stmt.run(fixtureRun.runId, DATE, r.observedAt, rule, fixtureResponseId(), r.ticker, r.date, r.source ?? 'finnhub');
  }
}

describe('QC-601, the earnings truncation signature', () => {
  it('fires when a date slips more than 14 days later', () => {
    // The NVDA case: 2026-08-26 stored as 2026-11-17 from a capped response.
    insertEarnings([
      { ticker: 'NVDA', date: '2026-08-26', observedAt: '2026-09-01T17:00:00-04:00' },
      { ticker: 'NVDA', date: '2026-11-17', observedAt: '2026-09-07T17:00:00-04:00' }
    ]);
    const result = gate([EARNINGS_FUNDAMENTALS_CHECKS[0] as never]);
    expect(result.blocking).toBe(1);
  });

  it('does NOT fire when a date moves nearer, however far', () => {
    // A coverage gap hiding the near date is the common case and the correction
    // is unbounded. The asymmetry is the whole rule.
    insertEarnings([
      { ticker: 'NVDA', date: '2026-11-17', observedAt: '2026-09-01T17:00:00-04:00' },
      { ticker: 'NVDA', date: '2026-08-26', observedAt: '2026-09-07T17:00:00-04:00' }
    ]);
    expect(gate([EARNINGS_FUNDAMENTALS_CHECKS[0] as never]).blocking).toBe(0);
  });

  it('does not fire on a small later slip an issuer might genuinely make', () => {
    insertEarnings([
      { ticker: 'NVDA', date: '2026-08-26', observedAt: '2026-09-01T17:00:00-04:00' },
      { ticker: 'NVDA', date: '2026-09-02', observedAt: '2026-09-07T17:00:00-04:00' }
    ]);
    expect(gate([EARNINGS_FUNDAMENTALS_CHECKS[0] as never]).blocking).toBe(0);
  });

  it('records the distribution even on a clean run', () => {
    // P10: a check cannot record fires without the distribution they came from.
    insertEarnings([
      { ticker: 'NVDA', date: '2026-08-26', observedAt: '2026-09-01T17:00:00-04:00' },
      { ticker: 'NVDA', date: '2026-09-02', observedAt: '2026-09-07T17:00:00-04:00' }
    ]);
    gate([EARNINGS_FUNDAMENTALS_CHECKS[0] as never]);
    const row = raw
      .prepare("SELECT distribution_json FROM qa_check_result WHERE check_id = 'QC-601'")
      .get() as { distribution_json: string | null } | undefined;
    expect(row?.distribution_json).toBeTruthy();
    expect(JSON.parse(row?.distribution_json as string).n).toBe(1);
  });
});

describe('QC-901, the index range guard', () => {
  beforeEach(() => {
    raw.exec(
      "INSERT INTO ref_macro_series (symbol, description, sane_min, sane_max, enabled, added_at) " +
        "VALUES ('VIX', 'CBOE Volatility Index', 5, 150, 1, '2026-09-07T00:00:00-04:00')"
    );
  });

  function insertQuote(last: number | null) {
    raw
      .prepare(
        `INSERT INTO raw_index_quote
           (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, symbol, last,
            last_status, session_status)
         VALUES (?, ?, ?, ?, ?, 'VIX', ?, ?, 'omitted')`
      )
      .run(fixtureRun.runId, DATE, OBSERVED, ruleId(), fixtureResponseId(), last, last === null ? 'omitted' : 'ok');
  }

  it('passes a value inside the band', () => {
    insertQuote(14.53);
    expect(gate([MACRO_CHECKS[0] as never]).blocking).toBe(0);
  });

  it('fires on a value outside the band', () => {
    insertQuote(999);
    expect(gate([MACRO_CHECKS[0] as never]).blocking).toBe(1);
  });

  it('fires just as hard when the quote is MISSING', () => {
    // A silently absent VIX is how a regime gate comes to be evaluated against
    // nothing at all — the same failure mode as a check that returns no
    // evaluations and reads as clean.
    expect(gate([MACRO_CHECKS[0] as never]).blocking).toBe(1);
  });
});

describe('QC-902, the yield curve', () => {
  it('fires when a renamed header costs a tenor', () => {
    const rows = ingestTreasuryYields(
      TREASURY_CSV.replace('"1.5 Month"', '"1.5 Fortnights"'),
      ctx(newRun())
    );
    const stmt = raw.prepare(
      `INSERT INTO raw_treasury_yield
         (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, curve_date, tenor,
          "yield", source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'treasury')`
    );
    const rule = ruleId();
    const resp = fixtureResponseId();
    for (const r of rows) {
      stmt.run(fixtureRun.runId, DATE, OBSERVED, rule, resp, r.values['curve_date'], r.values['tenor'], r.values['yield']);
    }
    expect(gate([MACRO_CHECKS[1] as never]).warnings).toBe(1);
  });

  it('fires when no curve exists at all', () => {
    expect(gate([MACRO_CHECKS[1] as never]).warnings).toBe(1);
  });
});

describe('QC-903, the macro calendar gap', () => {
  function insertEvent(type: string, date: string) {
    raw
      .prepare(
        `INSERT INTO raw_macro_event
           (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, event_key,
            event_type, event_date, event_time, description, source_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'x', NULL)`
      )
      .run(fixtureRun.runId, DATE, OBSERVED, ruleId(), fixtureResponseId(), `${type}-${date}`, type, date);
  }

  it('passes when both an FOMC and a CPI are scheduled in their windows', () => {
    insertEvent('FOMC', '2026-10-28');
    insertEvent('CPI', '2026-09-10');
    expect(gate([MACRO_CHECKS[2] as never]).warnings).toBe(0);
  });

  it('fires once per horizon when the calendar has gone stale', () => {
    // Both bodies publish a year ahead, so an empty forward window means our
    // copy is stale, not that nothing is scheduled. Two horizons are checked —
    // FOMC and CPI — and with nothing stored both of them fire, which is what
    // distinguishes "the calendar is empty" from "one release has slipped".
    expect(gate([MACRO_CHECKS[2] as never]).warnings).toBe(2);
  });
});

describe('QC-906, the insider parse check', () => {
  it('says nothing on a day with no Form 4 fetched', () => {
    // Firing on an empty day would train the operator to ignore the check on
    // exactly the days it has nothing to say.
    expect(gate([MACRO_CHECKS[5] as never]).warnings).toBe(0);
    const row = raw
      .prepare("SELECT evaluated_count FROM qa_check_result WHERE check_id = 'QC-906'")
      .get() as { evaluated_count: number } | undefined;
    expect(row?.evaluated_count ?? 0).toBe(0);
  });
});
