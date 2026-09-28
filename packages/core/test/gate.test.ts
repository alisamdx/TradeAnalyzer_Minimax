import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { CollectorHost } from '../src/collector/host.js';
import { beginRun } from '../src/collector/run.js';
import { validateDefinition, summarise, type CheckDefinition } from '../src/qa/check.js';
import {
  runGate, syncRegistry, markNotRun, cleanDayStreak, fingerprint, recomputeDomainDayStatus
} from '../src/qa/gate.js';
import { buildStatusEmail, buildNoRunEmail } from '../src/qa/email.js';
import { ALL_CHECKS } from '../src/qa/registry.js';
import { QC409_STICKY_SET_HONOURED } from '../src/qa/checks/chains.js';

let dir: string;
let raw: Database.Database;
let db: SqliteLike;

function makeHost(overrides: Partial<CollectorHost> = {}): CollectorHost {
  return {
    openGenerationDb: () => db,
    archiveRoot: () => join(dir, 'archive'),
    encryptForArchive: (b) => b,
    decryptFromArchive: (b) => b,
    polygonGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    etradeGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    httpGet: async () => ({ status: 200, body: '{}', requestedAt: 't', respondedAt: 't' }),
    nowET: () => '2026-09-06T18:30:00-04:00',
    sendEmail: async () => undefined,
    progress: () => undefined,
    signal: new AbortController().signal,
    hostApp: { name: 'test', version: '0' },
    ...overrides
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-gate-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  raw.exec(
    "INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) " +
      "VALUES (1, 't', 'pilot', 'x', 'y')"
  );
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A check whose evaluations the test controls exactly. */
function fakeCheck(over: Partial<CheckDefinition> & { evals: () => ReturnType<CheckDefinition['run']> }): CheckDefinition {
  const { evals, ...rest } = over;
  return {
    id: 'QC-901',
    domain: 'test',
    severity: 'warning',
    description: 'A synthetic check used only by the gate tests, with controlled evaluations.',
    readsTables: ['raw_daily_bar'],
    testedQuantity: 'synthetic_value',
    testedUnit: 'fraction',
    thresholds: { limit: 1 },
    thresholdBasis: 'working',
    run: () => evals(),
    ...rest
  } as CheckDefinition;
}

describe('every registered check is well formed', () => {
  it('passes its own definition validation', () => {
    const problems = ALL_CHECKS.flatMap((c) => validateDefinition(c));
    expect(problems).toEqual([]);
  });

  it('gives every check a unique id', () => {
    const ids = ALL_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names the evidence behind every threshold it calls measured', () => {
    // A "measured" threshold with no evidence is a guess wearing a badge.
    for (const c of ALL_CHECKS.filter((x) => x.thresholdBasis === 'measured')) {
      expect(c.thresholdEvidence, `${c.id}`).toBeTruthy();
      expect((c.thresholdEvidence ?? '').length).toBeGreaterThan(40);
    }
  });

  it('declares a unit for every magnitude and none for any predicate', () => {
    for (const c of ALL_CHECKS) {
      if (c.testedQuantity === null) expect(c.testedUnit, `${c.id}`).toBeNull();
      else expect(c.testedUnit, `${c.id}`).not.toBeNull();
    }
  });
});

describe('P10 — the distribution is recorded, not just the fires', () => {
  it('records the distribution of every evaluation, including the ones that did not fire', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const check = fakeCheck({
      evals: () => [
        { key: 'a', value: 0.1, fired: false },
        { key: 'b', value: 0.2, fired: false },
        { key: 'c', value: 0.9, fired: false },
        { key: 'd', value: 1.5, fired: true, detail: 'over the limit' }
      ]
    });

    runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [check] });

    const row = raw
      .prepare('SELECT evaluated_count, fired_count, distribution_json, extreme_keys_json FROM qa_check_result WHERE check_id = ?')
      .get('QC-901') as Record<string, unknown>;

    expect(row['evaluated_count']).toBe(4);
    expect(row['fired_count']).toBe(1);

    const dist = JSON.parse(row['distribution_json'] as string) as Record<string, number>;
    expect(dist['n']).toBe(4);
    expect(dist['min']).toBe(0.1);
    expect(dist['max']).toBe(1.5);
    expect(dist['threshold']).toBe(1);
    // Only 0.9 is within 25 % of the threshold; 1.5 is 50 % above it. This count
    // is what says whether the boundary sits where the data actually is.
    expect(dist['nearBoundary']).toBe(1);

    // The extremes include values that did NOT fire. Those are the rows a
    // threshold review needs, and exactly the ones a fired-only record discards.
    const extremes = JSON.parse(row['extreme_keys_json'] as string) as { key: string; value: number }[];
    expect(extremes.map((e) => e.key)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('makes a decorative threshold visible: many evaluations, zero near the boundary', () => {
    // This is the conviction-band failure reproduced deliberately. The check
    // never fires — and without the distribution that is indistinguishable from
    // a clean system. With it, `nearBoundary: 0` against `n: 50` and a max two
    // orders of magnitude below the threshold says the check cannot fire.
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const check = fakeCheck({
      thresholds: { limit: 100 },
      evals: () => Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, value: 0.5 + i / 100, fired: false }))
    });

    const result = runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [check] });
    expect(result.verdict).toBe('green');

    const dist = JSON.parse(
      (raw.prepare('SELECT distribution_json FROM qa_check_result WHERE check_id = ?').get('QC-901') as { distribution_json: string }).distribution_json
    ) as Record<string, number>;

    expect(dist['n']).toBe(50);
    expect(dist['nearBoundary']).toBe(0);
    expect(dist['max']).toBeLessThan(dist['threshold']! / 50);
  });

  it('stores no distribution for a predicate check, and the registry says why', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const check = fakeCheck({
      id: 'QC-902', testedQuantity: null, testedUnit: null, thresholds: {},
      thresholdBasis: 'not_applicable',
      evals: () => [{ key: 'table', fired: false }]
    });
    runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [check] });

    const row = raw
      .prepare('SELECT distribution_json, extreme_keys_json FROM qa_check_result WHERE check_id = ?')
      .get('QC-902') as Record<string, unknown>;
    expect(row['distribution_json']).toBeNull();
    expect(row['extreme_keys_json']).toBeNull();

    const reg = raw
      .prepare('SELECT tested_quantity, tested_unit FROM qa_check_registry WHERE check_id = ?')
      .get('QC-902') as Record<string, unknown>;
    expect(reg['tested_quantity']).toBeNull();
    expect(reg['tested_unit']).toBeNull();
  });

  it('summarises an empty set as no distribution rather than as zeroes', () => {
    // Zeroes would read as "measured, and everything was 0".
    expect(summarise([], 1)).toBeNull();
  });
});

describe('exceptions are facts about the data, not about the run', () => {
  it('keeps the same fingerprint across runs rather than raising a new one', () => {
    const host = makeHost();
    const check = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });

    for (const date of ['2026-09-04', '2026-09-05', '2026-09-06']) {
      const run = beginRun(db, host, { kind: 'daily', tradingDate: date });
      runGate(db, host, { runId: run.runId, tradingDate: date, checks: [check] });
      raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);
    }

    const rows = raw.prepare('SELECT fingerprint, consecutive_runs, severity FROM qa_exception').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!['fingerprint']).toBe(fingerprint('QC-901', 'test', 'AAPL'));
    expect(rows[0]!['consecutive_runs']).toBe(3);
    // Three consecutive runs promotes it one level (03 §5.4).
    expect(rows[0]!['severity']).toBe('blocking');
  });

  it('leaves an exception OPEN when it stops firing without a remediation', () => {
    // "It went away" is exactly how the earnings-date bug hid for a quarter.
    const host = makeHost();
    const firing = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });
    const clean = fakeCheck({ evals: () => [{ key: 'AAPL', value: 0.1, fired: false }] });

    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-05', checks: [firing] });
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);

    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-06', checks: [clean] });

    const row = raw.prepare('SELECT state, still_firing FROM qa_exception').get() as Record<string, unknown>;
    expect(row['state']).toBe('open');
    expect(row['still_firing']).toBe(0);
  });

  it('resolves only when a remediation succeeded AND the check evaluates clean', () => {
    const host = makeHost();
    const firing = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });
    const clean = fakeCheck({ evals: () => [{ key: 'AAPL', value: 0.1, fired: false }] });

    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-05', checks: [firing] });
    raw.prepare(`UPDATE qa_exception SET remediations_json = '[{"code":"R5","outcome":"success"}]'`).run();
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);

    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const result = runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-06', checks: [clean] });

    expect(result.resolvedByGate).toBe(1);
    const row = raw.prepare('SELECT state, resolution_kind FROM qa_exception').get() as Record<string, unknown>;
    expect(row['state']).toBe('resolved');
    expect(row['resolution_kind']).toBe('data_corrected');
  });

  it('does NOT resolve when the remediation succeeded but the check never evaluated the key', () => {
    // v1.1.278: absent from the evaluations is unobserved, not clean. Before, a run that did not
    // cover the key (ticker not collected, a deduplicated fetch that stored nothing) closed the
    // finding as data_corrected on no evidence.
    const host = makeHost();
    const firing = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });
    const elsewhere = fakeCheck({ evals: () => [{ key: 'MSFT', value: 0.1, fired: false }] });

    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-05', checks: [firing] });
    raw.prepare(`UPDATE qa_exception SET remediations_json = '[{"code":"R5","outcome":"success"}]'`).run();
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);

    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const result = runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-06', checks: [elsewhere] });

    expect(result.resolvedByGate).toBe(0);
    const row = raw.prepare(`SELECT state, still_firing FROM qa_exception WHERE key = 'AAPL'`).get() as Record<string, unknown>;
    expect(row['state']).toBe('open');
    expect(row['still_firing']).toBe(0);
  });

  it('does NOT resolve when the check threw, whatever it evaluated before', () => {
    const host = makeHost();
    const firing = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });
    const broken = fakeCheck({ evals: () => { throw new Error('no such column'); } });

    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-05', checks: [firing] });
    raw.prepare(`UPDATE qa_exception SET remediations_json = '[{"code":"R5","outcome":"success"}]'`).run();
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);

    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-06', checks: [broken] });

    const row = raw.prepare(`SELECT state FROM qa_exception WHERE key = 'AAPL'`).get() as Record<string, unknown>;
    expect(row['state']).toBe('open');
  });

  it('reopens the same exception on recurrence rather than raising a second', () => {
    const host = makeHost();
    const firing = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });

    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-04' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-04', checks: [firing] });
    raw.prepare("UPDATE qa_exception SET state='resolved', resolved_at='t'").run();
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);

    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-05', checks: [firing] });

    expect(raw.prepare('SELECT COUNT(*) AS n FROM qa_exception').get()).toEqual({ n: 1 });
    const row = raw.prepare('SELECT state, consecutive_runs FROM qa_exception').get() as Record<string, unknown>;
    expect(row['state']).toBe('open');
    expect(row['consecutive_runs']).toBe(1);
    const events = raw.prepare("SELECT note FROM qa_exception_event WHERE to_state='open' ORDER BY row_id").all() as { note: string }[];
    expect(events.some((e) => e.note.includes('recurrence'))).toBe(true);
  });

  /** Runs the gate once per date with `checks`, closing each run. */
  function runDays(host: CollectorHost, dates: readonly string[], checks: () => CheckDefinition[]): void {
    for (const date of dates) {
      const run = beginRun(db, host, { kind: 'daily', tradingDate: date });
      runGate(db, host, { runId: run.runId, tradingDate: date, checks: checks() });
      raw.prepare("UPDATE meta_run SET status = 'complete' WHERE run_id = ?").run(run.runId);
    }
  }
  const sev = (): Record<string, unknown> =>
    raw.prepare('SELECT severity, consecutive_runs, state FROM qa_exception').get() as Record<string, unknown>;

  // v1.1.328: on 2026-09-25, 10 QC-410 findings (AIZ, PCTY, …) reopened as BLOCKING with
  // consecutive_runs = 1 — the escalation survived the resolution that should have ended it.
  it('starts a recurrence from the base severity, and re-earns the escalation', () => {
    const host = makeHost();
    const firing = () => [fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] })];
    runDays(host, ['2026-09-02', '2026-09-03', '2026-09-04'], firing);
    expect(sev()).toMatchObject({ severity: 'blocking', consecutive_runs: 3 });

    raw.prepare("UPDATE qa_exception SET state='resolved', resolved_at='t'").run();
    runDays(host, ['2026-09-05'], firing);
    expect(sev()).toMatchObject({ state: 'open', severity: 'warning', consecutive_runs: 1 });

    runDays(host, ['2026-09-08', '2026-09-09'], firing);
    expect(sev()).toMatchObject({ severity: 'blocking', consecutive_runs: 3 });
  });

  it('never escalates a check exempt from it, however long it fires', () => {
    const host = makeHost();
    const exempt = () => [fakeCheck({
      escalatesOnRepeat: false, evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }]
    })];
    runDays(host, ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-08'], exempt);
    expect(sev()).toMatchObject({ severity: 'warning', consecutive_runs: 5 });
  });

  it('still promotes an exempt check by its own value — only the repeat rule is off', () => {
    const host = makeHost();
    const exempt = () => [fakeCheck({
      escalatesOnRepeat: false, promoteToBlockingAtValue: 1,
      evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }]
    })];
    runDays(host, ['2026-09-02'], exempt);
    expect(sev()).toMatchObject({ severity: 'blocking' });
  });

  it('returns an already-escalated finding of an exempt check to base, firing or not', () => {
    const host = makeHost();
    // Escalated under the old rule: two keys, both blocking.
    const both = fakeCheck({
      evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }, { key: 'REXR', value: 2, fired: true, detail: 'over' }]
    });
    runDays(host, ['2026-09-02', '2026-09-03', '2026-09-04'], () => [both]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM qa_exception WHERE severity='blocking'").get()).toEqual({ n: 2 });

    // Now exempt. AAPL fires again; REXR cannot be evaluated at all (no evaluation, so it stays open).
    runDays(host, ['2026-09-05'], () => [fakeCheck({
      escalatesOnRepeat: false, evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }]
    })]);
    const rows = raw.prepare('SELECT key, severity, state FROM qa_exception ORDER BY key').all();
    expect(rows).toEqual([
      { key: 'AAPL', severity: 'warning', state: 'open' },
      { key: 'REXR', severity: 'warning', state: 'open' }
    ]);
    const notes = (raw.prepare("SELECT note FROM qa_exception_event WHERE note LIKE '%does not escalate%'").all() as { note: string }[]);
    expect(notes).toHaveLength(2);
  });

  it('declares QC-410 exempt from the repeat escalation', () => {
    expect(ALL_CHECKS.find((c) => c.id === 'QC-410')?.escalatesOnRepeat).toBe(false);
  });

  it('treats a check that throws as a finding rather than as a clean pass', () => {
    // A broken check that silently passes is the gate failing at its own job.
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const broken = fakeCheck({
      severity: 'blocking',
      evals: () => { throw new Error('boom'); }
    });
    const result = runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [broken] });
    expect(result.verdict).toBe('red');
    const row = raw.prepare('SELECT detail FROM qa_exception').get() as { detail: string };
    expect(row.detail).toContain('check threw');
  });
});

describe('a check that changed its keying retires findings it can no longer produce (v1.1.273)', () => {
  // QC-410 was keyed per contract until v1.1.252 and per ticker since, which left 11,468
  // contract-keyed findings open on gen-002 with nothing able to close them.
  const SHAPE = { pattern: /^[A-Z][A-Z0-9.]{0,9}$/, note: 'keyed per ticker since v1.1.252' };

  function twoRuns(second: CheckDefinition) {
    const host = makeHost();
    const oldKeying = fakeCheck({
      evals: () => [
        { key: 'ADP---260918C00275000', value: 2, fired: true, detail: 'old contract key' },
        { key: 'AMG', value: 2, fired: true, detail: 'ticker, will stop' },
        { key: 'PCTY', value: 2, fired: true, detail: 'ticker, keeps firing' }
      ]
    });
    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-05', checks: [oldKeying] });
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);
    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const result = runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-06', checks: [second] });
    const states = Object.fromEntries(
      (raw.prepare('SELECT key, state, resolution_kind FROM qa_exception').all() as { key: string; state: string; resolution_kind: string | null }[])
        .map((r) => [r.key, `${r.state}${r.resolution_kind ? `:${r.resolution_kind}` : ''}`])
    );
    return { result, states };
  }

  it('resolves only the stopped finding whose key is outside the shape, as the gate', () => {
    const { result, states } = twoRuns(fakeCheck({
      keyShape: SHAPE,
      evals: () => [{ key: 'PCTY', value: 2, fired: true, detail: 'still broken' }, { key: 'AAPL', value: 0, fired: false }]
    }));
    expect(result.resolvedByGate).toBe(1);
    // The stopped ticker stays open: its going quiet is a fact about the data, the operator's call.
    expect(states).toEqual({ 'ADP---260918C00275000': 'resolved:rule_changed', AMG: 'open', PCTY: 'open' });
    const ev = raw.prepare("SELECT actor, note FROM qa_exception_event WHERE to_state = 'resolved'").get() as { actor: string; note: string };
    expect(ev.actor).toBe('gate');
    expect(ev.note).toContain('ADP---260918C00275000');
  });

  it('retires nothing, and says so, when the check produces a key outside its own declaration', () => {
    const { result, states } = twoRuns(fakeCheck({
      keyShape: SHAPE,
      evals: () => [{ key: 'pcty lower-case', value: 0, fired: false }]
    }));
    expect(result.resolvedByGate).toBe(0);
    expect(states['ADP---260918C00275000']).toBe('open');
    expect(states['key_shape_violation']).toBe('open');
  });

  it('retires nothing when the check throws', () => {
    const { result, states } = twoRuns(fakeCheck({
      keyShape: SHAPE,
      evals: () => { throw new Error('boom'); }
    }));
    expect(result.resolvedByGate).toBe(0);
    expect(states['ADP---260918C00275000']).toBe('open');
  });

  it("QC-409's declared shape accepts E*Trade's symbols and rejects the pre-repair spellings (v1.1.281)", () => {
    const { pattern } = QC409_STICKY_SET_HONOURED.keyShape!;
    for (const ok of ['BRKB--261016P00495000', 'AIZ---261016C00280000', 'GOOGL-261016C00150000', 'X-----261016C00030000']) {
      expect(pattern.test(ok), ok).toBe(true);
    }
    // Space padding (before v1.1.248), the class-share dot (before v1.1.269), and a short symbol.
    for (const bad of ['AIZ   261016C00280000', 'BRK.B-261016P00495000', 'AIZ--261016C00280000']) {
      expect(pattern.test(bad), bad).toBe(false);
    }
  });

  it('retires nothing for a check that declares no shape', () => {
    const { states } = twoRuns(fakeCheck({ evals: () => [{ key: 'PCTY', value: 2, fired: true }] }));
    expect(states['ADP---260918C00275000']).toBe('open');
  });
});

describe('a check that threw and then ran cleanly closes its check_error finding (v1.1.289)', () => {
  // QC-604 threw "no such column: trade_date" until v1.1.251 and ran cleanly on every run
  // after, yet its check_error finding stayed open and blocking: no clean evaluation of the
  // key `check_error` can exist, so nothing could ever close it.
  function runs(...checks: CheckDefinition[]) {
    const host = makeHost();
    checks.forEach((check, i) => {
      const date = `2026-09-0${i + 5}`;
      const r = beginRun(db, host, { kind: 'daily', tradingDate: date });
      runGate(db, host, { runId: r.runId, tradingDate: date, checks: [check] });
      raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r.runId);
    });
    return raw.prepare("SELECT state, resolution_kind FROM qa_exception WHERE key = 'check_error'").get() as
      { state: string; resolution_kind: string | null };
  }
  const throws = fakeCheck({ evals: () => { throw new Error('no such column: trade_date'); } });

  it('resolves it as rule_changed, by the gate, once the check runs without throwing', () => {
    const row = runs(throws, fakeCheck({ evals: () => [{ key: 'AAPL', value: 0, fired: false }] }));
    expect(row).toEqual({ state: 'resolved', resolution_kind: 'rule_changed' });
    const ev = raw.prepare("SELECT actor, note FROM qa_exception_event WHERE to_state = 'resolved'").get() as { actor: string; note: string };
    expect(ev.actor).toBe('gate');
    expect(ev.note).toContain('ran without throwing');
  });

  it('also resolves it when the recovered check evaluates nothing — not throwing is the evidence', () => {
    expect(runs(throws, fakeCheck({ evals: () => [] })).state).toBe('resolved');
  });

  it('keeps it open while the check still throws', () => {
    expect(runs(throws, throws).state).toBe('open');
  });
});

describe('usability is derived, never stored on the run', () => {
  it('marks a domain-day unusable while a blocking exception is open, and usable when it is not', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const check = fakeCheck({ severity: 'blocking', evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'x' }] });
    runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [check] });

    let status = raw.prepare("SELECT status FROM qa_domain_day_status WHERE domain='test'").get();
    expect(status).toEqual({ status: 'unusable' });

    // Accepting it makes the day usable again — and the verdict follows the
    // exception state, which is the whole reason it is not stored on the run.
    raw.prepare("UPDATE qa_exception SET state='accepted', accepted_until='2026-10-06'").run();
    recomputeDomainDayStatus(db, host, run.runId, '2026-09-06');
    status = raw.prepare("SELECT status FROM qa_domain_day_status WHERE domain='test'").get();
    expect(status).toEqual({ status: 'usable' });
  });

  it('keeps meta_run.gate_verdict as history even after the exception is resolved', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const check = fakeCheck({ severity: 'blocking', evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'x' }] });
    const result = runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [check] });
    raw.prepare('UPDATE meta_run SET gate_verdict = ? WHERE run_id = ?').run(result.verdict, run.runId);

    raw.prepare("UPDATE qa_exception SET state='resolved'").run();
    recomputeDomainDayStatus(db, host, run.runId, '2026-09-06');

    // The day is usable now; the run still records that it finished red.
    expect(raw.prepare("SELECT status FROM qa_domain_day_status WHERE domain='test'").get()).toEqual({ status: 'usable' });
    expect(raw.prepare('SELECT gate_verdict FROM meta_run WHERE run_id = ?').get(run.runId)).toEqual({ gate_verdict: 'red' });
  });

  it('writes not_run for a day nobody collected', () => {
    const host = makeHost();
    syncRegistry(db, host, ALL_CHECKS);
    const domains = markNotRun(db, host, '2026-09-07');
    expect(domains).toBeGreaterThan(0);
    const rows = raw.prepare("SELECT DISTINCT status FROM qa_domain_day_status WHERE trading_date='2026-09-07'").all();
    expect(rows).toEqual([{ status: 'not_run' }]);
  });

  it('breaks the clean-day streak on an unusable or not_run day', () => {
    const host = makeHost();
    syncRegistry(db, host, ALL_CHECKS);
    for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) {
      raw.prepare(
        `INSERT INTO qa_domain_day_status (domain, trading_date, status, blocking_open, warning_open, computed_at)
         VALUES ('bars', ?, 'usable', 0, 0, 't')`
      ).run(d);
    }
    expect(cleanDayStreak(db, '2026-09-04')).toBe(3);

    raw.prepare("UPDATE qa_domain_day_status SET status='unusable' WHERE trading_date='2026-09-03'").run();
    expect(cleanDayStreak(db, '2026-09-04')).toBe(1);
  });
});

describe('the check registry versions rather than edits', () => {
  it('opens a new version when a threshold changes, keeping the old one readable', () => {
    const host = makeHost();
    const v1 = fakeCheck({ thresholds: { limit: 1 }, evals: () => [] });
    const v2 = fakeCheck({ thresholds: { limit: 2 }, evals: () => [] });
    syncRegistry(db, host, [v1]);
    syncRegistry(db, host, [v2]);

    const rows = raw
      .prepare('SELECT registry_version, thresholds_json, valid_to FROM qa_check_registry WHERE check_id = ? ORDER BY registry_version')
      .all('QC-901') as { registry_version: number; thresholds_json: string; valid_to: string | null }[];
    expect(rows.map((r) => r.registry_version)).toEqual([1, 2]);
    expect(rows[0]!.valid_to).not.toBeNull();
    // The superseded row keeps its own threshold, so a past qa_check_result can
    // still be read against the boundary that was actually in force.
    expect(JSON.parse(rows[0]!.thresholds_json)).toEqual({ limit: 1 });
  });

  it('does not version when nothing changed', () => {
    const host = makeHost();
    const check = fakeCheck({ evals: () => [] });
    syncRegistry(db, host, [check]);
    syncRegistry(db, host, [check]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM qa_check_registry WHERE check_id = ?').get('QC-901')).toEqual({ n: 1 });
  });
});

describe('the status email', () => {
  it('is built for a green run too — silence is the failure it exists to break', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, { runId: run.runId, tradingDate: '2026-09-06', checks: [fakeCheck({ evals: () => [{ key: 'a', value: 0, fired: false }] })] });

    const email = buildStatusEmail(db, {
      runId: run.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'green',
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: '2026-09-06T17:05:00-04:00', finishedAt: '2026-09-06T17:31:00-04:00',
      domains: { bars: { expected: 1089, stored: 1089 } }
    });

    expect(email.subject).toContain('GREEN');
    expect(email.text).toContain('DOMAINS');
    expect(email.text).toContain('OPEN EXCEPTIONS');
    expect(email.text).toContain('Zero-fire checks');
    expect(email.html).toContain('<pre');
  });

  it('reports what R6 did, what it deferred, and when it did not run (v1.1.286)', () => {
    // 2026-09-18: the per-run cap deferred WULF and nothing rendered the count.
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    const base = {
      runId: run.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'green' as const,
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: '2026-09-06T17:05:00-04:00', finishedAt: '2026-09-06T17:31:00-04:00', domains: {}
    };

    const ran = buildStatusEmail(db, { ...base, r6: { attempted: 60, succeeded: 59, failed: 1, findingsMarked: 121, deferred: 1, cap: 60 } });
    expect(ran.text).toContain(
      'REMEDIATION  R6 (splits/dividends re-fetch): 60 tickers (59 ok, 1 failed), 121 findings marked · 1 deferred to a later run (cap 60 per run, oldest first)'
    );
    expect(buildStatusEmail(db, { ...base, r6: { attempted: 0, succeeded: 0, failed: 0, findingsMarked: 0, deferred: 0, cap: 60 } }).text)
      .toContain('R6 (splits/dividends re-fetch): nothing to re-fetch');
    expect(buildStatusEmail(db, { ...base, r6: { error: 'polygon 503' } }).text)
      .toContain('R6 (splits/dividends re-fetch) did not run: polygon 503');
    expect(buildStatusEmail(db, base).text).not.toContain('REMEDIATION');

    // R3 (v1.1.288): above R6, one line whatever it did.
    const r3 = (x: Parameters<typeof buildStatusEmail>[1]['r3']) => buildStatusEmail(db, { ...base, ...(x ? { r3: x } : {}) }).text;
    expect(r3({ provisional: 12, refetched: 12, stillProvisional: 0 }))
      .toContain('REMEDIATION  R3 (final re-fetch of provisional bars): 12 re-fetched, 0 still provisional');
    expect(r3({ provisional: 1083, refetched: 0, stillProvisional: 1083, windowOpenAt: '16:50' }))
      .toContain('R3 (final re-fetch of provisional bars): settlement window still open at 16:50 ET — 1083 bar(s) left provisional');
    expect(r3({ provisional: 0, refetched: 0, stillProvisional: 0 })).toContain('R3 (final re-fetch of provisional bars): nothing provisional');
    expect(r3({ error: 'polygon 503' })).toContain('R3 (final re-fetch of provisional bars) did not run: polygon 503');
  });

  it('names the checks that evaluated nothing, which a fired count cannot distinguish from clean', () => {
    // QC-602 sat at evaluated 0 for the whole of gen-002 because it joined on a
    // source the collector never fetches. The gate computed `checksVacuous` and
    // the daily result carried it, but nothing rendered it, so the only trace
    // was a zero in a table nobody reads. The aggregate "Zero-fire checks: N of
    // M" cannot tell "found nothing wrong" from "could not look".
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [
        fakeCheck({ id: 'QC-901', evals: () => [{ key: 'a', value: 0, fired: false }] }),
        fakeCheck({ id: 'QC-902', evals: () => [] })
      ]
    });

    const email = buildStatusEmail(db, {
      runId: run.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'green',
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: '2026-09-06T17:05:00-04:00', finishedAt: '2026-09-06T17:31:00-04:00',
      domains: {}
    });

    expect(email.text).toContain('EVALUATED NOTHING (1)');
    expect(email.text).toContain('QC-902');
    expect(email.text).not.toMatch(/EVALUATED NOTHING[^\n]*\n\s*QC-901/);
  });

  it('puts blocking first and names the key, the evidence and the age', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [
        fakeCheck({ id: 'QC-903', severity: 'blocking', evals: () => [{ key: 'CRWD', value: 0.75, fired: true, detail: 'close 78.12 vs prev 312.40 (-75%) no split found' }] }),
        fakeCheck({ id: 'QC-904', severity: 'warning', evals: () => [{ key: 'BRK.B', value: 0.007, fired: true, detail: 'close disagreement 0.7%' }] })
      ]
    });

    const email = buildStatusEmail(db, {
      runId: run.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'red',
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: '2026-09-06T17:05:00-04:00', finishedAt: '2026-09-06T17:31:00-04:00',
      domains: { bars: { expected: 1089, stored: 1086 } }
    });

    expect(email.subject).toContain('RED (1 blocking)');
    const blockingAt = email.text.indexOf('BLOCKING');
    const warningsAt = email.text.indexOf('WARNINGS');
    expect(blockingAt).toBeGreaterThan(-1);
    expect(blockingAt).toBeLessThan(warningsAt);
    expect(email.text).toContain('CRWD');
    expect(email.text).toContain('no split found');
    // Warnings are counted, not listed one by one.
    expect(email.text).toContain('QC-904 ×1');
  });

  it('counts this run\'s blocking findings in the subject, and the backlog separately', () => {
    // 2026-09-16: subject "RED (3438 blocking)", gate and batch note 2,321.
    const host = makeHost();
    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, {
      runId: r1.runId, tradingDate: '2026-09-05',
      checks: [fakeCheck({ severity: 'blocking', evals: () => [{ key: 'OLD', value: 2, fired: true, detail: 'over' }] })]
    });
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);
    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: r2.runId, tradingDate: '2026-09-06',
      checks: [fakeCheck({ id: 'QC-902', severity: 'blocking', evals: () => [{ key: 'NEW', value: 2, fired: true, detail: 'over' }] })]
    });

    const email = buildStatusEmail(db, {
      runId: r2.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'red',
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: 't', finishedAt: 't', domains: {}
    });
    expect(email.subject).toContain('RED (1 blocking)');
    expect(email.text).toContain('BLOCKING (2: 1 found by this run, 1 still open from earlier runs)');
  });

  it('lists exceptions that stopped firing but were never resolved', () => {
    const host = makeHost();
    const firing = fakeCheck({ evals: () => [{ key: 'AAPL', value: 2, fired: true, detail: 'over' }] });
    const clean = fakeCheck({ evals: () => [{ key: 'AAPL', value: 0, fired: false }] });
    const r1 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-05' });
    runGate(db, host, { runId: r1.runId, tradingDate: '2026-09-05', checks: [firing] });
    raw.prepare("UPDATE meta_run SET status='complete' WHERE run_id=?").run(r1.runId);
    const r2 = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, { runId: r2.runId, tradingDate: '2026-09-06', checks: [clean] });

    const email = buildStatusEmail(db, {
      runId: r2.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'green',
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: 't', finishedAt: 't', domains: {}
    });
    expect(email.text).toContain('NO LONGER OBSERVED, UNRESOLVED');
  });

  /**
   * The gate email is an ALERT, not a dump of `qa_exception`.
   *
   * On 2026-09-15 it listed all 773 blocking findings one per line. Two RED
   * emails in a row then failed to reach the operator, and nothing in the send
   * path could say whether size was why — Gmail clips a body over ~102 KB, and
   * 415 identical QC-409 lines are one fact printed 415 times, which buries the
   * eight other checks that each needed a separate decision.
   *
   * So the size is a property worth asserting, not a consequence worth hoping
   * about: a pathological day must still produce a readable, deliverable email.
   */
  it('stays small and readable when one check fires hundreds of times', () => {
    const host = makeHost();
    const run = beginRun(db, host, { kind: 'daily', tradingDate: '2026-09-06' });
    runGate(db, host, {
      runId: run.runId, tradingDate: '2026-09-06',
      checks: [
        fakeCheck({
          id: 'QC-903', severity: 'blocking',
          evals: () => Array.from({ length: 500 }, (_, i) => ({
            key: `AAA${i}--261016C00280000`,
            value: 1,
            fired: true,
            detail: `AAA${i}--261016C00280000 is pinned (recommended_by_legacy) but has no snapshot for 2026-09-06`
          }))
        }),
        fakeCheck({
          id: 'QC-905', severity: 'blocking',
          evals: () => [{ key: 'SPY', value: 1, fired: true, detail: 'the one that must not be buried' }]
        })
      ]
    });

    const email = buildStatusEmail(db, {
      runId: run.runId, tradingDate: '2026-09-06', slot: 'after_close', verdict: 'red',
      generationNo: 1, generationStatus: 'pilot', collectorVersion: '0.1.0',
      startedAt: 't', finishedAt: 't', domains: {}
    });

    // Well under the clip threshold, which is what makes it arrive intact.
    expect(Buffer.byteLength(email.html, 'utf8')).toBeLessThan(102_400);
    // The total is never lost — that is the number that says how bad the day is.
    expect(email.subject).toContain('RED (501 blocking)');
    expect(email.text).toContain('QC-903');
    expect(email.text).toContain('×500');
    expect(email.text).toContain('and 497 more');
    // A check that fired once is still visible beside one that fired 500 times.
    expect(email.text).toContain('the one that must not be buried');
    // Concrete evidence survives the collapse; a bare count is not actionable.
    expect(email.text).toContain('AAA0--261016C00280000');
  });

  it('has a no-run email that explains what silence meant', () => {
    const email = buildNoRunEmail('2026-09-06', 'The scheduler did not fire.');
    expect(email.subject).toContain('NO RUN');
    expect(email.text).toContain('not_run');
    expect(email.text).toContain('Silence is the failure mode this reports.');
  });
});
