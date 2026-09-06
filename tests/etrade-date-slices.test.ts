import { describe, it, expect } from 'vitest';
import { buildDateSlices } from '../src/main/services/etrade-portfolio-service.js';

/**
 * `buildDateSlices` — the transactions range walk.
 *
 * The bug this pins: the stride is `maxSpanDays + 1`, so a range whose length is
 * an exact multiple of that landed the walk on `cur === endMs` and emitted a
 * final window covering a single day on its own — one wasted round trip to an
 * endpoint that is intermittently unresponsive for ~120 s.
 *
 * It survived because the only test that touched it drove the real
 * `syncClosedPositions`, which builds its range from **today**. One calendar
 * configuration per run, so the suite could see the fault on roughly twelve days
 * a year and was green on the other ~353 — and on those twelve it went red for
 * reasons unrelated to whatever anyone had just changed, which is how a test
 * teaches people to ignore it. Sweeping every start date in a year costs
 * milliseconds and removes the dependence on the clock entirely.
 */

const DAY = 86_400_000;
const days = (a: string, b: string) =>
  (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY;

describe('buildDateSlices', () => {
  it('covers a range with no gaps, no overlap and no window wider than the limit', () => {
    const slices = buildDateSlices('2026-01-01', '2026-09-06');
    expect(slices[0]!.from).toBe('2026-01-01');
    expect(slices[slices.length - 1]!.to).toBe('2026-09-06');
    for (let i = 1; i < slices.length; i++) {
      expect(days(slices[i - 1]!.to, slices[i]!.from)).toBe(1); // contiguous, no gap
    }
    for (const s of slices) expect(days(s.from, s.to)).toBeLessThanOrEqual(31);
  });

  it('emits no zero-width tail on any start date across a full year — the actual regression', () => {
    // 2026-09-06 is day 248 from Jan 1 = 8 x 31, which is what broke.
    const offenders: string[] = [];
    for (let k = 0; k <= 400; k++) {
      const end = new Date(Date.parse('2026-01-01T00:00:00Z') + k * DAY).toISOString().slice(0, 10);
      const slices = buildDateSlices('2026-01-01', end);
      if (slices.length > 1 && slices.some((sl) => sl.from === sl.to)) offenders.push(end);
    }
    expect(offenders).toEqual([]);
  });

  it('still covers the final day when the tail is folded in', () => {
    const end = '2026-09-06'; // the multiple-of-31 case
    const slices = buildDateSlices('2026-01-01', end);
    expect(slices[slices.length - 1]!.to).toBe(end);
    expect(days(slices[slices.length - 1]!.from, slices[slices.length - 1]!.to)).toBe(31);
  });

  it('keeps a genuine one-day range as one window', () => {
    // A one-day window is a real interval, not a degenerate tail; only a tail
    // that has a predecessor to fold into is removed.
    expect(buildDateSlices('2026-01-01', '2026-01-01')).toEqual([
      { from: '2026-01-01', to: '2026-01-01' }
    ]);
  });

  it('returns nothing for an inverted or unparseable range rather than looping', () => {
    expect(buildDateSlices('2026-09-06', '2026-01-01')).toEqual([]);
    expect(buildDateSlices('not-a-date', '2026-01-01')).toEqual([]);
  });

  it('honours a narrower maxSpanDays', () => {
    const slices = buildDateSlices('2026-01-01', '2026-01-20', 5);
    for (const s of slices) expect(days(s.from, s.to)).toBeLessThanOrEqual(6);
    expect(slices[0]!.from).toBe('2026-01-01');
    expect(slices[slices.length - 1]!.to).toBe('2026-01-20');
  });
});
