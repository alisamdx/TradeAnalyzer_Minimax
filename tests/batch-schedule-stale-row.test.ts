import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BatchService, type BatchJobResult } from '../src/main/services/batch-service.js';
import { BatchOrchestratorJob } from '../src/main/services/jobs/batch-orchestrator-job.js';
import type { EmailService } from '../src/main/services/email-service.js';

/**
 * One scheduler tick must not run a job its own earlier await already ran (v1.1.352).
 *
 * 2026-10-12: the app started at 19:09 ET, after every schedule time of the day. The first tick ran
 * the orchestrator's 17:00 slot, whose chain ran data-collector (run 75, until 21:12). The same tick
 * then reached data-collector's own 17:05 schedule with the job row it had read at 19:09, whose
 * `last_success_date` was still yesterday, and ran a second full collection (run 76).
 */

const ok = (): BatchJobResult => ({ status: 'success', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 });

afterEach(() => {
  vi.useRealTimers();
});

describe('the daily scheduler', () => {
  it('does not run a job a second time after the orchestrator chain already ran it in the same tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T23:09:58Z')); // 19:09 ET, Monday — every slot is overdue

    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const batch = new BatchService(db, () => undefined, () => undefined);
    const email = { isConfigured: () => false } as unknown as EmailService;

    batch.registerJob('batch-orchestrator', new BatchOrchestratorJob(batch, () => null, email), {
      sequenceOrder: 1,
      dailyScheduleEnabled: true,
      defaultConfig: { scheduleSlots: ['17:00'], validateEtradeToken: false, emailOnStart: false, jobs: [] },
    });
    let collectorRuns = 0;
    batch.registerJob(
      'data-collector',
      { name: 'collector', description: 'd', run: async () => { collectorRuns++; return ok(); } },
      { sequenceOrder: 2, dailyScheduleEnabled: true, dailyScheduleTime: '17:05' }
    );

    await (batch as unknown as { checkSchedule(): Promise<void> }).checkSchedule();

    expect(batch.getLastRun('batch-orchestrator')?.status).toBe('success');
    expect(collectorRuns).toBe(1);
  });
});
