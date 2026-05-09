import { useCallback, useEffect, useState, useRef } from 'react';
import type { Watchlist, WatchlistItem, CachedQuote } from '@shared/types.js';
import { ScreenerView } from './views/ScreenerView.js';
import { AnalysisView } from './views/AnalysisView.js';
import { ValidateView } from './views/ValidateView.js';
import { SettingsView } from './views/SettingsView.js';
import { PortfolioView } from './views/PortfolioView.js';
import { BriefingView } from './views/BriefingView.js';
import { AlertsView } from './views/AlertsView.js';
import { useCacheStatus } from './hooks/useCacheStatus.js';
import { CacheStatusIndicator } from './components/CacheStatusIndicator.js';
import { useSortable } from './hooks/useSortable.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { RealtimePriceTicker } from './components/RealtimePriceTicker.js';

import { DataView } from './views/DataView.js';

declare const __APP_VERSION__: string;

type View = 'watchlists' | 'screener' | 'analysis' | 'validate' | 'portfolio' | 'briefing' | 'settings' | 'alerts' | 'data';

export function App() {
  const [view, setView] = useState<View>('watchlists');
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [tickerInput, setTickerInput] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [quoteMap, setQuoteMap] = useState<Record<string, CachedQuote | null>>({});
  const [lastRefresh, setLastRefresh] = useState<string>('');
  const [isRefreshingCache, setIsRefreshingCache] = useState(false);
  
  // Audio context for alerts
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Cache status for auto-refresh indicator
  const { status: cacheStatus, refresh: refreshCacheStatus } = useCacheStatus();

  // WebSocket for real-time prices
  const { isConnected: wsConnected, priceUpdates, subscribe, unsubscribe } = useWebSocket();

  // Listen for real-time alerts
  useEffect(() => {
    const removeAlertListener = window.api.websocket.onAlert((data) => {
      setAlertMsg(`ALERT: ${data.message}`);
      
      if (data.playSound) {
        // Play a simple beep using Web Audio API
        if (!audioCtxRef.current) {
          audioCtxRef.current = new window.AudioContext();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
        
        gainNode.gain.setValueAtTime(0, ctx.currentTime);
        gainNode.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
      }
    });

    return () => {
      removeAlertListener();
    };
  }, []);

  // Sortable columns for watchlist table
  const tableData = items.map(item => ({
    ...item,
    lastPrice: quoteMap[item.ticker]?.last ?? null,
    dayChangePct: quoteMap[item.ticker]?.last && quoteMap[item.ticker]?.prevClose
      ? ((quoteMap[item.ticker]!.last! - quoteMap[item.ticker]!.prevClose!) / quoteMap[item.ticker]!.prevClose!) * 100
      : null,
    volume: quoteMap[item.ticker]?.volume ?? null,
    wheelSuitability: quoteMap[item.ticker]?.wheelSuitability ?? null,
    targetStrike: quoteMap[item.ticker]?.targetStrike ?? null,
    estimatedPremium: quoteMap[item.ticker]?.estimatedPremium ?? null
  }));

  const { sortedData, sortConfig, requestSort, getSortIndicator } = useSortable(tableData, 'ticker', 'asc');

  const refreshLists = useCallback(async () => {
    try {
      const lists = await window.api.watchlists.list();
      setWatchlists(lists);
      if (activeId === null && lists.length > 0) {
        setActiveId(lists[0]!.id);
      }
    } catch (err) {
      console.error('[App] refreshLists caught error:', err);
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred while fetching watchlists.';
      setError(errorMessage);
      // Re-throw to be caught by the useEffect catch block if needed, or handle here.
      throw err;
    }
  }, [activeId]);

  const refreshItems = useCallback(async (id: number) => {
    const list = await window.api.watchlists.items.list(id);
    setItems(list);
    setSelected(new Set());
  }, []);

  // Refresh all quotes for the current watchlist.
  const refreshQuotes = useCallback(async (_watchlistId: number) => {
    const tickers = items.map((i) => i.ticker);
    if (tickers.length === 0) return;
    try {
      const quotes = await window.api.quotes.refreshBulk(tickers);
      const map: Record<string, CachedQuote | null> = {};
      for (const q of quotes) {
        map[q.ticker] = q;
      }
      setQuoteMap(map);
      setLastRefresh(new Date().toLocaleTimeString());
    } catch {
      // Silently fail — quotes are a nice-to-have on the watchlist table.
    }
  }, [items]);

  useEffect(() => {
    console.log('[App] useEffect: refreshLists');
    refreshLists().catch((e) => {
      console.error('[App] refreshLists error:', e);
      setError((e as Error).message);
    });
  }, [refreshLists]);

  useEffect(() => {
    if (activeId === null) return;
    refreshItems(activeId).catch((e) => setError((e as Error).message));
  }, [activeId, refreshItems]);

  // Auto-refresh quotes every 60 seconds (FR-1.7).
  useEffect(() => {
    if (activeId === null) return;
    const interval = setInterval(() => refreshQuotes(activeId), 60_000);
    return () => clearInterval(interval);
  }, [activeId, refreshQuotes]);

  // Subscribe to WebSocket for real-time prices when watchlist changes
  useEffect(() => {
    if (activeId === null) return;

    // Subscribe to all tickers in the current watchlist
    items.forEach(item => {
      subscribe(item.ticker);
    });

    return () => {
      // Unsubscribe when watchlist changes
      items.forEach(item => {
        unsubscribe(item.ticker);
      });
    };
  }, [activeId, items, subscribe, unsubscribe]);

  // Apply theme setting
  useEffect(() => {
    const applyTheme = async () => {
      try {
        const settings = await window.api.settings.getAll();
        if (settings.theme) {
          document.documentElement.setAttribute('data-theme', settings.theme);
        }
      } catch {
        // Theme is optional, ignore errors
      }
    };
    applyTheme();

    // Listen for theme changes from settings
    const handleStorage = () => {
      applyTheme();
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const onCreate = async () => {
    const name = await window.dialog.prompt({ title: 'New watchlist name' });
    if (!name) return;
    try {
      const wl = await window.api.watchlists.create(name);
      await refreshLists();
      setActiveId(wl.id);
      setStatusMsg(`Created "${wl.name}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onRename = async () => {
    if (!activeId) return;
    const current = watchlists.find((w) => w.id === activeId);
    if (!current) return;
    const next = await window.dialog.prompt({ title: 'Rename watchlist', defaultValue: current.name });
    if (!next || next === current.name) return;
    try {
      await window.api.watchlists.rename(activeId, next);
      await refreshLists();
      setStatusMsg(`Renamed to "${next}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onDelete = async () => {
    if (!activeId) return;
    const current = watchlists.find((w) => w.id === activeId);
    if (!current) return;
    const confirmed = await window.dialog.confirm({
      title: 'Delete watchlist',
      message: `Delete watchlist "${current.name}"? This cannot be undone.`
    });
    if (!confirmed) return;
    try {
      await window.api.watchlists.delete(activeId);
      setActiveId(null);
      await refreshLists();
      setStatusMsg(`Deleted "${current.name}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onAddTicker = async () => {
    if (!activeId) return;
    const t = tickerInput.trim();
    if (!t) return;
    try {
      await window.api.watchlists.items.add(activeId, t, null);
      setTickerInput('');
      await refreshItems(activeId);
      await refreshLists();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onRemoveSelected = async () => {
    if (!activeId || selected.size === 0) return;
    try {
      const removed = await window.api.watchlists.items.remove(activeId, Array.from(selected));
      await refreshItems(activeId);
      await refreshLists();
      setStatusMsg(`Removed ${removed} item(s)`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onExport = async () => {
    if (!activeId) return;
    try {
      const result = await window.api.watchlists.csv.export(activeId);
      if (result) setStatusMsg(`Exported ${result.rowCount} rows → ${result.filePath}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onImportIntoActive = async () => {
    if (!activeId) return;
    try {
      const result = await window.api.watchlists.csv.import({ watchlistId: activeId });
      await refreshItems(activeId);
      await refreshLists();
      const skipMsg =
        result.skipped.length > 0
          ? `, ${result.skipped.length} skipped (${result.skipped
              .slice(0, 3)
              .map((s) => s.ticker || `row ${s.row}`)
              .join(', ')}${result.skipped.length > 3 ? '…' : ''})`
          : '';
      setStatusMsg(`Imported ${result.imported}${skipMsg}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onImportNew = async () => {
    const name = await window.dialog.prompt({ title: 'Import into a new watchlist named:' });
    if (!name) return;
    try {
      const result = await window.api.watchlists.csv.import({ createWithName: name });
      await refreshLists();
      setActiveId(result.watchlistId);
      const skipMsg =
        result.skipped.length > 0
          ? `, ${result.skipped.length} skipped`
          : '';
      setStatusMsg(`Imported ${result.imported} into "${name}"${skipMsg}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const active = watchlists.find((w) => w.id === activeId) ?? null;

  const fmtPrice = (ticker: string): string => {
    // Use WebSocket price if available, fallback to quote cache
    const wsPrice = priceUpdates[ticker]?.price;
    const q = quoteMap[ticker];
    const price = wsPrice ?? q?.last;
    if (price === null || price === undefined) return '—';
    return `$${price.toFixed(2)}`;
  };

  const fmtDayPct = (ticker: string): string => {
    const q = quoteMap[ticker];
    if (!q || q.last === null || q.prevClose === null || q.prevClose === 0) return '—';
    const pct = ((q.last - q.prevClose) / q.prevClose) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  };

  const dayPctClass = (ticker: string): string => {
    const q = quoteMap[ticker];
    if (!q || q.last === null || q.prevClose === null) return '';
    const pct = ((q.last - q.prevClose) / q.prevClose) * 100;
    return pct >= 0 ? 'up' : 'down';
  };

  // Wheel column formatters
  const fmtWheelScore = (ticker: string): string => {
    const q = quoteMap[ticker];
    if (!q || q.wheelSuitability === null || q.wheelSuitability === undefined) return '—';
    return `${q.wheelSuitability}`;
  };

  const fmtTargetStrike = (ticker: string): string => {
    const q = quoteMap[ticker];
    if (!q || q.targetStrike === null || q.targetStrike === undefined) return '—';
    return `$${q.targetStrike.toFixed(2)}`;
  };

  const fmtEstPremium = (ticker: string): string => {
    const q = quoteMap[ticker];
    if (!q || q.estimatedPremium === null || q.estimatedPremium === undefined) return '—';
    return `$${q.estimatedPremium.toFixed(2)}`;
  };

  const wheelScoreClass = (ticker: string): string => {
    const q = quoteMap[ticker];
    if (!q || q.wheelSuitability === null || q.wheelSuitability === undefined) return '';
    const score = q.wheelSuitability;
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    return 'poor';
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="nav-section">
          <button
            className={`nav-btn ${view === 'watchlists' ? 'active' : ''}`}
            onClick={() => setView('watchlists')}
          >
            📋 Watchlists
          </button>
          <button
            className={`nav-btn ${view === 'screener' ? 'active' : ''}`}
            onClick={() => setView('screener')}
          >
            🔍 Screener
          </button>
          <button
            className={`nav-btn ${view === 'analysis' ? 'active' : ''}`}
            onClick={() => setView('analysis')}
          >
            📊 Analysis
          </button>
          <button
            className={`nav-btn ${view === 'validate' ? 'active' : ''}`}
            onClick={() => setView('validate')}
          >
            🎯 Validate
          </button>
          <button
            className={`nav-btn ${view === 'portfolio' ? 'active' : ''}`}
            onClick={() => setView('portfolio')}
          >
            💼 Portfolio
          </button>
          <button
            className={`nav-btn ${view === 'briefing' ? 'active' : ''}`}
            onClick={() => setView('briefing')}
          >
            📰 Briefing
          </button>
          <button
            className={`nav-btn ${view === 'alerts' ? 'active' : ''}`}
            onClick={() => setView('alerts')}
          >
            🔔 Alerts
          </button>
          <button
            className={`nav-btn ${view === 'data' ? 'active' : ''}`}
            onClick={() => setView('data')}
          >
            🗄️ Data Sync
          </button>
          <button
            className={`nav-btn ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            ⚙ Settings
          </button>
        </div>

        {view === 'watchlists' && (
          <>
            <ul className="watchlist-list">
              {watchlists.map((w) => (
                <li
                  key={w.id}
                  className={`${w.id === activeId ? 'active' : ''} ${w.isDefault ? 'is-default' : ''}`}
                  onClick={() => setActiveId(w.id)}
                >
                  <span>{w.name}</span>
                  <span className="count">{w.itemCount}</span>
                </li>
              ))}
            </ul>
            <div className="sidebar-actions">
              <button onClick={onCreate}>+ New</button>
              <button onClick={onImportNew}>Import…</button>
            </div>
          </>
        )}
      </aside>

      <section className="main">
        {error && (
          <div className="error-toast" onClick={() => setError(null)}>
            {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
          </div>
        )}
        {alertMsg && (
          <div className="alert-toast" style={{ backgroundColor: '#e74c3c', color: 'white', padding: '10px', marginBottom: '10px', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => setAlertMsg(null)}>
            {alertMsg} <span style={{ float: 'right', cursor: 'pointer', fontWeight: 'bold' }}>✕</span>
          </div>
        )}

        {view === 'screener' && <ScreenerView />}
        {view === 'analysis' && <AnalysisView />}
        {view === 'validate' && <ValidateView />}
        {view === 'portfolio' && <PortfolioView />}
        {view === 'briefing' && <BriefingView />}
        {view === 'alerts' && <AlertsView />}
        {view === 'data' && <DataView />}
        {view === 'settings' && <SettingsView />}

        {view === 'watchlists' && !active ? (
          <div className="empty">No watchlist selected.</div>
        ) : view === 'watchlists' ? (
          <>
            <div className="toolbar">
              <h1>{active?.name}</h1>
              <span className="meta">
                {active?.itemCount} ticker{active?.itemCount === 1 ? '' : 's'}
              </span>
              <button onClick={onRename}>Rename</button>
              <button onClick={onExport} disabled={(active?.itemCount ?? 0) === 0}>
                Export CSV
              </button>
              <button onClick={onImportIntoActive}>Import CSV</button>
              <button onClick={onDelete} disabled={active?.isDefault ?? false} className="danger">
                Delete
              </button>
              <div style={{ flex: 1 }} />
              <CacheStatusIndicator
                status={cacheStatus}
                isLoading={isRefreshingCache}
                onRefresh={async () => {
                  try {
                    setIsRefreshingCache(true);
                    await window.api.cache.refresh();
                    await refreshCacheStatus();
                    if (activeId !== null) await refreshQuotes(activeId);
                  } catch (err) {
                    console.error('Failed to refresh cache:', err);
                  } finally {
                    setIsRefreshingCache(false);
                  }
                }}
              />
              <button
                onClick={() => activeId !== null && refreshQuotes(activeId)}
                className="refresh-btn"
                title="Refresh quotes"
              >
                ↻ Refresh quotes
              </button>
            </div>
            <div className="add-row">
              <input
                type="text"
                placeholder="Add ticker (e.g. AAPL)"
                value={tickerInput}
                onChange={(e) => setTickerInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onAddTicker()}
                style={{ width: 220 }}
              />
              <button onClick={onAddTicker} disabled={!tickerInput.trim()}>
                Add
              </button>
              <span style={{ flex: 1 }} />
              <button
                onClick={onRemoveSelected}
                disabled={selected.size === 0}
                className="danger"
              >
                Remove {selected.size > 0 ? `(${selected.size})` : 'selected'}
              </button>
            </div>
            <div className="items">
              {items.length === 0 ? (
                <div className="empty">Empty watchlist. Add a ticker above or import a CSV.</div>
              ) : (
                <table className="items-table">
                  <thead>
                    <tr>
                      <th style={{ width: 24 }}></th>
                      <th className="sortable-header" onClick={() => requestSort('ticker')}>Ticker {getSortIndicator('ticker')}</th>
                      <th className="sortable-header" onClick={() => requestSort('lastPrice')}>Last {getSortIndicator('lastPrice')}</th>
                      <th className="sortable-header" onClick={() => requestSort('dayChangePct')}>Day % {getSortIndicator('dayChangePct')}</th>
                      <th className="sortable-header" onClick={() => requestSort('volume')}>Volume {getSortIndicator('volume')}</th>
                      <th className="sortable-header" onClick={() => requestSort('wheelSuitability')} title="Wheel Suitability Score">Wheel {getSortIndicator('wheelSuitability')}</th>
                      <th className="sortable-header" onClick={() => requestSort('targetStrike')} title="Target Put Strike">Strike {getSortIndicator('targetStrike')}</th>
                      <th className="sortable-header" onClick={() => requestSort('estimatedPremium')} title="Estimated Monthly Premium">Premium {getSortIndicator('estimatedPremium')}</th>
                      <th>Sector</th>
                      <th className="sortable-header" onClick={() => requestSort('notes')}>Notes {getSortIndicator('notes')}</th>
                      <th className="sortable-header" onClick={() => requestSort('addedAt')}>Added {getSortIndicator('addedAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedData.map((it) => (
                      <tr key={it.id} className={selected.has(it.id) ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(it.id)}
                            onChange={() => toggleSelected(it.id)}
                          />
                        </td>
                        <td><strong>{it.ticker}</strong></td>
                        <td className="num">{fmtPrice(it.ticker)}</td>
                        <td className={`num ${dayPctClass(it.ticker)}`}>
                          {fmtDayPct(it.ticker)}
                        </td>
                        <td className="num">
                          {it.volume != null
                            ? (it.volume / 1_000_000).toFixed(1) + 'M'
                            : '—'}
                        </td>
                        <td className={`num wheel-score ${wheelScoreClass(it.ticker)}`}>
                          {fmtWheelScore(it.ticker)}
                        </td>
                        <td className="num">{fmtTargetStrike(it.ticker)}</td>
                        <td className="num">{fmtEstPremium(it.ticker)}</td>
                        <td className="placeholder" title="Coming in Phase 3">—</td>
                        <td>{it.notes ?? ''}</td>
                        <td>{it.addedAt.slice(0, 10)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : null}
      </section>

      <footer className="statusbar">
        <span>v{typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0'}</span>
        <span style={{ flex: 1 }} />
        {lastRefresh && <span className="meta">Quotes: {lastRefresh}</span>}
        <span>{statusMsg ?? 'Ready'}</span>
      </footer>
    </div>
  );
}
