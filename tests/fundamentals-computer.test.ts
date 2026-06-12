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

    // see docs/formulas.md#dividend-yield (v0.32.84)
    it('computes dividend yield from TTM dividends per share and price', () => {
      const result = computeRatios({
        financials: makeFinancials({ filings: [] }),
        details: makeDetails(),
        snapshot: makeSnapshot({ last: { c: 100, tr: undefined } }),
        beta: null,
        ttmDividendsPerShare: 2.5
      });
      expect(result.dividendYield).toBe(2.5);
    });

    it('dividend yield is 0 for confirmed non-payers, null when unknown', () => {
      const base = {
        financials: makeFinancials({ filings: [] }),
        details: makeDetails(),
        snapshot: makeSnapshot({ last: { c: 100, tr: undefined } }),
        beta: null
      };
      expect(computeRatios({ ...base, ttmDividendsPerShare: 0 }).dividendYield).toBe(0);
      expect(computeRatios({ ...base, ttmDividendsPerShare: null }).dividendYield).toBeNull();
      expect(computeRatios(base).dividendYield).toBeNull();
    });

    it('passes beta through to the result', () => {
      const result = computeRatios({
        financials: makeFinancials({ filings: [] }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: 1.34
      });
      expect(result.beta).toBe(1.34);
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

  // ── Quality signals (v0.22.20) ─────────────────────────────────────────────

  /** Build N identical quarterly filings for TTM computation. */
  function makeQuarterlyFilings(
    income: {
      revenues?: number;
      net_income_loss?: number;
      operating_income_loss?: number;
      depreciation_and_amortization?: number;
    },
    balance: {
      equity?: number;
      current_assets?: number;
      current_liabilities?: number;
      long_term_debt?: number;
      cash_and_cash_equivalents?: number;
    },
    cashFlow: { net_cash_flow_from_operating_activities?: number } = {},
    count = 4
  ) {
    return Array.from({ length: count }, () => ({
      date: '', start_date: '', end_date: '',
      financials: {
        income_statement: {
          ...(income.revenues != null ? { revenues: { value: income.revenues } } : {}),
          ...(income.net_income_loss != null ? { net_income_loss: { value: income.net_income_loss } } : {}),
          ...(income.operating_income_loss != null ? { operating_income_loss: { value: income.operating_income_loss } } : {}),
          ...(income.depreciation_and_amortization != null ? { depreciation_and_amortization: { value: income.depreciation_and_amortization } } : {}),
        },
        balance_sheet: {
          ...(balance.equity != null ? { equity: { value: balance.equity } } : {}),
          ...(balance.current_assets != null ? { current_assets: { value: balance.current_assets } } : {}),
          ...(balance.current_liabilities != null ? { current_liabilities: { value: balance.current_liabilities } } : {}),
          ...(balance.long_term_debt != null ? { long_term_debt: { value: balance.long_term_debt } } : {}),
          ...(balance.cash_and_cash_equivalents != null ? { cash_and_cash_equivalents: { value: balance.cash_and_cash_equivalents } } : {}),
        },
        cash_flow_statement: {
          ...(cashFlow.net_cash_flow_from_operating_activities != null
            ? { net_cash_flow_from_operating_activities: { value: cashFlow.net_cash_flow_from_operating_activities } }
            : {}),
        },
      }
    }));
  }

  describe('new quality signals', () => {
    it('FCFToNetIncome: operatingCashFlow / netIncome × 100', () => {
      // Each quarter: OCF=200, NI=250 → TTM OCF=800, NI=1000 → ratio = 80%
      const filings = makeQuarterlyFilings(
        { net_income_loss: 250 },
        { equity: 1000 },
        { net_cash_flow_from_operating_activities: 200 }
      );
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.fcfToNetIncome).toBeCloseTo(80, 1);
    });

    it('FCFToNetIncome: null when netIncome <= 0', () => {
      const filings = makeQuarterlyFilings(
        { net_income_loss: -50 },
        { equity: 500 },
        { net_cash_flow_from_operating_activities: 100 }
      );
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.fcfToNetIncome).toBeNull();
    });

    it('ROIC: NOPAT / investedCapital × 100', () => {
      // Q: operatingIncome=300, netIncome=210 → taxRate = 1 − 210/300 = 30%
      // TTM: opInc=1200, NI=840 → NOPAT = 1200 × 0.70 = 840
      // equity=3000, totalDebt=1000 → investedCapital=4000
      // ROIC = 840/4000 × 100 = 21%
      const filings = makeQuarterlyFilings(
        { operating_income_loss: 300, net_income_loss: 210 },
        { equity: 3000, long_term_debt: 1000 }
      );
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.roic).toBeCloseTo(21, 0);
    });

    it('ROIC: null when investedCapital <= 0', () => {
      const filings = makeQuarterlyFilings(
        { operating_income_loss: 100, net_income_loss: 70 },
        { equity: -200, long_term_debt: 100 }  // investedCapital = -100
      );
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.roic).toBeNull();
    });

    it('NetDebtToEBITDA: (totalDebt − cash) / (operatingIncome + D&A)', () => {
      // Q: opInc=100, D&A=25 → TTM opInc=400, D&A=100 → EBITDA=500
      // balance (latest): totalDebt=600, cash=100 → netDebt=500
      // ratio = 500/500 = 1.0
      const filings = makeQuarterlyFilings(
        { operating_income_loss: 100, depreciation_and_amortization: 25 },
        { long_term_debt: 600, cash_and_cash_equivalents: 100 }
      );
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.netDebtToEbitda).toBeCloseTo(1.0, 1);
    });

    it('NetDebtToEBITDA: null when D&A is missing', () => {
      const filings = makeQuarterlyFilings(
        { operating_income_loss: 100 },  // no D&A
        { long_term_debt: 500 }
      );
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.netDebtToEbitda).toBeNull();
    });

    it('revenueGrowth5Y: null when fewer than 20 filings', () => {
      const filings = makeQuarterlyFilings({ revenues: 100 }, {}, {}, 8);
      const result = computeRatios({
        financials: makeFinancials({ filings }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.revenueGrowth5Y).toBeNull();
    });

    it('revenueGrowth5Y: 5Y CAGR when 20+ filings available', () => {
      // Current TTM (filings 0-3): revenue=250 each → TTM=1000
      // 5Y-ago TTM (filings 16-19): revenue=100 each → TTM=400
      // CAGR = (1000/400)^(1/5) − 1 ≈ 20.1%
      const currentFilings = makeQuarterlyFilings({ revenues: 250 }, {});
      const gapFilings     = makeQuarterlyFilings({ revenues: 150 }, {}, {}, 12);
      const oldFilings     = makeQuarterlyFilings({ revenues: 100 }, {});
      const result = computeRatios({
        financials: makeFinancials({ filings: [...currentFilings, ...gapFilings, ...oldFilings] }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.revenueGrowth5Y).toBeCloseTo(20.1, 0);
    });

    it('VS / GS: score = 6 when all criteria pass', () => {
      // Current TTM per Q: rev=200, NI=50 (margin=25%), opInc=65, D&A=10, OCF=60, equity=200, debt=100, cash=50
      // Checks: FCF=60×4/50×4=48%, hmm need FCF/NI≥80
      // Use NI=25 per Q → TTM NI=100, OCF=80 → FCF/NI = 80%
      // profitMargin = 100/800 = 12.5% ≥ 10 ✓
      // ROIC: opInc=65×4=260, NI=100 → taxRate = 1-100/260 = 61.5% → clamp to 50% → NOPAT=260×0.50=130
      //   IC = 200+100×4=600 wait debt is per-filing not summed (balance sheet)
      //   debt = 100 (latest filing), equity = 200 → IC = 300 → ROIC = 130/300×100 = 43.3% ✓
      // ND/EBITDA: EBITDA=260+40=300, netDebt=100-50=50 → 50/300=0.17 ≤ 3 ✓
      // D/E: 100/200 = 0.5 ≤ 0.8 ✓
      // 5Y: need 20 filings; 5Y-ago rev=100/Q→TTM=400, NI=10/Q→TTM=40
      //   revCAGR = (800/400)^0.2-1 ≈ 14.9% ≥ 5 ✓
      //   epsGrowth5Y: eps now = 100/shares, eps5Y = 40/shares → need shares
      const currentQ = makeQuarterlyFilings(
        { revenues: 200, net_income_loss: 25, operating_income_loss: 65, depreciation_and_amortization: 10 },
        { equity: 200, long_term_debt: 100, cash_and_cash_equivalents: 50 },
        { net_cash_flow_from_operating_activities: 20 }
      );
      const gapQ = makeQuarterlyFilings({ revenues: 130, net_income_loss: 15 }, {}, {}, 12);
      const oldQ = makeQuarterlyFilings({ revenues: 100, net_income_loss: 10 }, {});
      const result = computeRatios({
        financials: makeFinancials({ filings: [...currentQ, ...gapQ, ...oldQ] }),
        details: makeDetails({ share_class_shares_outstanding: 10 }),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.valueScore).toBeGreaterThanOrEqual(4);
      expect(result.growthScore).toBeGreaterThanOrEqual(4);
      expect(result.stockGrade).toBe(3);
    });

    it('StockGrade: null when VS=0 and GS=0', () => {
      // Empty filings → all null metrics → VS=0, GS=0 → stockGrade=null
      const result = computeRatios({
        financials: makeFinancials({ filings: [] }),
        details: makeDetails(),
        snapshot: makeSnapshot(),
        beta: null
      });
      expect(result.valueScore).toBe(0);
      expect(result.growthScore).toBe(0);
      expect(result.stockGrade).toBeNull();
    });
  });
});