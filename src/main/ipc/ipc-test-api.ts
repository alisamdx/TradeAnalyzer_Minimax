import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { PolygonDataProvider } from '../services/polygon-provider.js';
import type { MarketDataProvider, MarketDataContract } from '../services/marketdata-provider.js';
import { nearestMonthlyExpFor30Dte } from '../services/marketdata-provider.js';
import type { IVolatilityProvider } from '../services/ivolatility-provider.js';
import type { DbHandle } from '../db/connection.js';
import { secureGet, secureSet } from '../services/secure-settings.js';
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
  withBsIv:   number;    // subset of withIv computed via Black-Scholes (API returned null)
  withDelta:  number;
  withUndPx:  number;
  // Raw field diagnostics (from unparsed response)
  rawTopLevelKeys:   string[];           // all keys present in the API response
  rawFieldTypes:     Record<string, string>;  // key → type/shape description
  rawContractSample: string;             // JSON of first 2 raw contracts (before parsing)
  // Compact parsed sample as JSON
  rawJsonSample: string;
}

// ─── IVolatility result type ──────────────────────────────────────────────────

export interface IVolatilityTestResult {
  symbol:   string;
  from:     string;
  to:       string;
  status:   string;
  rowCount: number;
  // Parsed rows (all, sorted ascending — UI can slice for display)
  rows: Array<{
    date:  string;
    iv30:  number | null;
    iv60:  number | null;
    iv90:  number | null;
    iv7:   number | null;
    iv14:  number | null;
    iv21:  number | null;
    iv120: number | null;
    iv180: number | null;
    iv360: number | null;
  }>;
  // iv30 summary stats
  iv30Min:    number | null;
  iv30Max:    number | null;
  iv30Latest: number | null;
  iv30LatestDate: string | null;
  // Raw diagnostics
  rawTopLevelKeys: string[];
  rawFieldTypes:   Record<string, string>;
  rawSample:       string;   // JSON of first 3 raw rows
}

// ─── SEC EDGAR helpers (module-level) ────────────────────────────────────────

const EDGAR_HEADERS = { 'User-Agent': 'TradeAnalyzer/1.0 trader@local' };

// Session-level CIK lookup cache — avoids re-fetching the 500 KB tickers file.
let _edgarCikCache: Map<string, { cikPadded: string; title: string }> | null = null;

async function resolveEdgarCik(ticker: string): Promise<{ cikPadded: string; title: string }> {
  if (!_edgarCikCache) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: EDGAR_HEADERS });
    if (!r.ok) throw new Error(`SEC company_tickers.json HTTP ${r.status}`);
    const raw = await r.json() as Record<string, { cik_str: number | string; ticker: string; title: string }>;
    _edgarCikCache = new Map();
    for (const entry of Object.values(raw)) {
      const cikNum = typeof entry.cik_str === 'string' ? parseInt(entry.cik_str, 10) : entry.cik_str;
      _edgarCikCache.set(entry.ticker.toUpperCase(), {
        cikPadded: String(cikNum).padStart(10, '0'),
        title: entry.title,
      });
    }
  }
  const info = _edgarCikCache.get(ticker);
  if (!info) throw new Error(`"${ticker}" not found in SEC company_tickers.json (${_edgarCikCache.size} tickers indexed — OTC/foreign tickers may not be listed)`);
  return info;
}

interface EdgarEntry { end: string; val: number; fp: string; form: string; filed: string }

function pickEdgarLatest(entries: EdgarEntry[], form: '10-K' | '10-Q'): EdgarEntry | null {
  return [...entries].filter(e => e.form === form).sort((a, b) => b.end.localeCompare(a.end))[0] ?? null;
}

// The 11 financial concepts that computeRatios() needs, mapped to US-GAAP concept name(s).
// Listed in priority order — first match wins.
const EDGAR_FIELD_SPECS: ReadonlyArray<{ role: string; label: string; concepts: readonly string[] }> = [
  { role: 'revenue',      label: 'Revenue',               concepts: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
  { role: 'net_income',   label: 'Net Income',            concepts: ['NetIncomeLoss', 'NetIncome', 'ProfitLoss'] },
  { role: 'op_income',    label: 'Operating Income',      concepts: ['OperatingIncomeLoss'] },
  { role: 'depreciation', label: 'Depreciation & Amort',  concepts: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'DepreciationAmortizationAndAccretionNet'] },
  { role: 'equity',       label: "Stockholders' Equity",  concepts: ['StockholdersEquity', 'StockholdersEquityAttributableToParent'] },
  { role: 'assets_cur',   label: 'Current Assets',        concepts: ['AssetsCurrent'] },
  { role: 'liab_cur',     label: 'Current Liabilities',   concepts: ['LiabilitiesCurrent'] },
  { role: 'debt_lt',      label: 'Long-term Debt',        concepts: ['LongTermDebt', 'LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'] },
  { role: 'cash',         label: 'Cash & Equivalents',    concepts: ['CashAndCashEquivalentsAtCarryingValue', 'Cash', 'CashCashEquivalentsAndShortTermInvestments'] },
  { role: 'op_cf',        label: 'Operating Cash Flow',   concepts: ['NetCashProvidedByUsedInOperatingActivities'] },
  { role: 'capex',        label: 'CapEx',                  concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'CapitalExpendituresIncurringObligation'] },
];

export interface EdgarFieldResult {
  role: string;
  label: string;
  conceptUsed: string | null;
  conceptsTried: string[];
  unit: string | null;
  found: boolean;
  latestAnnualVal: number | null;
  latestAnnualDate: string | null;
  latestQtrVal: number | null;
  latestQtrDate: string | null;
  annualCount: number;
  quarterlyCount: number;
}

export interface EdgarTestResult {
  ticker: string;
  cik: string;
  entityName: string;
  fields: EdgarFieldResult[];
  totalConceptCount: number;
  topGaapConcepts: string[];
  rawSample: string;
}

export function registerTestApiIpc(
  dataProvider: PolygonDataProvider,
  db: DbHandle,
  marketdata?: MarketDataProvider,
  ivolatility?: IVolatilityProvider,
): void {
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

        // Step 2 — run the full pipeline: query the two monthly expirations
        // that bracket (date + 30 days) and combine their contracts.
        // This mirrors exactly what iv-history-service does during backfill.
        const chain = await marketdata.getChainForDate(ticker.toUpperCase(), date);

        const { contracts, underlyingPrice } = chain;

        if (contracts.length === 0) {
          return ok<MarketDataTestResult>({
            ticker: ticker.toUpperCase(), date, status: 'no_data',
            contractCount: 0, underlyingPrice: null,
            sample: [], atmIvResult: null,
            withIv: 0, withBsIv: 0, withDelta: 0, withUndPx: 0,
            rawTopLevelKeys: Object.keys(raw),
            rawFieldTypes,
            rawContractSample: JSON.stringify(rawContractRows, null, 2),
            rawJsonSample: JSON.stringify(raw, null, 2).slice(0, 2000),
          });
        }

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

        const withBsIv = (contracts as MarketDataContract[]).filter(c => c.ivSource === 'bs').length;

        return ok<MarketDataTestResult>({
          ticker: ticker.toUpperCase(), date, status: 'ok',
          contractCount: contracts.length,
          underlyingPrice,
          sample,
          atmIvResult: atmIvResult ?? null,
          withIv:    contracts.filter(c => c.iv !== null).length,
          withBsIv,
          withDelta: contracts.filter(c => c.delta !== null).length,
          withUndPx: contracts.filter(c => c.underlyingPrice !== null).length,
          rawTopLevelKeys: Object.keys(raw),
          rawFieldTypes,
          rawContractSample: JSON.stringify(rawContractRows, null, 2),
          rawJsonSample: JSON.stringify({
            status: 'ok', asOfDate: date, underlyingPrice,
            contractCount: contracts.length,
            withBsIv,
            expirations: [...new Set(contracts.map(c => c.expiration))],
            parsedFirst4: (contracts as MarketDataContract[]).slice(0, 4).map(c => ({
              sym: c.optionSymbol, exp: c.expiration, side: c.side,
              strike: c.strike, iv: c.iv, ivSource: c.ivSource,
              delta: c.delta, undPx: c.underlyingPrice, dte: c.dte,
            })),
          }, null, 2),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // MarketData.app LIVE chain test — fetches today's chain using ?expiration= (not ?date=).
  // Auto-selects the nearest monthly expiration to 30 DTE.
  ipcMain.handle(
    'test-api:get-marketdata-live-chain',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        if (!marketdata) throw new Error('MarketData.app provider not initialised.');

        const expiration = nearestMonthlyExpFor30Dte();

        // Step 1 — raw unparsed response for field diagnostics.
        const raw = await marketdata.getRawLiveChain(ticker.toUpperCase(), expiration);

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

        const arrayFields = Object.entries(raw).filter(([, v]) => Array.isArray(v));
        const rawContractRows: Record<string, unknown>[] = [];
        for (let i = 0; i < Math.min(2, (arrayFields[0]?.[1] as unknown[])?.length ?? 0); i++) {
          const row: Record<string, unknown> = {};
          for (const [k, v] of arrayFields) row[k] = (v as unknown[])[i];
          rawContractRows.push(row);
        }

        // Step 2 — live chain via ?expiration= param.
        const chain = await marketdata.getLiveChain(ticker.toUpperCase(), expiration);
        const { contracts, underlyingPrice } = chain;

        const today = new Date().toISOString().slice(0, 10);

        if (contracts.length === 0) {
          return ok<MarketDataTestResult>({
            ticker: ticker.toUpperCase(), date: today, status: 'no_data',
            contractCount: 0, underlyingPrice: null,
            sample: [], atmIvResult: null,
            withIv: 0, withBsIv: 0, withDelta: 0, withUndPx: 0,
            rawTopLevelKeys: Object.keys(raw),
            rawFieldTypes,
            rawContractSample: JSON.stringify(rawContractRows, null, 2),
            rawJsonSample: JSON.stringify({ expiration, status: 'no_data' }, null, 2),
          });
        }

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

        const nearAtm = resolvedUndPx ?? 0;
        const sorted = [...contracts].sort((a, b) => Math.abs(a.strike - nearAtm) - Math.abs(b.strike - nearAtm));
        const sample = sorted.slice(0, 8).map(c => ({
          optionSymbol: c.optionSymbol, expiration: c.expiration, side: c.side,
          strike: c.strike, iv: c.iv, delta: c.delta,
          underlyingPrice: c.underlyingPrice, dte: c.dte,
        }));

        const withBsIv = (contracts as MarketDataContract[]).filter(c => c.ivSource === 'bs').length;

        return ok<MarketDataTestResult>({
          ticker: ticker.toUpperCase(), date: today, status: 'ok',
          contractCount: contracts.length, underlyingPrice,
          sample, atmIvResult: atmIvResult ?? null,
          withIv:    contracts.filter(c => c.iv !== null).length,
          withBsIv,
          withDelta: contracts.filter(c => c.delta !== null).length,
          withUndPx: contracts.filter(c => c.underlyingPrice !== null).length,
          rawTopLevelKeys: Object.keys(raw),
          rawFieldTypes,
          rawContractSample: JSON.stringify(rawContractRows, null, 2),
          rawJsonSample: JSON.stringify({
            mode: 'live', expiration, underlyingPrice,
            contractCount: contracts.length, withBsIv,
            parsedFirst4: (contracts as MarketDataContract[]).slice(0, 4).map(c => ({
              sym: c.optionSymbol, exp: c.expiration, side: c.side,
              strike: c.strike, iv: c.iv, ivSource: c.ivSource,
              delta: c.delta, undPx: c.underlyingPrice, dte: c.dte,
            })),
          }, null, 2),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── IVolatility handlers ──────────────────────────────────────────────────

  ipcMain.handle('test-api:save-ivolatility-key', (_e, key: string) => {
    try { secureSet(db, 'ivolatilityApiKey', key.trim()); return ok(true); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('test-api:get-ivolatility-key-configured', () => {
    try { return ok(Boolean(secureGet(db, 'ivolatilityApiKey'))); }
    catch { return ok(false); }
  });

  ipcMain.handle(
    'test-api:get-ivolatility-ivx',
    async (_e: IpcMainInvokeEvent, symbol: string, from: string, to: string) => {
      try {
        if (!ivolatility) throw new Error('IVolatility provider not initialised.');

        // Step 1 — raw response for field inspection.
        const raw = await ivolatility.getRawIvx(symbol.toUpperCase(), from, to);

        // Find the data rows array (may be top-level array or inside an envelope key).
        const topObj: Record<string, unknown> = Array.isArray(raw)
          ? { _array: raw }
          : (raw as Record<string, unknown>);
        const anyArr = Array.isArray(raw)
          ? raw
          : (Object.values(topObj).find(Array.isArray) as unknown[] | undefined);

        // Describe the FIRST ROW's fields — that's what the parser cares about.
        // Envelope keys (status, query, data) are shown in rawSample instead.
        const rawTopLevelKeys: string[] = [];
        const rawFieldTypes: Record<string, string> = {};
        const firstRow = (anyArr ?? [])[0];
        if (firstRow !== null && typeof firstRow === 'object') {
          for (const [k, v] of Object.entries(firstRow as Record<string, unknown>)) {
            rawTopLevelKeys.push(k);
            rawFieldTypes[k] = `${typeof v} — ${JSON.stringify(v)}`;
          }
        } else {
          // Fallback: show envelope keys
          for (const [k, v] of Object.entries(topObj)) {
            rawTopLevelKeys.push(k);
            rawFieldTypes[k] = Array.isArray(v)
              ? `array(${(v as unknown[]).length})`
              : `${typeof v} — ${JSON.stringify(v)}`;
          }
        }

        // Build raw sample from first 3 rows.
        const rawSample = JSON.stringify((anyArr ?? []).slice(0, 3), null, 2);

        // Step 2 — parse.
        const { parseIvxResponse } = await import('../services/ivolatility-provider.js');
        const result = parseIvxResponse(raw, symbol.toUpperCase());

        if (result.s === 'no_data' || result.rows.length === 0) {
          return ok<IVolatilityTestResult>({
            symbol: symbol.toUpperCase(), from, to,
            status: 'no_data', rowCount: 0, rows: [],
            iv30Min: null, iv30Max: null, iv30Latest: null, iv30LatestDate: null,
            rawTopLevelKeys, rawFieldTypes, rawSample,
          });
        }

        const latestRow = result.rows[result.rows.length - 1];

        // IV Rank is a 52-week metric — restrict min/max to the last 365 calendar days
        // regardless of how wide the query range is.
        const cutoff365 = latestRow
          ? new Date(latestRow.date + 'T00:00:00Z').getTime() - 365 * 86_400_000
          : 0;
        const rows52w = result.rows.filter(r => new Date(r.date + 'T00:00:00Z').getTime() >= cutoff365);
        const iv30s52w = rows52w.map(r => r.iv30).filter((v): v is number => v !== null);

        return ok<IVolatilityTestResult>({
          symbol: symbol.toUpperCase(), from, to,
          status: 'ok',
          rowCount: result.rows.length,
          rows: result.rows,
          iv30Min:       iv30s52w.length ? Math.min(...iv30s52w) : null,
          iv30Max:       iv30s52w.length ? Math.max(...iv30s52w) : null,
          iv30Latest:    latestRow?.iv30 ?? null,
          iv30LatestDate: latestRow?.date ?? null,
          rawTopLevelKeys, rawFieldTypes, rawSample,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── SEC EDGAR handlers ────────────────────────────────────────────────────

  ipcMain.handle('test-api:edgar-fundamentals', async (_e: IpcMainInvokeEvent, ticker: string) => {
    try {
      const { cikPadded, title } = await resolveEdgarCik(ticker.toUpperCase().trim());
      const resp = await fetch(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cikPadded}.json`,
        { headers: EDGAR_HEADERS }
      );
      if (!resp.ok) throw new Error(`SEC companyfacts HTTP ${resp.status}: ${await resp.text().then(t => t.slice(0, 200))}`);

      const data = await resp.json() as {
        cik: number;
        entityName: string;
        facts: { 'us-gaap'?: Record<string, { label: string; units: Record<string, EdgarEntry[]> }> };
      };

      const gaap = data.facts['us-gaap'] ?? {};
      const topGaapConcepts = Object.keys(gaap).slice(0, 40);
      const totalConceptCount = Object.keys(gaap).length;

      const fields: EdgarFieldResult[] = EDGAR_FIELD_SPECS.map(spec => {
        // Collect ALL matching candidates, then pick the one with the most recent
        // annual data. This handles ASC 606-style transitions where a company has
        // both an old concept (e.g. "Revenues", last used 2018) and a new concept
        // (e.g. "RevenueFromContractWithCustomer…", used from 2019 onward). Taking
        // the first-found would silently return stale data.
        type Candidate = {
          concept: string; unit: string; entries: EdgarEntry[];
          latestAnnual: EdgarEntry | null; latestQtr: EdgarEntry | null;
        };
        const candidates: Candidate[] = [];
        for (const concept of spec.concepts) {
          const node = gaap[concept];
          if (!node?.units) continue;
          // Prefer USD for monetary, USD/shares for EPS, then whatever unit exists.
          const unitEntry = Object.entries(node.units).find(([u]) => u === 'USD') ??
                            Object.entries(node.units).find(([u]) => u === 'USD/shares') ??
                            Object.entries(node.units)[0];
          if (!unitEntry) continue;
          const [unit, entries] = unitEntry;
          if (!entries?.length) continue;
          candidates.push({
            concept, unit, entries,
            latestAnnual: pickEdgarLatest(entries, '10-K'),
            latestQtr:    pickEdgarLatest(entries, '10-Q'),
          });
        }

        if (candidates.length === 0) {
          return {
            role: spec.role, label: spec.label,
            conceptUsed: null, conceptsTried: [...spec.concepts],
            unit: null, found: false,
            latestAnnualVal: null, latestAnnualDate: null,
            latestQtrVal: null, latestQtrDate: null,
            annualCount: 0, quarterlyCount: 0,
          };
        }

        // Pick the candidate whose most recent 10-K is latest.
        candidates.sort((a, b) =>
          (b.latestAnnual?.end ?? '').localeCompare(a.latestAnnual?.end ?? '')
        );
        const best = candidates[0]!;
        return {
          role: spec.role, label: spec.label,
          conceptUsed: best.concept, conceptsTried: [...spec.concepts],
          unit: best.unit, found: true,
          latestAnnualVal:  best.latestAnnual?.val ?? null,
          latestAnnualDate: best.latestAnnual?.end ?? null,
          latestQtrVal:     best.latestQtr?.val    ?? null,
          latestQtrDate:    best.latestQtr?.end    ?? null,
          annualCount:    best.entries.filter(e => e.form === '10-K').length,
          quarterlyCount: best.entries.filter(e => e.form === '10-Q').length,
        };
      });

      // Raw sample: first 3 entries of the first found concept's USD array.
      const firstFound = fields.find(f => f.found && f.conceptUsed);
      let rawSample = '{}';
      if (firstFound?.conceptUsed) {
        const sampleEntries = Object.values(
          gaap[firstFound.conceptUsed]?.units ?? {}
        )[0]?.slice(-5) ?? [];
        rawSample = JSON.stringify({ [firstFound.conceptUsed]: sampleEntries }, null, 2);
      }

      return ok<EdgarTestResult>({
        ticker: ticker.toUpperCase().trim(),
        cik: cikPadded,
        entityName: data.entityName || title,
        fields,
        totalConceptCount,
        topGaapConcepts,
        rawSample,
      });
    } catch (err) {
      return fail(err);
    }
  });

  // ── Finnhub handlers ──────────────────────────────────────────────────────

  ipcMain.handle('test-api:save-finnhub-key', (_e, key: string) => {
    try { secureSet(db, 'finnhubApiKey', key.trim()); return ok(true); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('test-api:get-finnhub-key-configured', () => {
    try { return ok(Boolean(secureGet(db, 'finnhubApiKey'))); }
    catch { return ok(false); }
  });

  ipcMain.handle(
    'test-api:get-finnhub-earnings',
    async (_e: IpcMainInvokeEvent, from: string, to: string, symbol?: string) => {
      try {
        const token = secureGet(db, 'finnhubApiKey');
        if (!token) throw new Error('Finnhub API key not configured.');

        const url = new URL('https://finnhub.io/api/v1/calendar/earnings');
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);
        url.searchParams.set('token', token);
        if (symbol?.trim()) url.searchParams.set('symbol', symbol.trim().toUpperCase());

        const resp = await fetch(url.toString());
        if (!resp.ok) throw new Error(`Finnhub HTTP ${resp.status}: ${await resp.text()}`);
        const json = await resp.json() as { earningsCalendar?: FinnhubEarningsEntry[] };

        const entries: FinnhubEarningsEntry[] = json.earningsCalendar ?? [];

        // Coverage check: how many returned tickers are in our constituents universe?
        type TRow = { ticker: string };
        const constituentTickers = new Set<string>(
          (db.prepare('SELECT DISTINCT ticker FROM constituents').all() as TRow[]).map(r => r.ticker)
        );
        const matched = entries.filter(e => constituentTickers.has(e.symbol));

        return ok({
          from, to,
          totalEntries: entries.length,
          matchedConstituents: matched.length,
          constituentCount: constituentTickers.size,
          entries: entries.slice(0, 200),  // cap for display
          rawSample: JSON.stringify(entries.slice(0, 3), null, 2),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}

interface FinnhubEarningsEntry {
  date: string;
  symbol: string;
  epsActual: number | null;
  epsEstimate: number | null;
  hour: string | null;  // 'bmo' | 'amc' | 'dmh'
  quarter: number | null;
  year: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}
