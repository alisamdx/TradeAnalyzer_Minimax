import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { DailyIvCaptureJob } from '../src/main/services/jobs/daily-iv-capture.js';
import type { ETradeDataProvider } from '../src/main/services/etrade-data-provider.js';
import type { IvHistoryService } from '../src/main/services/iv-history-service.js';
import type { ConstituentsService } from '../src/main/services/constituents-service.js';

// Regression for the June 2026 evening-chain halts: a DORMANT E*Trade token
// (inactive >2h) killed the connectivity probe with a terminated/hung stream —
// NOT a clean 401 — so the old auth-message heuristic never attempted a renewal
// and the whole orchestrator chain stopped at Daily IV Update 8 of 10 trading
// days. The check must now renew-and-retry once on ANY probe failure.

const emptyConstituents = {
  getConstituents: () => [],
} as unknown as ConstituentsService;

const ivHistory = {} as unknown as IvHistoryService;

function makeProvider(behavior: {
  probeResults: Array<'ok' | Error>;
  renewError?: Error;
}) {
  let probeCall = 0;
  const getOptionsExpirations = vi.fn(async () => {
    const r = behavior.probeResults[Math.min(probeCall++, behavior.probeResults.length - 1)]!;
    if (r instanceof Error) throw r;
    return ['2026-08-21'];
  });
  const renewToken = vi.fn(async () => {
    if (behavior.renewError) throw behavior.renewError;
  });
  return {
    provider: { getOptionsExpirations, renewToken } as unknown as ETradeDataProvider,
    getOptionsExpirations,
    renewToken,
  };
}

describe('DailyIvCaptureJob — connectivity check renew-and-retry', () => {
  let db: DbHandle;
  const noop = () => {};
  const signal = new AbortController().signal;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    // Pin to a known NYSE trading day so the non-trading-day guard never skips.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T15:00:00Z')); // Wed Jul 1 2026, 11:00 ET
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renews and retries when the probe dies with a NON-auth error (dormant token → terminated stream)', async () => {
    const { provider, getOptionsExpirations, renewToken } = makeProvider({
      probeResults: [new Error('terminated'), 'ok'],
    });

    const job = new DailyIvCaptureJob(db, provider as ETradeDataProvider, ivHistory, emptyConstituents);
    const result = await job.run(noop, signal);

    expect(renewToken).toHaveBeenCalledTimes(1);
    expect(getOptionsExpirations).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success'); // empty universe → clean success after the check
    expect(result.errorMessage).toBeUndefined();
  });

  it('reports token-expired (with Reconnect CTA) when the error is auth-shaped and renewal fails', async () => {
    const { provider } = makeProvider({
      probeResults: [new Error('oauth_problem=token_rejected (401)')],
      renewError: new Error('E*Trade renew token failed (401)'),
    });

    const job = new DailyIvCaptureJob(db, provider as ETradeDataProvider, ivHistory, emptyConstituents);
    const result = await job.run(noop, signal);

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('token expired');
    expect(result.notification?.cta?.label).toBe('Reconnect');
  });

  it('reports a connectivity failure (no CTA) when renew+retry still fails with a non-auth error', async () => {
    const { provider, renewToken } = makeProvider({
      probeResults: [new Error('terminated')], // every probe attempt dies the same way
    });

    const job = new DailyIvCaptureJob(db, provider as ETradeDataProvider, ivHistory, emptyConstituents);
    const result = await job.run(noop, signal);

    expect(renewToken).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.errorMessage).toContain('after token renew + retry');
    expect(result.notification).toBeUndefined();
  });
});
