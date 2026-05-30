import { useCallback, useEffect, useState, useRef } from 'react';
import type { Watchlist, WatchlistItem, CachedQuote, Universe } from '@shared/types.js';
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

import { PromptDialog } from './components/PromptDialog.js';
import { showPromptDialog } from './utils/promptDialog.js';

import { DataView } from './views/DataView.js';
import { OptionsChainView } from './views/OptionsChainView.js';
import { AgentView } from './views/AgentView.js';
import { BacktestView } from './views/BacktestView.js';
import { LeapsCspView } from './views/LeapsCspView.js';
import { CollaredLeapsView } from './views/CollaredLeapsView.js';
import { FiltersView } from './views/FiltersView.js';
import { TestApiView } from './views/TestApiView.js';
import { PayoffView } from './views/PayoffView.js';
import { IvHistoryView } from './views/IvHistoryView.js';

declare const __APP_VERSION__: string;

type View = 'watchlists' | 'screener' | 'filters' | 'analysis' | 'validate' | 'portfolio' | 'briefing' | 'settings' | 'alerts' | 'data' | 'optionsChain' | 'payoff' | 'agent' | 'backtest' | 'leapsCsp' | 'collaredLeaps' | 'testApi' | 'ivHistory';

type NavEntry = {
  id: number;
  view: View;
  analysisTicker?: string | null;
  validateTicker?: string | null;
  optionsChainTicker?: string | null;
  optionsChainExpiry?: string | null;
  payoffTicker?: string | null;
  payoffSpot?: number | null;
};

export function App() {
  const [navStack, setNavStack] = useState<NavEntry[]>([{ id: 0, view: 'watchlists' }]);
  const navIdRef = useRef(1);
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

  // Prompt dialog state
  const [promptDialogOpen, setPromptDialogOpen] = useState(false);
  const [promptTitle, setPromptTitle] = useState('');
  const [promptDefaultValue, setPromptDefaultValue] = useState('');
  const promptResolveRef = useRef<((value: string | null) => void) | null>(null);

  // Cache status for auto-refresh indicator
  const { status: cacheStatus, refresh: refreshCacheStatus } = useCacheStatus();

  // E*Trade connection warning forwarded to SettingsView
  const [etradeWarning, setEtradeWarning] = useState<string | null>(null);

  // Data sync state — lifted here so it survives tab navigation
  const [syncUniverseSelection, setSyncUniverseSelection] = useState<Universe>('sp500');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<{ scanned: number; total: number; ticker?: string } | null>(null);

  // Derived navigation state
  const currentEntry = navStack[navStack.length - 1]!;
  const currentView = currentEntry.view;
  const canGoBack = navStack.length > 1;

  const navigateSidebar = useCallback((v: View) => {
    setNavStack([{ id: navIdRef.current++, view: v }]);
  }, []);

  const navigateBack = useCallback(() => {
    setNavStack(prev => prev.length > 1 ? prev.slice(0, -1) : prev);
  }, []);

  // On mount: if E*Trade is the options provider, verify the token is still valid.
  // If not, redirect to Settings so the user can reconnect before anything breaks.
  useEffect(() => {
    (async () => {
      try {
        const provider = await window.api.settings.getOptionsProvider();
        if (provider !== 'etrade') return;

        const result = await window.api.etrade.checkConnection();
        if (result.status === 'ok') return; // all good, normal startup

        let warning: string;
        if (result.status === 'expired') {
          warning = 'E*Trade token expired (tokens reset at midnight ET). Please reconnect.';
        } else if (result.status === 'no_token') {
          warning = 'E*Trade is selected as the options provider but you have not connected yet. Click "Connect" below to authenticate.';
        } else {
          // 'no_credentials'
          warning = 'E*Trade is selected as the options provider but no credentials are saved. Enter your Consumer Key and Secret, then click "Connect".';
        }

        setEtradeWarning(warning);
        setNavStack([{ id: navIdRef.current++, view: 'settings' }]);
      } catch {
        // If the check itself fails, let the app start normally — don't block on this
      }
    })();
  }, []);

  useEffect(() => {
    const unsub = window.api.screen.onSyncProgress((data) => {
      setSyncProgress(data);
    });
    return () => { unsub(); };
  }, []);

  const handleStartSync = useCallback(async (universe: Universe): Promise<{ scanned: number }> => {
    setSyncUniverseSelection(universe);
    setIsSyncing(true);
    setSyncProgress(null);
    try {
      const result = await window.api.screen.syncUniverse(universe);
      return result;
    } finally {
      setIsSyncing(false);
      setSyncProgress(null);
    }
  }, []);

  const handleCancelSync = useCallback(async () => {
    await window.api.screen.syncCancel();
  }, []);

  useEffect(() => {
    // Listen for "Run Analysis" from screener
    const handleNavigateToAnalysis = (e: CustomEvent<{ ticker: string }>) => {
      setNavStack(prev => [...prev, { id: navIdRef.current++, view: 'analysis', analysisTicker: e.detail.ticker }]);
    };
    window.addEventListener('navigate-to-analysis', handleNavigateToAnalysis as EventListener);

    // Listen for "Validate" from analysis
    const handleNavigateToValidate = (e: CustomEvent<{ ticker: string }>) => {
      setNavStack(prev => [...prev, { id: navIdRef.current++, view: 'validate', validateTicker: e.detail.ticker }]);
    };
    window.addEventListener('navigate-to-validate', handleNavigateToValidate as EventListener);

    // Listen for "Options Chain" from other views
    const handleNavigateToOptions = (e: CustomEvent<{ ticker: string; expiry?: string }>) => {
      setNavStack(prev => [...prev, { id: navIdRef.current++, view: 'optionsChain', optionsChainTicker: e.detail.ticker, optionsChainExpiry: e.detail.expiry ?? null }]);
    };
    window.addEventListener('navigate-to-options', handleNavigateToOptions as EventListener);

    // Listen for "Payoff Visualizer" from other views
    const handleNavigateToPayoff = (e: CustomEvent<{ ticker?: string; spot?: number }>) => {
      setNavStack(prev => [...prev, { id: navIdRef.current++, view: 'payoff', payoffTicker: e.detail.ticker ?? null, payoffSpot: e.detail.spot ?? null }]);
    };
    window.addEventListener('navigate-to-payoff', handleNavigateToPayoff as EventListener);

    // Listen for E*Trade auth errors from any view → redirect to Settings
    const handleEtradeAuthError = (e: CustomEvent<{ warning: string }>) => {
      setEtradeWarning(e.detail.warning);
      setNavStack([{ id: navIdRef.current++, view: 'settings' }]);
    };
    window.addEventListener('navigate-to-settings-etrade', handleEtradeAuthError as EventListener);

    // Listen for watchlist created from screener
    const handleWatchlistCreated = () => {
      refreshLists();
    };
    window.addEventListener('watchlist-created', handleWatchlistCreated as EventListener);

    // Listen for prompt dialog requests
    const handleShowPrompt = (e: CustomEvent<{ title: string; defaultValue?: string; resolveId: string }>) => {
      setPromptTitle(e.detail.title);
      setPromptDefaultValue(e.detail.defaultValue ?? '');
      setPromptDialogOpen(true);
      // Store resolveId to use when sending result
      (window as unknown as Record<string, unknown>).__promptResolveId = e.detail.resolveId;
    };
    window.addEventListener('show-prompt-dialog', handleShowPrompt as EventListener);

    return () => {
      window.removeEventListener('navigate-to-analysis', handleNavigateToAnalysis as EventListener);
      window.removeEventListener('navigate-to-validate', handleNavigateToValidate as EventListener);
      window.removeEventListener('navigate-to-options', handleNavigateToOptions as EventListener);
      window.removeEventListener('navigate-to-payoff', handleNavigateToPayoff as EventListener);
      window.removeEventListener('navigate-to-settings-etrade', handleEtradeAuthError as EventListener);
      window.removeEventListener('watchlist-created', handleWatchlistCreated as EventListener);
      window.removeEventListener('show-prompt-dialog', handleShowPrompt as EventListener);
    };
  }, []);

  // Prompt dialog handlers
  const handlePromptConfirm = (value: string) => {
    const resolveId = (window as unknown as Record<string, unknown>).__promptResolveId as string;
    window.dispatchEvent(new CustomEvent('prompt-dialog-result', { detail: { value: value || null, resolveId } }));
    setPromptDialogOpen(false);
  };

  const handlePromptCancel = () => {
    const resolveId = (window as unknown as Record<string, unknown>).__promptResolveId as string;
    window.dispatchEvent(new CustomEvent('prompt-dialog-result', { detail: { value: null, resolveId } }));
    setPromptDialogOpen(false);
  };

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
    estimatedPremium: quoteMap[item.ticker]?.estimatedPremium ?? null,
    currentIv: quoteMap[item.ticker]?.currentIv ?? item.currentIv
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
    // Guard against stale responses - only update if we're still on this watchlist
    if (activeId !== id) {
      return; // Skip update - user has already switched to another watchlist
    }
    const list = await window.api.watchlists.items.list(id);
    // Double-check after the async call
    if (activeId !== id) {
      return; // User switched during the API call
    }
    setItems(list);
    setSelected(new Set());
  }, [activeId]);

  // Refresh all quotes for the current watchlist.
  const refreshQuotes = useCallback(async (tickers: string[]) => {
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
  }, []);

  useEffect(() => {
    console.log('[App] useEffect: refreshLists');
    refreshLists().catch((e) => {
      console.error('[App] refreshLists error:', e);
      setError((e as Error).message);
    });
  }, [refreshLists]);

  // Load items when watchlist changes
  useEffect(() => {
    if (activeId === null) return;
    refreshItems(activeId).catch((e) => setError((e as Error).message));
  }, [activeId, refreshItems]);

  // When watchlist items change, trigger initial quote refresh
  useEffect(() => {
    if (activeId === null || items.length === 0) return;
    // Use a small timeout to avoid race conditions with React's batching
    const timer = setTimeout(() => {
      const tickers = items.map((i) => i.ticker);
      refreshQuotes(tickers).catch((e) => console.error('[App] initial quote refresh error:', e));
    }, 100);
    return () => clearTimeout(timer);
  }, [items]); // Only depend on items, not activeId

  // Auto-refresh quotes every 60 seconds (FR-1.7).
  useEffect(() => {
    if (activeId === null || items.length === 0) return;
    const interval = setInterval(() => {
      const tickers = items.map((i) => i.ticker);
      refreshQuotes(tickers).catch((e) => console.error('[App] interval quote refresh error:', e));
    }, 60_000);
    return () => clearInterval(interval);
  }, [activeId, refreshQuotes]); // Removed items.length from deps to avoid unnecessary resets

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
    const name = await showPromptDialog('New watchlist name');
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
    const next = await showPromptDialog('Rename watchlist', current.name);
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

  const runValidateForTicker = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
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
    const name = await showPromptDialog('Import into a new watchlist named:');
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
    if (q?.last === null || q?.last === undefined) return '—';
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

  // Renders the content for a single nav stack entry.
  // Hidden entries remain mounted (display:none) so their state is preserved.
  const renderEntry = (entry: NavEntry) => {
    switch (entry.view) {
      case 'screener': return <ScreenerView />;
      case 'filters': return <FiltersView />;
      case 'analysis': return <AnalysisView initialTicker={entry.analysisTicker ?? null} clearInitialTicker={() => {}} />;
      case 'validate': return <ValidateView initialTicker={entry.validateTicker ?? null} clearInitialTicker={() => {}} />;
      case 'portfolio': return <PortfolioView />;
      case 'briefing': return <BriefingView />;
      case 'alerts': return <AlertsView />;
      case 'data': return (
        <DataView
          isSyncing={isSyncing}
          syncProgress={syncProgress}
          syncUniverseSelection={syncUniverseSelection}
          onSyncUniverseChange={setSyncUniverseSelection}
          onStartSync={handleStartSync}
          onCancelSync={handleCancelSync}
        />
      );
      case 'optionsChain': return (
        <OptionsChainView
          initialTicker={entry.optionsChainTicker ?? null}
          initialExpiry={entry.optionsChainExpiry ?? null}
          clearInitialTicker={() => {}}
        />
      );
      case 'payoff': return (
        <PayoffView
          initialTicker={entry.payoffTicker ?? null}
          initialSpot={entry.payoffSpot ?? null}
        />
      );
      case 'agent': return <AgentView />;
      case 'backtest': return <BacktestView />;
      case 'leapsCsp': return <LeapsCspView />;
      case 'collaredLeaps': return <CollaredLeapsView />;
      case 'testApi': return <TestApiView />;
      case 'ivHistory': return <IvHistoryView />;
      case 'settings': return (
        <SettingsView
          etradeWarning={etradeWarning}
          onEtradeWarningDismiss={() => setEtradeWarning(null)}
        />
      );
      case 'watchlists': return !active ? (
        <div className="empty">No watchlist selected.</div>
      ) : (
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
                  if (activeId !== null && items.length > 0) await refreshQuotes(items.map(i => i.ticker));
                } catch (err) {
                  console.error('Failed to refresh cache:', err);
                } finally {
                  setIsRefreshingCache(false);
                }
              }}
            />
            <button
              onClick={() => activeId !== null && items.length > 0 && refreshQuotes(items.map(i => i.ticker))}
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
                    <th className="sortable-header num" title="ATM Implied Volatility">IV %</th>
                    <th className="sortable-header" onClick={() => requestSort('notes')}>Notes {getSortIndicator('notes')}</th>
                    <th className="sortable-header" onClick={() => requestSort('addedAt')}>Added {getSortIndicator('addedAt')}</th>
                    <th style={{ width: 50 }}></th>
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
                      <td>{it.sector ?? ''}</td>
                      <td className="num">
                        {(() => {
                          const iv = quoteMap[it.ticker]?.currentIv ?? it.currentIv;
                          return iv !== null && iv !== undefined ? (
                            <span
                              style={{
                                color: iv >= 30 ? '#2ecc71' : iv >= 20 ? '#f39c12' : '#95a5a6'
                              }}
                              title={iv >= 30 ? 'Good premium' : iv >= 20 ? 'Moderate premium' : 'Low premium'}
                            >
                              {iv.toFixed(1)}%
                            </span>
                          ) : '—';
                        })()}
                      </td>
                      <td>{it.notes ?? ''}</td>
                      <td>{it.addedAt.slice(0, 10)}</td>
                      <td>
                        <button
                          className="action-btn"
                          title="Validate this ticker"
                          onClick={() => runValidateForTicker(it.ticker)}
                        >
                          🎯
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      );
      default: return null;
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="nav-section">
          {canGoBack && (
            <button className="nav-btn back-nav-btn" onClick={navigateBack}>
              ← Back
            </button>
          )}
          <button
            className={`nav-btn ${currentView === 'briefing' ? 'active' : ''}`}
            onClick={() => navigateSidebar('briefing')}
          >
            📰 Briefing
          </button>
          <button
            className={`nav-btn ${currentView === 'screener' ? 'active' : ''}`}
            onClick={() => navigateSidebar('screener')}
          >
            🔍 Screener
          </button>
          <button
            className={`nav-btn ${currentView === 'filters' ? 'active' : ''}`}
            onClick={() => navigateSidebar('filters')}
          >
            🎛️ Filters
          </button>
          <button
            className={`nav-btn ${currentView === 'analysis' ? 'active' : ''}`}
            onClick={() => navigateSidebar('analysis')}
          >
            📊 Analysis
          </button>
          <button
            className={`nav-btn ${currentView === 'validate' ? 'active' : ''}`}
            onClick={() => navigateSidebar('validate')}
          >
            🎯 Validate
          </button>
          <button
            className={`nav-btn ${currentView === 'optionsChain' ? 'active' : ''}`}
            onClick={() => navigateSidebar('optionsChain')}
          >
            📉 Options
          </button>
          <button
            className={`nav-btn ${currentView === 'payoff' ? 'active' : ''}`}
            onClick={() => navigateSidebar('payoff')}
          >
            📐 Payoff
          </button>
          <button
            className={`nav-btn ${currentView === 'leapsCsp' ? 'active' : ''}`}
            onClick={() => navigateSidebar('leapsCsp')}
          >
            ⚡ LEAPS+CSP
          </button>
          <button
            className={`nav-btn ${currentView === 'collaredLeaps' ? 'active' : ''}`}
            onClick={() => navigateSidebar('collaredLeaps')}
          >
            🛡️ Collared LEAPS
          </button>
          <button
            className={`nav-btn ${currentView === 'testApi' ? 'active' : ''}`}
            onClick={() => navigateSidebar('testApi')}
          >
            🔬 Test API
          </button>
          <div className="nav-divider" />
          <button
            className={`nav-btn ${currentView === 'ivHistory' ? 'active' : ''}`}
            onClick={() => navigateSidebar('ivHistory')}
          >
            📊 IV History
          </button>
          <button
            className={`nav-btn ${currentView === 'data' ? 'active' : ''}`}
            onClick={() => navigateSidebar('data')}
          >
            🗄️ Data Sync
          </button>
          <button
            className={`nav-btn ${currentView === 'alerts' ? 'active' : ''}`}
            onClick={() => navigateSidebar('alerts')}
          >
            🔔 Alerts
          </button>
          <button
            className={`nav-btn ${currentView === 'settings' ? 'active' : ''}`}
            onClick={() => navigateSidebar('settings')}
          >
            ⚙ Settings
          </button>
          <div className="nav-divider" />
          <button
            className={`nav-btn ${currentView === 'portfolio' ? 'active' : ''}`}
            onClick={() => navigateSidebar('portfolio')}
          >
            💼 Portfolio
          </button>
          <button
            className={`nav-btn ${currentView === 'agent' ? 'active' : ''}`}
            onClick={() => navigateSidebar('agent')}
          >
            🤖 Agent
          </button>
          <button
            className={`nav-btn ${currentView === 'backtest' ? 'active' : ''}`}
            onClick={() => navigateSidebar('backtest')}
          >
            🔁 Backtest
          </button>
          <button
            className={`nav-btn ${currentView === 'watchlists' ? 'active' : ''}`}
            onClick={() => navigateSidebar('watchlists')}
          >
            📋 Watchlists
          </button>
        </div>

        {currentView === 'watchlists' && (
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

        {navStack.map((entry, idx) => {
          const isActive = idx === navStack.length - 1;
          // Active entry: display:contents makes the wrapper invisible to CSS layout,
          // so children participate in section.main exactly as before.
          // Hidden entries: display:none hides them from layout while keeping them mounted.
          return (
            <div key={entry.id} style={{ display: isActive ? 'contents' : 'none' }}>
              {renderEntry(entry)}
            </div>
          );
        })}
      </section>

      <footer className="statusbar">
        <span>v{typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0'}</span>
        <span style={{ flex: 1 }} />
        {lastRefresh && <span className="meta">Quotes: {lastRefresh}</span>}
        <span>{statusMsg ?? 'Ready'}</span>
      </footer>

      <PromptDialog
        isOpen={promptDialogOpen}
        title={promptTitle}
        defaultValue={promptDefaultValue}
        onConfirm={handlePromptConfirm}
        onCancel={handlePromptCancel}
      />
    </div>
  );
}
