// Tests for beta computation (v0.32.84). see docs/formulas.md#beta

import { describe, it, expect } from 'vitest';
import { computeBeta } from '../src/main/services/beta-service.js';

/** Deterministic pseudo-random market return series. */
function marketSeries(n: number): number[] {
  const out: number[] = [];
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push(((seed / 2147483648) - 0.5) * 0.02); // ±1% daily
  }
  return out;
}

describe('computeBeta', () => {
  const mkt = marketSeries(252);

  it('returns ~1 for a stock that moves identically to the market', () => {
    expect(computeBeta([...mkt], [...mkt])!).toBeCloseTo(1, 6);
  });

  it('returns ~2 for a stock that moves twice the market', () => {
    const stock = mkt.map(r => r * 2);
    expect(computeBeta(stock, mkt)!).toBeCloseTo(2, 6);
  });

  it('returns ~-1 for an inverse mover', () => {
    const stock = mkt.map(r => -r);
    expect(computeBeta(stock, mkt)!).toBeCloseTo(-1, 6);
  });

  it('idiosyncratic noise does not bias beta (beta of market+noise stays ~1)', () => {
    const noise = marketSeries(252).map(r => r * 0.5);
    const stock = mkt.map((r, i) => r + noise[i]!);
    // noise is independent of mkt by construction (different positions in the
    // PRNG stream), so cov(stock, mkt) ≈ var(mkt) → beta ≈ 1 with small error.
    expect(computeBeta(stock, mkt)!).toBeCloseTo(1, 0);
  });

  it('returns null with insufficient observations', () => {
    expect(computeBeta(mkt.slice(0, 100), mkt.slice(0, 100))).toBeNull();
  });

  it('returns null when market variance is zero', () => {
    const flat = new Array(252).fill(0) as number[];
    expect(computeBeta(mkt, flat)).toBeNull();
  });
});
