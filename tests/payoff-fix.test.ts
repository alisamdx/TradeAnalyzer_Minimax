// Tests for the Payoff "Fix" — narrows a credit structure's protective wing(s) toward the
// short strike(s) (keeping the shorts) until the credit-vs-width rule passes, re-priced from
// the chain. Verticals + lizards (single wing) and iron condors (two wings).
import { describe, it, expect } from 'vitest';
import { fixLegsForStrategy } from '../src/shared/payoff-fix.js';
import type { PayoffLeg, OptionContract } from '../src/shared/types.js';

function leg(p: Partial<PayoffLeg> & { id: string; side: 'buy' | 'sell'; type: 'call' | 'put'; strike: number; premium: number }): PayoffLeg {
  return { expiry: '2026-07-17', quantity: 1, delta: null, theta: null, vega: null, iv: null, label: '', ...p };
}
function ct(side: 'call' | 'put', strike: number, mid: number): OptionContract {
  return { ticker: 'X', expiration: '2026-07-17', strike, side, bid: mid - 0.1, ask: mid + 0.1,
    delta: null, gamma: null, theta: null, vega: null, iv: 30, openInterest: 1, volume: 1 };
}
const netCredit = (legs: PayoffLeg[]) => legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.premium, 0);
const strikeOf  = (legs: PayoffLeg[], id: string) => legs.find(l => l.id === id)!.strike;

describe('fixLegsForStrategy — Bull Put Spread (credit ≥ ⅓ width)', () => {
  const sp = leg({ id: 'sp', side: 'sell', type: 'put', strike: 620, premium: 20.00 });
  const bp = leg({ id: 'bp', side: 'buy',  type: 'put', strike: 590, premium: 10.60 });
  const chain: OptionContract[] = [
    ct('put', 590, 10.60), ct('put', 595, 11.40), ct('put', 600, 12.30),
    ct('put', 605, 13.40), ct('put', 610, 14.80), ct('put', 615, 16.60), ct('put', 620, 20.00),
  ];
  it('narrows the long put to the WIDEST passing strike, short kept, re-priced at mid', () => {
    const fixed = fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], chain);
    expect(fixed).not.toBeNull();
    expect(strikeOf(fixed!.legs, 'sp')).toBe(620);          // short unchanged
    expect(strikeOf(fixed!.legs, 'bp')).toBe(595);          // $25-wide passes (8.60 ≥ 8.33)
    expect(fixed!.legs.find(l => l.id === 'bp')!.premium).toBe(11.40);
  });
  it('returns null when the chain is absent', () => {
    expect(fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], undefined)).toBeNull();
    expect(fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], [])).toBeNull();
  });
  it('returns null when the spread already satisfies the rule', () => {
    const okBp = leg({ id: 'bp', side: 'buy', type: 'put', strike: 605, premium: 13.40 }); // $15 wide, 6.60 ≥ 5
    expect(fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, okBp], chain)).toBeNull();
  });
});

describe('fixLegsForStrategy — Bear Call Spread', () => {
  const sc = leg({ id: 'sc', side: 'sell', type: 'call', strike: 100, premium: 6.00 });
  const bc = leg({ id: 'bc', side: 'buy',  type: 'call', strike: 130, premium: 0.40 });
  const chain: OptionContract[] = [
    ct('call', 100, 6.00), ct('call', 105, 3.80), ct('call', 110, 2.20),
    ct('call', 115, 1.20), ct('call', 120, 0.80), ct('call', 125, 0.55), ct('call', 130, 0.40),
  ];
  it('narrows the long call DOWN to the widest passing strike, short kept', () => {
    const fixed = fixLegsForStrategy('Bear Call Spread (Short Call Vertical)', [sc, bc], chain);
    expect(fixed).not.toBeNull();
    expect(strikeOf(fixed!.legs, 'sc')).toBe(100);
    expect(strikeOf(fixed!.legs, 'bc')).toBe(110);          // $10 wide, 3.80 ≥ 3.33
  });
});

describe('fixLegsForStrategy — Jade Lizard (credit ≥ FULL call-spread width)', () => {
  const sp = leg({ id: 'sp', side: 'sell', type: 'put',  strike: 90,  premium: 3.00 });
  const sc = leg({ id: 'sc', side: 'sell', type: 'call', strike: 105, premium: 5.00 });
  const bc = leg({ id: 'bc', side: 'buy',  type: 'call', strike: 125, premium: 0.40 });
  const chain: OptionContract[] = [
    ct('call', 108, 3.20), ct('call', 110, 2.40), ct('call', 112, 1.80),
    ct('call', 115, 1.10), ct('call', 120, 0.60), ct('call', 125, 0.40),
  ];
  it('narrows the call wing so total credit ≥ call width; both shorts kept', () => {
    const fixed = fixLegsForStrategy('Jade Lizard', [sp, sc, bc], chain);
    expect(fixed).not.toBeNull();
    const legs = fixed!.legs;
    expect(strikeOf(legs, 'sp')).toBe(90);   // short put kept
    expect(strikeOf(legs, 'sc')).toBe(105);  // short call kept
    const callWidth = strikeOf(legs, 'bc') - 105;
    expect(netCredit(legs)).toBeGreaterThanOrEqual(callWidth); // the "no upside risk" rule now holds
  });
});

describe('fixLegsForStrategy — Reverse Big Lizard (credit ≥ FULL put-spread width)', () => {
  const sc = leg({ id: 'sc', side: 'sell', type: 'call', strike: 100, premium: 5.00 });
  const sp = leg({ id: 'sp', side: 'sell', type: 'put',  strike: 100, premium: 5.00 });
  const bp = leg({ id: 'bp', side: 'buy',  type: 'put',  strike: 80,  premium: 0.40 });
  const chain: OptionContract[] = [
    ct('put', 80, 0.40), ct('put', 85, 0.70), ct('put', 88, 1.10),
    ct('put', 90, 1.60), ct('put', 92, 2.20), ct('put', 95, 3.20),
  ];
  it('narrows the put wing UP so credit ≥ put width; shorts kept', () => {
    const fixed = fixLegsForStrategy('Reverse Big Lizard', [sc, sp, bp], chain);
    expect(fixed).not.toBeNull();
    const legs = fixed!.legs;
    expect(strikeOf(legs, 'sc')).toBe(100);
    expect(strikeOf(legs, 'sp')).toBe(100);
    const putWidth = 100 - strikeOf(legs, 'bp');
    expect(netCredit(legs)).toBeGreaterThanOrEqual(putWidth);
  });
});

describe('fixLegsForStrategy — Iron Condor (credit ≥ ⅓ × max width, two wings)', () => {
  const sp = leg({ id: 'sp', side: 'sell', type: 'put',  strike: 90,  premium: 4.00 });
  const bp = leg({ id: 'bp', side: 'buy',  type: 'put',  strike: 60,  premium: 0.30 });
  const sc = leg({ id: 'sc', side: 'sell', type: 'call', strike: 110, premium: 4.00 });
  const bc = leg({ id: 'bc', side: 'buy',  type: 'call', strike: 140, premium: 0.30 });
  const chain: OptionContract[] = [
    // puts rising toward the short ($90)
    ct('put', 60, 0.30), ct('put', 70, 0.60), ct('put', 75, 0.90), ct('put', 78, 1.20), ct('put', 80, 1.50),
    // calls rising toward the short ($110)
    ct('call', 140, 0.30), ct('call', 130, 0.60), ct('call', 125, 0.90), ct('call', 122, 1.20), ct('call', 120, 1.50),
  ];
  it('narrows both wings until credit ≥ ⅓ of the wider width; shorts kept', () => {
    const fixed = fixLegsForStrategy('Iron Condor', [sp, bp, sc, bc], chain);
    expect(fixed).not.toBeNull();
    const legs = fixed!.legs;
    expect(strikeOf(legs, 'sp')).toBe(90);
    expect(strikeOf(legs, 'sc')).toBe(110);
    const putW  = 90 - strikeOf(legs, 'bp');
    const callW = strikeOf(legs, 'bc') - 110;
    expect(strikeOf(legs, 'bp')).toBeGreaterThan(60); // narrowed in
    expect(strikeOf(legs, 'bc')).toBeLessThan(140);
    expect(netCredit(legs)).toBeGreaterThanOrEqual(Math.max(putW, callW) / 3);
  });
});

describe('fixLegsForStrategy — out of scope', () => {
  it('returns null for strategies without a wing-narrow fix', () => {
    const legs = [leg({ id: 'a', side: 'sell', type: 'put', strike: 100, premium: 2 })];
    expect(fixLegsForStrategy('Cash-Secured Put', legs, [ct('put', 100, 2)])).toBeNull();
    expect(fixLegsForStrategy('Short Strangle', legs, [ct('put', 100, 2)])).toBeNull();
  });
});
