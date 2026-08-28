// Regression: historical_prices carried unadjusted stock splits (v1.1.139).
//
// Polygon aggregates are fetched with adjusted=true, so each response is correct as of
// that fetch. The corruption came from incremental storage — price-gap-fill re-fetches
// only a ~3-day window, so bars written before a split keep PRE-split prices while new
// bars arrive POST-split, leaving a permanent step in the middle of the series.
//
// Found 2026-08-28 while marking a quarter of brief picks to market: CRWD fell 74% in one
// day (a 4:1 split) and produced a fake $43k loss. Across Jun-Aug: DD +203%, MRNA +177%,
// HON +95%, KLAC +89% — versus SPY's largest genuine daily move of 2.58%. Any indicator
// spanning such a date is wrong, which reaches the scoring engine, the backtest engine,
// and Brief Replay (the FR-SEY-5 validation tool).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  detectDiscontinuities, nearestSplitRatio, detectAndRepairSplits, DEFAULT_SPLIT_THRESHOLD,
} from '../src/main/services/split-repair.js';

describe('detectDiscontinuities', () => {
  it('flags a 4:1 split (the CRWD case) and ignores normal volatility', () => {
    const bars = [
      { date: '2026-06-25', close: 700 },
      { date: '2026-06-26', close: 701 },
      { date: '2026-06-29', close: 185.73 },   // 4:1 split, unadjusted
      { date: '2026-06-30', close: 190 },
    ];
    const hits = detectDiscontinuities('CRWD', bars);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.date).toBe('2026-06-29');
    expect(hits[0]!.ratio).toBeCloseTo(0.265, 2);
  });

  it('flags a reverse split (ratio > 1)', () => {
    const hits = detectDiscontinuities('DD', [
      { date: '2026-06-19', close: 40 },
      { date: '2026-06-22', close: 121 },      // ~1:3 reverse
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ratio).toBeCloseTo(3.03, 2);
  });

  it('does not flag ordinary daily moves', () => {
    const bars = [
      { date: '2026-06-01', close: 100 },
      { date: '2026-06-02', close: 108 },   // +8%
      { date: '2026-06-03', close: 96 },    // -11%
      { date: '2026-06-04', close: 112 },   // +17%
    ];
    expect(detectDiscontinuities('X', bars, DEFAULT_SPLIT_THRESHOLD)).toHaveLength(0);
  });

  it('skips non-positive closes rather than dividing by zero', () => {
    const hits = detectDiscontinuities('BAD', [
      { date: '2026-06-01', close: 0 },
      { date: '2026-06-02', close: 50 },
    ]);
    expect(hits).toHaveLength(0);
  });

  it('labels common split ratios and rejects arbitrary ones', () => {
    expect(nearestSplitRatio(0.25)).toBe('4:1');
    expect(nearestSplitRatio(0.5)).toBe('2:1');
    expect(nearestSplitRatio(3.0)).toBe('1:3');
    expect(nearestSplitRatio(0.61)).toBeNull();   // not near any simple ratio
  });
});

describe('detectAndRepairSplits', () => {
  let db: DbHandle;
  const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  const insert = (db0: DbHandle) => (ticker: string, date: string, close: number) =>
    db0.prepare(`INSERT OR REPLACE INTO historical_prices (ticker,date,open,high,low,close,volume,source,fetched_at)
                 VALUES (?,?,?,?,?,?,?, 'test', '2026-01-01T00:00:00Z')`).run(ticker, date, close, close, close, close, 1000);

  it('repairs a split by re-fetching the whole series, and records it', async () => {
    const put = insert(db);
    put('CRWD', iso(-6), 700); put('CRWD', iso(-5), 701);
    put('CRWD', iso(-4), 185); put('CRWD', iso(-3), 190);   // unadjusted step

    // A re-fetch returns the fully adjusted series (what Polygon actually does).
    const service = {} as never;
    const provider = {} as never;
    const mod = await import('../src/main/services/historical-service.js');
    vi.spyOn(mod, 'fetchAndStorePrices').mockImplementation(async () => {
      const p = insert(db);
      p('CRWD', iso(-6), 175); p('CRWD', iso(-5), 175.25);   // now adjusted
      p('CRWD', iso(-4), 185); p('CRWD', iso(-3), 190);
      return 4;
    });

    const res = await detectAndRepairSplits(db, service, provider, { lookbackDays: 30 });

    expect(res.flagged).toBe(1);
    expect(res.repaired).toBe(1);
    expect(res.confirmedReal).toBe(0);
    const row = db.prepare(`SELECT * FROM price_split_repairs WHERE ticker='CRWD'`).get() as { status: string };
    expect(row.status).toBe('repaired');
  });

  it('records a jump that survives re-fetch as a real move, and never re-fetches it again', async () => {
    const put = insert(db);
    put('BIO', iso(-5), 100); put('BIO', iso(-4), 45);       // genuine -55% collapse
    const mod = await import('../src/main/services/historical-service.js');
    const spy = vi.spyOn(mod, 'fetchAndStorePrices').mockResolvedValue(2);  // re-fetch changes nothing

    const first = await detectAndRepairSplits(db, {} as never, {} as never, { lookbackDays: 30 });
    expect(first.confirmedReal).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second run must not spend another API call on the same known-real move.
    const second = await detectAndRepairSplits(db, {} as never, {} as never, { lookbackDays: 30 });
    expect(second.flagged).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves a clean series completely alone', async () => {
    const put = insert(db);
    put('SPY', iso(-4), 760); put('SPY', iso(-3), 765); put('SPY', iso(-2), 771);
    const mod = await import('../src/main/services/historical-service.js');
    const spy = vi.spyOn(mod, 'fetchAndStorePrices').mockResolvedValue(0);

    const res = await detectAndRepairSplits(db, {} as never, {} as never, { lookbackDays: 30 });
    expect(res.flagged).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
