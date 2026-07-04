// Unit tests for the Filters Prefill summary email's pure helpers (v1.1.119):
// topIvHigh (ranks + caps IV High to a short actionable list) and sortWheelVetted
// (matches FiltersView's own default sort so the email agrees with the app view).

import { describe, it, expect } from 'vitest';
import { topIvHigh, sortWheelVetted, buildFiltersPrefillEmailHtml } from '../src/main/services/filters-prefill-report-builder.js';
import type { FilterTemplateResult } from '../src/shared/types.js';

function ivRow(ticker: string, ivRank: number | null, currentIv: number | null = null): FilterTemplateResult {
  return { ticker, watchlists: ['All'], lastPrice: 100, metrics: { ivRank, currentIv }, matchReason: '' };
}
function wheelRow(ticker: string, riskAdjustedReturn: number | null): FilterTemplateResult {
  return { ticker, watchlists: ['All'], lastPrice: 50, metrics: { riskAdjustedReturn }, matchReason: '' };
}

describe('topIvHigh', () => {
  it('sorts by ivRank descending and caps to the limit', () => {
    const rows = [ivRow('A', 40), ivRow('B', 90), ivRow('C', 70)];
    expect(topIvHigh(rows, 2).map(r => r.ticker)).toEqual(['B', 'C']);
  });

  it('falls back to currentIv when ivRank is missing', () => {
    const rows = [ivRow('A', null, 50), ivRow('B', null, 80), ivRow('C', null, 65)];
    expect(topIvHigh(rows).map(r => r.ticker)).toEqual(['B', 'C', 'A']);
  });

  it('ranks any row with a real ivRank above every row missing one', () => {
    const rows = [ivRow('HAS_RANK', 10), ivRow('NO_RANK', null, 99)];
    expect(topIvHigh(rows).map(r => r.ticker)).toEqual(['HAS_RANK', 'NO_RANK']);
  });

  it('does not mutate the input array', () => {
    const rows = [ivRow('A', 10), ivRow('B', 90)];
    const copy = [...rows];
    topIvHigh(rows);
    expect(rows).toEqual(copy);
  });

  it('defaults to a limit of 10', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ivRow(`T${i}`, i));
    expect(topIvHigh(rows)).toHaveLength(10);
  });
});

describe('sortWheelVetted', () => {
  it('sorts by riskAdjustedReturn descending', () => {
    const rows = [wheelRow('A', 12), wheelRow('B', 30), wheelRow('C', 20)];
    expect(sortWheelVetted(rows).map(r => r.ticker)).toEqual(['B', 'C', 'A']);
  });

  it('does not cap the result count (unlike IV High)', () => {
    const rows = Array.from({ length: 12 }, (_, i) => wheelRow(`T${i}`, i));
    expect(sortWheelVetted(rows)).toHaveLength(12);
  });
});

describe('buildFiltersPrefillEmailHtml', () => {
  it('shows an empty-state message for a list with zero matches', () => {
    const html = buildFiltersPrefillEmailHtml('2026-07-03', { top: [], totalScanned: 0 }, []);
    expect(html).toContain('No tickers cleared the IV High threshold today.');
    expect(html).toContain('No tickers passed the Wheel (Vetted) funnel today.');
  });

  it('renders tickers and the scanned-vs-shown count for IV High', () => {
    const html = buildFiltersPrefillEmailHtml(
      '2026-07-03',
      { top: [ivRow('SPY', 85, 42)], totalScanned: 214 },
      [wheelRow('AAPL', 18)],
    );
    expect(html).toContain('>SPY<');
    expect(html).toContain('top 1 of 214 scanned');
    expect(html).toContain('>AAPL<');
  });

  it('labels ETF rows distinctly from stock rows', () => {
    const etfRow: FilterTemplateResult = { ticker: 'XLE', watchlists: ['ETF'], lastPrice: 90, metrics: { ivRank: 80 }, matchReason: '' };
    const html = buildFiltersPrefillEmailHtml('2026-07-03', { top: [etfRow], totalScanned: 1 }, []);
    expect(html).toMatch(/XLE[\s\S]*ETF/);
  });
});
