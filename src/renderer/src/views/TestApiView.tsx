// TestApiView — validates data provider APIs before full integration.
// Provider tabs: Polygon (raw snapshot) | E*Trade (OAuth + chain)
// Both display results in the same options chain table format.

import { useCallback, useEffect, useState } from 'react';

// ─── Shared types ─────────────────────────────────────────────────────────────

interface NormalizedLeg {
  strike: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;         // as decimal (0.28 = 28%)
  openInterest: number | null;
  volume: number | null;
  hasGreeks: boolean;
  hasBidAsk: boolean;
  lastPrice: number | null;  // day.close (Polygon) or lastPrice (E*Trade)
}

interface NormalizedChain {
  ticker: string;
  expiration: string;
  underlyingPrice: number | null;
  totalContracts: number;
  withGreeks: number;
  withBidAsk: number;
  callMap: Map<number, NormalizedLeg>;
  putMap: Map<number, NormalizedLeg>;
  strikes: number[];
  // diagnostics
  diagLines: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtP(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`;
}
function fmtN(v: number | null, dp = 2): string {
  return v === null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: dp });
}
function fmtPct(v: number | null): string {
  // v is decimal (0.28 → "28.0%")
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}
function dteDays(expDate: string): number {
  const exp = new Date(expDate + 'T00:00:00Z');
  return Math.max(0, Math.round((exp.getTime() - Date.now()) / 86_400_000));
}
function calcMid(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null) return null;
  return (bid + ask) / 2;
}
function pctOf(n: number, total: number): string {
  return total > 0 ? ` (${Math.round((n / total) * 100)}%)` : '';
}
function ivColor(iv: number | null): string {
  if (iv === null) return '#6c7086';
  const pct = iv * 100;
  if (pct >= 30) return '#a6e3a1';
  if (pct >= 20) return '#f9e2af';
  return '#8b949e';
}
function deltaColor(delta: number | null): string {
  if (delta === null) return '#6c7086';
  const abs = Math.abs(delta);
  return abs >= 0.15 && abs <= 0.35 ? '#fab387' : '#cdd6f4';
}

// ─── Polygon raw contract type (mirrors ipc-test-api) ────────────────────────

interface PolygonRawContract {
  strike: number; contractType: string;
  impliedVolatility: number | null; openInterest: number | null;
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null;
  hasGreeks: boolean;
  bid: number | null; ask: number | null; quoteMidpoint: number | null; hasLastQuote: boolean;
  dayClose: number | null; dayVolume: number | null;
  underlyingPrice: number | null;
}

interface PolygonResult {
  ticker: string; expiration: string; underlyingPrice: number | null;
  totalContracts: number; contractsWithGreeks: number; contractsWithLastQuote: number;
  pages: number; polygonStatus: string; rawResultsType: string;
  rawResultsCount: number; firstPageKeys: string[];
  contracts: PolygonRawContract[];
}

// ─── E*Trade types (mirrors preload) ─────────────────────────────────────────

interface ETradeExpiration {
  year: number; month: number; day: number; expiryType: string; dateStr: string;
}

interface ETradeGreek {
  delta: number | null; gamma: number | null; theta: number | null;
  vega: number | null; rho: number | null; iv: number | null;
}

interface ETradeLeg {
  symbol: string; strikePrice: number;
  bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null;
  lastPrice: number | null; volume: number | null; openInterest: number | null;
  inTheMoney: boolean; greek: ETradeGreek; hasGreeks: boolean; hasBidAsk: boolean;
}

interface ETradeChainResult {
  ticker: string; expiration: string; underlyingPrice: number | null;
  totalContracts: number; withGreeks: number; withBidAsk: number;
  rawTopLevelKeys: string[]; rawResponseKeys: string[]; pairsCount: number;
  rawSampleCall: string; rawSamplePut: string;
  calls: ETradeLeg[]; puts: ETradeLeg[];
}

interface ETradeStatus {
  hasConsumerKey: boolean; hasConsumerSecret: boolean; hasAccessToken: boolean;
  isConfigured: boolean; isAuthenticated: boolean;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normalizePolygon(raw: PolygonResult): NormalizedChain {
  const callMap = new Map<number, NormalizedLeg>();
  const putMap  = new Map<number, NormalizedLeg>();
  for (const c of raw.contracts) {
    const leg: NormalizedLeg = {
      strike: c.strike,
      bid: c.bid, ask: c.ask,
      mid: calcMid(c.bid, c.ask),
      delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega,
      iv: c.impliedVolatility,
      openInterest: c.openInterest,
      volume: c.dayVolume,
      hasGreeks: c.hasGreeks, hasBidAsk: c.hasLastQuote,
      lastPrice: c.dayClose,
    };
    if (c.contractType === 'call') callMap.set(c.strike, leg);
    else putMap.set(c.strike, leg);
  }
  const strikes = Array.from(new Set(raw.contracts.map(c => c.strike))).sort((a, b) => a - b);
  return {
    ticker: raw.ticker, expiration: raw.expiration,
    underlyingPrice: raw.underlyingPrice,
    totalContracts: raw.totalContracts,
    withGreeks: raw.contractsWithGreeks, withBidAsk: raw.contractsWithLastQuote,
    callMap, putMap, strikes,
    diagLines: [
      `Polygon status: ${raw.polygonStatus}`,
      `results[]: ${raw.rawResultsType}, count p1: ${raw.rawResultsCount}, pages: ${raw.pages}`,
      `Top-level keys: ${raw.firstPageKeys.join(', ')}`,
      raw.contractsWithLastQuote === 0 ? '⚠ last_quote absent — plan does not include quotes data' : '',
    ].filter(Boolean),
  };
}

function normalizeEtrade(raw: ETradeChainResult): NormalizedChain {
  const callMap = new Map<number, NormalizedLeg>();
  const putMap  = new Map<number, NormalizedLeg>();
  const addLeg = (leg: ETradeLeg, map: Map<number, NormalizedLeg>) => {
    map.set(leg.strikePrice, {
      strike: leg.strikePrice,
      bid: leg.bid, ask: leg.ask,
      mid: calcMid(leg.bid, leg.ask),
      delta: leg.greek.delta, gamma: leg.greek.gamma,
      theta: leg.greek.theta, vega: leg.greek.vega,
      iv: leg.greek.iv,
      openInterest: leg.openInterest, volume: leg.volume,
      hasGreeks: leg.hasGreeks, hasBidAsk: leg.hasBidAsk,
      lastPrice: leg.lastPrice,
    });
  };
  raw.calls.forEach(l => addLeg(l, callMap));
  raw.puts.forEach(l  => addLeg(l, putMap));
  const strikes = Array.from(new Set([...callMap.keys(), ...putMap.keys()])).sort((a, b) => a - b);
  return {
    ticker: raw.ticker, expiration: raw.expiration,
    underlyingPrice: raw.underlyingPrice,
    totalContracts: raw.totalContracts,
    withGreeks: raw.withGreeks, withBidAsk: raw.withBidAsk,
    callMap, putMap, strikes,
    diagLines: [
      `Top-level keys: ${raw.rawTopLevelKeys.join(', ')}`,
      `OptionChainResponse keys: ${raw.rawResponseKeys.join(', ')}`,
      `Option pairs: ${raw.pairsCount}`,
    ],
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '10px', color: '#6c7086' }}>{label}</span>
      <span style={{ fontSize: '12px', fontWeight: 600, color: color ?? '#cdd6f4' }}>{value}</span>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: '4px 8px', color: '#6c7086', fontWeight: 600, textAlign: 'right', whiteSpace: 'nowrap' }}>{children}</th>;
}

function Td({ children, color, warn }: { children: React.ReactNode; color?: string; warn?: boolean }) {
  return (
    <td style={{
      padding: '3px 8px', textAlign: 'right', whiteSpace: 'nowrap',
      color: warn ? '#f38ba8' : (color ?? '#cdd6f4'),
      background: warn ? 'rgba(243,139,168,0.06)' : undefined,
    }}>
      {children}
    </td>
  );
}

// ─── Shared chain table ───────────────────────────────────────────────────────

function ChainTable({ chain }: { chain: NormalizedChain }) {
  const { strikes, callMap, putMap, underlyingPrice } = chain;

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
        <thead>
          <tr style={{ position: 'sticky', top: 0, background: '#1e1e2e', zIndex: 1 }}>
            <Th>Bid</Th><Th>Ask</Th><Th>Mid</Th><Th>Last</Th>
            <Th>Delta</Th><Th>IV%</Th><Th>OI</Th><Th>Vol</Th>
            <th style={{ textAlign: 'center', padding: '4px 10px', color: '#89b4fa', fontWeight: 700, borderLeft: '1px solid #313244', borderRight: '1px solid #313244' }}>
              STRIKE
            </th>
            <Th>Bid</Th><Th>Ask</Th><Th>Mid</Th><Th>Last</Th>
            <Th>Delta</Th><Th>IV%</Th><Th>OI</Th><Th>Vol</Th>
          </tr>
        </thead>
        <tbody>
          {strikes.map(strike => {
            const call = callMap.get(strike);
            const put  = putMap.get(strike);
            const isAtm = underlyingPrice !== null && Math.abs(strike - underlyingPrice) / underlyingPrice <= 0.02;
            return (
              <tr key={strike}
                style={{ background: isAtm ? '#1a2a3a' : 'transparent', borderBottom: '1px solid #1e1e2e' }}
                onMouseEnter={e => (e.currentTarget.style.background = isAtm ? '#1f3248' : '#181825')}
                onMouseLeave={e => (e.currentTarget.style.background = isAtm ? '#1a2a3a' : 'transparent')}
              >
                {/* ── Calls ── */}
                <Td warn={call ? !call.hasBidAsk : false}>{fmtP(call?.bid ?? null)}</Td>
                <Td warn={call ? !call.hasBidAsk : false}>{fmtP(call?.ask ?? null)}</Td>
                <Td color="#a6e3a1">{fmtP(call?.mid ?? null)}</Td>
                <Td color="#fab387">{fmtP(call?.lastPrice ?? null)}</Td>
                <Td warn={call ? !call.hasGreeks : false} color={deltaColor(call?.delta ?? null)}>
                  {fmtN(call?.delta ?? null, 3)}
                </Td>
                <Td color={ivColor(call?.iv ?? null)}>{fmtPct(call?.iv ?? null)}</Td>
                <Td>{fmtN(call?.openInterest ?? null, 0)}</Td>
                <Td>{fmtN(call?.volume ?? null, 0)}</Td>

                {/* ── Strike ── */}
                <td style={{
                  textAlign: 'center', padding: '4px 10px', fontWeight: 700,
                  color: isAtm ? '#89dceb' : '#cdd6f4',
                  borderLeft: '1px solid #313244', borderRight: '1px solid #313244',
                }}>
                  ${strike.toFixed(2)}{isAtm && <span style={{ fontSize: '9px', marginLeft: '4px', color: '#89dceb' }}>ATM</span>}
                </td>

                {/* ── Puts ── */}
                <Td warn={put ? !put.hasBidAsk : false}>{fmtP(put?.bid ?? null)}</Td>
                <Td warn={put ? !put.hasBidAsk : false}>{fmtP(put?.ask ?? null)}</Td>
                <Td color="#a6e3a1">{fmtP(put?.mid ?? null)}</Td>
                <Td color="#fab387">{fmtP(put?.lastPrice ?? null)}</Td>
                <Td warn={put ? !put.hasGreeks : false} color={deltaColor(put?.delta ?? null)}>
                  {fmtN(put?.delta ?? null, 3)}
                </Td>
                <Td color={ivColor(put?.iv ?? null)}>{fmtPct(put?.iv ?? null)}</Td>
                <Td>{fmtN(put?.openInterest ?? null, 0)}</Td>
                <Td>{fmtN(put?.volume ?? null, 0)}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Quality Banner ───────────────────────────────────────────────────────────

function QualityBanner({ chain, providerLabel }: { chain: NormalizedChain; providerLabel: string }) {
  return (
    <div style={{ background: '#181825', border: '1px solid #313244', padding: '10px 14px', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
        <Stat label="Provider" value={providerLabel} color="#89b4fa" />
        <Stat label="Ticker" value={chain.ticker} />
        <Stat label="Expiration" value={`${chain.expiration} (${dteDays(chain.expiration)} DTE)`} />
        <Stat label="Underlying" value={chain.underlyingPrice !== null ? `$${chain.underlyingPrice.toFixed(2)}` : '—'} />
        <Stat label="Contracts" value={String(chain.totalContracts)} color={chain.totalContracts === 0 ? '#f38ba8' : '#a6e3a1'} />
        <Stat label="With bid/ask" value={`${chain.withBidAsk}${pctOf(chain.withBidAsk, chain.totalContracts)}`}
          color={chain.withBidAsk === 0 ? '#f38ba8' : chain.withBidAsk < chain.totalContracts * 0.8 ? '#fab387' : '#a6e3a1'} />
        <Stat label="With Greeks" value={`${chain.withGreeks}${pctOf(chain.withGreeks, chain.totalContracts)}`}
          color={chain.withGreeks === 0 ? '#f38ba8' : chain.withGreeks < chain.totalContracts * 0.8 ? '#fab387' : '#a6e3a1'} />
      </div>
      {chain.diagLines.length > 0 && (
        <div style={{ borderTop: '1px solid #313244', paddingTop: '6px', fontSize: '11px', color: '#6c7086', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {chain.diagLines.map((l, i) => <span key={i} style={{ color: l.startsWith('⚠') ? '#f38ba8' : '#6c7086' }}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

// ─── Polygon tab ──────────────────────────────────────────────────────────────

function PolygonTab() {
  const [ticker, setTicker]   = useState('');
  const [expDate, setExpDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [chain, setChain]     = useState<NormalizedChain | null>(null);

  const fetch = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) { setError('Enter a ticker.'); return; }
    setLoading(true); setError(null); setChain(null);
    try {
      const raw = await window.api.testApi.getRawOptions(t, expDate.trim()) as PolygonResult;
      setChain(normalizePolygon(raw));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && fetch()} placeholder="Ticker"
          style={inputStyle} />
        <input type="date" value={expDate} onChange={e => setExpDate(e.target.value)}
          title="Leave blank to fetch all expirations"
          style={inputStyle} />
        <span style={{ fontSize: '11px', color: '#6c7086' }}>date optional</span>
        <FetchBtn loading={loading} onClick={fetch} />
      </div>
      {error && <ErrorBox msg={error} />}
      {chain && <QualityBanner chain={chain} providerLabel="Polygon.io" />}
      {chain && chain.totalContracts > 0 && <ChainTable chain={chain} />}
      {chain && chain.totalContracts === 0 && (
        <div style={{ color: '#6c7086', padding: '24px', textAlign: 'center' }}>
          No contracts returned — try without a date to confirm plan access.
        </div>
      )}
    </div>
  );
}

// ─── E*Trade Quote Inspector ─────────────────────────────────────────────────

function QuoteInspector() {
  const [ticker, setTicker]   = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [result, setResult]   = useState<{ rawJson: string; topLevelKeys: string[] } | null>(null);

  const fetch = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) { setError('Enter a ticker.'); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await window.api.etrade.getRawQuote(t);
      setResult(res);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const ivRelatedKeys = result
    ? extractIvKeys(result.rawJson)
    : [];

  return (
    <div style={{ background: '#181825', border: '1px solid #313244', borderRadius: '6px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#cba6f7' }}>Quote Inspector</span>
        <span style={{ fontSize: '12px', color: '#6c7086' }}>
          Calls <code style={{ color: '#fab387' }}>/v1/market/quote/TICKER?detailFlag=ALL</code> — inspect every field E*Trade returns
        </span>
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && fetch()}
          placeholder="Ticker (e.g. AAPL)"
          style={inputStyle}
        />
        <FetchBtn loading={busy} onClick={fetch} label="Fetch Quote" />
      </div>
      {error && <ErrorBox msg={error} />}
      {result && (
        <>
          {/* IV-related fields highlighted at the top */}
          <div style={{ background: '#12121e', border: '1px solid #45475a', borderRadius: '4px', padding: '10px 12px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#cba6f7', marginBottom: '6px' }}>
              IV / Volatility fields found ({ivRelatedKeys.length === 0 ? 'none' : ivRelatedKeys.length})
            </div>
            {ivRelatedKeys.length === 0 ? (
              <div style={{ fontSize: '13px', color: '#f38ba8' }}>
                No IV rank / IV percentile / volatility fields detected in this response.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {ivRelatedKeys.map(({ path, value }) => (
                  <div key={path} style={{ display: 'flex', gap: '8px', fontSize: '13px' }}>
                    <span style={{ color: '#a6e3a1', minWidth: '280px', fontFamily: 'monospace' }}>{path}</span>
                    <span style={{ color: '#cdd6f4' }}>{String(value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Full raw response */}
          <details style={{ background: '#12121e', border: '1px solid #313244', borderRadius: '4px', padding: '8px 12px', fontSize: '13px' }}>
            <summary style={{ cursor: 'pointer', color: '#89b4fa', marginBottom: '6px' }}>
              🔍 Full raw response (top-level keys: {result.topLevelKeys.join(', ')})
            </summary>
            <pre style={{ margin: 0, color: '#cdd6f4', overflowX: 'auto', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '400px', overflowY: 'auto' }}>
              {result.rawJson}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

/** Walk the parsed JSON and return every key path that looks IV/volatility-related. */
function extractIvKeys(rawJson: string): Array<{ path: string; value: unknown }> {
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); } catch { return []; }

  const results: Array<{ path: string; value: unknown }> = [];
  const ivTerms = ['iv', 'impliedvol', 'volatility', 'ivrank', 'ivpct', 'ivpercentile', 'historicalvol', 'hvol'];

  function walk(obj: unknown, path: string) {
    if (obj === null || obj === undefined) return;
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const lower = k.toLowerCase().replace(/[_\-]/g, '');
        if (ivTerms.some(t => lower.includes(t))) {
          results.push({ path: path ? `${path}.${k}` : k, value: v });
        }
        walk(v, path ? `${path}.${k}` : k);
      }
    } else if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    }
  }

  walk(parsed, '');
  return results;
}

// ─── MarketData.app tab ───────────────────────────────────────────────────────

type MDResult = Awaited<ReturnType<typeof window.api.testApi.getMarketDataChain>>;

function MarketDataTab() {
  const [ticker, setTicker]   = useState('AAPL');
  // Default date: yesterday (hardcode-friendly — user can change)
  const [date, setDate]       = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState<MDResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const fetch = async () => {
    if (!ticker.trim() || !date.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await window.api.testApi.getMarketDataChain(ticker.trim().toUpperCase(), date.trim());
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const S = { // common styles
    row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const, marginBottom: 10 },
    label: { color: '#6c7086', minWidth: 110 },
    val: { color: '#cdd6f4' },
    good: { color: '#a6e3a1' },
    warn: { color: '#f9e2af' },
    bad: { color: '#f38ba8' },
    card: { background: '#1e1e2e', border: '1px solid #313244', borderRadius: 8, padding: '12px 16px', marginBottom: 12 },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Input row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          placeholder="Ticker"
          style={{ width: 90, padding: '5px 10px', borderRadius: 5, border: '1px solid #313244', background: '#1e1e2e', color: '#cdd6f4', fontSize: 12 }}
        />
        <input
          value={date}
          onChange={e => setDate(e.target.value)}
          placeholder="YYYY-MM-DD"
          style={{ width: 120, padding: '5px 10px', borderRadius: 5, border: '1px solid #313244', background: '#1e1e2e', color: '#cdd6f4', fontSize: 12 }}
        />
        <button
          onClick={fetch}
          disabled={loading}
          style={{ padding: '5px 18px', borderRadius: 5, border: 'none', background: '#89b4fa', color: '#1e1e2e', fontSize: 12, fontWeight: 700, cursor: 'pointer', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Fetching…' : 'Fetch Chain'}
        </button>
        <span style={{ fontSize: 11, color: '#6c7086' }}>
          Fetches a historical options chain via MarketData.app and runs the ATM IV computation to verify parsing.
        </span>
      </div>

      {error && <div style={{ color: '#f38ba8', fontSize: 12, background: '#1e1e2e', padding: '8px 12px', borderRadius: 6 }}>Error: {error}</div>}

      {result && (
        <>
          {/* Status row */}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#89b4fa', marginBottom: 8 }}>
              {result.ticker} — {result.date}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px 20px', fontSize: 12 }}>
              <span><span style={S.label}>Status:</span>{' '}
                <span style={result.status === 'ok' ? S.good : S.bad}>{result.status}</span>
              </span>
              <span><span style={S.label}>Contracts:</span>{' '}
                <span style={S.val}>{result.contractCount.toLocaleString()}</span>
              </span>
              <span><span style={S.label}>Underlying Px:</span>{' '}
                <span style={result.underlyingPrice !== null ? S.good : S.bad}>
                  {result.underlyingPrice !== null ? `$${result.underlyingPrice.toFixed(2)}` : 'NULL ⚠'}
                </span>
              </span>
              <span><span style={S.label}>With IV:</span>{' '}
                <span style={result.withIv > 0 ? S.good : S.bad}>
                  {result.withIv} / {result.contractCount}{' '}
                  ({result.contractCount > 0 ? Math.round(result.withIv / result.contractCount * 100) : 0}%)
                </span>
              </span>
              <span><span style={S.label}>With Delta:</span>{' '}
                <span style={result.withDelta > 0 ? S.good : S.bad}>
                  {result.withDelta} / {result.contractCount}{' '}
                  ({result.contractCount > 0 ? Math.round(result.withDelta / result.contractCount * 100) : 0}%)
                </span>
              </span>
              <span><span style={S.label}>Und Px per-ctr:</span>{' '}
                <span style={result.withUndPx > 0 ? S.good : S.warn}>
                  {result.withUndPx > 0 ? `${result.withUndPx} contracts` : 'None (root-level only)'}
                </span>
              </span>
            </div>
          </div>

          {/* ATM IV result */}
          <div style={S.card}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#89b4fa', marginBottom: 8 }}>ATM IV Computation</div>
            {result.atmIvResult === null ? (
              <span style={S.bad}>Could not compute — underlyingPrice is null and no delta data available.</span>
            ) : result.atmIvResult.atmIv === null ? (
              <span style={S.warn}>computeAtmIv returned null — no expirations bracket 30 DTE on this date.</span>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px 20px', fontSize: 12 }}>
                <span><span style={S.label}>ATM IV:</span>{' '}
                  <span style={{ color: '#a6e3a1', fontWeight: 700, fontSize: 14 }}>
                    {result.atmIvResult.atmIvPct?.toFixed(2)}%
                  </span>
                  {' '}<span style={{ color: '#6c7086' }}>(= {result.atmIvResult.atmIv?.toFixed(4)} decimal)</span>
                </span>
                <span><span style={S.label}>Near exp:</span>{' '}
                  <span style={S.val}>{result.atmIvResult.expNear ?? '—'}{result.atmIvResult.dteNear !== null ? ` (${result.atmIvResult.dteNear}d)` : ''}</span>
                </span>
                <span><span style={S.label}>Far exp:</span>{' '}
                  <span style={S.val}>{result.atmIvResult.expFar ?? '—'}{result.atmIvResult.dteFar !== null ? ` (${result.atmIvResult.dteFar}d)` : ''}</span>
                </span>
                {result.atmIvResult.estimatedFromDelta && (
                  <span style={S.warn}>⚠ Underlying price estimated from delta (root-level price was null)</span>
                )}
              </div>
            )}
          </div>

          {/* Sample contracts table */}
          {result.sample.length > 0 && (
            <div style={S.card}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#89b4fa', marginBottom: 8 }}>
                Near-ATM Sample ({result.sample.length} contracts)
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ color: '#6c7086', borderBottom: '1px solid #313244' }}>
                    {['Symbol', 'Exp', 'Side', 'Strike', 'DTE', 'IV%', 'Delta', 'Und Px'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '3px 8px', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.sample.map((c, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #1e1e2e' }}>
                      <td style={{ padding: '3px 8px', color: '#cdd6f4', fontFamily: 'monospace', fontSize: 10 }}>{c.optionSymbol}</td>
                      <td style={{ padding: '3px 8px', color: '#cdd6f4' }}>{c.expiration}</td>
                      <td style={{ padding: '3px 8px', color: c.side === 'call' ? '#a6e3a1' : '#f38ba8' }}>{c.side}</td>
                      <td style={{ padding: '3px 8px', color: '#cdd6f4' }}>${c.strike}</td>
                      <td style={{ padding: '3px 8px', color: '#cdd6f4' }}>{c.dte ?? '—'}</td>
                      <td style={{ padding: '3px 8px', color: c.iv !== null ? '#a6e3a1' : '#f38ba8' }}>
                        {c.iv !== null ? `${(c.iv * 100).toFixed(1)}%` : 'null ⚠'}
                      </td>
                      <td style={{ padding: '3px 8px', color: c.delta !== null ? '#fab387' : '#f38ba8' }}>
                        {c.delta !== null ? c.delta.toFixed(3) : 'null ⚠'}
                      </td>
                      <td style={{ padding: '3px 8px', color: c.underlyingPrice !== null ? '#cdd6f4' : '#6c7086' }}>
                        {c.underlyingPrice !== null ? `$${c.underlyingPrice.toFixed(2)}` : 'root-only'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Raw JSON toggle */}
          <div>
            <button
              onClick={() => setShowRaw(v => !v)}
              style={{ padding: '4px 12px', borderRadius: 5, border: '1px solid #313244', background: 'transparent', color: '#6c7086', fontSize: 11, cursor: 'pointer' }}
            >
              {showRaw ? 'Hide' : 'Show'} Raw JSON Sample
            </button>
            {showRaw && (
              <pre style={{ marginTop: 8, background: '#1e1e2e', border: '1px solid #313244', borderRadius: 6, padding: '10px 14px', fontSize: 11, color: '#a6e3a1', overflowX: 'auto', maxHeight: 300, overflowY: 'auto' }}>
                {result.rawJsonSample}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── E*Trade tab ──────────────────────────────────────────────────────────────

function ETradeTab() {
  const [status, setStatus]           = useState<ETradeStatus | null>(null);
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [verifier, setVerifier]       = useState('');
  const [authUrl, setAuthUrl]         = useState<string | null>(null);
  const [expirations, setExpirations] = useState<ETradeExpiration[]>([]);
  const [ticker, setTicker]           = useState('');
  const [selectedExp, setSelectedExp] = useState<ETradeExpiration | null>(null);
  const [chain, setChain]             = useState<NormalizedChain | null>(null);
  const [rawChain, setRawChain]       = useState<ETradeChainResult | null>(null);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [step, setStep]               = useState<'idle' | 'awaiting-verifier'>('idle');

  const loadStatus = useCallback(async () => {
    try {
      const res = await window.api.etrade.getStatus();
      setStatus(res.status);
      setConsumerKey(res.consumerKey);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const saveCredentials = async () => {
    if (!consumerKey.trim() || !consumerSecret.trim()) { setError('Enter both consumer key and secret.'); return; }
    setBusy(true); setError(null);
    try {
      await window.api.etrade.saveCredentials(consumerKey.trim(), consumerSecret.trim());
      setConsumerSecret('');
      await loadStatus();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const startAuth = async () => {
    setBusy(true); setError(null); setAuthUrl(null);
    try {
      const res = await window.api.etrade.startAuth();
      setAuthUrl(res.authUrl);
      setStep('awaiting-verifier');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const submitVerifier = async () => {
    if (!verifier.trim()) { setError('Paste the verifier code from the E*Trade browser page.'); return; }
    setBusy(true); setError(null);
    try {
      await window.api.etrade.submitVerifier(verifier.trim());
      setVerifier(''); setStep('idle'); setAuthUrl(null);
      await loadStatus();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    await window.api.etrade.disconnect();
    setChain(null); setExpirations([]); setSelectedExp(null);
    await loadStatus();
  };

  const loadExpirations = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) { setError('Enter a ticker first.'); return; }
    setBusy(true); setError(null); setExpirations([]); setSelectedExp(null); setChain(null);
    try {
      const exps = await window.api.etrade.getExpirations(t);
      setExpirations(exps);
      if (exps.length > 0) setSelectedExp(exps[0]!);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const fetchChain = async () => {
    if (!selectedExp) { setError('Select an expiration date.'); return; }
    setBusy(true); setError(null); setChain(null); setRawChain(null);
    try {
      const raw = await window.api.etrade.getOptionsChain(ticker.trim().toUpperCase(), selectedExp) as ETradeChainResult;
      setRawChain(raw);
      setChain(normalizeEtrade(raw));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const isAuth = status?.isAuthenticated ?? false;
  const isConf = status?.isConfigured ?? false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: 1, minHeight: 0 }}>

      {/* ── Credentials + Auth ── */}
      <div style={{ background: '#181825', border: '1px solid #313244', padding: '12px', borderRadius: '6px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#89b4fa' }}>E*Trade OAuth</span>
          <span style={{
            fontSize: '11px', padding: '2px 8px', borderRadius: '10px', fontWeight: 600,
            background: isAuth ? '#1a3a1a' : '#3a1a1a',
            color: isAuth ? '#a6e3a1' : '#f38ba8',
          }}>
            {isAuth ? '✓ Connected' : '✗ Not connected'}
          </span>
          {isAuth && (
            <button onClick={disconnect} style={{ ...btnStyle, background: '#45213a', color: '#f38ba8', fontSize: '11px' }}>
              Disconnect
            </button>
          )}
        </div>

        {/* Credentials row */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input value={consumerKey} onChange={e => setConsumerKey(e.target.value)}
            placeholder="Consumer Key" style={{ ...inputStyle, width: '200px' }} />
          <input value={consumerSecret} onChange={e => setConsumerSecret(e.target.value)}
            placeholder="Consumer Secret" type="password" style={{ ...inputStyle, width: '200px' }} />
          <button onClick={saveCredentials} disabled={busy} style={btnStyle}>Save</button>
          <span style={{ fontSize: '11px', color: '#6c7086' }}>
            Get keys at <span style={{ color: '#89b4fa' }}>developer.etrade.com</span>
          </span>
        </div>

        {/* Auth flow */}
        {isConf && !isAuth && step === 'idle' && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button onClick={startAuth} disabled={busy} style={{ ...btnStyle, background: '#a6e3a1', color: '#1e1e2e' }}>
              {busy ? 'Opening browser…' : 'Connect — Open E*Trade Login'}
            </button>
            <span style={{ fontSize: '11px', color: '#6c7086' }}>Browser will open → log in → copy the verifier code</span>
          </div>
        )}
        {step === 'awaiting-verifier' && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {authUrl && <span style={{ fontSize: '11px', color: '#6c7086' }}>Auth URL opened in browser. Paste verifier code:</span>}
            <input value={verifier} onChange={e => setVerifier(e.target.value)}
              placeholder="Verifier code" style={{ ...inputStyle, width: '180px' }}
              onKeyDown={e => e.key === 'Enter' && submitVerifier()} />
            <button onClick={submitVerifier} disabled={busy} style={{ ...btnStyle, background: '#a6e3a1', color: '#1e1e2e' }}>
              {busy ? 'Verifying…' : 'Submit'}
            </button>
          </div>
        )}
      </div>

      {/* ── Quote Inspector (only when authenticated) ── */}
      {isAuth && <QuoteInspector />}

      {/* ── Chain fetch (only when authenticated) ── */}
      {isAuth && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && loadExpirations()} placeholder="Ticker"
            style={inputStyle} />
          <button onClick={loadExpirations} disabled={busy} style={btnStyle}>
            {busy && expirations.length === 0 ? 'Loading…' : 'Get Expirations'}
          </button>
          {expirations.length > 0 && (
            <>
              <select
                value={selectedExp?.dateStr ?? ''}
                onChange={e => {
                  const exp = expirations.find(x => x.dateStr === e.target.value);
                  setSelectedExp(exp ?? null);
                }}
                style={{ ...inputStyle, width: '180px' }}
              >
                {expirations.map(exp => (
                  <option key={exp.dateStr} value={exp.dateStr}>
                    {exp.dateStr} — {exp.expiryType} ({dteDays(exp.dateStr)} DTE)
                  </option>
                ))}
              </select>
              <FetchBtn loading={busy} onClick={fetchChain} label="Fetch Chain" />
            </>
          )}
        </div>
      )}

      {error && <ErrorBox msg={error} />}
      {chain && <QualityBanner chain={chain} providerLabel="E*Trade" />}

      {/* Raw sample — always show so we can verify field names */}
      {rawChain && (rawChain.rawSampleCall || rawChain.rawSamplePut) && (
        <details style={{ background: '#12121e', border: '1px solid #313244', borderRadius: '4px', padding: '8px 12px', fontSize: '11px' }}>
          <summary style={{ cursor: 'pointer', color: '#89b4fa', marginBottom: '6px' }}>
            🔍 Raw first contract (field name inspector — expand to debug Greeks/IV)
          </summary>
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            {rawChain.rawSampleCall && (
              <div style={{ flex: 1, minWidth: '300px' }}>
                <div style={{ color: '#a6e3a1', marginBottom: '4px', fontWeight: 700 }}>CALL</div>
                <pre style={{ margin: 0, color: '#cdd6f4', overflowX: 'auto', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {rawChain.rawSampleCall}
                </pre>
              </div>
            )}
            {rawChain.rawSamplePut && (
              <div style={{ flex: 1, minWidth: '300px' }}>
                <div style={{ color: '#f38ba8', marginBottom: '4px', fontWeight: 700 }}>PUT</div>
                <pre style={{ margin: 0, color: '#cdd6f4', overflowX: 'auto', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {rawChain.rawSamplePut}
                </pre>
              </div>
            )}
          </div>
        </details>
      )}

      {chain && chain.totalContracts > 0 && <ChainTable chain={chain} />}
      {chain && chain.totalContracts === 0 && (
        <div style={{ color: '#6c7086', padding: '24px', textAlign: 'center' }}>No contracts returned for this expiration.</div>
      )}
    </div>
  );
}

// ─── Shared small components ──────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '4px 8px', background: '#1e1e2e', border: '1px solid #45475a',
  color: '#cdd6f4', borderRadius: '4px', fontSize: '12px',
};

const btnStyle: React.CSSProperties = {
  padding: '4px 14px', background: '#89b4fa', color: '#1e1e2e',
  border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 700, fontSize: '12px',
};

function FetchBtn({ loading, onClick, label = 'Fetch' }: { loading: boolean; onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} disabled={loading} style={btnStyle}>
      {loading ? 'Loading…' : label}
    </button>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div style={{ background: '#45213a', border: '1px solid #f38ba8', color: '#f38ba8', padding: '8px 12px', borderRadius: '4px', fontSize: '12px' }}>
      {msg}
    </div>
  );
}

// ─── Root view ────────────────────────────────────────────────────────────────

export function TestApiView() {
  const [provider, setProvider] = useState<'polygon' | 'etrade' | 'marketdata'>('polygon');

  const TAB_LABELS: Record<typeof provider, string> = {
    polygon:    'Polygon',
    etrade:     'E*Trade',
    marketdata: 'MarketData.app',
  };
  const TAB_DESC: Record<typeof provider, string> = {
    polygon:    'Current provider — validates data quality & plan coverage',
    etrade:     'Options provider — validate before full integration',
    marketdata: 'IV history source — verify chain parsing & ATM IV computation',
  };

  return (
    <div style={{ padding: '16px', fontFamily: 'monospace', fontSize: '12px', color: '#cdd6f4', height: '100%', display: 'flex', flexDirection: 'column', gap: '12px' }}>

      {/* ── Header + provider tabs ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, color: '#89b4fa', fontSize: '14px', fontWeight: 700 }}>🔬 Test API</h2>
        <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid #313244' }}>
          {(['polygon', 'etrade', 'marketdata'] as const).map(p => (
            <button key={p} onClick={() => setProvider(p)} style={{
              padding: '4px 16px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
              background: provider === p ? '#89b4fa' : '#1e1e2e',
              color: provider === p ? '#1e1e2e' : '#6c7086',
            }}>
              {TAB_LABELS[p]}
            </button>
          ))}
        </div>
        <span style={{ fontSize: '11px', color: '#6c7086' }}>{TAB_DESC[provider]}</span>
      </div>

      {/* ── Legend (Polygon / E*Trade only) ── */}
      {provider !== 'marketdata' && (
        <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: '#6c7086', flexWrap: 'wrap' }}>
          <span><span style={{ color: '#a6e3a1' }}>Mid</span> = (bid+ask)/2</span>
          <span><span style={{ color: '#fab387' }}>Last</span> = most recent trade / day close</span>
          <span><span style={{ color: '#f38ba8' }}>Red cell</span> = field absent from API response</span>
          <span><span style={{ color: '#fab387' }}>Orange delta</span> = wheel target zone (0.15–0.35)</span>
        </div>
      )}

      {/* ── Active tab ── */}
      {provider === 'polygon'    && <PolygonTab />}
      {provider === 'etrade'     && <ETradeTab />}
      {provider === 'marketdata' && <MarketDataTab />}
    </div>
  );
}
