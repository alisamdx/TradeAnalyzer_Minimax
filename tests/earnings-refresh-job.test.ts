import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { EarningsService } from '../src/main/services/earnings-service.js';

// secureGet would try to decrypt via Electron safeStorage (unavailable in tests),
// so stub it to a fixed Finnhub key — the job only needs a truthy key to run Phase 1.
vi.mock('../src/main/services/secure-settings.js', () => ({
  secureGet: (_db: unknown, key: string) => (key === 'finnhubApiKey' ? 'TEST_KEY' : ''),
}));

const { EarningsRefreshJob } = await import('../src/main/services/jobs/earnings-refresh-job.js');

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

describe('EarningsRefreshJob — nearest-future-date wins across windows', () => {
  let db: DbHandle;
  const noop = () => {};
  const signal = new AbortController().signal;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare(`INSERT INTO constituents (ticker, index_name, company_name) VALUES ('NVDA','sp500','NVIDIA')`).run();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('keeps the nearer earnings date even though window 2 (later quarter) is fetched last', async () => {
    const near = iso(60);  // window 1 (0–90d)  — the TRUE next earnings
    const far = iso(150);  // window 2 (90–180d) — the following quarter

    // Mock the Finnhub bulk endpoint: respond per requested window so the later
    // window returns the later date (the exact ordering that caused the overwrite bug).
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      const from = u.searchParams.get('from')!;
      const to = u.searchParams.get('to')!;
      const inWin = (d: string) => d >= from && d <= to;
      const cal: Array<Record<string, unknown>> = [];
      if (inWin(near)) cal.push({ symbol: 'NVDA', date: near, hour: 'amc' });
      if (inWin(far)) cal.push({ symbol: 'NVDA', date: far, hour: 'amc' });
      return { ok: true, json: async () => ({ earningsCalendar: cal }) } as Response;
    }));

    const svc = new EarningsService(db);
    const job = new EarningsRefreshJob(db, svc, () => null);
    await job.run(noop, signal, false);

    const stored = svc.getForTicker('NVDA');
    expect(stored?.reportDate).toBe(near); // NOT the later `far` date
  });

  it('does not overwrite a nearer stored date when only the later window returns a date', async () => {
    const near = iso(20);
    const far = iso(150);
    // Pre-seed the nearer (correct) date as if a prior good run stored it.
    new EarningsService(db).upsertFromProvider('NVDA', near, 'amc', 'finnhub', true);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      const from = u.searchParams.get('from')!;
      const to = u.searchParams.get('to')!;
      const cal: Array<Record<string, unknown>> = [];
      if (far >= from && far <= to) cal.push({ symbol: 'NVDA', date: far, hour: 'amc' });
      return { ok: true, json: async () => ({ earningsCalendar: cal }) } as Response;
    }));

    const svc = new EarningsService(db);
    const job = new EarningsRefreshJob(db, svc, () => null);
    await job.run(noop, signal, false);

    expect(svc.getForTicker('NVDA')?.reportDate).toBe(near);
  });
});
