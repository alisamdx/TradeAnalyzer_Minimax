import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import { DICTIONARY, type TableEntry } from '../src/dictionary/index.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { OperatorHost } from '../src/collector/host.js';
import type { CheckDefinition } from '../src/qa/check.js';
import { syncRegistry, cleanDayStreak } from '../src/qa/gate.js';
import { tradingDaysInRange } from '../src/collector/trading-calendar.js';
import { QC951_REPLAY_EQUIVALENCE, QC956_REPLAY_OVERDUE } from '../src/qa/checks/replay.js';
import {
  pilotExitStatus, promoteToProduction, recordCheckRuling, recordDomainInspection,
  thresholdReview, zeroFireReview, PILOT_CLEAN_DAYS
} from '../src/qa/pilot-exit.js';
import { OperatorActionRefused } from '../src/qa/operator.js';

let dir: string;
let raw: Database.Database;
let db: SqliteLike;
const host: OperatorHost = { nowET: () => '2026-09-11T12:00:00-04:00', hostApp: { name: 'test', version: '0' } };

/** A magnitude check with a working threshold, and a predicate one. Both in domain `bars`. */
const MAG: CheckDefinition = {
  id: 'QC-201', domain: 'bars', severity: 'warning',
  description: 'Synthetic magnitude check for the pilot-exit tests, with a working threshold.',
  readsTables: ['raw_daily_bar'], testedQuantity: 'synthetic', testedUnit: 'fraction',
  thresholds: { limit: 10 }, thresholdBasis: 'working', run: () => []
};
const PRED: CheckDefinition = {
  id: 'QC-001', domain: 'bars', severity: 'blocking',
  description: 'Synthetic predicate check for the pilot-exit tests, which never fires.',
  readsTables: ['meta_response'], testedQuantity: null, testedUnit: null,
  thresholds: {}, thresholdBasis: 'not_applicable', run: () => []
};
const CHECKS = [MAG, PRED];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-pilot-'));
  raw = new Database(join(dir, 'data.sqlite'));
  db = raw as unknown as SqliteLike;
  applyDictionary(db);
  nextRun = 1;
  raw.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1, 't', 'pilot', 'x', 'y')");
  syncRegistry(db, { ...host, openGenerationDb: () => db } as never, CHECKS);
});

afterEach(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

function dayStatus(date: string, status = 'usable', domain = 'bars'): void {
  raw.prepare(
    `INSERT INTO qa_domain_day_status (domain, trading_date, status, blocking_open, warning_open, computed_at)
     VALUES (?, ?, ?, 0, 0, 't')`
  ).run(domain, date, status);
}

let nextRun = 1;
function dailyRun(date: string): number {
  const id = nextRun++;
  raw.prepare(
    `INSERT INTO meta_run (run_id, run_kind, slot, trading_date, started_at, status, host_app, host_version, collector_version, dictionary_version)
     VALUES (?, 'daily', 'after_close', ?, ?, 'complete', 'test', '0', '0', 13)`
  ).run(id, date, `${date}T17:05:00-04:00`);
  return id;
}

function replay(finishedAt: string, verdict: string, tradingDates: string[]): void {
  raw.prepare(
    `INSERT INTO meta_job_request (requested_at, requested_by, run_kind, params_json, state, finished_at, result_json)
     VALUES (?, 'test', 'replay', '{}', 'complete', ?, ?)`
  ).run(finishedAt, finishedAt, JSON.stringify({ verdict, tradingDates, sourceRunIds: [] }));
}

function result(runId: number, check: string, dist: Record<string, number>): void {
  raw.prepare(
    `INSERT INTO qa_check_result (run_id, check_id, registry_version, evaluated_count, fired_count, duration_ms,
       sample_keys_json, distribution_json, extreme_keys_json)
     VALUES (?, ?, 1, ?, 0, 1, '[]', ?, ?)`
  ).run(runId, check, dist.n, JSON.stringify({ threshold: 10, nearBoundary: 0, ...dist }), JSON.stringify([{ key: `K${runId}`, value: dist.max }]));
}

describe('the clean-day streak walks the calendar, not the rows', () => {
  it('breaks on a trading day nothing recorded — a missing day is not a clean one', () => {
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-04']) dayStatus(d); // 09-03 absent
    expect(cleanDayStreak(db, '2026-09-04')).toBe(1);
  });

  it('runs across a weekend and a holiday, which are not sessions', () => {
    // Fri 09-04, then Sat, Sun, Labor Day Monday 09-07, then Tue 09-08.
    for (const d of ['2026-09-03', '2026-09-04', '2026-09-08']) dayStatus(d);
    expect(cleanDayStreak(db, '2026-09-08')).toBe(3);
  });

  it('still breaks on not_run and unusable', () => {
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) dayStatus(d);
    dayStatus('2026-09-02', 'not_run', 'chains');
    expect(cleanDayStreak(db, '2026-09-03')).toBe(1);
  });
});

describe('QC-951 — the latest replay of a day must be equal', () => {
  const ctx = (tradingDate: string) => ({ db, runId: 1, tradingDate, observedAt: 't' });

  it('evaluates nothing when nothing was replayed — no replay is QC-956\'s finding', () => {
    expect(QC951_REPLAY_EQUIVALENCE.run(ctx('2026-09-10'))).toEqual([]);
  });

  it('fires on a different replay, and makes that day unusable', () => {
    replay('2026-09-10T20:00:00-04:00', 'different', ['2026-09-09']);
    const [e] = QC951_REPLAY_EQUIVALENCE.run(ctx('2026-09-10'));
    expect(e).toMatchObject({ key: '2026-09-09', fired: true, affects: ['2026-09-09'] });
  });

  it('stops firing once a later replay of the same day comes back equal, so it can be resolved', () => {
    replay('2026-09-10T20:00:00-04:00', 'different', ['2026-09-09']);
    replay('2026-09-11T20:00:00-04:00', 'equal', ['2026-09-09']);
    const evals = QC951_REPLAY_EQUIVALENCE.run(ctx('2026-09-11'));
    expect(evals).toHaveLength(1);
    expect(evals[0]?.fired).toBe(false);
  });
});

describe('QC-956 — a replay must have passed recently', () => {
  const ctx = (tradingDate: string) => ({ db, runId: 1, tradingDate, observedAt: 't' });

  it('counts sessions from the first daily run until a replay passes, and fires past seven', () => {
    dailyRun('2026-08-31');
    // Sep 1-4, 8-10 = 7 sessions after 08-31 (Labor Day is not one): at the limit, not past it.
    expect(QC956_REPLAY_OVERDUE.run(ctx('2026-09-10'))[0]).toMatchObject({ value: 7, fired: false });
    expect(QC956_REPLAY_OVERDUE.run(ctx('2026-09-11'))[0]).toMatchObject({ value: 8, fired: true });
  });

  it('restarts the count at the last PASSING replay; nothing_replayable does not count', () => {
    dailyRun('2026-08-31');
    replay('2026-09-08T20:00:00-04:00', 'equal_on_replayed', ['2026-09-04']);
    replay('2026-09-10T20:00:00-04:00', 'nothing_replayable', ['2026-09-09']);
    expect(QC956_REPLAY_OVERDUE.run(ctx('2026-09-11'))[0]).toMatchObject({ value: 3, fired: false });
  });
});

describe('the pilot-exit reviews', () => {
  it('lists never-fired checks and refuses a zero-fire ruling on a check that has fired', () => {
    expect(zeroFireReview(db).map((z) => z.checkId).sort()).toEqual(['QC-001', 'QC-201']);
    raw.prepare("UPDATE qa_check_registry SET fired_total = 3 WHERE check_id = 'QC-201'").run();
    expect(zeroFireReview(db).map((z) => z.checkId)).toEqual(['QC-001']);
    expect(() =>
      recordCheckRuling(db, host, CHECKS, { checkId: 'QC-201', review: 'zero_fire', decision: 'keep', note: 'n' })
    ).toThrow(OperatorActionRefused);
  });

  it('refuses a ruling with no note, or with a decision from the other review', () => {
    expect(() => recordCheckRuling(db, host, CHECKS, { checkId: 'QC-001', review: 'zero_fire', decision: 'keep', note: '  ' }))
      .toThrow(/note/);
    expect(() => recordCheckRuling(db, host, CHECKS, { checkId: 'QC-001', review: 'zero_fire', decision: 'confirm', note: 'x' }))
      .toThrow(/does not answer/);
  });

  it('bounds pooled quantiles between the per-run extremes, and says maybe when the bound straddles', () => {
    result(dailyRun('2026-09-08'), 'QC-201', { n: 100, min: 0, p50: 1, p90: 2, p99: 3, max: 4 });
    result(dailyRun('2026-09-09'), 'QC-201', { n: 50, min: 0, p50: 2, p90: 5, p99: 7, max: 9 });
    const [t] = thresholdReview(db, CHECKS);
    expect(t).toMatchObject({ runs: 2, n: 150, min: 0, max: 9, p50: { lo: 1, hi: 2 }, p99: { lo: 3, hi: 7 } });
    // Half the threshold is 5: p99 runs 3..7, so it cannot be called either way.
    expect(t?.decorative).toBe('maybe');
    expect(t?.bulkAgainst).toBe('no');
    expect(t?.extremes[0]).toEqual({ key: 'K2', value: 9, runId: 2 });
  });

  it('calls a threshold decorative only when even the largest per-run p99 is under half of it', () => {
    result(dailyRun('2026-09-08'), 'QC-201', { n: 10, min: 0, p50: 1, p90: 2, p99: 3, max: 4 });
    expect(thresholdReview(db, CHECKS)[0]?.decorative).toBe('yes');
  });

  it('requires a value on a move, and refuses one on anything else', () => {
    expect(() => recordCheckRuling(db, host, CHECKS, { checkId: 'QC-201', review: 'threshold', decision: 'move', note: 'x' }))
      .toThrow(/where the threshold should go/);
    expect(() =>
      recordCheckRuling(db, host, CHECKS, { checkId: 'QC-201', review: 'threshold', decision: 'confirm', note: 'x', proposedThreshold: 3 })
    ).toThrow(/Only a "move"/);
    recordCheckRuling(db, host, CHECKS, { checkId: 'QC-201', review: 'threshold', decision: 'move', note: 'p99 sits at 3', proposedThreshold: 6 });
    const row = raw.prepare('SELECT proposed_threshold, proposed_unit, evidence_json FROM qa_check_ruling').get() as {
      proposed_threshold: number; proposed_unit: string; evidence_json: string;
    };
    expect(row).toMatchObject({ proposed_threshold: 6, proposed_unit: 'fraction' });
    expect(JSON.parse(row.evidence_json)).toHaveProperty('threshold', 10);
  });

  it('refuses a threshold ruling on a threshold that is not working', () => {
    const measured = { ...MAG, thresholdBasis: 'measured' as const, thresholdEvidence: 'measured' };
    expect(() =>
      recordCheckRuling(db, host, [measured, PRED], { checkId: 'QC-201', review: 'threshold', decision: 'confirm', note: 'x' })
    ).toThrow(/not working/);
  });

  it('keeps every ruling, and the latest is the one in force', () => {
    recordCheckRuling(db, host, CHECKS, { checkId: 'QC-001', review: 'zero_fire', decision: 'fix', note: 'first look' });
    recordCheckRuling(db, { ...host, nowET: () => '2026-09-12T09:00:00-04:00' }, CHECKS,
      { checkId: 'QC-001', review: 'zero_fire', decision: 'keep', note: 'second look' });
    expect(zeroFireReview(db).find((z) => z.checkId === 'QC-001')?.ruling?.decision).toBe('keep');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM qa_check_ruling').get()).toEqual({ n: 2 });
  });
});

describe('dictionary v13 on a generation that already holds rows', () => {
  it('is plain growth: two new tables and one nullable column, and no drift afterwards', () => {
    // gen-001 meets this change populated, with its meta_generation row written.
    const older: TableEntry[] = DICTIONARY
      .filter((t) => t.table !== 'qa_check_ruling' && t.table !== 'meta_domain_inspection')
      .map((t) =>
        t.table === 'meta_generation'
          ? { ...t, columns: t.columns.filter((c) => c.column !== 'pilot_exit_evidence_json') }
          : t
      );
    const legacy = new Database(join(dir, 'v12.sqlite'));
    try {
      const ldb = legacy as unknown as SqliteLike;
      applyDictionary(ldb, older);
      legacy.exec("INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path) VALUES (1, 't', 'pilot', 'x', 'y')");

      const result = applyDictionary(ldb);
      expect(result.columnsAdded).toContainEqual({ table: 'meta_generation', column: 'pilot_exit_evidence_json' });
      expect(result.tablesCreated).toEqual(expect.arrayContaining(['qa_check_ruling', 'meta_domain_inspection']));
      expect(applyDictionary(ldb).driftBlocked).not.toContain('meta_generation');
      expect(legacy.prepare('SELECT status, pilot_exit_evidence_json FROM meta_generation').get())
        .toEqual({ status: 'pilot', pilot_exit_evidence_json: null });
    } finally {
      legacy.close();
    }
  });

  it('refuses an edit to a ruling or an inspection — both are append-only', () => {
    recordCheckRuling(db, host, CHECKS, { checkId: 'QC-001', review: 'zero_fire', decision: 'keep', note: 'x' });
    recordDomainInspection(db, host, { domain: 'bars' });
    expect(() => raw.prepare("UPDATE qa_check_ruling SET decision = 'drop'").run()).toThrow();
    expect(() => raw.prepare('DELETE FROM meta_domain_inspection').run()).toThrow();
  });
});

describe('inspections and promotion', () => {
  it('refuses an inspection of a domain the gate does not report on', () => {
    expect(() => recordDomainInspection(db, host, { domain: 'weather' })).toThrow(OperatorActionRefused);
    recordDomainInspection(db, host, { domain: 'bars', note: 'looked at AAPL and SPY' });
    expect(pilotExitStatus(db, CHECKS).inspections).toEqual([
      { domain: 'bars', lastAt: '2026-09-11T12:00:00-04:00', note: 'looked at AAPL and SPY' }
    ]);
  });

  it('refuses promotion, naming every unmet condition, and changes nothing', () => {
    const OK = { confirmation: 'promote gen-001' };
    expect(() => promoteToProduction(db, host, CHECKS, { confirmation: 'promote' }, { verifyNotes: 0 }))
      .toThrow(/Type "promote gen-001" exactly/);
    expect(() => promoteToProduction(db, host, CHECKS, OK, { verifyNotes: 0 })).toThrow(/0 of 20 consecutive clean/);
    expect(raw.prepare('SELECT status, pilot_exit_at FROM meta_generation').get()).toEqual({ status: 'pilot', pilot_exit_at: null });
  });

  it('promotes when every condition holds, and stores the checklist it was promoted on', () => {
    const days = tradingDaysInRange(db, '2026-08-01', '2026-09-11').slice(-PILOT_CLEAN_DAYS);
    for (const d of days) { dayStatus(d); dailyRun(d); }
    replay('2026-09-10T20:00:00-04:00', 'equal', [days[days.length - 2] as string]);
    recordCheckRuling(db, host, CHECKS, { checkId: 'QC-001', review: 'zero_fire', decision: 'keep', note: 'plausibly rare' });
    recordCheckRuling(db, host, CHECKS, { checkId: 'QC-201', review: 'zero_fire', decision: 'keep', note: 'plausibly rare' });
    recordCheckRuling(db, host, CHECKS, { checkId: 'QC-201', review: 'threshold', decision: 'unmeasurable', note: 'event did not occur' });
    recordDomainInspection(db, host, { domain: 'bars' });

    // The real dictionary still carries a verify note (short_interest), so the
    // default refuses on that alone — which is the point of the condition.
    expect(pilotExitStatus(db, CHECKS).conditions.filter((c) => !c.met).map((c) => c.key)).toEqual(['verify_notes']);

    const OK = { confirmation: 'promote gen-001' };
    const after = promoteToProduction(db, host, CHECKS, OK, { verifyNotes: 0 });
    expect(after.generationStatus).toBe('production');
    const gen = raw.prepare('SELECT status, pilot_exit_at, pilot_exit_evidence_json FROM meta_generation').get() as {
      status: string; pilot_exit_at: string; pilot_exit_evidence_json: string;
    };
    expect(gen.pilot_exit_at).toBe('2026-09-11T12:00:00-04:00');
    expect(JSON.parse(gen.pilot_exit_evidence_json)).toMatchObject({ streak: 20, canPromote: true });

    // A second click changes nothing: the generation is no longer in pilot.
    expect(() => promoteToProduction(db, host, CHECKS, OK, { verifyNotes: 0 })).toThrow(OperatorActionRefused);
  });

  it('holds promotion while the latest replay of any day differs', () => {
    const days = tradingDaysInRange(db, '2026-08-01', '2026-09-11').slice(-PILOT_CLEAN_DAYS);
    for (const d of days) { dayStatus(d); dailyRun(d); }
    replay('2026-09-09T20:00:00-04:00', 'equal', [days[0] as string]);
    replay('2026-09-10T20:00:00-04:00', 'different', [days[1] as string]);
    const replayCond = pilotExitStatus(db, CHECKS).conditions.find((c) => c.key === 'replay');
    expect(replayCond).toMatchObject({ met: false });
    expect(replayCond?.detail).toContain(days[1]);
  });
});
