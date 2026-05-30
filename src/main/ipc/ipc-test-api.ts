import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { PolygonDataProvider } from '../services/polygon-provider.js';
import type { MarketDataProvider } from '../services/marketdata-provider.js';
import { computeAtmIv } from '../services/iv-history-service.js';

function ok<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
function fail(err: unknown): { ok: false; error: { code: string; message: string } } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false, error: { code, message } };
}

export interface RawOptionContract {
  // from details
  ticker: string;
  strike: number;
  expiration: string;
  contractType: string;
  exerciseStyle: string;
  // root-level
  impliedVolatility: number | null;
  openInterest: number | null;
  breakEvenPrice: number | null;
  fmv: number | null;
  // greeks sub-object
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  hasGreeks: boolean;
  // last_quote sub-object
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteMidpoint: number | null;
  hasLastQuote: boolean;
  // day sub-object
  dayClose: number | null;
  dayVolume: number | null;
  dayVwap: number | null;
  // last_trade sub-object
  lastTradePrice: number | null;
  // underlying_asset (same for all contracts in a chain)
  underlyingPrice: number | null;
}

export interface TestApiResult {
  ticker: string;
  expiration: string;
  underlyingPrice: number | null;
  totalContracts: number;
  contractsWithGreeks: number;
  contractsWithLastQuote: number;
  contracts: RawOptionContract[];
  // diagnostics
  pages: number;
  polygonStatus: string;
  rawResultsType: string;
  rawResultsCount: number;
  firstPageKeys: string[];
}

function parseRaw(raw: unknown): RawOptionContract {
  const co = raw as Record<string, unknown>;
  const details = (co['details'] as Record<string, unknown>) ?? {};
  const greeks = co['greeks'] as Record<string, unknown> | undefined;
  const lastQuote = co['last_quote'] as Record<string, unknown> | undefined;
  const day = (co['day'] as Record<string, unknown>) ?? {};
  const lastTrade = (co['last_trade'] as Record<string, unknown>) ?? {};
  const underlying = (co['underlying_asset'] as Record<string, unknown>) ?? {};

  const hasGreeks = !!greeks && (
    typeof greeks['delta'] === 'number' ||
    typeof greeks['gamma'] === 'number' ||
    typeof greeks['theta'] === 'number' ||
    typeof greeks['vega'] === 'number'
  );

  const hasLastQuote = !!lastQuote && (
    typeof lastQuote['bid'] === 'number' ||
    typeof lastQuote['ask'] === 'number'
  );

  return {
    ticker: String(details['ticker'] ?? co['ticker'] ?? ''),
    strike: Number(details['strike_price'] ?? co['strike_price'] ?? 0),
    expiration: String(details['expiration_date'] ?? co['expiration_date'] ?? ''),
    contractType: String(details['contract_type'] ?? co['contract_type'] ?? '').toLowerCase(),
    exerciseStyle: String(details['exercise_style'] ?? ''),

    impliedVolatility: typeof co['implied_volatility'] === 'number' ? co['implied_volatility'] as number : null,
    openInterest: typeof co['open_interest'] === 'number' ? co['open_interest'] as number : null,
    breakEvenPrice: typeof co['break_even_price'] === 'number' ? co['break_even_price'] as number : null,
    fmv: typeof co['fmv'] === 'number' ? co['fmv'] as number : null,

    delta: hasGreeks && typeof greeks!['delta'] === 'number' ? greeks!['delta'] as number : null,
    gamma: hasGreeks && typeof greeks!['gamma'] === 'number' ? greeks!['gamma'] as number : null,
    theta: hasGreeks && typeof greeks!['theta'] === 'number' ? greeks!['theta'] as number : null,
    vega: hasGreeks && typeof greeks!['vega'] === 'number' ? greeks!['vega'] as number : null,
    hasGreeks,

    bid: hasLastQuote && typeof lastQuote!['bid'] === 'number' ? lastQuote!['bid'] as number : null,
    ask: hasLastQuote && typeof lastQuote!['ask'] === 'number' ? lastQuote!['ask'] as number : null,
    bidSize: hasLastQuote && typeof lastQuote!['bid_size'] === 'number' ? lastQuote!['bid_size'] as number : null,
    askSize: hasLastQuote && typeof lastQuote!['ask_size'] === 'number' ? lastQuote!['ask_size'] as number : null,
    quoteMidpoint: hasLastQuote && typeof lastQuote!['midpoint'] === 'number' ? lastQuote!['midpoint'] as number : null,
    hasLastQuote,

    dayClose: typeof day['close'] === 'number' ? day['close'] as number : null,
    dayVolume: typeof day['volume'] === 'number' ? day['volume'] as number : null,
    dayVwap: typeof day['vwap'] === 'number' ? day['vwap'] as number : null,

    lastTradePrice: typeof lastTrade['price'] === 'number' ? lastTrade['price'] as number : null,

    underlyingPrice: typeof underlying['price'] === 'number' ? underlying['price'] as number : null,
  };
}

export interface MarketDataTestResult {
  ticker:          string;
  date:            string;
  status:          string;                 // 'ok' | 'no_data' | 'error'
  contractCount:   number;
  underlyingPrice: number | null;          // root-level from response
  // Parsed sample
  sample: Array<{
    optionSymbol: string;
    expiration:   string;
    side:         string;
    strike:       number;
    iv:           number | null;
    delta:        number | null;
    underlyingPrice: number | null;
    dte:          number | null;
  }>;
  // ATM IV computation result
  atmIvResult: {
    atmIv:   number | null;
    atmIvPct: number | null;   // atmIv * 100
    expNear: string | null;
    expFar:  string | null;
    dteNear: number | null;
    dteFar:  number | null;
    estimatedFromDelta: boolean;
  } | null;
  // Coverage breakdown
  withIv:     number;
  withDelta:  number;
  withUndPx:  number;
  // Raw field diagnostics (from unparsed response)
  rawTopLevelKeys:   string[];           // all keys present in the API response
  rawFieldTypes:     Record<string, string>;  // key → type/shape description
  rawContractSample: string;             // JSON of first 2 raw contracts (before parsing)
  // Compact parsed sample as JSON
  rawJsonSample: string;
}

export function registerTestApiIpc(dataProvider: PolygonDataProvider, marketdata?: MarketDataProvider): void {
  ipcMain.handle(
    'test-api:get-raw-options',
    async (_e: IpcMainInvokeEvent, ticker: string, expiration: string) => {
      try {
        const snap = await dataProvider.getRawOptionsSnapshot(
          ticker.toUpperCase(),
          expiration || undefined
        );
        const contracts = snap.contracts.map(parseRaw);
        const underlyingPrice = contracts[0]?.underlyingPrice ?? null;
        return ok<TestApiResult>({
          ticker: ticker.toUpperCase(),
          expiration: expiration || '(none)',
          underlyingPrice,
          totalContracts: contracts.length,
          contractsWithGreeks: contracts.filter(c => c.hasGreeks).length,
          contractsWithLastQuote: contracts.filter(c => c.hasLastQuote).length,
          contracts,
          pages: snap.pages,
          polygonStatus: snap.polygonStatus,
          rawResultsType: snap.rawResultsType,
          rawResultsCount: snap.rawResultsCount,
          firstPageKeys: snap.firstPageKeys,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // MarketData.app chain test — fetches one historical chain, parses it, runs computeAtmIv.
  ipcMain.handle(
    'test-api:get-marketdata-chain',
    async (_e: IpcMainInvokeEvent, ticker: string, date: string) => {
      try {
        if (!marketdata) throw new Error('MarketData.app provider not initialised.');

        // Step 1 — get the RAW unparsed response so we can inspect actual field names.
        const raw = await marketdata.getRawChain(ticker.toUpperCase(), date);

        // Describe each top-level field: type + first-element preview for arrays.
        const rawFieldTypes: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (Array.isArray(v)) {
            const sample0 = v[0];
            const elemType = sample0 === null ? 'null' : typeof sample0;
            rawFieldTypes[k] = `array(${v.length}) of ${elemType} — first: ${JSON.stringify(sample0)}`;
          } else {
            rawFieldTypes[k] = `${typeof v} — ${JSON.stringify(v)}`;
          }
        }

        // Build a raw contract sample: zip first 2 elements of every array field.
        const arrayFields = Object.entries(raw).filter(([, v]) => Array.isArray(v));
        const rawContractRows: Record<string, unknown>[] = [];
        for (let i = 0; i < Math.min(2, (arrayFields[0]?.[1] as unknown[])?.length ?? 0); i++) {
          const row: Record<string, unknown> = {};
          for (const [k, v] of arrayFields) {
            row[k] = (v as unknown[])[i];
          }
          rawContractRows.push(row);
        }

        // Step 2 — run the regular parser + ATM IV computation.
        const chain = await marketdata.getOptionsChain(ticker.toUpperCase(), date);

        if (chain.s !== 'ok') {
          return ok<MarketDataTestResult>({
            ticker: ticker.toUpperCase(), date, status: chain.s,
            contractCount: 0, underlyingPrice: null,
            sample: [], atmIvResult: null,
            withIv: 0, withDelta: 0, withUndPx: 0,
            rawTopLevelKeys: Object.keys(raw),
            rawFieldTypes,
            rawContractSample: JSON.stringify(rawContractRows, null, 2),
            rawJsonSample: JSON.stringify(raw, null, 2).slice(0, 2000),
          });
        }

        const { contracts, underlyingPrice } = chain;

        // Delta-based ATM fallback (mirrors iv-history-service logic)
        let resolvedUndPx = underlyingPrice;
        let estimatedFromDelta = false;
        if (resolvedUndPx === null) {
          const byDelta = contracts
            .filter(c => c.side === 'call' && c.delta !== null)
            .sort((a, b) => Math.abs(Math.abs(a.delta!) - 0.5) - Math.abs(Math.abs(b.delta!) - 0.5));
          if (byDelta[0]) { resolvedUndPx = byDelta[0].strike; estimatedFromDelta = true; }
        }

        const atmRaw = resolvedUndPx !== null ? computeAtmIv(contracts, resolvedUndPx) : null;
        const atmIvResult = atmRaw
          ? { ...atmRaw, atmIvPct: Math.round(atmRaw.atmIv * 10000) / 100, estimatedFromDelta }
          : (resolvedUndPx !== null
              ? { atmIv: null, atmIvPct: null, expNear: null, expFar: null, dteNear: null, dteFar: null, estimatedFromDelta }
              : null);

        // Near-ATM sample (8 contracts)
        const nearAtm = resolvedUndPx ?? 0;
        const sorted = [...contracts].sort((a, b) => Math.abs(a.strike - nearAtm) - Math.abs(b.strike - nearAtm));
        const sample = sorted.slice(0, 8).map(c => ({
          optionSymbol: c.optionSymbol, expiration: c.expiration, side: c.side,
          strike: c.strike, iv: c.iv, delta: c.delta,
          underlyingPrice: c.underlyingPrice, dte: c.dte,
        }));

        return ok<MarketDataTestResult>({
          ticker: ticker.toUpperCase(), date, status: 'ok',
          contractCount: contracts.length,
          underlyingPrice,
          sample,
          atmIvResult: atmIvResult ?? null,
          withIv:    contracts.filter(c => c.iv !== null).length,
          withDelta: contracts.filter(c => c.delta !== null).length,
          withUndPx: contracts.filter(c => c.underlyingPrice !== null).length,
          rawTopLevelKeys: Object.keys(raw),
          rawFieldTypes,
          rawContractSample: JSON.stringify(rawContractRows, null, 2),
          rawJsonSample: JSON.stringify({
            s: chain.s, underlyingPrice, contractCount: contracts.length,
            parsedFirst4: contracts.slice(0, 4).map(c => ({
              sym: c.optionSymbol, exp: c.expiration, side: c.side,
              strike: c.strike, iv: c.iv, delta: c.delta,
              undPx: c.underlyingPrice, dte: c.dte,
            })),
          }, null, 2),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
