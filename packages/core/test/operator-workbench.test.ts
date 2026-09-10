import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary } from '../src/dictionary/apply.js';
import type { SqliteLike } from '../src/db/sqlite-like.js';
import type { OperatorHost } from '../src/collector/host.js';
import * as operatorModule from '../src/qa/operator.js';
import {
  acknowledge, accept, bulkAcknowledge, MAX_ACCEPTANCE_DAYS, OperatorActionRefused
} from '../src/qa/operator.js';
import { queueJob, claimNextJob, cancelJob } from '../src/collector/jobs.js';
import {
  performReset, resetPreview, resetConfirmationText, IN_FLIGHT_HOURS
} from '../src/collector/reset.js';

/**
 * The operator path of B9a — the workbench, the job queue and reset (05 §5,
 * §7; 04 §7.6; AC-14).
 *
 * Every action here is driven from the new exe, which holds no provider
 * transport. So the host these tests pass is deliberately the smallest thing
 * the functions accept: a clock and a name. If one of them grows a dependency
 * on the collector's transports, this file stops compiling, which is the point.
 */

let dir: string;
const handles: Database.Database[] = [];

function genPath(no: number): string {
  return join(dir, `gen-${String(no).padStart(3, '0')}`, 'data.sqlite');
}

function openGen(no: number, withRow = true): { raw: Database.Database; db: SqliteLike } {
  mkdirSync(join(dir, `gen-${String(no).padStart(3, '0')}`), { recursive: true });
  const raw = new Database(genPath(no));
  handles.push(raw);
  const db = raw as unknown as SqliteLike;
  applyDictionary(db);
  if (withRow) {
    raw
      .prepare(
        `INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path)
         VALUES (?, '2026-09-01T09:00:00-04:00', 'pilot', 'x', 'y')`
      )
      .run(no);
  }
  return { raw, db };
}

function operator(nowET = '2026-09-06T18:00:00-04:00'): OperatorHost {
  return { nowET: () => nowET, hostApp: { name: 'TradeAnalyzer 2', version: 'test' } };
}

let seq = 0;
function raise(db: SqliteLike, state = 'open'): number {
  seq++;
  const info = db
    .prepare(
      `INSERT INTO qa_exception (
         fingerprint, check_id, domain, key, severity, base_severity, state, detail, evidence_json,
         first_seen_run_id, last_seen_run_id, consecutive_runs, remediations_json,
         affects_trading_dates_json, still_firing
       ) VALUES (?, 'QC-204', 'bars', ?, 'blocking', 'blocking', ?, 'a step in the series', '{}',
                 1, 1, 1, '[]', '["2026-09-04"]', 1)`
    )
    .run(`fp-${seq}`, `T${seq} 2026-09-04`, state);
  return Number(info.lastInsertRowid);
}

function run(db: SqliteLike, status: string, startedAt: string, kind = 'daily'): number {
  const info = db
    .prepare(
      `INSERT INTO meta_run (
         run_kind, slot, trading_date, started_at, status,
         host_app, host_version, collector_version, dictionary_version
       ) VALUES (?, 'after_close', '2026-09-04', ?, ?, 'TradeAnalyzer', '1', '0', 10)`
    )
    .run(kind, startedAt, status);
  return Number(info.lastInsertRowid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-workbench-'));
});

afterEach(() => {
  for (const h of handles.splice(0)) if (h.open) h.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('operator actions need only a clock and a name', () => {
  it('acknowledges through a host that has nothing else on it', () => {
    const { raw, db } = openGen(1);
    const id = raise(db);
    acknowledge(db, operator(), id, 'looking');
    expect(raw.prepare('SELECT state FROM qa_exception WHERE exception_id = ?').get(id))
      .toEqual({ state: 'acknowledged' });
  });
});

describe('an acceptance expiry is bounded, and dated in ET', () => {
  it('defaults to 30 ET calendar days even when accepted in the evening', () => {
    // Regression. The default used to add 30 days to the instant and serialise
    // it as UTC, so at 21:30 ET — 01:30 UTC the next day — it came out as
    // 2026-10-07: a day longer than the same acceptance taken at lunch.
    const { db } = openGen(1);
    const id = raise(db);
    expect(accept(db, operator('2026-09-06T21:30:00-04:00'), id, 'genuine move')).toBe('2026-10-06');
  });

  it('accepts exactly the maximum, and refuses one day more', () => {
    const { db } = openGen(1);
    expect(MAX_ACCEPTANCE_DAYS).toBe(180);
    const a = raise(db);
    expect(accept(db, operator(), a, 'reviewed', '2027-03-05')).toBe('2027-03-05');
    const b = raise(db);
    expect(() => accept(db, operator(), b, 'reviewed', '2027-03-06')).toThrow(/at most 180 days/);
  });

  it('refuses an expiry of today or earlier, which would be over before it began', () => {
    const { db } = openGen(1);
    const id = raise(db);
    expect(() => accept(db, operator(), id, 'x', '2026-09-06')).toThrow(OperatorActionRefused);
    expect(() => accept(db, operator(), id, 'x', '2026-08-01')).toThrow(/must run past today/);
  });

  it('refuses an expiry that is not a date', () => {
    const { db } = openGen(1);
    const id = raise(db);
    expect(() => accept(db, operator(), id, 'x', 'next month')).toThrow(/must be a date/);
  });
});

describe('bulk acknowledge — and deliberately nothing else in bulk', () => {
  it('acknowledges the open ones and says why each other one was skipped', () => {
    const { raw, db } = openGen(1);
    const open1 = raise(db);
    const open2 = raise(db);
    const already = raise(db, 'acknowledged');

    const result = bulkAcknowledge(db, operator(), [open1, already, open2], 'triage');

    expect(result.acknowledged).toEqual([open1, open2]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.exceptionId).toBe(already);
    expect(result.skipped[0]!.why).toMatch(/Only an open exception/);
    const states = raw.prepare('SELECT state FROM qa_exception ORDER BY exception_id').all();
    expect(states).toEqual([{ state: 'acknowledged' }, { state: 'acknowledged' }, { state: 'acknowledged' }]);
  });

  it('offers no bulk resolve and no bulk accept (05 §5)', () => {
    // Each of those is a claim about one finding. A bulk version makes the
    // claim about a filter, which is how "we looked at these" becomes "we
    // looked at a list of these".
    expect(operatorModule).not.toHaveProperty('bulkResolve');
    expect(operatorModule).not.toHaveProperty('bulkAccept');
  });
});

describe('cancelling a queued request', () => {
  it('withdraws a request nobody has claimed, so no host can claim it afterwards', () => {
    const { raw, db } = openGen(1);
    const id = queueJob(db, operator(), 'backfill_bars');
    expect(cancelJob(db, operator(), id)).toBe(true);
    expect(raw.prepare('SELECT state, finished_at FROM meta_job_request').get())
      .toEqual({ state: 'cancelled', finished_at: '2026-09-06T18:00:00-04:00' });
    expect(claimNextJob(db, { ...operator(), openGenerationDb: () => db } as never)).toBeUndefined();
  });

  it('refuses a request that is already claimed — that one belongs to the host running it', () => {
    const { raw, db } = openGen(1);
    const id = queueJob(db, operator(), 'backfill_bars');
    claimNextJob(db, operator() as never);
    expect(cancelJob(db, operator(), id)).toBe(false);
    expect(raw.prepare('SELECT state FROM meta_job_request').get()).toEqual({ state: 'claimed' });
  });
});

describe('reset — AC-14', () => {
  const noSuccessor = (): SqliteLike => {
    throw new Error('openSuccessor must not be reached');
  };
  const noPointer = (): void => {
    throw new Error('commitPointer must not be reached');
  };

  it('asks for the generation by name', () => {
    expect(resetConfirmationText(1)).toBe('RESET gen-001');
    expect(resetConfirmationText(12)).toBe('RESET gen-012');
  });

  it('refuses without a reason or without the exact confirmation, and touches nothing', () => {
    const { raw, db } = openGen(1);
    const base = { db, host: operator(), generationNo: 1, openSuccessor: noSuccessor, commitPointer: noPointer };
    expect(() => performReset({ ...base, reason: '  ', confirmation: 'RESET gen-001' })).toThrow(/needs a reason/);
    expect(() => performReset({ ...base, reason: 'drift', confirmation: 'reset gen-001' })).toThrow(/exactly/);
    expect(() => performReset({ ...base, reason: 'drift', confirmation: 'RESET gen-002' })).toThrow(/exactly/);
    expect(raw.prepare('SELECT status FROM meta_generation').get()).toEqual({ status: 'pilot' });
  });

  it('is blocked by a run that could still be running, but not by one that died long ago', () => {
    const { db } = openGen(1);
    run(db, 'running', '2026-09-05T08:00:00-04:00'); // 34h before "now": the host died mid-run
    const before = resetPreview(db, '2026-09-06T18:00:00-04:00', 1);
    expect(before.blockers).toEqual([]);
    expect(before.presumedDead).toHaveLength(1);
    expect(before.presumedDead[0]).toMatch(/presumed dead/);

    // Well inside the in-flight window.
    expect(IN_FLIGHT_HOURS).toBeGreaterThan(1);
    run(db, 'running', '2026-09-06T17:00:00-04:00');
    const after = resetPreview(db, '2026-09-06T18:00:00-04:00', 1);
    expect(after.blockers).toHaveLength(1);
    expect(after.blockers[0]).toMatch(/still running/);
    expect(() =>
      performReset({
        db, host: operator(), generationNo: 1, reason: 'drift', confirmation: 'RESET gen-001',
        openSuccessor: noSuccessor, commitPointer: noPointer
      })
    ).toThrow(/Reset refused: run \d+ \(daily/);
  });

  it('is blocked by a request a host has claimed', () => {
    const { db } = openGen(1);
    queueJob(db, operator('2026-09-06T17:50:00-04:00'), 'backfill_bars');
    claimNextJob(db, operator('2026-09-06T17:55:00-04:00') as never);
    expect(resetPreview(db, '2026-09-06T18:00:00-04:00', 1).blockers[0]).toMatch(/request 1 \(backfill_bars\) is claimed/);
  });

  it('opens a new generation and leaves the previous one intact and readable', () => {
    const g1 = openGen(1);
    run(g1.db, 'complete', '2026-09-04T17:05:00-04:00');
    const exceptionId = raise(g1.db);
    queueJob(g1.db, operator(), 'backfill_bars'); // would never be claimed once the pointer moves

    const preview = resetPreview(g1.db, '2026-09-06T18:00:00-04:00', 1);
    expect(preview.dataDays).toBe(1);
    expect(preview.queuedToWithdraw).toBe(1);

    let successor: { raw: Database.Database; db: SqliteLike } | undefined;
    const pointerMoves: number[] = [];
    const report = performReset({
      db: g1.db,
      host: operator(),
      generationNo: 1,
      reason: 'dictionary change needs a clean generation',
      confirmation: 'RESET gen-001',
      openSuccessor: (no) => {
        successor = openGen(no);
        return successor.db;
      },
      commitPointer: (no) => {
        // The successor must already be complete when the pointer moves — the
        // pointer is the commit point, and both apps follow it immediately.
        expect(successor!.raw.prepare('SELECT COUNT(*) AS n FROM meta_job_request').get()).toEqual({ n: 2 });
        pointerMoves.push(no);
      }
    });

    expect(report).toMatchObject({ predecessorNo: 1, successorNo: 2, withdrawn: 1 });
    expect(pointerMoves).toEqual([2]);

    // The successor describes where it came from, and why.
    expect(successor!.raw.prepare('SELECT generation_no, status, predecessor_no, reset_reason FROM meta_generation').get())
      .toEqual({ generation_no: 2, status: 'pilot', predecessor_no: 1, reset_reason: 'dictionary change needs a clean generation' });
    // Configuration and the universe re-run with no operator re-entry.
    expect(successor!.raw.prepare("SELECT run_kind FROM meta_job_request WHERE state = 'queued' ORDER BY request_id").all())
      .toEqual([{ run_kind: 'universe_seed' }, { run_kind: 'legacy_import' }]);

    // The predecessor, reopened from disk by a fresh connection: closed, and
    // everything it held still there.
    g1.raw.close();
    const reopened = new Database(genPath(1));
    handles.push(reopened);
    const gen = reopened.prepare('SELECT status, closed_at FROM meta_generation').get() as { status: string; closed_at: string | null };
    expect(gen.status).toBe('closed');
    expect(gen.closed_at).toBe('2026-09-06T18:00:00-04:00');
    expect(reopened.prepare('SELECT exception_id FROM qa_exception').all()).toEqual([{ exception_id: exceptionId }]);
    expect(reopened.prepare('SELECT COUNT(*) AS n FROM meta_run').get()).toEqual({ n: 1 });
    expect(reopened.prepare('SELECT state FROM meta_job_request').get()).toEqual({ state: 'cancelled' });
  });

  it('changes nothing in the old generation if the pointer cannot be moved', () => {
    const g1 = openGen(1);
    queueJob(g1.db, operator(), 'backfill_bars');
    expect(() =>
      performReset({
        db: g1.db, host: operator(), generationNo: 1, reason: 'drift', confirmation: 'RESET gen-001',
        openSuccessor: (no) => openGen(no).db,
        commitPointer: () => { throw new Error('disk full'); }
      })
    ).toThrow(/disk full/);
    expect(g1.raw.prepare('SELECT status FROM meta_generation').get()).toEqual({ status: 'pilot' });
    expect(g1.raw.prepare('SELECT state FROM meta_job_request').get()).toEqual({ state: 'queued' });
  });

  it('refuses a successor that does not describe itself, before the pointer moves', () => {
    const g1 = openGen(1);
    expect(() =>
      performReset({
        db: g1.db, host: operator(), generationNo: 1, reason: 'drift', confirmation: 'RESET gen-001',
        openSuccessor: (no) => openGen(no, false).db,
        commitPointer: noPointer
      })
    ).toThrow(/without its meta_generation row/);
    expect(g1.raw.prepare('SELECT status FROM meta_generation').get()).toEqual({ status: 'pilot' });
  });
});
