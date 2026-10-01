// Real income/wheel return on capital from options_premium_history (premium-roc.ts).
//
// The analysis was deferred until ≥ 40 capture dates matured (reached 2026-10). Two things must be
// pinned beyond the arithmetic: rows without bid/ask still settle (every wheel row before v1.1.132
// had them null), and a split-scale mismatch is excluded and listed, never settled — a repaired
// split once manufactured -$168k of fiction in a backtest.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { premiumRoc, settleShortPut } from '../src/main/services/premium-roc.js';
import type { PanelDb } from '../src/main/services/settled-csp-panel.js';

let db: DbHandle;

/** Consecutive calendar days from 2026-01-01. */
function day(i: number): string {
  return new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
}

/** Bars with low = close unless a dip is given. */
function insertBars(ticker: string, closes: readonly number[], lows: Record<number, number> = {}): void {
  const stmt = db.prepare(
    `INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000)`
  );
  closes.forEach((c, i) => stmt.run(ticker, day(i), c, c, lows[i] ?? c, c));
}

function insertRow(r: {
  asOf: string; ticker: string; expiration: string; strike: number; premium: number;
  lastPrice?: number | null; structure?: 'CSP' | 'CC'; strategy?: string; bid?: number | null;
}): void {
  db.prepare(
    `INSERT INTO options_premium_history
       (as_of_date, ticker, strategy, structure, last_price, strike, expiration, dte, premium, bid, ask,
        open_interest, iv_rank, annualized_return)
     VALUES (?, ?, ?, ?, ?, ?, ?, 30, ?, ?, NULL, NULL, 40, 18)`
  ).run(
    r.asOf, r.ticker, r.strategy ?? 'income', r.structure ?? 'CSP',
    r.lastPrice === undefined ? 100 : r.lastPrice, r.strike, r.expiration, r.premium,
    r.bid === undefined ? null : r.bid
  );
}

const run = (strategy: 'income' | 'wheel' = 'income') => premiumRoc(db as unknown as PanelDb, strategy);
const flat = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

describe('settleShortPut', () => {
  it('keeps the premium when the put expires out of the money', () => {
    expect(settleShortPut(95, 2, 100)).toEqual({ pnl: 2, rocPct: (2 / 95) * 100, assigned: false });
  });
  it('subtracts intrinsic when assigned', () => {
    const s = settleShortPut(95, 2, 90);
    expect(s.pnl).toBeCloseTo(-3, 10);
    expect(s.rocPct).toBeCloseTo((-3 / 95) * 100, 10);
    expect(s.assigned).toBe(true);
  });
});

describe('premiumRoc', () => {
  it('settles a row that has no bid/ask — premium is all return needs', () => {
    insertBars('AAA', flat(40));
    insertRow({ asOf: day(0), ticker: 'AAA', expiration: day(30), strike: 95, premium: 2, bid: null });
    const rep = run();
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]!.rocPct).toBeCloseTo((2 / 95) * 100, 10);
    expect(rep.rows[0]!.annualizedRocPct).toBeCloseTo((2 / 95) * 100 * (365 / 30), 10);
    expect(rep.excluded).toEqual([]);
  });

  it('settles on the last bar on or before a holiday expiration', () => {
    const closes = flat(40);
    insertBars('HOL', closes.slice(0, 29)); // no bar on day 29 or 30
    db.prepare(`INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES ('HOL', ?, 1,1,1,1,1)`).run(day(35));
    insertRow({ asOf: day(0), ticker: 'HOL', expiration: day(30), strike: 95, premium: 2 });
    const r = run().rows[0]!;
    expect(r.settleDate).toBe(day(28));
  });

  it('excludes and lists a split-repaired series instead of settling it', () => {
    // Captured at $400 with a $380 strike; the series has since been adjusted 4:1 to $100.
    insertBars('SPL', flat(40, 100));
    insertRow({ asOf: day(0), ticker: 'SPL', expiration: day(30), strike: 380, premium: 8, lastPrice: 400 });
    const rep = run();
    expect(rep.rows).toEqual([]);
    expect(rep.excluded).toHaveLength(1);
    expect(rep.excluded[0]!.reason).toBe('scale_mismatch_entry');
  });

  it('excludes an unrepaired step between capture and expiry', () => {
    // Entry consistent with last_price, but the series steps 4:1 down mid-option: settled naively
    // this is a $280/share "loss" on a $380 strike.
    insertBars('STEP', [...flat(20, 400), ...flat(20, 100)]);
    insertRow({ asOf: day(0), ticker: 'STEP', expiration: day(30), strike: 380, premium: 8, lastPrice: 400 });
    const rep = run();
    expect(rep.rows).toEqual([]);
    expect(rep.excluded[0]!.reason).toBe('scale_mismatch_settle');
  });

  it('keeps a genuine large drop inside the settle band, as a real assignment', () => {
    insertBars('DROP', [...flat(20, 100), ...flat(20, 60)]);
    insertRow({ asOf: day(0), ticker: 'DROP', expiration: day(30), strike: 95, premium: 2 });
    const r = run().rows[0]!;
    expect(r.assigned).toBe(true);
    expect(r.rocPct).toBeCloseTo(((2 - 35) / 95) * 100, 10);
  });

  it('uses the strike/close band when last_price was never stored', () => {
    insertBars('NOLP', flat(40, 100));
    insertRow({ asOf: day(0), ticker: 'NOLP', expiration: day(30), strike: 380, premium: 8, lastPrice: null });
    expect(run().excluded[0]!.reason).toBe('scale_mismatch_entry');
  });

  it('mirrors the Brief Replay proxy: any low under 0.85 x entry in 21 sessions is a breach', () => {
    insertBars('PX1', flat(40), { 10: 84 });
    insertBars('PX2', flat(40), { 10: 86 });
    insertBars('PX3', flat(40), { 25: 50 }); // after the 21-session window
    for (const t of ['PX1', 'PX2', 'PX3']) insertRow({ asOf: day(0), ticker: t, expiration: day(30), strike: 95, premium: 2 });
    const byT = new Map(run().rows.map((r) => [r.ticker, r.proxyKept]));
    expect(byT.get('PX1')).toBe(false);
    expect(byT.get('PX2')).toBe(true);
    expect(byT.get('PX3')).toBe(true);
  });

  it('the proxy and the real outcome can disagree in both directions', () => {
    // Dips through the synthetic strike, recovers: proxy says breached, real put expires worthless.
    insertBars('RECOV', flat(40), { 5: 80 });
    // Never dips 15 %, but closes 3 % down at expiry: proxy says kept, real put is assigned.
    insertBars('SLIDE', [...flat(25, 100), ...flat(15, 93)]);
    for (const t of ['RECOV', 'SLIDE']) insertRow({ asOf: day(0), ticker: t, expiration: day(30), strike: 95, premium: 1 });
    const byT = new Map(run().rows.map((r) => [r.ticker, r]));
    expect(byT.get('RECOV')).toMatchObject({ proxyKept: false, assigned: false });
    expect(byT.get('SLIDE')).toMatchObject({ proxyKept: true, assigned: true });
  });

  it('leaves the proxy null without 21 forward sessions', () => {
    insertBars('SHORT', flat(20));
    insertRow({ asOf: day(0), ticker: 'SHORT', expiration: day(14), strike: 95, premium: 1 });
    expect(run().rows[0]!.proxyKept).toBeNull();
  });

  it('does not settle an option expiring after the newest bar, or a covered call', () => {
    insertBars('LATE', flat(20));
    insertRow({ asOf: day(0), ticker: 'LATE', expiration: day(40), strike: 95, premium: 1 });
    insertRow({ asOf: day(0), ticker: 'LATE', expiration: day(10), strike: 105, premium: 1, structure: 'CC', strategy: 'wheel' });
    expect(run().rows).toEqual([]);
    expect(run().eligible).toBe(0);
    expect(run('wheel').coveredCallsSkipped).toBe(1);
    expect(run('wheel').rows).toEqual([]);
  });

  it('keeps strategies apart', () => {
    insertBars('BOTH', flat(40));
    insertRow({ asOf: day(0), ticker: 'BOTH', expiration: day(30), strike: 95, premium: 2, strategy: 'wheel' });
    expect(run('income').rows).toEqual([]);
    expect(run('wheel').rows).toHaveLength(1);
  });
});
