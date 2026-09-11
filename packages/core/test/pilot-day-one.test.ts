import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost } from '../src/collector/host.js';
import { beginRun, captureRuleId, type RunHandle } from '../src/collector/run.js';
import { ensureTradingCalendar } from '../src/collector/trading-calendar.js';
import { QC001_PROVENANCE } from '../src/qa/checks/cross-cutting.js';
import { QC207_TRADING_DAY_GAP } from '../src/qa/checks/bars.js';

/**
 * Checks that fired on gen-001's first full run (2026-09-10) for a reason that
 * was the check's, not the data's. Each would have fired on every run, so no
 * pilot day could come out clean. QC-008 is pinned in events.test.ts and
 * QC-409 in chains-account.test.ts.
 */

let dir: string;
let raw: Database.Database;
const db = (): SqliteLike => raw as unknown as SqliteLike;
const DATE = '2026-09-10';

function makeHost(): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-10T19:33:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' }
  };
}

function ctx(run: RunHandle) {
  return { db: db(), runId: run.runId, tradingDate: DATE, observedAt: '2026-09-10T19:34:00-04:00' };
}

function response(run: RunHandle, id: number, parseStatus: 'ok' | 'failed'): void {
  raw.exec(
    'INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) ' +
      `VALUES (${id}, ${run.runId}, 'polygon', '/b', '{}', 't', 'a', ${id}, 'h-${id}', 0, 0, '${parseStatus}')`
  );
}

function bar(run: RunHandle, ruleId: number, src: number, ticker: string, date: string): void {
  raw.prepare(
    `INSERT INTO raw_daily_bar (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
       ticker, trade_date, open, high, low, close, volume, adjusted_as_of, fetch_kind, is_final)
     VALUES (?,?,?,?,?,?,?,100,101,99,100,1000000,?,'daily',1)`
  ).run(run.runId, DATE, 't', ruleId, src, ticker, date, DATE);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-day-one-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, '2026-09-09T20:57:00-04:00', 'pilot', 'x', 'y')"
  );
  ensureTradingCalendar(db(), makeHost(), DATE);
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('QC-001 reads only the layers whose rows are parsed from a response', () => {
  it('does not fire on a derived row, whose source response is null by definition', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    raw.prepare(
      `INSERT INTO derived_iv30_daily (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, iv30, iv30_status, near_expiration, far_expiration, near_iv, far_iv, derivation_version, status)
       VALUES (?, ?, 't', NULL, NULL, 'SPY', NULL, 'omitted', NULL, NULL, NULL, NULL, 1, 'insufficient_expirations')`
    ).run(run.runId, DATE);

    const fired = QC001_PROVENANCE.run(ctx(run)).filter((e) => e.fired);
    expect(fired).toEqual([]);
    expect(QC001_PROVENANCE.run(ctx(run)).map((e) => e.key)).not.toContain('derived_iv30_daily');
  });

  it('still fires on a raw row whose response failed to parse', () => {
    const host = makeHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const ruleId = captureRuleId(db(), host, 'bars', { depthDays: 1 }, 'test');
    response(run, 9200, 'failed');
    bar(run, ruleId, 9200, 'SPY', DATE);

    const fired = QC001_PROVENANCE.run(ctx(run)).filter((e) => e.fired);
    expect(fired.map((e) => e.key)).toEqual(['raw_daily_bar']);
  });
});

describe('QC-207 counts holes BETWEEN bars, not days before a series began', () => {
  function setup(dates: readonly string[]): RunHandle {
    const host = makeHost();
    const run = beginRun(db(), host, { kind: 'daily', tradingDate: DATE });
    const ruleId = captureRuleId(db(), host, 'bars', { depthDays: 1 }, 'test');
    response(run, 9100, 'ok');
    for (const d of dates) bar(run, ruleId, 9100, 'SPY', d);
    return run;
  }

  it('a series that began inside the window is not a gap', () => {
    // gen-001: three bars per ticker, and 17 "missing days" each before the fix.
    const run = setup(['2026-09-08', '2026-09-09', '2026-09-10']);
    const [e] = QC207_TRADING_DAY_GAP.run(ctx(run));
    expect(e).toMatchObject({ key: 'SPY', value: 0, fired: false });
  });

  it('a hole in the middle still fires — and Labor Day is not one', () => {
    // 2026-09-07 is Labor Day; 09-08 is the real hole.
    const run = setup(['2026-09-03', '2026-09-04', '2026-09-09', '2026-09-10']);
    const [e] = QC207_TRADING_DAY_GAP.run(ctx(run));
    expect(e).toMatchObject({ key: 'SPY', value: 1, fired: true });
    expect(e?.evidence).toMatchObject({ missing: ['2026-09-08'] });
  });
});
