import { describe, it, expect } from 'vitest';
import { buildScale, pathSegments, type PathPoint } from '../src/renderer/src/views/iv-path.js';

/**
 * The IV chart's geometry — 05 §4.6.
 *
 * **A chart that bridges a gap is the failure this tests for**, and it is the
 * kind that never announces itself: the line is smooth, the page looks right,
 * and it asserts a value on days when our own series explicitly said it could
 * not compute one (`insufficient_expirations`, `no_atm_quotes`). Those statuses
 * exist precisely so that a gap is a declared fact rather than something to be
 * smoothed over, and drawing across them throws that away at the last step.
 */

const BOX = { width: 100, height: 100, pad: { top: 0, right: 0, bottom: 0, left: 0 } };

function scaleOf(points: readonly PathPoint[]) {
  const s = buildScale(
    points.map((p) => p.date),
    points.flatMap((p) => (p.value === null ? [] : [p.value])),
    BOX
  );
  if (s === null) throw new Error('expected a scale');
  return s;
}

const day = (n: number): string => `2026-08-${String(n).padStart(2, '0')}`;

describe('pathSegments — a gap is never bridged', () => {
  it('breaks the line where a day has no value', () => {
    const points: PathPoint[] = [
      { date: day(1), value: 0.3 },
      { date: day(2), value: 0.32 },
      { date: day(3), value: null },
      { date: day(4), value: 0.35 },
      { date: day(5), value: 0.36 }
    ];

    const segs = pathSegments(points, scaleOf(points));

    // Two runs, not one. One path here would be a straight line drawn across
    // the 3rd — a value nobody measured, rendered identically to ones we did.
    expect(segs).toHaveLength(2);
    expect(segs.every((d) => d.startsWith('M'))).toBe(true);
    expect(segs.join(' ').match(/M/g)).toHaveLength(2);
  });

  it('emits one path when nothing is missing', () => {
    const points: PathPoint[] = [
      { date: day(1), value: 0.3 },
      { date: day(2), value: 0.31 },
      { date: day(3), value: 0.32 }
    ];
    expect(pathSegments(points, scaleOf(points))).toHaveLength(1);
  });

  it('emits nothing for an isolated value, because a point is not a line', () => {
    const points: PathPoint[] = [
      { date: day(1), value: null },
      { date: day(2), value: 0.3 },
      { date: day(3), value: null }
    ];
    // The view marks such days separately rather than drawing a segment that
    // would have to connect to something.
    expect(pathSegments(points, scaleOf(points))).toEqual([]);
  });

  it('emits nothing at all when the whole series is missing', () => {
    const points: PathPoint[] = [
      { date: day(1), value: null },
      { date: day(2), value: null }
    ];
    const s = buildScale(points.map((p) => p.date), [0.3], BOX);
    expect(pathSegments(points, s!)).toEqual([]);
  });

  it('handles a gap at each end without producing a stray segment', () => {
    const points: PathPoint[] = [
      { date: day(1), value: null },
      { date: day(2), value: 0.3 },
      { date: day(3), value: 0.31 },
      { date: day(4), value: null }
    ];
    expect(pathSegments(points, scaleOf(points))).toHaveLength(1);
  });
});

describe('buildScale', () => {
  it('maps the extremes to the box edges', () => {
    const s = buildScale([day(1), day(2), day(3)], [0.2, 0.4], BOX)!;
    expect(s.x(day(1))).toBe(0);
    expect(s.x(day(3))).toBe(100);
    expect(s.y(0.4)).toBe(0); // the maximum is at the top
    expect(s.y(0.2)).toBe(100);
  });

  it('renders a flat series instead of dividing by a zero span', () => {
    // Without the guard every point is NaN and the chart comes out blank —
    // which reads as missing data rather than as a constant, and those are
    // opposite facts.
    const s = buildScale([day(1), day(2)], [0.3, 0.3], BOX)!;
    expect(Number.isFinite(s.y(0.3))).toBe(true);
  });

  it('returns null rather than a broken scale when there is nothing to plot', () => {
    expect(buildScale([], [], BOX)).toBeNull();
    expect(buildScale([day(1)], [], BOX)).toBeNull();
  });
});
