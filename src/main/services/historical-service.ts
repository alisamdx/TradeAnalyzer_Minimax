// Historical data service - manages historical_financials and historical_prices tables
// Supports Phase 4: Historical Charts
// see SPEC: FR-4 Historical Charts

import type { DbHandle } from '../db/connection.js';
import type { PolygonDataProvider } from './polygon-provider.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HistoricalFinancial {
  ticker: string;
  filingDate: string;
  periodType: 'quarterly' | 'annual';
  periodEndDate: string;
  revenues: number | null;
  netIncome: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  earningsPerShare: number | null;
  sharesOutstanding: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  shareholdersEquity: number | null;
  longTermDebt: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  operatingCashFlow: number | null;
  freeCashFlow: number | null;
  ebitda: number | null;
  currency: string;
  source: string;
  fetchedAt: string;
}

export interface HistoricalPrice {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose: number | null;
  source: string;
}

export interface FinancialsQueryParams {
  ticker: string;
  periodType: 'quarterly' | 'annual';
  limit?: number;
}

export interface PricesQueryParams {
  ticker: string;
  fromDate: string;
  toDate: string;
}

export type TimeRange = '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y';

// ─── Service Implementation ─────────────────────────────────────────────────

export class HistoricalDataService {
  private readonly insertFinancialStmt;
  private readonly insertPriceStmt;
  private readonly getFinancialsStmt;
  private readonly getPricesStmt;
  private readonly getLatestFinancialStmt;
  private readonly getLatestPriceStmt;
  private readonly deleteOldPricesStmt;

  constructor(private readonly db: DbHandle) {
    // Insert financials - handles duplicates via ON CONFLICT
    this.insertFinancialStmt = db.prepare(`
      INSERT OR REPLACE INTO historical_financials (
        ticker, filing_date, period_type, period_end_date,
        revenues, net_income, gross_profit, operating_income,
        earnings_per_share, shares_outstanding,
        total_assets, total_liabilities, shareholders_equity,
        long_term_debt, current_assets, current_liabilities,
        operating_cash_flow, free_cash_flow, ebitda,
        currency, source, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);

    // Insert prices - handles duplicates via ON CONFLICT
    this.insertPriceStmt = db.prepare(`
      INSERT OR REPLACE INTO historical_prices (
        ticker, date, open, high, low, close, volume, adjusted_close, source, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `);

    // Get financials for a ticker
    this.getFinancialsStmt = db.prepare(`
      SELECT * FROM historical_financials
      WHERE ticker = ? AND period_type = ?
      ORDER BY period_end_date DESC
      LIMIT ?
    `);

    // Get prices for a ticker in date range
    this.getPricesStmt = db.prepare(`
      SELECT * FROM historical_prices
      WHERE ticker = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
    `);

    // Get latest financial filing date
    this.getLatestFinancialStmt = db.prepare(`
      SELECT MAX(filing_date) as latest_date FROM historical_financials
      WHERE ticker = ? AND period_type = ?
    `);

    // Get latest price date
    this.getLatestPriceStmt = db.prepare(`
      SELECT MAX(date) as latest_date FROM historical_prices
      WHERE ticker = ?
    `);

    // Cleanup old prices (keep 5 years of data)
    this.deleteOldPricesStmt = db.prepare(`
      DELETE FROM historical_prices
      WHERE ticker = ? AND date < ?
    `);
  }

  // ─── Financials Operations ─────────────────────────────────────────────────

  getFinancials(params: FinancialsQueryParams): HistoricalFinancial[] {
    const limit = params.limit ?? 20;
    const rows = this.getFinancialsStmt.all(
      params.ticker.toUpperCase(),
      params.periodType,
      limit
    ) as Array<{
      ticker: string;
      filing_date: string;
      period_type: string;
      period_end_date: string;
      revenues: number | null;
      net_income: number | null;
      gross_profit: number | null;
      operating_income: number | null;
      earnings_per_share: number | null;
      shares_outstanding: number | null;
      total_assets: number | null;
      total_liabilities: number | null;
      shareholders_equity: number | null;
      long_term_debt: number | null;
      current_assets: number | null;
      current_liabilities: number | null;
      operating_cash_flow: number | null;
      free_cash_flow: number | null;
      ebitda: number | null;
      currency: string;
      source: string;
      fetched_at: string;
    }>;

    return rows.map(r => ({
      ticker: r.ticker,
      filingDate: r.filing_date,
      periodType: r.period_type as 'quarterly' | 'annual',
      periodEndDate: r.period_end_date,
      revenues: r.revenues,
      netIncome: r.net_income,
      grossProfit: r.gross_profit,
      operatingIncome: r.operating_income,
      earningsPerShare: r.earnings_per_share,
      sharesOutstanding: r.shares_outstanding,
      totalAssets: r.total_assets,
      totalLiabilities: r.total_liabilities,
      shareholdersEquity: r.shareholders_equity,
      longTermDebt: r.long_term_debt,
      currentAssets: r.current_assets,
      currentLiabilities: r.current_liabilities,
      operatingCashFlow: r.operating_cash_flow,
      freeCashFlow: r.free_cash_flow,
      ebitda: r.ebitda,
      currency: r.currency ?? 'USD',
      source: r.source ?? 'polygon',
      fetchedAt: r.fetched_at
    }));
  }

  upsertFinancial(financial: HistoricalFinancial): void {
    this.insertFinancialStmt.run(
      financial.ticker.toUpperCase(),
      financial.filingDate,
      financial.periodType,
      financial.periodEndDate,
      financial.revenues,
      financial.netIncome,
      financial.grossProfit,
      financial.operatingIncome,
      financial.earningsPerShare,
      financial.sharesOutstanding,
      financial.totalAssets,
      financial.totalLiabilities,
      financial.shareholdersEquity,
      financial.longTermDebt,
      financial.currentAssets,
      financial.currentLiabilities,
      financial.operatingCashFlow,
      financial.freeCashFlow,
      financial.ebitda,
      financial.currency ?? 'USD',
      financial.source ?? 'polygon'
    );
  }

  getLatestFinancialDate(ticker: string, periodType: 'quarterly' | 'annual'): string | null {
    const row = this.getLatestFinancialStmt.get(
      ticker.toUpperCase(),
      periodType
    ) as { latest_date: string | null } | undefined;
    return row?.latest_date ?? null;
  }

  // ─── Price Operations ──────────────────────────────────────────────────────

  getPrices(params: PricesQueryParams): HistoricalPrice[] {
    const rows = this.getPricesStmt.all(
      params.ticker.toUpperCase(),
      params.fromDate,
      params.toDate
    ) as Array<{
      ticker: string;
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      adjusted_close: number | null;
      source: string;
    }>;

    return rows.map(r => ({
      ticker: r.ticker,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      adjustedClose: r.adjusted_close,
      source: r.source ?? 'polygon'
    }));
  }

  upsertPrice(price: HistoricalPrice): void {
    this.insertPriceStmt.run(
      price.ticker.toUpperCase(),
      price.date,
      price.open,
      price.high,
      price.low,
      price.close,
      price.volume,
      price.adjustedClose,
      price.source ?? 'polygon'
    );
  }

  getLatestPriceDate(ticker: string): string | null {
    const row = this.getLatestPriceStmt.get(
      ticker.toUpperCase()
    ) as { latest_date: string | null } | undefined;
    return row?.latest_date ?? null;
  }

  // ─── Utility Methods ───────────────────────────────────────────────────────

  /**
   * Calculate date range from time range selector
   */
  static getDateRangeFromTimeRange(range: TimeRange): { from: string; to: string } {
    const to = new Date();
    const from = new Date();

    switch (range) {
      case '1M':
        from.setMonth(from.getMonth() - 1);
        break;
      case '3M':
        from.setMonth(from.getMonth() - 3);
        break;
      case '6M':
        from.setMonth(from.getMonth() - 6);
        break;
      case '1Y':
        from.setFullYear(from.getFullYear() - 1);
        break;
      case '2Y':
        from.setFullYear(from.getFullYear() - 2);
        break;
      case '5Y':
        from.setFullYear(from.getFullYear() - 5);
        break;
    }

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10)
    };
  }

  /**
   * Calculate 50-day SMA from price data
   */
  static calculateSMA(prices: HistoricalPrice[], period: number): Array<{ date: string; value: number | null }> {
    const result: Array<{ date: string; value: number | null }> = [];

    for (let i = 0; i < prices.length; i++) {
      const price = prices[i];
      if (!price || i < period - 1) {
        result.push({ date: price?.date ?? '', value: null });
      } else {
        let sum = 0;
        let valid = true;
        for (let j = i - period + 1; j <= i; j++) {
          const p = prices[j];
          if (!p) {
            valid = false;
            break;
          }
          sum += p.close;
        }
        result.push({ date: price.date, value: valid ? sum / period : null });
      }
    }

    return result;
  }

  /**
   * Check if data needs refresh (older than specified days)
   */
  needsRefresh(latestDate: string | null, maxAgeDays: number): boolean {
    if (!latestDate) return true;
    const latest = new Date(latestDate).getTime();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    return Date.now() - latest > maxAge;
  }
}

// ─── Fetch and Store Helper ─────────────────────────────────────────────────

export async function fetchAndStoreFinancials(
  service: HistoricalDataService,
  provider: PolygonDataProvider,
  ticker: string,
  periodType: 'quarterly' | 'annual'
): Promise<number> {
  const data = await provider.fetchWithRetry('/vX/reference/financials', {
    ticker: ticker.toUpperCase(),
    timeframe: periodType,
    limit: '20'
  });

  const results = (data.results as unknown[] | undefined) ?? [];
  let count = 0;

  for (const result of results) {
    const r = result as Record<string, unknown>;
    const financials = r['financials'] as Record<string, unknown> | undefined;
    if (!financials) continue;

    const income = financials['income_statement'] as Record<string, unknown> | undefined;
    const balance = financials['balance_sheet'] as Record<string, unknown> | undefined;
    const cashflow = financials['cash_flow_statement'] as Record<string, unknown> | undefined;
    const comprehensive = financials['comprehensive_income'] as Record<string, unknown> | undefined;

    const getValue = (obj: Record<string, unknown> | undefined, key: string): number | null => {
      if (!obj) return null;
      const val = obj[key] as Record<string, unknown> | undefined;
      if (!val) return null;
      const num = val['value'] as number | undefined;
      return num ?? null;
    };

    const hf: HistoricalFinancial = {
      ticker: ticker.toUpperCase(),
      filingDate: String(r['filing_date'] ?? ''),
      periodType,
      periodEndDate: String(r['end_date'] ?? ''),
      revenues: getValue(income, 'revenues'),
      netIncome: getValue(income, 'net_income_loss'),
      grossProfit: getValue(income, 'gross_profit'),
      operatingIncome: getValue(income, 'operating_income_loss'),
      earningsPerShare: getValue(comprehensive, 'comprehensive_income_loss_attributable_to_parent'),
      sharesOutstanding: getValue(balance, 'shares_outstanding'),
      totalAssets: getValue(balance, 'assets'),
      totalLiabilities: getValue(balance, 'liabilities'),
      shareholdersEquity: getValue(balance, 'equity_attributable_to_parent'),
      longTermDebt: getValue(balance, 'long_term_debt'),
      currentAssets: getValue(balance, 'current_assets'),
      currentLiabilities: getValue(balance, 'current_liabilities'),
      operatingCashFlow: getValue(cashflow, 'net_cash_flow_from_operating_activities'),
      freeCashFlow: getValue(cashflow, 'net_cash_flow_from_operating_activities'), // Simplified
      ebitda: getValue(income, 'operating_income_loss'), // Simplified - would need proper EBITDA calc
      currency: String(r['currency_name'] ?? 'USD'),
      source: 'polygon',
      fetchedAt: new Date().toISOString()
    };

    // Calculate free cash flow properly if possible
    if (hf.operatingCashFlow && financials['cash_flow_statement']) {
      const capex = getValue(financials['cash_flow_statement'] as Record<string, unknown>, 'net_cash_flow_from_investing_activities');
      if (capex) {
        hf.freeCashFlow = hf.operatingCashFlow + capex; // capex is negative
      }
    }

    service.upsertFinancial(hf);
    count++;
  }

  return count;
}

export async function fetchAndStorePrices(
  service: HistoricalDataService,
  provider: PolygonDataProvider,
  ticker: string,
  timeRange: TimeRange
): Promise<number> {
  const { from, to } = HistoricalDataService.getDateRangeFromTimeRange(timeRange);

  const data = await provider.fetchWithRetry(
    `/v2/aggs/ticker/${ticker.toUpperCase()}/range/1/day/${from}/${to}`,
    { adjusted: 'true', sort: 'asc', limit: '50000' }
  );

  const results = (data.results as unknown[] | undefined) ?? [];
  let count = 0;

  for (const result of results) {
    const r = result as Record<string, number>;
    const timestamp = r['t'];
    if (!timestamp) continue;

    const date = new Date(timestamp).toISOString().slice(0, 10);

    const hp: HistoricalPrice = {
      ticker: ticker.toUpperCase(),
      date,
      open: r['o'] ?? 0,
      high: r['h'] ?? 0,
      low: r['l'] ?? 0,
      close: r['c'] ?? 0,
      volume: r['v'] ?? 0,
      adjustedClose: r['vw'] ?? null, // Use VWAP as proxy for adjusted close
      source: 'polygon'
    };

    service.upsertPrice(hp);
    count++;
  }

  return count;
}
