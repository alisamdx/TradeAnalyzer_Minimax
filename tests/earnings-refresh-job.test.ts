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

// ── Regression: Finnhub bulk result cap (v1.1.136) ──────────────────────────
//
// Finnhub's free-tier bulk calendar caps a response at 1500 entries and truncates
// from the FRONT — a from=today&to=+90d call during earnings season returns only the
// LAST couple of weeks of that range. The old job issued two fixed 90-day windows and
// trusted whatever came back, so near-term dates were silently dropped and the ticker
// was stored with the FOLLOWING quarter's date.
//
// Found live 2026-08-27: NVDA reported 2026-08-26 AMC, but earnings_calendar held
// 2026-11-17 (written 2026-08-25 by a truncated bulk call). loadEarningsPenalty()
// therefore saw no earnings within 45 days, the -20 income/wheel/bearish penalty never
// applied, and NVDA ranked wheel #1 in the brief on the very day it printed.
describe('EarningsRefreshJob — Finnhub bulk result cap', () => {
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

  it('subdivides a capped window instead of accepting its truncated tail', async () => {
    const near = iso(10);   // the TRUE next earnings — lives in the truncated-away front
    const far  = iso(150);  // the following quarter — survives in the returned tail

    // Emulate Finnhub: any window wider than 100 days overflows the cap and comes
    // back holding ONLY its tail. Narrower windows return the full range.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get('symbol')) {
        return { ok: true, json: async () => ({ earningsCalendar: [] }) } as Response;
      }
      const from = u.searchParams.get('from')!;
      const to = u.searchParams.get('to')!;
      const inWin = (d: string) => d >= from && d <= to;
      const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

      const cal: Array<Record<string, unknown>> = [];
      if (spanDays > 100) {
        // Truncated: only the tail of the range survives, padded to the cap so the
        // job can recognise the response as overflowing.
        if (inWin(far)) cal.push({ symbol: 'NVDA', date: far, hour: 'amc' });
        while (cal.length < 1500) cal.push({ symbol: 'FILLER', date: far, hour: 'amc' });
      } else {
        if (inWin(near)) cal.push({ symbol: 'NVDA', date: near, hour: 'amc' });
        if (inWin(far)) cal.push({ symbol: 'NVDA', date: far, hour: 'amc' });
      }
      return { ok: true, json: async () => ({ earningsCalendar: cal }) } as Response;
    }));

    const svc = new EarningsService(db);
    const job = new EarningsRefreshJob(db, svc, () => null);
    await job.run(noop, signal, false);

    // Without subdivision the single capped call yields only `far` and NVDA is stored
    // one full quarter late — exactly the NVDA-on-earnings-day failure.
    expect(svc.getForTicker('NVDA')?.reportDate).toBe(near);
  }, 30_000);

  it('re-verifies a stored date beyond the sweep horizon instead of trusting it', async () => {
    const poisoned = iso(200);  // beyond the 180d sweep — the truncation bug's signature
    const truth    = iso(12);   // what a per-ticker lookup returns
    new EarningsService(db).upsertFromProvider('NVDA', poisoned, 'amc', 'finnhub', true);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      // Bulk sweep sees nothing; only the per-ticker endpoint knows the near date.
      const cal = u.searchParams.get('symbol')
        ? [{ symbol: 'NVDA', date: truth, hour: 'amc' }, { symbol: 'NVDA', date: poisoned, hour: 'amc' }]
        : [];
      return { ok: true, json: async () => ({ earningsCalendar: cal }) } as Response;
    }));

    const svc = new EarningsService(db);
    const job = new EarningsRefreshJob(db, svc, () => null);
    await job.run(noop, signal, false);

    // The old delta filter skipped any ticker holding a future date, so the bogus far
    // date suppressed the very lookup that would have corrected it — permanently.
    expect(svc.getForTicker('NVDA')?.reportDate).toBe(truth);
  }, 30_000);
});

// ── Bounded later-move (v1.1.137) ───────────────────────────────────────────
//
// v1.1.136 forbade the sweep from ever pushing a stored future date further out.
// That is the right instinct for a ~90-day jump (the signature of a Finnhub coverage
// gap hiding the near date and returning the following quarter) but it also refused
// the routine case of an issuer refining a scheduled date by a day or two, leaving
// rows stale-early for weeks — measured 2026-08-28, 19 of 69 names reporting within
// 45 days were 1-8 days early, several written two months earlier.
//
// A COMPLETE sweep may now move a date later by up to MAX_LATER_SLIP_DAYS (14).
describe('EarningsRefreshJob — bounded later-move', () => {
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

  // Bulk sweep returns exactly one date for NVDA; per-ticker endpoint returns nothing,
  // so only the sweep's write policy is under test.
  function stubSweepReturning(date: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.searchParams.get('symbol')) {
        return { ok: true, json: async () => ({ earningsCalendar: [] }) } as Response;
      }
      const from = u.searchParams.get('from')!;
      const to = u.searchParams.get('to')!;
      const cal = date >= from && date <= to ? [{ symbol: 'NVDA', date, hour: 'amc' }] : [];
      return { ok: true, json: async () => ({ earningsCalendar: cal }) } as Response;
    }));
  }

  it('accepts a small later slip — an issuer refining its scheduled date', async () => {
    const stored = iso(30);
    const slipped = iso(31);   // +1 day
    new EarningsService(db).upsertFromProvider('NVDA', stored, 'amc', 'finnhub', true);
    stubSweepReturning(slipped);

    const svc = new EarningsService(db);
    await new EarningsRefreshJob(db, svc, () => null).run(noop, signal, false);

    expect(svc.getForTicker('NVDA')?.reportDate).toBe(slipped);
  }, 30_000);

  it('still refuses a quarter-sized later jump — the coverage-gap signature', async () => {
    const stored = iso(30);
    const nextQuarter = iso(120);  // ~90 days out — a hidden near date, not a slip
    new EarningsService(db).upsertFromProvider('NVDA', stored, 'amc', 'finnhub', true);
    stubSweepReturning(nextQuarter);

    const svc = new EarningsService(db);
    await new EarningsRefreshJob(db, svc, () => null).run(noop, signal, false);

    expect(svc.getForTicker('NVDA')?.reportDate).toBe(stored);
  }, 30_000);

  it('refuses a later move at the boundary + 1 day', async () => {
    const stored = iso(30);
    new EarningsService(db).upsertFromProvider('NVDA', stored, 'amc', 'finnhub', true);
    stubSweepReturning(iso(45));   // +15d, one past the 14d bound

    const svc = new EarningsService(db);
    await new EarningsRefreshJob(db, svc, () => null).run(noop, signal, false);

    expect(svc.getForTicker('NVDA')?.reportDate).toBe(stored);
  }, 30_000);

  it('still moves a date NEARER without any bound', async () => {
    const stored = iso(120);
    const nearer = iso(5);   // healing a poisoned row — always allowed
    new EarningsService(db).upsertFromProvider('NVDA', stored, 'amc', 'finnhub', true);
    stubSweepReturning(nearer);

    const svc = new EarningsService(db);
    await new EarningsRefreshJob(db, svc, () => null).run(noop, signal, false);

    expect(svc.getForTicker('NVDA')?.reportDate).toBe(nearer);
  }, 30_000);
});
