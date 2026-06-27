// Tests for the Daily Brief cross-strategy Conviction ranking + critic pass-filter
// (Ranked Grid feature). Conviction = Strategy-Lab structure score − critic penalty,
// the one ranking that IS comparable across strategies; the pass-filter gates both tabs.

import { describe, it, expect } from 'vitest';
import { convictionOf, rsiOf, passesFilter } from '../src/shared/brief-ranking.js';
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
