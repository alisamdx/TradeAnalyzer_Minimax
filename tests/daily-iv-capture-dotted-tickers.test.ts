import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { DailyIvCaptureJob, formatSkipReasons } from '../src/main/services/jobs/daily-iv-capture.js';
import { IvHistoryService } from '../src/main/services/iv-history-service.js';
import type { ETradeDataProvider } from '../src/main/services/etrade-data-provider.js';
import type { ConstituentsService } from '../src/main/services/constituents-service.js';
import type { IVolatilityProvider } from '../src/main/services/ivolatility-provider.js';
import type { OptionContract } from '@shared/types.js';

// Regression for v1.1.368. v0.23.9 (2026-06-05) skipped every ticker containing a
// dot ("class share — no listed options") before asking E*Trade. The premise was
// wrong: E*Trade serves option chains for BRK.B, BF.A, BF.B, HEI.A and UHAL.B
// (HTTP 200 in logs/api on 2026-10-14). Their iv_history stopped on 2026-06-05, so
// IV rank and percentile for those names read a five-day series for four months.
// The job also reported those skips with no reason anywhere a log could show it.

const EXPIRATION = '2026-07-31'; // 30 DTE from the pinned clock below

function chainFor(spot: number): OptionContract[] {
  const strikes = [spot - 5, spot, spot + 5];
  return strikes.flatMap(strike => (['call', 'put'] as const).map(side => ({
    expiration: EXPIRATION, strike, side, iv: 0.25,
  }) as unknown as OptionContract));
}

describe('DailyIvCaptureJob — dotted share-class tickers', () => {
  let db: DbHandle;
  const signal = new AbortController().signal;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    // Keep the inter-call sleep at its floor so the test stays fast.
    db.prepare(`INSERT INTO batch_jobs (id, name, config_json) VALUES ('daily-iv-update', 'Daily IV Update', ?)`)
      .run(JSON.stringify({ callDelayMs: 200 }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T15:00:00Z')); // Wed Jul 1 2026, 11:00 ET
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it('asks E*Trade for BRK.B and stores its ATM IV under the dotted ticker; logs why LEN.B was skipped', async () => {
    const getOptionsExpirations = vi.fn(async (ticker: string) => {
      if (ticker === 'LEN.B') throw new Error('E*Trade options expirations: non-JSON response (HTTP 204)');
      return [EXPIRATION];
    });
    const getOptionsChain = vi.fn(async () => ({ underlyingPrice: 480, contracts: chainFor(480) }));
    const provider = { getOptionsExpirations, getOptionsChain, renewToken: vi.fn() } as unknown as ETradeDataProvider;

    const constituents = {
      getConstituents: (u: string) => (u === 'sp500' ? [{ ticker: 'BRK.B' }, { ticker: 'LEN.B' }] : []),
    } as unknown as ConstituentsService;
    const ivHistory = new IvHistoryService(db, {} as unknown as IVolatilityProvider, () => []);

    const job = new DailyIvCaptureJob(db, provider, ivHistory, constituents);
    const result = await job.run(() => {}, signal);

    // Both dotted tickers reached E*Trade (the old pre-filter asked neither).
    expect(getOptionsExpirations).toHaveBeenCalledWith('BRK.B');
    expect(getOptionsExpirations).toHaveBeenCalledWith('LEN.B');

    const row = db.prepare(`SELECT ticker, date, atm_iv, source FROM iv_history WHERE ticker = 'BRK.B'`).get() as
      { ticker: string; date: string; atm_iv: number; source: string } | undefined;
    expect(row).toEqual({ ticker: 'BRK.B', date: '2026-07-01', atm_iv: 25, source: 'etrade' });

    expect(result.tickersUpdated).toBe(1);
    expect(result.tickersSkipped).toBe(1);
    // The reason travels in notes, which the batch-run log line writes to logs/errors.
    expect(result.notes).toContain('Skipped: LEN.B (no listed options).');
  }, 15_000);

  it('formatSkipReasons is empty with no skips and caps a long list without dropping the total', () => {
    expect(formatSkipReasons([])).toBe('');
    const many = Array.from({ length: 45 }, (_, i) => ({ ticker: `T${i}`, reason: 'no expirations' }));
    const s = formatSkipReasons(many);
    expect(s).toContain('T39 (no expirations)');
    expect(s).not.toContain('T40 (');
    expect(s).toContain('and 5 more');
  });
});
