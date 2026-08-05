// Brief Replay has no historical option chains, so annualizedReturn / optionLiquidityScore /
// suitabilityScore are null for every ticker on every replay date. Under FR-SE-03 a missing
// signal still contributes its full weight to the denominator, so those signals are a permanent
// zero-at-full-weight — 28% of wheel's scoring weight and 35% of income's.
//
// These tests pin the arithmetic so a future weight change can't silently widen the blind spot,
// and document which strategies are faithful to live.
import { describe, it, expect } from 'vitest';
import { REPLAY_BLIND_SIGNAL_KEYS, replayWeightCoverage } from '../src/main/services/brief-replay-service.js';
import { BASELINE_CONFIGS } from '../src/main/services/scoring-service.js';

describe('REPLAY_BLIND_SIGNAL_KEYS', () => {
  it('covers exactly the signals fed by the three options-derived fields', () => {
    // premiumYield / premiumRiskRatio ← annualizedReturn; optionLiquidity ← optionLiquidityScore
    expect([...REPLAY_BLIND_SIGNAL_KEYS].sort())
      .toEqual(['optionLiquidity', 'premiumRiskRatio', 'premiumYield']);
  });
});

describe('replayWeightCoverage', () => {
  it('reports wheel as 72% covered — premiumYield (19) + optionLiquidity (9) are blind', () => {
    const c = replayWeightCoverage(BASELINE_CONFIGS.wheel);
    expect(c.totalWeight).toBe(100);
    expect(c.blindWeight).toBe(28);
    expect(c.coveragePct).toBeCloseTo(72, 6);
    expect(c.blindKeys.sort()).toEqual(['optionLiquidity', 'premiumYield']);
  });

  it('reports income as 65% covered — premiumRiskRatio (22) + optionLiquidity (13) are blind', () => {
    const c = replayWeightCoverage(BASELINE_CONFIGS.income);
    expect(c.totalWeight).toBe(100);
    expect(c.blindWeight).toBe(35);
    expect(c.coveragePct).toBeCloseTo(65, 6);
    expect(c.blindKeys.sort()).toEqual(['optionLiquidity', 'premiumRiskRatio']);
  });

  it('reports the non-options strategies as fully faithful to live', () => {
    for (const strategy of ['bullish', 'bearish', 'buy', 'inflection'] as const) {
      const c = replayWeightCoverage(BASELINE_CONFIGS[strategy]);
      expect(c.blindWeight, `${strategy} should have no options-derived signal`).toBe(0);
      expect(c.coveragePct).toBeCloseTo(100, 6);
    }
  });

  it('only counts enabled signals', () => {
    const signals = [
      { key: 'ivRank', weight: 50, enabled: true },
      { key: 'optionLiquidity', weight: 30, enabled: false },  // disabled → not a blind spot
      { key: 'premiumYield', weight: 20, enabled: true },
    ];
    const c = replayWeightCoverage(signals);
    expect(c.totalWeight).toBe(70);
    expect(c.blindWeight).toBe(20);
    expect(c.blindKeys).toEqual(['premiumYield']);
  });

  it('handles a config with no signals without dividing by zero', () => {
    expect(replayWeightCoverage([])).toEqual({
      totalWeight: 0, blindWeight: 0, coveragePct: 100, blindKeys: [],
    });
  });

  it('leaves within-run ranking unaffected — blind signals are zero for EVERY ticker', () => {
    // The blind weight is a constant divisor across all tickers in a run, so it cannot reorder
    // them. What it breaks is comparability of the ABSOLUTE composite between replay and live —
    // which is why no wheel/income threshold may be carried across.
    const c = replayWeightCoverage(BASELINE_CONFIGS.wheel);
    const scaled = (liveWeightedSum: number) => liveWeightedSum / c.totalWeight;
    expect(scaled(80) > scaled(60)).toBe(true);
    expect(c.coveragePct).toBeLessThan(100);   // but not on live's scale
  });
});
