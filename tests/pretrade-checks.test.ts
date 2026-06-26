import { describe, it, expect } from 'vitest';
import {
  runPretradeChecks,
  rollUpVerdict,
  pickSuggestedStructure,
  type PretradeCheckInput,
} from '../src/main/services/pretrade-checks.js';
import type {
  PayoffLeg, PretradeIntent, PretradeMarketContext, StrategyScore, StrategySetup,
} from '../src/shared/types.js';

const NOW = new Date('2026-06-25T15:00:00Z').getTime();
const EXP = '2026-07-24'; // ~29 DTE from NOW

function leg(over: Partial<PayoffLeg>): PayoffLeg {
  return {
    id: Math.random().toString(36).slice(2), side: 'sell', type: 'put', strike: 95,
    expiry: EXP, premium: 2, quantity: 1, delta: -0.3, theta: 0.05, vega: -0.1, iv: 30, label: '',
    ...over,
  };
}

function ctx(over: Partial<PretradeMarketContext> = {}): PretradeMarketContext {
  return {
    ivRank: 50, ivPercentile: 50, currentAtmIv: 30, directionBias: 'neutral',
    ma20: 100, ma50: 100, atrPct: 2, nextEarningsDate: null, ...over,
  };
}

function intent(over: Partial<PretradeIntent> = {}): PretradeIntent {
  return { happyToOwn: null, purpose: 'income', multiQuarterThesis: false, ...over };
}

function input(over: Partial<PretradeCheckInput>): PretradeCheckInput {
  return {
    legs: [leg({})], spot: 100,
    metrics: {
      maxProfit: 200, maxLoss: -9300, unlimitedProfit: false, unlimitedLoss: false,
      breakevenPrices: [93], netPremium: 200, netDelta: 0.3, netTheta: 5, netVega: -10,
    },
    context: ctx(), intent: intent(), now: NOW,
    ...over,
  };
}

const byKey = (cs: ReturnType<typeof runPretradeChecks>, k: string) => cs.find(c => c.key === k);

describe('runPretradeChecks — reward/risk', () => {
  it('does NOT flag a cash-secured put on reward/risk (huge structural max loss)', () => {
    const checks = runPretradeChecks(input({})); // single short put, no long leg
    expect(byKey(checks, 'reward_risk')).toBeUndefined();
  });

  it('fails a defined-risk spread with catastrophic reward/risk', () => {
    const legs = [leg({ side: 'sell', strike: 95 }), leg({ side: 'buy', strike: 70 })];
    const checks = runPretradeChecks(input({
      legs,
      metrics: { maxProfit: 11, maxLoss: -239, unlimitedProfit: false, unlimitedLoss: false, breakevenPrices: [94.9], netPremium: 11, netDelta: 0.2, netTheta: 1, netVega: -1 },
    }));
    expect(byKey(checks, 'reward_risk')?.status).toBe('fail');
  });

  it('passes a defined-risk spread with healthy reward/risk', () => {
    const legs = [leg({ side: 'sell', strike: 95 }), leg({ side: 'buy', strike: 90 })];
    const checks = runPretradeChecks(input({
      legs,
      metrics: { maxProfit: 150, maxLoss: -350, unlimitedProfit: false, unlimitedLoss: false, breakevenPrices: [93.5], netPremium: 150, netDelta: 0.2, netTheta: 1, netVega: -1 },
    }));
    expect(byKey(checks, 'reward_risk')?.status).toBe('pass');
  });

  it('warns on undefined risk (uncovered short)', () => {
    const checks = runPretradeChecks(input({
      legs: [leg({ side: 'sell', type: 'call', strike: 105 })],
      metrics: { maxProfit: 200, maxLoss: null, unlimitedProfit: false, unlimitedLoss: true, breakevenPrices: [107], netPremium: 200, netDelta: -0.3, netTheta: 5, netVega: -10 },
    }));
    expect(byKey(checks, 'undefined_risk')?.status).toBe('warn');
  });
});

describe('runPretradeChecks — IV regime', () => {
  it('warns when selling premium into low IV rank for an income trade', () => {
    const checks = runPretradeChecks(input({ context: ctx({ ivRank: 25 }), intent: intent({ purpose: 'income' }) }));
    expect(byKey(checks, 'iv_regime')?.status).toBe('warn');
    expect(byKey(checks, 'iv_regime')?.title).toMatch(/cheap/i);
  });
  it('downgrades cheap-vol to info when premium is secondary (ownership / happy-to-own)', () => {
    const owns = runPretradeChecks(input({ context: ctx({ ivRank: 25 }), intent: intent({ purpose: 'ownership' }) }));
    expect(byKey(owns, 'iv_regime')?.status).toBe('info');
    const happy = runPretradeChecks(input({ context: ctx({ ivRank: 25 }), intent: intent({ purpose: 'income', happyToOwn: true }) }));
    expect(byKey(happy, 'iv_regime')?.status).toBe('info');
  });
  it('warns when buying premium into high IV rank', () => {
    const checks = runPretradeChecks(input({
      context: ctx({ ivRank: 75 }),
      metrics: { maxProfit: 500, maxLoss: -200, unlimitedProfit: false, unlimitedLoss: false, breakevenPrices: [], netPremium: -200, netDelta: 0.4, netTheta: -5, netVega: 10 },
    }));
    expect(byKey(checks, 'iv_regime')?.status).toBe('warn');
    expect(byKey(checks, 'iv_regime')?.title).toMatch(/expensive/i);
  });
  it('passes selling premium into adequate IV rank', () => {
    expect(byKey(runPretradeChecks(input({ context: ctx({ ivRank: 55 }) })), 'iv_regime')?.status).toBe('pass');
  });
});

describe('runPretradeChecks — direction vs trend', () => {
  it('warns when a bullish structure fades a bearish trend (no ownership intent)', () => {
    const checks = runPretradeChecks(input({ context: ctx({ directionBias: 'bearish' }), metrics: { ...input({}).metrics, netDelta: 0.4 } }));
    expect(byKey(checks, 'direction_fit')?.status).toBe('warn');
  });
  it('downgrades to info when the fade is a deliberate ownership stance', () => {
    const checks = runPretradeChecks(input({ context: ctx({ directionBias: 'bearish' }), intent: intent({ happyToOwn: true, purpose: 'ownership' }), metrics: { ...input({}).metrics, netDelta: 0.4 } }));
    expect(byKey(checks, 'direction_fit')?.status).toBe('info');
  });
});

describe('runPretradeChecks — earnings window', () => {
  it('warns when earnings fall before expiry and not happy to own', () => {
    const checks = runPretradeChecks(input({ context: ctx({ nextEarningsDate: '2026-07-15' }) }));
    expect(byKey(checks, 'earnings_window')?.status).toBe('warn');
  });
  it('downgrades to info when happy to own at the strike', () => {
    const checks = runPretradeChecks(input({ context: ctx({ nextEarningsDate: '2026-07-15' }), intent: intent({ happyToOwn: true }) }));
    expect(byKey(checks, 'earnings_window')?.status).toBe('info');
  });
  it('does not flag when earnings are after expiry', () => {
    expect(byKey(runPretradeChecks(input({ context: ctx({ nextEarningsDate: '2026-08-25' }) })), 'earnings_window')).toBeUndefined();
  });
});

describe('runPretradeChecks — cushion vs volatility', () => {
  it('warns on a thin cushion relative to ATR', () => {
    // short put 98, spot 100 → 2% cushion; ATR 4% → need 6% → thin
    const checks = runPretradeChecks(input({ legs: [leg({ strike: 98 })], context: ctx({ atrPct: 4 }) }));
    expect(byKey(checks, 'cushion')?.status).toBe('warn');
  });
  it('passes a comfortable cushion', () => {
    // short put 88, spot 100 → 12% cushion; ATR 4% → need 6% → ok
    const checks = runPretradeChecks(input({ legs: [leg({ strike: 88 })], context: ctx({ atrPct: 4 }) }));
    expect(byKey(checks, 'cushion')?.status).toBe('pass');
  });
  it('warns when the short strike is ITM', () => {
    const checks = runPretradeChecks(input({ legs: [leg({ strike: 110 })], spot: 100 }));
    expect(byKey(checks, 'cushion')?.status).toBe('warn');
    expect(byKey(checks, 'cushion')?.title).toMatch(/in-the-money/i);
  });
});

describe('runPretradeChecks — horizon match', () => {
  it('warns when a multi-quarter thesis uses a short-dated structure', () => {
    const checks = runPretradeChecks(input({ intent: intent({ multiQuarterThesis: true }) })); // ~29 DTE
    expect(byKey(checks, 'horizon_match')?.status).toBe('warn');
  });
  it('does not warn for a by-expiry thesis', () => {
    expect(byKey(runPretradeChecks(input({ intent: intent({ multiQuarterThesis: false }) })), 'horizon_match')).toBeUndefined();
  });
});

describe('rollUpVerdict', () => {
  it('maps fail → bad, warn → caution, else good', () => {
    expect(rollUpVerdict([{ key: 'a', status: 'pass', title: '', detail: '' }])).toBe('good');
    expect(rollUpVerdict([{ key: 'a', status: 'warn', title: '', detail: '' }])).toBe('caution');
    expect(rollUpVerdict([{ key: 'a', status: 'fail', title: '', detail: '' }, { key: 'b', status: 'warn', title: '', detail: '' }])).toBe('bad');
    expect(rollUpVerdict([{ key: 'a', status: 'info', title: '', detail: '' }])).toBe('good');
  });
});

describe('pickSuggestedStructure', () => {
  function setup(over: Partial<StrategySetup>): StrategySetup {
    return {
      slug: 'x', ticker: 'T', expiration: EXP, dte: 29, underlyingPrice: 100,
      legs: [{ action: 'sell', side: 'put', strike: 95, expiration: EXP, delta: -0.3, gamma: 0, theta: 0, vega: 0, bid: 1, ask: 1.2, mid: 1.1, iv: 30, openInterest: 100, volume: 10, qty: 1 }],
      netCredit: 150, netDebit: null, maxProfit: 150, maxLoss: -350, breakevens: [93.5],
      annualizedReturn: 40, popEstimate: 70, currentAtmIv: 30, unavailableReason: null, ...over,
    };
  }
  function score(over: Partial<StrategyScore>): StrategyScore {
    return {
      slug: 'short-put-vertical', name: 'Short Put Vertical', category: 'bullish', totalScore: 80, grade: 'A',
      ivScore: 20, directionScore: 20, premiumScore: 20, liquidityScore: 12, requiresStock: false,
      complexity: 'moderate', flags: [], aiRationale: null, setup: setup({}), ...over,
    };
  }

  it('returns null when no valid setups exist', () => {
    expect(pickSuggestedStructure([score({ setup: null })], { happyToOwn: null, purpose: 'income', multiQuarterThesis: false }, 50)).toBeNull();
  });

  it('picks a credit structure for income intent and notes low IV', () => {
    const s = pickSuggestedStructure([score({})], { happyToOwn: null, purpose: 'income', multiQuarterThesis: false }, 22);
    expect(s).not.toBeNull();
    expect(s!.netCredit).toBeGreaterThan(0);
    expect(s!.rationale).toMatch(/cheap|waiting|higher IV/i);
  });

  it('prefers the higher grade within the intent-matched pool', () => {
    const lowGrade = score({ slug: 'short-put-vertical', grade: 'C', totalScore: 60 });
    const highGrade = score({ slug: 'short-naked-put', grade: 'A+', totalScore: 92 });
    const s = pickSuggestedStructure([lowGrade, highGrade], { happyToOwn: true, purpose: 'ownership', multiQuarterThesis: false }, 55);
    expect(s!.grade).toBe('A+');
  });
});
