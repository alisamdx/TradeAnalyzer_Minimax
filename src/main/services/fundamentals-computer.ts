// Fundamentals computer — derives financial ratios from raw Polygon financials data.
// Unit-tested module (EP-6.1). Every formula is documented in docs/formulas.md.
// All computed ratios are non-nullable in the type but may be null in practice
// (e.g. pre-IPO companies, financial sector for D/E).
// see docs/formulas.md
// see SPEC: §4.2.2, §10 (design question)

import type { DerivedRatios } from '@shared/types.js';

/** Raw Polygon /vX/reference/financials shape (abbreviated — we only need the fields
 *  we actually use, so extra Polygon fields are silently ignored). */
export interface PolygonFinancials {
  ticker: string;
  company_name?: string;
  sic_description?: string;
  filings?: ReadonlyArray<{
    date: string;
    start_date: string;
    end_date: string;
    financials?: {
      income_statement?: {
        revenues?: { value: number; unit?: string; label?: string };
        net_income_loss?: { value: number; unit?: string; label?: string };
        operating_income_loss?: { value: number; unit?: string; label?: string };
      };
      balance_sheet?: {
        equity?: { value: number; unit?: string; label?: string };
        current_assets?: { value: number; unit?: string; label?: string };
        current_liabilities?: { value: number; unit?: string; label?: string };
        long_term_debt?: { value: number; unit?: string; label?: string };
      };
      cash_flow_statement?: {
        net_cash_flow_from_operating_activities?: { value: number; unit?: string; label?: string };
        // Note: capital_expenditures is not consistently available in Polygon data
      };
    };
  }>;
}

/** Polygon /v3/reference/tickers/{ticker} abbreviated response. */
export interface PolygonTickerDetails {
  market_cap?: number | null;
  share_class_shares_outstanding?: number | null;
  sic_code?: string | null;
 sic_description?: string | null;
  sector?: string | null;
  industry?: string | null;
}

/** Polygon /v2/snapshot/locale/us/markets/stocks/tickers/{ticker} abbreviated. */
export interface PolygonSnapshot {
  ticker: string;
  last?: { tr?: number; c?: number } | null;
  prev_day?: { c?: number; v?: number; h?: number; l?: number } | null;
  bid?: { p?: number } | null;
  ask?: { p?: number } | null;
  day?: { v?: number; h?: number; l?: number } | null;
  session?: { a?: number } | null;  // average (volume)
  lastStats?: { dt?: number; dv?: number } | null;
  otm?: boolean;  // placeholder — not used for fundamentals
}

interface RawFinancials {
  // Income statement
  revenue: number | null;
  netIncome: number | null;
  operatingIncome: number | null;
  // Balance sheet
  shareholdersEquity: number | null;
  totalCurrentAssets: number | null;
  totalCurrentLiabilities: number | null;
  totalDebt: number | null;
  // Cash flow
  operatingCashFlow: number | null;
  capex: number | null;
  // Share count (from details)
  shareCount: number | null;
  // Market data
  marketCap: number | null;
  currentPrice: number | null;
  // Metadata
  sector: string | null;
  industry: string | null;
  beta: number | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function latestValue(obj: unknown): number | null {
  // Polygon financials: each metric is an object { value: number, unit: string, ... }
  // Not an array as previously assumed.
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const v = o['value'];
  return typeof v === 'number' ? v : null;
}

function growthRate(current: number | null, prior: number | null): number | null {
  if (current == null || prior == null || prior <= 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** Extract a flat RawFinancials snapshot from Polygon API responses. */
export function parseFinancials(raw: PolygonFinancials): RawFinancials {
  const filings = raw.filings ?? [];
  const latest = filings[0]?.financials;

  const balance = latest?.balance_sheet;

  // Try to get TTM (trailing 12 months = last 4 quarters) by summing across the last 4 filings.
  function sumTtm(extractor: (financials: NonNullable<PolygonFinancials['filings']>[0]['financials']) => number | null): number | null {
    let sum = 0;
    let found = 0;
    for (let i = 0; i < Math.min(4, filings.length); i++) {
      const f = filings[i]?.financials;
      if (f) {
        const val = extractor(f);
        if (val !== null) {
          sum += val;
          found++;
        }
      }
    }
    return found > 0 ? sum : null;
  }

  const revenue = sumTtm(f => latestValue(f?.income_statement?.revenues));
  const netIncome = sumTtm(f => latestValue(f?.income_statement?.net_income_loss));
  const operatingIncome = sumTtm(f => latestValue(f?.income_statement?.operating_income_loss));
  const operatingCashFlow = sumTtm(f => latestValue(f?.cash_flow_statement?.net_cash_flow_from_operating_activities));
  // Note: capital_expenditures is not consistently available in Polygon data
  // FCF will be based on operating cash flow only if capex unavailable
  const capex = null;

  return {
    revenue,
    netIncome,
    operatingIncome,
    shareholdersEquity: latestValue(balance?.equity),
    totalCurrentAssets: latestValue(balance?.current_assets),
    totalCurrentLiabilities: latestValue(balance?.current_liabilities),
    totalDebt: latestValue(balance?.long_term_debt),
    operatingCashFlow,
    capex,
    shareCount: null,
    marketCap: null,
    currentPrice: null,
    sector: raw.sic_description ?? null,
    industry: null,
    beta: null
  };
}

/** Merge ticker details into a RawFinancials object. */
export function applyTickerDetails(raw: RawFinancials, details: PolygonTickerDetails): RawFinancials {
  return {
    ...raw,
    marketCap: details.market_cap ?? null,
    sector: details.sector ?? details.sic_description ?? raw.sector,
    industry: details.industry ?? null,
    shareCount: details.share_class_shares_outstanding ?? null
  };
}

// ─── Ratio computation ────────────────────────────────────────────────────────
// All formulas are documented in docs/formulas.md.
// Each comment references the anchor in that file.

export interface FundamentalsComputerInput {
  financials: PolygonFinancials;
  details: PolygonTickerDetails;
  snapshot: PolygonSnapshot;
  beta: number | null;
}

export function computeRatios(input: FundamentalsComputerInput): DerivedRatios {
  const { financials, details, snapshot, beta } = input;

  let raw = parseFinancials(financials);
  raw = applyTickerDetails(raw, details);

  const shareCount = details.share_class_shares_outstanding ?? raw.shareCount;
  const marketCap = details.market_cap ?? raw.marketCap ?? null;
  const currentPrice = snapshot.last?.c ?? snapshot.prev_day?.c ?? null;

  // Get prior-year financials for YoY growth calculations.
  // We need the TTM from exactly 1 year ago (i.e. filings 4 through 7).
  const filings = financials.filings ?? [];
  
  function sumPriorTtm(extractor: (financials: NonNullable<PolygonFinancials['filings']>[0]['financials']) => number | null): number | null {
    let sum = 0;
    let found = 0;
    for (let i = 4; i < Math.min(8, filings.length); i++) {
      const f = filings[i]?.financials;
      if (f) {
        const val = extractor(f);
        if (val !== null) {
          sum += val;
          found++;
        }
      }
    }
    return found > 0 ? sum : null;
  }

  const priorRev = sumPriorTtm(f => latestValue(f?.income_statement?.revenues));
  const priorNet = sumPriorTtm(f => latestValue(f?.income_statement?.net_income_loss));

  // EPS (TTM) = TTM net income / share count
  // see docs/formulas.md#earnings-per-share
  const eps = raw.netIncome != null && shareCount != null && shareCount > 0
    ? raw.netIncome / shareCount
    : null;

  // P/E = current price / EPS
  // see docs/formulas.md#price-to-earnings
  const peRatio = currentPrice != null && eps != null && eps !== 0
    ? currentPrice / eps
    : null;

  // ROE = Net Income / Shareholders' Equity
  // see docs/formulas.md#return-on-equity
  const roe = raw.netIncome != null && raw.shareholdersEquity != null && raw.shareholdersEquity !== 0
    ? (raw.netIncome / raw.shareholdersEquity) * 100
    : null;

  // Debt-to-Equity = Total Debt / Shareholders' Equity
  // see docs/formulas.md#debt-to-equity
  // Financial sector exempted — null for financials.
  const sector = (details.sector ?? raw.sector)?.toLowerCase() ?? '';
  const isFinancial = sector.includes('bank') || sector.includes('financial') ||
    sector.includes('insurance') || sector.includes('investment');
  const debtToEquity = isFinancial || raw.shareholdersEquity == null || raw.shareholdersEquity === 0
    ? null
    : raw.totalDebt != null
      ? raw.totalDebt / raw.shareholdersEquity
      : null;

  // Profit margin = Net Income / Revenue
  // see docs/formulas.md#profit-margin
  const profitMargin = raw.netIncome != null && raw.revenue != null && raw.revenue !== 0
    ? (raw.netIncome / raw.revenue) * 100
    : null;

  // Revenue growth (YoY)
  // see docs/formulas.md#revenue-growth
  const revenueGrowth = growthRate(raw.revenue, priorRev);

  // EPS growth (YoY)
  const priorEps = priorNet != null && shareCount != null && shareCount > 0
    ? priorNet / shareCount
    : null;
  const epsGrowth = growthRate(eps, priorEps);

  // Free Cash Flow = Operating Cash Flow − CapEx
  // see docs/formulas.md#free-cash-flow
  const freeCashFlow =
    raw.operatingCashFlow != null && raw.capex != null
      ? raw.operatingCashFlow - Math.abs(raw.capex)
      : raw.operatingCashFlow;

  // Current ratio = Current Assets / Current Liabilities
  // see docs/formulas.md#current-ratio
  const currentRatio =
    raw.totalCurrentAssets != null && raw.totalCurrentLiabilities != null && raw.totalCurrentLiabilities !== 0
      ? raw.totalCurrentAssets / raw.totalCurrentLiabilities
      : null;

  // Dividend yield (Polygon snapshot has no dividend data, so null here;
  // may be added in Phase 3 when we query /v3/reference/dividends).
  const dividendYield: null = null;

  return {
    peRatio: peRatio !== null ? Math.round(peRatio * 100) / 100 : null,
    eps: eps !== null ? Math.round(eps * 100) / 100 : null,
    marketCap,
    debtToEquity: debtToEquity !== null ? Math.round(debtToEquity * 100) / 100 : null,
    roe: roe !== null ? Math.round(roe * 100) / 100 : null,
    profitMargin: profitMargin !== null ? Math.round(profitMargin * 100) / 100 : null,
    revenueGrowth: revenueGrowth !== null ? Math.round(revenueGrowth * 100) / 100 : null,
    epsGrowth: epsGrowth !== null ? Math.round(epsGrowth * 100) / 100 : null,
    freeCashFlow: freeCashFlow !== null ? Math.round(freeCashFlow * 100) / 100 : null,
    currentRatio: currentRatio !== null ? Math.round(currentRatio * 1000) / 1000 : null,
    dividendYield,
    beta,
    sector,
    industry: details.industry ?? null
  };
}