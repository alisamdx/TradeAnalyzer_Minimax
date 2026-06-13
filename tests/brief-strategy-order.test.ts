// Regression tests for brief section ordering by the day's top composite score (v0.33.4).
// Sections sort by max composite per strategy (desc); the fixed STRATEGY_ORDER
// (wheel→bullish→bearish→income→buy→inflection) breaks ties and orders empty strategies last.

import { describe, it, expect } from 'vitest';
import { orderByTopComposite } from '../src/main/services/brief-report-builder.js';
import type { BriefPick, ScoringStrategy } from '../src/shared/types.js';

const pick = (compositeScore: number): BriefPick => ({ compositeScore } as BriefPick);
const map = (m: Partial<Record<ScoringStrategy, number[]>>): Map<ScoringStrategy, BriefPick[]> =>
  new Map(Object.entries(m).map(([s, scores]) => [s as ScoringStrategy, (scores ?? []).map(pick)]));

describe('orderByTopComposite', () => {
  it('orders strategies by their top composite score, highest first', () => {
    const order = orderByTopComposite(map({ wheel: [60, 72], buy: [81], bearish: [75] }));
    expect(order.slice(0, 3)).toEqual(['buy', 'bearish', 'wheel']); // 81 > 75 > 72
  });

  it('puts strategies with no picks last, in fixed order', () => {
    const order = orderByTopComposite(map({ inflection: [90], income: [55] }));
    expect(order[0]).toBe('inflection');
    expect(order[1]).toBe('income');
    // the four empty strategies trail in the canonical fixed order
    expect(order.slice(2)).toEqual(['wheel', 'bullish', 'bearish', 'buy']);
  });

  it('breaks ties using the fixed STRATEGY_ORDER', () => {
    const order = orderByTopComposite(map({ buy: [70], wheel: [70], bullish: [70] }));
    // all tied at 70 → fixed order wheel < bullish < buy
    expect(order.slice(0, 3)).toEqual(['wheel', 'bullish', 'buy']);
  });
});
