import { useState, useEffect, useCallback, useRef } from 'react';
import { CacheStatusIndicator } from '../components/CacheStatusIndicator.js';
import type { Universe, CacheStats, ConstituentsMeta, Watchlist, IvHistoryProgressEvent, IvHistoryCoverage } from '@shared/types.js';

const PRICE_RANGES = ['1M', '3M', '6M', '1Y', '2Y', '5Y'] as const;
type PriceRange = typeof PRICE_RANGES[number];

interface DataViewProps {
  isSyncing: boolean;
  syncProgress: { scanned: number; total: number; ticker?: string } | null;
  syncUniverseSelection: Universe;
  onSyncUniverseChange: (u: Universe) => void;
  onStartSync: (universe: Universe) => Promise<{ scanned: number }>;
  onCancelSync: () => Promise<void>;
}

export function DataView({ isSyncing, syncProgress, syncUniverseSelection, onSyncUniverseChange, onStartSync, onCancelSync }: DataViewProps) {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [meta, setMeta] = useState<Record<'sp500' | 'russell1000' | 'etf', ConstituentsMeta | null>>({ sp500: null, russell1000: null, etf: null });
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Single-ticker historical price fetch (for backtesting)
  const [priceTicker, setPriceTicker] = useState('');
  const [priceRange, setPriceRange] = useState<PriceRange>('5Y');
  const [isFetchingPrices, setIsFetchingPrices] = useState(false);

  // Watchlist historical price fetch
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [wlRange, setWlRange] = useState<PriceRange>('2Y');
  const [isFetchingWl, setIsFetchingWl] = useState(false);
  const [wlProgress, setWlProgress] = useState<{ done: number; total: number; ticker: string } | null>(null);

  // Universe historical price fetch
  const [univPriceUniverse, setUnivPriceUniverse] = useState<'sp500' | 'russell1000' | 'etf'>('etf');
  const [univPriceRange, setUnivPriceRange] = useState<PriceRange>('2Y');
  const [isFetchingUniv, setIsFetchingUniv] = useState(false);
  const [univProgress, setUnivProgress] = useState<{ done: number; total: number; ticker: string } | null>(null);
  const univCancelRef = useRef(false);

  // IV History gap fill
  const [ivKeyConfigured, setIvKeyConfigured] = useState(false);
  const [ivCoverage, setIvCoverage] = useState<IvHistoryCoverage | null>(null);
  const [ivRunning, setIvRunning] = useState(false);
  const [ivProgress, setIvProgress] = useState<IvHistoryProgressEvent | null>(null);
  const [ivResult, setIvResult] = useState<{ processed: number; skipped: number; failed: number } | null>(null);
  const ivUnsubRef = useRef<(() => void) | null>(null);

  // Price gap fill
  const [priceStaleCount, setPriceStaleCount] = useState<number | null>(null);
  const [priceGapRunning, setPriceGapRunning] = useState(false);
  const [priceGapProgress, setPriceGapProgress] = useState<{ done: number; total: number; ticker: string } | null>(null);
  const [priceGapResult, setPriceGapResult] = useState<{ updated: number; failed: number } | null>(null);
  const priceGapCancelRef = useRef(false);

  const loadStats = useCallback(async () => {
    try {
      const currentStats = await window.api.cache.getStats();
      setStats(currentStats);
      for (const idx of ['sp500', 'russell1000', 'etf'] as const) {
        const m = await window.api.screen.getMeta(idx);
        setMeta((prev) => ({ ...prev, [idx]: m }));
      }
    } catch (err) {
      console.error('Failed to load stats', err);
    }
  }, []);

  const loadIvStatus = useCallback(async () => {
    try {
      const [key, cov] = await Promise.all([
        window.api.settings.getIvolatilityKey(),
        window.api.ivHistory.getCoverage('both'),
      ]);
      setIvKeyConfigured(Boolean(key));
      setIvCoverage(cov);
    } catch { /* non-fatal */ }
  }, []);

  const loadPriceGapStatus = useCallback(async () => {
    try {
      const stale = await window.api.historical.getStalePriceTickers();
      setPriceStaleCount(stale.length);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    loadStats();
    loadIvStatus();
    loadPriceGapStatus();
    window.api.watchlists.list().then(setWatchlists).catch(console.error);
    return () => { ivUnsubRef.current?.(); };
  }, [loadStats, loadIvStatus, loadPriceGapStatus]);

  const startSync = async () => {
    setError(null);
    setStatusMsg(null);
    try {
      const result = await onStartSync(syncUniverseSelection);
      setStatusMsg(`Successfully synced data for ${result.scanned} tickers.`);
      await loadStats();
    } catch (err) {
      if ((err as Error).message.includes('cancelled')) {
        setStatusMsg('Data sync cancelled by user.');
      } else {
        setError((err as Error).message);
      }
    }
  };

  const cancelSync = async () => {
    await onCancelSync();
  };

  const refreshConstituents = async (index: 'sp500' | 'russell1000') => {
    try {
      setStatusMsg(`Refreshing ${index} list from Wikipedia...`);
      await window.api.screen.refreshConstituents(index);
      await loadStats();
      setStatusMsg(`Successfully updated ${index} list.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const importCsv = async (index: 'sp500' | 'russell1000' | 'etf') => {
    try {
      setStatusMsg(`Importing ${index} from CSV...`);
      const result = await window.api.screen.importConstituents('', index);
      await loadStats();
      setStatusMsg(`Successfully imported ${result.count} tickers.`);
    } catch (e) {
      if ((e as Error).message.includes('Cancelled')) {
        setStatusMsg('Import cancelled.');
      } else {
        setError((e as Error).message);
      }
    }
  };

  const fetchUniversePrices = async () => {
    univCancelRef.current = false;
    setIsFetchingUniv(true);
    setUnivProgress(null);
    setError(null);
    setStatusMsg(null);
    try {
      const tickers = await window.api.historical.getUniverseTickers(univPriceUniverse);
      let done = 0;
      const failed: string[] = [];
      for (const ticker of tickers) {
        if (univCancelRef.current) break;
        setUnivProgress({ done, total: tickers.length, ticker });
        try {
          await window.api.historical.fetchPrices(ticker, univPriceRange);
        } catch {
          failed.push(ticker);
        }
        done++;
      }
      setUnivProgress(null);
      if (univCancelRef.current) {
        setStatusMsg(`Cancelled after ${done} / ${tickers.length} tickers.`);
      } else if (failed.length > 0) {
        setStatusMsg(`Done. ${done - failed.length}/${tickers.length} fetched. Failed: ${failed.join(', ')}`);
      } else {
        setStatusMsg(`Fetched ${univPriceRange} price history for all ${tickers.length} ${univPriceUniverse.toUpperCase()} tickers.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsFetchingUniv(false);
      setUnivProgress(null);
    }
  };

  const fetchTickerPrices = async () => {
    const ticker = priceTicker.trim().toUpperCase();
    if (!ticker) return;
    setIsFetchingPrices(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await window.api.historical.fetchPrices(ticker, priceRange);
      if (result.success) {
        setStatusMsg(`Fetched ${result.count ?? 0} price bars for ${ticker} (${priceRange}).`);
      } else {
        setError(`Failed to fetch prices for ${ticker}.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsFetchingPrices(false);
    }
  };

  const fetchWatchlistPrices = async () => {
    if (selectedWatchlistId === null) return;
    setIsFetchingWl(true);
    setWlProgress(null);
    setError(null);
    setStatusMsg(null);
    try {
      const items = await window.api.watchlists.items.list(selectedWatchlistId);
      const tickers = items.map((i) => i.ticker);
      let done = 0;
      const failed: string[] = [];
      for (const ticker of tickers) {
        setWlProgress({ done, total: tickers.length, ticker });
        try {
          await window.api.historical.fetchPrices(ticker, wlRange);
        } catch {
          failed.push(ticker);
        }
        done++;
      }
      setWlProgress(null);
      if (failed.length > 0) {
        setStatusMsg(`Done. ${done - failed.length}/${tickers.length} fetched. Failed: ${failed.join(', ')}`);
      } else {
        setStatusMsg(`Fetched ${wlRange} price history for all ${tickers.length} tickers.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsFetchingWl(false);
      setWlProgress(null);
    }
  };

  const clearMarketData = async () => {
    const proceed = await window.dialog.confirm({
      title: 'Clear All Market Data',
      message: 'This will delete all downloaded stock quotes, fundamentals, and index lists (S&P 500, etc.). Your settings and API key will NOT be affected. Are you sure?'
    });
    if (!proceed) return;

    try {
      await window.api.cache.refresh();
      await loadStats();
      setStatusMsg('All market data has been cleared.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const runIvGapFill = async () => {
    setIvResult(null);
    setIvProgress(null);
    setIvRunning(true);
    ivUnsubRef.current?.();
    ivUnsubRef.current = window.api.ivHistory.onProgress(evt => setIvProgress(evt));
    try {
      const res = await window.api.ivHistory.startBackfill('gap_fill');
      setIvResult(res);
      await loadIvStatus();
    } catch { /* error surfaced via progress */ }
    finally {
      setIvRunning(false);
      ivUnsubRef.current?.();
      ivUnsubRef.current = null;
    }
  };

  const cancelIvGapFill = () => window.api.ivHistory.cancel().catch(console.error);

  const runPriceGapFill = async () => {
    setPriceGapResult(null);
    setPriceGapProgress(null);
    priceGapCancelRef.current = false;
    setPriceGapRunning(true);
    setError(null);
    setStatusMsg(null);
    try {
      const tickers = await window.api.historical.getStalePriceTickers();
      if (tickers.length === 0) {
        setStatusMsg('Price history is already up to date — no gaps found.');
        setPriceGapRunning(false);
        return;
      }
      let updated = 0, failed = 0;
      for (const [i, ticker] of tickers.entries()) {
        if (priceGapCancelRef.current) break;
        setPriceGapProgress({ done: i, total: tickers.length, ticker });
        try {
          await window.api.historical.fetchPrices(ticker, '1M');
          updated++;
        } catch {
          failed++;
        }
      }
      setPriceGapResult({ updated, failed });
      await loadPriceGapStatus();
      if (!priceGapCancelRef.current) {
        setStatusMsg(`Price gap fill done — ${updated} tickers refreshed${failed > 0 ? `, ${failed} failed` : ''}.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPriceGapRunning(false);
      setPriceGapProgress(null);
    }
  };

  const cancelPriceGapFill = () => { priceGapCancelRef.current = true; };

  const isBusy = isFetchingPrices || isFetchingWl || isFetchingUniv;

  const card: React.CSSProperties = { padding: '16px 18px', border: '1px solid var(--border)', borderRadius: '8px', background: 'var(--bg-card, var(--bg))' };
  const cardTitle: React.CSSProperties = { margin: '0 0 4px', fontSize: '14px', fontWeight: 700 };
  const hint: React.CSSProperties = { margin: '0 0 12px', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 };

  return (
    <div className="data-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '16px 20px', boxSizing: 'border-box', overflow: 'hidden' }}>

      {/* ── Toasts ── */}
      {error && (
        <div className="error-toast" onClick={() => setError(null)} style={{ marginBottom: 8 }}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}
      {statusMsg && !error && (
        <div className="status-toast" onClick={() => setStatusMsg(null)} style={{ marginBottom: 8 }}>
          {statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      {/* ── Header ── */}
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 2px', fontSize: 16 }}>Data Management</h2>
        <p style={{ ...hint, margin: 0 }}>Manage the local database: ticker lists, market data, IV history, and price history.</p>
      </div>

      {/* ── Two-column body ── */}
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0, overflow: 'hidden' }}>

        {/* ── Left column ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', minWidth: 0 }}>

          {/* 1. Ticker Lists */}
          <div style={card}>
            <h3 style={cardTitle}>1. Update Ticker Lists</h3>
            <p style={hint}>Scrape equity index constituents from Wikipedia. ETF list is curated (import CSV to override).</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <button onClick={() => refreshConstituents('sp500')} className="primary">↻ S&amp;P 500</button>
              <span className="meta">{meta.sp500 ? `Updated ${new Date(meta.sp500.refreshedAt).toLocaleDateString()}` : 'Not loaded'}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <button onClick={() => refreshConstituents('russell1000')} className="primary">↻ Russell 1000</button>
              <button onClick={() => importCsv('russell1000')} className="secondary">Import CSV</button>
              <span className="meta">{meta.russell1000 ? `Updated ${new Date(meta.russell1000.refreshedAt).toLocaleDateString()}` : 'Not loaded'}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', minWidth: 100 }}>ETF Universe</span>
              <button onClick={() => importCsv('etf')} className="secondary">Import CSV</button>
              <span className="meta">{meta.etf ? `Updated ${new Date(meta.etf.refreshedAt).toLocaleDateString()}` : 'Using bundled list'}</span>
            </div>
          </div>

          {/* 2. Sync Market Data */}
          <div style={card}>
            <h3 style={cardTitle}>2. Sync Market Data</h3>
            <p style={hint}>Download current prices &amp; fundamentals from Polygon.io for all tickers in the selected universe.</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {(['sp500', 'russell1000', 'both', 'etf'] as Universe[]).map((u) => (
                <button key={u} className={`univ-btn ${syncUniverseSelection === u ? 'active' : ''}`}
                  onClick={() => onSyncUniverseChange(u)} disabled={isSyncing}>
                  {u === 'sp500' ? 'S&P 500' : u === 'russell1000' ? 'Russell 1000' : u === 'both' ? 'Both' : 'ETFs'}
                </button>
              ))}
            </div>
            {isSyncing ? (
              <div style={{ background: 'var(--bg-lighter)', borderRadius: 4, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: '0.85em' }}>
                  <strong>Downloading…</strong>
                  {syncProgress && syncProgress.total > 0 && <span>{Math.round(syncProgress.scanned / syncProgress.total * 100)}%</span>}
                </div>
                {syncProgress && syncProgress.total > 0 && (
                  <>
                    <progress value={syncProgress.scanned} max={syncProgress.total} style={{ width: '100%', height: 8 }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: '0.8em', color: 'var(--text-muted)' }}>
                      <span>{syncProgress.scanned} / {syncProgress.total}</span>
                      <span>Fetching: <strong>{syncProgress.ticker}</strong></span>
                    </div>
                  </>
                )}
                <button onClick={cancelSync} className="danger" style={{ marginTop: 10, padding: '6px 14px' }}>Stop Sync</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={startSync} className="primary">▶ Start Sync</button>
                <button onClick={clearMarketData} className="danger">Clear All Market Data</button>
              </div>
            )}
          </div>

          {/* 3. IV History Sync */}
          <div style={card}>
            <h3 style={cardTitle}>3. IV History Sync</h3>
            <p style={hint}>Fetch missing daily IV readings from IVolatility.com for S&amp;P 500, Russell 1000 + ETF Universe. One API call per ticker — run weekly.</p>
            {!ivKeyConfigured ? (
              <p style={{ ...hint, color: 'var(--warning, #ff9800)', margin: 0 }}>
                IVolatility API key not configured — add it in <strong>Settings → API &amp; Data</strong>.
              </p>
            ) : (
              <>
                {ivCoverage && (
                  <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: '0.82em', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                    <span>Last: <strong style={{ color: 'var(--text)' }}>{ivCoverage.lastRefreshDate ?? '—'}</strong></span>
                    <span>Rows: <strong style={{ color: 'var(--text)' }}>{ivCoverage.totalReadings.toLocaleString()}</strong></span>
                    <span><strong style={{ color: '#4caf50' }}>{ivCoverage.complete}</strong> complete · <strong style={{ color: '#ff9800' }}>{ivCoverage.partial}</strong> partial · <strong style={{ color: '#ef5350' }}>{ivCoverage.none}</strong> none</span>
                  </div>
                )}
                {ivRunning && ivProgress && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: '0.82em', color: 'var(--text-muted)' }}>
                      <span><strong style={{ color: 'var(--text)' }}>{ivProgress.ticker}</strong></span>
                      <span>{ivProgress.processed + ivProgress.skipped + ivProgress.failed} / {ivProgress.total} · {ivProgress.callsPerMin}/min</span>
                    </div>
                    <progress value={ivProgress.processed + ivProgress.skipped + ivProgress.failed} max={ivProgress.total} style={{ width: '100%', height: 7 }} />
                    {ivProgress.lastError && <div style={{ marginTop: 3, fontSize: '0.78em', color: '#ef5350' }}>✗ {ivProgress.ticker}: {ivProgress.lastError}</div>}
                  </div>
                )}
                {!ivRunning && ivResult && (
                  <div style={{ marginBottom: 10, fontSize: '0.85em', color: 'var(--text-muted)' }}>
                    Done — <strong style={{ color: '#4caf50' }}>{ivResult.processed}</strong> updated · <strong>{ivResult.skipped}</strong> skipped · <strong style={{ color: ivResult.failed > 0 ? '#ef5350' : 'inherit' }}>{ivResult.failed}</strong> failed
                  </div>
                )}
                {ivRunning
                  ? <button onClick={cancelIvGapFill} className="danger" style={{ padding: '6px 14px' }}>Stop IV Sync</button>
                  : <button onClick={runIvGapFill} className="primary">▶ Run IV Gap Fill</button>
                }
              </>
            )}
          </div>

        </div>{/* end left */}

        {/* ── Right column ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', minWidth: 0 }}>

          {/* 4. Historical Prices */}
          <div style={card}>
            <h3 style={cardTitle}>4. Fetch Historical Prices</h3>
            <p style={hint}>Download daily OHLCV price history. Required before running a backtest on a ticker.</p>

            {/* Single ticker */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '0.78em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Single Ticker</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input type="text" placeholder="e.g. AAPL" value={priceTicker}
                  onChange={(e) => setPriceTicker(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && fetchTickerPrices()}
                  style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 110, textTransform: 'uppercase' }}
                  disabled={isBusy} />
                <div style={{ display: 'flex', gap: 4 }}>
                  {PRICE_RANGES.map((r) => (
                    <button key={r} className={`univ-btn ${priceRange === r ? 'active' : ''}`} onClick={() => setPriceRange(r)} disabled={isBusy}>{r}</button>
                  ))}
                </div>
                <button className="primary" onClick={fetchTickerPrices} disabled={isBusy || !priceTicker.trim()}>
                  {isFetchingPrices ? 'Fetching…' : '↓ Fetch'}
                </button>
              </div>
            </div>

            {/* Watchlist */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ fontSize: '0.78em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Watchlist</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={selectedWatchlistId ?? ''} onChange={(e) => setSelectedWatchlistId(e.target.value ? Number(e.target.value) : null)}
                  disabled={isBusy}
                  style={{ padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', minWidth: 160 }}>
                  <option value="">— Select watchlist —</option>
                  {watchlists.map((wl) => (
                    <option key={wl.id} value={wl.id}>{wl.name} ({wl.itemCount ?? '?'})</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 4 }}>
                  {PRICE_RANGES.map((r) => (
                    <button key={r} className={`univ-btn ${wlRange === r ? 'active' : ''}`} onClick={() => setWlRange(r)} disabled={isBusy}>{r}</button>
                  ))}
                </div>
                <button className="primary" onClick={fetchWatchlistPrices} disabled={isBusy || selectedWatchlistId === null}>
                  {isFetchingWl ? 'Fetching…' : '↓ Fetch All'}
                </button>
              </div>
              {isFetchingWl && wlProgress && (
                <div style={{ marginTop: 10 }}>
                  <progress value={wlProgress.done} max={wlProgress.total} style={{ width: '100%', height: 7 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: '0.8em', color: 'var(--text-muted)' }}>
                    <span>{wlProgress.done} / {wlProgress.total}</span>
                    <span>Fetching: <strong>{wlProgress.ticker}</strong></span>
                  </div>
                </div>
              )}
            </div>

            {/* Universe bulk */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ fontSize: '0.78em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Universe Bulk Load</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {(['sp500', 'russell1000', 'etf'] as const).map((u) => (
                  <button key={u} className={`univ-btn ${univPriceUniverse === u ? 'active' : ''}`}
                    onClick={() => setUnivPriceUniverse(u)} disabled={isBusy}>
                    {u === 'sp500' ? 'S&P 500' : u === 'russell1000' ? 'Russell 1000' : 'ETFs'}
                  </button>
                ))}
                <div style={{ display: 'flex', gap: 4 }}>
                  {PRICE_RANGES.filter(r => r !== '5Y').map((r) => (
                    <button key={r} className={`univ-btn ${univPriceRange === r ? 'active' : ''}`} onClick={() => setUnivPriceRange(r)} disabled={isBusy}>{r}</button>
                  ))}
                </div>
                {isFetchingUniv
                  ? <button className="danger" onClick={() => { univCancelRef.current = true; }} style={{ padding: '6px 12px' }}>Stop</button>
                  : <button className="primary" onClick={fetchUniversePrices} disabled={isBusy}>↓ Fetch All</button>}
              </div>
              {isFetchingUniv && univProgress && (
                <div style={{ marginTop: 10 }}>
                  <progress value={univProgress.done} max={univProgress.total} style={{ width: '100%', height: 7 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: '0.8em', color: 'var(--text-muted)' }}>
                    <span>{univProgress.done} / {univProgress.total}</span>
                    <span>Fetching: <strong>{univProgress.ticker}</strong></span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 5. Price Gap Fill */}
          <div style={card}>
            <h3 style={cardTitle}>5. Price Gap Fill</h3>
            <p style={hint}>Refreshes price history for tickers already loaded but missing recent bars. Fetches the last month for each stale ticker — run weekly after initial bulk load.</p>
            {priceStaleCount !== null && (
              <div style={{ fontSize: '0.82em', color: 'var(--text-muted)', marginBottom: 10, flexWrap: 'wrap' }}>
                {priceStaleCount === 0
                  ? <span style={{ color: '#4caf50' }}>✓ All price history is up to date.</span>
                  : <span><strong style={{ color: '#ff9800' }}>{priceStaleCount}</strong> ticker{priceStaleCount !== 1 ? 's' : ''} need a refresh.</span>}
              </div>
            )}
            {priceGapRunning && priceGapProgress && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: '0.82em', color: 'var(--text-muted)' }}>
                  <span><strong style={{ color: 'var(--text)' }}>{priceGapProgress.ticker}</strong></span>
                  <span>{priceGapProgress.done + 1} / {priceGapProgress.total}</span>
                </div>
                <progress value={priceGapProgress.done + 1} max={priceGapProgress.total} style={{ width: '100%', height: 7 }} />
              </div>
            )}
            {!priceGapRunning && priceGapResult && (
              <div style={{ marginBottom: 10, fontSize: '0.85em', color: 'var(--text-muted)' }}>
                Done — <strong style={{ color: '#4caf50' }}>{priceGapResult.updated}</strong> updated · <strong style={{ color: priceGapResult.failed > 0 ? '#ef5350' : 'inherit' }}>{priceGapResult.failed}</strong> failed
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {priceGapRunning
                ? <button onClick={cancelPriceGapFill} className="danger" style={{ padding: '6px 14px' }}>Stop</button>
                : <button onClick={runPriceGapFill} className="primary" disabled={priceStaleCount === 0}>▶ Run Price Gap Fill</button>}
              <button onClick={loadPriceGapStatus} className="secondary" disabled={priceGapRunning} style={{ padding: '6px 12px' }}>↻ Check</button>
            </div>
          </div>

          {/* 6. DB Stats */}
          <div style={card}>
            <h3 style={cardTitle}>Local Database Stats</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', lineHeight: 1.8, fontSize: '0.9em' }}>
              <li><strong>Cached Records:</strong> {stats?.recordCount ?? 0}</li>
              <li><strong>Last Sync Completed:</strong> {stats?.lastScreenerRun ? new Date(stats.lastScreenerRun).toLocaleString() : 'Never'}</li>
              {ivCoverage && <li><strong>IV Readings:</strong> {ivCoverage.totalReadings.toLocaleString()}</li>}
            </ul>
          </div>

        </div>{/* end right */}
      </div>{/* end two-column */}
    </div>
  );
}
