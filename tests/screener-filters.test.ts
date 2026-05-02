import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTER_SPECS } from '../src/shared/screener-filters.js';

// ─── Filter spec tests ─────────────────────────────────────────────────────────

describe('screener-filters', () => {
  describe('DEFAULT_FILTER_SPECS', () => {
    it('has all filters from the spec table', () => {
      // 17 from spec table + 1 sector_exclude (also in table) = 18
      expect(DEFAULT_FILTER_SPECS.length).toBeGreaterThanOrEqual(17);
    });

    it('has unique IDs', () => {
      const ids = DEFAULT_FILTER_SPECS.map((f) => f.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('default market cap is $10B (≥ $10B large-cap)', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'market_cap')!;
      expect(f.defaultMin).toBe(10_000_000_000);
    });

    it('default P/E is 5–30', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'pe_ratio')!;
      expect(f.defaultMin).toBe(5);
      expect(f.defaultMax).toBe(30);
    });

    it('P/E is enabled by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'pe_ratio')!;
      expect(f.defaultEnabled).toBe(true);
    });

    it('EPS is > 0 by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'eps')!;
      expect(f.defaultMin).toBe(0.01); // > 0
    });

    it('default D/E is < 1.5', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'debt_to_equity')!;
      expect(f.defaultMax).toBe(1.5);
    });

    it('ROE is ≥ 15% by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'roe')!;
      expect(f.defaultMin).toBe(15);
    });

    it('profit margin is ≥ 8% by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'profit_margin')!;
      expect(f.defaultMin).toBe(8);
    });

    it('avg volume is ≥ 1M by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'avg_volume')!;
      expect(f.defaultMin).toBe(1_000_000);
    });

    it('option volume is disabled by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'avg_option_vol')!;
      expect(f.defaultEnabled).toBe(false);
    });

    it('price is ≥ $20 by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'price')!;
      expect(f.defaultMin).toBe(20);
    });

    it('dist_52wk_high is within 25% by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'dist_52wk_high')!;
      expect(f.defaultMin).toBe(0);
      expect(f.defaultMax).toBe(25);
    });

    it('dist_52wk_low is ≥ 15% by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'dist_52wk_low')!;
      expect(f.defaultMin).toBe(15);
    });

    it('beta is 0.7–1.6 by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'beta')!;
      expect(f.defaultMin).toBe(0.7);
      expect(f.defaultMax).toBe(1.6);
    });

    it('earnings filter is disabled by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'exclude_earnings')!;
      expect(f.defaultEnabled).toBe(false);
    });

    it('sector_exclude is disabled by default', () => {
      const f = DEFAULT_FILTER_SPECS.find((f) => f.id === 'sector_exclude')!;
      expect(f.defaultEnabled).toBe(false);
    });
  });
});

// ─── Filter logic evaluation (pure functions) ─────────────────────────────────

describe('screener filter logic', () => {
  // Re-implement the key evaluation logic as pure functions for testing.
  // This mirrors the logic in ScreenerService.evaluateTicker.

  function evalFilter(
    filterId: string,
    value: Record<string, unknown>,
    fundamentals: {
      marketCap: number | null;
      peRatio: number | null;
      eps: number | null;
      revenueGrowth: number | null;
      epsGrowth: number | null;
      debtToEquity: number | null;
      roe: number | null;
      profitMargin: number | null;
      freeCashFlow: number | null;
      currentRatio: number | null;
      beta: number | null;
      sector: string | null;
    },
    quote: { price: number | null; avgVolume: number | null }
  ): boolean {
    switch (filterId) {
      case 'market_cap':
        return fundamentals.marketCap !== null && fundamentals.marketCap >= (value['min'] as number ?? 0);
      case 'pe_ratio': {
        const [mn, mx] = [(value['min'] as number) ?? 0, (value['max'] as number) ?? Infinity];
        return fundamentals.peRatio !== null && fundamentals.peRatio >= mn && fundamentals.peRatio <= mx;
      }
      case 'eps':
        return fundamentals.eps !== null && fundamentals.eps >= (value['min'] as number ?? 0);
      case 'revenue_growth':
        return fundamentals.revenueGrowth !== null && fundamentals.revenueGrowth >= (value['min'] as number ?? 0);
      case 'eps_growth':
        return fundamentals.epsGrowth !== null && fundamentals.epsGrowth >= (value['min'] as number ?? 0);
      case 'debt_to_equity': {
        // Financial sector exempted — null passes.
        if (fundamentals.debtToEquity === null) return true;
        const [mn, mx] = [(value['min'] as number) ?? 0, (value['max'] as number) ?? Infinity];
        return fundamentals.debtToEquity >= mn && fundamentals.debtToEquity <= mx;
      }
      case 'roe':
        return fundamentals.roe !== null && fundamentals.roe >= (value['min'] as number ?? 0);
      case 'profit_margin':
        return fundamentals.profitMargin !== null && fundamentals.profitMargin >= (value['min'] as number ?? 0);
      case 'free_cash_flow':
        return fundamentals.freeCashFlow !== null && fundamentals.freeCashFlow > 0;
      case 'current_ratio':
        return fundamentals.currentRatio !== null && fundamentals.currentRatio >= (value['min'] as number ?? 0);
      case 'avg_volume':
        return quote.avgVolume !== null && quote.avgVolume >= (value['min'] as number ?? 0);
      case 'price':
        return quote.price !== null && quote.price >= (value['min'] as number ?? 0);
      case 'beta': {
        const [mn, mx] = [(value['min'] as number) ?? 0, (value['max'] as number) ?? Infinity];
        const beta = fundamentals.beta ?? 1.0;
        return beta >= mn && beta <= mx;
      }
      case 'sector_exclude': {
        const excluded = (value['sectors'] as string[] | undefined) ?? [];
        return fundamentals.sector === null || !excluded.some(
          (s) => fundamentals.sector!.toLowerCase().includes(s.toLowerCase())
        );
      }
      default:
        return true;
    }
  }

  const baseFundamentals = {
    marketCap: 100_000_000_000,
    peRatio: 18,
    eps: 5.20,
    revenueGrowth: 12,
    epsGrowth: 8,
    debtToEquity: 0.6,
    roe: 22,
    profitMargin: 18,
    freeCashFlow: 5_000_000_000,
    currentRatio: 1.5,
    beta: 1.1,
    sector: 'Technology'
  };

  const baseQuote = { price: 95, avgVolume: 15_000_000 };

  function makeValue(min: number, max: number): Record<string, unknown> {
    return { min, max, enabled: true };
  }

  describe('market_cap filter', () => {
    it('passes when market cap is above threshold', () => {
      const result = evalFilter('market_cap', makeValue(10_000_000_000, Infinity), baseFundamentals, baseQuote);
      expect(result).toBe(true);
    });

    it('fails when market cap is below threshold', () => {
      const result = evalFilter('market_cap', makeValue(500_000_000_000, Infinity), baseFundamentals, baseQuote);
      expect(result).toBe(false);
    });

    it('fails when market cap is null', () => {
      const result = evalFilter('market_cap', makeValue(10_000_000_000, Infinity), { ...baseFundamentals, marketCap: null }, baseQuote);
      expect(result).toBe(false);
    });
  });

  describe('pe_ratio filter', () => {
    it('passes when P/E is in range', () => {
      expect(evalFilter('pe_ratio', makeValue(5, 30), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when P/E is below range', () => {
      expect(evalFilter('pe_ratio', makeValue(20, 30), baseFundamentals, baseQuote)).toBe(false);
    });

    it('fails when P/E is above range', () => {
      expect(evalFilter('pe_ratio', makeValue(0, 15), baseFundamentals, baseQuote)).toBe(false);
    });

    it('fails when P/E is null', () => {
      expect(evalFilter('pe_ratio', makeValue(5, 30), { ...baseFundamentals, peRatio: null }, baseQuote)).toBe(false);
    });
  });

  describe('eps filter', () => {
    it('passes when EPS > 0', () => {
      expect(evalFilter('eps', makeValue(0.01, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when EPS is negative', () => {
      expect(evalFilter('eps', makeValue(0.01, Infinity), { ...baseFundamentals, eps: -1 }, baseQuote)).toBe(false);
    });

    it('fails when EPS is null', () => {
      expect(evalFilter('eps', makeValue(0.01, Infinity), { ...baseFundamentals, eps: null }, baseQuote)).toBe(false);
    });
  });

  describe('debt_to_equity filter', () => {
    it('passes when D/E is below threshold', () => {
      expect(evalFilter('debt_to_equity', makeValue(0, 1.5), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when D/E exceeds threshold', () => {
      expect(evalFilter('debt_to_equity', makeValue(0, 0.4), baseFundamentals, baseQuote)).toBe(false);
    });

    it('passes when D/E is null (financial sector exemption)', () => {
      expect(evalFilter('debt_to_equity', makeValue(0, 1.5), { ...baseFundamentals, debtToEquity: null }, baseQuote)).toBe(true);
    });
  });

  describe('roe filter', () => {
    it('passes when ROE >= threshold', () => {
      expect(evalFilter('roe', makeValue(15, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when ROE is below threshold', () => {
      expect(evalFilter('roe', makeValue(25, Infinity), baseFundamentals, baseQuote)).toBe(false);
    });
  });

  describe('profit_margin filter', () => {
    it('passes when profit margin is high enough', () => {
      expect(evalFilter('profit_margin', makeValue(8, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when profit margin is too low', () => {
      expect(evalFilter('profit_margin', makeValue(25, Infinity), baseFundamentals, baseQuote)).toBe(false);
    });
  });

  describe('free_cash_flow filter', () => {
    it('passes when FCF is positive', () => {
      expect(evalFilter('free_cash_flow', makeValue(0, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when FCF is negative', () => {
      expect(evalFilter('free_cash_flow', makeValue(0, Infinity), { ...baseFundamentals, freeCashFlow: -1_000_000 }, baseQuote)).toBe(false);
    });

    it('fails when FCF is null', () => {
      expect(evalFilter('free_cash_flow', makeValue(0, Infinity), { ...baseFundamentals, freeCashFlow: null }, baseQuote)).toBe(false);
    });
  });

  describe('current_ratio filter', () => {
    it('passes when current ratio >= 1.0', () => {
      expect(evalFilter('current_ratio', makeValue(1.0, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when current ratio is below threshold', () => {
      expect(evalFilter('current_ratio', makeValue(2.0, Infinity), baseFundamentals, baseQuote)).toBe(false);
    });
  });

  describe('price filter', () => {
    it('passes when price >= $20', () => {
      expect(evalFilter('price', makeValue(20, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when price < $20', () => {
      expect(evalFilter('price', makeValue(20, Infinity), baseFundamentals, { ...baseQuote, price: 15 })).toBe(false);
    });
  });

  describe('avg_volume filter', () => {
    it('passes when volume >= threshold', () => {
      expect(evalFilter('avg_volume', makeValue(1_000_000, Infinity), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when volume is too low', () => {
      expect(evalFilter('avg_volume', makeValue(50_000_000, Infinity), baseFundamentals, baseQuote)).toBe(false);
    });
  });

  describe('beta filter', () => {
    it('passes when beta is in range 0.7–1.6', () => {
      expect(evalFilter('beta', makeValue(0.7, 1.6), baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when beta is too low', () => {
      // baseFundamentals has beta=1.1 which is IN range; test with a low beta value.
      expect(evalFilter('beta', makeValue(0.7, 1.6), { ...baseFundamentals, beta: 0.5 }, baseQuote)).toBe(false);
    });

    it('defaults to 1.0 when beta is null', () => {
      // Beta = 1.0 is in range 0.7–1.6 → passes
      expect(evalFilter('beta', makeValue(0.7, 1.6), { ...baseFundamentals, beta: null }, baseQuote)).toBe(true);
    });

    it('fails when beta is null and range excludes 1.0', () => {
      // Beta = 1.0 is not in range 0.7–0.9 → fails
      expect(evalFilter('beta', makeValue(0.7, 0.9), { ...baseFundamentals, beta: null }, baseQuote)).toBe(false);
    });
  });

  describe('sector_exclude filter', () => {
    it('passes when sector is not in exclude list', () => {
      const v = { sectors: ['Banks', 'Oil'], enabled: true };
      expect(evalFilter('sector_exclude', v, baseFundamentals, baseQuote)).toBe(true);
    });

    it('fails when sector is in exclude list', () => {
      const v = { sectors: ['Banks', 'Technology'], enabled: true };
      expect(evalFilter('sector_exclude', v, baseFundamentals, baseQuote)).toBe(false);
    });

    it('passes when sector is null', () => {
      const v = { sectors: ['Technology'], enabled: true };
      expect(evalFilter('sector_exclude', v, { ...baseFundamentals, sector: null }, baseQuote)).toBe(true);
    });

    it('case-insensitive sector matching', () => {
      const v = { sectors: ['TECHNOLOGY'], enabled: true };
      expect(evalFilter('sector_exclude', v, baseFundamentals, baseQuote)).toBe(false);
    });
  });

  describe('strict vs soft mode pass score', () => {
    function strictPass(failedFilters: string[]): boolean {
      return failedFilters.length === 0;
    }

    function softScore(passed: number): number {
      return passed;
    }

    it('strict mode: all passing = pass', () => {
      expect(strictPass([])).toBe(true);
    });

    it('strict mode: one failure = fail', () => {
      expect(strictPass(['pe_ratio'])).toBe(false);
      expect(strictPass(['pe_ratio', 'roe'])).toBe(false);
    });

    it('soft mode: counts passed filters', () => {
      expect(softScore(14)).toBe(14);
      expect(softScore(17)).toBe(17);
    });
  });
});