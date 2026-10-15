import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import type { IngestContext } from '../src/collector/capture.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { runEtradeQuotesPhase, ETRADE_QUOTE_BATCH } from '../src/collector/phases/market.js';
import { makeEtradeQuoteIngest, etradeWallClockToEt, etradeTrueFalseToFlag } from '../src/ingest/market.js';
import { QC303_CROSSED_MARKET } from '../src/qa/checks/quotes-actions.js';

/**
 * E*Trade equity bid/ask (v1.1.363) — what QC-303 reads, because Polygon
 * Starter sends no `lastQuote` and QC-303 had never evaluated a row.
 */

/**
 * A live response, NOT a hand-typed one: TA1 → Misc → Test API, AAPL, 2026-10-14
 * at 19:59:57 EDT (after hours), trimmed to the fields this parser reads plus a
 * few neighbours. Note `ahFlag` is the STRING "true", and `All.bid`/`All.ask`
 * equal the extended-hours detail — after the close they ARE the after-hours quote.
 */
const AAPL_LIVE_2026_10_14 = {
  dateTime: '19:59:57 EDT 10-14-2026',
  dateTimeUTC: 1792022397,
  quoteStatus: 'CLOSING',
  ahFlag: 'true',
  hasMiniOptions: false,
  All: {
    ask: 345.2,
    askSize: 360,
    askTime: '19:59:57 EDT 10-14-2026',
    bid: 344.63,
    bidExchange: '',
    bidSize: 80,
    bidTime: '19:59:57 EDT 10-14-2026',
    lastTrade: 342.96,
    previousClose: 341.27,
    timeOfLastTrade: 1792008000,
    ExtendedHourQuoteDetail: {
      lastPrice: 345, bid: 344.63, bidSize: 80, ask: 345.2, askSize: 360,
      timeOfLastTrade: 1792022397, timeZone: 'EST', quoteStatus: 'EH_CLOSED'
    }
  },
  Product: { symbol: 'AAPL', securityType: 'EQ' }
};

const ctx: IngestContext = {
  runId: 1, asOfDate: '2026-10-14', observedAt: '2026-10-14T20:00:00-04:00', captureRuleId: 1
} as IngestContext;

function body(...quotes: unknown[]): string {
  return JSON.stringify({ QuoteResponse: { QuoteData: quotes } });
}

describe('E*Trade equity quote parser', () => {
  it('reads the live AAPL response', () => {
    const rows = makeEtradeQuoteIngest({ symbols: ['AAPL'] })(body(AAPL_LIVE_2026_10_14), ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.table).toBe('raw_etrade_quote');
    expect(rows[0]!.values).toMatchObject({
      ticker: 'AAPL',
      bid: 344.63, bid_size: 80, bid_status: 'ok',
      ask: 345.2, ask_size: 360, ask_status: 'ok',
      bid_time: '2026-10-14T19:59:57-04:00', bid_time_status: 'ok',
      ask_time: '2026-10-14T19:59:57-04:00', ask_time_status: 'ok',
      ah_flag: 1,
      provider_quote_state: 'CLOSING',
      provider_timestamp: '2026-10-14T19:59:57-04:00'
    });
  });

  it('reads ahFlag "false" as 0 — a cast would read it as true', () => {
    expect(etradeTrueFalseToFlag('false')).toBe(0);
    expect(etradeTrueFalseToFlag('true')).toBe(1);
    expect(etradeTrueFalseToFlag(false)).toBe(0);
    expect(etradeTrueFalseToFlag('n')).toBeNull();
    expect(etradeTrueFalseToFlag(undefined)).toBeNull();
  });

  it('parses the wall-clock time with its zone label, and refuses other shapes', () => {
    expect(etradeWallClockToEt('09:30:01 EST 12-01-2026')).toEqual({ value: '2026-12-01T09:30:01-05:00', status: 'ok' });
    expect(etradeWallClockToEt(undefined)).toEqual({ value: null, status: 'omitted' });
    expect(etradeWallClockToEt('')).toEqual({ value: null, status: 'omitted' });
    expect(etradeWallClockToEt('2026-10-14T19:59:57Z')).toEqual({ value: null, status: 'invalid' });
    expect(etradeWallClockToEt(1792022397)).toEqual({ value: null, status: 'invalid' });
  });

  it('keys on the symbol ASKED and drops an answer for one that was not', () => {
    const msft = { ...AAPL_LIVE_2026_10_14, Product: { symbol: 'MSFT', securityType: 'EQ' } };
    const goog = { ...AAPL_LIVE_2026_10_14, Product: { symbol: 'GOOG', securityType: 'EQ' } };
    const rows = makeEtradeQuoteIngest({ symbols: ['AAPL', 'MSFT'] })(body(AAPL_LIVE_2026_10_14, msft, goog), ctx);
    expect(rows.map((r) => r.values['ticker'])).toEqual(['AAPL', 'MSFT']);
  });

  it('keeps one side when the other is missing, and a zero as a zero', () => {
    const oneSided = { ...AAPL_LIVE_2026_10_14, All: { ask: 0, askSize: 0, bid: 'n/a' } };
    const [row] = makeEtradeQuoteIngest({ symbols: ['AAPL'] })(body(oneSided), ctx);
    expect(row!.values).toMatchObject({
      bid: null, bid_status: 'invalid', bid_size: null,
      ask: 0, ask_status: 'ok', ask_size: 0,
      bid_time_status: 'omitted', ask_time_status: 'omitted'
    });
  });
});

describe('the E*Trade quotes phase and QC-303', () => {
  const DATE = '2026-10-14';
  let dir: string;
  let raw: Database.Database;
  const db = (): SqliteLike => raw as unknown as SqliteLike;
  const TICKERS = Array.from({ length: ETRADE_QUOTE_BATCH + 5 }, (_, i) => `T${String(i).padStart(2, '0')}`);

  function host(opts: {
    readonly refuseBatches?: boolean;
    readonly silent?: ReadonlySet<string>;
    readonly crossed?: ReadonlySet<string>;
    readonly zeroAsk?: ReadonlySet<string>;
    readonly paths?: string[];
  } = {}): CollectorHost {
    const reply = (status: number, b: string): ProviderResponse => ({
      status, body: b, requestedAt: '2026-10-14T17:05:00-04:00', respondedAt: '2026-10-14T17:05:01-04:00'
    });
    return {
      openGenerationDb: () => db(),
      archiveRoot: () => join(dir, 'archive'),
      encryptForArchive: (b) => b,
      decryptFromArchive: (b) => b,
      polygonGet: async () => reply(200, '{}'),
      etradeGet: async (path) => {
        opts.paths?.push(path);
        const symbols = path.replace('/v1/market/quote/', '').split(',');
        if (opts.refuseBatches && symbols.length > 1) return reply(400, '<Error><code>9999</code></Error>');
        const quotes = symbols
          .filter((s) => !opts.silent?.has(s))
          .map((s) => ({
            ...AAPL_LIVE_2026_10_14,
            All: {
              ...AAPL_LIVE_2026_10_14.All,
              ...(opts.crossed?.has(s) ? { bid: 346, ask: 345.2 } : {}),
              ...(opts.zeroAsk?.has(s) ? { bid: 346, ask: 0 } : {})
            },
            Product: { symbol: s, securityType: 'EQ' }
          }));
        return reply(200, body(...quotes));
      },
      httpGet: async () => reply(200, '{}'),
      nowET: () => '2026-10-14T17:05:00-04:00',
      sendEmail: async () => undefined,
      progress: () => undefined,
      signal: new AbortController().signal,
      hostApp: { name: 'test', version: '0' }
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ta-etq-'));
    resetOffsetCache();
    raw = new Database(join(dir, 'data.sqlite'));
    applyDictionary(db());
    raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
    const h = host();
    const run = beginRun(db(), h, { kind: 'manual', tradingDate: DATE });
    const rule = captureRuleId(db(), h, 'universe', { v: 1 }, 'test');
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9001, ${run.runId}, 'polygon', '/x', '{}', 't', 'a', 0, 'seed', 0, 0, 'ok')`
    );
    const ins = raw.prepare(
      `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, list_source, valid_from, valid_to, change_reason)
       VALUES (?, ?, 't', ?, 9001, ?, 'sp500', '2021-01-01', NULL, 'initial')`
    );
    for (const t of TICKERS) ins.run(run.runId, DATE, rule, t);
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);
  });

  afterEach(() => {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function collect(h: CollectorHost) {
    const run = beginRun(db(), h, { kind: 'daily', tradingDate: DATE });
    const counts = await runEtradeQuotesPhase(h, db(), run);
    return { run, counts };
  }

  it('batches 25 symbols per call and stores one row per ticker', async () => {
    const paths: string[] = [];
    const { counts } = await collect(host({ paths, silent: new Set(['T07']) }));
    expect(paths).toHaveLength(2);
    expect(paths[0]!.split(',')).toHaveLength(ETRADE_QUOTE_BATCH);
    expect(counts).toMatchObject({ expected: 30, stored: 29, failed: 0, calls: 2, unanswered: ['T07'] });
    expect((raw.prepare('SELECT COUNT(*) AS n FROM raw_etrade_quote').get() as { n: number }).n).toBe(29);
  });

  it('falls back to one symbol per call when a batch is refused', async () => {
    const paths: string[] = [];
    const { counts } = await collect(host({ paths, refuseBatches: true }));
    // 2 refused batches, then 30 single-symbol calls.
    expect(counts.calls).toBe(32);
    expect(counts.stored).toBe(30);
    expect(counts.unanswered).toEqual([]);
  });

  it('QC-303 reads only the latest observation of a ticker', async () => {
    await collect(host({ crossed: new Set(['T03']) }));
    const { run } = await collect(host()); // a re-run of the same date, now uncrossed
    const [e] = QC303_CROSSED_MARKET.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
    expect(e!.fired).toBe(false);
    expect(e!.evidence).toMatchObject({ total: 30, crossed: 0 });
  });

  it('QC-303 fires on a crossed quote and splits out the after-hours ones', async () => {
    await collect(host());
    const { run } = await collect(host({ crossed: new Set(['T03']) }));
    const [e] = QC303_CROSSED_MARKET.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
    expect(e!.fired).toBe(true);
    expect(e!.value).toBeCloseTo(1 / 30);
    expect(e!.detail).toBe('1 of 30 quotes are crossed (1 marked after-hours)');
    expect(e!.evidence).toMatchObject({ total: 30, crossed: 1, crossedAfterHours: 1 });
  });

  it('QC-303 ignores a side quoted at zero, and evaluates nothing with no quotes', async () => {
    expect(QC303_CROSSED_MARKET.run({ db: db(), runId: 1, tradingDate: DATE, observedAt: 't' })).toEqual([]);
    const { run } = await collect(host({ zeroAsk: new Set(['T05']) }));
    const [e] = QC303_CROSSED_MARKET.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
    expect(e!.fired).toBe(false);
    expect(e!.evidence).toMatchObject({ total: 29 });
  });
});
