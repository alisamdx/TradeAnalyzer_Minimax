// Regression: wheel optionLiquidityScore must distinguish "measured and illiquid" (0) from
// "never measured" (null).
//
// Before this fix, analyzeWheel initialised `liquidityScore = 0` and only ever raised it when
// findSuitableChain resolved a contract, so a ticker with NO suitable CSP chain in the
// 30–45 DTE / 0.20–0.30 delta window was persisted to analysis_snapshots as a hard
// `optionLiquidityScore: 0`. On a full-universe snapshot that is ~68% of rows (695/1029 on
// 2026-08-03) — all of them indistinguishable from a genuinely illiquid name, and all of them
// carrying a "Low option liquidity." explanation asserting a measurement that never happened.
//
// see docs/formulas.md#liquidity-score
import { describe, it, expect } from 'vitest';
import { wheelOptionLiquidityScore } from '../src/main/services/analysis-service.js';

const contract = (o: Partial<{ bid: number; ask: number; openInterest: number | null; volume: number | null }> = {}) => ({
  bid: 1.00, ask: 1.02, openInterest: 100, volume: 100, ...o,
});

describe('wheelOptionLiquidityScore', () => {
  it('returns NULL when there is no contract to measure (the regression)', () => {
    expect(wheelOptionLiquidityScore(null)).toBeNull();
  });

  it('distinguishes null from a genuine measured zero', () => {
    // Real contract, fails all three checks: OI 10 (<50), spread ~40% (>5%), volume 1 (<50).
    const measuredZero = wheelOptionLiquidityScore(contract({ bid: 0.80, ask: 1.20, openInterest: 10, volume: 1 }));
    expect(measuredZero).toBe(0);
    expect(measuredZero).not.toBeNull();
    expect(wheelOptionLiquidityScore(null)).not.toBe(0);
  });

  it('awards 4 for open interest >= 50', () => {
    // spread 40% and volume 1 both fail, so OI is the only contributor.
    expect(wheelOptionLiquidityScore(contract({ bid: 0.80, ask: 1.20, openInterest: 50, volume: 1 }))).toBe(4);
    expect(wheelOptionLiquidityScore(contract({ bid: 0.80, ask: 1.20, openInterest: 49, volume: 1 }))).toBe(0);
  });

  it('awards 4 for relative spread <= 5%', () => {
    // bid 1.00 / ask 1.02 → mid 1.01, spread ≈ 1.98%. OI and volume fail.
    expect(wheelOptionLiquidityScore(contract({ openInterest: 10, volume: 1 }))).toBe(4);
    // bid 1.00 / ask 1.10 → mid 1.05, spread ≈ 9.5% → fails.
    expect(wheelOptionLiquidityScore(contract({ bid: 1.00, ask: 1.10, openInterest: 10, volume: 1 }))).toBe(0);
  });

  it('awards 2 for same-day volume >= 50', () => {
    expect(wheelOptionLiquidityScore(contract({ bid: 0.80, ask: 1.20, openInterest: 10, volume: 50 }))).toBe(2);
    expect(wheelOptionLiquidityScore(contract({ bid: 0.80, ask: 1.20, openInterest: 10, volume: 49 }))).toBe(0);
  });

  it('sums to 10 when all three pass and caps there', () => {
    expect(wheelOptionLiquidityScore(contract({ openInterest: 5000, volume: 5000 }))).toBe(10);
  });

  it('treats a degenerate/locked quote as zero spread rather than penalising it', () => {
    // v3 snapshots use day.close as the bid/ask proxy — no real spread to measure.
    expect(wheelOptionLiquidityScore(contract({ bid: 1.00, ask: 1.00, openInterest: 10, volume: 1 }))).toBe(4);
    expect(wheelOptionLiquidityScore(contract({ bid: 0, ask: 0, openInterest: 10, volume: 1 }))).toBe(4);
  });

  it('treats null openInterest/volume as absent, not as passing', () => {
    expect(wheelOptionLiquidityScore(contract({ bid: 0.80, ask: 1.20, openInterest: null, volume: null }))).toBe(0);
  });
});
