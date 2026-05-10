import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { QuoteCache, FundamentalsCache, OptionsCache, initCacheTables } from '../src/main/services/cache-service.js';
import type { DerivedRatios } from '../src/shared/types.js';

// Fresh in-memory DB for each test.
function freshDb() {
  const db = openDatabase(':memory:');
  initCacheTables(db);
  return db;
}

const SAMPLE_QUOTE = {
  ticker: 'AAPL',
  last: 180.50,
  prevClose: 178.20,
  bid: 180.45,
  ask: 180.55,
  volume: 45_000_000,
  dayHigh: 181.00,
  dayLow: 177.50,
  ivRank: 45,
  ivPercentile: 38,
  fetchedAt: new Date().toISOString()
};

const SAMPLE_RATIOS: DerivedRatios = {
  peRatio: 28.5,
  eps: 6.33,
  marketCap: 2_800_000_000_000,
  debtToEquity: 0.58,
  roe: 22.1,
  profitMargin: 18.4,
  revenueGrowth: 9.2,
  epsGrowth: 11.5,
  freeCashFlow: 5_200_000_000,
  currentRatio: 1.45,
  dividendYield: null,
  beta: 1.15,
  sector: 'Technology',
  industry: 'Consumer Electronics',
  companyName: 'Apple Inc.'
};

describe('cache-service', () => {
  describe('QuoteCache', () => {
    let cache: QuoteCache;

    beforeEach(() => {
      cache = new QuoteCache(freshDb());
    });

    it('returns null for missing ticker', () => {
      expect(cache.get('MISSING')).toBeNull();
    });

    it('stores and retrieves a quote', () => {
      cache.upsert(SAMPLE_QUOTE);
      const found = cache.get('AAPL');
      expect(found).not.toBeNull();
      expect(found!.last).toBe(180.50);
      expect(found!.prevClose).toBe(178.20);
      expect(found!.bid).toBe(180.45);
    });

    it('overwrites on re-upsert', () => {
      cache.upsert(SAMPLE_QUOTE);
      cache.upsert({ ...SAMPLE_QUOTE, last: 181.00, fetchedAt: new Date().toISOString() });
      expect(cache.get('AAPL')!.last).toBe(181.00);
    });

    it('isStale returns false for fresh entry', () => {
      cache.upsert(SAMPLE_QUOTE);
      expect(cache.isStale('AAPL')).toBe(false);
    });

    it('getStaleTickers: none fresh → empty', () => {
      cache.upsert(SAMPLE_QUOTE);
      expect(cache.getStaleTickers(['AAPL'])).toEqual([]);
    });

    it('getStaleTickers: multiple tickers', () => {
      cache.upsert(SAMPLE_QUOTE);
      cache.upsert({ ...SAMPLE_QUOTE, ticker: 'MSFT', last: 400, fetchedAt: new Date().toISOString() });
      expect(cache.getStaleTickers(['AAPL', 'MSFT', 'GOOG'])).toEqual([]);
    });
  });

  describe('FundamentalsCache', () => {
    let cache: FundamentalsCache;

    beforeEach(() => {
      cache = new FundamentalsCache(freshDb());
    });

    it('returns null for missing ticker', () => {
      expect(cache.get('MISSING')).toBeNull();
    });

    it('stores and retrieves ratios as JSON', () => {
      cache.upsert('AAPL', SAMPLE_RATIOS);
      const found = cache.get('AAPL');
      expect(found).not.toBeNull();
      expect(found!.ratios.peRatio).toBe(28.5);
      expect(found!.ratios.roe).toBe(22.1);
    });

    it('isStale: fresh entry not stale', () => {
      cache.upsert('AAPL', SAMPLE_RATIOS);
      expect(cache.isStale('AAPL')).toBe(false);
    });
  });

  describe('OptionsCache', () => {
    let cache: OptionsCache;

    beforeEach(() => {
      cache = new OptionsCache(freshDb());
    });

    it('returns null for missing entry', () => {
      expect(cache.get('AAPL', '2026-06-20')).toBeNull();
    });

    it('stores and retrieves options payload', () => {
      const payload = { strike: 180, call: true, bid: 2.50, ask: 2.60 };
      cache.upsert('AAPL', '2026-06-20', payload);
      const found = cache.get('AAPL', '2026-06-20');
      expect(found).not.toBeNull();
      expect((found!.payload as { strike: number }).strike).toBe(180);
    });

    it('listExpirations returns sorted list', () => {
      cache.upsert('AAPL', '2026-06-20', {});
      cache.upsert('AAPL', '2026-07-18', {});
      cache.upsert('AAPL', '2026-08-15', {});
      const expirations = cache.listExpirations('AAPL');
      expect(expirations).toEqual(['2026-06-20', '2026-07-18', '2026-08-15']);
    });

    it('isStale returns false for fresh entry', () => {
      cache.upsert('AAPL', '2026-06-20', {});
      expect(cache.isStale('AAPL', '2026-06-20')).toBe(false);
    });
  });
});