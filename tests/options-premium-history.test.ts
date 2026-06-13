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

const wheel: WheelResult = {
  mode: 'wheel', ticker: 'AAPL', lastPrice: 200, recommendedStrike: 190,
  expiration: '2026-07-17', dte: 34, delta: -0.3, premium: 3.25,
  annualizedReturn: 18.4, currentIv: 28.5, ivRank: 42, daysToEarnings: 20,
  optionLiquidityScore: 8, suitabilityScore: 7, explanation: '',
};

const income: OptionsIncomeResult = {
  mode: 'options_income', ticker: 'MSFT', lastPrice: 400, strategy: 'CSP',
  strike: 380, expiration: '2026-07-17', dte: 34, delta: -0.28, bid: 5.1, ask: 5.4,
  premium: 5.25, annualizedReturn: 14.9, ivRank: 35, openInterest: 1200,
  breakeven: 374.75, capitalRequired: 38000, explanation: '',
};

describe('premium history mappers', () => {
  it('maps a WheelResult to a CSP wheel row', () => {
    const r = wheelResultToRow(wheel, '2026-06-13');
    expect(r).toMatchObject({
      asOfDate: '2026-06-13', ticker: 'AAPL', strategy: 'wheel', structure: 'CSP',
      strike: 190, premium: 3.25, annualizedReturn: 18.4, iv: 28.5, ivRank: 42,
      bid: null, ask: null, openInterest: null,
    });
  });

  it('maps an OptionsIncomeResult, preserving CSP/CC + bid/ask/OI', () => {
    const r = incomeResultToRow(income, '2026-06-13');
    expect(r).toMatchObject({
      ticker: 'MSFT', strategy: 'income', structure: 'CSP', strike: 380,
      bid: 5.1, ask: 5.4, premium: 5.25, openInterest: 1200, breakeven: 374.75,
      iv: null, // income result carries no ATM iv field
    });
  });
});

describe('options_premium_history migration', () => {
  function insert(db: ReturnType<typeof openDatabase>, row: PremiumHistoryRow) {
    db.prepare(`
      INSERT OR REPLACE INTO options_premium_history
        (as_of_date, ticker, strategy, structure, last_price, strike, expiration, dte,
         delta, bid, ask, premium, annualized_return, iv, iv_rank, open_interest, breakeven)
      VALUES (@asOfDate, @ticker, @strategy, @structure, @lastPrice, @strike, @expiration, @dte,
              @delta, @bid, @ask, @premium, @annualizedReturn, @iv, @ivRank, @openInterest, @breakeven)
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
