import { describe, it, expect } from 'vitest';
import { buildRollCandidates, scoreByMetric, recommendAction, dteDays } from '../src/main/services/roll-analyzer-service.js';
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

describe('dteDays', () => {
  it('counts calendar days to the 16:00Z expiry', () => {
    expect(dteDays(EXP_60, NOW)).toBe(60);
    expect(dteDays(CUR_EXP, NOW)).toBe(30);
  });
});
