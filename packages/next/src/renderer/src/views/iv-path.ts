/**
 * The IV chart's geometry, kept as pure functions so it can be tested.
 *
 * Extracted from the view for one reason: **the rule that a gap must not be
 * bridged is the only thing on this screen that can be silently wrong.** A
 * chart that interpolates across a missing day looks completely normal — it is
 * a smooth line — and asserts a value nobody measured. Inside a component that
 * claim is only checkable by looking at it; out here it is checkable by a test.
 */

export interface PathPoint {
  readonly date: string;
  readonly value: number | null;
}

export interface Scale {
  x(date: string): number;
  y(v: number): number;
  readonly dates: readonly string[];
  readonly min: number;
  readonly max: number;
}

export interface Box {
  readonly width: number;
  readonly height: number;
  readonly pad: { top: number; right: number; bottom: number; left: number };
}

export function buildScale(
  dates: readonly string[],
  values: readonly number[],
  box: Box
): Scale | null {
  if (dates.length === 0 || values.length === 0) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series still has to render. Without this the span is zero and every
  // point divides by it, which puts the whole line at NaN — a blank chart that
  // looks like missing data rather than like a constant.
  const span = max - min || 0.01;
  const lastIndex = Math.max(1, dates.length - 1);

  return {
    dates,
    min,
    max,
    x: (date) => {
      const i = dates.indexOf(date);
      return box.pad.left + (i / lastIndex) * (box.width - box.pad.left - box.pad.right);
    },
    y: (v) =>
      box.pad.top + (1 - (v - min) / span) * (box.height - box.pad.top - box.pad.bottom)
  };
}

/**
 * One SVG path per **unbroken run** of values.
 *
 * Never one path with the nulls filtered out. That is the convenient
 * implementation and it draws a straight line across every gap, which is
 * indistinguishable on screen from days that were actually measured.
 *
 * A run of length one produces no path — a single point is not a line — so the
 * view marks isolated values separately rather than pretending they connect to
 * anything.
 */
export function pathSegments(points: readonly PathPoint[], s: Scale): string[] {
  const out: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 1) out.push(current.join(' '));
    current = [];
  };

  for (const p of points) {
    if (p.value === null) {
      flush();
      continue;
    }
    current.push(
      `${current.length === 0 ? 'M' : 'L'}${s.x(p.date).toFixed(1)},${s.y(p.value).toFixed(1)}`
    );
  }
  flush();
  return out;
}
