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

import { renewAccessToken, type OAuthCredentials } from './etrade-auth.js';
import { etradeApplicationErrorCode, TICKER_WIDE_NO_OPTIONS_CODES } from './etrade-errors.js';
import {
  getETradeExpirations,
  getETradeOptionsChain,
  type ETradeOptionLeg,
} from './etrade-options.js';
import type { OptionsProvider } from './options-provider.js';
import type { OptionsChain, OptionContract } from './data-provider.js';
import { atmIvAtClosestStrike } from './iv-utils.js';
import { assessChainGreeks, staleGreekGuardEnabled, withholdStaleGreeks, type GreekAssessment } from './greek-consistency.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseExpiry(dateStr: string): { year: number; month: number; day: number } {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { year: y!, month: m!, day: d! };
}

function etDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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

  /**
   * `onStaleChain` receives every chain the stale-Greek guard flags, AS FETCHED (before its Greeks
   * are withheld) — the STALE_GREEK_MODEL_DELTA shadow log (v1.1.320). Its failure never reaches
   * the caller: a logging fault must not cost a chain.
   */
  constructor(
    private readonly getCreds: () => OAuthCredentials,
    private readonly onStaleChain?: (chain: OptionsChain, assessment: GreekAssessment, todayEt: string) => void,
  ) {}

  /**
   * Attempt to renew a dormant token (inactive > 2 h, same calendar day).
   * Throws if the token is fully expired (midnight rollover) — caller must
   * detect that and prompt the user to re-auth in Settings → E*Trade Connection.
   */
  async renewToken(): Promise<void> {
    await renewAccessToken(this.getCreds());
  }

  /**
   * Run an E*Trade call; on ANY failure, renew the token once and retry. This makes
   * the on-demand options path (API-server options route, TraderAgent scout, Strategy
   * Lab, and the v2 execution engine's entry-time re-pricing) self-heal from token
   * dormancy — without it, any options fetch made > 2 h after the last E*Trade activity
   * returned an empty chain (silently swallowed by the route's per-expiration catch).
   *
   * We renew on any error, not just auth-shaped ones: a dormant token (idle > 2 h) does
   * NOT reliably surface as a 401 — it can kill/hang the response stream (undici
   * `terminated`), which the old auth-message heuristic missed, so the renewal
   * that would have fixed it never ran (observed live 2026-07-01; mirrors the
   * daily-iv-update probe fix v1.1.92). Renewing an active token errors harmlessly
   * (swallowed); a genuine non-auth error (bad symbol, network down) simply fails again
   * on the retry, surfacing the real error. A fully expired token (past midnight ET)
   * makes the retry throw an auth error — the caller must prompt a manual re-auth.
   * see CLAUDE.md (E*Trade dormancy)
   *
   * The one exception (v1.1.355): an HTTP 400 carrying an E*Trade application code is
   * rethrown as is. E*Trade only sends one after accepting the token, so it cannot be
   * dormancy, and renewing and retrying turned every such answer into three calls —
   * measured 2026-10-13: 136 failed chain calls and 89 renews, all from 10032/10033.
   * This is an exemption for a positively identified answer, not a gate on an auth-shaped
   * message: everything else (401s, killed streams, timeouts, 5xx) still renews.
   *
   * 10032/10033 also answer for the whole ticker, so the ticker is remembered for the ET day
   * and later calls for it — any expiration, any job — fail at once with the same error.
   */
  private async withRenew<T>(ticker: string, fn: (creds: OAuthCredentials) => Promise<T>): Promise<T> {
    const key = ticker.toUpperCase();
    const today = etDate();
    const known = this.noOptions.get(key);
    if (known && known.day === today) throw known.error;

    try {
      return await fn(this.getCreds());
    } catch (err) {
      const code = etradeApplicationErrorCode(err);
      if (code !== null) {
        if (TICKER_WIDE_NO_OPTIONS_CODES.has(code)) this.noOptions.set(key, { day: today, error: err as Error });
        throw err;
      }
      try {
        await renewAccessToken(this.getCreds());
      } catch { /* active-token renew errors harmlessly; the retry below decides the outcome */ }
      return await fn(this.getCreds());
    }
  }

  /** Tickers E*Trade answered 10032/10033 for, with the ET day of that answer. */
  private readonly noOptions = new Map<string, { day: string; error: Error }>();

  // ── Expiration Discovery ───────────────────────────────────────────────────

  async getOptionsExpirations(ticker: string): Promise<string[]> {
    const expirations = await this.withRenew(ticker, creds => getETradeExpirations(ticker, creds));
    return expirations.map(e => e.dateStr);
  }

  // ── Chain Fetch ───────────────────────────────────────────────────────────

  async getOptionsChain(ticker: string, expiration: string): Promise<OptionsChain> {
    const expObj = {
      ...parseExpiry(expiration),
      expiryType: 'UNKNOWN',
      dateStr: expiration,
    };
    const result = await this.withRenew(ticker, creds => getETradeOptionsChain(ticker, expObj, creds));

    const contracts: OptionContract[] = [
      ...result.calls.map(leg => legToContract(leg, ticker, expiration)),
      ...result.puts .map(leg => legToContract(leg, ticker, expiration)),
    ];

    const chain: OptionsChain = { ticker: ticker.toUpperCase(), expiration, contracts, underlyingPrice: result.underlyingPrice ?? null };
    // One choke point for every consumer that selects a strike by delta. Off until validated
    // (FR-SEY-5); see greek-consistency.ts for the measurement behind it.
    if (!staleGreekGuardEnabled()) return chain;
    const todayEt = etDate();
    const assessment = assessChainGreeks(chain, todayEt);
    if (assessment.stale && this.onStaleChain) {
      try { this.onStaleChain(chain, assessment, todayEt); } catch { /* shadow log only — never fail the fetch */ }
    }
    return withholdStaleGreeks(chain, assessment, todayEt);
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

      // ATM IV — call+put average at the strike closest to spot (the shared canonical
      // definition; previously this used the closest CALL only, which read differently from
      // the lab's call+put average for the same expiration). see docs/formulas.md#atm-iv
      const atmDecimal = atmIvAtClosestStrike(
        allLegs.map(leg => ({ strike: leg.strikePrice, iv: leg.greek.iv })),
        result.underlyingPrice,
      );
      let atmIv: number | null = atmDecimal !== null ? atmDecimal * 100 : null;
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
