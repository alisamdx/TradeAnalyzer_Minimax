import { useCallback, useEffect, useState } from 'react';
import type { Watchlist, WatchlistItem, CachedQuote } from '@shared/types.js';
import { ScreenerView } from './views/ScreenerView.js';
import { AnalysisView } from './views/AnalysisView.js';
import { ValidateView } from './views/ValidateView.js';
import { SettingsView } from './views/SettingsView.js';

declare const __APP_VERSION__: string;

type View = 'watchlists' | 'screener' | 'analysis' | 'validate' | 'settings';

export function App() {
  const [view, setView] = useState<View>('watchlists');
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [tickerInput, setTickerInput] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [quoteMap, setQuoteMap] = useState<Record<string, CachedQuote | null>>({});
  const [lastRefresh, setLastRefresh] = useState<string>('');

  const refreshLists = useCallback(async () => {
    const lists = await window.api.watchlists.list();
    setWatchlists(lists);
    if (activeId === null && lists.length > 0) {
      setActiveId(lists[0]!.id);
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
    refreshLists().catch((e) => setError((e as Error).message));
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

  const onCreate = async () => {
    const name = window.prompt('New watchlist name');
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
    const next = window.prompt('Rename watchlist', current.name);
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
    if (!window.confirm(`Delete watchlist "${current.name}"? This cannot be undone.`)) return;
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
    const name = window.prompt('Import into a new watchlist named:');
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
    const q = quoteMap[ticker];
    if (!q || q.last === null) return '—';
    return `$${q.last.toFixed(2)}`;
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

        {view === 'screener' && <ScreenerView />}
        {view === 'analysis' && <AnalysisView />}
        {view === 'validate' && <ValidateView />}
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
                      <th>Ticker</th>
                      <th>Last</th>
                      <th>Day %</th>
                      <th>Volume</th>
                      <th>Sector</th>
                      <th>Notes</th>
                      <th>Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
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
                          {quoteMap[it.ticker]?.volume != null
                            ? (quoteMap[it.ticker]!.volume! / 1_000_000).toFixed(1) + 'M'
                            : '—'}
                        </td>
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
