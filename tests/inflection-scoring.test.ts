// Regression tests for the Inflection scoring strategy (v0.32.99, Phase 2).
// All inflection signals are gated on a fresh BULLISH (up) breakout, so non-breakout
// and down-breakout tickers score 0 and never surface.

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ScoringService, type TickerSignalData } from '../src/main/services/scoring-service.js';

function emptySignal(ticker: string): TickerSignalData {
  return {
    ticker, ivRank: null, fundamentalScore: null, epsGrowth: null, revenueGrowth: null,
    rsi: null, trendStrengthAdx: null, trendLabel: null, smaStack: null, lastPrice: 100,
    annualizedReturn: null, optionLiquidityScore: null, suitabilityScore: null,
    entryZoneLow: null, snapshotAgeHours: 0, priceMomentumPct: null,
    relativeStrengthVsSpy: null, sectorMomentumPct: null, recentVolatility: null,
    buySignalScore: null, fcfToNetIncome: null, roic: null, netDebtToEbitda: null,
    revenueGrowth5Y: null, epsGrowth5Y: null, stockGrade: null,
    breakoutState: null, breakoutDecisiveness: null, volumeSurge: null, atrPct: null, breakoutLevel: null,
  };
}

function svc(): ScoringService {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return new ScoringService(db);
}

describe('Inflection scoring', () => {
  it('scores a strong up-breakout > 0', () => {
    const s = svc();
    const m = new Map<string, TickerSignalData>();
    m.set('AAA', { ...emptySignal('AAA'), breakoutState: 1, breakoutDecisiveness: 2, volumeSurge: 2.5, atrPct: 4, ivRank: 60, breakoutLevel: 100 });
    const scored = s.scoreFromSignalData(m, 'inflection');
    expect(scored[0]!.compositeScore).toBeGreaterThan(40);
  });

  it('scores a non-breakout ticker 0 (all signals gated out)', () => {
    const s = svc();
    const m = new Map<string, TickerSignalData>();
    // breakoutState 0 even though the other fields are populated → gated → 0
    m.set('BBB', { ...emptySignal('BBB'), breakoutState: 0, breakoutDecisiveness: 3, volumeSurge: 3, atrPct: 6, ivRank: 90 });
    expect(s.scoreFromSignalData(m, 'inflection')[0]!.compositeScore).toBe(0);
  });

  it('scores a down-breakout 0 in Phase 2 (bullish-only)', () => {
    const s = svc();
    const m = new Map<string, TickerSignalData>();
    m.set('CCC', { ...emptySignal('CCC'), breakoutState: -1, breakoutDecisiveness: 3, volumeSurge: 3, atrPct: 6, ivRank: 90 });
    expect(s.scoreFromSignalData(m, 'inflection')[0]!.compositeScore).toBe(0);
  });

  it('ranks a more decisive, higher-volume, higher-IV breakout above a marginal one', () => {
    const s = svc();
    const m = new Map<string, TickerSignalData>();
    m.set('STRONG', { ...emptySignal('STRONG'), breakoutState: 1, breakoutDecisiveness: 2.5, volumeSurge: 3, atrPct: 5, ivRank: 80, breakoutLevel: 100 });
    m.set('WEAK',   { ...emptySignal('WEAK'),   breakoutState: 1, breakoutDecisiveness: 0.3, volumeSurge: 1.1, atrPct: 1.5, ivRank: 20, breakoutLevel: 100 });
    const scored = s.scoreFromSignalData(m, 'inflection');
    expect(scored[0]!.ticker).toBe('STRONG');
    expect(scored[0]!.compositeScore).toBeGreaterThan(scored[1]!.compositeScore);
  });
});
