// Polygon.io DataProvider implementation.
// Wraps fetch calls to the Polygon REST API, logs every call (EP-3),
// and surfaces errors through the structured error logger.
// Rate limiting is handled by the pipeline (Phase ≥ 3); this layer makes
// raw calls without its own throttle — it just retries on transient failures.
// see SPEC: §4.2.1, §4.2.3
// see docs/data-provider.md for endpoint-to-method mapping

// Uses the global `fetch` available in Node 18+ (Electron main process).
// No import needed — fetch is a global in Node 22+ ESM.
import type { DataProvider } from './data-provider.js';
import type {
  DerivedRatios,
  Quote,
  Universe,
  ConstituentRow
} from '@shared/types.js';
import { logApiCall, scrubObject } from './logger.js';
import {
  computeRatios,
  type FundamentalsComputerInput
} from './fundamentals-computer.js';

const BASE_URL = 'https://api.polygon.io';

export interface PolygonConfig {
  /** Requests per minute. Passed from settings or defaults. */
  rateLimitRpm?: number;
}

/** Map endpoint → human-readable label for API logs. */
const ENDPOINT_LABELS: Record<string, string> = {
  '/v3/reference/tickers': 'reference:tickers',
  '/v2/snapshot/locale/us/markets/stocks/tickers': 'snapshot:ticker',
  '/v3/snapshot/options': 'snapshot:options',
  '/vX/reference/financials': 'reference:financials',
  '/v3/reference/tickers/{ticker}': 'reference:ticker_details',
  '/v2/aggs/ticker/{ticker}/range': 'aggs:bars',
  '/v3/reference/dividends': 'reference:dividends'
};

function endpointLabel(path: string, ticker?: string): string {
  let label = ENDPOINT_LABELS[path] ?? path;
  if (ticker) label += `:${ticker}`;
  return label;
}

export class PolygonDataProvider implements DataProvider {
  readonly name = 'polygon';
  private readonly baseUrl = BASE_URL;
  private readonly correlationCounter = 0;
  // Simple in-call retry counter (not the rate limiter — that's Phase 3).
  private readonly maxRetries = 3;
  private correlationSeq = 0;

  constructor(
    private readonly getApiKey: () => string,
    _config?: PolygonConfig
  ) {}

  correlationId(): string {
    return `poly-${Date.now()}-${++this.correlationSeq}`;
  }

  private async fetchWithRetry(
    path: string,
    params: Record<string, string> = {},
    retryCount = 0
  ): Promise<Record<string, unknown>> {
    const url = new URL(this.baseUrl + path);
    const apiKey = this.getApiKey();
    if (apiKey) {
      url.searchParams.set('apiKey', apiKey);
    }
    
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const start = Date.now();
    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (err) {
      const latencyMs = Date.now() - start;
      logApiCall({
        timestamp: new Date().toISOString(),
        provider: 'polygon',
        endpoint: endpointLabel(path),
        method: 'GET',
        requestParams: scrubObject(Object.fromEntries(url.searchParams)),
        responseStatus: null,
        responseLatencyMs: latencyMs,
        responseSizeBytes: null,
        retryCount,
        jobRunId: null
      });
      throw err;
    }

    const latencyMs = Date.now() - start;
    const bodyText = await response.text();
    const sizeBytes = new TextEncoder().encode(bodyText).length;

    logApiCall({
      timestamp: new Date().toISOString(),
      provider: 'polygon',
      endpoint: endpointLabel(path),
      method: 'GET',
      requestParams: scrubObject(Object.fromEntries(url.searchParams)),
      responseStatus: response.status,
      responseLatencyMs: latencyMs,
      responseSizeBytes: sizeBytes,
      retryCount,
      jobRunId: null
    });

    // Retry on 5xx or network errors, up to maxRetries.
    if (!response.ok && retryCount < this.maxRetries) {
      const delay = Math.pow(2, retryCount) * 200;
      await new Promise((r) => setTimeout(r, delay));
      return this.fetchWithRetry(path, params, retryCount + 1);
    }

    if (!response.ok) {
      const msg = `Polygon HTTP ${response.status}: ${bodyText.slice(0, 200)}`;
      throw new Error(msg);
    }

    try {
      return JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(`Polygon returned non-JSON at ${path}`);
    }
  }

  async ping(): Promise<void> {
    const data = await this.fetchWithRetry('/v3/reference/tickers', {
      ticker: 'AAPL',
      active: 'true',
      limit: '1'
    });
    if (!data.results) throw new Error('Polygon ping failed: no results');
  }

  async getQuote(ticker: string): Promise<Quote> {
    const data = await this.fetchWithRetry(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`
    ) as {
      ticker?: string;
      last?: { c?: number; p?: number; b?: { p?: number }; a?: { p?: number }; v?: number; h?: number; l?: number };
      prevDay?: { c?: number; v?: number; h?: number; l?: number };
      today?: { v?: number; h?: number; l?: number };
      session?: { av?: number };
    };

    const snapshot = (data as { results?: typeof data }).results ?? {};
    const last = snapshot.last;
    const prev = snapshot.prevDay;

    // IV rank / percentile: computed from 52-week IV range — Polygon doesn't
    // expose this directly in the snapshot, so we store null here.
    // Phase 3's pipeline will compute this post-fetch and update the cache.
    const lastPrice = last?.c ?? prev?.c ?? null;
    const prevClose = prev?.c ?? null;
    void lastPrice; void prevClose; // used in return value below

    return {
      ticker,
      last: lastPrice,
      prevClose,
      bid: last?.b?.p ?? null,
      ask: last?.a?.p ?? null,
      volume: last?.v ?? prev?.v ?? null,
      dayHigh: last?.h ?? prev?.h ?? null,
      dayLow: last?.l ?? prev?.l ?? null,
      ivRank: null,
      ivPercentile: null,
      distance52WkHigh: null,
      distance52WkLow: null,
      fetchedAt: new Date().toISOString()
    };
  }

  async getFundamentals(ticker: string): Promise<DerivedRatios> {
    // Fetch financials + ticker details in parallel.
    const [finData, detailsData] = await Promise.all([
      this.fetchWithRetry('/vX/reference/financials', {
        ticker,
        timeframe: 'TTM',
        limit: '4'
      }),
      this.fetchWithRetry(`/v3/reference/tickers/${ticker}`)
    ]);

    const finResults = (finData.results as unknown[] | undefined) ?? [];
    const details = (detailsData.results as Record<string, unknown> | undefined) ?? {};

    // Patch up the Polygon shapes to match our expected interfaces.
    const financials = {
      ticker,
      company_name: String(details['name'] ?? ticker),
      filings: finResults.map((f) => {
        const ff = f as Record<string, unknown>;
        return {
          date: String(ff['filing_date'] ?? ''),
          start_date: String(ff['start_date'] ?? ''),
          end_date: String(ff['end_date'] ?? ''),
          financials: ff['financials']
        };
      })
    };

    const tickerDetails = {
      market_cap: (details['market_cap'] as number | null) ?? null,
      share_class_shares_outstanding: (details['shares_outstanding'] as number | null) ?? null,
      sector: (details['sector'] as string | null) ?? null,
      industry: (details['industry'] as string | null) ?? null,
      sic_description: (details['sic_description'] as string | null) ?? null
    };

    // Snapshot is needed for current price.
    const snapshot = await this.getQuote(ticker);

    const input: FundamentalsComputerInput = {
      financials: financials as Parameters<typeof computeRatios>[0]['financials'],
      details: tickerDetails as Parameters<typeof computeRatios>[0]['details'],
      snapshot: {
        ticker,
        last: { c: snapshot.last ?? undefined, tr: undefined },
        prev_day: { c: snapshot.prevClose ?? undefined, v: undefined, h: undefined, l: undefined }
      },
      beta: null
    };

    return computeRatios(input);
  }

  async getEarningsCalendar(ticker: string): Promise<{
    ticker: string;
    nextEarningsDate: string | null;
    nextEarningsTime: 'am' | 'pm' | null;
    epsEstimate: number | null;
    epsActualLast4: number[];
  }> {
    // Polygon doesn't expose earnings calendar via public endpoint; return stub.
    // Phase 3 may add this via /v1/reference/earnings_charts or a web scrape.
    return {
      ticker,
      nextEarningsDate: null,
      nextEarningsTime: null,
      epsEstimate: null,
      epsActualLast4: []
    };
  }

  async getHistoricalBars(
    ticker: string,
    timeframe: 'day' | 'week' | 'month',
    lookback: number
  ): Promise<Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>> {
    const multiplier = timeframe === 'day' ? '1' : timeframe === 'week' ? '1' : '1';
    const timespan = timeframe === 'day' ? 'day' : timeframe === 'week' ? 'week' : 'month';
    const to = new Date();
    const from = new Date(Date.now() - lookback * 86_400_000);
    const fromStr = from.toISOString().slice(0, 10);
    const toStr = to.toISOString().slice(0, 10);

    const data = await this.fetchWithRetry(
      `/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${fromStr}/${toStr}`,
      { adjusted: 'true', sort: 'asc', limit: '50000' }
    );

    const results = (data.results as unknown[] | undefined) ?? [];
    return results.map((r) => {
      const bar = r as Record<string, number>;
      const t = bar['t'] ?? 0, o = bar['o'] ?? 0, h = bar['h'] ?? 0, l = bar['l'] ?? 0, c = bar['c'] ?? 0, v = bar['v'] ?? 0;
      return { t, o, h, l, c, v };
    });
  }

  async getOptionsChain(
    ticker: string,
    expiration: string
  ): Promise<{ ticker: string; expiration: string; contracts: Array<{
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
  }> }> {
    const data = await this.fetchWithRetry(
      `/v3/snapshot/options/${ticker}`,
      { expiration_date: expiration }
    );

    const contracts = ((data.results as Record<string, unknown> | undefined)?.[
      'options' as string
    ] as unknown[] | undefined) ?? [];

    return {
      ticker,
      expiration,
      contracts: contracts.map((c) => {
        const co = c as Record<string, unknown>;
        return {
          ticker: String(co['ticker'] ?? ticker),
          expiration,
          strike: Number(co['strike_price'] ?? 0),
          side: String(co['contract_type'] ?? '').toLowerCase().includes('call') ? 'call' : 'put',
          bid: Number(co['bid'] ?? 0),
          ask: Number(co['ask'] ?? 0),
          delta: typeof co['delta'] === 'number' ? (co['delta'] as number) : null,
          gamma: typeof co['gamma'] === 'number' ? (co['gamma'] as number) : null,
          theta: typeof co['theta'] === 'number' ? (co['theta'] as number) : null,
          vega: typeof co['vega'] === 'number' ? (co['vega'] as number) : null,
          iv: typeof co['implied_volatility'] === 'number' ? (co['implied_volatility'] as number) : 0,
          openInterest: typeof co['open_interest'] === 'number' ? (co['open_interest'] as number) : null,
          volume: typeof co['volume'] === 'number' ? (co['volume'] as number) : null
        };
      })
    };
  }

  async getIndexConstituents(_index: Universe): Promise<ConstituentRow[]> {
    // This is a no-op here — constituents are loaded from bundled CSV files
    // by the ConstituentsService. This method exists on the interface for
    // completeness but is not called directly.
    return [];
  }
}