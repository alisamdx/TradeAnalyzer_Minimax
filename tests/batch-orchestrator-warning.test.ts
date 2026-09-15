import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BatchService, type BatchJobResult } from '../src/main/services/batch-service.js';
import { BatchOrchestratorJob } from '../src/main/services/jobs/batch-orchestrator-job.js';
import type { EmailService } from '../src/main/services/email-service.js';

/**
 * A `warning` sub-job continues the orchestrator chain (v1.1.246).
 *
 * `warning` exists so a job whose fallback keeps the chain alive — the constituents
 * refresh when every source failed — stops reading as green. It must not become a
 * second way to halt the nightly chain: only `failed` does that.
 */

const result = (status: BatchJobResult['status'], notes?: string): BatchJobResult => ({
  status, tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0, ...(notes ? { notes } : {}),
});

describe('the orchestrator and a warning sub-job', () => {
  it('runs the next job after a warning and counts the warning in its note', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const batch = new BatchService(db, () => undefined, () => undefined);
    const email = { isConfigured: () => false } as unknown as EmailService;

    batch.registerJob('batch-orchestrator', new BatchOrchestratorJob(batch, () => null, email), {
      sequenceOrder: 1,
      defaultConfig: { scheduleSlots: [], validateEtradeToken: false, emailOnStart: false, jobs: [] },
    });
    const ran: string[] = [];
    batch.registerJob('refresh', { name: 'refresh', description: 'd', run: async () => { ran.push('refresh'); return result('warning', 'both sources failed — kept existing list'); } });
    batch.registerJob('brief', { name: 'brief', description: 'd', run: async () => { ran.push('brief'); return result('success'); } });

    await batch.runJob('batch-orchestrator', 'manual');

    expect(ran).toEqual(['refresh', 'brief']);
    const orchestrator = batch.getLastRun('batch-orchestrator');
    expect(orchestrator?.status).toBe('success');
    expect(orchestrator?.notes).toBe('2 succeeded (1 with warnings) · 0 skipped');
    expect(batch.getLastRun('refresh')?.status).toBe('warning');
  });
});
