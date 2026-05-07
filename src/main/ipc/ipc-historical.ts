// IPC handlers for historical data
// Exposes historical financials and prices to renderer
// see SPEC: FR-4 Historical Charts

import { ipcMain } from 'electron';
import type { Database } from 'better-sqlite3';
import { HistoricalDataService, fetchAndStoreFinancials, fetchAndStorePrices } from '../services/historical-service.js';
import { PolygonDataProvider } from '../services/polygon-provider.js';

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

export function registerHistoricalIpc(
  db: Database,
  getApiKey: () => string
): void {
  const service = new HistoricalDataService(db);
  const provider = new PolygonDataProvider(getApiKey);

  // ─── Financials ─────────────────────────────────────────────────────────────

  ipcMain.handle('historical:getFinancials', (_event, ticker: string, periodType: 'quarterly' | 'annual', limit?: number) => {
    try {
      const rows = service.getFinancials({ ticker, periodType, limit: limit ?? 20 });
      // Reverse to get chronological order (oldest first) for charts
      return rows.reverse();
    } catch (err) {
      console.error('[historical:getFinancials] Error:', err);
      throw err;
    }
  });

  ipcMain.handle('historical:getFinancialsLatestDate', (_event, ticker: string, periodType: 'quarterly' | 'annual') => {
    try {
      return service.getLatestFinancialDate(ticker, periodType);
    } catch (err) {
      console.error('[historical:getFinancialsLatestDate] Error:', err);
      throw err;
    }
  });

  ipcMain.handle('historical:fetchFinancials', async (_event, ticker: string, periodType: 'quarterly' | 'annual') => {
    try {
      const count = await fetchAndStoreFinancials(service, provider, ticker, periodType);
      return { success: true, count };
    } catch (err) {
      console.error('[historical:fetchFinancials] Error:', err);
      return { success: false, error: String(err) };
    }
  });

  // ─── Prices ────────────────────────────────────────────────────────────────

  ipcMain.handle('historical:getPrices', (_event, ticker: string, fromDate: string, toDate: string) => {
    try {
      const rows = service.getPrices({ ticker, fromDate, toDate });
      return rows;
    } catch (err) {
      console.error('[historical:getPrices] Error:', err);
      throw err;
    }
  });

  ipcMain.handle('historical:getPricesWithSMA', (_event, ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') => {
    try {
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
    } catch (err) {
      console.error('[historical:getPricesWithSMA] Error:', err);
      throw err;
    }
  });

  ipcMain.handle('historical:getPricesLatestDate', (_event, ticker: string) => {
    try {
      return service.getLatestPriceDate(ticker);
    } catch (err) {
      console.error('[historical:getPricesLatestDate] Error:', err);
      throw err;
    }
  });

  ipcMain.handle('historical:fetchPrices', async (_event, ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') => {
    try {
      const count = await fetchAndStorePrices(service, provider, ticker, range);
      return { success: true, count };
    } catch (err) {
      console.error('[historical:fetchPrices] Error:', err);
      return { success: false, error: String(err) };
    }
  });

  // ─── Combined Auto-Fetch ──────────────────────────────────────────────────

  ipcMain.handle('historical:fetchAndStore', async (_event, ticker: string, type: 'financials' | 'prices', options?: { periodType?: 'quarterly' | 'annual'; range?: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' }) => {
    try {
      if (type === 'financials') {
        const periodType = options?.periodType ?? 'quarterly';
        const count = await fetchAndStoreFinancials(service, provider, ticker, periodType);
        return { success: true, count, type: 'financials' };
      } else {
        const range = options?.range ?? '1Y';
        const count = await fetchAndStorePrices(service, provider, ticker, range);
        return { success: true, count, type: 'prices' };
      }
    } catch (err) {
      console.error('[historical:fetchAndStore] Error:', err);
      return { success: false, error: String(err), type };
    }
  });

  // ─── Bulk Fetch for Analysis ─────────────────────────────────────────────

  ipcMain.handle('historical:needsRefresh', (_event, ticker: string, dataType: 'financials' | 'prices', maxAgeDays: number = 7) => {
    try {
      let latestDate: string | null = null;
      if (dataType === 'financials') {
        latestDate = service.getLatestFinancialDate(ticker, 'quarterly');
      } else {
        latestDate = service.getLatestPriceDate(ticker);
      }
      return service.needsRefresh(latestDate, maxAgeDays);
    } catch (err) {
      console.error('[historical:needsRefresh] Error:', err);
      return true; // Assume needs refresh on error
    }
  });
}
