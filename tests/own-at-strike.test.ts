// The own-at-strike read replaces a check that was measurably incapable of failing, so these
// tests care most about the two things that made the old one useless: that it CAN come out
// negative, and that "we don't know" is never rendered as a pass.
//
// v1.1.188 merged a second axis in — the STRIKE against the 20-day low — so the four cells and,
// above all, the WITHDRAWAL of the "extended price" clause from the support-only cell are pinned
// here. That cell measured +3.46% mean / +5.49% median, the best of the four, while the old
// single-axis sentence called it an extended price with no discount.
//
// see docs/formulas.md#own-at-strike

import { describe, it, expect } from 'vitest';
import { readOwnAtStrike, ownAtStrikeNote, type PriceWindow } from '../src/shared/own-at-strike.js';

const W: PriceWindow = { sma200: 100, hi52: 140, lo52: 60, swingLow20: null };

describe('readOwnAtStrike', () => {
  it('reads a cost basis BELOW the long-run average as below, with its range position', () => {
    const r = readOwnAtStrike(90, 90, W)!;
    expect(r.atOrBelowSma200).toBe(true);
    expect(r.basisVsSma200Pct).toBeCloseTo(-10, 5);
    expect(r.rangePctile).toBeCloseTo(37.5, 5);   // (90 − 60) / (140 − 60)
    expect(r.costBasis).toBe(90);
  });

  // The whole point of replacing the conviction band: the old test fired on 0 of 39 picks
  // because a CSP strike (~0.93 × spot) could not reach a band anchored at ~1.13 × spot. This
  // one has to be able to say no.
  it('reads a cost basis ABOVE the long-run average as above — the check must be able to fail', () => {
    const r = readOwnAtStrike(115, 115, W)!;
    expect(r.atOrBelowSma200).toBe(false);
    expect(r.basisVsSma200Pct).toBeCloseTo(15, 5);
    expect(ownAtStrikeNote('AMD', r)).toContain('ABOVE its 200-day average');
    expect(ownAtStrikeNote('AMD', r)).toContain('extended price');
  });

  it('treats the boundary as satisfied — at the average is not above it', () => {
    expect(readOwnAtStrike(100, 100, W)!.atOrBelowSma200).toBe(true);
    expect(readOwnAtStrike(100.01, 100.01, W)!.atOrBelowSma200).toBe(false);
  });

  it('lets the range percentile fall outside 0–100 rather than clamping a real fact away', () => {
    expect(readOwnAtStrike(150, 150, W)!.rangePctile).toBeGreaterThan(100);   // above the 52w high
    expect(readOwnAtStrike(50, 50, W)!.rangePctile).toBeLessThan(0);         // below the 52w low
  });

  // Absent history must read as unknown, never as an all-clear — the same fail-closed reasoning
  // the earnings gate uses for an absent calendar row.
  it('returns null when there is no window, and says so in words', () => {
    expect(readOwnAtStrike(90, 90, undefined)).toBeNull();
    const note = ownAtStrikeNote('XYZ', null);
    expect(note).toContain('Not enough price history');
    expect(note).not.toContain('BELOW');
  });

  it('refuses a degenerate or non-finite average rather than dividing by it', () => {
    expect(readOwnAtStrike(90, 90, { sma200: 0, hi52: 1, lo52: 0, swingLow20: null })).toBeNull();
    expect(readOwnAtStrike(90, 90, { sma200: NaN, hi52: 1, lo52: 0, swingLow20: null })).toBeNull();
  });

  it('answers 50 for a flat range instead of dividing by zero', () => {
    expect(readOwnAtStrike(90, 90, { sma200: 100, hi52: 80, lo52: 80, swingLow20: null })!.rangePctile).toBe(50);
  });
});

describe('ownAtStrikeNote', () => {
  it('is phrased around assignment, and names the basis and both anchors', () => {
    const note = ownAtStrikeNote('NVDA', readOwnAtStrike(90, 90, W));
    expect(note).toContain('If assigned');
    expect(note).toContain('NVDA');
    expect(note).toContain('$90.00');
    expect(note).toContain('10.0% BELOW its 200-day average');
    expect(note).toContain('38th percentile');
  });

  it('gets English ordinals right, including the teens', () => {
    const at = (basis: number) => ownAtStrikeNote('T', readOwnAtStrike(basis, basis, { sma200: 1000, hi52: 100, lo52: 0, swingLow20: null }));
    expect(at(1)).toContain('1st percentile');
    expect(at(2)).toContain('2nd percentile');
    expect(at(3)).toContain('3rd percentile');
    expect(at(11)).toContain('11th percentile');
    expect(at(12)).toContain('12th percentile');
    expect(at(13)).toContain('13th percentile');
    expect(at(21)).toContain('21st percentile');
  });
});

// ── The four cells (v1.1.188) ─────────────────────────────────────────────────
// Numbers are real, from picks the replay scored:
//   A both        VKTX 2026-09-03  K=30   basis 27.55  SMA200 33.52   20d low 31.70
//   B long-run    GLW  2026-08-26  K=145  basis 137.75 SMA200 141.56  20d low 130.00
//   C support     SNOW 2026-09-02  K=280  basis 267.75 SMA200 218.03  20d low 303.89
//   D neither     MPC  2026-09-04  K=360  basis 349.30 SMA200 241.64  20d low 302.20
describe('ownAtStrikeNote — the two axes merged', () => {
  const cell = (strike: number, basis: number, sma200: number, swingLow20: number) =>
    ownAtStrikeNote('X', readOwnAtStrike(strike, basis, { sma200, hi52: 400, lo52: 60, swingLow20 }));

  const A = () => cell(30, 27.55, 33.52, 31.70);
  const B = () => cell(145, 137.75, 141.56, 130.00);
  const C = () => cell(280, 267.75, 218.03, 303.89);
  const D = () => cell(360, 349.30, 241.64, 302.20);

  it('joins agreeing readings with "and"', () => {
    expect(A()).toContain('BELOW its 200-day average');
    expect(A()).toContain('— and the $30 strike sits below its 20-day low of $31.70');
    expect(A()).toContain('a price it has not traded at in the last month');
    expect(D()).toContain('ABOVE its 200-day average');
    expect(D()).toContain('— and the $360 strike is above its 20-day low of $302.20');
  });

  it('joins conflicting readings with "but", in both directions', () => {
    expect(B()).toContain('BELOW its 200-day average');
    expect(B()).toContain('— but the $145 strike is above its 20-day low of $130.00');
    expect(C()).toContain('ABOVE its 200-day average');
    expect(C()).toContain('— but the $280 strike sits below its 20-day low of $303.89');
  });

  // THE POINT OF THE WHOLE CHANGE. Before v1.1.188 this clause fired on every basis above SMA200
  // — 166 of 250 stored brief picks (66%), which includes the support-only cell that returned
  // +3.46% mean / +5.49% median, the best of the four. It now fires only when BOTH axes agree.
  it('withdraws "extended price" from the support-only cell, and keeps it when both agree', () => {
    expect(C()).not.toContain('extended price');
    expect(C()).not.toContain('no recent floor');
    expect(D()).toContain('An extended price with no recent floor under it.');
    expect(A()).not.toContain('extended price');
    expect(B()).not.toContain('extended price');
  });

  // An axis we could not measure must never be the reason a caution disappears.
  it('falls back to the exact single-axis sentence when there is no support reading', () => {
    const note = ownAtStrikeNote('X', readOwnAtStrike(360, 349.30, { sma200: 241.64, hi52: 400, lo52: 60, swingLow20: null }));
    expect(note).toContain('That is an extended price, not a discount.');
    expect(note).not.toContain('20-day low');
  });

  it('reads the strike, not the basis, against support — the asymmetry the study measured', () => {
    // basis 99 is below the 100 low; the STRIKE 101 is not. The support half must say "above".
    const r = readOwnAtStrike(101, 99, { sma200: 200, hi52: 400, lo52: 60, swingLow20: 100 })!;
    expect(r.strikeBelowSwing).toBe(false);
    expect(ownAtStrikeNote('X', r)).toContain('$101 strike is above its 20-day low of $100.00');
  });

  it('reports an unmeasurable support axis as null, never as false', () => {
    const r = readOwnAtStrike(50, 48, { sma200: 100, hi52: 140, lo52: 60, swingLow20: null })!;
    expect(r.strikeBelowSwing).toBeNull();
    expect(r.swingLow20).toBeNull();
  });
});
