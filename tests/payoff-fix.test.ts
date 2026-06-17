// Tests for the Payoff "Fix" — narrows a credit spread's protective wing toward the short
// strike (keeping the short leg) until "credit ≥ ⅓ width" passes, re-priced from the chain.
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

describe('fixLegsForStrategy — Bull Put Spread', () => {
  // Short put $620 @ $20.00. Long put $590 ($30 wide) @ $10.60 → credit $9.40 < ⅓×30 ($10) ✗.
  // Put premiums rise toward the short (closer = pricier), so narrowing raises credit/width.
  const sp = leg({ id: 'sp', side: 'sell', type: 'put', strike: 620, premium: 20.00 });
  const bp = leg({ id: 'bp', side: 'buy',  type: 'put', strike: 590, premium: 10.60 });
  const chain: OptionContract[] = [
    ct('put', 590, 10.60), ct('put', 595, 11.40), ct('put', 600, 12.30),
    ct('put', 605, 13.40), ct('put', 610, 14.80), ct('put', 615, 16.60), ct('put', 620, 20.00),
  ];

  it('narrows the long put to the WIDEST strike that passes (least narrowing), short kept', () => {
    const fixed = fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], chain);
    expect(fixed).not.toBeNull();
    const legs = fixed!.legs;
    // short put unchanged
    expect(legs.find(l => l.id === 'sp')!.strike).toBe(620);
    const wing = legs.find(l => l.id === 'bp')!;
    // $605: width 15, credit 20−13.40 = 6.60 ≥ 5.00 ✓.  $600: width 20, credit 7.70 ≥ 6.67 ✓.
    // $595: width 25, credit 8.60 ≥ 8.33 ✓ (widest passing). $590 orig: 9.40 < 10 ✗.
    expect(wing.strike).toBe(595);
    expect(wing.premium).toBe(11.40); // re-priced at mid from the chain
  });

  it('returns null when the chain is absent', () => {
    expect(fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], undefined)).toBeNull();
    expect(fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], [])).toBeNull();
  });

  it('never moves the wing to or above the short strike', () => {
    const fixed = fixLegsForStrategy('Bull Put Spread (Short Put Vertical)', [sp, bp], chain);
    expect(fixed!.legs.find(l => l.id === 'bp')!.strike).toBeLessThan(620);
  });
});

describe('fixLegsForStrategy — Bear Call Spread', () => {
  // Short call $100 @ $6.00. Long call $130 ($30 wide) @ $0.40 → credit $5.60 < ⅓×30 ✗.
  const sc = leg({ id: 'sc', side: 'sell', type: 'call', strike: 100, premium: 6.00 });
  const bc = leg({ id: 'bc', side: 'buy',  type: 'call', strike: 130, premium: 0.40 });
  const chain: OptionContract[] = [
    ct('call', 100, 6.00), ct('call', 105, 3.80), ct('call', 110, 2.20),
    ct('call', 115, 1.20), ct('call', 120, 0.80), ct('call', 125, 0.55), ct('call', 130, 0.40),
  ];

  it('narrows the long call DOWN to the widest passing strike, short kept', () => {
    const fixed = fixLegsForStrategy('Bear Call Spread (Short Call Vertical)', [sc, bc], chain);
    expect(fixed).not.toBeNull();
    const legs = fixed!.legs;
    expect(legs.find(l => l.id === 'sc')!.strike).toBe(100); // short kept
    // $115: width 15, credit 6−1.20 = 4.80 ≥ 5.00? no. $110: width 10, credit 3.80 ≥ 3.33 ✓.
    // $115 fails (4.80<5.00); widest passing scanning down is $110.
    const wing = legs.find(l => l.id === 'bc')!;
    expect(wing.strike).toBe(110);
    expect(wing.premium).toBe(2.20);
  });
});

describe('fixLegsForStrategy — out of scope', () => {
  it('returns null for strategies without a wing-narrow fix', () => {
    const legs = [leg({ id: 'a', side: 'sell', type: 'put', strike: 100, premium: 2 })];
    expect(fixLegsForStrategy('Cash-Secured Put', legs, [ct('put', 100, 2)])).toBeNull();
    expect(fixLegsForStrategy('Iron Condor', legs, [ct('put', 100, 2)])).toBeNull();
  });
});
