// Regression tests for CriticService rule checks (v0.32.67).
// Covers: chosen-structure liquidity flag, liquidity threshold, bearish SPY
// mirror, counter-trend ITM strike rule, buy stock-first presentation,
// A+ grade ranking, and the earnings-penalty strategy list.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  CriticService,
  breakevenDistancePct,
  extractVolatilityContext,
  type MarketContext,
} from '../src/main/services/critic-service.js';
import { EARNINGS_PENALTY_STRATEGIES } from '../src/main/services/jobs/daily-intelligence-brief-job.js';
import type { BriefPick, ScoringConfig } from '../src/shared/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Leg = { strike: number; action: string; side?: 'call' | 'put' };
type LabScore = {
  slug: string;
  grade: string;
  liquidityScore: number;
  setup: {
    expiration: string;
    netCredit: number | null;
    legs: Leg[];
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

function makeMultiLegSetup(legs: Leg[], netCredit: number, expiration = '2099-01-15') {
  return { expiration, netCredit, legs, unavailableReason: null };
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
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, confirmed INTEGER)`);
    svc = new CriticService(db);
  });

  describe('checkEarningsInWindow — unknown vs known-clear (v0.32.82)', () => {
    // ~11% of the universe has no earnings_calendar row; "no row" must read as
    // "unverified", not "no earnings risk".
    const liquidPick = () => makePick([
      { slug: 'big-lizard', grade: 'A', liquidityScore: 8, setup: makeSetup(105, '2099-01-15') },
    ]);

    it('emits an info-severity earnings_unknown flag when the ticker has no future earnings row', () => {
      const flags = runChecks(svc, liquidPick(), 'bullish');
      const f = flags.find(x => x.key === 'earnings_unknown');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('info');
      expect(f!.description).toContain('TEST');
    });

    it('stays silent when a future earnings date exists beyond expiry (known clear)', () => {
      db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', '2099-06-01', 1)`).run();
      const flags = runChecks(svc, liquidPick(), 'bullish');
      expect(flags.find(x => x.key === 'earnings_unknown')).toBeUndefined();
      expect(flags.find(x => x.key === 'earnings_in_window')).toBeUndefined();
    });

    it('flags earnings_in_window (warning) when the report falls before expiry', () => {
      db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', '2098-12-01', 1)`).run();
      const flags = runChecks(svc, liquidPick(), 'bullish');
      const f = flags.find(x => x.key === 'earnings_in_window');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warning');
      expect(flags.find(x => x.key === 'earnings_unknown')).toBeUndefined();
    });

    it('does not emit earnings flags when the pick has no options structure', () => {
      const flags = runChecks(svc, makePick(null), 'bullish');
      expect(flags.find(x => x.key === 'earnings_unknown')).toBeUndefined();
      expect(flags.find(x => x.key === 'earnings_in_window')).toBeUndefined();
    });
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

  describe('checkCounterTrendStrike — bearish short-call cushion in uptrend', () => {
    // reverse-big-lizard = short straddle + protective long put → the rally-exposed
    // leg is the SHORT CALL. The rule must judge that leg, not just any sell leg.
    const revLizard = (callStrike: number) => makeMultiLegSetup(
      [
        { strike: callStrike, action: 'sell', side: 'call' },
        { strike: callStrike, action: 'sell', side: 'put' },
        { strike: callStrike - 5, action: 'buy', side: 'put' },
      ],
      250,
    );

    it('warns when the short call is at/below price with SPY bullish', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: revLizard(99) },
      ], 100); // short call 99 ≤ price 100 → no upside cushion
      const flags = runChecks(svc, pick, 'bearish', bullMarket);
      const ct = flags.find(f => f.key === 'counter_trend_itm_strike');
      expect(ct).toBeDefined();
      expect(ct!.severity).toBe('warning');
      expect(ct!.description).toContain('Short call');
    });

    it('does not warn when the short call has OTM cushion', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: revLizard(105) },
      ], 100); // short call 105 > price 100 → 5% cushion
      const flags = runChecks(svc, pick, 'bearish', bullMarket);
      expect(flags.find(f => f.key === 'counter_trend_itm_strike')).toBeUndefined();
    });

    it('does not warn when SPY is not in an uptrend', () => {
      const pick = makePick([
        { slug: 'reverse-big-lizard', grade: 'A', liquidityScore: 8, setup: revLizard(99) },
      ], 100);
      const flags = runChecks(svc, pick, 'bearish', { vix: 18, spyAbove200ma: false });
      expect(flags.find(f => f.key === 'counter_trend_itm_strike')).toBeUndefined();
    });

    // Regression: a bearish long-put-vertical is a DEBIT spread whose short put
    // correctly sits below spot. The old "first sell leg ≤ price" rule wrongly
    // flagged it as "at/in the money — zero cushion" (GPN/EL on the 2026-06-16
    // brief), derailing the critic's rationale. No short call → no flag.
    it('does not warn on a bearish long-put-vertical (short put below spot by design)', () => {
      const pick = makePick([
        {
          slug: 'long-put-vertical', grade: 'A', liquidityScore: 8,
          setup: { expiration: '2099-01-15', netCredit: null,
            legs: [
              { strike: 67.5, action: 'buy', side: 'put' },
              { strike: 62.5, action: 'sell', side: 'put' },
            ] },
        },
      ], 67.48); // short put 62.5 is 7.4% OTM — a cushion, not a deficit
      const flags = runChecks(svc, pick, 'bearish', bullMarket);
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

// F2: strike-aware breakeven distance — credit/price only holds for ATM straddles.
describe('breakevenDistancePct (strike-aware)', () => {
  it('equals credit/price for an ATM short straddle (backward compatible)', () => {
    // sell put + sell call both at 100, $8/share credit, spot 100 → BE 92/108 → 8%.
    const legs: Leg[] = [
      { strike: 100, action: 'sell', side: 'put' },
      { strike: 100, action: 'sell', side: 'call' },
    ];
    expect(breakevenDistancePct(legs, 800, 100)).toBe(8.0);
  });

  it('is much wider than credit/price for an OTM short strangle', () => {
    // sell put 90 / sell call 110, $4/share credit, spot 100. Old proxy = 4%.
    const legs: Leg[] = [
      { strike: 90, action: 'sell', side: 'put' },
      { strike: 110, action: 'sell', side: 'call' },
    ];
    expect(breakevenDistancePct(legs, 400, 100)).toBe(14.0); // (100-(90-4))/100
  });

  it('uses the inner short strikes (not the long wings) for an iron condor', () => {
    // short 80/120, long 70/130, $3/share credit, spot 100. Real BE ≈ 23%, old proxy = 3%.
    const legs: Leg[] = [
      { strike: 70, action: 'buy', side: 'put' },
      { strike: 80, action: 'sell', side: 'put' },
      { strike: 120, action: 'sell', side: 'call' },
      { strike: 130, action: 'buy', side: 'call' },
    ];
    expect(breakevenDistancePct(legs, 300, 100)).toBe(23.0);
  });

  it('includes the OTM distance for a single short put (CSP)', () => {
    // sell put 95, $2.5/share credit, spot 100 → BE 92.5 → 7.5% (old proxy = 2.5%).
    expect(breakevenDistancePct([{ strike: 95, action: 'sell', side: 'put' }], 250, 100)).toBe(7.5);
  });

  it('infers put/call from strike-vs-spot when side is absent', () => {
    expect(breakevenDistancePct([{ strike: 90, action: 'sell' }], 400, 100)).toBe(14.0);
  });

  it('returns null for missing credit, no short leg, or non-positive price', () => {
    expect(breakevenDistancePct([{ strike: 95, action: 'sell' }], null, 100)).toBeNull();
    expect(breakevenDistancePct([{ strike: 95, action: 'buy' }], 250, 100)).toBeNull();
    expect(breakevenDistancePct([{ strike: 95, action: 'sell' }], 250, 0)).toBeNull();
  });
});

// F2: the thin_breakeven warning must not fire on structurally-wide condors.
describe('checkThinBreakeven — strike-aware', () => {
  let svc: CriticService;
  beforeEach(() => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, confirmed INTEGER)`);
    svc = new CriticService(db);
  });

  it('does NOT flag a wide iron condor as thin (was the bug: reported ~2%)', () => {
    const pick = makePick([
      { slug: 'iron-condor', grade: 'A', liquidityScore: 8, setup: makeMultiLegSetup([
        { strike: 70, action: 'buy', side: 'put' },
        { strike: 80, action: 'sell', side: 'put' },
        { strike: 120, action: 'sell', side: 'call' },
        { strike: 130, action: 'buy', side: 'call' },
      ], 300) },
    ], 100);
    expect(runChecks(svc, pick, 'income').find(f => f.key === 'thin_breakeven')).toBeUndefined();
  });

  it('still flags a genuinely thin ATM short straddle', () => {
    const pick = makePick([
      { slug: 'short-straddle', grade: 'A', liquidityScore: 8, setup: makeMultiLegSetup([
        { strike: 100, action: 'sell', side: 'put' },
        { strike: 100, action: 'sell', side: 'call' },
      ], 100) }, // $1/share credit, spot 100 → BE 1% < 2%
    ], 100);
    expect(runChecks(svc, pick, 'income').find(f => f.key === 'thin_breakeven')).toBeDefined();
  });
});

// F3: once VIX is populated in quote_cache, getMarketContext reads it and the
// previously-dormant VIX rules fire.
describe('getMarketContext + VIX rules (F3)', () => {
  function makeSvc(vix: number | null) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, confirmed INTEGER)`);
    db.exec(`CREATE TABLE quote_cache (ticker TEXT PRIMARY KEY, last REAL, fetched_at TEXT)`);
    db.exec(`CREATE TABLE historical_prices (ticker TEXT, date TEXT, close REAL)`);
    if (vix !== null) db.prepare(`INSERT INTO quote_cache (ticker, last, fetched_at) VALUES ('VIX', ?, '2026-06-15')`).run(vix);
    return new CriticService(db);
  }

  it('reads a populated VIX from quote_cache (was always null before)', () => {
    expect(makeSvc(31.5).getMarketContext().vix).toBe(31.5);
    expect(makeSvc(null).getMarketContext().vix).toBeNull();
  });

  it('fires elevated_market_risk on wheel/income when VIX > 30', () => {
    const svc = makeSvc(34);
    const pick = makePick([{ slug: 'short-naked-put', grade: 'A', liquidityScore: 8, setup: makeSetup(95) }], 100);
    const market = svc.getMarketContext();
    const f = runChecks(svc, pick, 'wheel', market).find(x => x.key === 'elevated_market_risk');
    expect(f).toBeDefined();
    expect(f!.description).toContain('elevated market fear');
  });

  it('does not fire the VIX fear rule when VIX is null (dormant, fail-safe)', () => {
    const svc = makeSvc(null);
    const pick = makePick([{ slug: 'short-naked-put', grade: 'A', liquidityScore: 8, setup: makeSetup(95) }], 100);
    const f = runChecks(svc, pick, 'wheel', svc.getMarketContext()).find(x => x.key === 'elevated_market_risk');
    expect(f).toBeUndefined();
  });
});

// F1: real IV is extracted for the critic so it never invents a volatility figure.
describe('extractVolatilityContext', () => {
  it('extracts and rounds implied vol + IV rank from the lab context', () => {
    expect(extractVolatilityContext({ context: { currentAtmIv: 104.74, ivRank: 89.88 } }))
      .toEqual({ impliedVolPct: 104.7, ivRank: 90 });
  });

  it('returns ivRank null when only IV is present', () => {
    expect(extractVolatilityContext({ context: { currentAtmIv: 40 } }))
      .toEqual({ impliedVolPct: 40, ivRank: null });
  });

  it('returns null when IV is missing or not finite (→ prompt forbids citing vol)', () => {
    expect(extractVolatilityContext(null)).toBeNull();
    expect(extractVolatilityContext({ context: {} })).toBeNull();
    expect(extractVolatilityContext({ context: { currentAtmIv: NaN } })).toBeNull();
  });
});
