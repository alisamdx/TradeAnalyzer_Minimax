import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { PolygonDataProvider } from '../services/polygon-provider.js';

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

export function registerTestApiIpc(dataProvider: PolygonDataProvider): void {
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
}
