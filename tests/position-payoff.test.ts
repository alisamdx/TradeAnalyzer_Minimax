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
    // raw greeks pass through unchanged (side sign is applied later by computePayoffMetrics)
    expect(l.delta).toBe(-0.29);
    expect(l.theta).toBe(-0.06);
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
