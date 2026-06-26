import { describe, it, expect } from 'vitest';
import { toPositionSignedGreeks, positionGreekSign } from '../src/shared/position-greeks.js';

describe('toPositionSignedGreeks — single source of truth for the stored sign convention', () => {
  it('negates raw contract greeks for short options (CSP) → bullish put: +δ/+θ/−ν', () => {
    // raw long-put greeks from E*Trade / chain
    expect(toPositionSignedGreeks('CSP', -0.30, -0.05, 0.10)).toEqual({ delta: 0.30, theta: 0.05, vega: -0.10 });
  });

  it('negates for short calls (CC)', () => {
    // raw long-call greeks
    expect(toPositionSignedGreeks('CC', 0.30, -0.05, 0.10)).toEqual({ delta: -0.30, theta: 0.05, vega: -0.10 });
  });

  it('keeps raw greeks for long options', () => {
    expect(toPositionSignedGreeks('Long Put', -0.30, -0.05, 0.10)).toEqual({ delta: -0.30, theta: -0.05, vega: 0.10 });
    expect(toPositionSignedGreeks('Long Call', 0.30, -0.05, 0.10)).toEqual({ delta: 0.30, theta: -0.05, vega: 0.10 });
  });

  it('passes nulls through', () => {
    expect(toPositionSignedGreeks('CSP', null, null, null)).toEqual({ delta: null, theta: null, vega: null });
  });

  it('sign helper: short = -1, long/stock = +1', () => {
    expect(positionGreekSign('CSP')).toBe(-1);
    expect(positionGreekSign('CC')).toBe(-1);
    expect(positionGreekSign('Long Put')).toBe(1);
    expect(positionGreekSign('Stock')).toBe(1);
  });
});
