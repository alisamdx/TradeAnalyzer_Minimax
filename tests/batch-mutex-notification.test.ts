import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BatchService, type BatchJobHandler, type BatchJobResult } from '../src/main/services/batch-service.js';

/**
 * The one-job-at-a-time mutex, and who hears about a refusal (v1.1.225).
 *
 * `checkSchedule` ticks every 5 minutes and a due job stays due until it
 * succeeds, so a job waiting behind the orchestrator chain was refused — and
 * notified — on every tick: ~30 identical warnings on 2026-09-10 while the 17:05
 * collector waited until 19:33. Nothing was wrong in any of them, and the job
 * was a member of the chain holding the lock anyway. An alarm that repeats while
 * nothing is wrong is what teaches an operator to ignore the channel.
 */

const ok = async (): Promise<BatchJobResult> => ({
  status: 'success', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0
});

function setup() {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const notifications: { message: string }[] = [];
  const batch = new BatchService(db, (n) => { notifications.push(n); }, () => undefined);

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder: BatchJobHandler = {
    name: 'holder', description: 'holds the mutex',
    run: async () => { await held; return ok(); }
  };
  batch.registerJob('holder', holder);
  batch.registerJob('waiter', { name: 'waiter', description: 'waits', run: ok });

  return { batch, notifications, release };
}

const busyOnes = (notifications: { message: string }[]) =>
  notifications.filter((n) => n.message.includes('is already running'));

describe('a refusal on the batch mutex', () => {
  it('is silent for a scheduled trigger — the next tick retries', async () => {
    const { batch, notifications, release } = setup();
    const running = batch.runJob('holder', 'manual');

    await batch.runJob('waiter', 'schedule');
    expect(busyOnes(notifications)).toHaveLength(0);

    // Repeated ticks stay silent: the count is the point, not the first one.
    await batch.runJob('waiter', 'schedule');
    await batch.runJob('waiter', 'schedule');
    expect(busyOnes(notifications)).toHaveLength(0);

    release();
    await running;
  });

  it('still notifies a manual or startup trigger — somebody is waiting on it', async () => {
    const { batch, notifications, release } = setup();
    const running = batch.runJob('holder', 'manual');

    await batch.runJob('waiter', 'manual');
    expect(busyOnes(notifications)).toHaveLength(1);
    expect(busyOnes(notifications)[0]?.message).toContain('"waiter" was not started');

    await batch.runJob('waiter', 'startup');
    expect(busyOnes(notifications)).toHaveLength(2);

    release();
    await running;
  });

  it('writes no batch_runs row for a refusal, however it was triggered', async () => {
    const { batch, release } = setup();
    const running = batch.runJob('holder', 'manual');

    await batch.runJob('waiter', 'schedule');
    await batch.runJob('waiter', 'manual');
    expect(batch.getLastRun('waiter')).toBeNull();

    release();
    await running;
  });
});
