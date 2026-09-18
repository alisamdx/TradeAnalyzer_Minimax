// The settled-CSP study panel (v1.1.267) — read by scripts/fr-income-liquidity-realized-ab.mjs
// through GET /diagnostics/settled-csp-panel instead of that script opening the SQLite file.
//
// The script opened %APPDATA%\trade-analyzer\trade-analyzer.sqlite itself, which is MSIX-redirected
// in the container a Claude Code session runs in, so an unattended run read a stale shadow copy.
// Its own realized-vol copy also accepted as few as 10 closes, so it never matched live scoring.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ScoringService } from '../src/main/services/scoring-service.js';
import {
  recentVolatility, settledCspPanel, type PanelDb
} from '../src/main/services/settled-csp-panel.js';

let db: DbHandle;

/** Consecutive calendar days from 2026-01-01; the vol rule counts bars, not sessions. */
function day(i: number): string {
  return new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
}

function insertBars(ticker: string, closes: readonly number[]): void {
  const stmt = db.prepare(
    `INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000)`
  );
  closes.forEach((c, i) => stmt.run(ticker, day(i), c, c, c, c));
}

function insertCsp(r: {
  asOf: string; ticker: string; expiration: string; strike?: number; premium?: number;
  bid?: number | null; ask?: number | null; oi?: number | null; strategy?: string;
}): void {
  db.prepare(
    `INSERT INTO options_premium_history
       (as_of_date, ticker, strategy, structure, strike, expiration, dte, premium, bid, ask,
        open_interest, iv_rank, annualized_return)
     VALUES (?, ?, ?, 'CSP', ?, ?, 30, ?, ?, ?, ?, 40, 18)`
  ).run(
    r.asOf, r.ticker, r.strategy ?? 'income', r.strike ?? 100, r.expiration, r.premium ?? 2,
    r.bid === undefined ? 1.9 : r.bid, r.ask === undefined ? 2.1 : r.ask, r.oi === undefined ? 500 : r.oi
  );
}

/** A deterministic, non-trivial path — varied returns, so the variance is genuinely exercised. */
const PATH = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i * 1.7) + 0.002 * i));

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

describe('recentVolatility — the LIVE rule, checked against live scoring itself', () => {
  it('agrees with ScoringService on identical bars', () => {
    // Compared with the real `loadRecentVolatility`, not with the formula restated in this file:
    // a replica tested against its own copy of the formula proves only that it matches itself.
    insertBars('AAA', PATH);
    const live = new ScoringService(db).gatherSignalData(['AAA']).get('AAA')?.recentVolatility;
    expect(live).not.toBeNull();
    const newestFirst = [...PATH].reverse();
    expect(recentVolatility(newestFirst)).toBeCloseTo(live as number, 10);
  });

  it('agrees with live on a thin history too — where the old script copy diverged', () => {
    // The script accepted 10 closes; live needs 16. At 12 closes live says null, and so must this.
    insertBars('THIN', PATH.slice(0, 12));
    const live = new ScoringService(db).gatherSignalData(['THIN']).get('THIN')?.recentVolatility ?? null;
    expect(live).toBeNull();
    expect(recentVolatility([...PATH.slice(0, 12)].reverse())).toBeNull();
  });

  it('looks at no more than 22 closes', () => {
    const newestFirst = [...PATH].reverse();
    const base = recentVolatility(newestFirst.slice(0, 22));
    // An older 23rd close, however extreme, is outside the window.
    expect(recentVolatility([...newestFirst.slice(0, 22), 1])).toBeCloseTo(base as number, 10);
  });

  it('skips a zero close rather than taking log(0)', () => {
    // The old script guarded only the previous close, so a zero current close gave -Infinity and a
    // NaN volatility that no comparison could catch.
    const withZero = [...PATH.slice(0, 22)].reverse();
    withZero[5] = 0;
    const v = recentVolatility(withZero);
    expect(v === null || Number.isFinite(v)).toBe(true);
  });
});

describe('settledCspPanel', () => {
  it('returns only rows that can be settled, with the close on the expiration date', () => {
    insertBars('AAA', PATH);
    insertCsp({ asOf: day(30), ticker: 'AAA', expiration: day(45) });          // settled
    insertCsp({ asOf: day(31), ticker: 'AAA', expiration: day(90) });          // after the last bar

    const p = settledCspPanel(db as unknown as PanelDb, 'income');
    expect(p.maxPriceDate).toBe(day(59));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.settle).toBeCloseTo(PATH[45]!, 10);
  });

  it('computes realized vol AS OF the recommendation date — no lookahead', () => {
    // A study that lets tomorrow's bars into today's signal measures a signal nobody could trade.
    insertBars('AAA', PATH);
    insertCsp({ asOf: day(30), ticker: 'AAA', expiration: day(45) });
    const before = settledCspPanel(db as unknown as PanelDb, 'income').rows[0]!.realizedVol;

    // Rewrite every bar AFTER the as-of date into a violent path.
    db.prepare('UPDATE historical_prices SET close = close * (1 + (id % 2) * 0.5) WHERE date > ?').run(day(30));
    const after = settledCspPanel(db as unknown as PanelDb, 'income').rows[0]!.realizedVol;

    expect(after).toBeCloseTo(before as number, 10);
    expect(before).toBeCloseTo(recentVolatility([...PATH.slice(0, 31)].reverse()) as number, 10);
  });

  it('excludes rows without the liquidity inputs, since they cannot be re-scored', () => {
    insertBars('AAA', PATH);
    insertCsp({ asOf: day(30), ticker: 'AAA', expiration: day(45), bid: null });
    insertCsp({ asOf: day(31), ticker: 'AAA', expiration: day(45), oi: null });
    insertCsp({ asOf: day(32), ticker: 'AAA', expiration: day(45) });
    expect(settledCspPanel(db as unknown as PanelDb, 'income').rows.map((r) => r.asOfDate)).toEqual([day(32)]);
  });

  it('filters by strategy', () => {
    insertBars('AAA', PATH);
    insertCsp({ asOf: day(30), ticker: 'AAA', expiration: day(45), strategy: 'income' });
    insertCsp({ asOf: day(31), ticker: 'AAA', expiration: day(45), strategy: 'wheel' });
    expect(settledCspPanel(db as unknown as PanelDb, 'wheel').rows.map((r) => r.asOfDate)).toEqual([day(31)]);
  });

  it('returns an empty panel with no bars rather than throwing', () => {
    insertCsp({ asOf: day(30), ticker: 'AAA', expiration: day(45) });
    expect(settledCspPanel(db as unknown as PanelDb, 'income')).toEqual({
      strategy: 'income', maxPriceDate: null, rows: []
    });
  });
});
