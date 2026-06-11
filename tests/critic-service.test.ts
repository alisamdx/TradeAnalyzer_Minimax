// Regression tests for CriticService rule checks (v0.32.67).
// Covers: chosen-structure liquidity flag, liquidity threshold, bearish SPY
// mirror, counter-trend ITM strike rule, buy stock-first presentation,
// A+ grade ranking, and the earnings-penalty strategy list.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CriticService, type MarketContext } from '../src/main/services/critic-service.js';
import { EARNINGS_PENALTY_STRATEGIES } from '../src/main/services/jobs/daily-intelligence-brief-job.js';
import type { BriefPick, ScoringConfig } from '../src/shared/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

type LabScore = {
  slug: string;
  grade: string;
  liquidityScore: number;
  setup: {
    expiration: string;
    netCredit: number | null;
    legs: Array<{ strike: number; action: string }>;
    unavailableReason?: string | null;
  } | null;
};

function makeSetup(shortStrike: number, expiration = '2099-01-15', unavailableReason: string | null = null) {
  return {
    expiration,
    netCredit: 250,
    legs: [{ strike: shortStrike, action: 'sell' }],
    unavailableReason,
  };
}

function makePick(scores: LabScore[] | null, price = 100, labUnderlyingPx?: number): BriefPick {
  return {
    ticker: 'TEST',
    compositeScore: 70,
    signals: {},
    strategyLabResult: scores === null ? null : {
      context: { underlyingPx: labUnderlyingPx ?? price },
      scores,
    },
    aiRationale: null,
    rank: 1,
    validated: true,
    price,
  };
}

const emptyConfig: ScoringConfig = {
  strategy: 'wheel', signals: [], version: 'test', updatedAt: '2026-01-01',
};

const noMarket: MarketContext = { vix: null, spyAbove200ma: null };
const bullMarket: MarketContext = { vix: 18, spyAbove200ma: true };

function runChecks(svc: CriticService, pick: BriefPick, strategy: string, market: MarketContext = noMarket) {
  return svc.runRuleChecks(pick, strategy, { ...emptyConfig, strategy: strategy as ScoringConfig['strategy'] }, new Map(), market);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CriticService rule checks', () => {
  let svc: CriticService;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, confirmed INTEGER)`);
    svc = new CriticService(db);
  });

  describe('checkLiquidity — chosen structure, threshold < 4', () => {
    it('uses the chosen (first relevant available) structure, not the max liquidity', () => {
      // big-lizard is chosen (first available relevant); butterfly has better liquidity.
      const pick = makePick([
        { slug: 'big-lizard',     grade: 'A+', liquidityScore: 3, setup: makeSetup(105) },
        { slug: 'call-butterfly', grade: 'A',  liquidityScore: 8, setup: makeSetup(105) },
      ]);
      const flags = runChecks(svc, pick, 'bullish');
      const liq = flags.find(f => f.key === 'low_liquidity');
      expect(liq).toBeDefined();
      expect(liq!.description).toContain('3/15');
      expect(liq!.description).toContain('big-lizard');
    });

    it('does not flag liquidity 4–5 (normal for single names)', () => {
      const pick = makePick([
        { slug: 'big-lizard', grade: 'A+', liquidityScore: 5, setup: makeSetup(105) },
      ]);
      const flags = runChecks(svc, pick, 'bullish');
      expect(flags.find(f => f.key === 'low_liquidity')).toBeUndefined();
    });

    it('still flags genuinely thin liquidity (< 4)', () => {
      const pick = makePick([
        { slug: 'big-lizard', grade: 'A+', liquidityScore: 2, setup: makeSetup(105) },
      ]);
      const flags = runChecks(svc, pick, 'bullish');
      expect(flags.find(f => f.key === 'low_liquidity')).toBeDefined();
    });

    it('flags unvalidated picks (no lab result)', () => {
      const flags = runChecks(svc, makePick(null), 'bullish');
      expect(flags.find(f => f.key === 'low_liquidity')).toBeDefined();
    });
  });

  describe('checkMarketRisk — bearish SPY mirror', () => {
    it('flags bearish picks when SPY is above its 200-day MA', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: makeSetup(110) },
      ]);
      const flags = runChecks(svc, pick, 'bearish', bullMarket);
      const mr = flags.find(f => f.key === 'elevated_market_risk');
      expect(mr).toBeDefined();
      expect(mr!.severity).toBe('info');
      expect(mr!.description).toContain('uptrend');
    });

    it('does not flag bearish picks when SPY is below its 200-day MA', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: makeSetup(110) },
      ]);
      const flags = runChecks(svc, pick, 'bearish', { vix: 18, spyAbove200ma: false });
      expect(flags.find(f => f.key === 'elevated_market_risk')).toBeUndefined();
    });
  });

  describe('checkCounterTrendStrike — bearish ATM/ITM strike in uptrend', () => {
    it('warns when the short strike is at/below price with SPY bullish', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: makeSetup(99) },
      ], 100); // strike 99 ≤ price 100 → no cushion
      const flags = runChecks(svc, pick, 'bearish', bullMarket);
      const ct = flags.find(f => f.key === 'counter_trend_itm_strike');
      expect(ct).toBeDefined();
      expect(ct!.severity).toBe('warning');
    });

    it('does not warn when the short strike has OTM cushion', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: makeSetup(105) },
      ], 100); // strike 105 > price 100 → 5% cushion
      const flags = runChecks(svc, pick, 'bearish', bullMarket);
      expect(flags.find(f => f.key === 'counter_trend_itm_strike')).toBeUndefined();
    });

    it('does not warn when SPY is not in an uptrend', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: makeSetup(99) },
      ], 100);
      const flags = runChecks(svc, pick, 'bearish', { vix: 18, spyAbove200ma: false });
      expect(flags.find(f => f.key === 'counter_trend_itm_strike')).toBeUndefined();
    });
  });

  describe('shouldPresentAsStock — buy stock-first fallback', () => {
    it('true for buy when the best available relevant structure is C', () => {
      const pick = makePick([
        { slug: 'poor-mans-covered-call', grade: 'B', liquidityScore: 5, setup: makeSetup(105, '2099-01-15', 'Requires two expirations') },
        { slug: 'call-zebra',             grade: 'C', liquidityScore: 7, setup: makeSetup(105) },
        { slug: 'long-call-vertical',     grade: 'F', liquidityScore: 5, setup: makeSetup(105) },
      ]);
      expect(svc.shouldPresentAsStock(pick, 'buy')).toBe(true);
    });

    it('false for buy when a B-or-better structure is available', () => {
      const pick = makePick([
        { slug: 'call-zebra', grade: 'B', liquidityScore: 7, setup: makeSetup(105) },
      ]);
      expect(svc.shouldPresentAsStock(pick, 'buy')).toBe(false);
    });

    it('false for non-buy strategies regardless of grades', () => {
      const pick = makePick([
        { slug: 'short-naked-put', grade: 'F', liquidityScore: 7, setup: makeSetup(95) },
      ]);
      expect(svc.shouldPresentAsStock(pick, 'wheel')).toBe(false);
    });

    it('suppresses poor_structure_grade for stock-first buy picks', () => {
      const pick = makePick([
        { slug: 'call-zebra',         grade: 'F', liquidityScore: 7, setup: makeSetup(105) },
        { slug: 'long-call-vertical', grade: 'F', liquidityScore: 5, setup: makeSetup(105) },
      ]);
      const flags = runChecks(svc, pick, 'buy');
      expect(flags.find(f => f.key === 'poor_structure_grade')).toBeUndefined();
    });

    it('still fires poor_structure_grade for non-buy all-F picks', () => {
      const pick = makePick([
        { slug: 'short-naked-put', grade: 'F', liquidityScore: 7, setup: makeSetup(95) },
      ]);
      const flags = runChecks(svc, pick, 'wheel');
      expect(flags.find(f => f.key === 'poor_structure_grade')).toBeDefined();
    });
  });

  describe('checkLabPriceConsistency — stale lab price guard', () => {
    it('warns when the lab underlying price deviates > 5% from the live price', () => {
      // Regression: 2026-06-10 WSO lab ran at $450 vs live $375.66 (stale E*Trade
      // Greeks) and built a wheel put 11.8% ITM; AWI was 31% off and passed.
      const pick = makePick([
        { slug: 'short-naked-put', grade: 'A', liquidityScore: 8, setup: makeSetup(420) },
      ], 375.66, 450);
      const flags = runChecks(svc, pick, 'wheel');
      const f = flags.find(fl => fl.key === 'stale_lab_price');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warning');
      expect(f!.description).toContain('450');
      expect(f!.description).toContain('375.66');
    });

    it('does not warn when lab and live prices agree within 5%', () => {
      const pick = makePick([
        { slug: 'short-naked-put', grade: 'A', liquidityScore: 8, setup: makeSetup(95) },
      ], 100, 102);
      const flags = runChecks(svc, pick, 'wheel');
      expect(flags.find(fl => fl.key === 'stale_lab_price')).toBeUndefined();
    });

    it('skips silently when the lab context or price is missing', () => {
      const flags = runChecks(svc, makePick(null), 'wheel');
      expect(flags.find(fl => fl.key === 'stale_lab_price')).toBeUndefined();
    });
  });

  describe('GRADE_RANK — A+ ranking regression', () => {
    it('does not fire poor_structure_grade when an A+ structure exists alongside an F', () => {
      // Regression: missing 'A+' key ranked A+ as 0 (below F), so [A+, F] picked F as "best".
      const pick = makePick([
        { slug: 'big-lizard',         grade: 'A+', liquidityScore: 8, setup: makeSetup(105) },
        { slug: 'long-call-vertical', grade: 'F',  liquidityScore: 5, setup: makeSetup(105) },
      ]);
      const flags = runChecks(svc, pick, 'bullish');
      expect(flags.find(f => f.key === 'poor_structure_grade')).toBeUndefined();
    });
  });
});

describe('EARNINGS_PENALTY_STRATEGIES', () => {
  it('covers all short-premium strategies, not just income', () => {
    expect(EARNINGS_PENALTY_STRATEGIES).toContain('income');
    expect(EARNINGS_PENALTY_STRATEGIES).toContain('wheel');
    expect(EARNINGS_PENALTY_STRATEGIES).toContain('bearish');
  });
});
