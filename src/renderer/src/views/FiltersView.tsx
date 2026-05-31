// FiltersView — pre-built filter templates that scan watchlist or universe tickers.
// User selects a template, picks a source (universe or watchlist), and sees matching results.

import { useCallback, useEffect, useState } from 'react';
import type { FilterTemplateResult, Watchlist, Universe } from '@shared/types.js';
import { FILTER_TEMPLATES } from '@shared/filter-templates.js';
import { useSortable } from '../hooks/useSortable.js';

// ─── Category metadata ────────────────────────────────────────────────────────

const CATEGORY_ORDER: Array<{ key: string; label: string }> = [
  { key: 'technical', label: 'Technical' },
  { key: 'volatility', label: 'Volatility' },
  { key: 'options', label: 'Options' },
  { key: 'wheel', label: 'Wheel' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, prefix = '', suffix = ''): string {
  if (v === null || v === undefined) return '—';
  return `${prefix}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FiltersView() {
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  const [results, setResults] = useState<FilterTemplateResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [filterProgress, setFilterProgress] = useState<{ current: number; total: number; ticker: string } | null>(null);

  // Source: universe vs watchlist — similar to LEAPS+CSP view
  const [source, setSource] = useState<'universe' | 'watchlist'>('watchlist');
  const [universe, setUniverse] = useState<Universe>('sp500');

  // Load watchlists on mount
  useEffect(() => {
    window.api.watchlists.list()
      .then(lists => {
        setWatchlists(lists);
        if (lists.length > 0) setSelectedWatchlistId(lists[0]!.id);
      })
      .catch(() => {});
  }, []);

  // Listen for filter progress events
  useEffect(() => {
    const unsub = window.api.filters.onProgress(p => setFilterProgress(p));
    return () => { unsub(); };
  }, []);

  // Sortable results
  const { sortedData, sortConfig, requestSort, getSortIndicator } = useSortable(
    results,
    'ticker',
    'asc'
  );

  const runTemplate = useCallback(async (templateId: string) => {
    setActiveTemplate(templateId);
    setIsRunning(true);
    setError(null);
    setResults([]);
    setFilterProgress(null);
    try {
      const watchlistIds = source === 'watchlist' && selectedWatchlistId !== null
        ? [selectedWatchlistId]
        : source === 'watchlist'
          ? undefined  // all watchlists
          : undefined;

      const res = await window.api.filters.runTemplate(
        templateId,
        source,
        source === 'universe' ? universe : undefined,
        watchlistIds
      );
      setResults(res);
      const template = FILTER_TEMPLATES.find(t => t.id === templateId);
      setStatusMsg(`${template?.label ?? templateId}: ${res.length} match${res.length !== 1 ? 'es' : ''}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsRunning(false);
      setFilterProgress(null);
    }
  }, [source, universe, selectedWatchlistId]);

  const activeTpl = activeTemplate ? FILTER_TEMPLATES.find(t => t.id === activeTemplate) : null;

  // Build dynamic columns from the active template's metricColumns
  const metricKeys = activeTpl ? Object.keys(activeTpl.metricColumns) : [];

  // Quick actions
  const runAnalysisForTicker = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker } }));
  };

  const runValidateForTicker = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
  };

  const runOptionsForTicker = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker } }));
  };

  const openInPayoff = (r: FilterTemplateResult) => {
    // Compute a target ~30 DTE expiry; PayoffView will snap to the nearest real expiry.
    const thirtyDTE = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    let strategy: string | undefined;
    let expiry: string | undefined;
    let strike: number | undefined;

    if (activeTemplate === 'iv_rank_high') {
      // High IV → sell CSP ATM (nearest available strike to current price)
      strategy = 'csp';
      expiry   = thirtyDTE;
      strike   = r.lastPrice ?? undefined;
    } else if (activeTemplate === 'wheel_opportunity') {
      // Wheel → sell CSP at the pre-computed target strike
      strategy = 'csp';
      expiry   = thirtyDTE;
      strike   = (r.metrics['targetStrike'] as number | null) ?? r.lastPrice ?? undefined;
    }

    window.dispatchEvent(new CustomEvent('navigate-to-payoff', {
      detail: { ticker: r.ticker, spot: r.lastPrice ?? undefined, expiry, strategy, strike }
    }));
  };

  return (
    <div className="filters-view" style={{ display: 'flex', height: '100%' }}>
      {/* ── Left: Template Cards ── */}
      <aside className="filters-sidebar" style={{ width: 280, minWidth: 280, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '12px' }}>
        <h2 style={{ margin: '0 0 12px' }}>Filters</h2>

        {/* Source toggle: Universe vs Watchlist */}
        <div style={{ marginBottom: '12px' }}>
          <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 8 }}>
            <button
              style={{
                flex: 1, borderRadius: 0, fontSize: 12, padding: '4px 12px', cursor: isRunning ? 'not-allowed' : 'pointer',
                background: source === 'universe' ? 'var(--accent)' : 'transparent',
                color: source === 'universe' ? '#000' : 'var(--text-muted)',
                fontWeight: source === 'universe' ? 700 : 400,
                border: 'none', borderRight: '1px solid var(--border)',
              }}
              onClick={() => setSource('universe')}
              disabled={isRunning}
            >
              Universe
            </button>
            <button
              style={{
                flex: 1, borderRadius: 0, fontSize: 12, padding: '4px 12px', cursor: isRunning ? 'not-allowed' : 'pointer',
                background: source === 'watchlist' ? 'var(--accent)' : 'transparent',
                color: source === 'watchlist' ? '#000' : 'var(--text-muted)',
                fontWeight: source === 'watchlist' ? 700 : 400,
                border: 'none',
              }}
              onClick={() => setSource('watchlist')}
              disabled={isRunning}
            >
              Watchlist
            </button>
          </div>

          {/* Source-specific selector */}
          {source === 'universe' ? (
            <select
              value={universe}
              onChange={e => setUniverse(e.target.value as Universe)}
              style={{ width: '100%', fontSize: 12, padding: '4px 8px' }}
              disabled={isRunning}
            >
              <option value="sp500">S&P 500</option>
              <option value="russell1000">Russell 1000</option>
              <option value="both">Both</option>
            </select>
          ) : (
            <select
              value={selectedWatchlistId ?? ''}
              onChange={e => setSelectedWatchlistId(Number(e.target.value) || null)}
              style={{ width: '100%', fontSize: 12, padding: '4px 8px' }}
              disabled={isRunning}
            >
              <option value="">All watchlists</option>
              {watchlists.map(wl => (
                <option key={wl.id} value={wl.id}>{wl.name} ({wl.itemCount})</option>
              ))}
            </select>
          )}
        </div>

        {/* Template cards grouped by category */}
        {CATEGORY_ORDER.map(cat => {
          const templates = FILTER_TEMPLATES.filter(t => t.category === cat.key);
          if (templates.length === 0) return null;
          return (
            <div key={cat.key} style={{ marginBottom: '12px' }}>
              <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                {cat.label}
              </h3>
              {templates.map(t => (
                <button
                  key={t.id}
                  onClick={() => runTemplate(t.id)}
                  disabled={isRunning}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    marginBottom: 4,
                    borderRadius: 6,
                    border: activeTemplate === t.id ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: activeTemplate === t.id ? 'var(--surface)' : 'transparent',
                    cursor: isRunning ? 'wait' : 'pointer',
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 16 }}>{t.icon}</span>
                    <strong>{t.label}</strong>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t.description}
                  </div>
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      {/* ── Right: Results ── */}
      <main style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {/* Error / status */}
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

        {/* Running indicator with progress bar */}
        {isRunning && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                {filterProgress
                  ? `Scanning ${filterProgress.ticker} (${filterProgress.current} / ${filterProgress.total})`
                  : 'Starting…'}
              </span>
              {filterProgress && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {Math.round((filterProgress.current / filterProgress.total) * 100)}%
                </span>
              )}
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                borderRadius: 2,
                background: 'var(--accent)',
                width: filterProgress
                  ? `${Math.round((filterProgress.current / filterProgress.total) * 100)}%`
                  : '0%',
                transition: 'width 0.15s ease',
              }} />
            </div>
          </div>
        )}

        {/* No template selected */}
        {!activeTemplate && !isRunning && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
            <h3 style={{ margin: '0 0 8px' }}>Select a filter template</h3>
            <p style={{ fontSize: 13, margin: 0 }}>Pick a pre-built criteria from the sidebar to scan your tickers.</p>
          </div>
        )}

        {/* Results table */}
        {activeTemplate && !isRunning && results.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>
                {activeTpl?.icon} {activeTpl?.label}
              </h3>
              <span className="meta" style={{ marginLeft: 8 }}>
                {results.length} match{results.length !== 1 ? 'es' : ''}
              </span>
              {source === 'universe' && (
                <span className="meta" style={{ marginLeft: 8 }}>
                  from {universe === 'sp500' ? 'S&P 500' : universe === 'russell1000' ? 'Russell 1000' : 'S&P 500 + Russell 1000'}
                </span>
              )}
              {sortConfig && (
                <span className="meta" style={{ marginLeft: 8 }}>
                  Sorted by {sortConfig.key} {sortConfig.direction === 'asc' ? '↑' : '↓'}
                </span>
              )}
            </div>
            <div className="results-table-wrap">
              <table className="results-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => requestSort('ticker')}>Ticker {getSortIndicator('ticker')}</th>
                    <th className="sortable num" onClick={() => requestSort('lastPrice')}>Last {getSortIndicator('lastPrice')}</th>
                    <th>Source</th>
                    {metricKeys.map(key => (
                      <th key={key} className="sortable num" onClick={() => requestSort(key)}>
                        {activeTpl!.metricColumns[key]} {getSortIndicator(key)}
                      </th>
                    ))}
                    <th>Match Reason</th>
                    <th style={{ width: 90 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedData.map((r) => (
                    <tr key={r.ticker}>
                      <td><strong>{r.ticker}</strong></td>
                      <td className="num">{fmt(r.lastPrice, '$')}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.watchlists.join(', ')}</td>
                      {metricKeys.map(key => (
                        <td key={key} className="num">
                          {formatMetricValue(key, r.metrics[key])}
                        </td>
                      ))}
                      <td style={{ fontSize: 12, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.matchReason}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button
                            className="action-btn"
                            title="Run analysis"
                            onClick={() => runAnalysisForTicker(r.ticker)}
                          >
                            📊
                          </button>
                          <button
                            className="action-btn"
                            title="Validate"
                            onClick={() => runValidateForTicker(r.ticker)}
                          >
                            ✔
                          </button>
                          <button
                            className="action-btn"
                            title="Options chain"
                            onClick={() => runOptionsForTicker(r.ticker)}
                          >
                            ⛓
                          </button>
                          <button
                            className="action-btn"
                            title="Open in Payoff Visualizer"
                            onClick={() => openInPayoff(r)}
                          >
                            📐
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Template selected but no matches */}
        {activeTemplate && !isRunning && results.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <h3 style={{ margin: '0 0 8px' }}>No matches found</h3>
            <p style={{ fontSize: 13, margin: 0 }}>
              No {source === 'universe' ? 'universe' : 'watchlist'} tickers currently meet the {activeTpl?.label ?? ''} criteria.
              Try a different template, source, or check that you have recent data.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Metric formatting ────────────────────────────────────────────────────────

function formatMetricValue(key: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (key === 'ivRank') return `${value}`;               // IV Rank is 0–100, not a %
  const percentKeys = ['currentIv', 'priceVsSma50', 'priceVsSma200'];
  if (percentKeys.includes(key)) return `${value}%`;
  const dollarKeys = ['targetStrike'];
  if (dollarKeys.includes(key)) return `$${value}`;
  if (key === 'suitabilityScore') return `${value}/100`;
  if (key === 'delta') return `${(value).toFixed(2)}`;
  if (key === 'daysToEarnings') return `${value}d`;
  if (key === 'rsi') return `${value}`;
  if (key === 'strike') return `$${value}`;
  if (key === 'dte') return `${value}`;
  return `${value}`;
}