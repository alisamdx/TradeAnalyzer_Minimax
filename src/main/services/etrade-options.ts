/**
 * E*Trade options data fetcher.
 * Uses etrade-auth.ts for all signed requests.
 *
 * Endpoints used:
 *   GET /v1/market/optionexpiredate  — list all expiration dates for a symbol
 *   GET /v1/market/optionchains     — full options chain for a symbol + expiration
 */

import { etradeGet, type OAuthCredentials } from './etrade-auth.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ETradeExpiration {
  year: number;
  month: number;
  day: number;
  expiryType: string;           // WEEKLY, MONTHLY, QUARTERLY, etc.
  dateStr: string;              // 'YYYY-MM-DD' — computed
}

export interface ETradeOptionGreek {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega:  number | null;
  rho:   number | null;
  iv:    number | null;         // implied volatility (decimal, e.g. 0.285)
}

export interface ETradeOptionLeg {
  symbol:           string;
  osiKey:           string;
  optionType:       'CALL' | 'PUT';
  strikePrice:      number;
  bid:              number | null;
  ask:              number | null;
  bidSize:          number | null;
  askSize:          number | null;
  lastPrice:        number | null;
  volume:           number | null;
  openInterest:     number | null;
  inTheMoney:       boolean;
  greek:            ETradeOptionGreek;
  // diagnostics
  hasGreeks:        boolean;
  hasBidAsk:        boolean;
}

export interface ETradeOptionsChainResult {
  ticker:          string;
  expiration:      string;    // 'YYYY-MM-DD'
  underlyingPrice: number | null;
  calls:           ETradeOptionLeg[];
  puts:            ETradeOptionLeg[];
  totalContracts:  number;
  withGreeks:      number;
  withBidAsk:      number;
  // diagnostics
  rawTopLevelKeys:  string[];
  pairsCount:       number;
  rawSampleCall:    string;   // JSON of first Call object — reveals actual field names
  rawSamplePut:     string;   // JSON of first Put object
  rawResponseKeys:  string[]; // keys inside OptionChainResponse
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true' || v.toLowerCase() === 'y';
  return false;
}

function parseGreek(raw: Record<string, unknown>): ETradeOptionGreek {
  return {
    delta: num(raw['delta']),
    gamma: num(raw['gamma']),
    theta: num(raw['theta']),
    vega:  num(raw['vega']),
    rho:   num(raw['rho']),
    iv:    num(raw['iv']),
  };
}

function parseLeg(raw: Record<string, unknown>, side: 'CALL' | 'PUT'): ETradeOptionLeg {
  const greekRaw = (raw['OptionGreeks'] ?? raw['optionGreeks'] ?? raw['OptionGreek'] ?? raw['optionGreek']) as Record<string, unknown> | undefined;
  const greek = greekRaw ? parseGreek(greekRaw) : { delta: null, gamma: null, theta: null, vega: null, rho: null, iv: null };

  const bid = num(raw['bid']);
  const ask = num(raw['ask']);

  return {
    symbol:       String(raw['symbol'] ?? raw['displaySymbol'] ?? ''),
    osiKey:       String(raw['osiKey'] ?? ''),
    optionType:   side,
    strikePrice:  num(raw['strikePrice']) ?? 0,
    bid,
    ask,
    bidSize:      num(raw['bidSize']),
    askSize:      num(raw['askSize']),
    lastPrice:    num(raw['lastPrice']),
    volume:       num(raw['volume']),
    openInterest: num(raw['openInterest']),
    inTheMoney:   bool(raw['inTheMoney']),
    greek,
    hasGreeks:    greek.delta !== null || greek.gamma !== null,
    hasBidAsk:    bid !== null && ask !== null,
  };
}

// ─── Expiration Dates ─────────────────────────────────────────────────────────

export async function getETradeExpirations(
  symbol: string,
  creds: OAuthCredentials
): Promise<ETradeExpiration[]> {
  const data = await etradeGet(
    '/v1/market/optionexpiredate',
    { symbol: symbol.toUpperCase(), expiryType: 'ALL' },
    creds
  );

  // Response: { "OptionExpireDateResponse": { "ExpirationDate": [...] } }
  const wrapper = (data['OptionExpireDateResponse'] ?? data) as Record<string, unknown>;
  const rawList = wrapper['ExpirationDate'] ?? wrapper['expirationDate'];
  if (!Array.isArray(rawList)) return [];

  return rawList.map((item: unknown) => {
    const d = item as Record<string, unknown>;
    const y = Number(d['year']  ?? d['Year']);
    const m = Number(d['month'] ?? d['Month']);
    const day = Number(d['day'] ?? d['Day']);
    const mm  = String(m).padStart(2, '0');
    const dd  = String(day).padStart(2, '0');
    return {
      year: y, month: m, day,
      expiryType: String(d['expiryType'] ?? d['ExpiryType'] ?? 'UNKNOWN'),
      dateStr: `${y}-${mm}-${dd}`,
    };
  }).sort((a, b) => a.dateStr.localeCompare(b.dateStr));
}

// ─── Options Chain ────────────────────────────────────────────────────────────

export async function getETradeOptionsChain(
  symbol: string,
  expiration: ETradeExpiration,
  creds: OAuthCredentials
): Promise<ETradeOptionsChainResult> {
  const data = await etradeGet(
    '/v1/market/optionchains',
    {
      symbol:     symbol.toUpperCase(),
      expiryYear:  String(expiration.year),
      expiryMonth: String(expiration.month),
      expiryDay:   String(expiration.day),
      chainType:  'CALLPUT',
      priceType:  'ALL',
    },
    creds
  );

  const topKeys = Object.keys(data);
  // Response: { "OptionChainResponse": { "OptionPair": [...], "underlying": "AAPL", "timeStamp": ... } }
  const resp = (data['OptionChainResponse'] ?? data) as Record<string, unknown>;
  const respKeys = Object.keys(resp);
  const rawPairs = resp['OptionPair'] ?? resp['optionPair'];

  const underlyingPrice = num(resp['currentPrice'] ?? resp['CurrentPrice']);

  const calls: ETradeOptionLeg[] = [];
  const puts:  ETradeOptionLeg[] = [];

  // Capture first raw pair for diagnostics before parsing
  let rawSampleCall = '';
  let rawSamplePut  = '';

  if (Array.isArray(rawPairs)) {
    for (let i = 0; i < rawPairs.length; i++) {
      const p = rawPairs[i] as Record<string, unknown>;
      const callRaw = (p['Call'] ?? p['call']) as Record<string, unknown> | undefined;
      const putRaw  = (p['Put']  ?? p['put'])  as Record<string, unknown> | undefined;
      // Capture first ATM-ish pair for diagnostics
      if (i === 0) {
        if (callRaw) rawSampleCall = JSON.stringify(callRaw, null, 2);
        if (putRaw)  rawSamplePut  = JSON.stringify(putRaw,  null, 2);
      }
      if (callRaw) calls.push(parseLeg(callRaw, 'CALL'));
      if (putRaw)  puts.push(parseLeg(putRaw,  'PUT'));
    }
  }

  const allLegs = [...calls, ...puts];
  return {
    ticker:          symbol.toUpperCase(),
    expiration:      expiration.dateStr,
    underlyingPrice,
    calls,
    puts,
    totalContracts:  allLegs.length,
    withGreeks:      allLegs.filter(l => l.hasGreeks).length,
    withBidAsk:      allLegs.filter(l => l.hasBidAsk).length,
    rawTopLevelKeys:  topKeys,
    pairsCount:       Array.isArray(rawPairs) ? rawPairs.length : 0,
    rawSampleCall,
    rawSamplePut,
    rawResponseKeys:  respKeys,
  };
}
