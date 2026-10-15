import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost, ProviderResponse } from '../src/collector/host.js';
import { resetOffsetCache } from '../src/collector/archive.js';
import { beginRun, finishRun, type RunHandle } from '../src/collector/run.js';
import { runDaily } from '../src/collector/daily.js';
import { ensureTradingCalendar } from '../src/collector/trading-calendar.js';
import { DAILY_PHASES, recordNotReached, recordPhase } from '../src/collector/run-phase.js';
import { QC006_RUN_COMPLETENESS, QC105_CALENDAR_COVERAGE } from '../src/qa/checks/cross-cutting.js';
import { runGate } from '../src/qa/gate.js';

/**
 * QC-006 run completeness and QC-105 calendar coverage (v1.1.361).
 *
 * The daily run catches a phase that throws so the rest can run. Until v1.1.361 the catch only
 * appended to an array `runDaily` returned and nothing stored, so a crashed phase left its domain
 * looking like a quiet day to every check, the email and every rehearsal.
 */

let dir: string;
let raw: Database.Database;
const DATE = '2026-10-14';

const db = (): SqliteLike => raw as unknown as SqliteLike;
const ok = (body = '{}'): ProviderResponse => ({ status: 200, body, requestedAt: `${DATE}T21:00:00Z`, respondedAt: `${DATE}T21:00:01Z` });

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => db(),
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    decryptFromArchive: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    polygonGet: async () => ok('{"results":[]}'),
    etradeGet: async () => ok(),
    httpGet: async () => ok(),
    nowET: () => `${DATE}T17:30:00-04:00`,
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test-host', version: '0.0.0' },
    ...overrides
  };
}

const phases = (runId: number) =>
  raw.prepare('SELECT phase, status, error FROM meta_run_phase WHERE run_id = ? ORDER BY phase_row_id').all(runId) as {
    phase: string; status: string; error: string | null;
  }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-qc006-'));
  raw = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db());
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (2, '2026-09-11T00:00:00-04:00', 'pilot', 'x', 'y')"
  );
  resetOffsetCache();
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A host whose E*Trade calls throw (a transport fault, not an error response) and whose Treasury fetch does too. */
const brokenHost = () =>
  makeHost({
    etradeGet: async () => { throw new Error('socket hang up'); },
    httpGet: async (url: string) => {
      if (url.includes('treasury')) throw new Error('ECONNRESET');
      return ok();
    }
  });

const exception = (key: string) =>
  raw.prepare("SELECT severity, state, domain, resolution_kind, affects_trading_dates_json AS affects FROM qa_exception WHERE check_id = 'QC-006' AND key = ?").get(key) as
    { severity: string; state: string; domain: string; resolution_kind: string | null; affects: string } | undefined;

describe('QC-006 — run completeness', () => {
  it('records every scheduled phase and each sub-phase, and blocks on the ones that threw', async () => {
    const report = await runDaily(brokenHost(), { tradingDate: DATE });
    const rows = phases(report.runId);

    // Every scheduled top-level phase has a row, in order, and each phase-8 sub-phase has its own.
    expect(rows.filter((r) => !r.phase.startsWith('events/')).map((r) => r.phase)).toEqual([...DAILY_PHASES]);
    expect(rows.filter((r) => r.phase.startsWith('events/')).length).toBeGreaterThanOrEqual(12);

    const failed = rows.filter((r) => r.status !== 'ok').map((r) => [r.phase, r.status, r.error]);
    expect(failed).toEqual([
      ['account', 'failed', 'socket hang up'],
      ['events/index-quotes', 'failed', 'socket hang up'],
      ['events/treasury', 'failed', 'ECONNRESET']
    ]);

    // The gate turned exactly those into blocking findings on this date and no other.
    expect(exception(`${DATE} account`)).toMatchObject({ severity: 'blocking', state: 'open', domain: 'cross_cutting', affects: `["${DATE}"]` });
    expect(exception(`${DATE} events/treasury`)).toMatchObject({ severity: 'blocking', state: 'open' });
    expect(exception(`${DATE} bars`)).toBeUndefined();
  });

  it('closes a finding data_corrected when a later run collects the same date cleanly', async () => {
    await runDaily(brokenHost(), { tradingDate: DATE });
    expect(exception(`${DATE} account`)?.state).toBe('open');

    await runDaily(makeHost(), { tradingDate: DATE });
    expect(exception(`${DATE} account`)).toMatchObject({ state: 'resolved', resolution_kind: 'data_corrected' });
    expect(exception(`${DATE} events/treasury`)).toMatchObject({ state: 'resolved', resolution_kind: 'data_corrected' });
  });

  it('leaves a missed day open when the next run is for a different date — its hole is real', async () => {
    await runDaily(brokenHost(), { tradingDate: DATE });
    await runDaily(makeHost({ nowET: () => '2026-10-15T17:30:00-04:00' }), { tradingDate: '2026-10-15' });
    expect(exception(`${DATE} account`)?.state).toBe('open');
    expect(exception('2026-10-15 account')).toBeUndefined();
  });

  it('reports a cancelled phase and every phase after it, as rows rather than absences', () => {
    const run: RunHandle = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    const t = `${DATE}T17:30:00-04:00`;
    expect(recordPhase(db(), run.runId, 'bars', { status: 'ok', startedAt: t, finishedAt: t })).toBeNull();
    expect(recordPhase(db(), run.runId, 'quotes', { status: 'cancelled', startedAt: t, finishedAt: t, error: 'cancelled' })).toBeNull();
    expect(recordNotReached(db(), run.runId)).toBe(DAILY_PHASES.length - 2);

    const fired = QC006_RUN_COMPLETENESS.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: t }).filter((e) => e.fired);
    expect(fired.map((e) => e.key)).toEqual(DAILY_PHASES.slice(1).map((p) => `${DATE} ${p}`));
    expect(fired[0]?.detail).toContain('was cancelled');
    expect(fired[1]?.detail).toContain('was never reached');
  });

  it('evaluates nothing on a run that wrote no phase rows (a backfill, a one-shot, a pre-v1.1.361 run)', () => {
    const run = beginRun(db(), makeHost(), { kind: 'manual', tradingDate: DATE });
    expect(QC006_RUN_COMPLETENESS.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' })).toEqual([]);
  });

  it('a failed bookkeeping write is returned to the caller, never thrown into the run', () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    const t = `${DATE}T17:30:00-04:00`;
    expect(recordPhase(db(), run.runId, 'bars', { status: 'ok', startedAt: t, finishedAt: t })).toBeNull();
    // (run_id, phase) is unique: a second write for the same phase is refused by the schema.
    expect(recordPhase(db(), run.runId, 'bars', { status: 'ok', startedAt: t, finishedAt: t })).toMatch(/UNIQUE/);
  });
});

describe('QC-105 — calendar coverage', () => {
  const run105 = () => {
    const run = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    return QC105_CALENDAR_COVERAGE.run({ db: db(), runId: run.runId, tradingDate: DATE, observedAt: 't' });
  };

  it('is quiet on the calendar preflight seeds, and says how far it looked', () => {
    ensureTradingCalendar(db(), makeHost(), DATE);
    const [e] = run105();
    expect(e).toMatchObject({ key: 'ref_trading_day', value: 0, fired: false, closesAs: { kind: 'data_corrected' } });
    expect(e?.evidence).toMatchObject({ from: '2021-10-14', to: '2027-01-12' });
  });

  it('fires on a hole inside the window and names its ends', () => {
    ensureTradingCalendar(db(), makeHost(), DATE);
    raw.prepare("DELETE FROM ref_trading_day WHERE date BETWEEN '2026-12-24' AND '2026-12-26'").run();
    const [e] = run105();
    expect(e).toMatchObject({ value: 3, fired: true });
    expect(e?.detail).toContain('first 2026-12-24, last 2026-12-26');
  });

  it('fires on an empty calendar, the state in which every weekend reads as a session', () => {
    const [e] = run105();
    expect(e?.fired).toBe(true);
    expect(e?.value).toBe(1917); // 2021-10-14 .. 2027-01-12 inclusive
  });

  it('opens a blocking finding through the gate, and the reseeded calendar closes it next run', () => {
    const first = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    runGate(db(), makeHost(), { runId: first.runId, tradingDate: DATE, checks: [QC105_CALENDAR_COVERAGE] });
    const open = () => raw.prepare("SELECT severity, state, resolution_kind FROM qa_exception WHERE check_id = 'QC-105'").get();
    expect(open()).toMatchObject({ severity: 'blocking', state: 'open' });

    finishRun(db(), makeHost(), first, 'complete');   // else beginRun resumes it
    ensureTradingCalendar(db(), makeHost(), DATE);
    const second = beginRun(db(), makeHost(), { kind: 'daily', tradingDate: DATE });
    runGate(db(), makeHost(), { runId: second.runId, tradingDate: DATE, checks: [QC105_CALENDAR_COVERAGE] });
    expect(open()).toMatchObject({ state: 'resolved', resolution_kind: 'data_corrected' });
  });
});
