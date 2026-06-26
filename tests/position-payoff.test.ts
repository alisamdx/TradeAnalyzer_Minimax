import { describe, it, expect } from 'vitest';
import { positionToPayoffLegs, type PositionLike } from '../src/shared/position-payoff.js';

function pos(over: Partial<PositionLike>): PositionLike {
  return {
    id: 1, positionType: 'CSP', quantity: 1, entryPrice: 4.32,
    strikePrice: 80, expirationDate: '2026-08-21',
    delta: -0.29, theta: -0.06, vega: 0.09, ...over,
  };
}

describe('positionToPayoffLegs', () => {
  it('reconstructs a CSP as a sold put at the exact strike / expiry / entry premium', () => {
    const legs = positionToPayoffLegs(pos({}))!;
    expect(legs).toHaveLength(1);
    const l = legs[0]!;
    expect(l).toMatchObject({ side: 'sell', type: 'put', strike: 80, expiry: '2026-08-21', premium: 4.32, quantity: 1 });
  });

  it('normalizes greeks to canonical raw (put δ<0, θ<0, ν>0) regardless of stored sign', () => {
    // raw-stored input (put delta negative)
    const raw = positionToPayoffLegs(pos({ delta: -0.29, theta: -0.06, vega: 0.09 }))![0]!;
    expect(raw.delta).toBe(-0.29); expect(raw.theta).toBe(-0.06); expect(raw.vega).toBe(0.09);
    // position-signed input (short put delta positive) → must normalize to the SAME raw signs,
    // so the Payoff engine's side flip yields the correct bullish position delta (not bearish).
    const signed = positionToPayoffLegs(pos({ delta: 0.27, theta: 0.066, vega: -0.117 }))![0]!;
    expect(signed.delta).toBe(-0.27); expect(signed.theta).toBe(-0.066); expect(signed.vega).toBe(0.117);
  });

  it('normalizes a call leg to canonical raw (call δ>0)', () => {
    const l = positionToPayoffLegs(pos({ positionType: 'CC', strikePrice: 95, delta: -0.3, theta: 0.05, vega: -0.1 }))![0]!;
    expect(l.delta).toBe(0.3); expect(l.theta).toBe(-0.05); expect(l.vega).toBe(0.1);
  });

  it('reconstructs a CC as a sold call', () => {
    const l = positionToPayoffLegs(pos({ positionType: 'CC', strikePrice: 95, delta: 0.3 }))![0]!;
    expect(l).toMatchObject({ side: 'sell', type: 'call', strike: 95 });
  });

  it('reconstructs Long Put / Long Call as bought options', () => {
    expect(positionToPayoffLegs(pos({ positionType: 'Long Put' }))![0]).toMatchObject({ side: 'buy', type: 'put' });
    expect(positionToPayoffLegs(pos({ positionType: 'Long Call', strikePrice: 100 }))![0]).toMatchObject({ side: 'buy', type: 'call' });
  });

  it('reconstructs Stock as a single stock leg using entry price', () => {
    const l = positionToPayoffLegs(pos({ positionType: 'Stock', entryPrice: 71.5, strikePrice: null, expirationDate: null }))![0]!;
    expect(l).toMatchObject({ type: 'stock', side: 'buy', premium: 71.5 });
  });

  it('carries the contract quantity (>=1)', () => {
    expect(positionToPayoffLegs(pos({ quantity: 3 }))![0]!.quantity).toBe(3);
    expect(positionToPayoffLegs(pos({ quantity: 0 }))![0]!.quantity).toBe(1); // floor at 1
  });

  it('returns undefined for an option position missing strike or expiry', () => {
    expect(positionToPayoffLegs(pos({ strikePrice: null }))).toBeUndefined();
    expect(positionToPayoffLegs(pos({ expirationDate: null }))).toBeUndefined();
  });
});
