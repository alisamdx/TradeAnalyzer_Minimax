// Tests for the Daily Brief cross-strategy Conviction ranking + critic pass-filter
// (Ranked Grid feature). Conviction = Strategy-Lab structure score − critic penalty,
// the one ranking that IS comparable across strategies; the pass-filter gates both tabs.

import { describe, it, expect } from 'vitest';
import { convictionOf, rsiOf, passesFilter, definedRiskAlternative } from '../src/shared/brief-ranking.js';
import type { BriefPick, CriticVerdict, ScoringStrategy } from '../src/shared/types.js';

// A minimal strategyLabResult whose top structure scores `totalScore`. pickDisplayStructure
// picks scores[0] when it's a relevant, available, defined-risk structure; a short put
// vertical (defined risk) is relevant to the bearish strategy.
function labResult(totalScore: number, slug = 'long-put-vertical') {
  return {
    scores: [
      {
        slug, name: slug, category: 'directional', totalScore,
        grade: totalScore >= 70 ? 'A' : totalScore >= 55 ? 'B' : 'C',
        ivScore: 0, directionScore: 0, premiumScore: 0, liquidityScore: 0,
        requiresStock: false, complexity: 'intermediate',
        flags: [], aiRationale: null,
        setup: { legs: [{ action: 'buy', side: 'put', strike: 100, expiration: '2026-07-17', qty: 1, mid: 1, bid: 0.9, ask: 1.1, delta: -0.3, iv: 30, openInterest: 500, volume: 100 }],
                 netDebit: 1, netCredit: null, expiration: '2026-07-17', unavailableReason: null },
      },
    ],
  };
}

function verdict(v: CriticVerdict['verdict'], degraded = false): CriticVerdict {
  return { verdict: v, degraded, confidence: 'high', rationale: '', flags: [] } as unknown as CriticVerdict;
}

function pick(over: Partial<BriefPick>): BriefPick {
  return {
    ticker: 'TST', compositeScore: 70, signals: {}, strategyLabResult: null,
    aiRationale: null, criticVerdict: null, rank: 1, validated: false, price: 100,
    ...over,
  } as BriefPick;
}

const BEARISH: ScoringStrategy = 'bearish';

describe('convictionOf', () => {
  it('is the lab structure score minus the critic penalty', () => {
    const lab = labResult(80);
    expect(convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('pass') }),    BEARISH)).toBe(80);
    expect(convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('caution') }), BEARISH)).toBe(65);
    expect(convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('flag') }),    BEARISH)).toBe(45);
  });

  it('ranks pass > caution > flag for the same structure score', () => {
    const lab = labResult(80);
    const p  = convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('pass') }),    BEARISH);
    const c  = convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('caution') }), BEARISH);
    const f  = convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('flag') }),    BEARISH);
    expect(p).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(f);
  });

  it('penalises a not-vetted pick (no verdict / degraded critic)', () => {
    const lab = labResult(80);
    expect(convictionOf(pick({ strategyLabResult: lab, criticVerdict: null }), BEARISH)).toBe(55);
    expect(convictionOf(pick({ strategyLabResult: lab, criticVerdict: verdict('pass', true) }), BEARISH)).toBe(55);
  });

  it('floors at 0 and is 0 when no structure is gradeable', () => {
    expect(convictionOf(pick({ strategyLabResult: null, criticVerdict: verdict('flag') }), BEARISH)).toBe(0);
    expect(convictionOf(pick({ strategyLabResult: labResult(10), criticVerdict: verdict('flag') }), BEARISH)).toBe(0);
  });
});

describe('rsiOf', () => {
  it('reads the raw RSI from an rsi signal', () => {
    expect(rsiOf(pick({ signals: { rsiMomentum: { raw: 58, missing: false, weight: 1, normalized: 0.5 } as never } }))).toBe(58);
    expect(rsiOf(pick({ signals: { rsiOverbought: { raw: 72, missing: false, weight: 1, normalized: 0.5 } as never } }))).toBe(72);
  });
  it('is null when the strategy does not score RSI', () => {
    expect(rsiOf(pick({ signals: { ivRank: { raw: 40, missing: false, weight: 1, normalized: 0.5 } as never } }))).toBeNull();
    expect(rsiOf(pick({ signals: { rsiMomentum: { raw: null, missing: true, weight: 1, normalized: 0 } as never } }))).toBeNull();
  });
});

describe('definedRiskAlternative', () => {
  // Bullish lab result: a Big Lizard (recommended, large tail) + a smaller-risk bull put spread.
  function bullishLab(opts: { spvLoss?: number; spvUnavail?: boolean; spvPop?: number | null } = {}) {
    const { spvLoss = -774.5, spvUnavail = false, spvPop = 71 } = opts;
    const leg = (action: string, strike: number, mid: number) => ({ action, side: 'put', strike, expiration: '2026-07-17', qty: 1, mid });
    return {
      scores: [
        { slug: 'big-lizard', name: 'Big Lizard', grade: 'A', totalScore: 84,
          setup: { legs: [leg('sell', 225, 10)], netCredit: 1800, netDebit: null, maxProfit: 1800, maxLoss: -34000, breakevens: [], expiration: '2026-07-17', popEstimate: 52, unavailableReason: null } },
        { slug: 'short-put-vertical', name: 'Short Put Vertical', grade: 'A+', totalScore: 82,
          setup: { legs: [leg('sell', 210, 4.65), leg('buy', 200, 2.395)], netCredit: 225.5, netDebit: null, maxProfit: 225.5, maxLoss: spvLoss, breakevens: [207.745], expiration: '2026-07-17', popEstimate: spvPop, unavailableReason: spvUnavail ? 'no chain' : null } },
      ],
    };
  }

  it('surfaces the smaller-risk bull put spread for a bullish pick', () => {
    const alt = definedRiskAlternative(pick({ strategyLabResult: bullishLab() }), 'bullish');
    expect(alt?.slug).toBe('short-put-vertical');
    expect(alt?.grade).toBe('A+');
    expect(alt?.popEstimate).toBe(71);
  });

  it('is null for non-bullish strategies', () => {
    expect(definedRiskAlternative(pick({ strategyLabResult: bullishLab() }), 'wheel')).toBeNull();
    expect(definedRiskAlternative(pick({ strategyLabResult: bullishLab() }), 'income')).toBeNull();
  });

  it('is null when the spread is not constructible', () => {
    expect(definedRiskAlternative(pick({ strategyLabResult: bullishLab({ spvUnavail: true }) }), 'bullish')).toBeNull();
  });

  it('is null when the spread is not actually smaller-risk', () => {
    expect(definedRiskAlternative(pick({ strategyLabResult: bullishLab({ spvLoss: -40000 }) }), 'bullish')).toBeNull();
  });

  it('is null when there is no lab result', () => {
    expect(definedRiskAlternative(pick({ strategyLabResult: null }), 'bullish')).toBeNull();
  });
});

describe('passesFilter', () => {
  const passPick    = pick({ criticVerdict: verdict('pass') });
  const cautionPick = pick({ criticVerdict: verdict('caution') });
  const flagPick    = pick({ criticVerdict: verdict('flag') });
  const degraded    = pick({ criticVerdict: verdict('pass', true) });
  const noVerdict   = pick({ criticVerdict: null });

  it('"all" keeps everything, including not-vetted', () => {
    for (const p of [passPick, cautionPick, flagPick, degraded, noVerdict]) {
      expect(passesFilter(p, 'all')).toBe(true);
    }
  });

  it('"pass-caution" keeps pass + caution, drops flag and not-vetted', () => {
    expect(passesFilter(passPick, 'pass-caution')).toBe(true);
    expect(passesFilter(cautionPick, 'pass-caution')).toBe(true);
    expect(passesFilter(flagPick, 'pass-caution')).toBe(false);
    expect(passesFilter(degraded, 'pass-caution')).toBe(false);
    expect(passesFilter(noVerdict, 'pass-caution')).toBe(false);
  });

  it('"pass" keeps only vetted passes', () => {
    expect(passesFilter(passPick, 'pass')).toBe(true);
    expect(passesFilter(cautionPick, 'pass')).toBe(false);
    expect(passesFilter(flagPick, 'pass')).toBe(false);
    expect(passesFilter(degraded, 'pass')).toBe(false);
    expect(passesFilter(noVerdict, 'pass')).toBe(false);
  });
});

// ── Level-2 (debit) vertical accessor ─────────────────────────────────────────
import { level2DebitAlternative } from '../src/shared/brief-ranking.js';
import type { Level2DebitVertical } from '../src/shared/types.js';

function l2(side: 'call' | 'put'): Level2DebitVertical {
  return {
    side, longStrike: 100, shortStrike: side === 'call' ? 110 : 90,
    longPremium: 8, shortPremium: 3, expiration: '2026-08-21', dte: 52,
    debitPerShare: 5, maxRisk: 500, maxProfit: 500,
    breakeven: side === 'call' ? 105 : 95,
    movePctToBreakeven: side === 'call' ? 5 : -5,
    underlyingPrice: 100, exceededBudget: false,
  };
}

describe('level2DebitAlternative', () => {
  const withAlts = (over: Record<string, unknown>) =>
    pick({ strategyLabResult: { scores: [], level2DebitAlts: { call: l2('call'), put: l2('put') }, ...over } as unknown as BriefPick['strategyLabResult'] });

  it('returns the call spread for bullish, put spread for bearish', () => {
    const p = withAlts({});
    expect(level2DebitAlternative(p, 'bullish')!.side).toBe('call');
    expect(level2DebitAlternative(p, 'bearish')!.side).toBe('put');
  });

  it('returns null for non-directional strategies', () => {
    const p = withAlts({});
    for (const s of ['buy', 'income', 'wheel', 'inflection'] as ScoringStrategy[]) {
      expect(level2DebitAlternative(p, s)).toBeNull();
    }
  });

  it('returns null when the lab result has no level2DebitAlts (older briefs)', () => {
    const p = pick({ strategyLabResult: { scores: [] } as unknown as BriefPick['strategyLabResult'] });
    expect(level2DebitAlternative(p, 'bullish')).toBeNull();
    expect(level2DebitAlternative(pick({}), 'bullish')).toBeNull();
  });

  it('returns null when the matching side is null', () => {
    const p = withAlts({ level2DebitAlts: { call: null, put: l2('put') } });
    expect(level2DebitAlternative(p, 'bullish')).toBeNull();
    expect(level2DebitAlternative(p, 'bearish')!.side).toBe('put');
  });
});
