// Regression tests for SEC EDGAR annual-series extraction (v0.32.80).
// Bug: every 10-K re-reports prior years as comparatives, so the raw 10-K entry
// list contains each fiscal year 2–3 times. Indexing that list as if entry N were
// N years back made the "5Y CAGR" base land on FY-2 (AAPL: computed 1.66% vs true 8.68%).

import { describe, it, expect } from 'vitest';
import {
  annualSeries,
  ttmPair,
  compositeEntries,
  conceptIsStale,
  type EdgarEntry,
} from '../src/main/services/sec-edgar-provider.js';

/** Annual duration fact as it appears in companyfacts (income/CF concepts). */
function fy(year: number, val: number, filedYear: number): EdgarEntry {
  return {
    start: `${year - 1}-09-29`,
    end: `${year}-09-27`,
    val,
    fp: 'FY',
    form: '10-K',
    filed: `${filedYear}-10-31`,
  };
}

describe('annualSeries', () => {
  it('dedupes comparative re-reports so index N is N fiscal years back (the 5Y CAGR bug)', () => {
    // Apple-like raw series: FY25 once, FY24 twice, FY23 three times, etc.
    const entries: EdgarEntry[] = [
      fy(2025, 416, 2025),
      fy(2024, 391, 2024), fy(2024, 391, 2025),
      fy(2023, 383, 2023), fy(2023, 383, 2024), fy(2023, 383, 2025),
      fy(2022, 394, 2022), fy(2022, 394, 2023), fy(2022, 394, 2024),
      fy(2021, 366, 2021), fy(2021, 366, 2022), fy(2021, 366, 2023),
      fy(2020, 274, 2020), fy(2020, 274, 2021), fy(2020, 274, 2022),
    ];

    const series = annualSeries(entries);

    expect(series.map(e => e.val)).toEqual([416, 391, 383, 394, 366, 274]);
    // Index 5 must be the value from exactly 5 fiscal years back — the CAGR base.
    expect(series[5]!.val).toBe(274);
    const cagr = (Math.pow(416 / 274, 1 / 5) - 1) * 100;
    expect(cagr).toBeCloseTo(8.7, 1);
  });

  it('prefers the most recently filed entry for a fiscal year (restatements win)', () => {
    const original = fy(2023, 100, 2023);
    const restated = { ...fy(2023, 95, 2024) };
    const series = annualSeries([original, restated]);
    expect(series).toHaveLength(1);
    expect(series[0]!.val).toBe(95);
  });

  it('excludes non-annual durations tagged in 10-K filings', () => {
    const quarterly: EdgarEntry = {
      start: '2023-07-02',
      end: '2023-09-30',  // ~90-day period inside a 10-K
      val: 90,
      fp: 'FY',
      form: '10-K',
      filed: '2023-11-03',
    };
    const series = annualSeries([fy(2023, 383, 2023), quarterly]);
    expect(series).toHaveLength(1);
    expect(series[0]!.val).toBe(383);
  });

  it('keeps instant facts (balance sheet, no start date)', () => {
    const instant: EdgarEntry = {
      end: '2023-09-30',
      val: 62_146,
      fp: 'FY',
      form: '10-K',
      filed: '2023-11-03',
    };
    expect(annualSeries([instant])).toHaveLength(1);
  });

  it('excludes 10-Q entries entirely', () => {
    const q: EdgarEntry = {
      start: '2024-09-29',
      end: '2024-12-28',
      val: 124,
      fp: 'Q1',
      form: '10-Q',
      filed: '2025-01-31',
    };
    expect(annualSeries([q])).toHaveLength(0);
  });

  it('handles 52/53-week fiscal calendars (363–370 day years)', () => {
    const wk53: EdgarEntry = {
      start: '2022-09-25',
      end: '2023-09-30',  // 370 days — Apple FY2023
      val: 383,
      fp: 'FY',
      form: '10-K',
      filed: '2023-11-03',
    };
    expect(annualSeries([wk53])).toHaveLength(1);
  });
});

// ─── ttmPair (v0.32.83) ───────────────────────────────────────────────────────
// TTM = FY + YTD(current) − YTD(prior year same period). Without the roll-forward,
// "TTM" was just the last 10-K — up to ~11 months stale for June-fiscal companies.

function ytd(start: string, end: string, val: number, form: '10-Q' | '10-K', filed: string): EdgarEntry {
  return { start, end, val, fp: 'Q2', form, filed };
}

describe('ttmPair', () => {
  // Sept-fiscal company (Apple-like): FY25 = 400, FY24 = 380.
  const fy25 = fy(2025, 400, 2025);
  const fy24 = fy(2024, 380, 2024);

  // H1 YTD facts: current FY26 H1 = 220, FY25 H1 = 200, FY24 H1 = 185.
  const h1Cur    = ytd('2025-09-28', '2026-03-28', 220, '10-Q', '2026-05-01');
  const h1Prior  = ytd('2024-09-29', '2025-03-29', 200, '10-Q', '2026-05-01');
  const h1Prior2 = ytd('2023-10-01', '2024-03-30', 185, '10-Q', '2025-05-02');

  it('rolls TTM forward with 10-Q YTD facts when the full chain exists', () => {
    const p = ttmPair([fy25, fy24, h1Cur, h1Prior, h1Prior2]);
    expect(p).not.toBeNull();
    expect(p!.source).toBe('ttm');
    // TTM = 400 + 220 − 200
    expect(p!.current.val).toBe(420);
    expect(p!.current.end).toBe('2026-03-28');
    // Prior TTM = 380 + 200 − 185
    expect(p!.prior!.val).toBe(395);
  });

  it('prefers the cumulative YTD over the single-quarter fact at the same end date', () => {
    const q2Only = ytd('2025-12-28', '2026-03-28', 110, '10-Q', '2026-05-01');
    const p = ttmPair([fy25, fy24, h1Cur, q2Only, h1Prior, h1Prior2]);
    expect(p!.source).toBe('ttm');
    expect(p!.current.val).toBe(420);  // used 220 (H1), not 110 (Q2 only)
  });

  it('falls back to consistent fiscal years when the YTD chain is incomplete', () => {
    // No two-years-back comparative → both values must be FY, never TTM-vs-FY mixed.
    const p = ttmPair([fy25, fy24, h1Cur, h1Prior]);
    expect(p!.source).toBe('fy');
    expect(p!.current.val).toBe(400);
    expect(p!.prior!.val).toBe(380);
  });

  it('uses plain FY values when no 10-Q is newer than the FY end', () => {
    const p = ttmPair([fy25, fy24, h1Prior, h1Prior2]);
    expect(p!.source).toBe('fy');
    expect(p!.current.val).toBe(400);
  });

  it('returns null prior when only one fiscal year exists', () => {
    const p = ttmPair([fy25]);
    expect(p!.current.val).toBe(400);
    expect(p!.prior).toBeNull();
  });

  it('returns null when there is no annual at all', () => {
    expect(ttmPair([h1Cur])).toBeNull();
  });
});

// ─── conceptIsStale (v0.32.87) ────────────────────────────────────────────────
// ORCL's only LongTermDebt entry is a $0 value from FY2022 — serving years-old
// data as "current" produced a fake net-cash position (ndEbitda −1.37 vs ~$90B
// of real debt). Stale concepts must yield null, not ancient values.

describe('conceptIsStale', () => {
  const NOW = Date.parse('2026-06-12');

  it('flags a concept whose newest entry is years old (the ORCL case)', () => {
    const stale: EdgarEntry = { end: '2022-05-31', val: 0, fp: 'FY', form: '10-K', filed: '2022-06-20' };
    expect(conceptIsStale([stale], NOW)).toBe(true);
  });

  it('accepts a concept with a recent entry', () => {
    const fresh: EdgarEntry = { end: '2026-02-28', val: 43e9, fp: 'Q3', form: '10-Q', filed: '2026-03-10' };
    expect(conceptIsStale([fresh], NOW)).toBe(false);
  });

  it('accepts an annual-only filer inside the 540-day window', () => {
    // 10-K ended ~14 months ago, next one not yet filed — must NOT be stale.
    const annualOnly: EdgarEntry = { end: '2025-03-29', val: 1e9, fp: 'FY', form: '10-K', filed: '2025-05-15' };
    expect(conceptIsStale([annualOnly], NOW)).toBe(false);
  });

  it('treats an empty entry list as stale', () => {
    expect(conceptIsStale([], NOW)).toBe(true);
  });
});

// ─── compositeEntries (v0.32.86) ──────────────────────────────────────────────
// Modern filers (MSFT, GOOGL, ORCL) tag Depreciation and amortization parts
// separately instead of a combined D&A concept — the composite sums them per
// reporting period so netDebtToEbitda stops coming up null.

describe('compositeEntries', () => {
  const dep  = (year: number, val: number, filedYear = year): EdgarEntry => fy(year, val, filedYear);
  const amort = (year: number, val: number, filedYear = year): EdgarEntry => fy(year, val, filedYear);

  it('sums base + addons for matching periods', () => {
    const out = compositeEntries(
      [dep(2025, 100), dep(2024, 90)],
      [[amort(2025, 30), amort(2024, 25)], [amort(2025, 5)]],
    );
    const series = annualSeries(out);
    expect(series.map(e => e.val)).toEqual([135, 115]);  // 100+30+5, 90+25
  });

  it('emits base-only periods when addons are missing (conservative understatement)', () => {
    const out = compositeEntries([dep(2025, 100)], [[], []]);
    expect(annualSeries(out).map(e => e.val)).toEqual([100]);
  });

  it('never emits a period the base concept lacks', () => {
    const out = compositeEntries([dep(2025, 100)], [[amort(2024, 25)]]);
    expect(annualSeries(out).map(e => e.val)).toEqual([100]);
  });

  it('dedupes comparative re-reports per component before summing (no double count)', () => {
    // FY2024 reported in both the FY24 and FY25 10-Ks for base and addon —
    // each must contribute once.
    const out = compositeEntries(
      [dep(2024, 90, 2024), dep(2024, 90, 2025)],
      [[amort(2024, 25, 2024), amort(2024, 25, 2025)]],
    );
    expect(annualSeries(out).map(e => e.val)).toEqual([115]);
  });

  it('restated component values win within a period', () => {
    const out = compositeEntries(
      [dep(2024, 90, 2024), { ...dep(2024, 85, 2025) }],
      [],
    );
    expect(annualSeries(out).map(e => e.val)).toEqual([85]);
  });

  it('feeds ttmPair like a native concept (10-Q periods join across components)', () => {
    const q = (start: string, end: string, val: number, filed: string): EdgarEntry =>
      ({ start, end, val, fp: 'Q2', form: '10-Q', filed });
    const out = compositeEntries(
      [dep(2025, 100), dep(2024, 90),
       q('2025-09-28', '2026-03-28', 55, '2026-05-01'),
       q('2024-09-29', '2025-03-29', 50, '2026-05-01'),
       q('2023-10-01', '2024-03-30', 45, '2025-05-02')],
      [[amort(2025, 30), amort(2024, 25),
        q('2025-09-28', '2026-03-28', 15, '2026-05-01'),
        q('2024-09-29', '2025-03-29', 14, '2026-05-01'),
        q('2023-10-01', '2024-03-30', 13, '2025-05-02')]],
    );
    const p = ttmPair(out);
    expect(p!.source).toBe('ttm');
    // TTM = (100+30) + (55+15) − (50+14) = 136
    expect(p!.current.val).toBe(136);
  });
});
