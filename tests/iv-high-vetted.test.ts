// IV High (Vetted) — applies Wheel (Vetted)'s downtrend / earnings / liquidity / IV-ceiling
// safety gates to the IV-High signal (v1.1.120). Plain `iv_rank_high` has none of these —
// it's a bare IV-Rank threshold, fine for browsing but not for a curated email top-10.
//
// Covers the two-phase funnel end to end:
//   Phase 1 (cheap): IV-Rank threshold (same as plain iv_rank_high, per-ticker ETF-calibrated)
//     → downtrend gate → earnings-before-expiry gate (stocks only).
//   Rank + cap: survivors sorted by IV Rank desc, capped to IV_HIGH_VETTED_CHAIN_FETCH_CAP
//     before any live chain fetch.
//   Phase 2 (expensive, survivors only): live monthly chain → ATM (0.50Δ) put →
//     liquidity (OI≥250, spread≤15%) + IV-ceiling (≤80%) gate. No yield floor.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConstituentsService } from '../src/main/services/constituents-service.js';
import {
  FilterTemplatesService,
  IV_HIGH_VETTED_CHAIN_FETCH_CAP,
  thirdFridayOnOrAfter,
} from '../src/main/services/filter-templates-service.js';
import { QuoteCache, FundamentalsCache } from '../src/main/services/cache-service.js';
import type { DataProvider, QuoteSnapshot } from '../src/main/services/data-provider.js';
import type { OptionsProvider, OptionsChain, OptionContract } from '../src/main/services/options-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedConstituent(db: DbHandle, index: string, ticker: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO constituents (index_name, ticker, company_name, sector) VALUES (?, ?, ?, NULL)`
  ).run(index, ticker, `${ticker} Corp`);
}
function seedTrend(db: DbHandle, ticker: string, trendLabel: string): void {
  db.prepare(`INSERT INTO technical_signals (ticker, trend_label) VALUES (?, ?)`).run(ticker, trendLabel);
}
function seedEarnings(db: DbHandle, ticker: string, reportDate: string): void {
  db.prepare(`INSERT INTO earnings_calendar (ticker, report_date) VALUES (?, ?)`).run(ticker, reportDate);
}

function fakeQuote(ticker: string, ivRank: number | null): QuoteSnapshot {
  return {
    ticker, last: 100, prevClose: 99, bid: 99.9, ask: 100.1, volume: 1_000_000,
    dayHigh: 101, dayLow: 99, ivRank, ivPercentile: null, fetchedAt: new Date().toISOString(),
  };
}

// Phase 1's IV-Rank read prefers IvHistoryService (wired via a separate setter these tests
// don't call, matching the rest of the filter-templates test suite) and falls back to
// quote.ivRank — so IV Rank is driven through the quote here, same as the existing
// 'iv_rank_high' tests in filters-prefill.test.ts.
function fakeDataProvider(ivRankByTicker: Record<string, number | null>): DataProvider {
  return {
    name: 'fake',
    getQuote: async (t: string) => fakeQuote(t, ivRankByTicker[t] ?? null),
    getFundamentals: async () => { throw new Error('not used'); },
    getEarningsCalendar: async () => { throw new Error('not used'); },
    getHistoricalBars: async () => [],
    getOptionsChain: async () => { throw new Error('not used — set via fakeOptionsProvider'); },
    getOptionsIV: async () => ({ currentIv: null, iv52WkHigh: null, iv52WkLow: null }),
    getIndexConstituents: async () => [],
    ping: async () => undefined,
  };
}

function put(strike: number, over: Partial<OptionContract> = {}): OptionContract {
  return {
    ticker: 'X', expiration: '2099-01-01', strike, side: 'put',
    bid: 2.0, ask: 2.1, delta: -0.50, gamma: 0, theta: 0, vega: 0,
    iv: 0.3, openInterest: 500, volume: 50, ...over,
  };
}

/** Fake OptionsProvider — one chain per ticker (via a map), tracks call args for cap assertions. */
function fakeOptionsProvider(chainByTicker: Record<string, OptionContract[] | 'reject'>) {
  const calls: string[] = [];
  const provider: OptionsProvider = {
    name: 'fake',
    getOptionsExpirations: async () => [],
    getOptionsChain: async (ticker: string, expiration: string): Promise<OptionsChain> => {
      calls.push(ticker);
      const contracts = chainByTicker[ticker];
      if (contracts === undefined || contracts === 'reject') throw new Error('no chain');
      return { ticker, expiration, contracts, underlyingPrice: 100 };
    },
    getOptionsIV: async () => ({ currentIv: null, iv52WkHigh: null, iv52WkLow: null }),
    getOptionsIVAndPremium: async () => ({ currentIv: null, iv52WkHigh: null, iv52WkLow: null, putPremium: null }),
  };
  return { provider, calls };
}

function makeService(db: DbHandle, dataProvider: DataProvider, optionsProvider: OptionsProvider | null): FilterTemplatesService {
  return new FilterTemplatesService(
    db, dataProvider, optionsProvider, new QuoteCache(db), new FundamentalsCache(db), new ConstituentsService(db)
  );
}

const TARGET_EXPIRY = thirdFridayOnOrAfter(25);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IV High (Vetted)', () => {
  let db: DbHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
  });

  it('returns [] when no options provider is configured', async () => {
    seedConstituent(db, 'sp500', 'AAA');
    const svc = makeService(db, fakeDataProvider({ AAA: 90 }), null);
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results).toEqual([]);
  });

  it('excludes a confirmed downtrend before ever fetching a chain', async () => {
    seedConstituent(db, 'sp500', 'DOWN');
    seedTrend(db, 'DOWN', 'Bearish');
    const { provider, calls } = fakeOptionsProvider({ DOWN: [put(95)] });
    const svc = makeService(db, fakeDataProvider({ DOWN: 95 }), provider);

    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).not.toContain('DOWN');
    expect(calls).not.toContain('DOWN'); // never chain-fetched — excluded before Phase 2
  });

  it('excludes a stock reporting earnings on/before the target expiry, but not an ETF on the same date', async () => {
    seedConstituent(db, 'sp500', 'EARN');
    seedConstituent(db, 'etf', 'EARNETF');
    seedEarnings(db, 'EARN', TARGET_EXPIRY); // on the expiry itself → "on/before" → excluded
    seedEarnings(db, 'EARNETF', TARGET_EXPIRY); // ETFs are exempt (they don't report)
    const { provider } = fakeOptionsProvider({
      EARN: [put(95)],
      EARNETF: [put(95)],
    });
    const svc = makeService(db, fakeDataProvider({ EARN: 95, EARNETF: 95 }), provider);

    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).not.toContain('EARN');
    expect(results.map(r => r.ticker)).toContain('EARNETF');
  });

  it('excludes thin open interest (< 250)', async () => {
    seedConstituent(db, 'sp500', 'THIN');
    const { provider } = fakeOptionsProvider({ THIN: [put(100, { openInterest: 50 })] });
    const svc = makeService(db, fakeDataProvider({ THIN: 95 }), provider);
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).not.toContain('THIN');
  });

  it('excludes a wide spread (> 15% of mid)', async () => {
    seedConstituent(db, 'sp500', 'WIDE');
    const { provider } = fakeOptionsProvider({ WIDE: [put(100, { bid: 1.0, ask: 2.0, openInterest: 500 })] }); // ~67% spread
    const svc = makeService(db, fakeDataProvider({ WIDE: 95 }), provider);
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).not.toContain('WIDE');
  });

  it('excludes a vol-bomb (IV > 80%)', async () => {
    seedConstituent(db, 'sp500', 'BOMB');
    const { provider } = fakeOptionsProvider({ BOMB: [put(100, { iv: 1.5, openInterest: 500 })] }); // 150% IV
    const svc = makeService(db, fakeDataProvider({ BOMB: 95 }), provider);
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).not.toContain('BOMB');
  });

  it('passes a clean candidate with correct metrics', async () => {
    seedConstituent(db, 'sp500', 'CLEAN');
    const { provider } = fakeOptionsProvider({
      CLEAN: [put(100, { bid: 2.0, ask: 2.1, openInterest: 800, iv: 0.4 })], // tight spread, high OI, sane IV
    });
    const svc = makeService(db, fakeDataProvider({ CLEAN: 88 }), provider);
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');

    const r = results.find(x => x.ticker === 'CLEAN');
    expect(r).toBeDefined();
    expect(r!.metrics['ivRank']).toBe(88);
    expect(r!.metrics['openInterest']).toBe(800);
    expect(typeof r!.metrics['spread']).toBe('number');
    expect(r!.matchReason).toContain('Vetted');
  });

  it('applies ETF IV-Rank calibration (30, not 70) — same as plain iv_rank_high', async () => {
    seedConstituent(db, 'etf', 'ETFMID');
    const { provider } = fakeOptionsProvider({ ETFMID: [put(100, { openInterest: 500 })] });
    const svc = makeService(db, fakeDataProvider({ ETFMID: 40 }), provider); // above ETF's 30 bar, below the stock 70 bar
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).toContain('ETFMID');
  });

  it('does not match a ticker below the IV-Rank threshold at all (never reaches the chain)', async () => {
    seedConstituent(db, 'sp500', 'LOWIV');
    const { provider, calls } = fakeOptionsProvider({ LOWIV: [put(100, { openInterest: 500 })] });
    const svc = makeService(db, fakeDataProvider({ LOWIV: 20 }), provider);
    const results = await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');
    expect(results.map(r => r.ticker)).not.toContain('LOWIV');
    expect(calls).not.toContain('LOWIV');
  });

  it('ranks Phase-1 survivors by IV Rank and caps the chain-fetch pool', async () => {
    const n = IV_HIGH_VETTED_CHAIN_FETCH_CAP + 5;
    const chainByTicker: Record<string, OptionContract[]> = {};
    const ivRankByTicker: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const ticker = `T${i}`;
      seedConstituent(db, 'sp500', ticker);
      ivRankByTicker[ticker] = 71 + (i % 20); // all above the 70 threshold, varying rank
      chainByTicker[ticker] = [put(100, { openInterest: 500 })];
    }
    const { provider, calls } = fakeOptionsProvider(chainByTicker);
    const svc = makeService(db, fakeDataProvider(ivRankByTicker), provider);
    await svc.runTemplate('iv_rank_high_vetted', 'universe', 'all');

    expect(calls.length).toBe(IV_HIGH_VETTED_CHAIN_FETCH_CAP);
  });
});
