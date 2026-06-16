// Regression test: BriefingService.getMarketRegime reads VIX from quote_cache
// (populated by the brief job via E*Trade), not from Polygon's getQuote('VIX')
// — the stocks snapshot can't serve an index and always returned null.

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BriefingService } from '../src/main/services/briefing-service.js';
import type { HistoricalDataService } from '../src/main/services/historical-service.js';
import type { PolygonDataProvider } from '../src/main/services/polygon-provider.js';
import type { TokenBucketRateLimiter } from '../src/main/services/rate-limiter.js';

function makeBriefingService(vix: number | null) {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  if (vix !== null) {
    db.prepare(`INSERT INTO quote_cache (ticker, last, fetched_at) VALUES ('VIX', ?, '2026-06-15')`).run(vix);
  }

  // SPY quote + history (regime trend path) — kept minimal; we assert on VIX.
  const dataProvider = {
    getQuote: async (ticker: string) => (ticker === 'VIX'
      ? (() => { throw new Error('getQuote("VIX") must not be called — VIX comes from quote_cache'); })()
      : { last: 500 }),
  } as unknown as PolygonDataProvider;
  const historicalService = { getPrices: async () => [] } as unknown as HistoricalDataService;
  const rateLimiter = { acquire: async () => {} } as unknown as TokenBucketRateLimiter;

  return new BriefingService(db, historicalService, dataProvider, rateLimiter);
}

describe('BriefingService.getMarketRegime — VIX from quote_cache', () => {
  it('reads the E*Trade-sourced VIX and classifies the level (high > 25)', async () => {
    const regime = await makeBriefingService(31.5).getMarketRegime();
    expect(regime.vixValue).toBe(31.5);
    expect(regime.vixLevel).toBe('high');
  });

  it('classifies a low VIX (< 15)', async () => {
    const regime = await makeBriefingService(12).getMarketRegime();
    expect(regime.vixValue).toBe(12);
    expect(regime.vixLevel).toBe('low');
  });

  it('falls back to null/normal when quote_cache has no VIX row (never calls Polygon for VIX)', async () => {
    const regime = await makeBriefingService(null).getMarketRegime();
    expect(regime.vixValue).toBeNull();
    expect(regime.vixLevel).toBe('normal');
  });
});
