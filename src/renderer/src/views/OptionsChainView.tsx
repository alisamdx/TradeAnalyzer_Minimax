// OptionsChainView — Shows options chain data filtered for profitability.
// Left pane: watchlist list + ticker list (like ValidateView).
// Right pane: strategy cards + full chain table with highlights.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Watchlist,
  WatchlistItem,
  OptionContract,
  OptionsChainExpirationSummary,
  OptionsChainViewData
} from '@shared/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`;
}
function fmtNum(v: number | null, decimals = 2): string {
  return v === null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function dteDays(expirationDate: string): number {
  const exp = new Date(expirationDate + 'T00:00:00Z');
  const now = new Date();
  return Math.max(0, Math.round((exp.getTime() - now.getTime()) / 86_400_000));
}

/** Annualized return: (premium / (strike * 100)) * (365 / DTE) * 100 */
function annualizedReturn(premium: number, strike: number, dte: number): number | null {
  if (dte <= 0 || strike <= 0) return null;
  return (premium / (strike * 100)) * (365 / dte) * 100;
}

function ivColor(iv: number): string {
  if (iv >= 30) return '#3fb950';
  if (iv >= 20) return '#d29922';
  return '#8b949e';
}

/** Format YYYY-MM-DD as "Mon DD" in local time (no UTC shift). */
function formatExpDate(dateStr: string): string {
  const parts = dateStr.split('-');
  const m = Number(parts[1] ?? '1');
  const d = Number(parts[2] ?? '1');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1] ?? 'Jan'} ${d}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StrategyCard {
  label: string;
  side: 'call' | 'put';
  strategy: string;
  contract: OptionContract;
  dte: number;
  annualRet: number | null;
  premiumYield: number;
}

type StrikeFilter = '30' | 'all';

// ─── Component ───────────────────────────────────────────────────────────────

interface OptionsChainViewProps {
  initialTicker?: string | null;
  initialExpiry?: string | null;
  clearInitialTicker?: () => void;
}

export function OptionsChainView({ initialTicker, initialExpiry, clearInitialTicker }: OptionsChainViewProps) {
  // Sidebar state
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [tickers, setTickers] = useState<WatchlistItem[]>([]);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  // Chain data state
  const [expirations, setExpirations] = useState<OptionsChainExpirationSummary[]>([]);
  const [selectedExpiration, setSelectedExpiration] = useState<string | null>(null);
  const [chainData, setChainData] = useState<OptionsChainViewData | null>(null);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [currentIv, setCurrentIv] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingChain, setLoadingChain] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [filterSide, setFilterSide] = useState<'all' | 'call' | 'put'>('all');
  const [minOI, setMinOI] = useState(0);
  const [strikeFilter, setStrikeFilter] = useState<StrikeFilter>('30');

  // Load watchlists on mount
  useEffect(() => {
    window.api.watchlists.list()
      .then(setWatchlists)
      .catch((e) => setError((e as Error).message));
  }, []);

  // Load tickers when watchlist changes
  useEffect(() => {
    if (!selectedWatchlistId) { setTickers([]); return; }
    window.api.watchlists.items.list(selectedWatchlistId)
      .then(setTickers)
      .catch(() => setTickers([]));
  }, [selectedWatchlistId]);

  // Load expirations when ticker changes
  const loadExpirations = useCallback(async (ticker: string, preferExpiry?: string | null) => {
    setLoading(true);
    setError(null);
    setChainData(null);
    setSelectedExpiration(null);
    try {
      const result = await window.api.optionsChain.getNearExpirations(ticker);
      setExpirations(result.expirations);
      setCurrentPrice(result.currentPrice);
      setCurrentIv(result.currentIv);
      // Prefer the requested expiry; fall back to first expiration with contracts
      const preferred = preferExpiry
        ? result.expirations.find(e => e.date === preferExpiry)
        : null;
      const first = result.expirations.find(e => e.callCount > 0 || e.putCount > 0);
      const toSelect = preferred ?? first;
      if (toSelect) setSelectedExpiration(toSelect.date);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load chain when expiration changes
  useEffect(() => {
    if (!selectedTicker || !selectedExpiration) { setChainData(null); return; }
    setLoadingChain(true);
    setError(null);
    window.api.optionsChain.getChain(selectedTicker, selectedExpiration)
      .then(setChainData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadingChain(false));
  }, [selectedTicker, selectedExpiration]);

  // Handle initial ticker from navigation
  const initialHandledRef = useRef(false);
  useEffect(() => {
    if (initialTicker && !initialHandledRef.current && watchlists.length > 0) {
      initialHandledRef.current = true;
      setSelectedTicker(initialTicker);
      loadExpirations(initialTicker, initialExpiry);
      clearInitialTicker?.();
    }
  }, [initialTicker, initialExpiry, watchlists, loadExpirations, clearInitialTicker]);

  // Ticker click handler
  const handleTickerClick = useCallback((ticker: string) => {
    setSelectedTicker(ticker);
    loadExpirations(ticker, null);
  }, [loadExpirations]);

  // Navigate to validate for the selected ticker
  const handleValidate = useCallback(() => {
    if (selectedTicker) {
      window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: selectedTicker } }));
    }
  }, [selectedTicker]);

  // Derive strategy cards from chain data
  const strategyCards = deriveStrategyCards(chainData, currentPrice);

  // Filter contracts for display
  let filteredContracts = (chainData?.contracts ?? []).filter(c => {
    if (filterSide === 'call' && c.side !== 'call') return false;
    if (filterSide === 'put' && c.side !== 'put') return false;
    if (minOI > 0 && (c.openInterest ?? 0) < minOI) return false;
    return true;
  });

  // Apply strike filter: show 15 above and 15 below ATM, or all
  if (strikeFilter === '30' && currentPrice !== null) {
    const allStrikes = [...new Set(filteredContracts.map(c => c.strike))].sort((a, b) => a - b);
    // Find ATM index (closest strike to current price)
    let atmIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < allStrikes.length; i++) {
      const dist = Math.abs(allStrikes[i]! - currentPrice);
      if (dist < minDist) { minDist = dist; atmIdx = i; }
    }
    const startIdx = Math.max(0, atmIdx - 15);
    const endIdx = Math.min(allStrikes.length, atmIdx + 16);
    const visibleStrikes = new Set(allStrikes.slice(startIdx, endIdx));
    filteredContracts = filteredContracts.filter(c => visibleStrikes.has(c.strike));
  }

  // Separate calls and puts for chain layout
  const calls = filteredContracts.filter(c => c.side === 'call').sort((a, b) => b.strike - a.strike);
  const puts = filteredContracts.filter(c => c.side === 'put').sort((a, b) => a.strike - b.strike);
  const strikes = [...new Set(filteredContracts.map(c => c.strike))].sort((a, b) => a - b);

  // Filter expirations: show up to 5 Fridays (current week + next 4)
  const visibleExpirations = expirations.filter(e => e.callCount > 0 || e.putCount > 0).slice(0, 5);

  return (
    <div className="options-chain-view">
      {/* Left Sidebar — list style like ValidateView */}
      <aside className="oc-sidebar">
        <div className="oc-sidebar-header">
          <h3>Options Chain</h3>
          <ul className="watchlist-selector-list">
            {watchlists.map((w) => (
              <li key={w.id}
                className={`watchlist-selector-item ${selectedWatchlistId === w.id ? 'active' : ''}`}
                onClick={() => setSelectedWatchlistId(w.id)}>
                <span className="name">{w.name}</span>
                <span className="count">{w.itemCount}</span>
              </li>
            ))}
          </ul>
        </div>
        {tickers.length > 0 && (
          <ul className="oc-ticker-list">
            {tickers.map(t => (
              <li key={t.id}
                className={t.ticker === selectedTicker ? 'active' : ''}
                onClick={() => handleTickerClick(t.ticker)}>
                {t.ticker}
              </li>
            ))}
          </ul>
        )}
        {selectedTicker && (
          <button className="oc-validate-btn" onClick={handleValidate}>
            🎯 Validate {selectedTicker}
          </button>
        )}
      </aside>

      {/* Main Content */}
      <div className="oc-main">
        {!selectedTicker && !loading && (
          <div className="oc-empty">Select a ticker to view options chain data.</div>
        )}
        {loading && <div className="oc-loading">Loading…</div>}
        {error && <div className="oc-error">{error}</div>}

        {selectedTicker && !loading && (
          <>
            {/* Header */}
            <div className="oc-header">
              <h2>{selectedTicker} Options</h2>
              {currentPrice !== null && <span className="oc-price">${currentPrice.toFixed(2)}</span>}
              {currentIv !== null && (
                <span className="oc-iv" style={{ color: ivColor(currentIv) }}>IV: {currentIv.toFixed(1)}%</span>
              )}
            </div>

            {/* Expiration Tabs — Fridays only, current week + next 4 */}
            {visibleExpirations.length > 0 && (
              <div className="oc-exp-tabs">
                {visibleExpirations.map(exp => (
                  <button key={exp.date}
                    className={`oc-exp-tab ${exp.date === selectedExpiration ? 'active' : ''}`}
                    onClick={() => setSelectedExpiration(exp.date)}>
                    {formatExpDate(exp.date)}
                    <span className="oc-dte">{exp.dte}d</span>
                    <span className="oc-counts">{exp.callCount}c/{exp.putCount}p</span>
                  </button>
                ))}
              </div>
            )}

            {/* Strategy Cards */}
            {strategyCards.length > 0 && (
              <div className="oc-strategy-cards">
                {strategyCards.map((card, i) => (
                  <div key={i} className={`oc-card oc-card-${card.side}`}>
                    <div className="oc-card-label">{card.label}</div>
                    <div className="oc-card-strategy">{card.strategy}</div>
                    <div className="oc-card-details">
                      <span>Strike: {fmtPrice(card.contract.strike)}</span>
                      <span>DTE: {card.dte}</span>
                      <span>Delta: {fmtNum(card.contract.delta)}</span>
                      <span>IV: <span style={{ color: ivColor(card.contract.iv * 100) }}>{(card.contract.iv * 100).toFixed(1)}%</span></span>
                      <span>Prem: {fmtPrice(card.contract.bid)}</span>
                      <span className="oc-card-yield">Ann: {card.annualRet !== null ? `${card.annualRet.toFixed(1)}%` : '—'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Filter Controls */}
            <div className="oc-filters">
              <button className={filterSide === 'all' ? 'active' : ''} onClick={() => setFilterSide('all')}>All</button>
              <button className={filterSide === 'put' ? 'active' : ''} onClick={() => setFilterSide('put')}>Puts</button>
              <button className={filterSide === 'call' ? 'active' : ''} onClick={() => setFilterSide('call')}>Calls</button>
              <span className="oc-filter-sep">|</span>
              <button className={strikeFilter === '30' ? 'active' : ''} onClick={() => setStrikeFilter('30')}>30 Strikes</button>
              <button className={strikeFilter === 'all' ? 'active' : ''} onClick={() => setStrikeFilter('all')}>All</button>
              <label className="oc-oi-filter">Min OI: <input type="number" value={minOI} onChange={e => setMinOI(Number(e.target.value) || 0)} style={{ width: 50 }} /></label>
            </div>

            {/* Legend */}
            <div className="oc-legend">
              <span className="oc-legend-item">
                <span className="oc-legend-swatch oc-legend-atm" />
                Row within 2% of current price (ATM zone)
              </span>
              <span className="oc-legend-item">
                <span className="oc-legend-swatch oc-legend-profitable" />
                Premium yield &gt;15% annualized
              </span>
              <span className="oc-legend-item">
                <span className="oc-legend-swatch oc-legend-delta" />
                Delta in target range (puts 0.15–0.35 · calls ≥0.65)
              </span>
            </div>

            {/* Chain Table */}
            {loadingChain && <div className="oc-loading">Loading chain…</div>}
            {!loadingChain && chainData && (
              <div className="oc-chain-table-wrapper">
                <table className="oc-chain-table">
                  <thead>
                    <tr>
                      {filterSide !== 'put' && <>
                        <th colSpan={6} className="oc-side-header oc-call-header">Calls</th>
                      </>}
                      <th>Strike</th>
                      {filterSide !== 'call' && <>
                        <th colSpan={6} className="oc-side-header oc-put-header">Puts</th>
                      </>}
                    </tr>
                    <tr>
                      {filterSide !== 'put' && <>
                        <th>Bid</th><th>Ask</th><th>Delta</th><th>IV%</th><th>OI</th><th>Vol</th>
                      </>}
                      <th></th>
                      {filterSide !== 'call' && <>
                        <th>Bid</th><th>Ask</th><th>Delta</th><th>IV%</th><th>OI</th><th>Vol</th>
                      </>}
                    </tr>
                  </thead>
                  <tbody>
                    {strikes.map(strike => {
                      const call = calls.find(c => c.strike === strike);
                      const put = puts.find(p => p.strike === strike);
                      const isAtm = currentPrice !== null && Math.abs(strike - currentPrice) < currentPrice * 0.02;
                      const callYield = call ? annualizedReturn(call.bid, call.strike, dteDays(chainData.expiration)) : null;
                      const putYield = put ? annualizedReturn(put.bid, put.strike, dteDays(chainData.expiration)) : null;

                      // Spread quality: color bid by spread-pct. <10% = default, 10-30% = amber, >30% = red.
                      const spreadColor = (bid: number, ask: number) => {
                        const mid = (bid + ask) / 2;
                        if (mid <= 0) return undefined;
                        const pct = (ask - bid) / mid * 100;
                        if (pct > 30) return '#ef4444';
                        if (pct > 10) return '#f59e0b';
                        return undefined;
                      };
                      const spreadTitle = (bid: number, ask: number) => {
                        const mid = (bid + ask) / 2;
                        const spread = ask - bid;
                        const pct = mid > 0 ? (spread / mid * 100).toFixed(0) : '—';
                        return `Bid $${bid.toFixed(2)}  Ask $${ask.toFixed(2)}  Spread $${spread.toFixed(2)} (${pct}%)`;
                      };

                      return (
                        <tr key={strike} className={isAtm ? 'oc-atm-row' : ''}>
                          {filterSide !== 'put' && call && (
                            <>
                              <td className={callYield !== null && callYield > 15 ? 'oc-profitable' : ''}
                                  style={{ color: spreadColor(call.bid, call.ask) }}
                                  title={spreadTitle(call.bid, call.ask)}>
                                {fmtPrice(call.bid)}
                              </td>
                              <td>{fmtPrice(call.ask)}</td>
                              <td className={call.delta !== null && call.delta >= 0.65 ? 'oc-delta-highlight' : ''}>{fmtNum(call.delta)}</td>
                              <td style={{ color: ivColor(call.iv * 100) }}>{(call.iv * 100).toFixed(1)}%</td>
                              <td>{fmtNum(call.openInterest, 0)}</td>
                              <td>{fmtNum(call.volume, 0)}</td>
                            </>
                          )}
                          {filterSide !== 'put' && !call && filterSide !== 'call' && <td colSpan={6} className="oc-empty-cell">—</td>}
                          <td className="oc-strike-cell">{fmtPrice(strike)}</td>
                          {filterSide !== 'call' && put && (
                            <>
                              <td className={putYield !== null && putYield > 15 ? 'oc-profitable' : ''}
                                  style={{ color: spreadColor(put.bid, put.ask) }}
                                  title={spreadTitle(put.bid, put.ask)}>
                                {fmtPrice(put.bid)}
                              </td>
                              <td>{fmtPrice(put.ask)}</td>
                              <td className={put.delta !== null && Math.abs(put.delta) >= 0.15 && Math.abs(put.delta) <= 0.35 ? 'oc-delta-highlight' : ''}>{fmtNum(put.delta)}</td>
                              <td style={{ color: ivColor(put.iv * 100) }}>{(put.iv * 100).toFixed(1)}%</td>
                              <td>{fmtNum(put.openInterest, 0)}</td>
                              <td>{fmtNum(put.volume, 0)}</td>
                            </>
                          )}
                          {filterSide !== 'call' && !put && filterSide !== 'put' && <td colSpan={6} className="oc-empty-cell">—</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Strategy Card Logic ──────────────────────────────────────────────────────

function deriveStrategyCards(
  data: OptionsChainViewData | null,
  currentPrice: number | null
): StrategyCard[] {
  if (!data || !data.contracts.length) return [];
  const dte = dteDays(data.expiration);
  const cards: StrategyCard[] = [];

  // Best CSP (put, delta 0.15-0.35, highest annualized yield)
  const cspPuts = data.contracts
    .filter(c => c.side === 'put' && c.delta !== null && Math.abs(c.delta) >= 0.15 && Math.abs(c.delta) <= 0.35 && c.bid > 0)
    .sort((a, b) => {
      const ya = annualizedReturn(a.bid, a.strike, dte) ?? -Infinity;
      const yb = annualizedReturn(b.bid, b.strike, dte) ?? -Infinity;
      return yb - ya;
    });
  if (cspPuts.length > 0) {
    const best = cspPuts[0]!;
    cards.push({
      label: 'Best CSP',
      side: 'put',
      strategy: `Sell ${best.strike} Put`,
      contract: best,
      dte,
      annualRet: annualizedReturn(best.bid, best.strike, dte),
      premiumYield: (best.bid / best.strike) * 100
    });
  }

  // Best CC (call, delta 0.15-0.35 for OTM, highest annualized yield)
  const ccCalls = data.contracts
    .filter(c => c.side === 'call' && c.delta !== null && c.delta >= 0.15 && c.delta <= 0.35 && c.bid > 0)
    .sort((a, b) => {
      const ya = annualizedReturn(a.bid, a.strike, dte) ?? -Infinity;
      const yb = annualizedReturn(b.bid, b.strike, dte) ?? -Infinity;
      return yb - ya;
    });
  if (ccCalls.length > 0) {
    const best = ccCalls[0]!;
    cards.push({
      label: 'Best CC',
      side: 'call',
      strategy: `Sell ${best.strike} Call`,
      contract: best,
      dte,
      annualRet: annualizedReturn(best.bid, best.strike, dte),
      premiumYield: (best.bid / best.strike) * 100
    });
  }

  // High IV Play (highest IV contract with OI > 0)
  const highIv = data.contracts
    .filter(c => c.iv > 0.30 && (c.openInterest ?? 0) > 0 && c.bid > 0)  // iv is decimal fraction (0.30 = 30%)
    .sort((a, b) => b.iv - a.iv)[0];
  if (highIv) {
    cards.push({
      label: 'High IV',
      side: highIv.side,
      strategy: `Sell ${highIv.strike} ${highIv.side === 'call' ? 'Call' : 'Put'}`,
      contract: highIv,
      dte,
      annualRet: annualizedReturn(highIv.bid, highIv.strike, dte),
      premiumYield: (highIv.bid / highIv.strike) * 100
    });
  }

  return cards;
}