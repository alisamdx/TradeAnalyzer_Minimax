import type { Api } from '../../preload/index.js';

declare global {
  interface Window {
    api: Api & {
      screen: {
        cancel: () => Promise<boolean>;
        onProgress: (callback: (data: { scanned: number; total: number; ticker?: string }) => void) => (() => void);
      };
      websocket: {
        connect: () => Promise<boolean>;
        disconnect: () => Promise<boolean>;
        subscribe: (ticker: string) => Promise<boolean>;
        unsubscribe: (ticker: string) => Promise<boolean>;
        isConnected: () => Promise<boolean>;
        getSubscribed: () => Promise<string[]>;
        onPrice: (callback: (data: { ticker: string; price: number; change: number; changePct: number }) => void) => (() => void);
        onConnected: (callback: () => void) => (() => void);
        onDisconnected: (callback: () => void) => (() => void);
        onError: (callback: (error: string) => void) => (() => void);
      };
      historical: {
        getFinancials: (ticker: string, periodType: 'quarterly' | 'annual', limit?: number) => Promise<{
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
        }[]>;
        getFinancialsLatestDate: (ticker: string, periodType: 'quarterly' | 'annual') => Promise<string | null>;
        fetchFinancials: (ticker: string, periodType: 'quarterly' | 'annual') => Promise<{ success: boolean; count?: number; error?: string }>;
        getPrices: (ticker: string, fromDate: string, toDate: string) => Promise<{
          ticker: string;
          date: string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
          adjustedClose: number | null;
        }[]>;
        getPricesWithSMA: (ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') => Promise<{
          ticker: string;
          date: string;
          open: number;
          high: number;
          low: number;
          close: number;
          volume: number;
          adjustedClose: number | null;
          sma50: number | null;
        }[]>;
        getPricesLatestDate: (ticker: string) => Promise<string | null>;
        fetchPrices: (ticker: string, range: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y') => Promise<{ success: boolean; count?: number; error?: string }>;
        fetchAndStore: (ticker: string, type: 'financials' | 'prices', options?: { periodType?: 'quarterly' | 'annual'; range?: '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' }) => Promise<{ success: boolean; count?: number; error?: string; type: string }>;
        needsRefresh: (ticker: string, dataType: 'financials' | 'prices', maxAgeDays?: number) => Promise<boolean>;
      };
    };
    dialog: {
      prompt(opts: { title: string; defaultValue?: string }): Promise<string | null>;
      confirm(opts: { title: string; message: string }): Promise<boolean>;
    };
  }
}

export {};
