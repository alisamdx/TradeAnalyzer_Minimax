import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  BatchService,
  type BatchJobHandler,
  type BatchJobResult
} from '../src/main/services/batch-service.js';

/**
 * `batch_jobs.enabled` must mean "does not run on its own" — v1.1.206.
 *
 * It did not. `runStartupJobs` filtered `enabled && run_on_startup` and the
 * daily tick filtered `enabled && daily_schedule_enabled`, but the orchestrator
 * chain — which is what actually runs jobs, twice a trading day — ignored the
 * column entirely. So there was no single switch that stopped a job, and the
 * three NewApp collector jobs kept running against a malformed generation and
 * emailing a RED gate report each time.
 *
 * Two defaults compounded and both are pinned below: a job absent from the
 * orchestrator's `config_json.jobs` defaults to *enabled*, so a newly registered
 * job joined the chain without anyone opting it in.
 */

function svc(): { db: DbHandle; batch: BatchService } {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return { db, batch: new BatchService(db, () => {}, () => {}) };
}

const handler = (name: string): BatchJobHandler => ({
  name,
  description: name,
  run: async (): Promise<BatchJobResult> => ({
    status: 'success',
    tickersAttempted: 0,
    tickersUpdated: 0,
    tickersSkipped: 0,
    tickersFailed: 0
  })
});

describe('the orchestrator chain honours batch_jobs.enabled', () => {
  it('excludes a disabled job and keeps an enabled one', () => {
    // Both arms. A filter that excluded everything would look identical in a
    // suite that only asserted the exclusion.
    const { batch } = svc();
    batch.registerJob('on-job', handler('on'), { sequenceOrder: 1 });
    batch.registerJob('off-job', handler('off'), { sequenceOrder: 2, enabled: false });

    expect(batch.getSubJobs([]).map((j) => j.id)).toEqual(['on-job']);
  });

  it('a disabled job stays out even when the orchestrator config lists it as enabled', () => {
    // The config is a per-chain opt-out; the column is the job's own switch. If
    // the config could override it, "off" would depend on which of two places
    // you looked, which is how this was missed.
    const { batch } = svc();
    batch.registerJob('off-job', handler('off'), { sequenceOrder: 1, enabled: false });

    expect(batch.getSubJobs([{ id: 'off-job', enabled: true }]).map((j) => j.id)).toEqual([]);
  });

  it('an unlisted job still defaults to enabled — the other half of the trap', () => {
    // Pinned deliberately rather than changed. A job absent from the config
    // joins the chain, which is why registering the collector jobs `enabled`
    // was enough to put them in the after-close run with nobody opting in.
    const { batch } = svc();
    batch.registerJob('new-job', handler('new'), { sequenceOrder: 1 });

    expect(batch.getSubJobs([{ id: 'other', enabled: true }]).map((j) => j.id)).toEqual(['new-job']);
  });

  it('a disabled job can still be run by hand', () => {
    // `enabled = 0` means "not triggered on its own", never "cannot be run" —
    // that distinction is the whole of the operator's request. `runJob` has
    // never consulted the column and must not start.
    const { db, batch } = svc();
    batch.registerJob('off-job', handler('off'), { sequenceOrder: 1, enabled: false });

    return batch.runJob('off-job', 'manual').then(() => {
      const runs = db
        .prepare("SELECT status, trigger FROM batch_runs WHERE job_id = 'off-job'")
        .all() as { status: string; trigger: string }[];
      expect(runs).toHaveLength(1);
      expect(runs[0]!.trigger).toBe('manual');
    });
  });
});

describe('registerJob seeds `enabled`, and only on a fresh install', () => {
  it('seeds 0 when the option says so, 1 by default', () => {
    const { db, batch } = svc();
    batch.registerJob('on-job', handler('on'), { sequenceOrder: 1 });
    batch.registerJob('off-job', handler('off'), { sequenceOrder: 2, enabled: false });

    const byId = Object.fromEntries(
      (db.prepare('SELECT id, enabled FROM batch_jobs').all() as { id: string; enabled: number }[])
        .map((r) => [r.id, r.enabled])
    );
    expect(byId['on-job']).toBe(1);
    expect(byId['off-job']).toBe(0);
  });

  it('never overwrites an existing row — the frozen-column trap', () => {
    // `INSERT OR IGNORE`. This is why the switch-off needed migration 080 and
    // could not be done in `index.ts` alone; the same trap as `sequence_order`,
    // `config_json` and `after_close_only` before it.
    const { db, batch } = svc();
    batch.registerJob('job', handler('job'), { sequenceOrder: 1, enabled: false });
    db.prepare("UPDATE batch_jobs SET enabled = 1 WHERE id = 'job'").run();

    batch.registerJob('job', handler('job'), { sequenceOrder: 1, enabled: false });

    const row = db.prepare("SELECT enabled FROM batch_jobs WHERE id = 'job'").get() as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });
});

describe('migration 080 switches the collector jobs to manual-only', () => {
  it('leaves them registered but never self-triggering', () => {
    // Count-agnostic: the migration is asserted by its effect on rows it finds,
    // not by a migration number or a total.
    const { db } = svc();
    const ids = ['data-collector', 'collector-watchdog', 'collector-oneshot'];

    // The rows only exist once `index.ts` has registered them, which does not
    // happen in a test process — so seed them as an upgraded install would have
    // them, then re-run the migration and check what it does.
    const insert = db.prepare(
      `INSERT INTO batch_jobs
         (id, name, description, enabled, run_on_startup, startup_delay_seconds,
          daily_schedule_enabled, daily_schedule_time, sequence_order, after_close_only)
       VALUES (?, ?, ?, 1, 1, 30, 1, '17:05', 900, 1)`
    );
    for (const id of ids) insert.run(id, id, id);

    // The migration FILE, not a copy of its SQL. Re-typing the statement here
    // would assert the test's own text and pass whatever the migration said.
    db.exec(readFileSync(join(MIGRATIONS_DIR, '080_collector_jobs_manual_only.sql'), 'utf8'));

    for (const id of ids) {
      const row = db
        .prepare(
          'SELECT enabled, daily_schedule_enabled, run_on_startup FROM batch_jobs WHERE id = ?'
        )
        .get(id) as { enabled: number; daily_schedule_enabled: number; run_on_startup: number };
      expect(row, id).toEqual({ enabled: 0, daily_schedule_enabled: 0, run_on_startup: 0 });
    }

    // And the point of all three: no automatic path can reach them.
    const batch = new BatchService(db, () => {}, () => {});
    expect(batch.getSubJobs([]).map((j) => j.id)).not.toContain('data-collector');
  });
});
