// Quality checks over the bull put spread's own captured chains (v1.1.297).
//
// WHY. The 08 §4 enable gate is decided on `spread_chain_capture`, which TradeAnalyzer fetches itself —
// TradeAnalyzer 2's quality gate judges the collector's generation and says nothing about this table.
// A silent capture failure (a series that stops being re-quoted, a chain that arrives without a usable
// leg, a quote that never moves) would not fail anything; it would quietly decide the gate by shrinking
// or distorting the sample the operator is about to trust.
//
// These are deliberately few, and each one states what it measured. A finding is a prompt to look, never
// a blocker: nothing here changes a pick.
//
// see docs/formulas.md#bull-put-spread-mode, NewApp/requirements/08-bull-put-spread-mode.md §4

import type { CaptureQualityFinding, CaptureQualityReport } from '@shared/spread-mode.js';

/** One captured mark of a position's two legs, as the settler already loaded it. */
export interface PositionCapture {
  ticker: string;
  /** The position's entry date; only captures after it are expected. */
  asOfDate: string;
  expiration: string;
  status: 'open' | 'target' | 'expired' | 'unsettleable';
  /** Dates on which a chain row existed for this series (any leg usable or not). */
  markDates: string[];
  /** `[shortBid, shortAsk, longBid, longAsk]` per usable mark, oldest first; null when a leg was missing. */
  quotes: Array<readonly [number, number, number, number] | null>;
}

export const CAPTURE_QUALITY_LIMITS = {
  /** Share of a position's captures that were unusable before it is worth reporting. */
  maxGapRate: 0.05,
  /** Consecutive identical two-leg quotes before a series is called unchanged. */
  unchangedMarks: 3,
} as const;

const asc = (a: string, b: string): number => a.localeCompare(b);

/**
 * Judge the captures behind the positions.
 *
 * `captureDays` is every date the capture ran at all. A day missing from a position's own marks while the
 * capture ran for other series is a real miss — the comparison needs no trading calendar, and cannot fire
 * on a weekend or a holiday, when nothing captured anything.
 */
export function assessCaptureQuality(
  positions: readonly PositionCapture[],
  captureDays: readonly string[],
  todayEt: string,
): CaptureQualityReport {
  const findings: CaptureQualityFinding[] = [];
  const days = [...captureDays].sort(asc);
  const lastCaptureDate = days.length > 0 ? days[days.length - 1]! : null;

  let marks = 0, gaps = 0, expected = 0, missing = 0;
  const missedBy: Array<{ ticker: string; dates: string[] }> = [];
  const unchanged: Array<{ ticker: string; since: string }> = [];

  for (const p of positions) {
    const seen = new Set(p.markDates);
    // Only days the position was live: after its entry, and not past its expiry or today.
    const end = [p.expiration, todayEt].sort(asc)[0]!;
    const due = days.filter(d => d > p.asOfDate && d <= end);
    const missedDates = due.filter(d => !seen.has(d));
    expected += due.length;
    missing += missedDates.length;
    if (missedDates.length > 0 && p.status === 'open') missedBy.push({ ticker: p.ticker, dates: missedDates });

    const usable = p.quotes.filter(q => q !== null) as Array<readonly [number, number, number, number]>;
    marks += usable.length;
    gaps += p.quotes.length - usable.length;

    // A quote that never moves is what a stale or re-served chain looks like from here. Only an OPEN
    // position matters: a settled one stopped being re-quoted for a good reason.
    if (p.status === 'open' && usable.length >= CAPTURE_QUALITY_LIMITS.unchangedMarks) {
      const tail = usable.slice(-CAPTURE_QUALITY_LIMITS.unchangedMarks);
      const same = tail.every(q => q.every((v, i) => v === tail[0]![i]));
      if (same) unchanged.push({ ticker: p.ticker, since: p.markDates[p.markDates.length - CAPTURE_QUALITY_LIMITS.unchangedMarks] ?? p.markDates[0]! });
    }
  }

  if (lastCaptureDate == null) {
    findings.push({ code: 'SC-1', severity: 'warning', detail: 'no chain has ever been captured — the enable gate cannot be measured', subjects: [] });
  } else if (positions.some(p => p.status === 'open') && lastCaptureDate < todayEt) {
    const age = Math.round((Date.parse(`${todayEt}T00:00:00Z`) - Date.parse(`${lastCaptureDate}T00:00:00Z`)) / 86_400_000);
    if (age >= 4) {
      findings.push({
        code: 'SC-1', severity: 'warning', subjects: [],
        detail: `the last capture was ${lastCaptureDate}, ${age} days ago — open positions are not being marked`,
      });
    }
  }

  if (missedBy.length > 0) {
    findings.push({
      code: 'SC-2', severity: 'warning',
      detail: `${missedBy.length} open position(s) were not re-quoted on a day the capture ran — those marks cannot be recovered`,
      subjects: missedBy.map(m => `${m.ticker} (${m.dates.length}: ${m.dates.slice(0, 3).join(', ')}${m.dates.length > 3 ? '…' : ''})`),
    });
  }

  const gapRate = marks + gaps > 0 ? gaps / (marks + gaps) : null;
  if (gapRate != null && gapRate > CAPTURE_QUALITY_LIMITS.maxGapRate) {
    findings.push({
      code: 'SC-3', severity: 'warning', subjects: [],
      detail: `${gaps} of ${marks + gaps} captures (${(gapRate * 100).toFixed(1)}%) were missing one of the two legs, above the ${(CAPTURE_QUALITY_LIMITS.maxGapRate * 100).toFixed(0)}% line`,
    });
  }

  if (unchanged.length > 0) {
    findings.push({
      code: 'SC-4', severity: 'warning',
      detail: `${unchanged.length} open position(s) have had identical quotes on both legs for the last ${CAPTURE_QUALITY_LIMITS.unchangedMarks} captures — a stale or re-served chain looks like this`,
      subjects: unchanged.map(u => `${u.ticker} (since ${u.since})`),
    });
  }

  return {
    captureDays: days.length,
    lastCaptureDate,
    marks,
    gaps,
    gapRate,
    expectedMarks: expected,
    missingMarks: missing,
    findings,
  };
}
