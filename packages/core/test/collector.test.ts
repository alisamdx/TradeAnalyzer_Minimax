import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import {
  archiveResponse,
  readArchivedResponse,
  verifyArchivedResponse,
  resetOffsetCache
} from '../src/collector/archive.js';
import { captureResponse } from '../src/collector/capture.js';
import { beginRun, finishRun, captureRuleId } from '../src/collector/run.js';
import { claimNextJob, finishJob, queueJob, stalledRequests } from '../src/collector/jobs.js';
import { runPreflight } from '../src/collector/phases/preflight.js';
import { reconcileMembership, referenceDue } from '../src/collector/phases/universe.js';
import { ingestTickerReference, zeroPadCik, pickShares } from '../src/ingest/raw-ticker-reference.js';
import { runUniverseSeed } from '../src/collector/universe-seed.js';

/**
 * The collector — B3's gate is AC-1 and AC-2 **on real rows**, so both are
 * exercised end to end against a real database and a real archive on disk
 * rather than against mocks of them.
 */

let dir: string;
let raw: Database.Database;

function response(body: string, status: number | null = 200, error?: string): ProviderResponse {
  return {
    status,
    body,
    requestedAt: '2026-09-06T17:05:00-04:00',
    respondedAt: status === null ? null : '2026-09-06T17:05:01-04:00',
    ...(error ? { error } : {})
  };
}

/**
 * A fake host. Its encryption is a byte-flip, not a cipher: the test is that the
 * archive round-trips through *whatever* the host provides and refuses a line
 * without the header, and a real cipher here would test Node's crypto instead.
 */
/** A `bars`-domain rule row, since rule-driven tables require one (02 §0.2). */
function ruleId(): number {
  return captureRuleId(raw as unknown as SqliteLike, makeHost(), 'reference', { scope: 'test' }, 'test rule');
}

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  const calls: { path: string; params: Record<string, string> }[] = [];
  const host: CollectorHost = {
    openGenerationDb: () => raw as unknown as SqliteLike,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async (path, params) => {
      calls.push({ path, params });
      return response('{"results":{}}');
    },
    etradeGet: async () => response('{"ok":true}'),
    httpGet: async () => response('{}'),
    nowET: () => '2026-09-06T17:05:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
  return host;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-collector-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(raw as unknown as SqliteLike);
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-06T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('archive — P2, and the substrate AC-1 stands on', () => {
  it('round-trips a response through gzip', () => {
    const host = makeHost();
    const body = JSON.stringify({ results: [1, 2, 3], note: 'hello' });
    const at = archiveResponse(host, {
      provider: 'polygon', asOfDate: '2026-09-06', slug: 'aggs-day',
      id: 'r1', params: { ticker: 'AAPL' }, response: response(body)
    });
    expect(at.archiveFile).toBe('archive/polygon/2026-09-06/aggs-day.jsonl.gz');
    expect(at.archiveOffset).toBe(0);
    expect(readArchivedResponse(host, at.archiveFile, 0).body).toBe(body);
  });

  it('keeps many responses in one file, each retrievable by offset', () => {
    const host = makeHost();
    const bodies = Array.from({ length: 25 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(i * 7) }));
    const locations = bodies.map((b, i) =>
      archiveResponse(host, {
        provider: 'polygon', asOfDate: '2026-09-06', slug: 'aggs-day',
        id: `r${i}`, params: {}, response: response(b)
      })
    );
    expect(locations.map((l) => l.archiveOffset)).toEqual(bodies.map((_, i) => i));
    for (const [i, loc] of locations.entries()) {
      expect(readArchivedResponse(host, loc.archiveFile, loc.archiveOffset).body).toBe(bodies[i]);
    }
  });

  it('survives bodies whose compressed bytes contain newlines', () => {
    // Records are length-prefixed rather than newline-delimited for exactly this
    // reason. Splitting compressed bytes on 0x0A corrupts records at random —
    // only the unlucky ones, and never reproducibly the same ones.
    const host = makeHost();
    const bodies = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ i, blob: Buffer.from(Array.from({ length: 200 }, (_, j) => (i * j) % 256)).toString('base64') })
    );
    const locations = bodies.map((b, i) =>
      archiveResponse(host, {
        provider: 'polygon', asOfDate: '2026-09-06', slug: 'newline-probe',
        id: `n${i}`, params: {}, response: response(b)
      })
    );
    const fileBytes = readFileSync(join(dir, locations[0]!.archiveFile));
    expect(fileBytes.includes(0x0a), 'the fixture must actually contain newline bytes').toBe(true);
    for (const [i, loc] of locations.entries()) {
      expect(readArchivedResponse(host, loc.archiveFile, loc.archiveOffset).body).toBe(bodies[i]);
    }
  });

  it('continues offsets across a restart, when the cache is cold', () => {
    const host = makeHost();
    const first = archiveResponse(host, {
      provider: 'polygon', asOfDate: '2026-09-06', slug: 'aggs-day',
      id: 'a', params: {}, response: response('{"a":1}')
    });
    resetOffsetCache(); // as if the process had restarted
    const second = archiveResponse(host, {
      provider: 'polygon', asOfDate: '2026-09-06', slug: 'aggs-day',
      id: 'b', params: {}, response: response('{"b":2}')
    });
    expect(first.archiveOffset).toBe(0);
    expect(second.archiveOffset).toBe(1);
    expect(readArchivedResponse(host, second.archiveFile, 1).body).toBe('{"b":2}');
  });

  it('encrypts account-domain files and refuses a line without the header', () => {
    const host = makeHost();
    const at = archiveResponse(host, {
      provider: 'etrade', asOfDate: '2026-09-06', slug: 'account-portfolio',
      id: 'p1', params: {}, response: response('{"Position":[{"symbol":"AAPL"}]}')
    });
    expect(at.archiveFile.endsWith('.jsonl.enc')).toBe(true);
    expect(readArchivedResponse(host, at.archiveFile, 0).body).toContain('AAPL');

    // A host that decrypts differently must fail loudly, not return noise.
    const wrongHost = makeHost({ decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x11)) });
    expect(() => readArchivedResponse(wrongHost, at.archiveFile, 0)).toThrow();
  });

  it('never writes an account body in the clear', () => {
    const host = makeHost();
    const secret = 'ACCOUNT-SECRET-9c1f';
    const at = archiveResponse(host, {
      provider: 'etrade', asOfDate: '2026-09-06', slug: 'account-balance',
      id: 'b1', params: {}, response: response(`{"cash":"${secret}"}`)
    });
    const bytes = readFileSync(join(dir, at.archiveFile));
    expect(bytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
  });

  it('verifies a stored body against the recorded digest', () => {
    const host = makeHost();
    const body = '{"x":42}';
    const at = archiveResponse(host, {
      provider: 'polygon', asOfDate: '2026-09-06', slug: 'aggs-day',
      id: 'v', params: {}, response: response(body)
    });
    expect(verifyArchivedResponse(host, at.archiveFile, 0, at.sha256)).toBe(true);
    expect(verifyArchivedResponse(host, at.archiveFile, 0, 'deadbeef')).toBe(false);
    expect(at.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });
});

describe('AC-1 — every stored value can be traced to the response it came from', () => {
  it('links a raw row to its archived body, and the body still parses to the value', () => {
    const host = makeHost();
    const run = beginRun(raw as unknown as SqliteLike, host, {
      kind: 'manual', tradingDate: '2026-09-06'
    });
    const body = JSON.stringify({
      results: {
        ticker: 'AAPL', name: 'Apple Inc.', type: 'CS', primary_exchange: 'XNAS',
        market_cap: 3.4e12, weighted_shares_outstanding: 15_400_000_000, cik: '320193', active: true
      }
    });

    const result = captureResponse({
      host, db: raw as unknown as SqliteLike, runId: run.runId, asOfDate: '2026-09-06',
      provider: 'polygon', endpoint: '/v3/reference/tickers/AAPL', slug: 'reference-tickers',
      params: { ticker: 'AAPL' }, response: response(body), captureRuleId: ruleId(),
      ingest: ingestTickerReference
    });
    expect(result.parseError).toBeUndefined();
    expect(result.parseStatus).toBe('ok');
    expect(result.rowsWritten).toBe(1);

    // The journey AC-1 describes, walked in full: raw row -> meta_response ->
    // archive file -> the bytes -> the value.
    const row = raw.prepare('SELECT * FROM raw_ticker_reference').get() as Record<string, unknown>;
    expect(row['market_cap']).toBe(3.4e12);
    expect(row['source_response_id']).toBe(result.sourceResponseId);

    const meta = raw
      .prepare('SELECT * FROM meta_response WHERE source_response_id = ?')
      .get(row['source_response_id']) as Record<string, unknown>;
    const archived = readArchivedResponse(
      host, meta['archive_file'] as string, meta['archive_offset'] as number
    );
    expect(JSON.parse(archived.body).results.market_cap).toBe(row['market_cap']);
    expect(verifyArchivedResponse(
      host, meta['archive_file'] as string, meta['archive_offset'] as number, meta['sha256'] as string
    )).toBe(true);
  });

  it('holds for every raw row written by a run, not just the one we looked at', () => {
    const host = makeHost();
    const run = beginRun(raw as unknown as SqliteLike, host, { kind: 'manual', tradingDate: '2026-09-06' });
    for (const ticker of ['AAPL', 'MSFT', 'NVDA', 'AMD', 'INTC']) {
      captureResponse({
        host, db: raw as unknown as SqliteLike, runId: run.runId, asOfDate: '2026-09-06',
        provider: 'polygon', endpoint: `/v3/reference/tickers/${ticker}`, slug: 'reference-tickers',
        params: { ticker },
        response: response(JSON.stringify({ results: { ticker, name: ticker, type: 'CS', active: true } })),
        captureRuleId: ruleId(), ingest: ingestTickerReference
      });
    }
    const rows = raw
      .prepare('SELECT ticker, source_response_id FROM raw_ticker_reference')
      .all() as { ticker: string; source_response_id: number }[];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const meta = raw
        .prepare('SELECT archive_file, archive_offset FROM meta_response WHERE source_response_id = ?')
        .get(row.source_response_id) as { archive_file: string; archive_offset: number };
      const archived = readArchivedResponse(host, meta.archive_file, meta.archive_offset);
      expect(JSON.parse(archived.body).results.ticker).toBe(row.ticker);
    }
  });

  it('keeps the index row and the body when ingestion fails, so a replay can recover', () => {
    // Rolling back would discard the evidence needed to fix the parser. The body
    // is on disk, parse_status says failed, and QC-001 has something to fire on.
    const host = makeHost();
    const run = beginRun(raw as unknown as SqliteLike, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const result = captureResponse({
      host, db: raw as unknown as SqliteLike, runId: run.runId, asOfDate: '2026-09-06',
      provider: 'polygon', endpoint: '/v3/reference/tickers/BAD', slug: 'reference-tickers',
      params: { ticker: 'BAD' }, response: response('this is not json'), captureRuleId: null,
      ingest: ingestTickerReference
    });
    expect(result.parseStatus).toBe('failed');
    expect(result.rowsWritten).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_ticker_reference').get()).toEqual({ n: 0 });

    const meta = raw.prepare('SELECT * FROM meta_response').get() as Record<string, unknown>;
    expect(meta['parse_status']).toBe('failed');
    expect(readArchivedResponse(host, meta['archive_file'] as string, meta['archive_offset'] as number).body)
      .toBe('this is not json');
  });

  it('archives and indexes a non-2xx response without parsing it — it is evidence', () => {
    const host = makeHost();
    const run = beginRun(raw as unknown as SqliteLike, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const result = captureResponse({
      host, db: raw as unknown as SqliteLike, runId: run.runId, asOfDate: '2026-09-06',
      provider: 'etrade', endpoint: '/v1/market/optionchains', slug: 'optionchains',
      params: { symbol: 'AAPL' },
      response: response('<Error><message>code 10031</message></Error>', 400),
      captureRuleId: ruleId(), ingest: ingestTickerReference
    });
    expect(result.parseStatus).toBe('failed');
    const meta = raw.prepare('SELECT http_status, parse_status FROM meta_response').get();
    expect(meta).toEqual({ http_status: 400, parse_status: 'failed' });
  });

  it('archives a network fault, which has no status at all', () => {
    const host = makeHost();
    const run = beginRun(raw as unknown as SqliteLike, host, { kind: 'manual', tradingDate: '2026-09-06' });
    captureResponse({
      host, db: raw as unknown as SqliteLike, runId: run.runId, asOfDate: '2026-09-06',
      provider: 'etrade', endpoint: '/v1/market/quote/SPY', slug: 'preflight-probe',
      params: {}, response: response('', null, 'fetch failed'), captureRuleId: null
    });
    const meta = raw.prepare('SELECT http_status, responded_at, parse_status FROM meta_response').get() as Record<string, unknown>;
    expect(meta['http_status']).toBeNull();
    expect(meta['responded_at']).toBeNull();
    expect(meta['parse_status']).toBe('failed');
  });
});

describe('AC-2 — raw rows are never updated or deleted', () => {
  it('refuses both, through the database rather than by convention', () => {
    const host = makeHost();
    const run = beginRun(raw as unknown as SqliteLike, host, { kind: 'manual', tradingDate: '2026-09-06' });
    captureResponse({
      host, db: raw as unknown as SqliteLike, runId: run.runId, asOfDate: '2026-09-06',
      provider: 'polygon', endpoint: '/v3/reference/tickers/AAPL', slug: 'reference-tickers',
      params: { ticker: 'AAPL' },
      response: response(JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true } })),
      captureRuleId: ruleId(), ingest: ingestTickerReference
    });
    expect(() => raw.exec("UPDATE raw_ticker_reference SET name = 'Tampered'")).toThrow(/append-only/);
    expect(() => raw.exec('DELETE FROM raw_ticker_reference')).toThrow(/append-only/);
  });

  it('supersedes a fact with a new row, leaving the old one intact', () => {
    const host = makeHost();
    const db = raw as unknown as SqliteLike;
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const capture = (marketCap: number, observedAt: string) =>
      captureResponse({
        host, db, runId: run.runId, asOfDate: '2026-09-06', provider: 'polygon',
        endpoint: '/v3/reference/tickers/AAPL', slug: 'reference-tickers', params: { ticker: 'AAPL' },
        response: {
          status: 200,
          body: JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true, market_cap: marketCap } }),
          requestedAt: observedAt,
          respondedAt: observedAt
        },
        captureRuleId: ruleId(), ingest: ingestTickerReference
      });

    capture(3.0e12, '2026-09-06T17:05:00-04:00');
    capture(3.1e12, '2026-09-07T17:05:00-04:00');

    const rows = raw
      .prepare('SELECT market_cap, observed_at FROM raw_ticker_reference ORDER BY observed_at')
      .all() as { market_cap: number; observed_at: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.market_cap)).toEqual([3.0e12, 3.1e12]);
  });
});

describe('idempotence — for crash recovery and replay, and nothing more', () => {
  it('treats an identical response as a no-op', () => {
    const host = makeHost();
    const db = raw as unknown as SqliteLike;
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const args = {
      host, db, runId: run.runId, asOfDate: '2026-09-06', provider: 'polygon' as const,
      endpoint: '/v3/reference/tickers/AAPL', slug: 'reference-tickers', params: { ticker: 'AAPL' },
      response: response(JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true } })),
      captureRuleId: ruleId(), ingest: ingestTickerReference
    };
    const first = captureResponse(args);
    const second = captureResponse(args);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.sourceResponseId).toBe(first.sourceResponseId);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_ticker_reference').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_response').get()).toEqual({ n: 1 });
  });

  it('does NOT dedupe a different body for the same call — that is a new version, not a repeat', () => {
    const host = makeHost();
    const db = raw as unknown as SqliteLike;
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const base = {
      host, db, runId: run.runId, asOfDate: '2026-09-06', provider: 'polygon' as const,
      endpoint: '/v3/reference/tickers/AAPL', slug: 'reference-tickers', params: { ticker: 'AAPL' },
      captureRuleId: ruleId(), ingest: ingestTickerReference
    };
    captureResponse({ ...base, response: response(JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true, market_cap: 1 } })) });
    const second = captureResponse({ ...base, response: response(JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true, market_cap: 2 } })) });
    expect(second.deduplicated).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM raw_ticker_reference').get()).toEqual({ n: 2 });
  });
});

describe('the job queue — the entire interface between the two applications', () => {
  it('claims exactly once when two hosts race', () => {
    const db = raw as unknown as SqliteLike;
    const a = makeHost({ hostApp: { name: 'host-a', version: '1' } });
    const b = makeHost({ hostApp: { name: 'host-b', version: '1' } });
    queueJob(db, a, 'universe_seed');

    const first = claimNextJob(db, a);
    const second = claimNextJob(db, b);

    expect(first).toBeDefined();
    // The loser yields rather than retrying. The jobs this queue carries include
    // `reset`, which destroys a generation, so "both hosts ran it" is not a
    // tolerable outcome.
    expect(second).toBeUndefined();
    const row = raw.prepare('SELECT state, claimed_by_host FROM meta_job_request').get();
    expect(row).toEqual({ state: 'claimed', claimed_by_host: 'host-a 1' });
  });

  it('drains a backlog one per tick, oldest first', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    queueJob(db, host, 'universe_seed');
    queueJob(db, host, 'backfill_bars');
    const first = claimNextJob(db, host);
    const second = claimNextJob(db, host);
    expect(first?.runKind).toBe('universe_seed');
    expect(second?.runKind).toBe('backfill_bars');
    expect(claimNextJob(db, host)).toBeUndefined();
  });

  it('reports a request that has waited too long rather than retrying it', () => {
    // A stuck request means the collector host is not running. That is the
    // failure a queue introduces, and hiding it behind a spinner would make it
    // look like a slow job (P9). A silent retry would hide it better still.
    const db = raw as unknown as SqliteLike;
    queueJob(db, makeHost({ nowET: () => '2026-09-06T17:00:00-04:00' }), 'universe_seed');
    expect(stalledRequests(db, '2026-09-06T17:05:00-04:00')).toEqual([]);
    const stalled = stalledRequests(db, '2026-09-06T17:20:00-04:00');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.waitingMinutes).toBe(20);
  });

  it('records the outcome where the queueing app can read it, without a second channel', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const id = queueJob(db, host, 'universe_seed');
    claimNextJob(db, host);
    finishJob(db, host, id, { state: 'complete', result: { distinctTickers: 1089 } });
    const row = raw.prepare('SELECT state, result_json, error FROM meta_job_request').get() as Record<string, unknown>;
    expect(row['state']).toBe('complete');
    expect(JSON.parse(row['result_json'] as string)).toEqual({ distinctTickers: 1089 });
    expect(row['error']).toBeNull();
  });
});

describe('capture rules — a change is a new version, never an edit (P6)', () => {
  it('reuses the version in force while the definition is unchanged', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const a = captureRuleId(db, host, 'bars', { depthDays: 1 }, 'daily bars');
    const b = captureRuleId(db, host, 'bars', { depthDays: 1 }, 'daily bars');
    expect(b).toBe(a);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_capture_rule').get()).toEqual({ n: 1 });
  });

  it('opens a new version and closes the old one when the definition changes', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const v1 = captureRuleId(db, host, 'chain_subset', { minAvgDollarVolume20d: 20_000_000 }, 'drafted');
    const v2 = captureRuleId(db, host, 'chain_subset', { minAvgDollarVolume20d: 233_000_000 }, 'measured');
    expect(v2).not.toBe(v1);
    const rows = raw
      .prepare('SELECT version, valid_to FROM meta_capture_rule WHERE domain = ? ORDER BY version')
      .all('chain_subset') as { version: number; valid_to: string | null }[];
    // The old row keeps its definition, so a run recorded under it still says
    // what was actually being asked for at the time.
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]!.valid_to).not.toBeNull();
    expect(rows[1]!.valid_to).toBeNull();
  });
});

describe('preflight — what it is allowed to stop', () => {
  it('stops on a non-trading day', async () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    raw.exec(
      "INSERT INTO ref_trading_day (date, is_trading_day, is_monthly_expiration, source, observed_at) " +
        "VALUES ('2026-09-07', 0, 0, 'nyse_rules', 't')"
    );
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-07' });
    const outcome = await runPreflight(host, db, run);
    expect(outcome.proceed).toBe(false);
  });

  it('proceeds on an unknown date rather than treating a missing calendar as a holiday', async () => {
    // Refusing here would turn an unseeded reference table into silent data
    // loss. A needless run costs calls; a skipped one costs a day that cannot
    // be recovered.
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-08' });
    const outcome = await runPreflight(host, db, run);
    expect(outcome.proceed).toBe(true);
  });

  it('does NOT stop when the E*Trade probe fails — the gate says which phases suffered', async () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost({
      etradeGet: async () => response('<Error>oauth_problem=token_expired</Error>', 401)
    });
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-08' });
    const outcome = await runPreflight(host, db, run);
    expect(outcome.proceed).toBe(true);
    if (outcome.proceed) expect(outcome.etrade).toBe('unavailable');
    // And the failed probe is archived, because "we could not reach the
    // provider" is a fact about the day worth keeping.
    const meta = raw.prepare("SELECT http_status FROM meta_response WHERE endpoint LIKE '%SPY%'").get();
    expect(meta).toEqual({ http_status: 401 });
  });

  it('stops on a closed generation', async () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    raw.exec("UPDATE meta_generation SET status = 'closed'");
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-08' });
    const outcome = await runPreflight(host, db, run);
    expect(outcome.proceed).toBe(false);
    if (!outcome.proceed) expect(outcome.reason).toBe('generation_closed');
  });
});

describe('run lifecycle', () => {
  it('resumes the open run for the same day rather than starting a second one', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const first = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const second = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    expect(second.runId).toBe(first.runId);
    expect(second.resumed).toBe(true);
  });

  it('starts a new run for a re-run of a completed day — rows append, nothing is deleted', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const first = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    finishRun(db, host, first, 'complete', 'green');
    const second = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    expect(second.runId).not.toBe(first.runId);
    expect(second.resumed).toBe(false);
  });

  it('stamps the collector and dictionary versions replay equivalence depends on', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const row = raw.prepare('SELECT collector_version, dictionary_version, host_app FROM meta_run').get() as Record<string, unknown>;
    expect(row['collector_version']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof row['dictionary_version']).toBe('number');
    expect(row['host_app']).toBe('test-host');
  });
});

describe('universe membership — validity ranges, never an overwrite', () => {
  it('opens rows for new members and closes rows for departures', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const responseId = captureResponse({
      host, db, runId: run.runId, asOfDate: '2026-09-06', provider: 'polygon',
      endpoint: '/lists', slug: 'universe-sp500', params: {}, response: response('{}'),
      captureRuleId: null
    }).sourceResponseId;
    const ruleId = captureRuleId(db, host, 'universe', { lists: ['sp500'] }, 'test');

    const first = reconcileMembership(db, host, run, ruleId,
      [{ ticker: 'AAPL', listSource: 'sp500' }, { ticker: 'ENRN', listSource: 'sp500' }],
      responseId, 'initial');
    expect(first).toEqual({ opened: 2, closed: 0 });

    const second = reconcileMembership(db, host, run, ruleId,
      [{ ticker: 'AAPL', listSource: 'sp500' }, { ticker: 'NVDA', listSource: 'sp500' }], responseId);
    expect(second).toEqual({ opened: 1, closed: 1 });

    // The departure keeps its row with a closing date, so "who was in the
    // universe on 2026-09-06" stays answerable a year from now. The existing app
    // tracked additions only, which is why its drift figure could only ever be a
    // lower bound.
    const enron = raw
      .prepare("SELECT valid_from, valid_to, change_reason FROM ref_universe_membership WHERE ticker = 'ENRN'")
      .get() as Record<string, unknown>;
    expect(enron['valid_from']).toBe('2026-09-06');
    expect(enron['valid_to']).toBe('2026-09-06');
    expect(enron['change_reason']).toBe('index_drop');
  });

  it('lists one row per list a ticker appears in, so an overlap is visible', () => {
    // The three lists overlap almost entirely — 1,089 distinct tickers across
    // 1,587 rows. Storing the union only would lose which list admitted a
    // ticker, and that is exactly the confusion that made discovery record 1,587
    // as the universe size.
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-06' });
    const ruleId = captureRuleId(db, host, 'universe', { lists: ['sp500', 'russell1000'] }, 'test');
    const rid = captureResponse({
      host, db, runId: run.runId, asOfDate: '2026-09-06', provider: 'polygon',
      endpoint: '/lists', slug: 'universe-sp500', params: {}, response: response('{}'), captureRuleId: null
    }).sourceResponseId;

    reconcileMembership(db, host, run, ruleId, [
      { ticker: 'AAPL', listSource: 'sp500' },
      { ticker: 'AAPL', listSource: 'russell1000' }
    ], rid, 'initial');

    expect(raw.prepare('SELECT COUNT(*) AS n FROM ref_universe_membership').get()).toEqual({ n: 2 });
    expect(raw.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM ref_universe_membership').get()).toEqual({ n: 1 });
  });

  it('refreshes a reference row only when it is missing or past the heartbeat', () => {
    const db = raw as unknown as SqliteLike;
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-10-20' });
    captureResponse({
      host, db, runId: run.runId, asOfDate: '2026-09-06', provider: 'polygon',
      endpoint: '/v3/reference/tickers/AAPL', slug: 'reference-tickers', params: { ticker: 'AAPL' },
      response: {
        status: 200,
        body: JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true } }),
        requestedAt: '2026-09-06T17:00:00-04:00', respondedAt: '2026-09-06T17:00:00-04:00'
      },
      captureRuleId: ruleId(), ingest: ingestTickerReference
    });
    expect(referenceDue(db, '2026-09-20', ['AAPL', 'MSFT'])).toEqual(['MSFT']);
    expect(referenceDue(db, '2026-10-20', ['AAPL', 'MSFT'])).toEqual(['AAPL', 'MSFT']);
  });
});

describe('universe_seed', () => {
  it('seeds membership and reference, and reports what it did', async () => {
    const bodies: Record<string, string> = {
      '/lists/sp500': JSON.stringify({ tickers: ['AAPL', 'MSFT'] }),
      '/lists/russell1000': JSON.stringify({ tickers: ['AAPL', 'NVDA'] }),
      '/lists/etf': JSON.stringify({ tickers: ['SPY'] })
    };
    const host = makeHost({
      polygonGet: async (path) =>
        response(
          bodies[path] ??
            JSON.stringify({ results: { ticker: path.split('/').pop(), name: 'X', type: 'CS', active: true } })
        )
    });

    const report = await runUniverseSeed(host, {
      tradingDate: '2026-09-06',
      sources: [
        { listSource: 'sp500', endpoint: '/lists/sp500', params: {}, provider: 'polygon', fetch: () => host.polygonGet('/lists/sp500', {}), parse: (b) => JSON.parse(b).tickers },
        { listSource: 'russell1000', endpoint: '/lists/russell1000', params: {}, provider: 'polygon', fetch: () => host.polygonGet('/lists/russell1000', {}), parse: (b) => JSON.parse(b).tickers },
        { listSource: 'etf_list', endpoint: '/lists/etf', params: {}, provider: 'polygon', fetch: () => host.polygonGet('/lists/etf', {}), parse: (b) => JSON.parse(b).tickers }
      ]
    });

    expect(report.listsFetched).toBe(3);
    expect(report.distinctTickers).toBe(4); // AAPL, MSFT, NVDA, SPY
    expect(report.membershipsOpened).toBe(5); // AAPL appears in two lists
    expect(report.referenceFetched).toBe(4);
    expect(raw.prepare('SELECT status FROM meta_run WHERE run_id = ?').get(report.runId))
      .toEqual({ status: 'complete' });
  });

  it('accepts a list the HOST supplies, and archives it like any other', async () => {
    // The correction of 2026-09-07. The sources used to be Polygon queries,
    // which constrained the universe to what a Polygon query can express — and
    // Polygon has no index membership on this plan, so what shipped was every
    // US common stock, alphabetically truncated at 1,000, with MSFT and SPY
    // absent. The real lists were never remote; the host already holds them.
    const host = makeHost({
      polygonGet: async (path: string) =>
        response(JSON.stringify({ results: { ticker: path.split('/').pop(), name: 'X', type: 'CS', active: true } }))
    });

    const body = JSON.stringify({ tickers: ['MSFT', 'SPY'] });
    const report = await runUniverseSeed(host, {
      tradingDate: '2026-09-06',
      sources: [
        {
          listSource: 'sp500',
          endpoint: 'host:constituents/sp500',
          params: { source: 'constituents' },
          provider: 'host_app',
          // No network call at all — the host serialises what it already has.
          fetch: async () => ({
            status: 200, body, requestedAt: '2026-09-06T17:00:00-04:00',
            respondedAt: '2026-09-06T17:00:00-04:00'
          }),
          parse: (b: string) => JSON.parse(b).tickers as string[]
        }
      ]
    });

    expect(report.listsFetched).toBe(1);
    expect(report.distinctTickers).toBe(2);

    // Provenance is the point: the membership rows still point at real archived
    // bytes, attributed to the host rather than to a vendor that never saw them.
    const resp = raw
      .prepare("SELECT provider, endpoint, byte_length FROM meta_response WHERE provider = 'host_app'")
      .get() as { provider: string; endpoint: string; byte_length: number };
    expect(resp.provider).toBe('host_app');
    expect(resp.endpoint).toBe('host:constituents/sp500');
    expect(resp.byte_length).toBe(body.length);
  });

  it('refuses to reconcile when it got none of its lists', async () => {
    // An empty incoming set would close every existing member — a total wipe
    // caused by a network blip. Refusing is the only safe answer.
    const host = makeHost({ polygonGet: async () => response('', 503, 'upstream down') });
    await expect(
      runUniverseSeed(host, {
        tradingDate: '2026-09-06',
        sources: [{ listSource: 'sp500', endpoint: '/lists/sp500', params: {}, provider: 'polygon', fetch: () => host.polygonGet('/lists/sp500', {}), parse: () => [] }]
      })
    ).rejects.toThrow(/Refusing to reconcile membership against an empty set/);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM ref_universe_membership').get()).toEqual({ n: 0 });
  });
});

describe('ticker-reference ingestion — pure, and honest about what it does not know', () => {
  const ctx = {
    runId: 1, asOfDate: '2026-09-06', observedAt: '2026-09-06T17:00:00-04:00',
    captureRuleId: null, sourceResponseId: 1
  };

  it('records WHICH field the share count came from', () => {
    expect(pickShares({ weighted_shares_outstanding: 100, share_class_shares_outstanding: 90 }))
      .toEqual({ shares: 100, source: 'weighted' });
    expect(pickShares({ share_class_shares_outstanding: 90 }))
      .toEqual({ shares: 90, source: 'share_class' });
    expect(pickShares({})).toEqual({ shares: null, source: null });
  });

  it('zero-pads a CIK to the ten digits EDGAR expects', () => {
    expect(zeroPadCik('320193')).toBe('0000320193');
    expect(zeroPadCik('0000320193')).toBe('0000320193');
    expect(zeroPadCik(undefined)).toBeNull();
  });

  it('marks optionability outside_window rather than writing a 0 that reads as "no options"', () => {
    const rows = ingestTickerReference(
      JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true } }), ctx
    );
    expect(rows[0]!.values['optionable']).toBeNull();
    expect(rows[0]!.values['optionable_status']).toBe('outside_window');
  });

  it('marks an absent market cap omitted rather than zero', () => {
    const rows = ingestTickerReference(
      JSON.stringify({ results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true } }), ctx
    );
    expect(rows[0]!.values['market_cap']).toBeNull();
    expect(rows[0]!.values['market_cap_status']).toBe('omitted');
  });

  it('is deterministic — the same body gives byte-identical rows, which is what makes replay work', () => {
    const body = JSON.stringify({
      results: { ticker: 'AAPL', name: 'Apple', type: 'CS', active: true, market_cap: 1e12, cik: '320193' }
    });
    expect(JSON.stringify(ingestTickerReference(body, ctx)))
      .toBe(JSON.stringify(ingestTickerReference(body, ctx)));
  });

  it('returns nothing for a body with no ticker, rather than a row of nulls', () => {
    expect(ingestTickerReference(JSON.stringify({ results: {} }), ctx)).toEqual([]);
    expect(ingestTickerReference(JSON.stringify({}), ctx)).toEqual([]);
  });
});
