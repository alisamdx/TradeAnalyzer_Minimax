import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { beginRun, captureRuleId } from '../src/collector/run.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { barSettled, runBarsPhase } from '../src/collector/phases/market.js';
import { runR3FinalBarRefetch } from '../src/collector/remediation.js';
import { QC203_NON_FINAL_BAR } from '../src/qa/checks/bars.js';
import { runGate } from '../src/qa/gate.js';

/**
 * When a same-day bar is final (v1.1.287).
 *
 * Spec 02 and 04 set `is_final` from when the response ARRIVED: before 17:00 ET the day may still
 * be settling, at or after it the bar is final. The collector marked every same-day bar provisional
 * whatever the clock said, so QC-203 read "1083 of 1083 bars are still non-final at run end" on
 * every run of gen-002 — including run 22, which fetched at 18:23 ET.
 */

describe('barSettled', () => {
  it('turns at 17:00 ET in summer time (EDT, UTC-4)', () => {
    expect(barSettled('2026-09-18', '2026-09-18T20:59:59Z')).toBe(false); // 16:59:59 EDT
    expect(barSettled('2026-09-18', '2026-09-18T21:00:00Z')).toBe(true);  // 17:00 EDT
    expect(barSettled('2026-09-18', '2026-09-18T22:23:00.000Z')).toBe(true); // run 22, 18:23 EDT
  });

  it('turns at 17:00 ET in winter time (EST, UTC-5) — a fixed offset would be an hour out', () => {
    expect(barSettled('2026-12-01', '2026-12-01T21:59:00Z')).toBe(false); // 16:59 EST
    expect(barSettled('2026-12-01', '2026-12-01T22:00:00Z')).toBe(true);  // 17:00 EST
  });

  it('reads an offset timestamp as the instant it names', () => {
    expect(barSettled('2026-09-18', '2026-09-18T16:59:00-04:00')).toBe(false);
    expect(barSettled('2026-09-18', '2026-09-18T17:05:01-04:00')).toBe(true);
  });

  it('is final on any later ET date, and provisional with no response time', () => {
    // 01:30 UTC on the 19th is still the 18th in New York — and after 17:00 there.
    expect(barSettled('2026-09-18', '2026-09-19T01:30:00Z')).toBe(true);
    expect(barSettled('2026-09-18', '2026-09-20T14:00:00Z')).toBe(true);
    expect(barSettled('2026-09-18', null)).toBe(false);
    expect(barSettled('2026-09-18', 'not a time')).toBe(false);
  });
});

describe('the bars phase stores what the clock says', () => {
  const DATE = '2026-09-18';
  let dir: string;
  let raw: Database.Database;
  const db = (): SqliteLike => raw as unknown as SqliteLike;

  function host(respondedAt: string, now = '2026-09-18T18:23:00-04:00'): CollectorHost {
    const bars = JSON.stringify({ results: [
      { t: Date.parse('2026-09-17T17:00:00Z'), o: 99, h: 101, l: 98, c: 100, v: 1000.5 },
      { t: Date.parse('2026-09-18T17:00:00Z'), o: 100, h: 102, l: 99, c: 101, v: 1200.5 }
    ] });
    const reply = (body: string): ProviderResponse => ({ status: 200, body, requestedAt: respondedAt, respondedAt });
    return {
      openGenerationDb: () => db(),
      archiveRoot: () => join(dir, 'archive'),
      encryptForArchive: (b) => b,
      decryptFromArchive: (b) => b,
      polygonGet: async () => reply(bars),
      etradeGet: async () => reply('{}'),
      httpGet: async () => reply('{}'),
      nowET: () => now,
      sendEmail: async () => undefined,
      progress: () => undefined,
      signal: new AbortController().signal,
      hostApp: { name: 'test', version: '0' }
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ta-settle-'));
    resetOffsetCache();
    raw = new Database(join(dir, 'data.sqlite'));
    applyDictionary(db());
    raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1,'t','pilot','x','y')");
    const h = host('2026-09-18T18:23:00-04:00');
    const run = beginRun(db(), h, { kind: 'manual', tradingDate: DATE });
    const rule = captureRuleId(db(), h, 'universe', { v: 1 }, 'test');
    raw.exec(
      "INSERT INTO meta_response (source_response_id, run_id, provider, endpoint, params_json, requested_at, archive_file, archive_offset, dedup_hash, encrypted, at_provider_cap, parse_status) " +
        `VALUES (9001, ${run.runId}, 'polygon', '/x', '{}', 't', 'a', 0, 'seed', 0, 0, 'ok')`
    );
    raw.prepare(
      `INSERT INTO ref_universe_membership (run_id, as_of_date, observed_at, capture_rule_id, source_response_id,
         ticker, list_source, valid_from, valid_to, change_reason)
       VALUES (?, ?, 't', ?, 9001, 'SPY', 'sp500', '2021-01-01', NULL, 'initial')`
    ).run(run.runId, DATE, rule);
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);
  });

  afterEach(() => {
    raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function phaseAt(respondedAt: string) {
    const h = host(respondedAt);
    const run = beginRun(db(), h, { kind: 'daily', tradingDate: DATE });
    await runBarsPhase(h, db(), run);
    const finals = raw.prepare('SELECT trade_date, is_final FROM raw_daily_bar WHERE run_id = ? ORDER BY trade_date').all(run.runId);
    const qc203 = QC203_NON_FINAL_BAR.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
    return { finals, qc203 };
  }

  it('stores the after-close bar final, and QC-203 passes (run 22 fetched at 18:23 ET)', async () => {
    const { finals, qc203 } = await phaseAt('2026-09-18T22:23:00.000Z');
    expect(finals).toEqual([{ trade_date: '2026-09-17', is_final: 1 }, { trade_date: '2026-09-18', is_final: 1 }]);
    expect(qc203[0]!.fired).toBe(false);
  });

  it('closes an earlier date\'s finding whose bars all arrived after 17:00 ET, and keeps a morning run\'s', async () => {
    // gen-002: QC-203 fired on every run from 2026-09-14, each finding keyed by a date the check
    // never evaluates again. Run 8's bars arrived 17:59–18:00 EDT.
    const raiseOn = async (date: string, respondedAt: string) => {
      const h = host(respondedAt);
      const run = beginRun(db(), h, { kind: 'daily', tradingDate: date });
      await runBarsPhase(h, db(), run);
      runGate(db(), h, {
        runId: run.runId, tradingDate: date, domainsExpected: {},
        checks: [{ ...QC203_NON_FINAL_BAR, run: () => [{ key: date, value: 1, fired: true, detail: 'all non-final' }] }]
      });
      raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);
    };
    await raiseOn('2026-09-16', '2026-09-16T21:59:17.497Z'); // 17:59 EDT: settled
    await raiseOn('2026-09-17', '2026-09-17T14:33:00.000Z'); // 10:33 EDT: a morning run, genuinely provisional

    const h = host('2026-09-18T22:23:00.000Z');
    const today = beginRun(db(), h, { kind: 'daily', tradingDate: DATE });
    await runBarsPhase(h, db(), today);
    runGate(db(), h, { runId: today.runId, tradingDate: DATE, domainsExpected: {}, checks: [QC203_NON_FINAL_BAR] });

    const rows = Object.fromEntries(
      (raw.prepare("SELECT key, state, resolution_kind, resolution_note FROM qa_exception WHERE check_id = 'QC-203'").all() as
        { key: string; state: string; resolution_kind: string | null; resolution_note: string | null }[]).map((r) => [r.key, r])
    );
    expect(rows['2026-09-16']!.resolution_kind).toBe('rule_changed');
    expect(rows['2026-09-16']!.resolution_note).toContain('arrived 17:59–17:59 ET, after the 17:00 settlement window');
    expect(rows['2026-09-17']!.state).toBe('open');
    expect(rows['2026-09-18']).toBeUndefined(); // today's bars are final: nothing raised
  });

  it('R3 re-fetches a provisional bar once the window has closed, and QC-203 then passes (v1.1.288)', async () => {
    // A run that began before 17:00: phase 2 fetched at 16:40 EDT, the chain phase took the rest.
    const early = host('2026-09-18T20:40:00.000Z');
    const run = beginRun(db(), early, { kind: 'daily', tradingDate: DATE });
    await runBarsPhase(early, db(), run);
    expect(QC203_NON_FINAL_BAR.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' })[0]!.fired).toBe(true);

    const report = await runR3FinalBarRefetch(host('2026-09-18T21:45:00.000Z', '2026-09-18T17:45:00-04:00'), db(), run);
    expect(report).toEqual({ provisional: 1, refetched: 1, stillProvisional: 0 });
    // Append-only: the provisional row stays as the record of what was fetched first.
    expect(raw.prepare("SELECT is_final FROM raw_daily_bar WHERE run_id = ? AND trade_date = ? ORDER BY row_id").all(run.runId, DATE))
      .toEqual([{ is_final: 0 }, { is_final: 1 }]);
    expect(QC203_NON_FINAL_BAR.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' })[0]!.fired).toBe(false);
  });

  it('R3 re-fetches nothing while the window is open, and says so', async () => {
    const early = host('2026-09-18T20:40:00.000Z', '2026-09-18T16:50:00-04:00');
    const run = beginRun(db(), early, { kind: 'daily', tradingDate: DATE });
    await runBarsPhase(early, db(), run);
    const calls = raw.prepare('SELECT COUNT(*) AS n FROM meta_response').get() as { n: number };

    const report = await runR3FinalBarRefetch(early, db(), run);
    expect(report).toEqual({ provisional: 1, refetched: 0, stillProvisional: 1, windowOpenAt: '16:50' });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM meta_response').get()).toEqual(calls);
    expect(QC203_NON_FINAL_BAR.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' })[0]!.fired).toBe(true);
  });

  it('R3 has nothing to do after an after-close fetch', async () => {
    const late = host('2026-09-18T22:23:00.000Z');
    const run = beginRun(db(), late, { kind: 'daily', tradingDate: DATE });
    await runBarsPhase(late, db(), run);
    expect(await runR3FinalBarRefetch(late, db(), run)).toEqual({ provisional: 0, refetched: 0, stillProvisional: 0 });
  });

  // v1.1.351: VMRK joined the universe at the 2026-10-12 seed with no bars at all, and the nightly
  // phase only ever asked for five days, so its history before that would never have been fetched.
  it('fetches five years for a member with no history, once, then goes back to the five-day tail', async () => {
    const paths: string[] = [];
    const base = host('2026-09-18T22:23:00.000Z');
    const h: CollectorHost = { ...base, polygonGet: async (path, params) => { paths.push(path); return base.polygonGet(path, params); } };

    const first = beginRun(db(), h, { kind: 'daily', tradingDate: DATE });
    const counts = await runBarsPhase(h, db(), first);
    expect(paths).toEqual(['/v2/aggs/ticker/SPY/range/1/day/2021-09-18/2026-09-18']);
    expect(counts).toMatchObject({ expected: 1, failed: 0, backfilled: 1 });
    expect(raw.prepare('SELECT DISTINCT fetch_kind FROM raw_daily_bar WHERE run_id = ?').all(first.runId)).toEqual([{ fetch_kind: 'backfill' }]);
    raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(first.runId);

    paths.length = 0;
    const next = beginRun(db(), h, { kind: 'daily', tradingDate: '2026-09-21' });
    const again = await runBarsPhase(h, db(), next);
    expect(paths).toEqual(['/v2/aggs/ticker/SPY/range/1/day/2026-09-16/2026-09-21']);
    expect(again.backfilled).toBe(0);
  });

  it('stores a bar fetched before 17:00 ET provisional, and QC-203 still fires on it', async () => {
    const { finals, qc203 } = await phaseAt('2026-09-18T14:33:00.000Z'); // 10:33 EDT, a morning run
    expect(finals).toEqual([{ trade_date: '2026-09-17', is_final: 1 }, { trade_date: '2026-09-18', is_final: 0 }]);
    expect(qc203[0]!.fired).toBe(true);
  });
});
