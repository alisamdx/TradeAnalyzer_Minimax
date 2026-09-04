// Regression tests for ETF-aware wheel scoring (v1.1.118, ENABLED v1.1.172 — see
// ETF_AWARE_WHEEL_SCORING in scoring-service.ts).
//
// Wheel's fundamentalScore (weight 17) and leverageQuality (weight 4) are structurally
// inapplicable to ETFs (no P/E, ROE, or traditional debt for a fund wrapper). Under
// FR-SE-03 ("missing signal contributes 0"), a missing signal's weight still counts toward
// the composite's denominator, so these two signals are ALWAYS null for an ETF and ALWAYS
// zero-contribute — every ETF's wheel composite is deflated relative to a fully-scored
// stock, for no reason related to trade quality. Confirmed empirically against the
// production DB (2026-07-03): 56/60 curated ETFs have no fundamentals_cache row, and 0 of
// the last 5 daily wheel briefs contained a single ETF pick.
//
// The fix excludes those two signals from BOTH the numerator and denominator for an ETF
// ticker, renormalizing the remaining signals — rather than zero-contributing them. It
// shipped ENABLED in v1.1.172 after a Brief Replay A/B (45 dates, 225 wheel picks per arm)
// admitted 6 ETF picks that tied their displaced stocks 6/6 on stayed-above-strike.
//
// `SCORING_ETF_AWARE_WHEEL` now overrides in BOTH directions ('1' on, '0' off), so these
// tests lock in: (1) the shipped-ON default, (2) that the pre-fix deflation is still exactly
// reproducible via the '0' rollback path, (3) the exact renormalized value, and (4) that
// non-ETF scoring is byte-for-byte unaffected either way.

import { describe, it, expect, afterEach } from 'vitest';
import { ScoringService, etfAwareWheelScoringEnabled, type TickerSignalData } from '../src/main/services/scoring-service.js';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

function baseSignal(ticker: string, isEtf: boolean): TickerSignalData {
  return {
    ticker, ivRank: 80, fundamentalScore: null, epsGrowth: null, revenueGrowth: null,
    rsi: 50, trendStrengthAdx: null, trendLabel: 'bullish', smaStack: null, lastPrice: 100,
    annualizedReturn: 30, optionLiquidityScore: 8, suitabilityScore: null,
    entryZoneLow: null, snapshotAgeHours: 0, priceMomentumPct: null,
    relativeStrengthVsSpy: null, sectorMomentumPct: null, recentVolatility: 30,
    buySignalScore: null, fcfToNetIncome: null, roic: null, netDebtToEbitda: null,
    revenueGrowth5Y: null, epsGrowth5Y: null, stockGrade: null,
    breakoutState: null, breakoutDecisiveness: null, volumeSurge: null, atrPct: null, breakoutLevel: null,
    isEtf,
  };
}

function svc(): { s: ScoringService; db: DbHandle } {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return { s: new ScoringService(db), db };
}

describe('etfAwareWheelScoringEnabled', () => {
  afterEach(() => { delete process.env['SCORING_ETF_AWARE_WHEEL']; });

  it('is ENABLED by default (shipped-on contract since v1.1.172)', () => {
    expect(etfAwareWheelScoringEnabled()).toBe(true);
  });

  it('can be forced OFF via SCORING_ETF_AWARE_WHEEL=0 — the documented rollback', () => {
    process.env['SCORING_ETF_AWARE_WHEEL'] = '0';
    expect(etfAwareWheelScoringEnabled()).toBe(false);
  });

  it('still accepts an explicit =1 (harmless now, but the replay A/B arm used it)', () => {
    process.env['SCORING_ETF_AWARE_WHEEL'] = '1';
    expect(etfAwareWheelScoringEnabled()).toBe(true);
  });
});

describe('Wheel scoring — ETF fundamentalScore/leverageQuality handling', () => {
  afterEach(() => { delete process.env['SCORING_ETF_AWARE_WHEEL']; });

  // The pre-v1.1.172 behaviour, kept reachable through the rollback path so what was fixed
  // stays visible: 58.3 vs 73.8 is a 21% deflation for a reason unrelated to trade quality.
  it('(rollback path) reproduces the old deflation exactly when forced off', () => {
    process.env['SCORING_ETF_AWARE_WHEEL'] = '0';
    const { s, db } = svc();
    const data = new Map([['SPY', baseSignal('SPY', true)]]);
    const [scored] = s.scoreFromSignalData(data, 'wheel');
    // weightedSum = 80*22 + 50*19 + 100*11 + 100*8 + 50*10 + 80*9 = 5830; totalWeight = 100
    // (fundamentalScore/leverageQuality weights still count, but contribute 0).
    expect(scored!.compositeScore).toBe(58.3);
    expect(scored!.signals['fundamentalScore']!.missing).toBe(true);
    expect(scored!.signals['leverageQuality']!.missing).toBe(true);
    db.close();
  });

  it('(shipped default) renormalizes the composite with fundamentalScore/leverageQuality excluded', () => {
    const { s, db } = svc();
    const data = new Map([['SPY', baseSignal('SPY', true)]]);
    const [scored] = s.scoreFromSignalData(data, 'wheel');
    // Same weightedSum = 5830, but totalWeight excludes 17+4=21 → 79.
    // 5830 / 79 = 73.797... → rounds to 73.8.
    expect(scored!.compositeScore).toBe(73.8);
    db.close();
  });

  it('never touches a non-ETF ticker, flag on or off (byte-for-byte identical composite)', () => {
    const { s, db } = svc();
    // Give the non-ETF ticker real fundamentalScore/netDebtToEbitda data too.
    const stock: TickerSignalData = { ...baseSignal('AAPL', false), fundamentalScore: 70, netDebtToEbitda: 1 };
    const data = new Map([['AAPL', stock]]);

    const [on] = s.scoreFromSignalData(data, 'wheel');
    process.env['SCORING_ETF_AWARE_WHEEL'] = '0';
    const [off] = s.scoreFromSignalData(new Map([['AAPL', stock]]), 'wheel');

    // weightedSum = 5830 + 70*17 + 80*4 = 5830 + 1190 + 320 = 7340; totalWeight = 100 always.
    expect(off!.compositeScore).toBe(73.4);
    expect(on!.compositeScore).toBe(73.4);
    expect(off!.signals['fundamentalScore']!.missing).toBe(false);
    db.close();
  });

  it('does not affect other strategies (e.g. income, which has no fundamentalScore signal)', () => {
    const { s, db } = svc();
    const data = new Map([['SPY', baseSignal('SPY', true)]]);
    // Should not throw and should score normally — income's signal set doesn't include the
    // wheel-only keys the ETF branch targets, so the flag is a no-op for income.
    const [scored] = s.scoreFromSignalData(data, 'income');
    expect(scored!.compositeScore).toBeGreaterThan(0);
    db.close();
  });
});
