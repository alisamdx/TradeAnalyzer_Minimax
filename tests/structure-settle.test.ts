// Tests for hold-to-expiry intrinsic settlement (used by the lizard-vs-spread backtest harness).
import { describe, it, expect } from 'vitest';
import { legIntrinsic, settleStructureAtExpiry } from '../src/shared/structure-settle.js';

describe('legIntrinsic', () => {
  it('is max(0, spot−strike) for calls, max(0, strike−spot) for puts', () => {
    expect(legIntrinsic('call', 100, 105)).toBe(5);
    expect(legIntrinsic('call', 100, 95)).toBe(0);
    expect(legIntrinsic('put', 100, 95)).toBe(5);
    expect(legIntrinsic('put', 100, 105)).toBe(0);
  });
});

describe('settleStructureAtExpiry', () => {
  // NVDA bull put spread from the stored sample: sell put 210 @4.65, buy put 200 @2.395.
  const spv = [
    { side: 'put', action: 'sell', strike: 210, mid: 4.65 },
    { side: 'put', action: 'buy',  strike: 200, mid: 2.395 },
  ] as const;

  it('keeps the full credit when both legs expire worthless (above the shorts)', () => {
    expect(settleStructureAtExpiry(spv, 225)).toBeCloseTo(225.5, 6); // net credit
  });

  it('realizes the defined max loss below the long strike', () => {
    expect(settleStructureAtExpiry(spv, 200)).toBeCloseTo(-774.5, 6);
    expect(settleStructureAtExpiry(spv, 190)).toBeCloseTo(-774.5, 6); // capped past the long
  });

  it('is ~0 at the breakeven', () => {
    expect(settleStructureAtExpiry(spv, 207.745)).toBeCloseTo(0, 4);
  });

  it('honours quantity and long-leg P&L', () => {
    const longCall = [{ side: 'call', action: 'buy', strike: 100, mid: 2, qty: 2 } as const];
    expect(settleStructureAtExpiry(longCall, 105)).toBeCloseTo((5 - 2) * 2 * 100, 6); // +600
    expect(settleStructureAtExpiry(longCall, 100)).toBeCloseTo((0 - 2) * 2 * 100, 6); // -400
  });
});
