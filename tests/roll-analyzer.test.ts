import { describe, it, expect } from 'vitest';
import {
  buildRollCandidates, scoreByMetric, recommendAction, dteDays, computeRollability, pickRollabilityExpirations,
} from '../src/main/services/roll-analyzer-service.js';
import type { OptionContract } from '../src/main/services/data-provider.js';
import type { RollPositionInput, RollCurrentState, RollCandidate } from '../src/shared/types.js';

// Fixed "now" so DTEs are deterministic. Current expiry 30 DTE, rolls at 60/90.
const NOW = new Date('2026-07-01T16:00:00Z').getTime();
const CUR_EXP = '2026-07-31'; // 30 DTE
const EXP_60 = '2026-08-30'; // 60 DTE

const put = (strike: number, bid: number, ask: number, delta: number, exp: string): OptionContract => ({
  ticker: 'MRVL', expiration: exp, strike, side: 'put', bid, ask,
  delta, gamma: null, theta: null, vega: null, iv: 0.4, openInterest: 1000, volume: 100,
});

const input: RollPositionInput = {
  ticker: 'MRVL', optionType: 'put', strike: 270, expiration: CUR_EXP, contracts: 1, entryCredit: 3.0,
};

describe('buildRollCandidates', () => {
  const currentMark = 4.0; // buy-to-close the current short costs $4/sh (it moved against us)

  it('includes only net-credit rolls at later expiries within the strike band', () => {
    const chains = [
      { expiration: EXP_60, contracts: [
        put(270, 6.0, 6.4, -0.45, EXP_60), // sell-to-open mid 6.2 > 4.0 → credit 2.2/sh ✓
        put(250, 3.6, 3.8, -0.28, EXP_60), // mid 3.7 < 4.0 → debit, excluded
        put(150, 0.5, 0.7, -0.05, EXP_60), // below 0.80×270=216 band, excluded
      ] },
      { expiration: CUR_EXP, contracts: [ put(270, 9, 9.2, -0.5, CUR_EXP) ] }, // not later → excluded
    ];
    const cands = buildRollCandidates(input, currentMark, 30, 272, chains, 'netCredit', NOW);
    expect(cands.length).toBe(1);
    const c = cands[0]!;
    expect(c.strike).toBe(270);
    expect(c.expiration).toBe(EXP_60);
    expect(c.netCreditPerShare).toBeCloseTo(2.2, 5);
    expect(c.netCredit).toBeCloseTo(220, 5);
    expect(c.direction).toBe('same');
    expect(c.addedDte).toBe(30);
  });

  it('computes annualized ROC and folds the roll credit into the new breakeven', () => {
    const chains = [{ expiration: EXP_60, contracts: [put(270, 6.0, 6.4, -0.45, EXP_60)] }];
    const c = buildRollCandidates(input, 4.0, 30, 272, chains, 'annualizedRoc', NOW)[0]!;
    // capitalPerShare = strike 270; netCredit/sh = 2.2; addedDte = 30
    // annualizedRoc = (2.2/270)/30*365 ≈ 0.0991
    expect(c.annualizedRoc).toBeCloseTo((2.2 / 270) / 30 * 365, 4);
    expect(c.capitalEfficiency).toBeCloseTo(2.2 / 270, 6);
    // new breakeven = strike - (entryCredit + netCredit/sh) = 270 - (3 + 2.2) = 264.8
    expect(c.breakeven).toBeCloseTo(264.8, 5);
  });

  it('ranks by the selected metric (netCredit vs capitalEfficiency pick different winners)', () => {
    const chains = [{ expiration: EXP_60, contracts: [
      put(270, 6.0, 6.4, -0.45, EXP_60), // credit 2.2/sh, cap 270 → eff 0.00815, netCredit 220
      put(230, 5.2, 5.6, -0.30, EXP_60), // mid 5.4, credit 1.4/sh, cap 230 → eff 0.00609, netCredit 140
      put(220, 5.6, 6.0, -0.34, EXP_60), // mid 5.8, credit 1.8/sh, cap 220 → eff 0.00818, netCredit 180
    ] }];
    const byCredit = buildRollCandidates(input, 4.0, 30, 272, chains, 'netCredit', NOW);
    expect(byCredit[0]!.strike).toBe(270); // biggest absolute credit
    const byEff = buildRollCandidates(input, 4.0, 30, 272, chains, 'capitalEfficiency', NOW);
    expect(byEff[0]!.strike).toBe(220); // best credit-per-dollar-committed (rolled down)
  });

  it('flags wide bid/ask as not liquid', () => {
    const chains = [{ expiration: EXP_60, contracts: [put(270, 5.0, 7.0, -0.45, EXP_60)] }]; // mid 6, spread 33%
    const c = buildRollCandidates(input, 4.0, 30, 272, chains, 'netCredit', NOW)[0]!;
    expect(c.liquidityOk).toBe(false);
  });

  it('scoreByMetric — riskAdjusted down-weights high-delta candidates', () => {
    const base = { annualizedRoc: 0.4, netCredit: 200, capitalEfficiency: 0.03 } as RollCandidate;
    const lowDelta = { ...base, assignmentProbability: 0.2 } as RollCandidate;
    const highDelta = { ...base, assignmentProbability: 0.7 } as RollCandidate;
    expect(scoreByMetric(lowDelta, 'riskAdjusted')).toBeGreaterThan(scoreByMetric(highDelta, 'riskAdjusted'));
  });
});

describe('recommendAction', () => {
  const baseCurrent: RollCurrentState = {
    underlyingPrice: 272, markToClose: 1.0, bid: 0.9, ask: 1.1, delta: -0.2, iv: 0.4,
    dte: 20, moneyness: 'OTM', openCredit: 300, closeCost: 100, unrealizedPnl: 200,
    pctOfMaxProfit: 0.667, capitalAtRisk: 27000, breakeven: 267, assignmentProbability: 0.2, chainStale: false,
  };

  it('recommends CLOSE when most of the credit is banked', () => {
    const rec = recommendAction({ ...baseCurrent, pctOfMaxProfit: 0.85 }, []);
    expect(rec.action).toBe('close');
  });

  it('recommends ROLL when ITM/high-assignment and a credit roll exists', () => {
    const cand = { strike: 260, expiration: EXP_60, netCredit: 150, direction: 'out-down' } as RollCandidate;
    const rec = recommendAction({ ...baseCurrent, moneyness: 'ITM', assignmentProbability: 0.62 }, [cand]);
    expect(rec.action).toBe('roll');
    expect(rec.reason).toMatch(/260/);
  });

  it('recommends HOLD for a comfortable OTM position with no compelling roll', () => {
    const rec = recommendAction(baseCurrent, []);
    expect(rec.action).toBe('hold');
  });
});

describe('computeRollability — Bec\'s "how far out to get back to safety"', () => {
  const EXP_37 = '2026-08-07';   // +7 days beyond the 30-DTE current expiry
  const EXP_120 = '2026-10-29';  // +90
  const EXP_395 = '2027-07-31';  // +365
  const call = (strike: number, bid: number, ask: number, exp: string): OptionContract => ({
    ticker: 'X', expiration: exp, strike, side: 'call', bid, ask,
    delta: null, gamma: null, theta: null, vega: null, iv: 0.4, openInterest: 500, volume: 10,
  });
  // A covered call written below the stock's cost basis, now in the money.
  const cc: RollPositionInput = { ticker: 'X', optionType: 'call', strike: 270, expiration: CUR_EXP, contracts: 1, entryCredit: 2, costBasis: 300 };

  it('walks the horizons and reports weeks until a credit roll reaches the cost basis', () => {
    const chains = [
      { expiration: EXP_37, contracts: [call(270, 16.8, 17.2, EXP_37), call(275, 12.8, 13.2, EXP_37)] },
      { expiration: EXP_60, contracts: [call(275, 18.0, 18.4, EXP_60), call(280, 16.3, 16.7, EXP_60)] },
      { expiration: EXP_120, contracts: [call(290, 17.0, 17.4, EXP_120), call(300, 16.0, 16.4, EXP_120)] },
    ];
    const r = computeRollability(cc, 16, 30, 285, chains, NOW);
    expect(r.target).toBe(300);
    expect(r.targetKind).toBe('cost_basis');
    // +7: only the same strike rolls for a credit (mid 17 > 16); 275 is a debit.
    expect(r.horizons[0]).toMatchObject({ addedDte: 7, bestStrike: 270, strikesGained: 0, reachesTarget: false });
    // +30: $280 still a credit (mid 16.5) — two listed strikes gained (275, 280).
    expect(r.horizons[1]).toMatchObject({ addedDte: 30, bestStrike: 280, strikesGained: 2, reachesTarget: false });
    // +90: $300 at mid 16.2 reaches the basis.
    expect(r.horizons[2]).toMatchObject({ addedDte: 90, bestStrike: 300, reachesTarget: true });
    expect(r.horizons[2]!.netCreditPerShare).toBeCloseTo(0.2, 6);
    expect(r.weeksToTarget).toBe(12.9);
    expect(r.verdict).toBe('workable');
  });

  it('calls it a trap when nothing within a year reaches the target', () => {
    const chains = [
      { expiration: EXP_60, contracts: [call(275, 16.5, 16.9, EXP_60)] },
      { expiration: EXP_395, contracts: [call(290, 16.2, 16.6, EXP_395), call(300, 14.0, 14.4, EXP_395)] },
    ];
    const r = computeRollability(cc, 16, 30, 285, chains, NOW);
    expect(r.weeksToTarget).toBeNull();
    expect(r.horizons.at(-1)).toMatchObject({ bestStrike: 290, reachesTarget: false });
    expect(r.verdict).toBe('trap');
  });

  it('never counts a worse strike or a debit as a repair', () => {
    const chains = [{ expiration: EXP_60, contracts: [call(260, 30, 31, EXP_60), call(275, 15.0, 15.4, EXP_60)] }];
    const r = computeRollability(cc, 16, 30, 285, chains, NOW);
    // 260 is a big credit but a LOWER call strike; 275 is higher but a debit.
    expect(r.horizons[0]).toMatchObject({ bestStrike: null, improvement: null, strikesGained: 0 });
  });

  it('uses the underlying as a put\'s target and reports a strike already there', () => {
    const r = computeRollability({ ...input, strike: 260 }, 1.0, 30, 272, [], NOW);
    expect(r.targetKind).toBe('underlying');
    expect(r.atTarget).toBe(true);
    expect(r.weeksToTarget).toBe(0);
    expect(r.verdict).toBe('at_target');
  });

  it('rolls a put DOWN: the best strike is the lowest still rollable for a credit', () => {
    const chains = [{ expiration: EXP_37, contracts: [
      put(270, 4.4, 4.6, -0.5, EXP_37), put(265, 4.1, 4.3, -0.45, EXP_37), put(255, 3.0, 3.2, -0.3, EXP_37),
    ] }];
    const r = computeRollability(input, 4.0, 30, 260, chains, NOW);
    expect(r.horizons[0]).toMatchObject({ bestStrike: 265, strikesGained: 1, reachesTarget: false });
    expect(r.verdict).toBe('unknown'); // only +7 days listed — cannot see far enough to call a trap
  });

  it('says unknown, not trap, when there is no target at all', () => {
    const r = computeRollability(input, 4.0, 30, null, [], NOW);
    expect(r.target).toBeNull();
    expect(r.verdict).toBe('unknown');
  });
});

describe('pickRollabilityExpirations', () => {
  it('takes the listed expiry nearest each horizon, later than the current one, without duplicates', () => {
    const listed = [CUR_EXP, '2026-08-07', '2026-08-14', '2026-08-30', '2026-10-29', '2027-01-15', '2027-07-31'];
    const picked = pickRollabilityExpirations(listed, 30, NOW);
    expect(picked).toEqual(['2026-08-07', '2026-08-14', '2026-08-30', '2026-10-29', '2027-01-15', '2027-07-31']);
    expect(picked).not.toContain(CUR_EXP);
  });
});

describe('dteDays', () => {
  it('counts calendar days to the 16:00Z expiry', () => {
    expect(dteDays(EXP_60, NOW)).toBe(60);
    expect(dteDays(CUR_EXP, NOW)).toBe(30);
  });
});
