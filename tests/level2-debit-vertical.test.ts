import { describe, it, expect } from 'vitest';
import { buildNarrowDebitVertical, DEFAULT_TARGET_MAX_RISK } from '../src/main/services/level2-debit-vertical.js';
import type { OptionContract } from '../src/main/services/data-provider.js';

// Build a same-side contract with a mid of `mid` (bid/ask straddle it). iv defaults to a usable
// fraction so the BS fallback path is only exercised when we explicitly zero the quote.
function c(side: 'call' | 'put', strike: number, mid: number | null, iv = 0.3): OptionContract {
  const has = mid !== null;
  return {
    ticker: 'X', expiration: '2026-08-21', strike, side,
    bid: has ? Math.max(0, mid - 0.05) : 0,
    ask: has ? mid + 0.05 : 0,
    delta: null, gamma: null, theta: null, vega: null,
    iv, openInterest: 100, volume: 10,
  };
}

// Call ladder around spot 100: ATM 100 = $8.00, decaying upward.
const CALLS: OptionContract[] = [
  c('call', 100, 8.0), c('call', 105, 5.0), c('call', 110, 3.0),
  c('call', 115, 1.5), c('call', 120, 0.5), c('call', 125, 0.2),
];
// Mirror for puts (ATM 100 = $8.00, decaying downward).
const PUTS: OptionContract[] = [
  c('put', 100, 8.0), c('put', 95, 5.0), c('put', 90, 3.0),
  c('put', 85, 1.5), c('put', 80, 0.5), c('put', 75, 0.2),
];

describe('buildNarrowDebitVertical', () => {
  it('default risk budget is $750', () => {
    expect(DEFAULT_TARGET_MAX_RISK).toBe(750);
  });

  it('bullish: long ATM call, widens short to the widest strike within the risk budget', () => {
    const v = buildNarrowDebitVertical(CALLS, 'call', 100, 52, '2026-08-21');
    expect(v).not.toBeNull();
    expect(v!.side).toBe('call');
    expect(v!.longStrike).toBe(100);          // ATM
    // short 120 → debit 7.5 → risk 750 (== budget); 125 → 7.8 → 780 (over) so stops at 120.
    expect(v!.shortStrike).toBe(120);
    expect(v!.debitPerShare).toBeCloseTo(7.5, 5);
    expect(v!.maxRisk).toBe(750);
    expect(v!.maxProfit).toBe(1250);          // (20 − 7.5) × 100
    expect(v!.breakeven).toBeCloseTo(107.5, 5);
    expect(v!.movePctToBreakeven).toBeCloseTo(7.5, 5); // up-move for a call
    expect(v!.exceededBudget).toBe(false);
  });

  it('respects a smaller budget by choosing a narrower short', () => {
    const v = buildNarrowDebitVertical(CALLS, 'call', 100, 52, '2026-08-21', 350);
    // short 105 → debit 3 → risk 300 ≤350; short 110 → 500 >350 → stop at 105.
    expect(v!.shortStrike).toBe(105);
    expect(v!.maxRisk).toBe(300);
    expect(v!.exceededBudget).toBe(false);
  });

  it('bearish: mirrors to a long put spread below spot', () => {
    const v = buildNarrowDebitVertical(PUTS, 'put', 100, 52, '2026-08-21');
    expect(v!.side).toBe('put');
    expect(v!.longStrike).toBe(100);
    expect(v!.shortStrike).toBe(80);
    expect(v!.breakeven).toBeCloseTo(92.5, 5);          // long − debit
    expect(v!.movePctToBreakeven).toBeCloseTo(-7.5, 5); // down-move for a put
  });

  it('flags exceededBudget when even the narrowest spread is over the target', () => {
    const pricey = [c('call', 100, 12.0), c('call', 105, 2.0), c('call', 110, 1.0)];
    const v = buildNarrowDebitVertical(pricey, 'call', 100, 52, '2026-08-21'); // budget 750
    expect(v).not.toBeNull();
    expect(v!.shortStrike).toBe(105);   // narrowest positive-debit spread
    expect(v!.debitPerShare).toBeCloseTo(10, 5);
    expect(v!.maxRisk).toBe(1000);
    expect(v!.exceededBudget).toBe(true);
  });

  it('returns null when fewer than two priced strikes exist on the side', () => {
    expect(buildNarrowDebitVertical([c('call', 100, 8.0)], 'call', 100, 52, '2026-08-21')).toBeNull();
    expect(buildNarrowDebitVertical([], 'call', 100, 52, '2026-08-21')).toBeNull();
    expect(buildNarrowDebitVertical(CALLS, 'call', 0, 52, '2026-08-21')).toBeNull(); // bad spot
  });

  it('falls back to Black-Scholes pricing when a leg has no bid/ask quote', () => {
    // Long ATM has no quote (bid/ask 0) but a usable IV → priced via BS; shorts quoted normally.
    const noQuoteLong = [c('call', 100, null, 0.4), c('call', 115, 1.5), c('call', 130, 0.4)];
    const v = buildNarrowDebitVertical(noQuoteLong, 'call', 100, 52, '2026-08-21');
    expect(v).not.toBeNull();
    expect(v!.longStrike).toBe(100);
    expect(v!.longPremium).toBeGreaterThan(0);  // BS produced a positive long price
    expect(v!.debitPerShare).toBeGreaterThan(0);
  });
});
