import { describe, it, expect } from 'vitest';
import { handoffLegsFor } from '../src/main/services/legacy-handoff-legs';
import type { SetupLeg } from '../src/shared/types';

function leg(over: Partial<SetupLeg>): SetupLeg {
  return {
    action: 'sell', side: 'call', strike: 100, expiration: '2026-10-30',
    delta: 0.3, gamma: null, theta: null, vega: null,
    bid: 1, ask: 1.2, mid: 1.1, iv: 50.1, openInterest: 10, volume: 5, qty: 1,
    ...over,
  };
}

describe('handoffLegsFor', () => {
  // Regression, 2026-09-29: a CRWD far-dated 237.5 call was pinned on the 10-30 weekly, where E*Trade
  // never listed that strike (it exists on the 10-16/11-20 monthlies), and QC-409 fired nightly.
  it("builds each leg's OSI symbol from the leg's own expiration, not the setup's", () => {
    const legs = handoffLegsFor('CRWD', {
      expiration: '2026-10-30',
      legs: [
        leg({ action: 'sell', strike: 260, expiration: '2026-10-30' }),
        leg({ action: 'buy', strike: 237.5, expiration: '2026-11-20' }),
      ],
    }, 9);
    expect(legs.map((l) => l.osiSymbol)).toEqual(['CRWD--261030C00260000', 'CRWD--261120C00237500']);
    expect(legs.map((l) => l.expiration)).toEqual(['2026-10-30', '2026-11-20']);
  });

  it("falls back to the setup's expiration only when the leg has none", () => {
    const legs = handoffLegsFor('AAPL', { expiration: '2026-10-16', legs: [leg({ expiration: '' })] }, null);
    expect(legs[0]?.osiSymbol).toBe('AAPL--261016C00100000');
  });

  it('skips a leg with no expiration anywhere rather than guessing one', () => {
    expect(handoffLegsFor('AAPL', { expiration: null, legs: [leg({ expiration: '' })] }, null)).toEqual([]);
  });

  // Regression: the lab holds IV as a percentage; the hand-off contract is a fraction. Stored rows
  // read 5.0–118.5 in a column declared fraction until v1.1.347.
  it('converts the lab percentage IV to a fraction exactly once', () => {
    const [l] = handoffLegsFor('AAPL', { expiration: '2026-10-16', legs: [leg({ iv: 50.1 })] }, null);
    expect(l?.iv).toBeCloseTo(0.501, 10);
  });

  it('keeps an unreported volume distinguishable from zero', () => {
    const [a, b] = handoffLegsFor('AAPL', {
      expiration: '2026-10-16',
      legs: [leg({ volume: null }), leg({ strike: 105, volume: 0 })],
    }, null);
    expect(a?.volumeReported).toBe(false);
    expect(b?.volumeReported).toBe(true);
  });
});
