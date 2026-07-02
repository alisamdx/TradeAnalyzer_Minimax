// Unit tests for the Wheel (Vetted) filter's pure gate logic: monthly-expiry math,
// target-put selection, annualized CSP yield, and the Tier-2 liquidity/premium gate.

import { describe, it, expect } from 'vitest';
import {
  thirdFridayOnOrAfter,
  pickWheelPut,
  annualizedCspYield,
  assessWheelPut,
  WHEEL_VETTED_DEFAULTS,
} from '../src/main/services/filter-templates-service.js';
import type { OptionContract } from '../src/shared/types.js';

function put(over: Partial<OptionContract> = {}): OptionContract {
  return {
    ticker: 'X', expiration: '2026-08-21', strike: 95, side: 'put',
    bid: 2.0, ask: 2.1, delta: -0.30, gamma: 0, theta: 0, vega: 0,
    iv: 0.3, openInterest: 500, volume: 50, ...over,
  };
}

describe('thirdFridayOnOrAfter', () => {
  const cases = [
    Date.UTC(2026, 6, 2),   // Jul 2 2026
    Date.UTC(2026, 0, 1),   // Jan 1 2026
    Date.UTC(2026, 7, 20),  // Aug 20 2026 (past that month's 3rd Friday)
    Date.UTC(2026, 11, 28), // Dec 28 2026 (rolls into next year)
  ];
  for (const now of cases) {
    it(`returns a real 3rd Friday ≥ minDte for ${new Date(now).toISOString().slice(0, 10)}`, () => {
      const iso = thirdFridayOnOrAfter(25, now);
      const d = new Date(`${iso}T00:00:00Z`);
      expect(d.getUTCDay()).toBe(5);                         // a Friday
      expect(d.getUTCDate()).toBeGreaterThanOrEqual(15);     // 3rd Friday falls on the 15th–21st
      expect(d.getUTCDate()).toBeLessThanOrEqual(21);
      expect(d.getTime()).toBeGreaterThanOrEqual(now + 25 * 86_400_000);
    });
  }
});

describe('pickWheelPut', () => {
  it('picks the put whose |delta| is closest to the target', () => {
    const puts = [put({ strike: 90, delta: -0.12 }), put({ strike: 95, delta: -0.28 }), put({ strike: 98, delta: -0.45 })];
    expect(pickWheelPut(puts, 100, 0.30)?.strike).toBe(95);
  });

  it('falls back to the ~OTM strike when deltas are missing', () => {
    // spot 100, target 0.30 → ~70 strike
    const puts = [put({ strike: 60, delta: null }), put({ strike: 72, delta: null }), put({ strike: 90, delta: null })];
    expect(pickWheelPut(puts, 100, 0.30)?.strike).toBe(72);
  });

  it('ignores puts without a two-sided quote', () => {
    const puts = [put({ strike: 95, delta: -0.30, bid: 0, ask: 0 })];
    expect(pickWheelPut(puts, 100, 0.30)).toBeNull();
  });
});

describe('annualizedCspYield', () => {
  it('computes (credit/strike) × (365/DTE) × 100', () => {
    expect(annualizedCspYield(2, 95, 30)!).toBeCloseTo((2 / 95) * (365 / 30) * 100, 4);
  });
  it('guards against non-positive strike / dte', () => {
    expect(annualizedCspYield(2, 0, 30)).toBeNull();
    expect(annualizedCspYield(2, 95, 0)).toBeNull();
  });
});

describe('assessWheelPut', () => {
  const t = WHEEL_VETTED_DEFAULTS;
  it('passes a liquid, well-priced put', () => {
    const a = assessWheelPut(put({ strike: 95, bid: 2.0, ask: 2.1, openInterest: 800 }), 30, t);
    expect(a.pass).toBe(true);
    expect(a.oi).toBe(800);
  });
  it('fails on thin open interest', () => {
    expect(assessWheelPut(put({ openInterest: 40 }), 30, t).pass).toBe(false);
  });
  it('fails on a wide bid/ask spread', () => {
    // mid 2.0, spread 1.0 → 50% (> 15%)
    expect(assessWheelPut(put({ bid: 1.5, ask: 2.5, openInterest: 800 }), 30, t).pass).toBe(false);
  });
  it('fails when the annualized premium is below the floor', () => {
    // tiny credit on a high strike, long dated → low annualized yield
    expect(assessWheelPut(put({ strike: 500, bid: 0.5, ask: 0.55, openInterest: 800 }), 60, t).pass).toBe(false);
  });
});
