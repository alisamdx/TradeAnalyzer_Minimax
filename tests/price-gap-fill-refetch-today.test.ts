// Regression: the batch runs twice daily (≈10:15 ET intraday scan + ≈16:30 ET
// after close). The morning run stores a PARTIAL same-day bar. The old staleness
// gate (`HAVING MAX(date) < date('now')`) then treated that partial bar as fresh,
// so the evening run skipped the ticker and never overwrote it — the brief reused
// a partial bar (volume ~10-25% of average, breakouts on a non-final close). The
// job now re-fetches the recent window for every ticker with history on every run
// (historical_prices is INSERT OR REPLACE, so the final bar overwrites the partial
// one). This test asserts a ticker whose latest bar is TODAY is still scheduled.
// see CHANGELOG v1.1.49.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const fetchAndStorePrices = vi.fn();
vi.mock('../src/main/services/historical-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/main/services/historical-service.js')>();
  return { ...actual, fetchAndStorePrices: (...a: unknown[]) => fetchAndStorePrices(...a) };
});

const { PriceGapFillJob } = await import('../src/main/services/jobs/price-gap-fill-job.js');

function utcDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function seedBar(db: ReturnType<typeof openDatabase>, ticker: string, date: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO historical_prices
      (ticker, date, open, high, low, close, volume, adjusted_close, source, fetched_at)
    VALUES (?, ?, 10, 11, 9, 10, 1000, 10, 'polygon', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(ticker, date);
}

describe('PriceGapFillJob — re-fetches today on every run', () => {
  afterEach(() => { fetchAndStorePrices.mockReset(); });

  it('schedules a ticker whose latest bar is TODAY (was skipped before the fix)', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);

    seedBar(db, 'TODAYSTK', utcDate(0));   // latest bar = today (partial morning bar)
    seedBar(db, 'YESTSTK', utcDate(-1));   // latest bar = yesterday

    fetchAndStorePrices.mockResolvedValue(1);

    const job = new PriceGapFillJob(db, () => 'fake-key');
    const result = await job.run(() => {}, new AbortController().signal);

    const fetched = new Set(fetchAndStorePrices.mock.calls.map(c => c[2])); // arg[2] = ticker
    expect(fetched.has('TODAYSTK')).toBe(true);  // the regression: today-bar ticker re-fetched
    expect(fetched.has('YESTSTK')).toBe(true);
    expect(result.status).toBe('success');
    db.close();
  });
});
