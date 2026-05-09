import { useState, useEffect, useCallback } from 'react';
import { CacheStatusIndicator } from '../components/CacheStatusIndicator.js';
import type { Universe, CacheStats, ConstituentsMeta } from '@shared/types.js';

export function DataView() {
  const [universe, setUniverse] = useState<Universe>('sp500');
  const [isSyncing, setIsSyncing] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; total: number; ticker?: string } | null>(null);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [meta, setMeta] = useState<Record<'sp500' | 'russell1000', ConstituentsMeta | null>>({ sp500: null, russell1000: null });
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

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
    
    const unsubProgress = window.api.screen.onSyncProgress((data) => {
      setProgress(data);
    });

    return () => {
      unsubProgress();
    };
  }, [loadStats]);

  const startSync = async () => {
    setIsSyncing(true);
    setProgress(null);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await window.api.screen.syncUniverse(universe);
      setStatusMsg(`Successfully synced data for ${result.scanned} tickers.`);
      await loadStats();
    } catch (err) {
      if ((err as Error).message.includes('cancelled')) {
        setStatusMsg('Data sync cancelled by user.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setIsSyncing(false);
      setProgress(null);
    }
  };

  const cancelSync = async () => {
    await window.api.screen.syncCancel();
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

  const clearMarketData = async () => {
    const proceed = await window.dialog.confirm({
      title: 'Clear All Market Data',
      message: 'This will delete all downloaded stock quotes, fundamentals, and index lists (S&P 500, etc.). Your settings and API key will NOT be affected. Are you sure?'
    });
    if (!proceed) return;

    try {
      await window.api.cache.refresh(); // This clears all market data tables
      await loadStats();
      setStatusMsg('All market data has been cleared.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
              className={`univ-btn ${universe === u ? 'active' : ''}`}
              onClick={() => setUniverse(u)}
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
              {progress && progress.total > 0 && (
                <span>{Math.round((progress.scanned / progress.total) * 100)}%</span>
              )}
            </div>
            {progress && progress.total > 0 && (
              <>
                <progress value={progress.scanned} max={progress.total} style={{ width: '100%', height: '10px' }}></progress>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '5px', fontSize: '0.9em', color: 'var(--text-muted)' }}>
                  <span>{progress.scanned} / {progress.total} tickers processed</span>
                  <span>Fetching: <strong>{progress.ticker}</strong></span>
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
        <h3>Local Database Stats</h3>
        <ul style={{ listStyleType: 'none', padding: 0, lineHeight: '1.6' }}>
          <li><strong>Cached Records:</strong> {stats?.recordCount ?? 0}</li>
          <li><strong>Last Sync Completed:</strong> {stats?.lastScreenerRun ? new Date(stats.lastScreenerRun).toLocaleString() : 'Never'}</li>
        </ul>
      </div>
    </div>
  );
}
