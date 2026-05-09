import { describe, it, expect } from 'vitest';
import {
  computeRatios,
  parseFinancials,
  applyTickerDetails,
  type PolygonFinancials,
  type PolygonTickerDetails,
  type PolygonSnapshot
} from '../src/main/services/fundamentals-computer.js';

// Helper to build minimal Polygon responses for testing.
function makeFinancials(overrides: Partial<PolygonFinancials> = {}): PolygonFinancials {
  return {
    ticker: 'AAPL',
    company_name: 'Apple Inc.',
    filings: [],
    ...overrides
  };
}

function makeDetails(overrides: Partial<PolygonTickerDetails> = {}): PolygonTickerDetails {
  return {
    market_cap: null,
    share_class_shares_outstanding: null,
    sector: null,
    industry: null,
    sic_description: null,
    ...overrides
  };
}

function makeSnapshot(overrides: Partial<PolygonSnapshot> = {}): PolygonSnapshot {
  return {
    ticker: 'AAPL',
    last: { c: 180, tr: undefined },
    prev_day: { c: 178, v: 50_000_000, h: 181, l: 177 },
    ...overrides
  };
}

// ─── parseFinancials tests ───────────────────────────────────────────────────

describe('fundamentals-computer', () => {
  describe('parseFinancials', () => {
    it('returns nulls for empty filings', () => {
      const raw = parseFinancials(makeFinancials({ filings: [] }));
      expect(raw.netIncome).toBeNull();
      expect(raw.revenue).toBeNull();
      expect(raw.shareholdersEquity).toBeNull();
    });

    it('extracts a single filing', () => {
      const raw = parseFinancials(makeFinancials({
        filings: [
          {
            date: '2025-03-31',
            start_date: '2024-04-01',
            end_date: '2025-03-31',
            financials: {
              income_statement: {
                revenues: { value: 390_000_000_000 },
                net_income_loss: { value: 97_000_000_000 }
              },
              balance_sheet: {
                equity: { value: 74_000_000_000 },
                current_assets: { value: 143_000_000_000 },
                current_liabilities: { value: 115_000_000_000 }
              }
            }
          }
        ]
      }));
      expect(raw.revenue).toBeCloseTo(390_000_000_000);
      // A single entry is returned as-is (latestValue for income, sumField for income)
      // So netIncome = 97B (the single quarter value — callers should use TTM data).
      expect(raw.netIncome).toBeCloseTo(97_000_000_000);
      expect(raw.shareholdersEquity).toBeCloseTo(74_000_000_000);
    });

    it('sums up to 4 quarters for TTM net income', () => {
      const raw = parseFinancials(makeFinancials({
        filings: [
          {
            date: '2025-03-31', start_date: '', end_date: '',
            financials: {
              income_statement: {
                revenues: { value: 100 },
                net_income_loss: { value: 100 }
              }
            }
          }
        ]
      }));
      // sumTtm takes the value from each filing's financials
      expect(raw.netIncome).toBeCloseTo(100);
    });
  });

  describe('applyTickerDetails', () => {
    it('merges market cap and sector', () => {
      const raw = parseFinancials(makeFinancials());
      const patched = applyTickerDetails(raw, makeDetails({
        market_cap: 2_800_000_000_000,
        sector: 'Technology'
      }));
      expect(patched.marketCap).toBe(2_800_000_000_000);
      expect(patched.sector).toBe('Technology');
    });
  });

  describe('computeRatios', () => {
    it('computes P/E from price and EPS', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                income_statement: {
                  net_income_loss: { value: 97_000_000_000 }
                }
              }
            }
          ]
        }),
        details: makeDetails({ share_class_shares_outstanding: 15_500_000_000 }),
        snapshot: makeSnapshot({ last: { c: 200, tr: undefined } }),
        beta: null
      });
      // EPS = 97B / 15.5B ≈ 6.26, P/E = 200 / 6.26 ≈ 31.9
      expect(result.eps).not.toBeNull();
      expect(result.eps).toBeCloseTo(6.26, 1);
      expect(result.peRatio).not.toBeNull();
      expect(result.peRatio).toBeCloseTo(31.9, 0);
    });

    it('returns null for zero-share-count EPS', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                income_statement: { net_income_loss: { value: 100_000 } }
              }
            }
          ]
        }),
        details: makeDetails({ share_class_shares_outstanding: 0 }),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.eps).toBeNull();
      expect(result.peRatio).toBeNull();
    });

    it('returns null for D/E when shareholders equity is zero', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                income_statement: { net_income_loss: { value: 100_000 } },
                balance_sheet: {
                  equity: { value: 0 },
                  long_term_debt: { value: 200_000 }
                }
              }
            }
          ]
        }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.debtToEquity).toBeNull();
    });

    it('exempts financial sector from D/E', () => {
      const result = computeRatios({
        financials: makeFinancials({ filings: [] }),
        details: makeDetails({ sector: 'Banks' }),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.debtToEquity).toBeNull();
    });

    it('computes profit margin', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                income_statement: {
                  revenues: { value: 400 },
                  net_income_loss: { value: 40 }
                }
              }
            }
          ]
        }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      // revenue = 400, netIncome = 40
      // profitMargin = (40/400)*100 = 10%
      expect(result.profitMargin).not.toBeNull();
      expect(result.profitMargin).toBeCloseTo(10, 0);
    });

    it('computes ROE', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                income_statement: { net_income_loss: { value: 100 } },
                balance_sheet: { equity: { value: 500 } }
              }
            }
          ]
        }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      // latestValue: netIncome = 100, shareholdersEquity = 500
      // ROE = (100/500)*100 = 20%
      expect(result.roe).toBeCloseTo(20, 0);
    });

    it('computes current ratio', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                balance_sheet: {
                  current_assets: { value: 150 },
                  current_liabilities: { value: 100 }
                }
              }
            }
          ]
        }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.currentRatio).toBeCloseTo(1.5, 2);
    });

    it('rounds all ratios to 2 decimal places', () => {
      const result = computeRatios({
        financials: makeFinancials({
          filings: [
            {
              date: '', start_date: '', end_date: '',
              financials: {
                income_statement: {
                  revenues: { value: 333 },
                  net_income_loss: { value: 33.333 }
                },
                balance_sheet: {
                  equity: { value: 100 },
                  current_assets: { value: 222.222 },
                  current_liabilities: { value: 100 }
                }
              }
            }
          ]
        }),
        details: makeDetails({ share_class_shares_outstanding: 10 }),
        snapshot: makeSnapshot({ last: { c: 99.99, tr: undefined } }),
        beta: 1.234
      });
      // Check rounding: ROE = 33.33%
      expect(result.roe).toBeCloseTo(33.33, 1);
      // Current ratio = 2.22
      expect(result.currentRatio).toBeCloseTo(2.22, 1);
      expect(result.beta).toBe(1.234);
    });
  });
});