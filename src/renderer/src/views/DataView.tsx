import { useState, useEffect, useCallback } from 'react';
import { CacheStatusIndicator } from '../components/CacheStatusIndicator.js';
import type { Universe, CacheStats, ConstituentsMeta, Watchlist } from '@shared/types.js';

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
  const [meta, setMeta] = useState<Record<'sp500' | 'russell1000', ConstituentsMeta | null>>({ sp500: null, russell1000: null });
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Single-ticker historical price fetch (for backtesting)
  const [priceTicker, setPriceTicker] = useState('');
  const [priceRange, setPriceRange] = useState<PriceRange>('5Y');
  const [isFetchingPrices, setIsFetchingPrices] = useState(false);

  // Watchlist historical price fetch
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [wlRange, setWlRange] = useState<PriceRange>('5Y');
  const [isFetchingWl, setIsFetchingWl] = useState(false);
  const [wlProgress, setWlProgress] = useState<{ done: number; total: number; ticker: string } | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const currentStats = await window.api.cache.getStats();
      setStats(currentStats);
      for (const idx of ['sp500', 'russell1000'] as const) {
        const m = await window.api.screen.getMeta(idx);
        setMeta((prev) => ({ ...prev, [idx]: m }));
      }
    } catch (err) {
      console.error('Failed to load stats', err);
    }
  }, []);

  useEffect(() => {
    loadStats();
    window.api.watchlists.list().then(setWatchlists).catch(console.error);
  }, [loadStats]);

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

  const importCsv = async (index: 'sp500' | 'russell1000') => {
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

  const isBusy = isFetchingPrices || isFetchingWl;

  return (
    <div className="data-view" style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}
      {statusMsg && !error && (
        <div className="status-toast" onClick={() => setStatusMsg(null)}>
          {statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      <h2>Data Management</h2>
      <p className="hint">
        Manage the local database. Fetch lists of companies and download their quotes and fundamentals to enable instantaneous screening.
      </p>

      <div className="card" style={{ marginTop: '20px', padding: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <h3>1. Update Ticker Lists</h3>
        <p className="hint" style={{ marginBottom: '15px' }}>Scrape the latest index constituents from Wikipedia.</p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button onClick={() => refreshConstituents('sp500')} className="primary">↻ Update S&P 500</button>
          <span className="meta" style={{ marginLeft: '10px' }}>
            {meta.sp500 ? `Last synced: ${new Date(meta.sp500.refreshedAt).toLocaleDateString()}` : 'Not loaded'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px' }}>
          <button onClick={() => refreshConstituents('russell1000')} className="primary">↻ Update Russell 1000</button>
          <button onClick={() => importCsv('russell1000')} className="secondary">Import CSV</button>
          <span className="meta" style={{ marginLeft: '10px' }}>
            {meta.russell1000 ? `Last synced: ${new Date(meta.russell1000.refreshedAt).toLocaleDateString()}` : 'Not loaded'}
          </span>
        </div>
      </div>

      <div className="card" style={{ marginTop: '20px', padding: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <h3>2. Sync Market Data</h3>
        <p className="hint" style={{ marginBottom: '15px' }}>Download current prices and fundamentals from Polygon.io for all tickers in the selected universe.</p>

        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          {(['sp500', 'russell1000', 'both'] as Universe[]).map((u) => (
            <button
              key={u}
              className={`univ-btn ${syncUniverseSelection === u ? 'active' : ''}`}
              onClick={() => onSyncUniverseChange(u)}
              disabled={isSyncing}
            >
              {u === 'sp500' ? 'S&P 500' : u === 'russell1000' ? 'Russell 1000' : 'Both'}
            </button>
          ))}
        </div>

        {isSyncing ? (
          <div style={{ padding: '15px', backgroundColor: 'var(--bg-lighter)', borderRadius: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
              <strong>Downloading...</strong>
              {syncProgress && syncProgress.total > 0 && (
                <span>{Math.round((syncProgress.scanned / syncProgress.total) * 100)}%</span>
              )}
            </div>
            {syncProgress && syncProgress.total > 0 && (
              <>
                <progress value={syncProgress.scanned} max={syncProgress.total} style={{ width: '100%', height: '10px' }}></progress>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '5px', fontSize: '0.9em', color: 'var(--text-muted)' }}>
                  <span>{syncProgress.scanned} / {syncProgress.total} tickers processed</span>
                  <span>Fetching: <strong>{syncProgress.ticker}</strong></span>
                </div>
              </>
            )}
            <button onClick={cancelSync} className="danger" style={{ marginTop: '15px' }}>Stop Sync</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={startSync} className="primary" style={{ padding: '10px 20px', fontSize: '1.1em' }}>
              ▶ Start Sync
            </button>
            <button onClick={clearMarketData} className="danger" style={{ padding: '10px 20px', fontSize: '1.1em' }}>
              Clear All Market Data
            </button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: '20px', padding: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <h3>3. Fetch Historical Prices</h3>
        <p className="hint" style={{ marginBottom: '15px' }}>Download daily OHLCV price history. Required before running a backtest on a ticker.</p>

        {/* Single ticker */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Single Ticker</div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="e.g. AAPL"
              value={priceTicker}
              onChange={(e) => setPriceTicker(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && fetchTickerPrices()}
              style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: '140px', textTransform: 'uppercase' }}
              disabled={isBusy}
            />
            <div style={{ display: 'flex', gap: '6px' }}>
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
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
          <div style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Watchlist</div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={selectedWatchlistId ?? ''}
              onChange={(e) => setSelectedWatchlistId(e.target.value ? Number(e.target.value) : null)}
              disabled={isBusy}
              style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', minWidth: '180px' }}
            >
              <option value="">— Select watchlist —</option>
              {watchlists.map((wl) => (
                <option key={wl.id} value={wl.id}>{wl.name} ({wl.itemCount ?? '?'} tickers)</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: '6px' }}>
              {PRICE_RANGES.map((r) => (
                <button key={r} className={`univ-btn ${wlRange === r ? 'active' : ''}`} onClick={() => setWlRange(r)} disabled={isBusy}>{r}</button>
              ))}
            </div>
            <button className="primary" onClick={fetchWatchlistPrices} disabled={isBusy || selectedWatchlistId === null}>
              {isFetchingWl ? 'Fetching…' : '↓ Fetch All'}
            </button>
          </div>
          {isFetchingWl && wlProgress && (
            <div style={{ marginTop: '12px' }}>
              <progress value={wlProgress.done} max={wlProgress.total} style={{ width: '100%', height: '8px' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '0.85em', color: 'var(--text-muted)' }}>
                <span>{wlProgress.done} / {wlProgress.total}</span>
                <span>Fetching: <strong>{wlProgress.ticker}</strong></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: '20px', padding: '20px', border: '1px solid var(--border)', borderRadius: '8px' }}>
        <h3>Local Database Stats</h3>
        <ul style={{ listStyleType: 'none', padding: 0, lineHeight: '1.6' }}>
          <li><strong>Cached Records:</strong> {stats?.recordCount ?? 0}</li>
          <li><strong>Last Sync Completed:</strong> {stats?.lastScreenerRun ? new Date(stats.lastScreenerRun).toLocaleString() : 'Never'}</li>
        </ul>
      </div>
    </div>
  );
}
