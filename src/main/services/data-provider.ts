// DataProvider interface — spec §4.2.3.
// All market-data access flows through this interface so a future provider
// drop-in is a single-class swap. Each method maps to a Polygon endpoint
// (or composite of endpoints for derived data).
// see SPEC: §4.2.3, §4.2.1

import type {
  DerivedRatios,
  Universe,
  ConstituentRow
} from '@shared/types.js';

export interface QuoteSnapshot {
  ticker: string;
  last: number | null;
  prevClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  distance52WkHigh?: number | null;
  distance52WkLow?: number | null;
  fetchedAt: string;
}

export interface EarningsInfo {
  ticker: string;
  nextEarningsDate: string | null;
  nextEarningsTime: 'am' | 'pm' | null;
  epsEstimate: number | null;
  epsActualLast4: number[];
}

export interface HistoricalBar {
  t: number;   // Unix ms timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface OptionContract {
  ticker: string;
  expiration: string;
  strike: number;
  side: 'call' | 'put';
  bid: number;
  ask: number;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number;
  openInterest: number | null;
  volume: number | null;
}

export interface OptionsChain {
  ticker: string;
  expiration: string;
  contracts: OptionContract[];
}

/**
 * Single interface for all market data. Implementations must be mockable
 * for the test suite (EP-6.2, EP-6.8).
 */
export interface DataProvider {
  name: string;

  /** Last price, bid/ask, volume, IV rank/percentile. */
  getQuote(ticker: string): Promise<QuoteSnapshot>;

  /**
   * Derived financial ratios from raw financial statements.
   * The DataProvider may call an internal `fundamentals-computer` to derive
   * these from raw /vX/reference/financials data — callers only see the ratios.
   */
  getFundamentals(ticker: string): Promise<DerivedRatios>;

  /** Earnings calendar: next date, time of day, EPS estimate + last 4 actuals. */
  getEarningsCalendar(ticker: string): Promise<EarningsInfo>;

  /** Daily OHLCV bars. */
  getHistoricalBars(
    ticker: string,
    timeframe: 'day' | 'week' | 'month',
    lookback: number
  ): Promise<HistoricalBar[]>;

  /** Full options chain for a given expiration. */
  getOptionsChain(ticker: string, expiration: string): Promise<OptionsChain>;

  /**
   * Index constituents. The bundled lists are maintained at
   * src/main/assets/constituents/ and refreshed manually.
   * see SPEC: §4.2.2
   */
  getIndexConstituents(index: Universe): Promise<ConstituentRow[]>;

  /** Health check — throws if the provider is unreachable or auth is bad. */
  ping(): Promise<void>;
}