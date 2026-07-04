// Regression tests for ETF-aware wheel scoring (v1.1.118 — NOT YET ENABLED, see
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
// The fix (gated behind SCORING_ETF_AWARE_WHEEL=1 / ETF_AWARE_WHEEL_SCORING, both false by
// default) excludes those two signals from BOTH the numerator and denominator for an ETF
// ticker, renormalizing the remaining signals to 100% — rather than zero-contributing them.
// This changes wheel composite scores (and therefore which picks reach Stage 4 / the final
// brief) for ETF tickers, so per this project's FR-SEY-5 rule it must show a Brief Replay
// improvement before shipping enabled. These tests lock in: (1) the current, unfixed
// deflation as a regression baseline, (2) the exact renormalized value the fix produces when
// enabled, and (3) that non-ETF scoring is byte-for-byte unaffected either way.

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

  it('is disabled by default (shipped-off contract)', () => {
    expect(etfAwareWheelScoringEnabled()).toBe(false);
  });

  it('can be overridden on via SCORING_ETF_AWARE_WHEEL=1 (for validation runs / tests)', () => {
    process.env['SCORING_ETF_AWARE_WHEEL'] = '1';
    expect(etfAwareWheelScoringEnabled()).toBe(true);
  });
});

describe('Wheel scoring — ETF fundamentalScore/leverageQuality handling', () => {
  afterEach(() => { delete process.env['SCORING_ETF_AWARE_WHEEL']; });

  it('(current, unfixed) deflates an ETF composite by zero-contributing the N/A signals', () => {
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

  it('(fix enabled) renormalizes the composite once fundamentalScore/leverageQuality are excluded', () => {
    process.env['SCORING_ETF_AWARE_WHEEL'] = '1';
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

    const [off] = s.scoreFromSignalData(data, 'wheel');
    process.env['SCORING_ETF_AWARE_WHEEL'] = '1';
    const [on] = s.scoreFromSignalData(new Map([['AAPL', stock]]), 'wheel');

    // weightedSum = 5830 + 70*17 + 80*4 = 5830 + 1190 + 320 = 7340; totalWeight = 100 always.
    expect(off!.compositeScore).toBe(73.4);
    expect(on!.compositeScore).toBe(73.4);
    expect(off!.signals['fundamentalScore']!.missing).toBe(false);
    db.close();
  });

  it('does not affect other strategies (e.g. income, which has no fundamentalScore signal)', () => {
    process.env['SCORING_ETF_AWARE_WHEEL'] = '1';
    const { s, db } = svc();
    const data = new Map([['SPY', baseSignal('SPY', true)]]);
    // Should not throw and should score normally — income's signal set doesn't include the
    // wheel-only keys the ETF branch targets, so the flag is a no-op for income.
    const [scored] = s.scoreFromSignalData(data, 'income');
    expect(scored!.compositeScore).toBeGreaterThan(0);
    db.close();
  });
});
