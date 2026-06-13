// Regression tests for the per-strategy composite quality gate (v0.32.93).
// Bearish is gated at composite ≥70; all other strategies are ungated (0).
// Full-year Brief Replay basis documented at minCompositeForStrategy() in
// scoring-service.ts. Replaces the rejected SPY-regime gate.

import { describe, it, expect } from 'vitest';
import { minCompositeForStrategy, STRATEGIES } from '../src/main/services/scoring-service.js';

describe('minCompositeForStrategy', () => {
  it('gates bearish at 70', () => {
    expect(minCompositeForStrategy('bearish')).toBe(70);
  });

  it('leaves all non-bearish strategies ungated (0)', () => {
    for (const s of STRATEGIES) {
      if (s === 'bearish') continue;
      expect(minCompositeForStrategy(s)).toBe(0);
    }
  });

  it('admits a bearish pick at exactly the threshold and rejects just below', () => {
    const min = minCompositeForStrategy('bearish');
    const passes = (score: number) => score >= min;
    expect(passes(70)).toBe(true);   // boundary is inclusive
    expect(passes(69.9)).toBe(false);
    expect(passes(77.2)).toBe(true); // observed max bearish score
  });

  it('is rank-agnostic: any rank clearing 70 is admitted, rank 1 below 70 is not', () => {
    // Simulates the slate filter used by the brief/replay: filter by score, not rank.
    const slate = [
      { rank: 1, compositeScore: 68 },
      { rank: 2, compositeScore: 72 },
      { rank: 3, compositeScore: 60 },
    ];
    const min = minCompositeForStrategy('bearish');
    const surviving = slate.filter(p => p.compositeScore >= min).map(p => p.rank);
    expect(surviving).toEqual([2]); // rank 2 clears, rank 1 (top) is dropped
  });
});
