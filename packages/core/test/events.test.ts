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
import {
  QC601_EARNINGS_SLIPS_LATER,
  QC602_EARNINGS_SOURCE_DISAGREEMENT,
  QC604_EARNINGS_WEEKEND_DATE
} from '../src/qa/checks/earnings-fundamentals.js';
import { ensureTradingCalendar } from '../src/collector/trading-calendar.js';
import { captureResponse } from '../src/collector/capture.js';
import { recipes } from '../src/ingest/recipes.js';
import { QC008_PROVIDER_CAP, QC009_DUPLICATE_NATURAL_KEY } from '../src/qa/checks/cross-cutting.js';
import { getTable } from '../src/dictionary/index.js';

const INSIDER_KEY = (): readonly string[] | undefined => getTable('raw_insider_transaction')?.naturalKey;

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

    const sweepRun = newRun();
    await runEarningsSweep(host, db(), sweepRun, { windowDays: 30, sliceDays: 30 });

    // The first 30-day request came back at the cap, so it was halved, and the
    // halves halved again, until the responses stopped being capped.
    expect(requested[0]).toBe('2026-09-07..2026-10-06');
    expect(requested.length).toBeGreaterThan(1);
    const finalSpans = requested.slice(1).map((r) => {
      const [from, to] = r.split('..') as [string, string];
      return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
    });
    expect(Math.max(...finalSpans)).toBeLessThan(30);

    // And QC-008 has nothing to say: every capped window was re-covered by its
    // uncapped halves. On 2026-09-16 it raised 3 blocking findings for exactly this.
    const qc008 = QC008_PROVIDER_CAP.run({ db: db(), runId: sweepRun.runId, tradingDate: DATE, observedAt: OBSERVED });
    expect(qc008.length).toBeGreaterThan(0);
    expect(qc008.filter((e) => e.fired)).toEqual([]);
  });

  it('re-judges findings from EARLIER runs: a re-covered window and a fund close, a stock stays (v1.1.283)', () => {
    // gen-002 on 2026-09-18: nine calendar windows raised before v1.1.252 that their own run had
    // re-covered, and six iShares submissions responses from before funds left the EDGAR sweep.
    const earlier = newRun();
    const insert = raw.prepare(
      `INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length,
         archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count)
       VALUES (?, ?, ?, ?, ?, 200, 1, 'f', 0, 'h', ?, 1, ?, 'ok', 0)`
    );
    const add = (provider: string, endpoint: string, params: object, cap: 0 | 1): number =>
      Number(insert.run(earlier.runId, provider, endpoint, JSON.stringify(params), OBSERVED, `rj-${JSON.stringify(params)}`, cap).lastInsertRowid);
    const window = add('finnhub', '/calendar/earnings', { from: '2026-10-01', to: '2026-10-10' }, 1);
    add('finnhub', '/calendar/earnings', { from: '2026-10-01', to: '2026-10-05' }, 0);
    add('finnhub', '/calendar/earnings', { from: '2026-10-06', to: '2026-10-10' }, 0);
    const fund = add('edgar', '/submissions/CIK{cik}.json', { cik: '0001100663', ticker: 'IVV' }, 1);
    const stock = add('edgar', '/submissions/CIK{cik}.json', { cik: '0000019617', ticker: 'JPM' }, 1);
    const ref = raw.prepare(
      `INSERT INTO raw_ticker_reference (run_id, as_of_date, observed_at, capture_rule_id, source_response_id, ticker, name,
         security_type, market_cap_status, shares_outstanding_status, list_date, active, optionable_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'omitted', 'omitted', NULL, 1, 'omitted')`
    );
    ref.run(earlier.runId, DATE, OBSERVED, ruleId(), fund, 'IVV', 'iShares Core S&P 500 ETF', 'ETF');
    ref.run(earlier.runId, DATE, OBSERVED, ruleId(), stock, 'JPM', 'JPMorgan Chase', 'CS');

    // Raised by the rules of the day: every capped response fired.
    runGate(db(), makeHost(), {
      runId: earlier.runId, tradingDate: DATE, domainsExpected: {},
      checks: [{ ...QC008_PROVIDER_CAP, run: () => [window, fund, stock].map((id) => ({ key: String(id), fired: true, detail: 'capped' })) }]
    });
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(earlier.runId);

    // A later run with no capped response of its own.
    const later = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-09-08' });
    runGate(db(), makeHost(), { runId: later.runId, tradingDate: '2026-09-08', domainsExpected: {}, checks: [QC008_PROVIDER_CAP] });

    const state = (id: number) =>
      raw.prepare("SELECT state, resolution_kind FROM qa_exception WHERE check_id = 'QC-008' AND key = ?").get(String(id));
    expect(state(window)).toEqual({ state: 'resolved', resolution_kind: 'rule_changed' });
    expect(state(fund)).toEqual({ state: 'resolved', resolution_kind: 'rule_changed' });
    // Whether JPM's list reached far enough is in the archived body, which a check cannot read.
    expect(state(stock)).toEqual({ state: 'open', resolution_kind: null });
  });

  it('stops subdividing at a single day and leaves the cap recorded', async () => {
    // A one-day slice cannot be split further. The rows are kept and the cap
    // stays on the response row: knowing the answer is incomplete beats
    // believing it, and beats looping forever.
    const host = makeHost({
      httpGet: async () =>
        response(earningsBody(Array.from({ length: 1500 }, () => ({ symbol: 'A', date: DATE }))))
    });
    const leafRun = newRun();
    const result = await runEarningsSweep(host, db(), leafRun, { windowDays: 2, sliceDays: 2 });
    expect(result.calls).toBeLessThan(10);
    // A capped single day could not be re-covered, so QC-008 still blocks on it.
    const qc008 = QC008_PROVIDER_CAP.run({ db: db(), runId: leafRun.runId, tradingDate: DATE, observedAt: OBSERVED });
    expect(qc008.some((e) => e.fired)).toBe(true);
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

  it('does not read a quarter and its year-to-date as one fact (QC-009)', () => {
    // A 10-Q reports Revenues for the quarter AND the six months to date: same end,
    // same filing, same fp, different start. 1,641 of these read as duplicates on
    // 2026-09-16 because period_start was not part of the natural key.
    const quarterAndYtd = JSON.stringify({
      facts: {
        'us-gaap': {
          Revenues: {
            units: {
              USD: [
                { start: '2026-04-01', end: '2026-06-28', val: 85_000_000_000, accn: '0000320193-26-000106', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-08-01' },
                { start: '2025-12-28', end: '2026-06-28', val: 210_000_000_000, accn: '0000320193-26-000106', fy: 2026, fp: 'Q3', form: '10-Q', filed: '2026-08-01' }
              ]
            }
          }
        }
      }
    });
    const run = newRun();
    const result = captureResponse({
      host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
      endpoint: '/api/xbrl/companyfacts/CIK0000320193.json', slug: 'companyfacts', params: { cik: '0000320193' },
      response: response(quarterAndYtd), captureRuleId: ruleId(),
      recipe: recipes.companyFacts({ cik: '0000320193' })
    });
    expect(result.rowsWritten).toBe(2);
    const edgar = QC009_DUPLICATE_NATURAL_KEY.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: OBSERVED })
      .find((e) => e.key === 'raw_edgar_fact');
    expect(edgar?.fired).toBe(false);

    // meta_dictionary keeps every version. On 2026-09-16 the check read them all, so a
    // superseded key without period_start would have kept firing after the key was fixed.
    // Copy the current version's rows as version N-1, from the live column list.
    const cols = (raw.prepare('PRAGMA table_info(meta_dictionary)').all() as { name: string }[]).map((c) => c.name);
    const select = cols.map((c) => (c === 'dictionary_version' ? 'dictionary_version - 1' : `"${c}"`)).join(', ');
    raw.exec(
      `INSERT INTO meta_dictionary (${cols.map((c) => `"${c}"`).join(', ')})
         SELECT ${select} FROM meta_dictionary
          WHERE table_name = 'raw_edgar_fact' AND dictionary_version = (SELECT MAX(dictionary_version) FROM meta_dictionary)`
    );
    raw.exec(
      `UPDATE meta_dictionary SET natural_key = '["cik","taxonomy","concept","unit","period_end","fiscal_period","accession_no","observed_at"]'
        WHERE table_name = 'raw_edgar_fact' AND dictionary_version < (SELECT MAX(dictionary_version) FROM meta_dictionary)`
    );
    const again = QC009_DUPLICATE_NATURAL_KEY.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: OBSERVED })
      .filter((e) => e.key === 'raw_edgar_fact');
    expect(again.map((e) => e.fired)).toEqual([false]);
  });

  it('does not treat two responses returning one key as an idempotence bug (QC-009)', async () => {
    // A capped Finnhub window stores its rows, then its uncapped halves store them again:
    // 330 raw_earnings_event and 322 raw_analyst_estimate "duplicates" on 2026-09-16, each
    // one the subdivision QC-008 requires.
    const run = newRun();
    for (const [from, to] of [['2026-09-07', '2026-09-20'], ['2026-09-07', '2026-09-13']]) {
      captureResponse({
        host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'finnhub',
        endpoint: '/calendar/earnings', slug: 'calendar-earnings', params: { from: from!, to: to! },
        response: response(earningsBody([{ symbol: 'NVDA', date: '2026-09-10' }])), captureRuleId: ruleId(),
        recipe: recipes.earnings({ sweepFrom: from!, sweepTo: to!, universe: new Set(['NVDA']) })
      });
    }
    const stored = raw.prepare("SELECT COUNT(*) AS n FROM raw_earnings_event WHERE ticker = 'NVDA'").get() as { n: number };
    expect(stored.n).toBe(2);
    const e = QC009_DUPLICATE_NATURAL_KEY.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: OBSERVED })
      .find((x) => x.key === 'raw_earnings_event');
    expect(e?.fired).toBe(false);
  });

  it('re-judges its open findings: a per-run artefact and a redefined key close, a real duplicate stays (v1.1.284)', () => {
    const earlier = newRun();
    // Two windows of one sweep storing one key — the first rule's "duplicate".
    for (const [from, to] of [['2026-09-07', '2026-09-20'], ['2026-09-07', '2026-09-13']]) {
      captureResponse({
        host: makeHost(), db: db(), runId: earlier.runId, asOfDate: DATE, provider: 'finnhub',
        endpoint: '/calendar/earnings', slug: 'calendar-earnings', params: { from: from!, to: to! },
        response: response(earningsBody([{ symbol: 'NVDA', date: '2026-09-10' }])), captureRuleId: ruleId(),
        recipe: recipes.earnings({ sweepFrom: from!, sweepTo: to!, universe: new Set(['NVDA']) })
      });
    }
    // Finnhub sending XOM's July period twice in ONE response (gen-002, 2026-09-14): a real duplicate.
    const period = { symbol: 'XOM', period: '2026-07-01', strongBuy: 7, buy: 9, hold: 13, sell: 1, strongSell: 0 };
    captureResponse({
      host: makeHost(), db: db(), runId: earlier.runId, asOfDate: DATE, provider: 'finnhub',
      endpoint: '/stock/recommendation', slug: 'recommendation', params: { symbol: 'XOM' },
      response: response(JSON.stringify([period, period])), captureRuleId: ruleId(),
      recipe: recipes.recommendations({ ticker: 'XOM' })
    });
    // The Form 4 finding was raised when the table's key was (accession, date, filer, code): record
    // that key as the dictionary of the run that raised it.
    const cols = (raw.prepare('PRAGMA table_info(meta_dictionary)').all() as { name: string }[]).map((c) => c.name);
    const older = (raw.prepare('SELECT MAX(dictionary_version) AS v FROM meta_dictionary').get() as { v: number }).v - 1;
    raw.exec(
      `INSERT INTO meta_dictionary (${cols.map((c) => `"${c}"`).join(', ')})
         SELECT ${cols.map((c) => (c === 'dictionary_version' ? String(older) : `"${c}"`)).join(', ')} FROM meta_dictionary
          WHERE table_name = 'raw_insider_transaction' AND dictionary_version = ${older + 1}`
    );
    raw.prepare(`UPDATE meta_dictionary SET natural_key = ? WHERE table_name = 'raw_insider_transaction' AND dictionary_version = ?`)
      .run(JSON.stringify(['accession_no', 'transaction_date', 'filer_name', 'transaction_code']), older);
    raw.prepare('UPDATE meta_run SET dictionary_version = ? WHERE run_id = ?').run(older, earlier.runId);

    runGate(db(), makeHost(), {
      runId: earlier.runId, tradingDate: DATE, domainsExpected: {},
      checks: [{
        ...QC009_DUPLICATE_NATURAL_KEY,
        run: () => ['raw_earnings_event', 'raw_analyst_recommendation', 'raw_insider_transaction']
          .map((key) => ({ key, fired: true, detail: 'duplicates' }))
      }]
    });
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(earlier.runId);

    const later = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-09-08' });
    runGate(db(), makeHost(), { runId: later.runId, tradingDate: '2026-09-08', domainsExpected: {}, checks: [QC009_DUPLICATE_NATURAL_KEY] });

    const rows = Object.fromEntries(
      (raw.prepare("SELECT key, state, resolution_kind, resolution_note FROM qa_exception WHERE check_id = 'QC-009'").all() as
        { key: string; state: string; resolution_kind: string | null; resolution_note: string | null }[]).map((r) => [r.key, r])
    );
    expect(rows['raw_earnings_event']!.resolution_kind).toBe('rule_changed');
    expect(rows['raw_insider_transaction']!.resolution_kind).toBe('rule_changed');
    expect(rows['raw_insider_transaction']!.resolution_note).toContain('["accession_no","line_no"]');
    // Stopped firing (the later run stored nothing), but its own run still holds the duplicate.
    expect(rows['raw_analyst_recommendation']!.state).toBe('open');
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

  it('excludes derivative transactions under the pre-v20 recipe, so old responses replay identically', () => {
    // NOT dead behaviour: this is what a Form 4 captured before dictionary v20
    // must still parse to. Its stored recipe has no `derivatives` key, so
    // `parseStoredRecipe` rebuilds the parser without it and the replay
    // reproduces exactly the rows stored then (AC-4/QC-951). A parser that
    // silently produced more rows than are stored would report every earlier
    // day as unrebuildable.
    expect(parse().every((r) => r.values['shares'] !== 99999)).toBe(true);
    expect(parse()).toHaveLength(2);
    // The column did not exist then, so the legacy path must write null, not
    // 'non_derivative' — a replay compares values, not intent.
    expect(parse().every((r) => r.values['security_class'] === null)).toBe(true);
  });

  it('captures both classes when the recipe says so, marking which is which (v1.1.305)', () => {
    // QC-906 reads "a fetched Form 4 yielded no rows" as a schema change, and
    // with derivative-only filings dropped the benign case dominated: it fired
    // on 2 of the 2 runs that ever had data and never once passed. All 11
    // filings it named on 2026-09-21 were correct Form 4s with only derivative
    // transactions (AMCR, AUGO, BILL, CTAS).
    const rows = makeForm4Ingest({ accessionNo: 'x', derivatives: true })(FORM4, ctx(newRun()));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.values['security_class'], r.values['shares']])).toEqual([
      ['non_derivative', 20534],
      ['non_derivative', 500],
      ['derivative', 99999]
    ]);
  });

  it('numbers derivative lines AFTER the non-derivative ones, so no pre-v20 line moves', () => {
    // `(accession_no, line_no)` is the natural key. Numbering the derivative
    // section first — or interleaving — would renumber rows already stored and
    // collide with them.
    const rows = makeForm4Ingest({ accessionNo: 'x', derivatives: true })(FORM4, ctx(newRun()));
    expect(rows.map((r) => r.values['line_no'])).toEqual([1, 2, 3]);
    const legacy = parse().map((r) => r.values['line_no']);
    expect(rows.slice(0, legacy.length).map((r) => r.values['line_no'])).toEqual(legacy);
  });

  it('a derivative-only filing yields rows now, which is what makes QC-906 mean what it says', () => {
    // The real shape: BILL Holdings 0001795497-26-000006, one derivative
    // transaction and no non-derivative section at all.
    const derivativeOnly = FORM4.replace(/<nonDerivativeTransaction>[\s\S]*<\/nonDerivativeTransaction>/, '');
    expect(makeForm4Ingest({ accessionNo: 'x' })(derivativeOnly, ctx(newRun()))).toHaveLength(0);
    const rows = makeForm4Ingest({ accessionNo: 'x', derivatives: true })(derivativeOnly, ctx(newRun()));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values['security_class']).toBe('derivative');
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

  it('numbers each line as the filing does, so same-day lots are distinct facts (v1.1.284)', () => {
    // Japan Post, AFL, 2026-09-14: two sales on one day at different prices. The old key
    // (accession, date, filer, code) could not tell them apart and QC-009 read 39 such pairs as
    // duplicates. The number is counted before a line is skipped, so it is the filing's own.
    const lot = (shares: string, price: string, after: string) => `
  <nonDerivativeTransaction>
    <transactionDate><value>2026-09-14</value></transactionDate>
    <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
    <transactionAmounts>
      <transactionShares><value>${shares}</value></transactionShares>
      <transactionPricePerShare><value>${price}</value></transactionPricePerShare>
    </transactionAmounts>
    <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${after}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
  </nonDerivativeTransaction>`;
    const doc = FORM4.replace(
      /<nonDerivativeTransaction>[\s\S]*<\/nonDerivativeTransaction>/,
      lot('9545', '116.62', '50588645') + lot('', '116.80', '50588645') + lot('4055', '117.02', '50584590')
    );
    const rows = makeForm4Ingest({ accessionNo: '0001104659-26-108107' })(doc, ctx(newRun()));
    // The middle line has no share count and is skipped; the third keeps its number.
    expect(rows.map((r) => [r.values['line_no'], r.values['shares']])).toEqual([[1, 9545], [3, 4055]]);
    expect(INSIDER_KEY()).toEqual(['accession_no', 'line_no']);
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
  ticker: string; date: string; observedAt: string; source?: string; runId?: number; asOf?: string;
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
    stmt.run(
      r.runId ?? fixtureRun.runId, r.asOf ?? DATE, r.observedAt, rule, fixtureResponseId(),
      r.ticker, r.date, r.source ?? 'finnhub'
    );
  }
}

describe('QC-604, report dates on non-trading days', () => {
  // Threw `no such column: trade_date` on every run until v1.1.251 — the calendar's
  // column is `date` — and a check that throws is recorded as a blocking finding,
  // so it never once evaluated. This runs against the real dictionary schema and
  // the real calendar seeder, which is what would have caught it.
  it('runs against the seeded calendar and flags a weekend and a holiday, not a session', () => {
    ensureTradingCalendar(db(), makeHost(), DATE);
    insertEarnings([
      { ticker: 'AAA', date: '2026-09-17', observedAt: OBSERVED }, // Thursday session
      { ticker: 'BBB', date: '2026-09-19', observedAt: OBSERVED }, // Saturday (the UTC artefact)
      { ticker: 'CCC', date: '2026-11-26', observedAt: OBSERVED }  // Thanksgiving — only the calendar knows
    ]);
    const evals = QC604_EARNINGS_WEEKEND_DATE.run({ db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED });
    expect(evals).toHaveLength(1);
    expect(evals[0]!.fired).toBe(true);
    expect(evals[0]!.value).toBeCloseTo(2 / 3);
    const sample = (evals[0]!.evidence as { sample: string[] }).sample;
    expect(sample.map((x) => x.split(' ')[0]).sort()).toEqual(['BBB', 'CCC']);
  });
});

describe('QC-601, the earnings truncation signature', () => {
  /**
   * The tested quantity is the NEAREST FUTURE date per sweep, so every fixture
   * here spans two runs. The previous shape — two rows, one run, one per
   * "observation" — was written from the check's own assumption that a sweep
   * writes one row per ticker, and that is exactly what made the bug invisible:
   * the real sweep is subdivided into windows and writes one row per window.
   */
  const SWEEP_1 = '2026-09-01T17:00:00-04:00';
  const SWEEP_2 = '2026-09-07T17:00:00-04:00';

  /**
   * Two sweeps. `beginRun` RESUMES a run that is still running on the same
   * trading date, slot and kind, so a second `newRun()` hands back the fixture's
   * own run and the check sees one sweep where the test meant two. The later
   * sweep is a different trading date, which is also the real case.
   */
  function sweeps(nextDate = '2026-09-08'): { prev: number; next: number; nextAsOf: string } {
    return {
      prev: fixtureRun.runId,
      next: beginRun(db(), makeHost(), { kind: 'daily', tradingDate: nextDate }).runId,
      nextAsOf: nextDate
    };
  }

  it('fires when the nearest future date slips more than 14 days later', () => {
    // The NVDA case: the real report replaced by the next quarter's, from a
    // response sitting at the provider's row cap.
    const { prev, next, nextAsOf } = sweeps();
    insertEarnings([
      { ticker: 'NVDA', date: '2026-09-25', observedAt: SWEEP_1, runId: prev },
      { ticker: 'NVDA', date: '2026-12-17', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    expect(gate([QC601_EARNINGS_SLIPS_LATER]).blocking).toBe(1);
  });

  it('does NOT fire on two windows of the SAME sweep', () => {
    // The regression. MU has two real reports inside the 90-day horizon, and the
    // sweep is subdivided because the bulk calendar truncates at its row cap, so
    // ONE run writes both: 2026-09-30 from the near window and 2026-12-15 from
    // the far one, 409 ms apart. Read as successive observations that was a
    // 76-day slip on entirely correct data — seven of the eight findings on
    // 2026-09-17, and it grows as a quarter-end pulls more second reports in.
    const { prev, next, nextAsOf } = sweeps();
    insertEarnings([
      { ticker: 'MU', date: '2026-09-30', observedAt: SWEEP_1, runId: prev },
      { ticker: 'MU', date: '2026-09-30', observedAt: '2026-09-08T19:00:12.615-04:00', runId: next, asOf: nextAsOf },
      { ticker: 'MU', date: '2026-12-15', observedAt: '2026-09-08T19:00:13.024-04:00', runId: next, asOf: nextAsOf }
    ]);
    expect(gate([QC601_EARNINGS_SLIPS_LATER]).blocking).toBe(0);
  });

  it('does not fire when the date rolls because the issuer has already reported', () => {
    // GIS reported 2026-09-15 and the calendar rolled to 2026-12-15 two days
    // later. The previous nearest is in the PAST as of this sweep: the calendar
    // working, not a slip. Still evaluated — clamped to 0, never dropped.
    const { prev, next, nextAsOf } = sweeps('2026-09-14');
    insertEarnings([
      { ticker: 'GIS', date: '2026-09-10', observedAt: SWEEP_1, runId: prev, asOf: DATE },
      { ticker: 'GIS', date: '2026-12-15', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    const evals = QC601_EARNINGS_SLIPS_LATER.run({
      db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED
    });
    expect(evals).toHaveLength(1);
    expect(evals[0]!.fired).toBe(false);
    expect(evals[0]!.value).toBe(0);
  });

  it('closes a finding the first rule raised when no sweep pair in its runs slipped, and keeps a real slip (v1.1.283)', () => {
    // AZO on gen-002: nearest date 2026-09-22 in every sweep, yet a finding "09-22 -> 12-07" from the
    // first rule reading two windows of one sweep. It sat open, because the current rule compares
    // only the latest two sweeps and never looks at it again.
    const s2 = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-09-08' });
    insertEarnings([
      { ticker: 'AZO', date: '2026-09-22', observedAt: SWEEP_1 },
      { ticker: 'AZO', date: '2026-09-22', observedAt: SWEEP_2, runId: s2.runId, asOf: '2026-09-08' },
      { ticker: 'AZO', date: '2026-12-07', observedAt: SWEEP_2, runId: s2.runId, asOf: '2026-09-08' },
      { ticker: 'NVDA', date: '2026-09-25', observedAt: SWEEP_1 },
      { ticker: 'NVDA', date: '2026-12-17', observedAt: SWEEP_2, runId: s2.runId, asOf: '2026-09-08' }
    ]);
    runGate(db(), makeHost(), {
      runId: s2.runId, tradingDate: '2026-09-08', domainsExpected: {},
      checks: [{
        ...QC601_EARNINGS_SLIPS_LATER,
        run: () => ['AZO:finnhub', 'NVDA:finnhub'].map((key) => ({ key, value: 76, fired: true, detail: 'slip' }))
      }]
    });

    // A third sweep that changes nothing: today's rule has no pair to report for either ticker.
    const s3 = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-09-09' });
    insertEarnings([
      { ticker: 'AZO', date: '2026-09-22', observedAt: '2026-09-09T17:00:00-04:00', runId: s3.runId, asOf: '2026-09-09' },
      { ticker: 'NVDA', date: '2026-12-17', observedAt: '2026-09-09T17:00:00-04:00', runId: s3.runId, asOf: '2026-09-09' }
    ]);
    runGate(db(), makeHost(), { runId: s3.runId, tradingDate: '2026-09-09', domainsExpected: {}, checks: [QC601_EARNINGS_SLIPS_LATER] });

    const rows = Object.fromEntries(
      (raw.prepare("SELECT key, state, resolution_kind FROM qa_exception WHERE check_id = 'QC-601'").all() as
        { key: string; state: string; resolution_kind: string | null }[]).map((r) => [r.key, r.resolution_kind ?? r.state])
    );
    expect(rows).toEqual({ 'AZO:finnhub': 'rule_changed', 'NVDA:finnhub': 'open' });
  });

  it('does NOT fire when a date moves nearer, however far', () => {
    // A coverage gap hiding the near date is the common case and the correction
    // is unbounded. The asymmetry is the whole rule.
    const { prev, next, nextAsOf } = sweeps();
    insertEarnings([
      { ticker: 'NVDA', date: '2026-12-17', observedAt: SWEEP_1, runId: prev },
      { ticker: 'NVDA', date: '2026-09-25', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    expect(gate([QC601_EARNINGS_SLIPS_LATER]).blocking).toBe(0);
  });

  it('does not fire on a small later slip an issuer might genuinely make', () => {
    const { prev, next, nextAsOf } = sweeps();
    insertEarnings([
      { ticker: 'NVDA', date: '2026-09-25', observedAt: SWEEP_1, runId: prev },
      { ticker: 'NVDA', date: '2026-10-01', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    expect(gate([QC601_EARNINGS_SLIPS_LATER]).blocking).toBe(0);
  });

  it('does NOT fire when the issuer reported ON the run\'s own date (v1.1.307)', () => {
    // FERG, measured on the real generation. Its FY2026 Q4 sat at 2026-09-22
    // for seven consecutive runs while its FY2026 Q3 at 2026-12-07 sat beside
    // it from run 8. On 2026-09-22 — the day it reported — Finnhub dropped the
    // Q4 row and the nearest became the Q3 date that had been there all along.
    // Nothing was truncated and no date was lost.
    //
    // The excusal was `prev < as_of`, strict, so a date landing exactly on the
    // run's own date was not excused: the check reported 76 DAYS LATER, the
    // single largest slip in the generation and the exact bulk-cap truncation
    // signature, from entirely correct data.
    const { prev, next, nextAsOf } = sweeps('2026-09-22');
    insertEarnings([
      { ticker: 'FERG', date: '2026-09-22', observedAt: SWEEP_1, runId: prev },
      { ticker: 'FERG', date: '2026-12-07', observedAt: SWEEP_1, runId: prev },
      { ticker: 'FERG', date: '2026-12-07', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    expect(gate([QC601_EARNINGS_SLIPS_LATER]).blocking).toBe(0);
  });

  it('still fires when the previous nearest is genuinely in the future', () => {
    // The boundary moved by one day, not away: a date the sweep has NOT reached
    // must still be measured, or the check stops being able to see truncation.
    const { prev, next, nextAsOf } = sweeps('2026-09-22');
    insertEarnings([
      { ticker: 'FERG', date: '2026-09-23', observedAt: SWEEP_1, runId: prev },
      { ticker: 'FERG', date: '2026-12-07', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    expect(gate([QC601_EARNINGS_SLIPS_LATER]).blocking).toBe(1);
  });

  it('records the distribution even on a clean run', () => {
    // P10: a check cannot record fires without the distribution they came from.
    const { prev, next, nextAsOf } = sweeps();
    insertEarnings([
      { ticker: 'NVDA', date: '2026-09-25', observedAt: SWEEP_1, runId: prev },
      { ticker: 'NVDA', date: '2026-10-01', observedAt: SWEEP_2, runId: next, asOf: nextAsOf }
    ]);
    gate([QC601_EARNINGS_SLIPS_LATER]);
    const row = raw
      .prepare("SELECT distribution_json FROM qa_check_result WHERE check_id = 'QC-601'")
      .get() as { distribution_json: string | null } | undefined;
    expect(row?.distribution_json).toBeTruthy();
    expect(JSON.parse(row?.distribution_json as string).n).toBe(1);
  });
});

describe('QC-602, the cross-source comparison that had no second source', () => {
  it('fires when the second source has no rows at all, rather than evaluating nothing', () => {
    // It self-joined on source = 'etrade' and the collector fetches only
    // finnhub, so it evaluated 0 on every daily run of the generation and could
    // not have fired. A vacuous check and a clean one are indistinguishable
    // from their fired count, which is the whole reason this framework records
    // the distribution — so the absence is reported as the finding it is.
    insertEarnings([{ ticker: 'NVDA', date: '2026-09-25', observedAt: OBSERVED, source: 'finnhub' }]);
    const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({
      db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED
    });
    expect(evals).toHaveLength(1);
    expect(evals[0]!.fired).toBe(true);
    expect(evals[0]!.detail).toContain('etrade');
    // Never the threshold's own value: "cannot be compared" must not read as
    // "compared and agreed".
    expect(evals[0]!.value).toBeGreaterThan(
      QC602_EARNINGS_SOURCE_DISAGREEMENT.thresholds['maxDisagreementDays'] as number
    );
  });

  it('compares per ticker once both sources are present', () => {
    insertEarnings([
      { ticker: 'NVDA', date: '2026-09-25', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'NVDA', date: '2026-10-09', observedAt: OBSERVED, source: 'etrade' },
      { ticker: 'AAPL', date: '2026-10-29', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'AAPL', date: '2026-10-29', observedAt: OBSERVED, source: 'etrade' }
    ]);
    const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({
      db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED
    });
    expect(evals).toHaveLength(2);
    expect(evals.filter((e) => e.fired).map((e) => e.key)).toEqual(['NVDA']);
  });

  it('compares the NEAREST future date, not the last row a multi-window sweep wrote', () => {
    // The shape every other test here misses: a sweep is subdivided into windows,
    // so one run writes one row per window per ticker and the LAST row written is
    // the ticker's FARTHEST date. ACN's real 2026-09-21 rows — Finnhub's
    // 2026-10-01 and 2026-12-16 from two windows 204 ms apart — read as
    // "80 days apart" from E*Trade's 2026-09-27 when the real gap is four.
    // QC-601 was fixed for exactly this and QC-602 was not.
    insertEarnings([
      { ticker: 'ACN', date: '2026-10-01', observedAt: '2026-09-21T22:40:26.126Z', source: 'finnhub' },
      { ticker: 'ACN', date: '2026-12-16', observedAt: '2026-09-21T22:40:26.330Z', source: 'finnhub' },
      { ticker: 'ACN', date: '2026-09-27', observedAt: '2026-09-21T22:40:43.739Z', source: 'etrade' }
    ]);
    const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({
      db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED
    });
    expect(evals).toHaveLength(1);
    expect(evals[0]!.value).toBe(4);
    expect(evals[0]!.detail).toContain('finnhub 2026-10-01');
  });

  it('still reads the newest run when a later sweep moves the nearest date', () => {
    // Ranking by run is what makes the nearest-date read a fresh one: an older
    // sweep's nearer date must not outrank the newest sweep's.
    const nextDate = '2026-09-08';
    const newer = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: nextDate }).runId;
    insertEarnings([
      { ticker: 'NVDA', date: '2026-09-25', observedAt: '2026-09-07T22:00:00.000Z', source: 'finnhub' },
      { ticker: 'NVDA', date: '2026-10-09', observedAt: '2026-09-08T22:00:00.000Z', source: 'finnhub', runId: newer, asOf: nextDate },
      { ticker: 'NVDA', date: '2026-10-09', observedAt: '2026-09-08T22:00:01.000Z', source: 'etrade', runId: newer, asOf: nextDate }
    ]);
    const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({
      db: db(), runId: newer, tradingDate: nextDate, observedAt: OBSERVED
    });
    expect(evals).toHaveLength(1);
    expect(evals[0]!.fired).toBe(false);
    expect(evals[0]!.value).toBe(0);
  });

  it('fires when both sources are present but no ticker is dated by both (v1.1.270)', () => {
    // E*Trade is asked mainly for tickers Finnhub did not date, so disjoint coverage is the
    // default shape — and a join over it evaluates nothing.
    insertEarnings([
      { ticker: 'NVDA', date: '2026-09-25', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'SWKS', date: '2026-11-05', observedAt: OBSERVED, source: 'etrade' }
    ]);
    const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({
      db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED
    });
    expect(evals).toHaveLength(1);
    expect(evals[0]!.fired).toBe(true);
    expect(evals[0]!.detail).toContain('no ticker has a future date from finnhub and from this run');
  });

  // v1.1.317. The overlap sample asks each covered ticker about once every eleven weeks, and the
  // check re-compared that one E*Trade row every night — so the consecutive-runs escalation turned
  // AAPL, ABT, ACN and ABBV into blocking findings on ONE observation each.
  const qc602Gate = (runId: number, tradingDate: string) =>
    runGate(db(), makeHost(), { runId, tradingDate, domainsExpected: {}, checks: [QC602_EARNINGS_SOURCE_DISAGREEMENT] });
  const qc602Finding = (key: string) =>
    raw.prepare("SELECT severity, state, still_firing, resolution_kind, resolution_note FROM qa_exception WHERE check_id = 'QC-602' AND key = ?")
      .get(key) as { severity: string; state: string; still_firing: number; resolution_kind: string | null; resolution_note: string | null } | undefined;

  it('compares E*Trade only in the run that fetched it, so one observation cannot escalate', () => {
    insertEarnings([
      { ticker: 'ACN', date: '2026-10-01', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'ACN', date: '2026-09-27', observedAt: OBSERVED, source: 'etrade' }
    ]);
    qc602Gate(fixtureRun.runId, DATE);
    expect(qc602Finding('ACN')).toMatchObject({ severity: 'warning', state: 'open', still_firing: 1 });

    // Four more runs: Finnhub every night, E*Trade never re-asked. The old check fired on each.
    for (const d of ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
      const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: d }).runId;
      insertEarnings([{ ticker: 'ACN', date: '2026-10-01', observedAt: `${d}T22:00:00Z`, source: 'finnhub', runId: run, asOf: d }]);
      const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({ db: db(), runId: run, tradingDate: d, observedAt: OBSERVED });
      expect(evals.some((e) => e.key === 'ACN')).toBe(false);
      qc602Gate(run, d);
    }
    expect(qc602Finding('ACN')).toMatchObject({ severity: 'warning', state: 'open', still_firing: 0 });
  });

  it('does not fire on the two-day gap between two estimates of an unannounced date', () => {
    insertEarnings([
      { ticker: 'AAPL', date: '2026-10-28', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'AAPL', date: '2026-10-30', observedAt: OBSERVED, source: 'etrade' },
      { ticker: 'ACN', date: '2026-10-01', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'ACN', date: '2026-09-27', observedAt: OBSERVED, source: 'etrade' }
    ]);
    const evals = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({ db: db(), runId: fixtureRun.runId, tradingDate: DATE, observedAt: OBSERVED });
    expect(evals.filter((e) => e.fired).map((e) => e.key)).toEqual(['ACN']);
  });

  it('closes findings the old rule raised, on their own evidence, and keeps a real one open', () => {
    insertEarnings([
      { ticker: 'ACN', date: '2026-10-01', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'ACN', date: '2026-09-27', observedAt: OBSERVED, source: 'etrade' },
      { ticker: 'AEP', date: '2026-10-22', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'AEP', date: '2026-11-02', observedAt: OBSERVED, source: 'etrade' },
      { ticker: 'NOW', date: '2026-09-20', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'NOW', date: '2026-09-25', observedAt: OBSERVED, source: 'etrade' }
    ]);
    qc602Gate(fixtureRun.runId, DATE);
    // What the old rule left behind: an escalated finding, and one at a gap today's rule passes.
    raw.exec("UPDATE qa_exception SET severity = 'blocking' WHERE check_id = 'QC-602' AND key = 'ACN'");
    raw.exec(`UPDATE qa_exception SET evidence_json = json_set(evidence_json, '$.gapDays', 2) WHERE check_id = 'QC-602' AND key = 'AEP'`);

    const later = '2026-09-28';
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: later }).runId;
    insertEarnings([{ ticker: 'ACN', date: '2026-10-01', observedAt: `${later}T22:00:00Z`, source: 'finnhub', runId: run, asOf: later }]);
    qc602Gate(run, later);

    expect(qc602Finding('ACN')).toMatchObject({ state: 'resolved', resolution_kind: 'rule_changed' });
    expect(qc602Finding('ACN')!.resolution_note).toContain('re-comparing one E*Trade observation');
    expect(qc602Finding('AEP')).toMatchObject({ state: 'resolved', resolution_kind: 'rule_changed' });
    expect(qc602Finding('AEP')!.resolution_note).toContain('inside the 3-day threshold');
    expect(qc602Finding('NOW')).toMatchObject({ state: 'resolved', resolution_kind: 'rule_changed' });
    expect(qc602Finding('NOW')!.resolution_note).toContain('both report dates have passed');
  });

  it('closes a same-run finding the old threshold raised as rule_changed, not data_corrected', () => {
    // AFL on 2026-09-23: the same two-day gap, judged again under the wider threshold. Nothing
    // was corrected, so the record must not say so.
    insertEarnings([
      { ticker: 'AFL', date: '2026-11-04', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'AFL', date: '2026-11-12', observedAt: OBSERVED, source: 'etrade' }
    ]);
    qc602Gate(fixtureRun.runId, DATE);
    raw.exec(`UPDATE qa_exception SET evidence_json = json_set(evidence_json, '$.gapDays', 2) WHERE check_id = 'QC-602' AND key = 'AFL'`);
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-09-08' }).runId;
    insertEarnings([
      { ticker: 'AFL', date: '2026-11-04', observedAt: '2026-09-08T22:00:00Z', source: 'finnhub', runId: run, asOf: '2026-09-08' },
      { ticker: 'AFL', date: '2026-11-02', observedAt: '2026-09-08T22:00:01Z', source: 'etrade', runId: run, asOf: '2026-09-08' }
    ]);
    qc602Gate(run, '2026-09-08');
    expect(qc602Finding('AFL')).toMatchObject({ state: 'resolved', resolution_kind: 'rule_changed' });
  });

  it('closes the "no comparison possible" finding once a comparison happens (v1.1.323)', () => {
    // Raised 2026-09-18, before E*Trade earnings were collected; nothing could ever close it,
    // because `sources` was only produced firing.
    insertEarnings([{ ticker: 'NVDA', date: '2026-10-09', observedAt: OBSERVED, source: 'finnhub' }]);
    qc602Gate(fixtureRun.runId, DATE);
    expect(qc602Finding('sources')).toMatchObject({ state: 'open', still_firing: 1 });

    const later = '2026-09-08';
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: later }).runId;
    insertEarnings([
      { ticker: 'NVDA', date: '2026-10-09', observedAt: `${later}T22:00:00Z`, source: 'finnhub', runId: run, asOf: later },
      { ticker: 'NVDA', date: '2026-10-09', observedAt: `${later}T22:00:01Z`, source: 'etrade', runId: run, asOf: later }
    ]);
    qc602Gate(run, later);
    expect(qc602Finding('sources')).toMatchObject({ state: 'resolved', resolution_kind: 'data_corrected' });
    expect(qc602Finding('sources')!.resolution_note).toContain('1 ticker compared');

    // With nothing open, a normal run says nothing about `sources` at all.
    const quiet = QC602_EARNINGS_SOURCE_DISAGREEMENT.run({ db: db(), runId: run, tradingDate: later, observedAt: OBSERVED });
    expect(quiet.map((e) => e.key)).toEqual(['NVDA']);
  });

  it('leaves a real, still-future disagreement at base severity open until E*Trade is asked again', () => {
    insertEarnings([
      { ticker: 'AEP', date: '2026-10-22', observedAt: OBSERVED, source: 'finnhub' },
      { ticker: 'AEP', date: '2026-11-02', observedAt: OBSERVED, source: 'etrade' }
    ]);
    qc602Gate(fixtureRun.runId, DATE);
    const later = '2026-09-08';
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: later }).runId;
    insertEarnings([{ ticker: 'AEP', date: '2026-10-22', observedAt: `${later}T22:00:00Z`, source: 'finnhub', runId: run, asOf: later }]);
    qc602Gate(run, later);
    expect(qc602Finding('AEP')).toMatchObject({ severity: 'warning', state: 'open', still_firing: 0 });

    // Re-asked, now agreeing: new data settles it.
    const again = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: '2026-09-09' }).runId;
    insertEarnings([
      { ticker: 'AEP', date: '2026-10-22', observedAt: '2026-09-09T22:00:00Z', source: 'finnhub', runId: again, asOf: '2026-09-09' },
      { ticker: 'AEP', date: '2026-10-22', observedAt: '2026-09-09T22:00:01Z', source: 'etrade', runId: again, asOf: '2026-09-09' }
    ]);
    qc602Gate(again, '2026-09-09');
    expect(qc602Finding('AEP')).toMatchObject({ state: 'resolved', resolution_kind: 'data_corrected' });
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
