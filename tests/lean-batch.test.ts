import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BatchService, type BatchJobHandler, type BatchJobResult } from '../src/main/services/batch-service.js';
import { isLeanSlot } from '../src/main/services/jobs/batch-orchestrator-job.js';

// Lean intraday batch (spec 08 §4 / #4): the ~10:15 slot skips after_close_only jobs (the post-brief
// tail); the after-close slot runs everything. Pins the slot-lean decision + the per-job flag.

describe('isLeanSlot', () => {
  const slots = ['10:15', '17:00'];
  it('treats every slot except the latest as lean (default)', () => {
    expect(isLeanSlot('10:15', slots)).toBe(true);
    expect(isLeanSlot('17:00', slots)).toBe(false); // after-close = full run
  });
  it('is never lean for manual/startup runs (no slot)', () => {
    expect(isLeanSlot(null, slots)).toBe(false);
  });
  it('a single-slot day runs full (not lean)', () => {
    expect(isLeanSlot('10:15', ['10:15'])).toBe(false);
  });
  it('honours an explicit leanSlots list', () => {
    expect(isLeanSlot('12:00', slots, ['12:00'])).toBe(true);
    expect(isLeanSlot('10:15', slots, ['12:00'])).toBe(false); // not in the explicit list
  });
});

describe('after_close_only per-job flag', () => {
  function svc(): { db: DbHandle; batch: BatchService } {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const batch = new BatchService(db, () => {}, () => {});
    return { db, batch };
  }

  const handler = (name: string): BatchJobHandler => ({
    name,
    description: name,
    run: async (): Promise<BatchJobResult> => ({
      status: 'success', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
    }),
  });

  it('registerJob seeds afterCloseOnly and getJobs reflects it', () => {
    const { batch } = svc();
    batch.registerJob('brief-job', handler('brief'), { sequenceOrder: 1 });
    batch.registerJob('tail-job', handler('tail'), { sequenceOrder: 2, afterCloseOnly: true });
    const byId = Object.fromEntries(batch.getJobs().map((j) => [j.id, j.afterCloseOnly]));
    expect(byId['brief-job']).toBe(false);
    expect(byId['tail-job']).toBe(true);
  });

  it('the lean slot filters out after_close_only jobs (the orchestrator expression)', () => {
    const { batch } = svc();
    batch.registerJob('brief-job', handler('brief'), { sequenceOrder: 1 });
    batch.registerJob('tail-job', handler('tail'), { sequenceOrder: 2, afterCloseOnly: true });
    const all = batch.getSubJobs([]);
    const applyLean = (lean: boolean) => all.filter((j) => !lean || !j.afterCloseOnly).map((j) => j.id);
    expect(applyLean(true)).toEqual(['brief-job']);            // tail skipped in the lean slot
    expect(applyLean(false)).toEqual(['brief-job', 'tail-job']); // full slot runs everything
  });

  it('updateJobConfig toggles after_close_only', () => {
    const { batch } = svc();
    batch.registerJob('tail-job', handler('tail'), { sequenceOrder: 1, afterCloseOnly: true });
    batch.updateJobConfig('tail-job', { afterCloseOnly: false });
    expect(batch.getJobs().find((j) => j.id === 'tail-job')!.afterCloseOnly).toBe(false);
  });
});

describe('getBriefFreshness', () => {
  function svc(): { db: DbHandle; batch: BatchService } {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    return { db, batch: new BatchService(db, () => {}, () => {}) };
  }
  const insertBrief = (db: DbHandle, generatedAt: string) =>
    db.prepare("INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks, run_meta) VALUES (?, '2030-01-01T00:00:00Z', 'inflection', '[]', '{}')").run(generatedAt);

  it('reports no brief on an empty DB', () => {
    expect(svc().batch.getBriefFreshness()).toEqual({ generatedAt: null, etDate: null, isToday: false });
  });
  it('flags a same-day brief as today', () => {
    const { db, batch } = svc();
    insertBrief(db, new Date().toISOString());
    expect(batch.getBriefFreshness().isToday).toBe(true);
  });
  it('flags an old brief as stale', () => {
    const { db, batch } = svc();
    insertBrief(db, '2020-01-02T15:00:00Z');
    const f = batch.getBriefFreshness();
    expect(f.isToday).toBe(false);
    expect(f.generatedAt).toBe('2020-01-02T15:00:00Z');
  });
});
