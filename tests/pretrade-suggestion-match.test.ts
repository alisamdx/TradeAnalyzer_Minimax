import { describe, it, expect } from 'vitest';
import { suggestionMatchesInput } from '../src/main/services/pretrade-validator-service.js';
import type { PayoffLeg, PretradeSuggestion } from '../src/shared/types.js';

function pLeg(side: 'buy' | 'sell', type: 'put' | 'call', strike: number): PayoffLeg {
  return { id: 'x', side, type, strike, expiry: '2026-08-21', premium: 1, quantity: 1, delta: null, theta: null, vega: null, iv: null, label: '' };
}
function sug(legs: { action: 'buy' | 'sell'; side: 'call' | 'put'; strike: number }[]): PretradeSuggestion {
  return { slug: 's', name: 'n', grade: 'C', rationale: '', legs: legs.map(l => ({ ...l, expiration: '2026-08-21', qty: 1 })),
    netCredit: null, netDebit: null, maxProfit: null, maxLoss: null, breakevens: [], annualizedReturn: null };
}

describe('suggestionMatchesInput', () => {
  it('matches a CSP suggestion to the held CSP (same leg)', () => {
    expect(suggestionMatchesInput([pLeg('sell', 'put', 185)], sug([{ action: 'sell', side: 'put', strike: 185 }]))).toBe(true);
  });
  it('does not match a different strike', () => {
    expect(suggestionMatchesInput([pLeg('sell', 'put', 185)], sug([{ action: 'sell', side: 'put', strike: 180 }]))).toBe(false);
  });
  it('does not match a different structure (vertical vs naked put)', () => {
    expect(suggestionMatchesInput([pLeg('sell', 'put', 185)], sug([{ action: 'sell', side: 'put', strike: 185 }, { action: 'buy', side: 'put', strike: 175 }]))).toBe(false);
  });
  it('matches a 2-leg spread regardless of leg order', () => {
    const input = [pLeg('buy', 'put', 175), pLeg('sell', 'put', 185)];
    const s = sug([{ action: 'sell', side: 'put', strike: 185 }, { action: 'buy', side: 'put', strike: 175 }]);
    expect(suggestionMatchesInput(input, s)).toBe(true);
  });
  it('ignores stock legs and returns false when no option legs', () => {
    expect(suggestionMatchesInput([pLeg('buy', 'put', 0)].map(l => ({ ...l, type: 'stock' as const })), sug([{ action: 'sell', side: 'put', strike: 185 }]))).toBe(false);
  });
});
