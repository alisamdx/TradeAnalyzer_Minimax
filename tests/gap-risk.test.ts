import { describe, it, expect } from 'vitest';
import { computeGapRisk } from '../src/shared/gap-risk.js';

// Build n daily bars. `gapAt` maps bar index → an overnight gap fraction applied to that bar's open
// (open = prevClose * (1 + gap)); all other bars open flat at the prior close.
function bars(n: number, gapAt: Record<number, number> = {}, base = 100): { o: number; c: number; t: number }[] {
  const out: { o: number; c: number; t: number }[] = [];
  let prevClose = base;
  for (let i = 0; i < n; i++) {
    const gap = gapAt[i] ?? 0;
    const o = i === 0 ? prevClose : prevClose * (1 + gap);
    const c = o; // flat intraday → only overnight gaps drive the metric
    out.push({ o, c, t: i });
    prevClose = c;
  }
  return out;
}

describe('computeGapRisk', () => {
  it('returns null without enough bars', () => {
    expect(computeGapRisk(bars(40), 30)).toBeNull();
  });

  it('returns null when IV is missing or non-positive', () => {
    expect(computeGapRisk(bars(120), null)).toBeNull();
    expect(computeGapRisk(bars(120), 0)).toBeNull();
  });

  it('returns null with too few downside gaps', () => {
    // all-flat bars → zero downside gaps
    expect(computeGapRisk(bars(120), 30)).toBeNull();
  });

  it('scores >1 when the downside-gap tail exceeds the IV-implied daily move', () => {
    // 30% IV → implied daily move ≈ 30/√252 ≈ 1.89%. Seed 15 down-gaps of ~5% → P95 ≈ 5% ≫ 1.89%.
    const g: Record<number, number> = {};
    for (let i = 1; i <= 15; i++) g[i * 5] = -0.05;
    const r = computeGapRisk(bars(120, g), 30);
    expect(r).not.toBeNull();
    expect(r!.sampleDays).toBe(15);
    expect(r!.adverseGapP95Pct).toBeCloseTo(5, 1);
    expect(r!.ivDailyMovePct).toBeCloseTo(1.89, 1);
    expect(r!.score).toBeGreaterThan(2);
  });

  it('scores <1 when realized gaps are within what IV implies', () => {
    // 60% IV → implied daily ≈ 3.78%. Down-gaps of only ~1% → score well below 1.
    const g: Record<number, number> = {};
    for (let i = 1; i <= 15; i++) g[i * 5] = -0.01;
    const r = computeGapRisk(bars(120, g), 60);
    expect(r).not.toBeNull();
    expect(r!.score).toBeLessThan(1);
  });

  it('ignores upside gaps (downside-only)', () => {
    const up: Record<number, number> = {};
    for (let i = 1; i <= 15; i++) up[i * 5] = +0.05; // all upside
    expect(computeGapRisk(bars(120, up), 30)).toBeNull(); // no downside gaps → null
  });
});
