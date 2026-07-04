// Regression tests for the Inflection scoring strategy (v0.32.99, Phase 2).
// All inflection signals are gated on a fresh breakout in an ALLOWED direction. The
// `inflectionDirection` setting (default 'up') controls which sides surface — the FR-SEY-3
// follow-up validated down-breakout (bear call) inflection as a net loser, so it's off by
// default. Non-breakout tickers always score 0.

import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
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
    isEtf: false,
  };
}

function svc(): { s: ScoringService; db: DbHandle } {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return { s: new ScoringService(db), db };
}
function setDirection(db: DbHandle, dir: 'both' | 'up' | 'down'): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('inflectionDirection', ?)").run(dir);
}
const up = (t: string): TickerSignalData => ({ ...emptySignal(t), breakoutState: 1, breakoutDecisiveness: 2, volumeSurge: 2.5, atrPct: 4, ivRank: 60, breakoutLevel: 100 });
const down = (t: string): TickerSignalData => ({ ...emptySignal(t), breakoutState: -1, breakoutDecisiveness: 3, volumeSurge: 3, atrPct: 6, ivRank: 90, breakoutLevel: 100 });

describe('Inflection scoring', () => {
  it('scores a strong up-breakout > 0 (default direction = up)', () => {
    const { s } = svc();
    const m = new Map([['AAA', up('AAA')]]);
    expect(s.scoreFromSignalData(m, 'inflection')[0]!.compositeScore).toBeGreaterThan(40);
  });

  it('scores a non-breakout ticker 0 (all signals gated out)', () => {
    const { s } = svc();
    const m = new Map([['BBB', { ...emptySignal('BBB'), breakoutState: 0, breakoutDecisiveness: 3, volumeSurge: 3, atrPct: 6, ivRank: 90 }]]);
    expect(s.scoreFromSignalData(m, 'inflection')[0]!.compositeScore).toBe(0);
  });

  it('gates down-breakouts to 0 by default (FR-SEY-3: bear-call side is off)', () => {
    const { s } = svc();
    const m = new Map([['CCC', down('CCC')]]);
    expect(s.scoreFromSignalData(m, 'inflection')[0]!.compositeScore).toBe(0);
  });

  it("scores down-breakouts > 0 when inflectionDirection = 'both'", () => {
    const { s, db } = svc();
    setDirection(db, 'both');
    const m = new Map([['CCC', down('CCC')]]);
    expect(s.scoreFromSignalData(m, 'inflection')[0]!.compositeScore).toBeGreaterThan(40);
  });

  it("gates up-breakouts to 0 when inflectionDirection = 'down'", () => {
    const { s, db } = svc();
    setDirection(db, 'down');
    const m = new Map([['AAA', up('AAA')], ['CCC', down('CCC')]]);
    const scored = s.scoreFromSignalData(m, 'inflection');
    expect(scored.find(x => x.ticker === 'AAA')!.compositeScore).toBe(0);
    expect(scored.find(x => x.ticker === 'CCC')!.compositeScore).toBeGreaterThan(40);
  });

  it('ranks a more decisive, higher-volume, higher-IV breakout above a marginal one', () => {
    const { s } = svc();
    const m = new Map<string, TickerSignalData>();
    m.set('STRONG', up('STRONG'));
    m.set('WEAK', { ...emptySignal('WEAK'), breakoutState: 1, breakoutDecisiveness: 0.3, volumeSurge: 1.1, atrPct: 1.5, ivRank: 20, breakoutLevel: 100 });
    const scored = s.scoreFromSignalData(m, 'inflection');
    expect(scored[0]!.ticker).toBe('STRONG');
    expect(scored[0]!.compositeScore).toBeGreaterThan(scored[1]!.compositeScore);
  });
});
