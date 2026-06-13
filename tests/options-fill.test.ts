// Regression tests for the realistic option fill model (v0.32.97).
// Sells fill below mid (toward bid), buys above mid (toward ask), by a fraction of the
// half-spread. Degenerate/locked quotes fall back to mid.

import { describe, it, expect } from 'vitest';
import { fillPrice, SLIPPAGE_FRACTION } from '../src/main/services/options-fill.js';

describe('fillPrice', () => {
  // bid 1.90 / ask 2.10 → mid 2.00, half-spread 0.10
  it('sells below mid by slip × half-spread', () => {
    expect(fillPrice(1.90, 2.10, 'sell', 0.5)).toBeCloseTo(1.95, 6);
  });

  it('buys above mid by slip × half-spread', () => {
    expect(fillPrice(1.90, 2.10, 'buy', 0.5)).toBeCloseTo(2.05, 6);
  });

  it('slip=0 returns the mid (optimistic, old behavior)', () => {
    expect(fillPrice(1.90, 2.10, 'sell', 0)).toBeCloseTo(2.00, 6);
    expect(fillPrice(1.90, 2.10, 'buy', 0)).toBeCloseTo(2.00, 6);
  });

  it('slip=1 returns the natural price (bid for sells, ask for buys)', () => {
    expect(fillPrice(1.90, 2.10, 'sell', 1)).toBeCloseTo(1.90, 6);
    expect(fillPrice(1.90, 2.10, 'buy', 1)).toBeCloseTo(2.10, 6);
  });

  it('penalizes wide spreads more than tight ones', () => {
    const tight = fillPrice(1.99, 2.01, 'sell'); // half-spread 0.01
    const wide  = fillPrice(1.50, 2.50, 'sell'); // half-spread 0.50
    expect(tight).toBeGreaterThan(wide);         // less given up on the tight market
    expect(2.00 - tight).toBeLessThan(2.00 - wide);
  });

  it('falls back to mid on locked/crossed/degenerate quotes', () => {
    expect(fillPrice(2.00, 2.00, 'sell')).toBeCloseTo(2.00, 6); // locked
    expect(fillPrice(2.10, 2.00, 'buy')).toBeCloseTo(2.05, 6);  // crossed → mid
  });

  it('never returns a negative price', () => {
    expect(fillPrice(0.00, 0.02, 'sell', 1)).toBeGreaterThanOrEqual(0);
  });

  it('defaults to the documented slippage fraction', () => {
    expect(fillPrice(1.90, 2.10, 'sell')).toBeCloseTo(fillPrice(1.90, 2.10, 'sell', SLIPPAGE_FRACTION), 6);
  });
});
