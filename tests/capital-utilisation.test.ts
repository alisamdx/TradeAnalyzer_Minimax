// Capital utilisation (v1.1.179).
//
// The whole risk in this feature is DOUBLE COUNTING, in two independent places, and both would
// produce a plausible-looking number rather than an obvious error:
//
//  1. E*Trade already withholds cash-secured put collateral from `cashAvailableForInvestment`.
//     Deriving idle as (available − committed) subtracts the same collateral twice and reports a
//     wheel book as far emptier than it is. Available IS the idle figure.
//  2. A covered call commits no capital of its own — the shares are already counted as stock —
//     and its market value is NEGATIVE, so adding it would move committed the wrong way.
//
// Both are pinned below.

import { describe, it, expect } from 'vitest';
import {
  computeCommitted, getCapitalUtilisation, type OpenPositionLike,
} from '../src/main/services/capital-utilisation.js';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

function pos(over: Partial<OpenPositionLike> & { ticker: string; positionType: string }): OpenPositionLike {
  return { quantity: 1, entryPrice: null, strikePrice: null, marketValue: null, ...over };
}

function db(): DbHandle {
  const d = openDatabase(':memory:');
  runMigrations(d, MIGRATIONS_DIR);
  return d;
}

const addPosition = (d: DbHandle, p: Record<string, unknown>) => d.prepare(`
  INSERT INTO positions (ticker, position_type, quantity, entry_price, strike_price, market_value, status, entry_date)
  VALUES (@ticker, @position_type, @quantity, @entry_price, @strike_price, @market_value, @status, '2026-09-01')
`).run({ entry_price: 0, strike_price: null, market_value: null, status: 'open', ...p });
// entry_price is NOT NULL in the schema, so the fixture defaults it to 0; tests that exercise
// the cost-basis fallback pass a real value.

const addBalance = (d: DbHandle, asOf: string, avail: number | null, key = 'K1', netLiq: number | null = null) =>
  d.prepare(`
    INSERT OR REPLACE INTO account_balances
      (as_of_date, fetched_at, account_id_key, cash_available, total_account_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(asOf, `${asOf}T20:00:00Z`, key, avail, netLiq);

describe('computeCommitted', () => {
  it('values a CSP at its collateral — strike x 100 x contracts, not the premium', () => {
    const r = computeCommitted([pos({ ticker: 'AAPL', positionType: 'CSP', quantity: 2, strikePrice: 190, entryPrice: 3.5 })]);
    expect(r.csp).toBe(38_000);
    expect(r.total).toBe(38_000);
  });

  // The shares are already counted; the CC's market value is a negative liability.
  it('counts a covered call as ZERO — the shares behind it are already counted', () => {
    const r = computeCommitted([
      pos({ ticker: 'TSLA', positionType: 'Stock', quantity: 100, marketValue: 37_636.5 }),
      pos({ ticker: 'TSLA', positionType: 'CC', quantity: 1, strikePrice: 350, marketValue: -2852.5 }),
    ]);
    expect(r.stock).toBeCloseTo(37_636.5);
    expect(r.total).toBeCloseTo(37_636.5);   // NOT 37,636.5 − 2,852.5, and NOT plus it either
  });

  it('marks stock to market when available, falling back to cost', () => {
    expect(computeCommitted([pos({ ticker: 'A', positionType: 'Stock', quantity: 100, entryPrice: 300, marketValue: 37_000 })]).stock)
      .toBe(37_000);
    expect(computeCommitted([pos({ ticker: 'A', positionType: 'Stock', quantity: 100, entryPrice: 300, marketValue: null })]).stock)
      .toBe(30_000);
  });

  it('counts a long option at the debit paid', () => {
    const r = computeCommitted([pos({ ticker: 'A', positionType: 'Long Call', quantity: 2, entryPrice: 4.25 })]);
    expect(r.longOptions).toBe(850);
  });

  it('surfaces an unrecognised position type instead of silently zeroing it', () => {
    const r = computeCommitted([pos({ ticker: 'XYZ', positionType: 'Butterfly', quantity: 1 })]);
    expect(r.total).toBe(0);
    expect(r.unclassified).toEqual(['XYZ:Butterfly']);
  });

  it('handles a short quantity sign without flipping the total negative', () => {
    const r = computeCommitted([pos({ ticker: 'A', positionType: 'CSP', quantity: -3, strikePrice: 100 })]);
    expect(r.csp).toBe(30_000);
  });
});

describe('getCapitalUtilisation', () => {
  it('treats available and committed as COMPLEMENTARY, never subtracting one from the other', () => {
    const d = db();
    addPosition(d, { ticker: 'TSLA', position_type: 'Stock', quantity: 100, market_value: 37_636.5 });
    addBalance(d, '2026-09-03', 20_000);
    const u = getCapitalUtilisation(d, '2026-09-03');
    expect(u.available).toBe(20_000);
    expect(u.committed.total).toBeCloseTo(37_636.5);
    // total is the SUM. If this were available − committed it would be negative here.
    expect(u.total).toBeCloseTo(57_636.5);
    expect(u.totalSource).toBe('derived');   // no broker net liq stored in this fixture
    expect(u.utilisationPct).toBeCloseTo(65.3, 1);
    d.close();
  });

  // Verified against the live account 2026-09-03: available + committed came to $82,541 while
  // E*Trade reported $79,688 — the $2,853 gap is the covered call's liability, which reduces net
  // liquidation without freeing cash or releasing the shares. Quoting the derived sum as "total"
  // would disagree with the operator's own E*Trade screen by the size of the option they wrote.
  it('prefers the broker net liq over the derived sum, and surfaces the gap', () => {
    const d = db();
    addPosition(d, { ticker: 'TSLA', position_type: 'Stock', quantity: 100, market_value: 37_636.5 });
    addPosition(d, { ticker: 'TSLA', position_type: 'CC', quantity: 1, strike_price: 350, market_value: -2852.5 });
    addBalance(d, '2026-09-03', 44_904.35, 'K1', 79_688.35);
    const u = getCapitalUtilisation(d, '2026-09-03');
    expect(u.committed.total).toBeCloseTo(37_636.5);       // CC still contributes nothing
    expect(u.total).toBeCloseTo(79_688.35);                 // the broker's figure, not 82,540.85
    expect(u.totalSource).toBe('broker');
    expect(u.unreconciled).toBeCloseTo(2_852.5, 0);         // exactly the short call liability
    expect(u.utilisationPct).toBeCloseTo(47.2, 1);
    d.close();
  });

  it('falls back to the derived sum when the broker sends no net liq', () => {
    const d = db();
    addPosition(d, { ticker: 'A', position_type: 'CSP', quantity: 1, strike_price: 100 });
    addBalance(d, '2026-09-03', 5_000);
    const u = getCapitalUtilisation(d, '2026-09-03');
    expect(u.total).toBe(15_000);
    expect(u.totalSource).toBe('derived');
    expect(u.unreconciled).toBeNull();   // nothing to reconcile against
    d.close();
  });

  it('reports a missing balance as null rather than zero available', () => {
    const d = db();
    addPosition(d, { ticker: 'A', position_type: 'CSP', quantity: 1, strike_price: 100 });
    const u = getCapitalUtilisation(d, '2026-09-03');
    expect(u.available).toBeNull();
    expect(u.total).toBeNull();
    expect(u.utilisationPct).toBeNull();
    expect(u.committed.total).toBe(10_000);   // the book is still known
    d.close();
  });

  it('ignores closed positions', () => {
    const d = db();
    addPosition(d, { ticker: 'OLD', position_type: 'CSP', quantity: 1, strike_price: 500, status: 'closed' });
    addBalance(d, '2026-09-03', 1000);
    expect(getCapitalUtilisation(d, '2026-09-03').committed.total).toBe(0);
    d.close();
  });

  it('ages the balance snapshot so a stale figure cannot pass as current', () => {
    const d = db();
    addBalance(d, '2026-08-28', 5000);
    const u = getCapitalUtilisation(d, '2026-09-03');
    expect(u.balanceAsOf).toBe('2026-08-28');
    expect(u.balanceAgeDays).toBe(6);
    d.close();
  });

  it('counts an idle streak, and ends it when cash goes to work', () => {
    const d = db();
    addBalance(d, '2026-09-01', 20_000);
    addBalance(d, '2026-09-02', 20_000);
    addBalance(d, '2026-09-03', 20_100);   // drifted up (dividend) — still idle
    expect(getCapitalUtilisation(d, '2026-09-03').idleStreakDays).toBe(3);

    const d2 = db();
    addBalance(d2, '2026-09-01', 20_000);
    addBalance(d2, '2026-09-02', 5_000);    // deployed — streak starts over here
    addBalance(d2, '2026-09-03', 5_000);
    expect(getCapitalUtilisation(d2, '2026-09-03').idleStreakDays).toBe(2);
    d.close(); d2.close();
  });

  it('a same-day re-run replaces the snapshot rather than duplicating it', () => {
    const d = db();
    addBalance(d, '2026-09-03', 20_000);
    addBalance(d, '2026-09-03', 12_000);
    expect(getCapitalUtilisation(d, '2026-09-03').available).toBe(12_000);
    d.close();
  });

  it('never throws when the table is missing', () => {
    const d = db();
    d.prepare('DROP TABLE account_balances').run();
    expect(() => getCapitalUtilisation(d, '2026-09-03')).not.toThrow();
    expect(getCapitalUtilisation(d, '2026-09-03').available).toBeNull();
    d.close();
  });
});
