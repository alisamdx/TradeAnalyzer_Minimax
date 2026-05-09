// ScreenerView — FR-2: Search Trading Opportunities.
// Universe selector, filter panel, run button, results table, presets.
// Priority 5: Sortable columns, quick actions, CSV export, pagination, cache status.
// see SPEC: FR-2

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type {
  ScreenPreset,
  ScreenCriteria,
  ScreenRunResult,
  ScreenResultRow,
  Universe,
  ConstituentsMeta,
  CacheStatus
} from '@shared/types.js';
import { DEFAULT_FILTER_SPECS } from '@shared/screener-filters.js';
import { useSortable } from '../hooks/useSortable.js';
import { CacheStatusIndicator } from '../components/CacheStatusIndicator.js';
import { showPromptDialog } from '../utils/promptDialog.js';

// `window.api` is declared once in `src/renderer/src/global.d.ts`.

// ─── Filter panel state ───────────────────────────────────────────────────────

interface FilterState {
  id: string;
  enabled: boolean;
  value: Record<string, unknown>;
}

function defaultCriteria(universe: Universe): ScreenCriteria {
  return {
    universe,
    mode: 'strict',
    filters: DEFAULT_FILTER_SPECS.map((spec) => ({
      id: spec.id,
      enabled: spec.defaultEnabled,
      value: { min: spec.defaultMin, max: spec.defaultMax, enabled: spec.defaultEnabled }
    }))
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

const ITEMS_PER_PAGE = 50;

function fmt(v: number | null, prefix = '', suffix = ''): string {
  if (v === null) return '—';
  return `${prefix}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function formatLargeNumber(value: number | null): string {
  if (value === null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toLocaleString();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ScreenerView() {
  const [presets, setPresets] = useState<ScreenPreset[]>([]);
  const [activePresetId, setActivePresetId] = useState<number | null>(null);
  const [criteria, setCriteria] = useState<ScreenCriteria>(() => defaultCriteria('sp500'));
  const [universe, setUniverse] = useState<Universe>('sp500');
  const [mode, setMode] = useState<'strict' | 'soft'>('strict');
  const [runs, setRuns] = useState<ScreenRunResult[]>([]);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [results, setResults] = useState<ScreenResultRow[]>([]);
  const [constituentsMeta, setConstituentsMeta] = useState<Record<'sp500' | 'russell1000', ConstituentsMeta | null>>({ sp500: null, russell1000: null });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [watchlists, setWatchlists] = useState<{ id: number; name: string }[]>([]);
  const [showAddToWatchlist, setShowAddToWatchlist] = useState<number | null>(null);
  const isRunningRef = useRef(false);

  // Load presets + runs + meta + cache status + default universe on mount.
  useEffect(() => {
    // Load default screener index from settings
    window.api.settings.getAll()
      .then((settings) => {
        const defaultUniverse = settings.defaultScreenerIndex || 'sp500';
        setUniverse(defaultUniverse);
        setCriteria(defaultCriteria(defaultUniverse));
      })
      .catch(() => {
        // Fallback to sp500
        setUniverse('sp500');
        setCriteria(defaultCriteria('sp500'));
      });

    window.api.screen.listPresets()
      .then(setPresets)
      .catch((e) => setError((e as Error).message));

    window.api.screen.getRuns()
      .then(setRuns)
      .catch(() => {});

    for (const idx of ['sp500', 'russell1000'] as const) {
      window.api.screen.getMeta(idx).then((m) => {
        setConstituentsMeta((prev) => ({ ...prev, [idx]: m }));
      }).catch(() => {});
    }

    // Load cache status
    window.api.cache.getStatus()
      .then(setCacheStatus)
      .catch(() => {});

    // Load watchlists for quick actions
    window.api.watchlists.list()
      .then(lists => setWatchlists(lists.map(w => ({ id: w.id, name: w.name }))))
      .catch(() => {});

    // Poll cache status every 5 minutes
    const interval = setInterval(() => {
      window.api.cache.getStatus()
        .then(setCacheStatus)
        .catch(() => {});
    }, 300000);

    return () => clearInterval(interval);
  }, []);

  // Check for stale cache and auto-refresh
  useEffect(() => {
    if (cacheStatus?.isStale && activeRunId) {
      setStatusMsg('Cache is stale. Consider refreshing data.');
    }
  }, [cacheStatus, activeRunId]);

  // Load results when a run is selected.
  useEffect(() => {
    if (activeRunId === null) { setResults([]); setCurrentPage(1); return; }
    window.api.screen.getResults(activeRunId).then((res) => {
      setResults(res);
      setCurrentPage(1);
      setSelected(new Set());
    }).catch(() => {});
  }, [activeRunId]);

  // ── Sorting ───────────────────────────────────────────────────────────────

  // Transform results for sorting (flatten payload)
  const sortableResults = useMemo(() => {
    return results.map(r => ({
      ...r,
      // Flatten payload fields for sorting
      lastPrice: r.payload.lastPrice,
      dayChangePct: r.payload.dayChangePct,
      peRatio: r.payload.peRatio,
      eps: r.payload.eps,
      marketCap: r.payload.marketCap,
      revenueGrowth: r.payload.revenueGrowth,
      epsGrowth: r.payload.epsGrowth,
      debtToEquity: r.payload.debtToEquity,
      roe: r.payload.roe,
      profitMargin: r.payload.profitMargin,
      freeCashFlow: r.payload.freeCashFlow,
      currentRatio: r.payload.currentRatio,
      avgVolume: r.payload.avgVolume,
      beta: r.payload.beta,
      passScore: r.payload.passScore
    }));
  }, [results]);

  const { sortedData, sortConfig, requestSort, getSortIndicator } = useSortable(
    sortableResults,
    'ticker',
    'asc'
  );

  // ── Pagination ────────────────────────────────────────────────────────────

  const totalPages = Math.ceil(sortedData.length / ITEMS_PER_PAGE);
  const paginatedResults = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return sortedData.slice(start, start + ITEMS_PER_PAGE);
  }, [sortedData, currentPage]);

  // ── Preset management ─────────────────────────────────────────────────────

  const loadPreset = useCallback((preset: ScreenPreset) => {
    setCriteria(preset.criteria);
    setUniverse(preset.criteria.universe);
    setMode(preset.criteria.mode);
    setActivePresetId(preset.id);
    setActiveRunId(null);
    setResults([]);
    setCurrentPage(1);
    setStatusMsg(`Loaded preset "${preset.name}"`);
  }, []);

  const saveAsPreset = useCallback(async () => {
    const name = await showPromptDialog('Preset name:');
    if (!name) return;
    try {
      const p = await window.api.screen.savePreset({ name, universe, criteria, isDefault: false });
      setPresets((prev) => [...prev, p]);
      setActivePresetId(p.id);
      setStatusMsg(`Saved preset "${name}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [universe, criteria]);

  const deletePreset = useCallback(async (id: number) => {
    try {
      await window.api.screen.deletePreset(id);
      setPresets((prev) => prev.filter((p) => p.id !== id));
      if (activePresetId === id) setActivePresetId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activePresetId]);

  // ── Filter helpers ─────────────────────────────────────────────────────────

  const updateFilter = useCallback((id: string, patch: Partial<FilterState>) => {
    setCriteria((prev) => ({
      ...prev,
      filters: prev.filters.map((f) => f.id === id ? { ...f, ...patch } : f)
    }));
    setActivePresetId(null);
  }, []);

  const resetFilters = useCallback(() => {
    setCriteria(defaultCriteria(universe));
    setActivePresetId(null);
  }, [universe]);

  const clearAllFilters = useCallback(() => {
    setCriteria((prev) => ({
      ...prev,
      filters: prev.filters.map((f) => ({ ...f, enabled: false }))
    }));
    setActivePresetId(null);
  }, []);

  // ── Run screen ────────────────────────────────────────────────────────────

  const runScreen = useCallback(async () => {
    // Prevent concurrent runs
    if (isRunningRef.current) return;

    isRunningRef.current = true;
    setIsRunning(true);
    setError(null);
    setResults([]);
    setCurrentPage(1);
    try {
      const response = await window.api.screen.run({ ...criteria, universe });
      setResults(response.rows);
      setActiveRunId(response.runId);
      const universeName = universe === 'both' ? 'Both' : universe.toUpperCase();
      setStatusMsg(`${universeName}: ${response.resultCount} passed`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsRunning(false);
      isRunningRef.current = false;
    }
  }, [criteria, universe]);

  // Auto-run when criteria or universe changes
  useEffect(() => {
    // Debounce: wait a bit before running to avoid rapid-fire on filter changes
    const timeoutId = setTimeout(() => {
      runScreen();
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [criteria, universe]);

  // ── Quick Actions ─────────────────────────────────────────────────────────

  const addToWatchlist = useCallback(async (ticker: string, watchlistId: number) => {
    try {
      await window.api.watchlists.items.add(watchlistId, ticker, null);
      setStatusMsg(`Added ${ticker} to watchlist`);
      setShowAddToWatchlist(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const runAnalysisForTicker = useCallback(async (ticker: string) => {
    // Navigate to analysis view - user can select a watchlist there
    setStatusMsg(`Opening analysis view...`);
    window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker } }));
  }, []);

  // ── Save as watchlist ─────────────────────────────────────────────────────

  const saveAsWatchlist = useCallback(async () => {
    if (selected.size === 0) return;
    const name = await showPromptDialog('Watchlist name:');
    if (!name) return;
    if (!activeRunId) return;
    try {
      await window.api.screen.saveAsWatchlist(activeRunId, Array.from(selected), name);
      setStatusMsg(`Saved ${selected.size} tickers as "${name}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected, activeRunId]);

  // ── CSV Export ─────────────────────────────────────────────────────────────

  const exportCsv = useCallback(() => {
    if (sortedData.length === 0) return;

    const headers = [
      'Ticker', 'Company', 'Sector', 'Last Price', 'Day Change %', 'P/E',
      'EPS', 'Revenue Growth %', 'EPS Growth %', 'D/E',
      'ROE %', 'Profit Margin %', 'Current Ratio',
      'Avg Volume'
    ];
    if (mode === 'soft') headers.push('Pass Score');

    const rows = sortedData.map(r => [
      r.ticker,
      r.companyName ?? '',
      r.sector ?? '',
      r.payload.lastPrice ?? '',
      r.payload.dayChangePct ?? '',
      r.payload.peRatio ?? '',
      r.payload.eps ?? '',
      r.payload.revenueGrowth ?? '',
      r.payload.epsGrowth ?? '',
      r.payload.debtToEquity ?? '',
      r.payload.roe ?? '',
      r.payload.profitMargin ?? '',
      r.payload.currentRatio ?? '',
      r.payload.avgVolume ?? '',
      mode === 'soft' ? r.payload.passScore : ''
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `screener_results_${universe}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    setStatusMsg(`Exported ${sortedData.length} results to CSV`);
  }, [sortedData, universe, mode]);

  // ── Constituents refresh ──────────────────────────────────────────────────

  const refreshConstituents = useCallback(async (index: 'sp500' | 'russell1000') => {
    setStatusMsg(`Refreshing ${index.toUpperCase()} from Wikipedia…`);
    try {
      const meta = await window.api.screen.refreshConstituents(index);
      setConstituentsMeta((prev) => ({ ...prev, [index]: meta }));
      setStatusMsg(`${index.toUpperCase()} refreshed from Wikipedia`);
    } catch (e) {
      setError(`Failed to refresh constituents: ${(e as Error).message}`);
    }
  }, []);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const totalEnabled = criteria.filters.filter((f) => f.enabled).length;

  const metaFor = (idx: 'sp500' | 'russell1000'): string => {
    const m = constituentsMeta[idx];
    if (!m) return 'not loaded';
    const d = new Date(m.refreshedAt).toLocaleDateString();
    return `${idx.toUpperCase()} · refreshed ${d} · source: ${m.source}`;
  };

  // ── Column definitions for sortable headers ────────────────────────────────

  type ColumnDef = { key: string; label: string; title?: string; sortable: boolean };

  const columns: ColumnDef[] = [
    { key: 'ticker', label: 'Ticker', sortable: true },
    { key: 'companyName', label: 'Company', sortable: true },
    { key: 'sector', label: 'Sector', sortable: true },
    { key: 'lastPrice', label: 'Last', title: 'Last Price', sortable: true },
    { key: 'dayChangePct', label: 'Day %', title: 'Day Change %', sortable: true },
    { key: 'peRatio', label: 'P/E', title: 'P/E Ratio', sortable: true },
    { key: 'eps', label: 'EPS', title: 'EPS (TTM)', sortable: true },
    { key: 'revenueGrowth', label: 'Rev Gr%', title: 'Revenue Growth YoY', sortable: true },
    { key: 'epsGrowth', label: 'EPS Gr%', title: 'EPS Growth YoY', sortable: true },
    { key: 'debtToEquity', label: 'D/E', title: 'Debt / Equity', sortable: true },
    { key: 'roe', label: 'ROE%', title: 'Return on Equity', sortable: true },
    { key: 'profitMargin', label: 'Margin%', title: 'Profit Margin', sortable: true },
    { key: 'currentRatio', label: 'Curr%', title: 'Current Ratio', sortable: true },
    { key: 'avgVolume', label: 'Vol', title: 'Average Volume', sortable: true },
    ...(mode === 'soft' ? [{ key: 'passScore', label: 'Pass', title: 'Pass score', sortable: true }] : [])
  ];

  return (
    <div className="screener-view">
      {/* ── Error / status ── */}
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

      <div className="screener-header">
        <div>
          <h2>Index Screener</h2>
          <span className="meta">{metaFor('sp500')}</span>
          <span className="meta">{metaFor('russell1000')}</span>
        </div>
        <div className="status-indicator">
          <span className="meta">
            {cacheStatus?.lastUpdated 
              ? `Data as of: ${new Date(cacheStatus.lastUpdated).toLocaleString()}` 
              : 'No data. Go to Data Sync.'}
          </span>
        </div>
      </div>

      <div className="screener-layout">
        {/* ── Left: controls ── */}
        <aside className="screener-controls">
          {/* Universe */}
          <div className="control-section">
            <h3>Universe</h3>
            <div className="universe-btns">
              {(['sp500', 'russell1000', 'both'] as Universe[]).map((u) => (
                <button
                  key={u}
                  className={`univ-btn ${universe === u ? 'active' : ''}`}
                  onClick={() => { setUniverse(u); setActivePresetId(null); }}
                >
                  {u === 'sp500' ? 'S&P 500' : u === 'russell1000' ? 'Russell 1000' : 'Both'}
                </button>
              ))}
            </div>
          </div>

          {/* Mode */}
          <div className="control-section">
            <h3>Mode</h3>
            <div className="mode-btns">
              <button className={`mode-btn ${mode === 'strict' ? 'active' : ''}`} onClick={() => { setMode('strict'); setActivePresetId(null); }}>
                Strict
              </button>
              <button className={`mode-btn ${mode === 'soft' ? 'active' : ''}`} onClick={() => { setMode('soft'); setActivePresetId(null); }}>
                Soft (rank)
              </button>
            </div>
            <p className="hint">{mode === 'strict' ? 'Must pass all enabled filters.' : 'Rank by filter-pass count; show top N.'}</p>
          </div>

          {/* Filters */}
          <div className="control-section filters-panel">
            <div className="filters-header">
              <h3>Filters <span className="badge">{totalEnabled} enabled</span></h3>
              <div>
                <button onClick={resetFilters} className="tiny-btn">Reset to defaults</button>
                <button onClick={clearAllFilters} className="tiny-btn" style={{ marginLeft: '8px' }}>Clear all</button>
              </div>
            </div>
            <div className="filters-list">
              {criteria.filters.map((f) => {
                const spec = DEFAULT_FILTER_SPECS.find((s) => s.id === f.id) ?? {
                  label: f.id, format: 'ratio' as const, description: ''
                };
                const v = f.value as Record<string, unknown>;
                const min = v['min'] as number;
                const max = v['max'] as number;
                return (
                  <div key={f.id} className={`filter-row ${!f.enabled ? 'disabled' : ''}`}>
                    <label className="filter-label">
                      <input
                        type="checkbox"
                        checked={f.enabled}
                        onChange={(e) => updateFilter(f.id, { enabled: e.target.checked, value: { ...v, enabled: e.target.checked } })}
                      />
                      {spec.label}
                    </label>
                    {f.enabled && (spec.format === 'percent' || spec.format === 'ratio' || spec.format === 'dollars' || spec.format === 'count') && (
                      <div className="filter-range">
                        <input
                          type="number"
                          value={min === Infinity ? '' : min}
                          onChange={(e) => updateFilter(f.id, { value: { ...v, min: parseFloat(e.target.value) || 0 } })}
                          placeholder="min"
                          style={{ width: 80 }}
                        />
                        {!isFinite(max as number) ? null : <>
                          <span style={{ padding: '0 4px' }}>–</span>
                          <input
                            type="number"
                            value={max}
                            onChange={(e) => updateFilter(f.id, { value: { ...v, max: parseFloat(e.target.value) || Infinity } })}
                            placeholder="max"
                            style={{ width: 80 }}
                          />
                        </>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Presets */}
          <div className="control-section">
            <h3>Presets</h3>
            <button onClick={saveAsPreset} className="tiny-btn">💾 Save current as preset</button>
            <ul className="preset-list">
              {presets.map((p) => (
                <li key={p.id} className={`preset-item ${activePresetId === p.id ? 'active' : ''}`}>
                  <button className="preset-load-btn" onClick={() => loadPreset(p)}>
                    {p.name} {p.isDefault ? '(default)' : ''}
                  </button>
                  {!p.isDefault && (
                    <button className="preset-del-btn" onClick={() => deletePreset(p.id)}>✕</button>
                  )}
                </li>
              ))}
              {presets.length === 0 && <li className="hint">No presets yet.</li>}
            </ul>
          </div>
        </aside>

        {/* ── Right: results ── */}
        <main className="screener-results">
          {/* Run history */}
          {runs.length > 0 && activeRunId === null && (
            <div className="run-history">
              <h3>Recent runs</h3>
              <div className="run-list">
                {runs.slice(0, 10).map((r) => (
                  <button key={r.id} className="run-chip" onClick={() => setActiveRunId(r.id)}>
                    {r.universe.toUpperCase()} · {r.resultCount} passed · {new Date(r.runAt).toLocaleString()}
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 && (
            <>
              <div className="results-toolbar">
                <span>{sortedData.length} result{sortedData.length === 1 ? '' : 's'}</span>
                {sortConfig && (
                  <span className="meta" style={{ marginLeft: 8 }}>
                    Sorted by {columns.find(c => c.key === sortConfig.key)?.label} {sortConfig.direction === 'asc' ? '↑' : '↓'}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={exportCsv} className="tiny-btn" disabled={sortedData.length === 0}>
                  📥 Export CSV
                </button>
                <button
                  onClick={() => setSelected(new Set(results.map((r) => r.id)))}
                  className="tiny-btn"
                  style={{ marginLeft: 8 }}
                >
                  Select all
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="tiny-btn"
                  style={{ marginLeft: 4 }}
                >
                  Deselect
                </button>
                <button
                  onClick={saveAsWatchlist}
                  disabled={selected.size === 0}
                  className="save-wl-btn"
                  style={{ marginLeft: 8 }}
                >
                  Save as Watchlist ({selected.size})
                </button>
              </div>

              <div className="results-table-wrap">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th style={{ width: 24 }}></th>
                      {columns.map((col) => (
                        <th
                          key={col.key}
                          title={col.title}
                          className={col.sortable ? 'sortable' : ''}
                          onClick={col.sortable ? () => requestSort(col.key) : undefined}
                        >
                          {col.label}
                          {col.sortable && getSortIndicator(col.key) && (
                            <span className="sort-indicator">{getSortIndicator(col.key)}</span>
                          )}
                        </th>
                      ))}
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedResults.map((r) => (
                      <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() =>
                              setSelected((prev) => {
                                const n = new Set(prev);
                                if (n.has(r.id)) n.delete(r.id); else n.add(r.id);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td><strong>{r.ticker}</strong></td>
                        <td>{r.companyName ?? '—'}</td>
                        <td>{r.sector ?? '—'}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { lastPrice: number | null }).lastPrice, '$')}</td>
                        <td className={`num ${((r as unknown as ScreenResultRow & { dayChangePct: number | null }).dayChangePct ?? 0) >= 0 ? 'up' : 'down'}`}>
                          {fmtPct((r as unknown as ScreenResultRow & { dayChangePct: number | null }).dayChangePct)}
                        </td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { peRatio: number | null }).peRatio)}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { eps: number | null }).eps, '$')}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { revenueGrowth: number | null }).revenueGrowth, '', '%')}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { epsGrowth: number | null }).epsGrowth, '', '%')}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { debtToEquity: number | null }).debtToEquity)}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { roe: number | null }).roe, '', '%')}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { profitMargin: number | null }).profitMargin, '', '%')}</td>
                        <td className="num">{fmt((r as unknown as ScreenResultRow & { currentRatio: number | null }).currentRatio)}</td>
                        <td className="num">{formatLargeNumber((r as unknown as ScreenResultRow & { avgVolume: number | null }).avgVolume)}</td>
                        {mode === 'soft' && (
                          <td className="num pass-score">
                            <span className="pass-badge">{(r as unknown as ScreenResultRow & { passScore: number }).passScore} / {totalEnabled}</span>
                          </td>
                        )}
                        <td className="actions">
                          <div className="quick-actions">
                            <button
                              className="action-btn"
                              title="Add to watchlist"
                              onClick={() => setShowAddToWatchlist(r.id)}
                            >
                              ⭐
                            </button>
                            <button
                              className="action-btn"
                              title="Run analysis"
                              onClick={() => runAnalysisForTicker(r.ticker)}
                            >
                              📊
                            </button>
                          </div>
                          {showAddToWatchlist === r.id && (
                            <div className="watchlist-dropdown">
                              {watchlists.map(wl => (
                                <button
                                  key={wl.id}
                                  className="dropdown-item"
                                  onClick={() => addToWatchlist(r.ticker, wl.id)}
                                >
                                  {wl.name}
                                </button>
                              ))}
                              <button
                                className="dropdown-item cancel"
                                onClick={() => setShowAddToWatchlist(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="page-btn"
                  >
                    ← Prev
                  </button>
                  <span className="page-info">
                    Page {currentPage} of {totalPages} ({sortedData.length} results)
                  </span>
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className="page-btn"
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}

          {!isRunning && results.length === 0 && activeRunId === null && (
            <div className="empty-state">
              <p>Configure filters and click <strong>Run Screen</strong> to scan the selected universe.</p>
              <p className="hint">S&P 500: ~500 names · Russell 1000: ~1,000 names · Both: deduplicated union.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
