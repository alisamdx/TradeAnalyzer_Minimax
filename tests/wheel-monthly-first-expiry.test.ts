// Wheel expiry selection — monthly-first (WHEEL_MONTHLY_FIRST_EXPIRY, default OFF).
//
// findSuitableChain walks expirations in ascending date order and returns the FIRST delta-band
// match, so the earliest qualifying expiry — structurally a WEEKLY — always wins, and the
// [30,45] DTE window is narrower than the ~30-day monthly cycle so a 3rd Friday is often out of
// range entirely. The measured contract then carries 1–2 orders of magnitude less open interest
// than the monthly at the same delta (2026-08-05, Sep-4 weekly vs Sep-18 monthly: PG 7 vs 4,063;
// WMT 109 vs 13,824), which is why optionLiquidityScore reads 0/10 across most of the universe.
//
// These tests pin the pure ordering/window helpers and, critically, that the DEFAULT path is
// unchanged — the flag is FR-SEY-5-gated and must stay inert until validated.
import { describe, it, expect, afterEach } from 'vitest';
import {
  isMonthlyExpiration,
  wheelExpirationOrder,
  wheelDteWindow,
  wheelMonthlyFirstEnabled,
} from '../src/main/services/analysis-service.js';

const ORIGINAL = process.env['WHEEL_MONTHLY_FIRST'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['WHEEL_MONTHLY_FIRST'];
  else process.env['WHEEL_MONTHLY_FIRST'] = ORIGINAL;
});

describe('isMonthlyExpiration', () => {
  it('identifies 3rd Fridays', () => {
    expect(isMonthlyExpiration('2026-09-18')).toBe(true);  // Sep 2026 monthly
    expect(isMonthlyExpiration('2026-08-21')).toBe(true);  // Aug 2026 monthly
    expect(isMonthlyExpiration('2026-10-16')).toBe(true);
  });

  it('rejects weeklies, including the 1st/2nd/4th Fridays', () => {
    expect(isMonthlyExpiration('2026-09-04')).toBe(false); // 1st Friday
    expect(isMonthlyExpiration('2026-09-11')).toBe(false); // 2nd Friday
    expect(isMonthlyExpiration('2026-09-25')).toBe(false); // 4th Friday
  });

  it('rejects a non-Friday and malformed input', () => {
    expect(isMonthlyExpiration('2026-09-17')).toBe(false); // Thursday
    expect(isMonthlyExpiration('')).toBe(false);
  });

  it('is stable regardless of local timezone (all-UTC math)', () => {
    // Guards the CLAUDE.md quirk: mixing local weekday math with toISOString() shifts every
    // date to Saturday on evening runs.
    const tz = process.env['TZ'];
    try {
      process.env['TZ'] = 'Pacific/Kiritimati'; // UTC+14
      expect(isMonthlyExpiration('2026-09-18')).toBe(true);
      process.env['TZ'] = 'Pacific/Midway';     // UTC-11
      expect(isMonthlyExpiration('2026-09-18')).toBe(true);
    } finally {
      if (tz === undefined) delete process.env['TZ']; else process.env['TZ'] = tz;
    }
  });
});

describe('wheelExpirationOrder', () => {
  // The real 2026-08-03 candidate set that produced the defect.
  const fridays = ['2026-08-07', '2026-08-14', '2026-08-21', '2026-08-28',
                   '2026-09-04', '2026-09-11', '2026-09-18'];

  it('DEFAULT is ascending by date — unchanged behavior (the shipped path)', () => {
    expect(wheelExpirationOrder(fridays, false)).toEqual(fridays);
  });

  it('monthly-first puts 3rd Fridays ahead of nearer weeklies', () => {
    const ordered = wheelExpirationOrder(fridays, true);
    expect(ordered.slice(0, 2)).toEqual(['2026-08-21', '2026-09-18']); // the two monthlies
    expect(ordered.slice(2)).toEqual(['2026-08-07', '2026-08-14', '2026-08-28',
                                      '2026-09-04', '2026-09-11']);
    expect([...ordered].sort()).toEqual([...fridays].sort());          // nothing lost or added
  });

  it('sorts unsorted input in both modes', () => {
    const shuffled = ['2026-09-18', '2026-08-07', '2026-09-04'];
    expect(wheelExpirationOrder(shuffled, false)).toEqual(['2026-08-07', '2026-09-04', '2026-09-18']);
    expect(wheelExpirationOrder(shuffled, true)).toEqual(['2026-09-18', '2026-08-07', '2026-09-04']);
  });

  it('handles a set with no monthly, and an empty set', () => {
    const weekliesOnly = ['2026-09-04', '2026-09-11'];
    expect(wheelExpirationOrder(weekliesOnly, true)).toEqual(weekliesOnly);
    expect(wheelExpirationOrder([], true)).toEqual([]);
  });
});

describe('wheelDteWindow', () => {
  it('is 30–45 by default', () => {
    expect(wheelDteWindow(false)).toEqual({ minDTE: 30, maxDTE: 45 });
  });

  it('widens to 28–52 when monthly-first is on, covering the 46-DTE case that triggered this', () => {
    // From 2026-08-03 the Sep-18 monthly sat at 46 DTE — clipped by ONE day under the old cap.
    expect(wheelDteWindow(true)).toEqual({ minDTE: 28, maxDTE: 52 });
    const { minDTE, maxDTE } = wheelDteWindow(true);
    expect(46).toBeGreaterThanOrEqual(minDTE);
    expect(46).toBeLessThanOrEqual(maxDTE);
    expect(wheelDteWindow(false).maxDTE).toBeLessThan(46); // old window excluded it
  });

  it('does NOT claim to always reach a monthly — that needs a ~35-day window', () => {
    // Consecutive 3rd Fridays are 28–35 days apart, so a guarantee requires width >= 35 (e.g.
    // [28,63]), and a 63-DTE CSP is outside the wheel's tenor. [28,52] is a deliberate
    // compromise: wider coverage, weekly fallback on the rest. Pinned so nobody "fixes" the
    // window to a guarantee without reconsidering the tenor.
    const { minDTE, maxDTE } = wheelDteWindow(true);
    const width = maxDTE - minDTE + 1;
    expect(width).toBeGreaterThan(wheelDteWindow(false).maxDTE - wheelDteWindow(false).minDTE + 1);
    expect(width).toBeLessThan(35);
  });
});

describe('wheelMonthlyFirstEnabled', () => {
  it('is OFF by default — FR-SEY-5 gate, must stay inert until validated', () => {
    delete process.env['WHEEL_MONTHLY_FIRST'];
    expect(wheelMonthlyFirstEnabled()).toBe(false);
    expect(wheelDteWindow()).toEqual({ minDTE: 30, maxDTE: 45 });
  });

  it('WHEEL_MONTHLY_FIRST=1 turns it on for a validation run', () => {
    process.env['WHEEL_MONTHLY_FIRST'] = '1';
    expect(wheelMonthlyFirstEnabled()).toBe(true);
    expect(wheelDteWindow()).toEqual({ minDTE: 28, maxDTE: 52 });
  });

  it('ignores any other value', () => {
    process.env['WHEEL_MONTHLY_FIRST'] = 'true';
    expect(wheelMonthlyFirstEnabled()).toBe(false);
  });
});
