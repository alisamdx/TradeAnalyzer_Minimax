import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  BatchService,
  formatBatchRunLog,
  type BatchJobResult,
  type BatchRunLogEntry,
} from '../src/main/services/batch-service.js';

/**
 * Every finished batch run is written to the run logger (v1.1.245).
 *
 * On 2026-09-14 the collector's gate email never arrived, and the one record of
 * why — the data-collector run's note — lived only in `batch_runs`, readable
 * only inside the app. The run logger puts that note in `logs/errors`, a plain
 * file kept 90 days, for every job and every trigger.
 */

const result = (over: Partial<BatchJobResult> = {}): BatchJobResult => ({
  status: 'success', tickersAttempted: 3, tickersUpdated: 2, tickersSkipped: 1, tickersFailed: 0, ...over,
});

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const entries: BatchRunLogEntry[] = [];
  const batch = new BatchService(db, () => undefined, () => undefined, (e) => { entries.push(e); });
  return { batch, entries };
}

describe('the batch run log', () => {
  it('records a finished run with its note, whatever triggered it', async () => {
    const { batch, entries } = setup();
    batch.registerJob('collector', {
      name: 'collector', description: 'd',
      run: async () => result({ notes: 'RED — 3 blocking, 1 warning(s); email NOT sent (SMTP 552)' }),
    });

    await batch.runJob('collector', 'schedule', false, '17:05');

    expect(entries).toHaveLength(1);
    const line = formatBatchRunLog(entries[0]!);
    expect(line.level).toBe('INFO');
    expect(line.operation).toBe('batch-run:collector');
    expect(line.message).toContain('collector success');
    expect(line.message).toContain('slot=17:05');
    expect(line.message).toContain('email NOT sent (SMTP 552)');
  });

  it('logs a failed run at ERROR with its error message', async () => {
    const { batch, entries } = setup();
    batch.registerJob('boom', {
      name: 'boom', description: 'd',
      run: async () => { throw new Error('generation locked'); },
    });

    await batch.runJob('boom', 'manual');

    const line = formatBatchRunLog(entries[0]!);
    expect(line.level).toBe('ERROR');
    expect(line.message).toContain('error: generation locked');
  });

  it('logs a sub-job the orchestrator runs directly, marked as such', async () => {
    const { batch, entries } = setup();
    batch.registerJob('sub', { name: 'sub', description: 'd', run: async () => result({ status: 'skipped', notes: 'not due' }) });

    await batch.runJobDirect('sub', 'schedule', '17:00', new AbortController().signal);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.viaOrchestrator).toBe(true);
    expect(formatBatchRunLog(entries[0]!).message).toContain('via orchestrator');
  });

  it('keeps a warning run as warning — stored, logged at WARNING, and not shown as success', async () => {
    const { batch, entries } = setup();
    batch.registerJob('refresh', { name: 'refresh', description: 'd', run: async () => result({ status: 'warning', notes: 'both sources failed — kept existing list' }) });

    await batch.runJob('refresh', 'schedule', false, '17:00');

    expect(batch.getLastRun('refresh')?.status).toBe('warning');
    expect(batch.getJobs().find((j) => j.id === 'refresh')?.lastRunStatus).toBe('warning');
    expect(formatBatchRunLog(entries[0]!).level).toBe('WARNING');
  });

  it('never lets a throwing logger break the run', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const batch = new BatchService(db, () => undefined, () => undefined, () => { throw new Error('disk full'); });
    batch.registerJob('job', { name: 'job', description: 'd', run: async () => result() });

    await batch.runJob('job', 'manual');

    expect(batch.getLastRun('job')?.status).toBe('success');
  });
});
