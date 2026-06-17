// The single canonical ATM-IV definition shared by the lab and the live providers.
// Regression context: E*Trade's getOptionsIV used the closest CALL only, which read
// differently from the lab's call+put average for the same expiration (the 70.27% vs
// 81.83% AMD audit finding — though most of that gap was a different expiration tenor).

import { describe, it, expect } from 'vitest';
import { atmIvAtClosestStrike } from '../src/main/services/iv-utils.js';

describe('atmIvAtClosestStrike', () => {
  it('averages the call and put IV at the strike closest to spot (NOT calls-only)', () => {
    // Closest strike is 100; call IV 0.60, put IV 0.80 → average 0.70 (calls-only would be 0.60).
    const items = [
      { strike: 100, iv: 0.60 }, // ATM call
      { strike: 100, iv: 0.80 }, // ATM put (skew)
      { strike: 110, iv: 0.50 },
      { strike: 90, iv: 0.55 },
    ];
    expect(atmIvAtClosestStrike(items, 101)).toBeCloseTo(0.70, 10);
  });

  it('selects the strike nearest to the underlying price', () => {
    const items = [
      { strike: 95, iv: 0.40 },
      { strike: 105, iv: 0.60 },
    ];
    expect(atmIvAtClosestStrike(items, 104)).toBeCloseTo(0.60, 10); // 105 is closer to 104
    expect(atmIvAtClosestStrike(items, 96)).toBeCloseTo(0.40, 10);  // 95 is closer to 96
  });

  it('passes units through unchanged (decimal in → decimal out, percent in → percent out)', () => {
    expect(atmIvAtClosestStrike([{ strike: 50, iv: 0.42 }], 50)).toBeCloseTo(0.42, 10);
    expect(atmIvAtClosestStrike([{ strike: 50, iv: 42 }], 50)).toBeCloseTo(42, 10);
  });

  it('ignores contracts with non-positive or null IV when choosing the strike and averaging', () => {
    const items = [
      { strike: 100, iv: 0 },     // ignored (no IV) even though it is the closest strike
      { strike: 100, iv: null },  // ignored
      { strike: 102, iv: 0.50 },  // nearest strike WITH a usable IV
    ];
    expect(atmIvAtClosestStrike(items, 100)).toBeCloseTo(0.50, 10);
  });

  it('returns null when there is no usable data', () => {
    expect(atmIvAtClosestStrike([], 100)).toBeNull();
    expect(atmIvAtClosestStrike([{ strike: 100, iv: 0 }], 100)).toBeNull();
    expect(atmIvAtClosestStrike([{ strike: 100, iv: null }], 100)).toBeNull();
  });

  it('returns null when the underlying price is missing or non-finite', () => {
    const items = [{ strike: 100, iv: 0.5 }];
    expect(atmIvAtClosestStrike(items, null)).toBeNull();
    expect(atmIvAtClosestStrike(items, undefined)).toBeNull();
    expect(atmIvAtClosestStrike(items, NaN)).toBeNull();
  });
});
