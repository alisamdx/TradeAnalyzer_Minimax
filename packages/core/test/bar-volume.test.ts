import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { runBackfillBars } from '../src/collector/backfill.js';
import { QC205_VOLUME_REGIME, volumeRegimeAroundSteps, REGIME_WINDOW } from '../src/qa/checks/bars.js';
import { makeBarIngest, volumeOrNull } from '../src/ingest/market.js';
import { sessionOnOrBefore } from '../src/collector/trading-calendar.js';

/**
 * Bar volume, end to end — the 2026-09-12 finding.
 *
 * gen-001's AAPL bar read `volume 0` beside `transactions 1,225,501`. Polygon's
 * daily `v` is fractional (it counts fractional-share trades); the parser
 * asserted integrality, "failed", and wrote 0. QC-205 skipped every zero median
 * and so evaluated nothing on three backfills, and the chain subset computed
 * dollar volume as `close × 0` and admitted nobody. Every fixture before this
 * one used a whole-number volume, which is why no test saw any of it.
 */

let dir: string;
let raw: Database.Database;
let db: SqliteLike;

const DAY = 86_400_000;
const START = Date.parse('2026-01-05T17:00:00Z');

function makeHost(polygonGet: CollectorHost['polygonGet']): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet,
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-11T18:00:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' }
  };
}

function seedUniverse(tickers: readonly string[]): void {
  const host = makeHost(async () => ({ status: 200, body: '{"results":[]}', requestedAt: 't', respondedAt: 't' }));
  const run = beginRun(db, host, { kind: 'manual', tradingDate: '2026-09-11' });
  const ruleId = captureRuleId(db, host, 'universe', { lists: ['sp500'] }, 'test');
  raw.exec(
    "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
      `VALUES (9001, ${run.runId}, 'polygon', '/x', '{}', 't', 'a', 0, 'seed-hash', 0, 0, 'ok')`
  );
  for (const t of tickers) {
    raw.prepare(
      `INSERT INTO ref_universe_membership (
         run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, list_source, valid_from, valid_to, change_reason
       ) VALUES (?,?,?,?,?,?, 'sp500', '2021-01-01', NULL, 'initial')`
    ).run(run.runId, '2026-09-11', 't', ruleId, 9001, t);
  }
}

interface Leg { readonly count: number; readonly close: number; readonly volume: number }

/** A Polygon aggs body built from consecutive legs, every volume fractional. */
function aggs(legs: readonly Leg[]): string {
  const results: unknown[] = [];
  let i = 0;
  for (const leg of legs) {
    for (let k = 0; k < leg.count; k++, i++) {
      results.push({ t: START + i * DAY, o: leg.close, h: leg.close, l: leg.close, c: leg.close, v: leg.volume, n: 100 });
    }
  }
  return JSON.stringify({ results });
}

/** The same legs as the pure function reads them. */
function series(legs: readonly Leg[]): { ticker: string; trade_date: string; close: number; volume: number | null }[] {
  const out: { ticker: string; trade_date: string; close: number; volume: number | null }[] = [];
  let i = 0;
  for (const leg of legs) {
    for (let k = 0; k < leg.count; k++, i++) {
      out.push({ ticker: 'X', trade_date: new Date(START + i * DAY).toISOString().slice(0, 10), close: leg.close, volume: leg.volume });
    }
  }
  return out;
}

const REUSE: readonly Leg[] = [
  { count: 30, close: 2, volume: 1_000.5 },
  { count: 30, close: 90, volume: 5_000_000.25 }
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-bar-volume-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the bar parser keeps volume as Polygon sends it', () => {
  const ctx = { runId: 1, observedAt: 't', captureRuleId: 1 } as unknown as Parameters<ReturnType<typeof makeBarIngest>>[1];
  const ingest = makeBarIngest({ ticker: 'AAPL', fetchKind: 'backfill', adjustedAsOf: '2026-09-11' });

  it('stores a fractional volume exactly, not as 0', () => {
    const rows = ingest(JSON.stringify({ results: [{ t: START, c: 326.57, v: 54_321_987.35, n: 1_225_501 }] }), ctx);
    expect(rows[0]!.values['volume']).toBe(54_321_987.35);
  });

  it('stores an absent volume as null, never 0', () => {
    const rows = ingest(JSON.stringify({ results: [{ t: START, c: 326.57 }] }), ctx);
    expect(rows[0]!.values['volume']).toBeNull();
  });

  it('keeps a genuine zero and refuses what is not a usable number', () => {
    expect(volumeOrNull(0)).toBe(0);
    expect(volumeOrNull('1000')).toBeNull();
    expect(volumeOrNull(-5)).toBeNull();
    expect(volumeOrNull(Number.NaN)).toBeNull();
  });

  it('writes the fractional value through the real schema', async () => {
    seedUniverse(['AAPL']);
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200,
      body: path.includes('/splits') ? '{"results":[]}' : aggs([{ count: 3, close: 326.57, volume: 54_321_987.35 }]),
      requestedAt: 't', respondedAt: 't'
    }));
    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    const vols = raw.prepare('SELECT DISTINCT volume, typeof(volume) AS kind FROM raw_daily_bar').all();
    expect(vols).toEqual([{ volume: 54_321_987.35, kind: 'real' }]);
  });
});

describe('QC-205 measures volume AROUND each discontinuity', () => {
  it('fires on the reuse signature with fractional volumes', () => {
    const out = volumeRegimeAroundSteps(series(REUSE), 0.4, 15);
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(true);
    expect(out[0]!.value).toBeCloseTo(5_000_000.25 / 1_000.5, 6);
  });

  it('measures a genuine move without firing, so the distribution holds it', () => {
    const out = volumeRegimeAroundSteps(
      series([{ count: 30, close: 100, volume: 1_000_000.5 }, { count: 30, close: 50, volume: 3_000_001.5 }]),
      0.4, 15
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.fired).toBe(false);
    expect(out[0]!.value).toBeCloseTo(3, 5);
  });

  it('does not estimate a step younger than a full window', () => {
    const young = series([{ count: 30, close: 100, volume: 1_000.5 }, { count: REGIME_WINDOW - 1, close: 50, volume: 9_000_000.5 }]);
    expect(volumeRegimeAroundSteps(young, 0.4, 15)).toEqual([]);
  });

  it('finds a step deep in the history, not only at the tail', () => {
    // The first version compared the last 20 rows with the 20 before them, so a
    // reuse two years back was invisible by construction.
    const deep = series([...REUSE, { count: 400, close: 90, volume: 5_000_000.25 }]);
    const out = volumeRegimeAroundSteps(deep, 0.4, 15);
    expect(out.map((e) => e.fired)).toEqual([true]);
    expect(out[0]!.affects).toEqual([deep[30]!.trade_date]);
  });

  it('evaluates after a real backfill — Evaluated 0 is what gen-001 read on all three runs', async () => {
    seedUniverse(['BNY']);
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200, body: path.includes('/splits') ? '{"results":[]}' : aggs(REUSE), requestedAt: 't', respondedAt: 't'
    }));
    const report = await runBackfillBars(host, { tradingDate: '2026-09-11' });
    expect(report.reviewQueue.filter((q) => q.checkId === 'QC-205')).toHaveLength(1);
  });

  it('reads the latest version of each day, so stacked backfills are still one series', async () => {
    seedUniverse(['BNY']);
    let afterVolume = 5_000_000.25;
    const host = makeHost(async (path): Promise<ProviderResponse> => ({
      status: 200,
      body: path.includes('/splits')
        ? '{"results":[]}'
        : aggs([REUSE[0]!, { count: 30, close: 90, volume: afterVolume }]),
      requestedAt: 't', respondedAt: 't'
    }));
    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    afterVolume = 3_000_000.75;
    await runBackfillBars(host, { tradingDate: '2026-09-11' });
    afterVolume = 2_000_000.5;
    const last = await runBackfillBars(host, { tradingDate: '2026-09-11' });

    expect(raw.prepare("SELECT COUNT(*) AS n FROM raw_daily_bar WHERE ticker = 'BNY'").get()).toEqual({ n: 180 });
    const out = QC205_VOLUME_REGIME.run({ db, runId: last.runId, tradingDate: '2026-09-11', observedAt: 't' });
    // One step, measured once, on the newest observation of every day.
    expect(out).toHaveLength(1);
    expect(out[0]!.value).toBeCloseTo(2_000_000.5 / 1_000.5, 6);
  });
});

describe('a one-shot job is dated to its session, not the calendar', () => {
  it('maps a weekend to the Friday before it', () => {
    // Run 9 of gen-001 started 01:35 on Saturday 2026-09-12 and recorded that date.
    expect(sessionOnOrBefore('2026-09-12')).toBe('2026-09-11');
    expect(sessionOnOrBefore('2026-09-13')).toBe('2026-09-11');
  });

  it('keeps a session as itself', () => {
    expect(sessionOnOrBefore('2026-09-14')).toBe('2026-09-14');
  });

  it('skips a rule holiday and an unscheduled closure', () => {
    expect(sessionOnOrBefore('2026-04-03')).toBe('2026-04-02'); // Good Friday
    expect(sessionOnOrBefore('2025-01-09')).toBe('2025-01-08'); // National Day of Mourning
  });
});
