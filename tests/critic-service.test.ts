// Regression tests for CriticService rule checks (v0.32.67).
// Covers: chosen-structure liquidity flag, liquidity threshold, bearish SPY
// mirror, counter-trend ITM strike rule, buy stock-first presentation,
// A+ grade ranking, and the earnings-penalty strategy list.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  CriticService,
  selectCriticSignals,
  breakevenDistancePct,
  extractVolatilityContext,
  expectedOneSigmaMove,
  type MarketContext,
} from '../src/main/services/critic-service.js';
import { EARNINGS_PENALTY_STRATEGIES } from '../src/main/services/jobs/daily-intelligence-brief-job.js';
import type { BriefPick, ScoringConfig } from '../src/shared/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Leg = { strike: number; action: string; side?: 'call' | 'put'; bid?: number; ask?: number };
type LabScore = {
  slug: string;
  grade: string;
  liquidityScore: number;
  setup: {
    expiration: string;
    netCredit: number | null;
    maxLoss?: number | null;
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
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, report_time TEXT, confirmed INTEGER)`);
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
      db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', '2099-06-01', NULL, 1)`).run();
      const flags = runChecks(svc, liquidPick(), 'bullish');
      expect(flags.find(x => x.key === 'earnings_unknown')).toBeUndefined();
      expect(flags.find(x => x.key === 'earnings_in_window')).toBeUndefined();
    });

    it('flags earnings_in_window (warning) when the report falls before expiry', () => {
      db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', '2098-12-01', NULL, 1)`).run();
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

    // v1.1.116: a same-day report used to compare with a strict `>` on today's date, so an
    // amc (after-close) or unknown-time report today read as "no earnings" — a stock could
    // surface in the morning brief with no warning hours before it reports.
    describe('same-day earnings (v1.1.116)', () => {
      const todayET = new Date().toISOString().slice(0, 10);

      it('flags earnings_in_window for a same-day amc report (has not happened yet)', () => {
        db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', ?, 'amc', 1)`).run(todayET);
        const flags = runChecks(svc, liquidPick(), 'bullish');
        const f = flags.find(x => x.key === 'earnings_in_window');
        expect(f).toBeDefined();
        expect(f!.severity).toBe('warning');
        expect(flags.find(x => x.key === 'earnings_unknown')).toBeUndefined();
      });

      it('flags earnings_in_window for a same-day report with unknown time (conservative)', () => {
        db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', ?, NULL, 1)`).run(todayET);
        const flags = runChecks(svc, liquidPick(), 'bullish');
        expect(flags.find(x => x.key === 'earnings_in_window')).toBeDefined();
      });

      it('treats a same-day bmo report as already-happened, not an in-window risk', () => {
        db.prepare(`INSERT INTO earnings_calendar VALUES ('TEST', ?, 'bmo', 1)`).run(todayET);
        const flags = runChecks(svc, liquidPick(), 'bullish');
        expect(flags.find(x => x.key === 'earnings_in_window')).toBeUndefined();
        // With no pending row left (today's bmo has already occurred and the row hasn't
        // been refreshed to the next date), the NEXT earnings is genuinely unverified —
        // correctly falls back to earnings_unknown rather than a false all-clear.
        expect(flags.find(x => x.key === 'earnings_unknown')).toBeDefined();
      });
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

  describe('checkLiquidity — defined-risk spread aligns with the engine tradability bar (v1.1.68)', () => {
    // A 2-leg defined-risk spread (maxLoss finite, legs quoted) — the kind the v2 engine trades.
    // The engine rejects it below MIN_TRADABLE_LIQUIDITY_SCORE (8); the critic must caution to match.
    const spread = (liq: number, opts: { noBid?: boolean } = {}) => makePick([
      {
        slug: 'long-put-vertical', grade: 'A', liquidityScore: liq,
        setup: {
          expiration: '2099-01-15', netCredit: null, maxLoss: -400,
          legs: [
            { strike: 100, action: 'sell', side: 'put', bid: opts.noBid ? 0 : 0.8, ask: 1.2 },
            { strike: 95, action: 'buy', side: 'put', bid: 0.3, ask: 0.6 },
          ],
        },
      },
    ]);

    it('warns when a tradable spread is below the bar (6 < 8) — was a silent pass before', () => {
      const liq = runChecks(svc, spread(6), 'bearish').find(f => f.key === 'low_liquidity');
      expect(liq).toBeDefined();
      expect(liq!.severity).toBe('warning');
      expect(liq!.description).toContain('6/15');
    });

    it('does not flag a spread at/above the bar (10)', () => {
      expect(runChecks(svc, spread(10), 'bearish').find(f => f.key === 'low_liquidity')).toBeUndefined();
    });

    it('warns on a no-bid leg even when the score is decent', () => {
      const liq = runChecks(svc, spread(10, { noBid: true }), 'bearish').find(f => f.key === 'low_liquidity');
      expect(liq).toBeDefined();
      expect(liq!.severity).toBe('warning');
      expect(liq!.description).toContain('no bid');
    });

    it('leaves single-leg short-premium (4–7 normal) un-flagged', () => {
      // wheel short-naked-put, single leg, no maxLoss → not a spread → old <4 rule only.
      const pick = makePick([{ slug: 'short-naked-put', grade: 'A', liquidityScore: 5, setup: makeSetup(95) }]);
      expect(runChecks(svc, pick, 'wheel').find(f => f.key === 'low_liquidity')).toBeUndefined();
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

  // v1.1.116: checkTrendAlignment read 'trendStrength' for wheel and buy, but neither
  // strategy's scoring config has that key (it belongs to bullish) — pick.signals only ever
  // contains the strategy's own configured keys, so the read was always `undefined` and the
  // wheel/buy trend-conflict warning could never fire. Fixed to read the strategy's real
  // trend signal (wheel: notDowntrend, buy: trendAlignment).
  describe('checkTrendAlignment — wheel/buy key fix (v1.1.116)', () => {
    function pickWithSignals(signals: BriefPick['signals']): BriefPick {
      return { ...makePick(null), signals };
    }
    const sig = (normalized: number, weight = 8): BriefPick['signals'][string] =>
      ({ raw: normalized, normalized, weight, missing: false });

    it('fires for wheel when notDowntrend is low (confirmed downtrend)', () => {
      const pick = pickWithSignals({ notDowntrend: sig(10) }); // scoring's downtrend raw value
      const flags = runChecks(svc, pick, 'wheel');
      const f = flags.find(x => x.key === 'trend_strategy_conflict');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('warning');
      expect(f!.description).toContain('confirmed downtrend');
    });

    it('does not fire for wheel when notDowntrend is healthy (sideways/uptrend)', () => {
      const pick = pickWithSignals({ notDowntrend: sig(75) });
      expect(runChecks(svc, pick, 'wheel').find(x => x.key === 'trend_strategy_conflict')).toBeUndefined();
    });

    it('a stale trendStrength signal alone no longer fires the wheel check (was silently dead before)', () => {
      // Confirms the fix actually changed behavior: the old key never existed on wheel's
      // config, so setting it here proves the check now looks at notDowntrend, not trendStrength.
      const pick = pickWithSignals({ trendStrength: sig(5) });
      expect(runChecks(svc, pick, 'wheel').find(x => x.key === 'trend_strategy_conflict')).toBeUndefined();
    });

    it('fires for buy when trendAlignment and relativeStrength are both weak', () => {
      const pick = pickWithSignals({ trendAlignment: sig(25), relativeStrength: sig(20) });
      const flags = runChecks(svc, pick, 'buy');
      const f = flags.find(x => x.key === 'trend_strategy_conflict');
      expect(f).toBeDefined();
      expect(f!.description).toContain('lagging');
    });

    it('does not fire for buy when only one of trendAlignment/relativeStrength is weak', () => {
      const pick = pickWithSignals({ trendAlignment: sig(80), relativeStrength: sig(20) });
      expect(runChecks(svc, pick, 'buy').find(x => x.key === 'trend_strategy_conflict')).toBeUndefined();
    });

    it('bullish and bearish checks are unaffected (still read trendStrength/downtrendScore)', () => {
      const bullishFlags = runChecks(svc, pickWithSignals({ trendStrength: sig(10) }), 'bullish');
      expect(bullishFlags.find(x => x.key === 'trend_strategy_conflict')).toBeDefined();
      const bearishFlags = runChecks(svc, pickWithSignals({ downtrendScore: sig(10) }), 'bearish');
      expect(bearishFlags.find(x => x.key === 'trend_strategy_conflict')).toBeDefined();
    });
  });

  // v1.1.117: the original comparison (`topContrib > 50`) treated an absolute points
  // value — bounded by that signal's own weight (max ~30 across every baseline config) —
  // as if it were a percentage, so it could never exceed 50 and this check has never fired.
  // Fixed to compare the signal's actual SHARE of the composite against the 50% threshold.
  describe('checkScoreConcentration — share-of-composite fix (v1.1.117)', () => {
    function pickWithScore(compositeScore: number, signals: BriefPick['signals']): BriefPick {
      return { ...makePick(null), compositeScore, signals };
    }
    const sig = (normalized: number, weight: number): BriefPick['signals'][string] =>
      ({ raw: normalized, normalized, weight, missing: false });

    it('fires when one signal accounts for > 50% of the composite', () => {
      // contrib = 100 × 22 / 100 = 22; composite 30 → share 73%.
      const pick = pickWithScore(30, { ivRank: sig(100, 22), other: sig(20, 8) });
      const flags = runChecks(svc, pick, 'wheel');
      const f = flags.find(x => x.key === 'score_concentrated');
      expect(f).toBeDefined();
      expect(f!.severity).toBe('info');
      expect(f!.description).toContain('73%');
    });

    it('does not fire when contribution is spread evenly across signals', () => {
      const pick = pickWithScore(60, {
        a: sig(60, 20), b: sig(60, 20), c: sig(60, 20), d: sig(60, 20), e: sig(60, 20),
      });
      expect(runChecks(svc, pick, 'wheel').find(x => x.key === 'score_concentrated')).toBeUndefined();
    });

    it('regression: a case the old ">50 points" comparison could never reach (contrib=30, 100% share)', () => {
      // Even the highest-weight baseline signal (30) tops out at contrib=30 when normalized=100
      // — the old absolute-points check (`> 50`) could never fire for ANY baseline config.
      const pick = pickWithScore(30, { breakoutDecisiveness: sig(100, 30) });
      const flags = runChecks(svc, pick, 'inflection');
      expect(flags.find(x => x.key === 'score_concentrated')).toBeDefined();
    });

    it('does not divide by zero when compositeScore is 0', () => {
      const pick = pickWithScore(0, { ivRank: sig(0, 22) });
      expect(runChecks(svc, pick, 'wheel').find(x => x.key === 'score_concentrated')).toBeUndefined();
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
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, report_time TEXT, confirmed INTEGER)`);
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
  function makeSvc(vix: number | null, fetchedAt: string = new Date().toISOString()) {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE earnings_calendar (ticker TEXT, report_date TEXT, report_time TEXT, confirmed INTEGER)`);
    db.exec(`CREATE TABLE quote_cache (ticker TEXT PRIMARY KEY, last REAL, fetched_at TEXT)`);
    db.exec(`CREATE TABLE historical_prices (ticker TEXT, date TEXT, close REAL)`);
    if (vix !== null) db.prepare(`INSERT INTO quote_cache (ticker, last, fetched_at) VALUES ('VIX', ?, ?)`).run(vix, fetchedAt);
    return new CriticService(db);
  }

  it('reads a populated VIX from quote_cache (was always null before)', () => {
    expect(makeSvc(31.5).getMarketContext().vix).toBe(31.5);
    expect(makeSvc(null).getMarketContext().vix).toBeNull();
  });

  // v1.1.116: a VIX value from a failed-refresh window (e.g. E*Trade down over a weekend)
  // used to be read with no age check — a stale complacency-regime VIX could sit in
  // quote_cache for days while the real market was in a fear regime, or vice versa.
  describe('VIX staleness (v1.1.116)', () => {
    it('reads a VIX fetched a few hours ago (fresh)', () => {
      const fetchedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(); // 6h old
      expect(makeSvc(34, fetchedAt).getMarketContext().vix).toBe(34);
    });

    it('treats a VIX older than 24h as unknown (null), not stale-but-confident', () => {
      const fetchedAt = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(); // 30h old
      expect(makeSvc(34, fetchedAt).getMarketContext().vix).toBeNull();
    });

    it('a stale VIX does not fire the VIX rules (fail-safe)', () => {
      const fetchedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(); // 3 days old
      const svc = makeSvc(34, fetchedAt); // would be > 30 (fear regime) if read
      const pick = makePick([{ slug: 'short-naked-put', grade: 'A', liquidityScore: 8, setup: makeSetup(95) }], 100);
      const market = svc.getMarketContext();
      expect(market.vix).toBeNull();
      expect(runChecks(svc, pick, 'wheel', market).find(x => x.key === 'elevated_market_risk')).toBeUndefined();
    });
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

  // The critic flagged a phantom "IV discrepancy" when the advocate cited the realized-vol
  // signal ("recent volatility 138.7") and the critic only had impliedVolPct (111.6).
  it('includes the realized-vol signal alongside IV so the critic can reconcile it', () => {
    expect(extractVolatilityContext({ context: { currentAtmIv: 111.6, ivRank: 71 } }, 138.7))
      .toEqual({ impliedVolPct: 111.6, ivRank: 71, realizedVolPct: 138.7 });
  });

  it('surfaces realized vol even when IV was not measured (impliedVolPct null, not null object)', () => {
    expect(extractVolatilityContext({ context: {} }, 80))
      .toEqual({ impliedVolPct: null, ivRank: null, realizedVolPct: 80 });
  });

  it('omits realizedVolPct when not provided (unchanged shape for non-vol strategies)', () => {
    expect(extractVolatilityContext({ context: { currentAtmIv: 40 } }))
      .toEqual({ impliedVolPct: 40, ivRank: null });
  });
});

// The critic LLM routinely overstated the 1-sigma move when asked to compute it (AMD wheel
// "±$149/29%" vs true ±$104/20.5%). It is now precomputed and the prompt forbids the LLM
// from deriving its own — same remediation as the IV-fabrication fix above.
describe('expectedOneSigmaMove', () => {
  it('computes the 1-sigma move in % and $ (AMD regression: ~$104 / 20.5%, NOT the critic\'s $149/29%)', () => {
    // 507.29 × 0.70271 × √(31/365) = 20.5% → $103.89
    expect(expectedOneSigmaMove(70.271, 31, 507.29)).toEqual({ pct: 20.5, usd: 103.89 });
  });

  it('computes the MRVL bullish case (~$82 / 29.5%, NOT the critic\'s ~$152)', () => {
    // 278.67 × 1.01334 × √(31/365) ≈ 29.5% → $82.30
    expect(expectedOneSigmaMove(101.334, 31, 278.67)).toEqual({ pct: 29.5, usd: 82.3 });
  });

  it('returns a pct but null usd when price is unknown', () => {
    expect(expectedOneSigmaMove(70.271, 31, null)).toEqual({ pct: 20.5, usd: null });
  });

  it('returns nulls when IV is missing/non-finite or DTE ≤ 0 (→ prompt skips expected-move reasoning)', () => {
    expect(expectedOneSigmaMove(null, 31, 507.29)).toEqual({ pct: null, usd: null });
    expect(expectedOneSigmaMove(NaN, 31, 507.29)).toEqual({ pct: null, usd: null });
    expect(expectedOneSigmaMove(70, null, 507.29)).toEqual({ pct: null, usd: null });
    expect(expectedOneSigmaMove(70, 0, 507.29)).toEqual({ pct: null, usd: null });
  });
});

// ─── What the reviewer is allowed to see (v1.1.189) ─────────────────────────
//
// Both defects pinned here pointed the same way: the adversarial reviewer was handed a filtered-
// favourable view of the pick it was meant to attack. Measured over 948 stored picks — the
// worst-scoring signal reached it on 8.3%, a sub-35 reading on 2.8% (18 of 653).

/** DINO, 2026-09-03 — the live pick that surfaced this. Real weights and normalized values. */
const DINO_SIGNALS = {
  ivRank:           { raw: 82.2, normalized: 82.2, weight: 22, missing: false },
  premiumYield:     { raw: 27.0, normalized: 45.0, weight: 19, missing: false },
  fundamentalScore: { raw: 86,   normalized: 86.0, weight: 17, missing: false },
  technicalNeutral: { raw: 73.9, normalized: 30.6, weight: 11, missing: false },
  notDowntrend:     { raw: 100,  normalized: 100,  weight: 8,  missing: false },
  recentVolatility: { raw: 35.4, normalized: 41.1, weight: 10, missing: false },
  leverageQuality:  { raw: 0.15, normalized: 97.0, weight: 4,  missing: false },
} as unknown as BriefPick['signals'];

describe('selectCriticSignals — the reviewer must see the worst reading', () => {
  it('shows the top contributors, as before', () => {
    const keys = selectCriticSignals(DINO_SIGNALS).map(s => s.key);
    // contribution = weight x normalized: 1809, 1462, 855, 800
    expect(keys.slice(0, 4)).toEqual(['ivRank', 'fundamentalScore', 'premiumYield', 'notDowntrend']);
  });

  // THE REGRESSION. technicalNeutral at 30.6/100 is the app's own "this is extended" read, and its
  // contribution (11 x 30.6 = 337) put it 7th of 7 — so the sort on good news excluded exactly the
  // signal a reviewer needed. The critic passed DINO clean with no warning flag.
  it('appends the weakest reading that the contribution sort excluded', () => {
    const sel = selectCriticSignals(DINO_SIGNALS);
    expect(sel).toHaveLength(5);
    const weakest = sel.find(s => s.key === 'technicalNeutral');
    expect(weakest).toBeDefined();
    expect(weakest!.normalized).toBeCloseTo(30.6, 5);
    expect(weakest!.isWeakestReading).toBe(true);
  });

  it('marks only the weakest, and marks nothing else', () => {
    const marked = selectCriticSignals(DINO_SIGNALS).filter(s => s.isWeakestReading);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.key).toBe('technicalNeutral');
  });

  it('does not duplicate when the weakest already made the cut', () => {
    const sig = {
      a: { raw: 1, normalized: 90, weight: 30, missing: false },
      b: { raw: 1, normalized: 80, weight: 20, missing: false },
      c: { raw: 1, normalized: 70, weight: 10, missing: false },
      d: { raw: 1, normalized: 60, weight: 5,  missing: false },
    } as unknown as BriefPick['signals'];
    const sel = selectCriticSignals(sig);
    expect(sel).toHaveLength(4);
    expect(sel.filter(s => s.isWeakestReading)).toHaveLength(1);
    expect(sel.find(s => s.isWeakestReading)!.key).toBe('d');
  });

  it('ignores missing and null-raw signals — an absent reading is not a weak one', () => {
    const sig = {
      a: { raw: 1, normalized: 90, weight: 30, missing: false },
      gone: { raw: null, normalized: 0, weight: 25, missing: true },
    } as unknown as BriefPick['signals'];
    expect(selectCriticSignals(sig).map(s => s.key)).toEqual(['a']);
  });

  it('is empty for a pick with no scored signals rather than throwing', () => {
    expect(selectCriticSignals({} as BriefPick['signals'])).toEqual([]);
  });
});

describe('readOwnership — the measured ownership read finally reaches the critic', () => {
  let db2: InstanceType<typeof Database>;
  let svc2: CriticService;

  /** 260 sessions, flat at `base` except the last 20 which sit at `recent`. */
  function seed(ticker: string, base: number, recent: number) {
    db2.exec(`CREATE TABLE IF NOT EXISTS historical_prices (
      ticker TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER)`);
    const ins = db2.prepare(
      'INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?,?,?,?,?,?,0)');
    for (let i = 0; i < 260; i++) {
      const px = i < 240 ? base : recent;               // oldest first; last 20 are `recent`
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      ins.run(ticker, d, px, px, px, px);
    }
  }
  const wheelPick = (strike: number, mid: number): BriefPick => ({
    ticker: 'OWN', compositeScore: 70, signals: {},
    strategyLabResult: { context: { underlyingPx: 100 }, scores: [{
      slug: 'short-naked-put', grade: 'A', liquidityScore: 10,
      setup: { expiration: '2099-01-15', netCredit: 100, unavailableReason: null,
               legs: [{ strike, action: 'sell', side: 'put', mid }] },
    }] },
    aiRationale: null, rank: 1, validated: true, price: 100,
  } as unknown as BriefPick);

  beforeEach(() => {
    db2 = new Database(':memory:');
    svc2 = new CriticService(db2);
  });

  it('reports both axes, with the basis measured against the ticker own SMA200', () => {
    seed('OWN', 100, 100);
    const r = svc2.readOwnership(wheelPick(95, 2), 'wheel') as Record<string, unknown>;
    expect(r).not.toBeNull();
    expect(r['costBasisIfAssigned']).toBeCloseTo(93, 5);      // 95 − 2
    expect(r['basisAtOrBelowSma200']).toBe(true);
    expect(r['strikeBelow20dLow']).toBe(true);                // strike 95 is under the flat 100 low
    expect(r['low20d']).toBeCloseTo(100, 5);
  });

  // The case the whole T8 study turned on: extended on the year, below anything it has traded at
  // this month. Before v1.1.189 the reviewer saw neither half.
  it('separates an extended basis from a strike under recent support', () => {
    seed('OWN', 60, 120);                                     // long-run 60ish, last 20 at 120
    const r = svc2.readOwnership(wheelPick(110, 4), 'wheel') as Record<string, unknown>;
    expect(r['basisAtOrBelowSma200']).toBe(false);            // basis 106 is above the SMA200
    expect(r['strikeBelow20dLow']).toBe(true);                // strike 110 is below the 120 low
  });

  it('returns null — never a pass — when there is too little history', () => {
    db2.exec(`CREATE TABLE historical_prices (
      ticker TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume INTEGER)`);
    expect(svc2.readOwnership(wheelPick(95, 2), 'wheel')).toBeNull();
  });

  it('returns null when the pick has no cash-secured put to measure', () => {
    seed('OWN', 100, 100);
    const noCsp = { ...wheelPick(95, 2), strategyLabResult: null } as BriefPick;
    expect(svc2.readOwnership(noCsp, 'wheel')).toBeNull();
  });

  // Context assembly must never be able to take a verdict down with it.
  it('swallows a broken table rather than throwing', () => {
    expect(() => svc2.readOwnership(wheelPick(95, 2), 'wheel')).not.toThrow();
  });
});
