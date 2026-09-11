import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import { DICTIONARY } from '../src/dictionary/index.js';
import type { TableEntry } from '../src/dictionary/types.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse, ScratchDb } from '../src/collector/host.js';
import { beginRun, captureRuleId, finishRun, type RunHandle } from '../src/collector/run.js';
import { captureResponse } from '../src/collector/capture.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { runDerivePhase } from '../src/collector/phases/derive.js';
import { runReplayJob, factColumns } from '../src/collector/replay.js';
import { canonicalJson, recipes } from '../src/ingest/recipes.js';
import { hashAccountKey } from '../src/ingest/account.js';

/**
 * Replay — AC-4 (B9b, 04 §7.5).
 *
 * A real day is captured through the real contract into a real generation with
 * a real archive, then replayed into a scratch file by the same one-shot job the
 * old app runs. What each test holds the replay to is the claim that matters:
 * equal when nothing changed, loud when something did, and never "equal" about
 * responses it could not actually replay.
 */

const DATE = '2026-09-09';
const KEY = 'ACCT-KEY-abc123';

let dir: string;
let raw: Database.Database;
const scratches: Database.Database[] = [];

function db(): SqliteLike {
  return raw as unknown as SqliteLike;
}

function openScratch(name: string): ScratchDb {
  const replayDir = join(dir, 'replay');
  mkdirSync(replayDir, { recursive: true });
  const path = join(replayDir, `${name}.sqlite`);
  if (existsSync(path)) throw new Error(`scratch ${path} already exists`);
  const handle = new Database(path);
  scratches.push(handle);
  applyDictionary(handle as unknown as SqliteLike);
  return {
    db: handle as unknown as SqliteLike,
    path,
    close: () => { if (handle.open) handle.close(); },
    discard: () => {
      if (handle.open) handle.close();
      rmSync(path, { force: true });
    }
  };
}

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  const empty: ProviderResponse = { status: 200, body: '{}', requestedAt: 't', respondedAt: 't' };
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    // A real transform, so the account line genuinely has to be decrypted.
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => empty,
    etradeGet: async () => empty,
    httpGet: async () => empty,
    nowET: () => `${DATE}T17:30:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    openScratchDb: openScratch,
    ...overrides
  };
}

function response(body: string): ProviderResponse {
  return { status: 200, body, requestedAt: `${DATE}T17:05:00-04:00`, respondedAt: `${DATE}T17:05:01-04:00` };
}

function chainBody(expiry: string, nearPrice: number, strikes: readonly number[]): string {
  return JSON.stringify({
    OptionChainResponse: {
      nearPrice,
      OptionPair: strikes.map((strike) => ({
        Call: {
          osiKey: `SPY   ${expiry}C00${String(strike).padStart(5, '0')}000`, strikePrice: strike,
          bid: 1, ask: 1.1, bidSize: 1, askSize: 1, volume: 5, openInterest: 10, inTheMoney: 'n',
          timeStamp: 1_788_552_898, OptionGreeks: { iv: 0.15, delta: 0.5, gamma: 0.01, theta: -0.1, vega: 0.4, rho: 0.1 }
        },
        Put: {
          osiKey: `SPY   ${expiry}P00${String(strike).padStart(5, '0')}000`, strikePrice: strike,
          bid: 1, ask: 1.1, bidSize: 1, askSize: 1, volume: 5, openInterest: 10, inTheMoney: 'n',
          timeStamp: 1_788_552_898, OptionGreeks: { iv: 0.16, delta: -0.5, gamma: 0.01, theta: -0.1, vega: 0.4, rho: -0.1 }
        }
      }))
    }
  });
}

const ORDERS_BODY = JSON.stringify({
  OrdersResponse: {
    Order: [{
      orderId: 987, orderType: 'OPTN',
      OrderDetail: [{
        placedTime: 1_788_552_000_000, executedTime: 1_788_552_898_000, status: 'EXECUTED',
        Instrument: [{
          orderAction: 'SELL_OPEN', quantityOrdered: 2, filledQuantity: 2, averageExecutionPrice: 3.4,
          Product: { symbol: 'TSLA', securityType: 'OPTN', callPut: 'PUT', expiryYear: 2026, expiryMonth: 9, expiryDay: 18, strikePrice: 350 }
        }]
      }]
    }]
  }
});

/** Captures one daily run exactly as the collector would, derivation included. */
function captureDay(): RunHandle {
  const host = makeHost();
  const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
  const barsRule = captureRuleId(db(), host, 'bars', { depthDays: 5 }, 'bars');
  const chainRule = captureRuleId(db(), host, 'chain', { maxDte: 90 }, 'chain');
  const accountRule = captureRuleId(db(), host, 'account', { v: 1 }, 'account');
  const common = { host, db: db(), runId: run.runId, asOfDate: DATE };

  captureResponse({
    ...common, provider: 'polygon', endpoint: '/v2/aggs/ticker/SPY/range/1/day', slug: 'aggs-day',
    params: { ticker: 'SPY' }, captureRuleId: barsRule,
    response: response(JSON.stringify({ results: [
      { t: Date.parse('2026-09-08T16:00:00Z'), o: 99, h: 101, l: 98, c: 100, v: 1000 },
      { t: Date.parse('2026-09-09T16:00:00Z'), o: 100, h: 102, l: 99, c: 101, v: 1200 }
    ] })),
    recipe: recipes.bars({ ticker: 'SPY', fetchKind: 'daily', adjustedAsOf: DATE, provisionalDate: DATE })
  });

  for (const [expiry, date] of [['260918', '2026-09-18'], ['261016', '2026-10-16']] as const) {
    captureResponse({
      ...common, provider: 'etrade', endpoint: '/v1/market/optionchains', slug: 'optionchains',
      params: { symbol: 'SPY', expiration: date }, captureRuleId: chainRule,
      response: response(chainBody(expiry, 100, [99, 101])),
      recipe: recipes.chain({
        ticker: 'SPY', expirationDate: date,
        stickyReasons: new Map([[`SPY   ${expiry}P00099000`, 'held_position']])
      })
    });
  }

  captureResponse({
    ...common, provider: 'etrade', endpoint: '/v1/accounts/{accountKey}/orders', slug: 'account-orders',
    params: { status: 'EXECUTED' }, captureRuleId: accountRule, response: response(ORDERS_BODY),
    recipe: recipes.orders({ accountKey: KEY, knownOrders: new Map() })
  });

  // A routing document: archived for provenance, parsed by nobody.
  captureResponse({
    ...common, provider: 'edgar', endpoint: '/Archives/edgar/daily-index/form.idx', slug: 'edgar-form-index',
    params: { date: DATE }, captureRuleId: null, response: response('Form Type   Company Name')
  });

  runDerivePhase(db(), host, run);
  finishRun(db(), host, run, 'complete', 'green');
  return run;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-replay-'));
  resetOffsetCache();
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.prepare(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1, 't', 'pilot', 'x', 'y')"
  ).run();
});

afterEach(() => {
  for (const s of scratches.splice(0)) if (s.open) s.close();
  if (raw.open) raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const tableOf = (report: ReturnType<typeof runReplayJob>, name: string) => report.tables.find((t) => t.table === name);

describe('a replay of an unchanged day', () => {
  it('reproduces every parsed row and the derivation exactly', () => {
    captureDay();
    const report = runReplayJob(makeHost(), { tradingDate: DATE });

    expect(report.verdict).toBe('equal');
    expect(report.coverage).toMatchObject({ considered: 5, replayed: 4, noIngest: 1, beforeRecipes: 0, unreadable: 0, digestMismatch: 0 });
    expect(report.derivedCompared).toBe(true);
    for (const name of ['raw_daily_bar', 'raw_option_contract_snapshot', 'raw_executed_order', 'raw_executed_order_leg', 'derived_iv30_daily']) {
      const t = tableOf(report, name);
      expect(t, name).toBeDefined();
      expect(t!.sourceRows, name).toBeGreaterThan(0);
      expect(t!, name).toMatchObject({ matched: t!.sourceRows, replayRows: t!.sourceRows, added: 0, removed: 0 });
    }
  });

  it('decrypts the account response through the host rather than reading it in the clear', () => {
    captureDay();
    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(tableOf(report, 'raw_executed_order')).toMatchObject({ sourceRows: 1, matched: 1 });
    // And the same replay with a host that cannot decrypt is counted, not guessed.
    const blind = runReplayJob(makeHost({ decryptFromArchive: () => { throw new Error('safeStorage unavailable'); } }), { tradingDate: DATE });
    expect(blind.coverage.unreadable).toBe(1);
    expect(blind.verdict).toBe('equal_on_replayed');
  });

  it('deletes an equal replay\'s scratch file — there is nothing in it to keep', () => {
    captureDay();
    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(report.scratchPath).toBeNull();
    expect(readdirSync(join(dir, 'replay')).filter((f) => f.endsWith('.sqlite'))).toEqual([]);
  });

  it('records its own run in the source generation, and writes nothing else there', () => {
    captureDay();
    const before = (raw.prepare('SELECT COUNT(*) AS n FROM raw_daily_bar').get() as { n: number }).n;
    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(raw.prepare('SELECT run_kind, status FROM meta_run WHERE run_id = ?').get(report.jobRunId))
      .toEqual({ run_kind: 'replay', status: 'complete' });
    expect((raw.prepare('SELECT COUNT(*) AS n FROM raw_daily_bar').get() as { n: number }).n).toBe(before);
  });
});

describe('a replay that finds something', () => {
  it('reports a stored row the parse did not produce, and keeps the scratch file as evidence', () => {
    captureDay();
    // A row the generation holds against the bar response that no parse of
    // that response produces — the shape of a write from outside the contract.
    const columns = (raw.prepare("PRAGMA table_info('raw_daily_bar')").all() as { name: string }[])
      .map((c) => c.name).filter((c) => c !== 'row_id');
    raw.prepare(
      `INSERT INTO raw_daily_bar (${columns.join(', ')})
       SELECT ${columns.map((c) => (c === 'close' ? 'close + 5' : c)).join(', ')} FROM raw_daily_bar ORDER BY row_id LIMIT 1`
    ).run();

    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(report.verdict).toBe('different');
    const bars = tableOf(report, 'raw_daily_bar')!;
    expect(bars).toMatchObject({ sourceRows: 3, replayRows: 2, matched: 2, added: 0, removed: 1 });
    expect(bars.removedSamples[0]!['close']).toBe(105);
    expect(report.scratchPath).not.toBeNull();
    expect(existsSync(report.scratchPath!)).toBe(true);
  });

  it('reports a fact that now reads differently as CHANGED, not as unrelated noise', () => {
    captureDay();
    // Point the bar response at a recipe that disagrees with how its stored
    // rows were produced — without a provisional date, the replayed bars come
    // out final. Same natural key, different value: one changed row.
    const barResponse = raw
      .prepare("SELECT source_response_id AS id FROM meta_response WHERE archive_file LIKE '%aggs-day%'")
      .get() as { id: number };
    const r = recipes.bars({ ticker: 'SPY', fetchKind: 'daily', adjustedAsOf: DATE });
    raw.prepare("INSERT INTO meta_ingest_recipe (recipe_sha256, module, args_json, first_seen_at) VALUES ('other', ?, ?, 't')")
      .run(r.module, canonicalJson(r.args));
    raw.prepare("UPDATE meta_response SET ingest_recipe_id = (SELECT recipe_id FROM meta_ingest_recipe WHERE recipe_sha256 = 'other') WHERE source_response_id = ?")
      .run(barResponse.id);

    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(report.verdict).toBe('different');
    expect(tableOf(report, 'raw_daily_bar')).toMatchObject({ added: 1, removed: 1, changed: 1 });
  });
});

describe('what a replay refuses to call equal', () => {
  it('a run captured before recipes existed is nothing_replayable — never equal', () => {
    // The zero-overlap trap: an equivalence check over zero comparisons
    // evaluates nothing and must not look like a clean result.
    const run = captureDay();
    raw.prepare('UPDATE meta_response SET ingest_recipe_id = NULL').run();
    raw.prepare('UPDATE meta_run SET dictionary_version = 10 WHERE run_id = ?').run(run.runId);

    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(report.verdict).toBe('nothing_replayable');
    expect(report.coverage).toMatchObject({ replayed: 0, beforeRecipes: 5 });
    expect(report.tables).toEqual([]);
  });

  it('a body that no longer matches its digest is counted and left out, and the derivation is not compared', () => {
    captureDay();
    raw.prepare(`UPDATE meta_response SET sha256 = ? WHERE archive_file LIKE '%aggs-day%'`).run('f'.repeat(64));

    const report = runReplayJob(makeHost(), { tradingDate: DATE });
    expect(report.coverage.digestMismatch).toBe(1);
    expect(report.problems[0]).toMatch(/no longer hashes/);
    // Everything that WAS replayed still matched — but it is not a full "equal".
    expect(report.verdict).toBe('equal_on_replayed');
    expect(tableOf(report, 'raw_daily_bar')).toBeUndefined();
    expect(report.derivedCompared).toBe(false);
    expect(report.derivedNote).toMatch(/not compared/);
  });

  it('refuses a generation with no completed daily run, and marks its own run failed', () => {
    const host = makeHost();
    expect(() => runReplayJob(host, { tradingDate: DATE })).toThrow(/no completed daily run/);
    expect(raw.prepare("SELECT status FROM meta_run WHERE run_kind = 'replay'").get()).toEqual({ status: 'failed' });
  });

  it('refuses a host that cannot open a scratch database', () => {
    captureDay();
    const { openScratchDb: _drop, ...rest } = makeHost();
    void _drop;
    expect(() => runReplayJob(rest as CollectorHost, { tradingDate: DATE })).toThrow(/cannot open a scratch database/);
  });
});

describe('recording recipes at capture', () => {
  it('stores each distinct recipe once, however many responses use it', () => {
    captureDay();
    // Two chain responses, two different expirations: two recipes. The bar and
    // order recipes once each.
    const byModule = raw
      .prepare('SELECT module, COUNT(*) AS n FROM meta_ingest_recipe GROUP BY module ORDER BY module')
      .all() as { module: string; n: number }[];
    expect(byModule).toEqual([
      { module: 'etrade_chain', n: 2 },
      { module: 'etrade_orders', n: 1 },
      { module: 'polygon_bars', n: 1 }
    ]);
  });

  it('never writes the account key, only its digest', () => {
    captureDay();
    const all = (raw.prepare('SELECT args_json FROM meta_ingest_recipe').all() as { args_json: string }[])
      .map((r) => r.args_json).join('\n');
    expect(all).not.toContain(KEY);
    expect(all).toContain(hashAccountKey(KEY));
  });

  it('records the capture rule on the response itself', () => {
    captureDay();
    const rows = raw
      .prepare("SELECT archive_file, capture_rule_id FROM meta_response ORDER BY source_response_id")
      .all() as { archive_file: string; capture_rule_id: number | null }[];
    expect(rows.filter((r) => r.capture_rule_id !== null)).toHaveLength(4);
    expect(rows.find((r) => r.archive_file.includes('edgar-form-index'))!.capture_rule_id).toBeNull();
  });
});

describe('the comparison basis', () => {
  it('excludes surrogate and reference columns everywhere, and observed_at on derived rows only', () => {
    const leg = DICTIONARY.find((t) => t.table === 'raw_executed_order_leg')!;
    expect(factColumns(leg)).not.toContain('order_row_id');
    expect(factColumns(leg)).not.toContain('row_id');
    expect(factColumns(leg)).not.toContain('source_response_id');
    const bar = DICTIONARY.find((t) => t.table === 'raw_daily_bar')!;
    expect(factColumns(bar)).toContain('observed_at');
    const derived = DICTIONARY.find((t) => t.table === 'derived_iv30_daily')!;
    expect(factColumns(derived)).not.toContain('observed_at');
    expect(factColumns(derived)).toContain('iv30');
  });
});

describe('adding the recipe columns to a generation already holding responses', () => {
  it('is plain growth — the stored table is not reported as drifted afterwards', () => {
    // Every existing generation meets this change populated. If the ALTER that
    // adds the columns left the stored DDL different from the generated one,
    // `meta_response` would be reported as drifted on every open from now on.
    const older: TableEntry[] = DICTIONARY
      .filter((t) => t.table !== 'meta_ingest_recipe')
      .map((t) =>
        t.table === 'meta_response'
          ? { ...t, columns: t.columns.filter((c) => c.column !== 'ingest_recipe_id' && c.column !== 'capture_rule_id') }
          : t
      );
    const path = join(dir, 'older.sqlite');
    const legacy = new Database(path);
    scratches.push(legacy);
    const ldb = legacy as unknown as SqliteLike;
    applyDictionary(ldb, older);
    legacy.prepare(
      `INSERT INTO meta_run (run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version)
       VALUES ('daily', 'after_close', ?, 't', 'complete', 'h', '1', '0', 10)`
    ).run(DATE);
    legacy.prepare(
      `INSERT INTO meta_response (run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset,
                                  dedup_hash, encrypted, at_provider_cap, parse_status)
       VALUES (1, 'polygon', '/x', '{}', 't', 'archive/polygon/2026-09-09/x.jsonl.gz', 0, 'd', 0, 0, 'ok')`
    ).run();

    const result = applyDictionary(ldb);
    expect(result.columnsAdded).toEqual(
      expect.arrayContaining([
        { table: 'meta_response', column: 'ingest_recipe_id' },
        { table: 'meta_response', column: 'capture_rule_id' }
      ])
    );
    expect(result.tablesCreated).toContain('meta_ingest_recipe');
    // And converged: a second open sees nothing to report.
    expect(applyDictionary(ldb).driftBlocked).not.toContain('meta_response');
  });
});
