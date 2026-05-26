/**
 * OptionsProvider interface — abstraction over any provider that supplies
 * options chain data (E*Trade, Polygon, or a future broker).
 *
 * PolygonDataProvider implements this by having all four methods already.
 * ETradeDataProvider implements it using the E*Trade Market API.
 *
 * The active provider is chosen by the 'optionsProvider' settings key
 * ('polygon' | 'etrade') and wired in src/main/index.ts.
 */

import type { OptionsChain, OptionContract } from './data-provider.js';

// Re-export so callers can import these shared shapes from one place.
export type { OptionsChain, OptionContract };

export interface OptionsProvider {
  /** Human-readable identifier, e.g. 'polygon' or 'etrade'. */
  readonly name: string;

  /**
   * All available expiration dates for a ticker, sorted ascending, as
   * 'YYYY-MM-DD' strings.  Implementations that do not support expiration
   * discovery should return []; callers fall back to generated Fridays.
   */
  getOptionsExpirations(ticker: string): Promise<string[]>;

  /** Full options chain (calls + puts) for a single expiration. */
  getOptionsChain(ticker: string, expiration: string): Promise<OptionsChain>;

  /**
   * Current ATM implied volatility plus 52-week high/low, all as
   * percentages (e.g. 28.5 means 28.5%).
   */
  getOptionsIV(ticker: string): Promise<{
    currentIv: number | null;
    iv52WkHigh: number | null;
    iv52WkLow: number | null;
  }>;

  /**
   * Combined call: ATM IV (same as getOptionsIV) + the bid/ask midpoint of the
   * put closest to targetStrike on targetExpiry.  Pass null for both target
   * args to skip put-premium extraction (backward-compat).
   */
  getOptionsIVAndPremium(
    ticker: string,
    targetExpiry: string | null,
    targetStrike: number | null
  ): Promise<{
    currentIv: number | null;
    iv52WkHigh: number | null;
    iv52WkLow: number | null;
    putPremium: number | null;
  }>;
}
