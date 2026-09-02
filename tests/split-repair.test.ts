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
  volumeRegimeRatio, isTickerReuse,
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

  // v1.1.140: 3:2 (-33%) was dropped from the candidate set. It sat right on top of the
  // ordinary one-day crash range, and produced every false "~3:2" label in the 2026-08-28
  // scan (SRPT, ALGN, ELF, SMCI all fell 32-37% on news, none of them split).
  it('does NOT label a one-third fall as a split — that is ordinary crash territory', () => {
    expect(nearestSplitRatio(2 / 3)).toBeNull();      // exact 3:2
    expect(nearestSplitRatio(0.65)).toBeNull();       // -35%, e.g. SRPT
    expect(nearestSplitRatio(0.68)).toBeNull();       // -32%
  });

  // The tolerance must stay wide: a split day also carries that day's real price move,
  // so the observed ratio is never exact. CRWD's genuine 4:1 printed at 0.2649.
  it('still matches a real split whose ratio is skewed by the day price move', () => {
    expect(nearestSplitRatio(0.2649)).toBe('4:1');    // CRWD 2026-06-29, stock +6% that day
    expect(nearestSplitRatio(1.9497)).toBe('1:2');    // HON 2026-06-23
    expect(nearestSplitRatio(3.03)).toBe('1:3');      // DD 2026-06-22
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

  it('re-verifies a confirmed_real verdict once its TTL has expired', async () => {
    const put = insert(db);
    put('MRNA', iso(-5), 63); put('MRNA', iso(-4), 174);      // split-shaped, provider not yet adjusted
    const mod = await import('../src/main/services/historical-service.js');
    const spy = vi.spyOn(mod, 'fetchAndStorePrices').mockResolvedValue(2);

    // First pass: survives the re-fetch, so it is written off as a real move.
    const first = await detectAndRepairSplits(db, {} as never, {} as never, { lookbackDays: 30 });
    expect(first.confirmedReal).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // Age the verdict past its TTL, as if a month of runs had passed. Without the TTL this
    // row would be excluded from detection forever and the corruption made permanent.
    db.prepare(`UPDATE price_split_repairs SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-45 days')`).run();

    // The provider has since published the split, so this time the re-fetch repairs it.
    spy.mockImplementation(async () => {
      const p = insert(db);
      p('MRNA', iso(-5), 189); p('MRNA', iso(-4), 174);
      return 2;
    });
    const second = await detectAndRepairSplits(db, {} as never, {} as never, { lookbackDays: 30 });
    expect(second.flagged).toBe(1);
    expect(second.repaired).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    const row = db.prepare(`SELECT status FROM price_split_repairs WHERE ticker='MRNA'`).get() as { status: string };
    expect(row.status).toBe('repaired');
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

// ── Ticker reuse (v1.1.141) ─────────────────────────────────────────────────
//
// A symbol can be reassigned to a completely different company (rename, reverse merger,
// de-SPAC, delisting + reuse). The stored series then splices two unrelated entities and
// NO re-fetch can repair it — the provider keys by ticker too and returns the same spliced
// data. Found 2026-09-01 after both cases had been written off as `confirmed_real`:
//   BNY  "Bank of New York Mellon Corp."  median vol   46,254 ->  3,519,645  (76x)
//   SPCX "Space Exploration Technologies" median vol    1,531 -> 82,047,547  (53,592x)
// against six genuine moves in the same batch whose volume regime moved only 0.4x-5.0x.
describe('ticker reuse', () => {
  it('separates a permanent volume-regime shift from a news spike', () => {
    // BNY: regime moves up ~76x and stays.
    expect(volumeRegimeRatio(new Array(20).fill(46_254), new Array(20).fill(3_519_645)))
      .toBeCloseTo(76.1, 0);
    // MRNA: the largest genuine move in the calibration set — 5x, well under the bar.
    expect(isTickerReuse(volumeRegimeRatio(new Array(20).fill(5_163_266), new Array(20).fill(25_820_564)))).toBe(false);
    expect(isTickerReuse(76.1)).toBe(true);
    expect(isTickerReuse(1 / 76.1)).toBe(true);   // reuse can cut volume too
    expect(isTickerReuse(5.0)).toBe(false);
    expect(isTickerReuse(null)).toBe(false);      // too little data to judge
  });

  it('declines to judge when either side is too thin', () => {
    expect(volumeRegimeRatio([1, 2, 3], new Array(20).fill(1000))).toBeNull();
    expect(volumeRegimeRatio(new Array(20).fill(1000), [1, 2])).toBeNull();
    expect(volumeRegimeRatio(new Array(20).fill(0), new Array(20).fill(1000))).toBeNull();
  });

  it('truncates the previous company out of prices AND iv_history, without an API call', async () => {
    const db2 = openDatabase(':memory:');
    runMigrations(db2, MIGRATIONS_DIR);
    const put = (ticker: string, date: string, close: number, volume: number) =>
      db2.prepare(`INSERT OR REPLACE INTO historical_prices (ticker,date,open,high,low,close,volume,source,fetched_at)
                   VALUES (?,?,?,?,?,?,?, 'test', '2026-01-01T00:00:00Z')`)
        .run(ticker, date, close, close, close, close, volume);
    const putIv = (ticker: string, date: string) =>
      db2.prepare(`INSERT OR REPLACE INTO iv_history (ticker,date,atm_iv,underlying_px,source,created_at)
                   VALUES (?,?,?,?, 'test', '2026-01-01T00:00:00Z')`).run(ticker, date, 30, 10);

    // 25 bars of the OLD company (penny stock, tiny volume), then the NEW one.
    const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    for (let i = 0; i < 25; i++) { put('BNY', day(i), 10, 46_254); putIv('BNY', day(i)); }
    for (let i = 25; i < 50; i++) { put('BNY', day(i), 140, 3_519_645); putIv('BNY', day(i)); }

    const mod = await import('../src/main/services/historical-service.js');
    const spy = vi.spyOn(mod, 'fetchAndStorePrices').mockResolvedValue(0);

    const res = await detectAndRepairSplits(db2, {} as never, {} as never, { lookbackDays: 400 });

    expect(res.tickerReuse).toBe(1);
    expect(spy).not.toHaveBeenCalled();   // settled before any re-fetch — none can help
    const rows = db2.prepare(`SELECT status, volume_ratio FROM price_split_repairs WHERE ticker='BNY'`)
      .get() as { status: string; volume_ratio: number };
    expect(rows.status).toBe('ticker_reuse');
    expect(rows.volume_ratio).toBeGreaterThan(15);
    // Only the current entity survives, in BOTH tables.
    expect((db2.prepare(`SELECT COUNT(*) n FROM historical_prices WHERE ticker='BNY'`).get() as { n: number }).n).toBe(25);
    expect((db2.prepare(`SELECT COUNT(*) n FROM iv_history WHERE ticker='BNY'`).get() as { n: number }).n).toBe(25);
    expect((db2.prepare(`SELECT MIN(close) c FROM historical_prices WHERE ticker='BNY'`).get() as { c: number }).c).toBe(140);
    db2.close();
  });
});
