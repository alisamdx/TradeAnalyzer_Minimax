// IPC handlers for historical data
// Exposes historical financials and prices to renderer
// see SPEC: FR-4 Historical Charts

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { HistoricalDataService, fetchAndStoreFinancials, fetchAndStorePrices } from '../services/historical-service.js';
import { PolygonDataProvider } from '../services/polygon-provider.js';
import type { IpcResult } from '@shared/types.js';

export interface HistoricalFinancialDto {
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
}

export interface HistoricalPriceDto {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjustedClose: number | null;
}

export interface PricesWithSmaDto extends HistoricalPriceDto {
  sma50: number | null;
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'HISTORICAL_ERROR', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try {
      return ok(fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

// Async wrap for async functions
function wrapAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  return async (_e: IpcMainInvokeEvent, ...args: Args): Promise<IpcResult<R>> => {
    try {
      const result = await fn(...args);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerHistoricalIpc(
  db: Database,
  getApiKey: () => string
): void {
  const service = new HistoricalDataService(db);
  const provider = new PolygonDataProvider(getApiKey);

  // ─── Financials ─────────────────────────────────────────────────────────────

  ipcMain.handle('historical:getFinancials', wrap((ticker: string, periodType: 'quarterly' | 'annual', limit?: number) => {
    const rows = service.getFinancials({ ticker, periodType, limit: limit ?? 20 });
    // Reverse to get chronological order (oldest first) for charts
    return rows.reverse();
  }));

  ipcMain.handle('historical:getFinancialsLatestDate', wrap((ticker: string, periodType: 'quarterly' | 'annual') => {
    return service.getLatestFinancialDate(ticker, periodType);
  }));

  ipcMain.handle('historical:fetchFinancials', wrapAsync(async (ticker: string, periodType: 'quarterly' | 'annual') => {
    const count = await fetchAndStoreFinancials(service, provider, ticker, periodType);
    return { success: true, count };
  }));

  // ─── Prices ─────────────────────────────────────────────────────────────────

  ipcMain.handle('historical:getPrices', wrap((ticker: string, fromDate: string, toDate: string) => {
    return service.getPrices({ ticker, fromDate, toDate });
  }));

  ipcMain.handle('historical:getPricesWithSMA', wrap((ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') => {
    const { from, to } = HistoricalDataService.getDateRangeFromTimeRange(range);
    // Extend range by 50 days to calculate SMA
    const extendedFrom = new Date(from);
    extendedFrom.setDate(extendedFrom.getDate() - 60);
    const extendedFromStr = extendedFrom.toISOString().slice(0, 10);

    const prices = service.getPrices({ ticker, fromDate: extendedFromStr, toDate: to });
    const sma50 = HistoricalDataService.calculateSMA(prices, 50);

    // Combine price data with SMA, only return requested range
    const result = prices
      .filter(p => p.date >= from)
      .map((p, idx) => {
        // Find corresponding SMA value
        const smaIdx = prices.findIndex(px => px.date === p.date);
        const smaValue = smaIdx >= 0 ? sma50[smaIdx]?.value ?? null : null;
        return {
          ticker: p.ticker,
          date: p.date,
          open: p.open,
          high: p.high,
          low: p.low,
          close: p.close,
          volume: p.volume,
          adjustedClose: p.adjustedClose,
          sma50: smaValue
        };
      });

    return result;
  }));

  ipcMain.handle('historical:getPricesLatestDate', wrap((ticker: string) => {
    return service.getLatestPriceDate(ticker);
  }));

  ipcMain.handle('historical:fetchPrices', wrapAsync(async (ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') => {
    const count = await fetchAndStorePrices(service, provider, ticker, range);
    return { success: true, count };
  }));

  // ─── Combined Auto-Fetch ──────────────────────────────────────────────────

  ipcMain.handle('historical:fetchAndStore', wrapAsync(async (ticker: string, type: 'financials' | 'prices', options?: { periodType?: 'quarterly' | 'annual'; range?: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' }) => {
    if (type === 'financials') {
      const periodType = options?.periodType ?? 'quarterly';
      const count = await fetchAndStoreFinancials(service, provider, ticker, periodType);
      return { success: true, count, type: 'financials' };
    } else {
      const range = options?.range ?? '1Y';
      const count = await fetchAndStorePrices(service, provider, ticker, range);
      return { success: true, count, type: 'prices' };
    }
  }));

  // ─── Bulk Fetch for Analysis ─────────────────────────────────────────────

  ipcMain.handle('historical:needsRefresh', wrap((ticker: string, dataType: 'financials' | 'prices', maxAgeDays: number = 7) => {
    let latestDate: string | null = null;
    if (dataType === 'financials') {
      latestDate = service.getLatestFinancialDate(ticker, 'quarterly');
    } else {
      latestDate = service.getLatestPriceDate(ticker);
    }
    return service.needsRefresh(latestDate, maxAgeDays);
  }));
}
