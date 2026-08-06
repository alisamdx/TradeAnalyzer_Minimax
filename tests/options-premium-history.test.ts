// Regression tests for DailyOptionsPremiumHistoryJob (v0.32.94).
// Covers the pure result→row mappers and the migration 040 table (columns +
// UNIQUE(as_of_date, ticker, strategy) idempotency).

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  wheelResultToRow,
  incomeResultToRow,
  type PremiumHistoryRow,
} from '../src/main/services/jobs/daily-options-premium-history-job.js';
import type { WheelResult, OptionsIncomeResult } from '../src/main/services/analysis-service.js';
import { BriefReplayService } from '../src/main/services/brief-replay-service.js';
import { ScoringService } from '../src/main/services/scoring-service.js';

const wheel: WheelResult = {
  mode: 'wheel', ticker: 'AAPL', lastPrice: 200, recommendedStrike: 190,
  expiration: '2026-07-17', dte: 34, delta: -0.3, premium: 3.25,
  annualizedReturn: 18.4, currentIv: 28.5, ivRank: 42, daysToEarnings: 20,
  bid: 3.1, ask: 3.4, openInterest: 850, volume: 120,
  optionLiquidityScore: 8, suitabilityScore: 7, explanation: '',
};

const income: OptionsIncomeResult = {
  mode: 'options_income', ticker: 'MSFT', lastPrice: 400, strategy: 'CSP',
  strike: 380, expiration: '2026-07-17', dte: 34, delta: -0.28, bid: 5.1, ask: 5.4,
  premium: 5.25, annualizedReturn: 14.9, ivRank: 35, openInterest: 1200, volume: 310,
  breakeven: 374.75, capitalRequired: 38000, explanation: '',
};

describe('premium history mappers', () => {
  it('maps a WheelResult to a CSP wheel row (negative delta = put)', () => {
    const r = wheelResultToRow(wheel, '2026-06-13');
    expect(r).toMatchObject({
      asOfDate: '2026-06-13', ticker: 'AAPL', strategy: 'wheel', structure: 'CSP',
      strike: 190, premium: 3.25, annualizedReturn: 18.4, iv: 28.5, ivRank: 42,
      // v1.1.132: the wheel row now carries the liquidity inputs it is scored from.
      // These were hardcoded null before, leaving two months of history unusable.
      bid: 3.1, ask: 3.4, openInterest: 850, volume: 120,
    });
  });

  it('labels a covered-call fallback as CC (positive delta = call)', () => {
    // findSuitableChain falls back to a call when no suitable CSP exists; the
    // contract then has a positive delta + strike above spot. The row must record
    // it as CC, not the old hardcoded CSP.
    const cc: WheelResult = {
      ...wheel, ticker: 'AA', lastPrice: 64.16, recommendedStrike: 75, delta: 0.2258,
    };
    expect(wheelResultToRow(cc, '2026-06-13')).toMatchObject({ ticker: 'AA', structure: 'CC' });
  });

  it('defaults to CSP when delta is null', () => {
    const noDelta: WheelResult = { ...wheel, delta: null };
    expect(wheelResultToRow(noDelta, '2026-06-13').structure).toBe('CSP');
  });

  it('maps an OptionsIncomeResult, preserving CSP/CC + bid/ask/OI', () => {
    const r = incomeResultToRow(income, '2026-06-13');
    expect(r).toMatchObject({
      ticker: 'MSFT', strategy: 'income', structure: 'CSP', strike: 380,
      bid: 5.1, ask: 5.4, premium: 5.25, openInterest: 1200, volume: 310, breakeven: 374.75,
      iv: null, // income result carries no ATM iv field
    });
  });

  // Regression (v1.1.132). wheelResultToRow hardcoded `bid: null, ask: null, openInterest: null`
  // because WheelResult did not carry them — analyzeWheel computed the liquidity inputs, scored
  // them, then discarded them. Result: every one of 21,127 stored wheel rows (2026-06-15 →
  // 2026-08-05) had NULL bid/ask/open_interest while all 22,302 income rows were complete, which
  // made a retrospective A/B of the liquidity scoring impossible on the wheel side.
  it('persists the liquidity EVIDENCE on both strategies, not just the score', () => {
    for (const row of [wheelResultToRow(wheel, '2026-06-13'), incomeResultToRow(income, '2026-06-13')]) {
      for (const field of ['bid', 'ask', 'openInterest', 'volume'] as const) {
        expect(row[field], `${row.strategy}.${field} must be carried through`).not.toBeNull();
        expect(row[field]).toBeTypeOf('number');
      }
    }
  });

  it('still writes null — never 0 — when an input was genuinely unmeasured', () => {
    // Same discipline as optionLiquidityScore (v1.1.127): a 0 asserts "measured and terrible",
    // which is a different claim from "no quote". Nothing may coerce these.
    const unmeasured: WheelResult = { ...wheel, bid: null, ask: null, openInterest: null, volume: null };
    const r = wheelResultToRow(unmeasured, '2026-06-13');
    expect([r.bid, r.ask, r.openInterest, r.volume]).toEqual([null, null, null, null]);
  });
});

describe('options_premium_history migration', () => {
  function insert(db: ReturnType<typeof openDatabase>, row: PremiumHistoryRow) {
    db.prepare(`
      INSERT OR REPLACE INTO options_premium_history
        (as_of_date, ticker, strategy, structure, last_price, strike, expiration, dte,
         delta, bid, ask, premium, annualized_return, iv, iv_rank, open_interest, volume, breakeven)
      VALUES (@asOfDate, @ticker, @strategy, @structure, @lastPrice, @strike, @expiration, @dte,
              @delta, @bid, @ask, @premium, @annualizedReturn, @iv, @ivRank, @openInterest, @volume, @breakeven)
    `).run(row);
  }

  it('creates the table and enforces one row per (date, ticker, strategy)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);

    const row = wheelResultToRow(wheel, '2026-06-13');
    insert(db, row);
    insert(db, { ...row, premium: 9.99 }); // same key → REPLACE, not duplicate

    const all = db.prepare(`SELECT premium FROM options_premium_history WHERE ticker='AAPL'`).all() as { premium: number }[];
    expect(all).toHaveLength(1);
    expect(all[0]!.premium).toBe(9.99);

    // Different strategy on same date/ticker is a distinct row.
    insert(db, incomeResultToRow({ ...income, ticker: 'AAPL' }, '2026-06-13'));
    const count = db.prepare(`SELECT COUNT(*) n FROM options_premium_history WHERE ticker='AAPL'`).get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });
});

describe('getPremiumHistoryReadiness', () => {
  function dayOffset(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function seed(db: ReturnType<typeof openDatabase>, dates: string[]) {
    const stmt = db.prepare(`INSERT OR REPLACE INTO options_premium_history
      (as_of_date, ticker, strategy, premium) VALUES (?, 'AAPL', 'wheel', 1.0)`);
    for (const d of dates) stmt.run(d);
  }

  it('reports not-ready while matured days are below threshold, ignoring recent dates', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    // 3 matured (>45d old) + 2 recent (<45d, not counted as matured)
    seed(db, [dayOffset(120), dayOffset(90), dayOffset(60), dayOffset(10), dayOffset(2)]);

    const svc = new BriefReplayService(db, new ScoringService(db));
    const r = svc.getPremiumHistoryReadiness();
    expect(r.days).toBe(5);
    expect(r.maturedDays).toBe(3);   // only the >45d dates
    expect(r.ready).toBe(false);     // 3 < thresholdDays
    db.close();
  });

  it('reports ready once matured days reach the threshold', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const matured = Array.from({ length: 45 }, (_, i) => dayOffset(50 + i)); // all >45d old, distinct
    seed(db, matured);

    const svc = new BriefReplayService(db, new ScoringService(db));
    const r = svc.getPremiumHistoryReadiness();
    expect(r.maturedDays).toBeGreaterThanOrEqual(r.thresholdDays);
    expect(r.ready).toBe(true);
    db.close();
  });

  it('returns an empty, not-ready state when the table is empty', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const r = new BriefReplayService(db, new ScoringService(db)).getPremiumHistoryReadiness();
    expect(r).toMatchObject({ totalRows: 0, days: 0, maturedDays: 0, ready: false, fromDate: null });
    db.close();
  });
});
