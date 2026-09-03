// The own-at-strike read replaces a check that was measurably incapable of failing, so these
// tests care most about the two things that made the old one useless: that it CAN come out
// negative, and that "we don't know" is never rendered as a pass.
//
// see docs/formulas.md#own-at-strike

import { describe, it, expect } from 'vitest';
import { readOwnAtStrike, ownAtStrikeNote, type PriceWindow } from '../src/main/services/own-at-strike.js';

const W: PriceWindow = { sma200: 100, hi52: 140, lo52: 60 };

describe('readOwnAtStrike', () => {
  it('reads a cost basis BELOW the long-run average as below, with its range position', () => {
    const r = readOwnAtStrike(90, W)!;
    expect(r.atOrBelowSma200).toBe(true);
    expect(r.basisVsSma200Pct).toBeCloseTo(-10, 5);
    expect(r.rangePctile).toBeCloseTo(37.5, 5);   // (90 − 60) / (140 − 60)
    expect(r.costBasis).toBe(90);
  });

  // The whole point of replacing the conviction band: the old test fired on 0 of 39 picks
  // because a CSP strike (~0.93 × spot) could not reach a band anchored at ~1.13 × spot. This
  // one has to be able to say no.
  it('reads a cost basis ABOVE the long-run average as above — the check must be able to fail', () => {
    const r = readOwnAtStrike(115, W)!;
    expect(r.atOrBelowSma200).toBe(false);
    expect(r.basisVsSma200Pct).toBeCloseTo(15, 5);
    expect(ownAtStrikeNote('AMD', r)).toContain('ABOVE its 200-day average');
    expect(ownAtStrikeNote('AMD', r)).toContain('extended price');
  });

  it('treats the boundary as satisfied — at the average is not above it', () => {
    expect(readOwnAtStrike(100, W)!.atOrBelowSma200).toBe(true);
    expect(readOwnAtStrike(100.01, W)!.atOrBelowSma200).toBe(false);
  });

  it('lets the range percentile fall outside 0–100 rather than clamping a real fact away', () => {
    expect(readOwnAtStrike(150, W)!.rangePctile).toBeGreaterThan(100);   // above the 52w high
    expect(readOwnAtStrike(50, W)!.rangePctile).toBeLessThan(0);         // below the 52w low
  });

  // Absent history must read as unknown, never as an all-clear — the same fail-closed reasoning
  // the earnings gate uses for an absent calendar row.
  it('returns null when there is no window, and says so in words', () => {
    expect(readOwnAtStrike(90, undefined)).toBeNull();
    const note = ownAtStrikeNote('XYZ', null);
    expect(note).toContain('Not enough price history');
    expect(note).not.toContain('BELOW');
  });

  it('refuses a degenerate or non-finite average rather than dividing by it', () => {
    expect(readOwnAtStrike(90, { sma200: 0, hi52: 1, lo52: 0 })).toBeNull();
    expect(readOwnAtStrike(90, { sma200: NaN, hi52: 1, lo52: 0 })).toBeNull();
  });

  it('answers 50 for a flat range instead of dividing by zero', () => {
    expect(readOwnAtStrike(90, { sma200: 100, hi52: 80, lo52: 80 })!.rangePctile).toBe(50);
  });
});

describe('ownAtStrikeNote', () => {
  it('is phrased around assignment, and names the basis and both anchors', () => {
    const note = ownAtStrikeNote('NVDA', readOwnAtStrike(90, W));
    expect(note).toContain('If assigned');
    expect(note).toContain('NVDA');
    expect(note).toContain('$90.00');
    expect(note).toContain('10.0% BELOW its 200-day average');
    expect(note).toContain('38th percentile');
  });

  it('gets English ordinals right, including the teens', () => {
    const at = (basis: number) => ownAtStrikeNote('T', readOwnAtStrike(basis, { sma200: 1000, hi52: 100, lo52: 0 }));
    expect(at(1)).toContain('1st percentile');
    expect(at(2)).toContain('2nd percentile');
    expect(at(3)).toContain('3rd percentile');
    expect(at(11)).toContain('11th percentile');
    expect(at(12)).toContain('12th percentile');
    expect(at(13)).toContain('13th percentile');
    expect(at(21)).toContain('21st percentile');
  });
});
