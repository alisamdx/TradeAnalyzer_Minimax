// Tests for the EXPERIMENTAL (disabled) PoP-weighted premium score. The point of the term is
// that a coin-flip ATM structure (Big Lizard, PoP ~52%) scores BELOW a high-PoP credit spread
// (~71%) even when both saturate the old return-on-capital threshold.
import { describe, it, expect } from 'vitest';
import { popWeightedPremiumScore, USE_POP_WEIGHTED_PREMIUM } from '../src/main/services/strategy-lab-service.js';

describe('USE_POP_WEIGHTED_PREMIUM', () => {
  it('ships DISABLED (must pass an FR-SEY-5 backtest before it can flip on)', () => {
    expect(USE_POP_WEIGHTED_PREMIUM).toBe(false);
  });
});

describe('popWeightedPremiumScore', () => {
  it('stays within [0,25] (preserves grade calibration)', () => {
    for (const ret of [0, 1, 1.5, 3, 10, 40]) {
      for (const pop of [null, 30, 50, 70, 90]) {
        const s = popWeightedPremiumScore(ret, pop);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(25);
      }
    }
  });

  it('docks a coin-flip lizard below a high-PoP spread at equal (saturated) return-on-risk', () => {
    const lizard = popWeightedPremiumScore(16.5, 52.7); // sample averages
    const spread = popWeightedPremiumScore(36.9, 70.6);
    expect(lizard).toBeLessThan(spread);
    expect(lizard).toBe(9);
    expect(spread).toBe(22);
  });

  it('ramps capital-efficiency 0→full by 3%/30d', () => {
    expect(popWeightedPremiumScore(0, 90)).toBe(0);
    expect(popWeightedPremiumScore(1.5, 90)).toBe(13); // half ramp at high PoP
    expect(popWeightedPremiumScore(3, 90)).toBe(25);   // full
  });

  it('floors the PoP factor at 0.3 and treats null PoP as neutral 0.7', () => {
    expect(popWeightedPremiumScore(10, 20)).toBe(8);    // 25 * 1 * 0.3 (floored)
    expect(popWeightedPremiumScore(10, null)).toBe(18); // 25 * 1 * 0.7
  });
});
