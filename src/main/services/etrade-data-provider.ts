/**
 * ETradeDataProvider — implements OptionsProvider using the E*Trade Market API.
 *
 * Credentials are supplied via a factory callback so this class always reads
 * the latest tokens from the DB (access tokens expire at midnight ET).
 *
 * Unit conventions:
 *   - OptionContract.iv (returned by getOptionsChain) is stored as a DECIMAL
 *     FRACTION (e.g. 0.285 = 28.5%) — matching the LeapsCspService expectation.
 *     Do NOT multiply by 100 here; the service does that where needed.
 *   - getOptionsIVAndPremium returns IV as a PERCENTAGE (28.5) — that is the
 *     IvData convention used by fetchIvData in LeapsCspService.
 *   - Bid / ask are already in dollars per share.
 */

import type { OAuthCredentials } from './etrade-auth.js';
import {
  getETradeExpirations,
  getETradeOptionsChain,
  type ETradeOptionLeg,
} from './etrade-options.js';
import type { OptionsProvider } from './options-provider.js';
import type { OptionsChain, OptionContract } from './data-provider.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseExpiry(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y!, month: m!, day: d! };
}

function legToContract(
  leg: ETradeOptionLeg,
  ticker: string,
  expiration: string
): OptionContract {
  return {
    ticker:       ticker.toUpperCase(),
    expiration,
    strike:       leg.strikePrice,
    side:         leg.optionType === 'CALL' ? 'call' : 'put',
    bid:          leg.bid  ?? 0,
    ask:          leg.ask  ?? 0,
    delta:        leg.greek.delta,
    gamma:        leg.greek.gamma,
    theta:        leg.greek.theta,
    vega:         leg.greek.vega,
    // Keep IV as a decimal fraction (e.g. 0.285) — LeapsCspService multiplies
    // by 100 itself when it needs a percentage.  Do NOT pre-multiply here.
    iv:           leg.greek.iv ?? 0,
    openInterest: leg.openInterest,
    volume:       leg.volume,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class ETradeDataProvider implements OptionsProvider {
  readonly name = 'etrade';

  constructor(private readonly getCreds: () => OAuthCredentials) {}

  // ── Expiration Discovery ───────────────────────────────────────────────────

  async getOptionsExpirations(ticker: string): Promise<string[]> {
    const creds = this.getCreds();
    const expirations = await getETradeExpirations(ticker, creds);
    return expirations.map(e => e.dateStr);
  }

  // ── Chain Fetch ───────────────────────────────────────────────────────────

  async getOptionsChain(ticker: string, expiration: string): Promise<OptionsChain> {
    const creds = this.getCreds();
    const expObj = {
      ...parseExpiry(expiration),
      expiryType: 'UNKNOWN',
      dateStr: expiration,
    };
    const result = await getETradeOptionsChain(ticker, expObj, creds);

    const contracts: OptionContract[] = [
      ...result.calls.map(leg => legToContract(leg, ticker, expiration)),
      ...result.puts .map(leg => legToContract(leg, ticker, expiration)),
    ];

    return { ticker: ticker.toUpperCase(), expiration, contracts };
  }

  // ── IV ────────────────────────────────────────────────────────────────────

  async getOptionsIV(ticker: string): Promise<{
    currentIv: number | null;
    iv52WkHigh: number | null;
    iv52WkLow: number | null;
  }> {
    const { currentIv, iv52WkHigh, iv52WkLow } =
      await this.getOptionsIVAndPremium(ticker, null, null);
    return { currentIv, iv52WkHigh, iv52WkLow };
  }

  async getOptionsIVAndPremium(
    ticker: string,
    targetExpiry: string | null,
    targetStrike: number | null
  ): Promise<{
    currentIv: number | null;
    iv52WkHigh: number | null;
    iv52WkLow: number | null;
    putPremium: number | null;
  }> {
    const noData = { currentIv: null, iv52WkHigh: null, iv52WkLow: null, putPremium: null };
    try {
      const creds = this.getCreds();

      // Resolve which expiration to pull.
      let expiry = targetExpiry;
      if (!expiry) {
        const expirations = await getETradeExpirations(ticker, creds);
        if (expirations.length === 0) return noData;
        expiry = expirations[0]!.dateStr; // nearest expiration
      }

      const expObj = {
        ...parseExpiry(expiry),
        expiryType: 'UNKNOWN',
        dateStr: expiry,
      };

      const result = await getETradeOptionsChain(ticker, expObj, creds);
      const allLegs = [...result.calls, ...result.puts];

      // Collect all IVs in percentage form.
      const allIvsPct: number[] = [];
      for (const leg of allLegs) {
        if (leg.greek.iv !== null && leg.greek.iv > 0) {
          allIvsPct.push(leg.greek.iv * 100);
        }
      }

      if (allIvsPct.length === 0) return noData;

      // ATM IV — find the call whose strike is closest to the underlying price.
      let atmIv: number | null = null;
      if (result.underlyingPrice !== null) {
        let minDist = Infinity;
        for (const leg of result.calls) {
          if (leg.greek.iv !== null && leg.greek.iv > 0) {
            const d = Math.abs(leg.strikePrice - result.underlyingPrice);
            if (d < minDist) { minDist = d; atmIv = leg.greek.iv * 100; }
          }
        }
      }
      // Fallback: use the median IV across all legs.
      if (atmIv === null) {
        const sorted = [...allIvsPct].sort((a, b) => a - b);
        atmIv = sorted[Math.floor(sorted.length / 2)] ?? null;
      }

      // 52-week high/low approximated from the range of IVs in this snapshot.
      const sortedAll = [...allIvsPct].sort((a, b) => a - b);
      const iv52WkLow  = sortedAll[0] ?? null;
      const iv52WkHigh = sortedAll[sortedAll.length - 1] ?? null;

      // Put premium: bid/ask midpoint (or last price) of put closest to target strike.
      let putPremium: number | null = null;
      if (targetStrike !== null && targetExpiry !== null) {
        let minStrikeDist = Infinity;
        for (const put of result.puts) {
          const dist = Math.abs(put.strikePrice - targetStrike);
          if (dist < minStrikeDist) {
            minStrikeDist = dist;
            if (put.bid !== null && put.ask !== null) {
              putPremium = (put.bid + put.ask) / 2;
            } else if (put.lastPrice !== null) {
              putPremium = put.lastPrice;
            } else {
              putPremium = put.bid;
            }
          }
        }
      }

      return { currentIv: atmIv, iv52WkHigh, iv52WkLow, putPremium };
    } catch {
      return noData;
    }
  }
}
