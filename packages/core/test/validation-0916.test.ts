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
import { runInsiderSweep } from '../src/collector/phases/events.js';
import { QC603_EARNINGS_FRESHNESS } from '../src/qa/checks/earnings-fundamentals.js';
import { runGate } from '../src/qa/gate.js';
import { QC905_RECOMMENDATION_FRESHNESS, QC909_RECOMMENDATION_SYMBOL_MISMATCH } from '../src/qa/checks/macro.js';
import { ensureSymbolRulings, refusedSymbolAnswers, refusedFor, DEFAULT_SYMBOL_RULINGS } from '../src/collector/symbol-rulings.js';
import { makeRecommendationIngest } from '../src/ingest/events.js';
import { recipeDigest } from '../src/ingest/recipes.js';

/**
 * Faults found rehearsing the 2026-09-16 gate on a snapshot of the real generation (v1.1.257).
 * Every fixture goes through `captureResponse` with the real recipe, into the real dictionary
 * schema, so the tests read what ingestion actually writes.
 */

let dir: string;
let raw: Database.Database;
let run: RunHandle;
const DATE = '2026-09-16';

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

function capture(provider: 'polygon' | 'finnhub', endpoint: string, params: Record<string, string>, body: string, recipe: ReturnType<typeof recipes.snapshot>) {
  const r = captureResponse({
    host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider, endpoint,
    slug: endpoint.replace(/\W+/g, '-'), params, response: response(body),
    captureRuleId: captureRuleId(db(), makeHost(), provider, { v: 1 }, 'test'), recipe
  });
  expect(r.parseStatus, JSON.stringify(r)).toBe('ok');
}

function reference(ticker: string, type: string, listDate?: string, cik?: string) {
  capture('polygon', `/v3/reference/tickers/${ticker}`, { ticker }, JSON.stringify({
    results: {
      ticker, name: ticker, type, weighted_shares_outstanding: 1_000_000,
      ...(listDate ? { list_date: listDate } : {}), ...(cik ? { cik } : {})
    }
  }), recipes.tickerReference());
}

/** One report filing for `cik`, stored the way the submissions sweep stores it. */
function filing(cik: string, ticker: string, form: string, filed: string) {
  const r = captureResponse({
    host: makeHost(), db: db(), runId: run.runId, asOfDate: DATE, provider: 'edgar',
    endpoint: '/submissions/CIK{cik}.json', slug: `sub-${ticker}-${filed}`, params: { cik, ticker, filed },
    response: response(JSON.stringify({ filings: { recent: {
      accessionNumber: [`${cik}-${filed}`], form: [form], filingDate: [filed], reportDate: [''], primaryDocument: ['x.htm']
    } } })),
    captureRuleId: captureRuleId(db(), makeHost(), 'edgar', { v: 1 }, 'test'),
    recipe: recipes.submissions({ cik, ticker, forms: new Set(['10-K', '10-Q']) })
  });
  expect(r.parseStatus, JSON.stringify(r)).toBe('ok');
}

function member(ticker: string, admitted: string) {
  raw.prepare(
    `INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, http_status, byte_length,
       archive_file, archive_offset, sha256, dedup_hash, encrypted, at_provider_cap, parse_status, parsed_row_count)
     VALUES (?, 'polygon', '/x', '{}', ?, 200, 1, 'f', 0, 'h', ?, 0, 0, 'ok', 0)`
  ).run(run.runId, `${admitted}T22:00:00Z`, `subset-${ticker}-${admitted}`);
  const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
  const rule = captureRuleId(db(), makeHost(), 'chain_subset', { v: 1 }, 'test');
  raw.prepare(
    `INSERT INTO ref_chain_subset_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
       ticker, valid_from, membership_reason, rule_capture_rule_id, rule_inputs_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'rule_pass', ?, '{}')`
  ).run(run.runId, admitted, `${admitted}T17:00:00-04:00`, rule, src, ticker, admitted, rule);
}

function earnings(ticker: string, date: string) {
  capture('finnhub', '/calendar/earnings', { from: date, to: date, t: ticker }, JSON.stringify({
    earningsCalendar: [{ symbol: ticker, date, hour: 'amc', year: 2026, quarter: 3 }]
  }), recipes.earnings({ sweepFrom: date, sweepTo: date }));
}

function recommendations(asked: string, answered: string) {
  capture('finnhub', '/stock/recommendation', { symbol: asked }, JSON.stringify([
    { symbol: answered, period: '2026-09-01', strongBuy: 10, buy: 5, hold: 2, sell: 0, strongSell: 0 }
  ]), recipes.recommendations({ ticker: asked }));
}

const ctx = () => ({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-0916-'));
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

describe('the insider sweep when today\'s index is not published yet', () => {
  it('falls back to the previous session on a 403, which SEC now sends instead of a 404', async () => {
    // Measured 2026-09-16 with a declared User-Agent: form.20260915.idx 200, form.20260916.idx 403
    // (215-byte AccessDenied). Every run 2026-09-14..16 got the 403, and no Form 4 was ever stored.
    ensureTradingCalendar(db(), makeHost(), DATE);
    const asked: string[] = [];
    const host = makeHost({
      httpGet: async (url: string) => {
        asked.push(url);
        return url.endsWith('form.20260916.idx')
          ? response('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', 403)
          : response('Form Type   Company Name   CIK   Date Filed   File Name\n');
      }
    });
    const result = await runInsiderSweep(host, db(), run);
    // Oldest first since v1.1.268: the sweep walks from the last parsed index, and
    // on a generation with none that is the previous session, then today.
    expect(asked.map((u) => u.slice(-17))).toEqual(['form.20260915.idx', 'form.20260916.idx']);
    expect(result.failed).toBe(0);
    const params = raw.prepare("SELECT params_json FROM meta_response WHERE endpoint LIKE '%form.idx%'").get() as { params_json: string };
    expect(JSON.parse(params.params_json)).toEqual({ date: '2026-09-15' });
  });
});

describe('Finnhub recommendations are filed under the ticker we asked for', () => {
  it('keeps the asked ticker and records the provider\'s symbol beside it', () => {
    recommendations('GOOG', 'GOOGL');
    const row = raw.prepare('SELECT ticker, provider_symbol FROM raw_analyst_recommendation').get();
    expect(row).toEqual({ ticker: 'GOOG', provider_symbol: 'GOOGL' });
  });

  it('QC-909 reports an answer for another listing, and only that', () => {
    // LLYVA came back as FWONA on 2026-09-14 — a different company.
    recommendations('LLYVA', 'FWONA');
    recommendations('NVDA', 'NVDA');
    const fired = QC909_RECOMMENDATION_SYMBOL_MISMATCH.run(ctx()).filter((e) => e.fired);
    expect(fired.map((e) => e.key)).toEqual(['LLYVA']);
    expect(fired[0]!.detail).toContain('FWONA');
  });

  it('QC-909 stops firing on a pairing the operator has ruled (v1.1.306)', () => {
    // A standing answer is not an open question, and leaving the ruled ones in
    // made the unruled ones harder to see — which is the point of the check.
    // GOOG → GOOGL is ruled; SWKS → SWKS.XX is not and must still fire.
    recommendations('GOOG', 'GOOGL');
    recommendations('SWKS', 'SWKS.XX');
    ensureSymbolRulings(db(), makeHost(), [
      { provider: 'finnhub', askedTicker: 'GOOG', answeredSymbol: 'GOOGL', decision: 'same_issuer', note: 'Alphabet C and A.' }
    ]);
    const evals = QC909_RECOMMENDATION_SYMBOL_MISMATCH.run(ctx());
    expect(evals.filter((e) => e.fired).map((e) => e.key)).toEqual(['SWKS']);
    // Ruled, so it closes as a rule change and says which ruling settled it.
    const goog = evals.find((e) => e.key === 'GOOG');
    expect(goog?.fired).toBe(false);
    expect(goog?.closesAs?.kind).toBe('rule_changed');
  });

  it('the seed is idempotent and never overwrites a ruling already there', () => {
    // An operator who changes their mind in the workbench keeps that change
    // across runs — the same rule ref_trading_day uses for the one closure no
    // generator can produce.
    const first = ensureSymbolRulings(db(), makeHost());
    expect(first.inserted).toBe(DEFAULT_SYMBOL_RULINGS.length);
    const second = ensureSymbolRulings(db(), makeHost());
    expect(second.inserted).toBe(0);
    expect(second.present).toBe(DEFAULT_SYMBOL_RULINGS.length);
    // Both Liberty Live classes are refused; FWONA is Liberty Media Formula One.
    const refusals = refusedSymbolAnswers(db());
    expect([...(refusedFor(refusals, 'finnhub', 'LLYVA') ?? [])]).toEqual(['FWONA']);
    expect([...(refusedFor(refusals, 'finnhub', 'LLYVK') ?? [])]).toEqual(['FWONA']);
    // A same-issuer ruling is not a refusal.
    expect(refusedFor(refusals, 'finnhub', 'GOOG')).toBeUndefined();
  });

  it('a ruled different issuer writes no row, so the ticker reads as uncovered rather than wrong', () => {
    // The alternative is LLYVA and LLYVK quietly carrying FWONA's ratings —
    // identical counts under two tickers that are not that company.
    const body = JSON.stringify([{ symbol: 'FWONA', period: '2026-09-01', strongBuy: 6, buy: 11, hold: 1, sell: 0, strongSell: 0 }]);
    const ictx = { runId: run.runId, asOfDate: DATE, observedAt: 't', captureRuleId: null };
    expect(makeRecommendationIngest({ ticker: 'LLYVA', refusedSymbols: ['FWONA'] })(body, ictx)).toHaveLength(0);
    // Unruled is STORED and reported — dropping a row on no evidence would hide
    // a feed gap behind silence.
    expect(makeRecommendationIngest({ ticker: 'LLYVA' })(body, ictx)).toHaveLength(1);
  });

  it('the refusal rides in the recipe, so a pre-ruling response replays unchanged', () => {
    // A parser that stores FEWER rows breaks replay equality (AC-4/QC-951)
    // exactly as one storing more does. A ruling made today must not
    // retroactively change what last week's response parsed to.
    const plain = recipes.recommendations({ ticker: 'LLYVA' });
    const ruled = recipes.recommendations({ ticker: 'LLYVA', refusedSymbols: new Set(['FWONA']) });
    expect(Object.keys(plain.args)).not.toContain('refusedSymbols');
    expect(recipes.recommendations({ ticker: 'LLYVA', refusedSymbols: new Set() }).args).toEqual(plain.args);
    expect(recipeDigest(plain)).not.toBe(recipeDigest(ruled));
  });
});

describe('QC-603 and QC-905 — funds, recent reports and recent admissions', () => {
  it('QC-603 skips funds and a ticker that just reported, and still fires on an uncovered stock', () => {
    // 2026-09-16: 47 of 68 findings were ETFs; GIS and FPS reported 9/15, next dates past the window.
    for (const [t, type] of [['SPY', 'ETF'], ['GLD', 'ETV'], ['GIS', 'CS'], ['SWKS', 'CS'], ['NVDA', 'CS']] as const) {
      reference(t, type);
      member(t, '2026-09-01');
    }
    earnings('GIS', '2026-09-15');
    earnings('NVDA', '2026-11-18');
    const evals = QC603_EARNINGS_FRESHNESS.run(ctx());
    expect(evals.map((e) => e.key).sort()).toEqual(['GIS', 'NVDA', 'SWKS']);
    expect(evals.filter((e) => e.fired).map((e) => e.key)).toEqual(['SWKS']);
  });

  it('QC-603 does not fire on a new listing whose first report is not yet due, and does once it is (v1.1.274)', () => {
    // Listing dates from gen-002 on 2026-09-18, measured against DATE (2026-09-16).
    reference('HONA', 'CS', '2026-06-15'); // 93 days: first report not due — quiet
    reference('CBRS', 'CS', '2026-05-14'); // 125 days: still inside 135 — quiet
    reference('SUNB', 'CS', '2026-03-02'); // 198 days: should have reported by now — fires
    reference('SWKS', 'CS', '1972-06-01'); // an old listing Finnhub does not date — fires
    reference('NOLD', 'CS');               // no listing date at all: nothing to excuse it — fires
    for (const t of ['HONA', 'CBRS', 'SUNB', 'SWKS', 'NOLD']) member(t, '2026-09-01');
    const byKey = new Map(QC603_EARNINGS_FRESHNESS.run(ctx()).map((e) => [e.key, e]));
    expect([...byKey].filter(([, e]) => e.fired).map(([k]) => k).sort()).toEqual(['NOLD', 'SUNB', 'SWKS']);
    expect(byKey.get('HONA')?.evidence?.['newlyListed']).toBe(true);
  });

  it('QC-603 does not fire on a stock whose last report was filed with the SEC within 60 days (v1.1.330)', () => {
    // 2026-09-27: IOT (10-Q 09-08), JHX (08-06) and JAN (08-05) had no date from any source, because
    // their next results were not announced yet, and the just-reported grace could not see a report the
    // calendar never listed. DATE is 2026-09-16.
    reference('IOT', 'CS', '2021-12-15', '0001642896');
    reference('OLD', 'CS', '2010-01-01', '0000000002');
    reference('NOF', 'CS', '2010-01-01', '0000000003');
    for (const t of ['IOT', 'OLD', 'NOF']) member(t, '2026-09-01');
    filing('0001642896', 'IOT', '10-Q', '2026-09-08');   // 8 days: quiet
    filing('0000000002', 'OLD', '10-Q', '2026-06-10');   // 98 days: the next report is due — fires
    filing('0000000002', 'OLD', '8-K', '2026-09-10');    // an 8-K is not a report filing
    // NOF has no filing at all — fires, as before
    const byKey = new Map(QC603_EARNINGS_FRESHNESS.run(ctx()).map((e) => [e.key, e]));
    expect(byKey.get('IOT')).toMatchObject({ fired: false, value: 0 });
    expect(byKey.get('IOT')!.evidence).toMatchObject({ recentFiling: true, lastReportFiling: '2026-09-08' });
    expect(byKey.get('IOT')!.closesAs).toMatchObject({ kind: 'rule_changed' });
    expect(byKey.get('IOT')!.closesAs!.note).toContain('2026-09-08');
    expect(byKey.get('OLD')!.fired).toBe(true);
    expect(byKey.get('NOF')!.fired).toBe(true);
  });

  it('QC-603 takes a date from a share class ruled the same issuer, never from a different one (v1.1.321)', () => {
    // 2026-09-23: Finnhub dated GOOGL 10-27 and NWSA 11-04, never GOOG or NWS; LLYVA is answered
    // for FWONA, which the operator ruled a DIFFERENT issuer.
    const rule = raw.prepare(
      `INSERT INTO ref_provider_symbol_ruling (provider, asked_ticker, answered_symbol, decision, note, ruled_at, ruled_by)
       VALUES ('finnhub', ?, ?, ?, 'test', '2026-09-21T12:00:00-04:00', 'operator')`
    );
    rule.run('GOOG', 'GOOGL', 'same_issuer');
    rule.run('NWS', 'NWSA', 'same_issuer');
    rule.run('LLYVA', 'FWONA', 'different_issuer');
    for (const t of ['GOOG', 'GOOGL', 'NWSA', 'NWS', 'LLYVA']) { reference(t, 'CS', '2010-01-01'); member(t, '2026-09-01'); }
    earnings('GOOGL', '2026-10-27');
    earnings('NWS', '2026-11-04');   // the ruling works in either direction: NWSA is dated by NWS
    earnings('FWONA', '2026-11-03');
    const byKey = new Map(QC603_EARNINGS_FRESHNESS.run(ctx()).map((e) => [e.key, e]));
    expect(byKey.get('GOOG')!.fired).toBe(false);
    expect(byKey.get('GOOG')!.evidence?.['via']).toBe('GOOGL');
    expect(byKey.get('GOOG')!.closesAs).toMatchObject({ kind: 'rule_changed' });
    expect(byKey.get('NWSA')!.fired).toBe(false);
    expect(byKey.get('GOOGL')!.evidence?.['via']).toBeNull(); // dated itself: no borrowed date named
    expect(byKey.get('LLYVA')!.fired).toBe(true);
  });

  it('QC-603 does not excuse a new listing that already has an earnings row', () => {
    // Grace covers "never dated", not "dated once and then dropped out of the calendar".
    reference('SPCX', 'CS', '2026-06-12');
    member('SPCX', '2026-09-01');
    earnings('SPCX', '2026-08-10');
    const e = QC603_EARNINGS_FRESHNESS.run(ctx()).find((x) => x.key === 'SPCX');
    expect(e?.evidence?.['newlyListed']).toBe(false);
  });

  it('closes the findings a clean reading settles, and says why — and leaves a live one open (v1.1.282)', () => {
    // gen-002 on 2026-09-18: 47 fund findings per check, raised before v1.1.257 excluded funds,
    // plus findings exempted by later rules, none of which anything could close.
    for (const [t, type] of [['SPY', 'ETF'], ['GIS', 'CS'], ['NVDA', 'CS'], ['SWKS', 'CS'], ['AAPL', 'CS'], ['CAI', 'CS'], ['OLD', 'CS']] as const) {
      reference(t, type);
    }
    for (const t of ['SPY', 'GIS', 'NVDA', 'SWKS', 'AAPL', 'OLD']) member(t, '2026-07-01');
    member('CAI', '2026-09-16');

    // Every one of them fired once, under older rules or before its data arrived.
    const raise = (def: typeof QC603_EARNINGS_FRESHNESS, keys: string[]) =>
      ({ ...def, run: () => keys.map((key) => ({ key, value: 9999, fired: true, detail: 'stale' })) });
    runGate(db(), makeHost(), {
      runId: run.runId, tradingDate: DATE, domainsExpected: {},
      checks: [raise(QC603_EARNINGS_FRESHNESS, ['SPY', 'GIS', 'NVDA', 'SWKS']), raise(QC905_RECOMMENDATION_FRESHNESS, ['SPY', 'AAPL', 'CAI', 'OLD'])]
    });
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);

    run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    earnings('GIS', '2026-09-15');   // just reported
    earnings('NVDA', '2026-11-18');  // a future date, observed now
    recommendations('AAPL', 'AAPL'); // a row stored now
    runGate(db(), makeHost(), {
      runId: run.runId, tradingDate: DATE, domainsExpected: {},
      checks: [QC603_EARNINGS_FRESHNESS, QC905_RECOMMENDATION_FRESHNESS]
    });

    // Only the eight raised above; the second run's own new findings (AAPL's missing earnings...) are not the point.
    const state = Object.fromEntries(
      (raw.prepare('SELECT check_id, key, state, resolution_kind FROM qa_exception WHERE first_seen_run_id < ?').all(run.runId) as
        { check_id: string; key: string; state: string; resolution_kind: string | null }[])
        .map((r) => [`${r.check_id} ${r.key}`, r.resolution_kind ?? r.state])
    );
    expect(state).toEqual({
      'QC-603 SPY': 'rule_changed',     // a fund — excluded since v1.1.257
      'QC-603 GIS': 'rule_changed',     // just-reported grace
      'QC-603 NVDA': 'data_corrected',  // a future date observed
      'QC-603 SWKS': 'open',            // still undated: still firing
      'QC-905 SPY': 'rule_changed',
      'QC-905 AAPL': 'data_corrected',  // a recommendation row stored
      'QC-905 CAI': 'rule_changed',     // admitted today, before its first weekly sweep
      'QC-905 OLD': 'open'              // never asked since July: still firing
    });
  });

  it('closes findings on a ticker that LEFT the subset, from the recorded exit — not one merely absent (v1.1.285)', () => {
    // EQR on gen-002: out of the S&P 500 and Russell 1000 on 2026-09-15, out of the subset 09-17.
    reference('EQR', 'CS');
    member('EQR', '2026-09-01');
    raw.prepare("UPDATE ref_chain_subset_membership SET valid_to = '2026-09-15' WHERE ticker = 'EQR'").run();
    const src = (raw.prepare('SELECT MAX(source_response_id) AS id FROM meta_response').get() as { id: number }).id;
    const rule = captureRuleId(db(), makeHost(), 'universe', { v: 1 }, 'test');
    for (const list of ['sp500', 'russell1000']) {
      raw.prepare(
        `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
           ticker, list_source, valid_from, valid_to, change_reason)
         VALUES (?, ?, 't', ?, ?, 'EQR', ?, '2026-09-01', '2026-09-14', 'index_drop')`
      ).run(run.runId, DATE, rule, src, list);
    }

    const raise = (def: typeof QC603_EARNINGS_FRESHNESS) =>
      ({ ...def, run: () => ['EQR', 'GHOST'].map((key) => ({ key, value: 9999, fired: true, detail: 'stale' })) });
    runGate(db(), makeHost(), {
      runId: run.runId, tradingDate: DATE, domainsExpected: {},
      checks: [raise(QC603_EARNINGS_FRESHNESS), raise(QC905_RECOMMENDATION_FRESHNESS)]
    });
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);

    run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    runGate(db(), makeHost(), {
      runId: run.runId, tradingDate: DATE, domainsExpected: {},
      checks: [QC603_EARNINGS_FRESHNESS, QC905_RECOMMENDATION_FRESHNESS]
    });

    const rows = raw.prepare(
      "SELECT check_id, key, state, resolution_kind, resolution_note FROM qa_exception WHERE key IN ('EQR', 'GHOST') ORDER BY check_id, key"
    ).all() as { check_id: string; key: string; state: string; resolution_kind: string | null; resolution_note: string | null }[];
    expect(rows.map((r) => [r.check_id, r.key, r.resolution_kind ?? r.state])).toEqual([
      ['QC-603', 'EQR', 'rule_changed'],
      ['QC-603', 'GHOST', 'open'],   // no membership record at all: absence, not a recorded exit
      ['QC-905', 'EQR', 'rule_changed'],
      ['QC-905', 'GHOST', 'open']
    ]);
    expect(rows[0]!.resolution_note).toBe(
      'EQR left the chain subset on 2026-09-15 (universe exit 2026-09-14: russell1000:index_drop, sp500:index_drop); QC-603 covers subset members only'
    );
  });

  it('QC-905 skips funds, measures from the last ask or admission, and fires on a ticker the sweep missed', () => {
    reference('SPY', 'ETF');
    member('SPY', '2026-07-01');
    reference('CAI', 'CS');
    member('CAI', '2026-09-16'); // admitted today, the weekly sweep has not reached it
    reference('OLD', 'CS');
    member('OLD', '2026-07-01'); // in the subset since July and never asked
    const evals = QC905_RECOMMENDATION_FRESHNESS.run(ctx());
    expect(evals.map((e) => e.key).sort()).toEqual(['CAI', 'OLD']);
    expect(evals.filter((e) => e.fired).map((e) => e.key)).toEqual(['OLD']);
  });
});
