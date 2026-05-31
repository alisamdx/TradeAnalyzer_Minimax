// MarketData.app HTTP client — used exclusively for IV history backfill and gap-fill.
// Authentication: Bearer token stored encrypted in settings ('marketdataApiToken').
// Rate limited via a dedicated TokenBucketRateLimiter instance (separate from Polygon).
//
// IMPORTANT — how the 'date' parameter works:
//   MarketData.app's /options/chain/{symbol}/?date=YYYY-MM-DD treats 'date' as an
//   EXPIRATION DATE filter, not a snapshot/as-of date. It returns contracts for the
//   monthly expiration nearest to (and ≤) the given date. To get meaningful IV for
//   a given as-of date use getChainForDate(), which queries the two monthly expirations
//   that bracket as-of+30 days and computes DTE relative to the as-of date.
//   see docs/formulas.md#iv-history

import { TokenBucketRateLimiter } from './rate-limiter.js';

export interface MarketDataContract {
  optionSymbol: string;
  expiration:   string;          // YYYY-MM-DD
  strike:       number;
  side:         'call' | 'put';
  iv:           number | null;   // decimal (0.285 = 28.5%); BS-computed if API returns null
  ivSource:     'api' | 'bs' | null;  // how IV was obtained
  delta:        number | null;
  underlyingPrice: number | null;
  dte:          number | null;   // calendar days from asOfDate to expiration
}

export interface MarketDataChainResult {
  s:               string;       // 'ok' | 'no_data' | 'error'
  contracts:       MarketDataContract[];
  underlyingPrice: number | null;
}

const BASE_URL = 'https://api.marketdata.app/v1';

// ─── Black-Scholes IV computation ─────────────────────────────────────────────
// Used as a fallback when the MarketData.app API returns null IV (common for
// historical chains). We compute IV from the bid/ask midpoint using bisection.
// see docs/formulas.md#bs-iv

/** Normal CDF — Abramowitz & Stegun 26.2.17, max error 7.5e-8. */
function normcdf(x: number): number {
  const a0 = 0.31938153, a1 = -0.356563782, a2 = 1.781477937;
  const a3 = -1.821255978, a4 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = k * (a0 + k * (a1 + k * (a2 + k * (a3 + k * a4))));
  const pdf  = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  return x >= 0 ? 1 - pdf * poly : pdf * poly;
}

/** Black-Scholes European option price. T in years. r annualised continuously compounded. */
function bsPrice(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return isCall
    ? S * normcdf(d1) - K * Math.exp(-r * T) * normcdf(d2)
    : K * Math.exp(-r * T) * normcdf(-d2) - S * normcdf(-d1);
}

/**
 * Implied volatility via bisection (200 iterations, tolerance 1e-7).
 * Returns null if no valid IV exists (deep ITM/OTM, expired, or degenerate inputs).
 * r = annualised risk-free rate (0.05 = 5%). T = years to expiry.
 */
export function bsIv(
  S: number, K: number, T: number, r: number,
  marketPrice: number, isCall: boolean,
): number | null {
  if (T <= 0 || S <= 0 || K <= 0 || marketPrice <= 0) return null;
  // Reject if market price ≤ discounted intrinsic (no time value → IV undefined)
  const floor = Math.max(isCall ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S, 0);
  if (marketPrice <= floor + 1e-6) return null;

  let lo = 1e-6, hi = 20.0; // 0.001% to 2000% IV
  let mid = 0;
  for (let i = 0; i < 200; i++) {
    mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, mid, isCall);
    if (Math.abs(p - marketPrice) < 1e-7 || (hi - lo) < 1e-9) break;
    if (p < marketPrice) lo = mid; else hi = mid;
  }
  // Sanity: reject extreme IVs (< 0.5% or > 500%)
  return mid >= 0.005 && mid <= 5.0 ? mid : null;
}

// ─── Expiration calendar helpers ───────────────────────────────────────────────

/**
 * Return the 3rd Friday of the given month (0-indexed).
 * Standard US monthly options expiration.
 */
function thirdFriday(year: number, month: number): Date {
  // Find the first Friday of the month
  const d = new Date(Date.UTC(year, month, 1));
  const dow = d.getUTCDay();                     // 0=Sun … 6=Sat
  const firstFriday = (5 - dow + 7) % 7;        // days until first Friday
  return new Date(Date.UTC(year, month, 1 + firstFriday + 14)); // +14 = 3rd Friday
}

/**
 * Given a target date, return the two monthly option expirations (3rd Fridays)
 * that straddle it — the one just before and the one just after.
 */
function bracketMonthlyExps(target: Date): [Date, Date] {
  // Start from the month of target; walk forward/back to find the bracket.
  let year = target.getUTCFullYear();
  let month = target.getUTCMonth();

  // Find the 3rd Friday of the target month.
  const expThisMonth = thirdFriday(year, month);

  // If target is before or on this month's expiration, near=prev month's 3rd Friday, far=this month's
  if (target <= expThisMonth) {
    const prevMonth = month === 0 ? 11 : month - 1;
    const prevYear  = month === 0 ? year - 1 : year;
    return [thirdFriday(prevYear, prevMonth), expThisMonth];
  }

  // Otherwise near=this month's, far=next month's
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear  = month === 11 ? year + 1 : year;
  return [expThisMonth, thirdFriday(nextYear, nextMonth)];
}

function toYMD(d: Date): string {
  return d.toISOString().split('T')[0] ?? '';
}

// ─── Provider class ────────────────────────────────────────────────────────────

export class MarketDataProvider {
  readonly limiter: TokenBucketRateLimiter;

  constructor(
    private readonly getToken: () => string,
    requestsPerMinute = 50,
  ) {
    this.limiter = new TokenBucketRateLimiter({ requestsPerMinute });
  }

  updateRate(rpm: number): void {
    this.limiter.setRate(rpm);
  }

  /** Returns the raw unparsed JSON object — used by the Test API screen to inspect field names. */
  async getRawChain(ticker: string, date: string): Promise<Record<string, unknown>> {
    await this.limiter.acquire();
    const token = this.getToken();
    if (!token) throw new Error('MarketData.app API token not configured.');
    const url = `${BASE_URL}/options/chain/${encodeURIComponent(ticker.toUpperCase())}/?date=${encodeURIComponent(date)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MarketData.app error (${res.status}): ${body.slice(0, 300)}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Fetch the options chain for a specific expiration date.
   * @param expirationDate  YYYY-MM-DD — passed as the 'date' param to the API
   * @param asOfDate        YYYY-MM-DD — used to compute DTE (defaults to expirationDate)
   */
  async getOptionsChain(
    ticker: string,
    expirationDate: string,
    asOfDate?: string,
  ): Promise<MarketDataChainResult> {
    await this.limiter.acquire();

    const token = this.getToken();
    if (!token) throw new Error('MarketData.app API token not configured. Add it in Settings → Data Sources.');

    const url = `${BASE_URL}/options/chain/${encodeURIComponent(ticker.toUpperCase())}/?date=${encodeURIComponent(expirationDate)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    });

    if (res.status === 404) return { s: 'no_data', contracts: [], underlyingPrice: null };

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) throw new Error(`MarketData.app rate limit exceeded (429). Reduce daily credits or wait.`);
      throw new Error(`MarketData.app error (${res.status}) for ${ticker} exp ${expirationDate}: ${body.slice(0, 200)}`);
    }

    const raw = await res.json() as Record<string, unknown>;

    if (raw['s'] === 'no_data') return { s: 'no_data', contracts: [], underlyingPrice: null };
    if (raw['s'] === 'error')   throw new Error(`MarketData.app: ${String(raw['errmsg'] ?? 'unknown error')}`);

    return parseChainResponse(raw, asOfDate ?? expirationDate);
  }

  /**
   * High-level helper used by the IV history service.
   * For a given as-of date, finds the two monthly expirations that bracket
   * (as-of + 30 days) and fetches both chains.  DTE is computed relative to
   * the as-of date so computeAtmIv() sees the correct 30-day window.
   *
   * Two API calls per ticker/date — counts against the daily credit quota.
   */
  async getChainForDate(ticker: string, asOfDate: string): Promise<MarketDataChainResult> {
    const target = new Date(asOfDate + 'T00:00:00Z');
    target.setUTCDate(target.getUTCDate() + 30);          // as-of + 30 days
    const [nearExp, farExp] = bracketMonthlyExps(target);

    const [nearResult, farResult] = await Promise.all([
      this.getOptionsChain(ticker, toYMD(nearExp), asOfDate),
      this.getOptionsChain(ticker, toYMD(farExp),  asOfDate),
    ]);

    // Combine — keep all contracts from both expirations.
    const contracts = [...nearResult.contracts, ...farResult.contracts];
    const underlyingPrice = nearResult.underlyingPrice ?? farResult.underlyingPrice;
    return { s: 'ok', contracts, underlyingPrice };
  }
}

// ─── Response parser ───────────────────────────────────────────────────────────

/**
 * Convert a MarketData.app expiration value to a YYYY-MM-DD string.
 * Historical chains return Unix timestamps (seconds); live chains return ISO strings.
 */
function toExpirationDate(v: unknown): string {
  if (typeof v === 'number') {
    // Unix timestamp in seconds → YYYY-MM-DD (UTC date)
    return new Date(v * 1000).toISOString().split('T')[0] ?? '';
  }
  return String(v ?? '').split('T')[0] ?? '';
}

function parseChainResponse(raw: Record<string, unknown>, asOfDate: string): MarketDataChainResult {
  // MarketData.app returns parallel arrays — one element per contract.
  const syms    = (raw['optionSymbol'] as unknown[]         | undefined) ?? [];
  const exps    = (raw['expiration']   as unknown[]         | undefined) ?? [];
  const sides   = (raw['side']         as string[]          | undefined) ?? [];
  const strikes = (raw['strike']       as number[]          | undefined) ?? [];
  const ivs     = (raw['iv']           as (number | null)[] | undefined) ?? [];
  const deltas  = (raw['delta']        as (number | null)[] | undefined) ?? [];
  const mids    = (raw['mid']          as (number | null)[] | undefined) ?? [];

  // The API's 'dte' field is relative to today (not the asOfDate), so we ignore
  // it and recompute from the parsed expiration date.
  const asOfMs = new Date(asOfDate + 'T00:00:00Z').getTime();

  // underlyingPrice: single scalar or parallel array — handle both.
  const undPxRaw = raw['underlyingPrice'];
  const rootUndPx: number | null = typeof undPxRaw === 'number' ? undPxRaw : null;
  const undPxArr: (number | null)[] = Array.isArray(undPxRaw) ? (undPxRaw as (number | null)[]) : [];

  const contracts: MarketDataContract[] = [];
  for (let i = 0; i < syms.length; i++) {
    const side = String(sides[i] ?? '').toLowerCase();
    if (side !== 'call' && side !== 'put') continue;

    // Normalise expiration: API may return Unix timestamps for historical queries.
    const expiration = toExpirationDate(exps[i]);

    // Recompute DTE relative to the as-of date (not today).
    // see docs/formulas.md#trading-days
    let dte: number | null = null;
    if (expiration) {
      const expMs = new Date(expiration + 'T00:00:00Z').getTime();
      if (!isNaN(expMs)) dte = Math.round((expMs - asOfMs) / 86400000);
    }

    // Skip expired/expiring contracts — they carry no meaningful IV.
    if (dte !== null && dte < 1) continue;

    const perContractPx = typeof undPxArr[i] === 'number' ? (undPxArr[i] as number) : null;
    const contractUndPx = perContractPx ?? rootUndPx;

    // IV: prefer API value; fall back to Black-Scholes from mid price.
    // see docs/formulas.md#bs-iv
    const apiIv = typeof ivs[i] === 'number' ? (ivs[i] as number) : null;
    let iv: number | null = apiIv;
    let ivSource: 'api' | 'bs' | null = apiIv !== null ? 'api' : null;

    if (iv === null && dte !== null && dte >= 1 && contractUndPx !== null) {
      const mid = typeof mids[i] === 'number' ? (mids[i] as number) : null;
      if (mid !== null) {
        const T = dte / 365;
        const K = Number(strikes[i] ?? 0);
        const computed = bsIv(contractUndPx, K, T, 0.05, mid, side === 'call');
        if (computed !== null) { iv = computed; ivSource = 'bs'; }
      }
    }

    contracts.push({
      optionSymbol:    String(syms[i] ?? ''),
      expiration,
      strike:          Number(strikes[i] ?? 0),
      side:            side as 'call' | 'put',
      iv,
      ivSource,
      delta:           typeof deltas[i] === 'number' ? (deltas[i] as number) : null,
      underlyingPrice: contractUndPx,
      dte,
    });
  }

  const firstUnderlying = rootUndPx ?? contracts.find(c => c.underlyingPrice !== null)?.underlyingPrice ?? null;
  return { s: 'ok', contracts, underlyingPrice: firstUnderlying };
}
