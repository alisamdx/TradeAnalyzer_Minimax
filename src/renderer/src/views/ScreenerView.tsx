// ScreenerView — FR-2: Search Trading Opportunities.
// Universe selector, filter panel, run button, results table, presets.
// see SPEC: FR-2

import { useCallback, useEffect, useState } from 'react';
import type {
  ScreenPreset,
  ScreenCriteria,
  ScreenRunResult,
  ScreenResultRow,
  Universe,
  ConstituentsMeta
} from '@shared/types.js';
import { DEFAULT_FILTER_SPECS } from '@shared/screener-filters.js';

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

  // Load presets + runs + meta on mount.
  useEffect(() => {
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
  }, []);

  // Load results when a run is selected.
  useEffect(() => {
    if (activeRunId === null) { setResults([]); return; }
    window.api.screen.getResults(activeRunId).then(setResults).catch(() => {});
  }, [activeRunId]);

  // ── Preset management ──────────────────────────────────────────────────

  const loadPreset = useCallback((preset: ScreenPreset) => {
    setCriteria(preset.criteria);
    setUniverse(preset.criteria.universe);
    setMode(preset.criteria.mode);
    setActivePresetId(preset.id);
    setActiveRunId(null);
    setResults([]);
    setStatusMsg(`Loaded preset "${preset.name}"`);
  }, []);

  const saveAsPreset = useCallback(async () => {
    const name = window.prompt('Preset name:');
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

  // ── Filter helpers ───────────────────────────────────────────────────────

  const updateFilter = useCallback((id: string, patch: Partial<FilterState>) => {
    setCriteria((prev) => ({
      ...prev,
      filters: prev.filters.map((f) => f.id === id ? { ...f, ...patch } : f)
    }));
    setActivePresetId(null); // Unsaved from preset.
  }, []);

  const resetFilters = useCallback(() => {
    setCriteria(defaultCriteria(universe));
    setActivePresetId(null);
  }, [universe]);

  // ── Run screen ─────────────────────────────────────────────────────────

  const runScreen = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setActiveRunId(null);
    setResults([]);
    try {
      const run = await window.api.screen.run({ ...criteria, universe });
      setActiveRunId(run.id);
      setRuns((prev) => [run, ...prev]);
      const res = await window.api.screen.getResults(run.id);
      setResults(res);
      const universeName = universe === 'both' ? 'Both' : universe.toUpperCase();
      setStatusMsg(`${universeName}: ${run.resultCount} passed`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsRunning(false);
    }
  }, [criteria, universe]);

  // ── Save as watchlist ──────────────────────────────────────────────────

  const saveAsWatchlist = useCallback(async () => {
    if (selected.size === 0) return;
    const name = window.prompt('Watchlist name:');
    if (!name) return;
    if (!activeRunId) return;
    try {
      await window.api.screen.saveAsWatchlist(activeRunId, Array.from(selected), name);
      setStatusMsg(`Saved ${selected.size} tickers as "${name}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected, activeRunId]);

  // ── Constituents refresh ────────────────────────────────────────────────

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

  // ── Helpers ────────────────────────────────────────────────────────────

  const fmt = (v: number | null, prefix = '', suffix = ''): string => {
    if (v === null) return '—';
    return `${prefix}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
  };

  const fmtPct = (v: number | null): string => v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  const totalEnabled = criteria.filters.filter((f) => f.enabled).length;

  const metaFor = (idx: 'sp500' | 'russell1000'): string => {
    const m = constituentsMeta[idx];
    if (!m) return 'not loaded';
    const d = new Date(m.refreshedAt).toLocaleDateString();
    return `${idx.toUpperCase()} · refreshed ${d} · source: ${m.source}`;
  };

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
        <h2>Index Screener</h2>
        <span className="meta">{metaFor('sp500')}</span>
        <span className="meta">{metaFor('russell1000')}</span>
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
            <div className="refresh-btns">
              <button onClick={() => refreshConstituents('sp500')} className="tiny-btn">↻ S&P 500</button>
              <button onClick={() => refreshConstituents('russell1000')} className="tiny-btn">↻ Russell 1000</button>
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
            <h3>Filters <span className="badge">{totalEnabled} enabled</span></h3>
            <button onClick={resetFilters} className="tiny-btn" style={{ marginBottom: 8 }}>Reset to defaults</button>
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

          {/* Run */}
          <div className="control-section">
            <button
              onClick={runScreen}
              disabled={isRunning}
              className="run-btn"
            >
              {isRunning ? 'Running…' : '▶ Run Screen'}
            </button>
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
                <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
                <div style={{ flex: 1 }} />
                <button
                  onClick={() => setSelected(new Set(results.map((r) => r.id)))}
                  className="tiny-btn"
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
                      <th>Ticker</th>
                      <th>Company</th>
                      <th>Sector</th>
                      <th>Last</th>
                      <th>Day %</th>
                      <th title="P/E Ratio">P/E</th>
                      <th title="EPS (TTM)">EPS</th>
                      <th title="Market Cap">Mkt Cap</th>
                      <th title="Revenue Growth YoY">Rev Gr%</th>
                      <th title="EPS Growth YoY">EPS Gr%</th>
                      <th title="Debt / Equity">D/E</th>
                      <th title="Return on Equity">ROE%</th>
                      <th title="Profit Margin">Margin%</th>
                      <th title="Free Cash Flow">FCF</th>
                      <th title="Current Ratio">Curr%</th>
                      <th>Vol</th>
                      <th title="Beta">β</th>
                      {mode === 'soft' && <th title="Pass score">Pass</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
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
                        <td className="num">{fmt(r.payload.lastPrice, '$')}</td>
                        <td className={`num ${(r.payload.dayChangePct ?? 0) >= 0 ? 'up' : 'down'}`}>
                          {fmtPct(r.payload.dayChangePct)}
                        </td>
                        <td className="num">{fmt(r.payload.peRatio)}</td>
                        <td className="num">{fmt(r.payload.eps, '$')}</td>
                        <td className="num">{fmt(r.payload.marketCap, '$')}</td>
                        <td className="num">{fmt(r.payload.revenueGrowth, '', '%')}</td>
                        <td className="num">{fmt(r.payload.epsGrowth, '', '%')}</td>
                        <td className="num">{fmt(r.payload.debtToEquity)}</td>
                        <td className="num">{fmt(r.payload.roe, '', '%')}</td>
                        <td className="num">{fmt(r.payload.profitMargin, '', '%')}</td>
                        <td className="num">{fmt(r.payload.freeCashFlow, '$')}</td>
                        <td className="num">{fmt(r.payload.currentRatio)}</td>
                        <td className="num">{fmt(r.payload.avgVolume)}</td>
                        <td className="num">{fmt(r.payload.beta)}</td>
                        {mode === 'soft' && (
                          <td className="num pass-score">
                            <span className="pass-badge">{r.payload.passScore} / {totalEnabled}</span>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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