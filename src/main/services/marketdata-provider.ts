// MarketData.app HTTP client — used exclusively for IV history backfill and gap-fill.
// Authentication: Bearer token stored encrypted in settings ('marketdataApiToken').
// Rate limited via a dedicated TokenBucketRateLimiter instance (separate from Polygon).

import { TokenBucketRateLimiter } from './rate-limiter.js';

export interface MarketDataContract {
  optionSymbol: string;
  expiration:   string;          // YYYY-MM-DD
  strike:       number;
  side:         'call' | 'put';
  iv:           number | null;   // decimal (0.285 = 28.5%)
  delta:        number | null;
  underlyingPrice: number | null;
  dte:          number | null;
}

export interface MarketDataChainResult {
  s:               string;       // 'ok' | 'no_data' | 'error'
  contracts:       MarketDataContract[];
  underlyingPrice: number | null;
}

const BASE_URL = 'https://api.marketdata.app/v1';

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

  async getOptionsChain(ticker: string, date: string): Promise<MarketDataChainResult> {
    await this.limiter.acquire();

    const token = this.getToken();
    if (!token) throw new Error('MarketData.app API token not configured. Add it in Settings → Data Sources.');

    const url = `${BASE_URL}/options/chain/${encodeURIComponent(ticker.toUpperCase())}/?date=${encodeURIComponent(date)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    });

    if (res.status === 404) return { s: 'no_data', contracts: [], underlyingPrice: null };

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) throw new Error(`MarketData.app rate limit exceeded (429). Reduce daily credits or wait.`);
      throw new Error(`MarketData.app error (${res.status}) for ${ticker} on ${date}: ${body.slice(0, 200)}`);
    }

    const raw = await res.json() as Record<string, unknown>;

    if (raw['s'] === 'no_data') return { s: 'no_data', contracts: [], underlyingPrice: null };
    if (raw['s'] === 'error')   throw new Error(`MarketData.app: ${String(raw['errmsg'] ?? 'unknown error')}`);

    return parseChainResponse(raw);
  }
}

function parseChainResponse(raw: Record<string, unknown>): MarketDataChainResult {
  // MarketData.app returns parallel arrays — one element per contract.
  const syms    = (raw['optionSymbol']   as string[]           | undefined) ?? [];
  const exps    = (raw['expiration']     as string[]           | undefined) ?? [];
  const sides   = (raw['side']           as string[]           | undefined) ?? [];
  const strikes = (raw['strike']         as number[]           | undefined) ?? [];
  const ivs     = (raw['iv']             as (number | null)[]  | undefined) ?? [];
  const deltas  = (raw['delta']          as (number | null)[]  | undefined) ?? [];
  const undPxs  = (raw['underlyingPrice'] as (number | null)[] | undefined) ?? [];
  const dtes    = (raw['dte']            as (number | null)[]  | undefined) ?? [];

  const contracts: MarketDataContract[] = [];
  for (let i = 0; i < syms.length; i++) {
    const side = String(sides[i] ?? '').toLowerCase();
    if (side !== 'call' && side !== 'put') continue;
    contracts.push({
      optionSymbol:    String(syms[i] ?? ''),
      expiration:      String(exps[i] ?? ''),
      strike:          Number(strikes[i] ?? 0),
      side:            side as 'call' | 'put',
      iv:              typeof ivs[i] === 'number'    ? (ivs[i] as number)    : null,
      delta:           typeof deltas[i] === 'number' ? (deltas[i] as number) : null,
      underlyingPrice: typeof undPxs[i] === 'number' ? (undPxs[i] as number) : null,
      dte:             typeof dtes[i] === 'number'   ? (dtes[i] as number)   : null,
    });
  }

  const firstUnderlying = contracts.find(c => c.underlyingPrice !== null)?.underlyingPrice ?? null;
  return { s: 'ok', contracts, underlyingPrice: firstUnderlying };
}
