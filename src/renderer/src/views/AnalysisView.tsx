// AnalysisView — FR-3: Multi-mode Analysis Engine.
// Watchlist selector, mode cards, run with progress, results table, save-as-watchlist.
// see SPEC: FR-3

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Watchlist,
  AnalysisModeInfo,
  AnalysisRunResult,
  AnalysisSnapshotRow,
  AnalysisMode
} from '@shared/types.js';
import { HistoricalFinancialChart } from '../components/HistoricalFinancialChart.js';
import { HistoricalPriceChart } from '../components/HistoricalPriceChart.js';
import { showPromptDialog } from '../utils/promptDialog.js';

// `window.api` is declared once in `src/renderer/src/global.d.ts`.

interface AnalysisViewProps {
  initialTicker?: string | null;
  clearInitialTicker?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtNum(v: number | null, decimals = 2): string {
  if (v === null) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

// Analysis result union — decoded from JSON.
type DecodedResult =
  | { mode: 'buy'; ticker: string; lastPrice: number | null; compositeScore: number; trend: string; rsi: number | null; entryZoneLow: number | null; stopLoss: number | null; targetPrice: number | null; riskReward: number | null; fundamentalsPass: boolean; explanation: string }
  | { mode: 'options_income'; ticker: string; lastPrice: number | null; strategy: 'CSP' | 'CC'; strike: number | null; expiration: string | null; dte: number | null; delta: number | null; premium: number | null; annualizedReturn: number | null; ivRank: number | null; breakeven: number | null; capitalRequired: number | null; explanation: string }
  | { mode: 'wheel'; ticker: string; lastPrice: number | null; recommendedStrike: number | null; expiration: string | null; dte: number | null; delta: number | null; premium: number | null; annualizedReturn: number | null; ivRank: number | null; daysToEarnings: number | null; optionLiquidityScore: number; suitabilityScore: number; explanation: string }
  | { mode: 'bullish' | 'bearish'; ticker: string; lastPrice: number | null; trendStrength: number | null; suggestedStrategy: string; structure: string; maxProfit: number | null; maxLoss: number | null; breakeven: number | null; probabilityOfProfit: number | null; explanation: string };

// ─── Component ────────────────────────────────────────────────────────────────

export function AnalysisView({ initialTicker, clearInitialTicker }: AnalysisViewProps) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [tickerCount, setTickerCount] = useState(0);
  const [modes, setModes] = useState<AnalysisModeInfo[]>([]);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; ticker: string } | null>(null);
  const [runResult, setRunResult] = useState<AnalysisRunResult | null>(null);
  const [results, setResults] = useState<DecodedResult[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [snapshots, setSnapshots] = useState<AnalysisSnapshotRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Selected ticker for chart view
  const [selectedTickerForChart, setSelectedTickerForChart] = useState<string | null>(null);
  const [showCharts, setShowCharts] = useState(false);

  // Flag for single-ticker analysis from screener
  const [singleTickerMode, setSingleTickerMode] = useState<string | null>(null);

  // Ref for charts section scroll
  const chartsSectionRef = useRef<HTMLDivElement>(null);

  // Load modes and watchlists on mount.
  useEffect(() => {
    window.api.analysis.listModes()
      .then(setModes)
      .catch((e) => setError((e as Error).message));
    window.api.watchlists.list()
      .then((lists) => setWatchlists(lists))
      .catch((e) => setError((e as Error).message));
  }, []);

  // Handle initial ticker from screener - auto-select mode and run analysis
  useEffect(() => {
    if (initialTicker && watchlists.length > 0 && modes.length > 0) {
      // Set single ticker mode
      setSingleTickerMode(initialTicker);
      // Select the first watchlist (we'll only analyze the one ticker)
      setSelectedWatchlistId(watchlists[0]!.id);
      // Select default mode (buy)
      setSelectedMode('buy');
      // Clear the initial ticker flag so we don't re-trigger
      if (clearInitialTicker) clearInitialTicker();
    }
  }, [initialTicker, watchlists, modes, clearInitialTicker]);

  // Load ticker count + snapshots when watchlist changes.
  useEffect(() => {
    if (!selectedWatchlistId) { setTickerCount(0); setSnapshots([]); return; }
    window.api.watchlists.items.list(selectedWatchlistId)
      .then((items) => setTickerCount(items.length))
      .catch(() => setTickerCount(0));
    window.api.analysis.getSnapshots(selectedWatchlistId)
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, [selectedWatchlistId]);

  // ── Run analysis ──────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async () => {
    if (!selectedWatchlistId || !selectedMode) return;
    setIsRunning(true);
    setError(null);
    setRunResult(null);
    setResults([]);
    setSelected(new Set());

    // Use single ticker mode if set, otherwise use all tickers in watchlist
    const tickersToAnalyze = singleTickerMode ? [singleTickerMode] : undefined;
    const totalCount = singleTickerMode ? 1 : tickerCount;
    setProgress({ current: 0, total: totalCount, ticker: singleTickerMode ?? '…' });

    try {
      const result = await window.api.analysis.run(selectedWatchlistId, selectedMode, tickersToAnalyze);
      setRunResult(result);
      setResults(JSON.parse(result.resultsJson) as DecodedResult[]);
      setStatusMsg(singleTickerMode
        ? `Analysis complete for ${singleTickerMode}`
        : `Analysis complete — ${result.resultCount} results`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsRunning(false);
      setProgress(null);
      setSingleTickerMode(null); // Reset single ticker mode after run
    }
  }, [selectedWatchlistId, selectedMode, tickerCount, singleTickerMode]);

  const cancelAnalysis = useCallback(async () => {
    try {
      await window.api.analysis.cancel();
      setIsRunning(false);
      setProgress(null);
      setStatusMsg('Analysis cancelled.');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // ── Open snapshot ─────────────────────────────────────────────────────────

  const openSnapshot = useCallback(async (snapshot: AnalysisSnapshotRow) => {
    try {
      const full = await window.api.analysis.getSnapshot(snapshot.id);
      if (!full) { setError('Snapshot not found.'); return; }
      setRunResult({
        snapshotId: snapshot.id,
        mode: full.mode as AnalysisMode,
        resultCount: full.resultCount,
        runAt: full.runAt,
        resultsJson: JSON.stringify(full.results),
        failedTickers: []
      });
      setResults(full.results as DecodedResult[]);
      setSelectedMode(full.mode);
      setStatusMsg(`Opened snapshot from ${new Date(full.runAt).toLocaleString()}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // ── Save as watchlist ────────────────────────────────────────────────────

  const saveAsWatchlist = useCallback(async () => {
    if (selected.size === 0 || !runResult) return;
    const name = await showPromptDialog('Watchlist name:');
    if (!name) return;
    try {
      await window.api.analysis.saveAsWatchlist(runResult.snapshotId, Array.from(selected), name);
      setStatusMsg(`Saved ${selected.size} tickers as "${name}"`);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected, runResult]);

  // ── Export CSV ─────────────────────────────────────────────────────────────

  const exportCsv = useCallback(() => {
    if (results.length === 0) return;
    const header = modeColumns(selectedMode ?? 'buy').join(',');
    const rows = results.map((r) => {
      if (r.mode === 'buy') return `${r.ticker},${r.lastPrice ?? ''},${r.compositeScore},${r.trend},${r.rsi ?? ''},${r.entryZoneLow ?? ''},${r.stopLoss ?? ''},${r.targetPrice ?? ''},${r.riskReward ?? ''},${r.fundamentalsPass}`;
      if (r.mode === 'options_income') return `${r.ticker},${r.lastPrice ?? ''},${r.strategy},${r.strike ?? ''},${r.expiration ?? ''},${r.dte ?? ''},${r.delta ?? ''},${r.premium ?? ''},${r.annualizedReturn ?? ''},${r.capitalRequired ?? ''}`;
      if (r.mode === 'wheel') return `${r.ticker},${r.lastPrice ?? ''},${r.recommendedStrike ?? ''},${r.expiration ?? ''},${r.dte ?? ''},${r.premium ?? ''},${r.annualizedReturn ?? ''},${r.ivRank ?? ''},${r.suitabilityScore},${r.optionLiquidityScore}`;
      return `${r.ticker},${r.lastPrice ?? ''},${r.trendStrength ?? ''},${r.suggestedStrategy},${r.structure},${r.maxProfit ?? ''},${r.maxLoss ?? ''},${r.breakeven ?? ''},${r.probabilityOfProfit ?? ''}`;
    });
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `analysis_${selectedMode}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg(`Exported ${results.length} rows to CSV`);
  }, [results, selectedMode]);

  // ── Navigate to Validate view for a ticker ────────────────────────────────────────

  const openValidateForTicker = useCallback((ticker: string) => {
    // Dispatch custom event to navigate to validate view
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
  }, []);

  // Auto-run analysis when in single ticker mode with everything ready
  useEffect(() => {
    if (singleTickerMode && selectedWatchlistId && selectedMode && !isRunning && results.length === 0) {
      // Use a ref to track if we already ran to prevent double execution
      let cancelled = false;
      const run = async () => {
        if (cancelled) return;
        setIsRunning(true);
        setError(null);
        setProgress({ current: 0, total: 1, ticker: singleTickerMode });
        try {
          const result = await window.api.analysis.run(selectedWatchlistId, selectedMode, [singleTickerMode]);
          if (cancelled) return;
          setRunResult(result);
          setResults(JSON.parse(result.resultsJson) as DecodedResult[]);
          setStatusMsg(`Analysis complete for ${singleTickerMode}`);
        } catch (e) {
          if (cancelled) return;
          setError((e as Error).message);
        } finally {
          if (!cancelled) {
            setIsRunning(false);
            setProgress(null);
            setSingleTickerMode(null);
          }
        }
      };
      run();
      return () => { cancelled = true; };
    }
  }, [singleTickerMode, selectedWatchlistId, selectedMode]);

  // Scroll to charts section when opened
  useEffect(() => {
    if (showCharts && chartsSectionRef.current) {
      chartsSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showCharts]);

  // ── Column definitions per mode ─────────────────────────────────────────

  const modeColumns = (mode: string): string[] => {
    switch (mode) {
      case 'buy': return ['Ticker', 'Price', 'Score/10', 'Trend', 'RSI', 'Entry Low', 'Stop', 'Target', 'R:R', 'Fund OK'];
      case 'options_income': return ['Ticker', 'Price', 'Strategy', 'Strike', 'Exp', 'DTE', 'Delta', 'Premium', 'Ann Return%', 'Capital'];
      case 'wheel': return ['Ticker', 'Price', 'Strike', 'Exp', 'DTE', 'Premium', 'Ann Return%', 'IV Rank', 'Days to Erns', 'Suitability', 'Liquidity'];
      case 'bullish':
      case 'bearish': return ['Ticker', 'Price', 'ADX', 'Strategy', 'Structure', 'Max Profit', 'Max Loss', 'Breakeven', 'POP'];
      default: return ['Ticker'];
    }
  };

  const renderCell = (result: DecodedResult, col: string): React.ReactNode => {
    if (result.mode === 'buy') {
      switch (col) {
        case 'Ticker': return (
          <span
            className="clickable-ticker"
            onClick={() => openValidateForTicker(result.ticker)}
            title="Click to validate"
          >
            {result.ticker}
          </span>
        );
        case 'Price': return fmtPrice(result.lastPrice);
        case 'Score/10': return `${result.compositeScore}/10`;
        case 'Trend': return result.trend;
        case 'RSI': return fmtNum(result.rsi, 1);
        case 'Entry Low': return fmtPrice(result.entryZoneLow);
        case 'Stop': return fmtPrice(result.stopLoss);
        case 'Target': return fmtPrice(result.targetPrice);
        case 'R:R': return fmtNum(result.riskReward, 2);
        case 'Fund OK': return result.fundamentalsPass ? '✓' : '✗';
      }
    } else if (result.mode === 'options_income') {
      switch (col) {
        case 'Ticker': return (
          <span
            className="clickable-ticker"
            onClick={() => openValidateForTicker(result.ticker)}
            title="Click to validate"
          >
            {result.ticker}
          </span>
        );
        case 'Price': return fmtPrice(result.lastPrice);
        case 'Strategy': return result.strategy;
        case 'Strike': return fmtNum(result.strike, 2);
        case 'Exp': return result.expiration ?? '—';
        case 'DTE': return result.dte?.toString() ?? '—';
        case 'Delta': return fmtNum(result.delta, 3);
        case 'Premium': return fmtPrice(result.premium);
        case 'Ann Return%': return fmtPct(result.annualizedReturn);
        case 'Capital': return result.capitalRequired ? `$${(result.capitalRequired / 1000).toFixed(0)}K` : '—';
      }
    } else if (result.mode === 'wheel') {
      switch (col) {
        case 'Ticker': return (
          <span
            className="clickable-ticker"
            onClick={() => openValidateForTicker(result.ticker)}
            title="Click to validate"
          >
            {result.ticker}
          </span>
        );
        case 'Price': return fmtPrice(result.lastPrice);
        case 'Strike': return fmtNum(result.recommendedStrike, 2);
        case 'Exp': return result.expiration ?? '—';
        case 'DTE': return result.dte?.toString() ?? '—';
        case 'Premium': return fmtPrice(result.premium);
        case 'Ann Return%': return fmtPct(result.annualizedReturn);
        case 'IV Rank': return fmtPct(result.ivRank);
        case 'Days to Erns': return result.daysToEarnings?.toString() ?? '—';
        case 'Suitability': return `${result.suitabilityScore}/10`;
        case 'Liquidity': return `${result.optionLiquidityScore}/10`;
      }
    } else {
      // bullish / bearish
      switch (col) {
        case 'Ticker': return (
          <span
            className="clickable-ticker"
            onClick={() => openValidateForTicker(result.ticker)}
            title="Click to validate"
          >
            {result.ticker}
          </span>
        );
        case 'Price': return fmtPrice(result.lastPrice);
        case 'ADX': return fmtNum(result.trendStrength, 1);
        case 'Strategy': return result.suggestedStrategy;
        case 'Structure': return result.structure;
        case 'Max Profit': return result.maxProfit !== null ? `$${result.maxProfit.toLocaleString()}` : 'Unlimited';
        case 'Max Loss': return result.maxLoss !== null ? `$${result.maxLoss.toLocaleString()}` : 'Unlimited';
        case 'Breakeven': return fmtPrice(result.breakeven);
        case 'POP': return result.probabilityOfProfit !== null ? `${(result.probabilityOfProfit * 100).toFixed(0)}%` : '—';
      }
    }
    return '—';
  };

  // Score badge colors.
  const scoreColor = (score: number): string => {
    if (score >= 7) return '#2ecc71';
    if (score >= 5) return '#f39c12';
    return '#e74c3c';
  };

  return (
    <div className="analysis-view">
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

      <div className="analysis-header">
        <h2>Analysis Engine</h2>
        {singleTickerMode ? (
          <span className="meta">Analyzing <strong>{singleTickerMode}</strong></span>
        ) : selectedWatchlistId && (
          <span className="meta">{watchlists.find(w => w.id === selectedWatchlistId)?.name} · {tickerCount} ticker{tickerCount === 1 ? '' : 's'}</span>
        )}
      </div>

      <div className="analysis-layout">
        {/* ── Left: controls ── */}
        <aside className="analysis-controls">
          {/* Watchlist selector or single ticker indicator */}
          {singleTickerMode ? (
            <div className="control-section">
              <h3>Single Stock Analysis</h3>
              <div className="single-ticker-info" style={{ padding: '12px', background: '#f0f4f8', borderRadius: '6px', marginBottom: '8px' }}>
                <span style={{ fontSize: '18px', fontWeight: 'bold' }}>{singleTickerMode}</span>
                <button
                  className="tiny-btn"
                  style={{ marginLeft: '12px' }}
                  onClick={() => {
                    setSingleTickerMode(null);
                    setResults([]);
                    setRunResult(null);
                  }}
                >
                  Clear
                </button>
              </div>
              <p className="hint">Running {selectedMode ?? 'buy'} analysis on {singleTickerMode}</p>
            </div>
          ) : (
            <div className="control-section">
              <h3>Watchlist</h3>
              <ul className="watchlist-selector-list">
                {watchlists.map((w) => (
                  <li
                    key={w.id}
                    className={`watchlist-selector-item ${selectedWatchlistId === w.id ? 'active' : ''}`}
                    onClick={() => setSelectedWatchlistId(w.id)}
                  >
                    <span className="name">{w.name}</span>
                    <span className="count">{w.itemCount}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Mode selector */}
          {modes.length > 0 && (
            <div className="control-section">
              <h3>Analysis Mode</h3>
              <div className="mode-cards">
                {modes.map((m) => (
                  <button
                    key={m.id}
                    className={`mode-card ${selectedMode === m.id ? 'active' : ''}`}
                    onClick={() => { setSelectedMode(m.id); setRunResult(null); setResults([]); }}
                    title={m.description}
                  >
                    <span className="mode-icon">{m.icon}</span>
                    <span className="mode-label">{m.label}</span>
                  </button>
                ))}
              </div>
              {selectedMode && (
                <p className="hint" style={{ marginTop: 8 }}>
                  {modes.find(m => m.id === selectedMode)?.description}
                </p>
              )}
            </div>
          )}

          {/* Run button */}
          <div className="control-section">
            {isRunning ? (
              <div>
                <div className="progress-bar-wrap">
                  <div
                    className="progress-bar-fill"
                    style={{ width: progress ? `${(progress.current / Math.max(progress.total, 1)) * 100}%` : '0%' }}
                  />
                </div>
                <span className="meta" style={{ display: 'block', marginTop: 4 }}>
                  {progress ? `Analyzing ${progress.current}/${progress.total}…` : 'Running…'}
                </span>
                <button onClick={cancelAnalysis} className="cancel-btn" style={{ marginTop: 8 }}>
                  ■ Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={runAnalysis}
                disabled={!selectedWatchlistId || !selectedMode}
                className="run-btn"
              >
                ▶ Run Analysis
              </button>
            )}
          </div>

          {/* Past snapshots */}
          {snapshots.length > 0 && (
            <div className="control-section">
              <div className="snapshot-header">
                <h3>Past Snapshots</h3>
                <button
                  className="clear-all-btn"
                  onClick={async () => {
                    if (!selectedWatchlistId) return;
                    const confirmed = await window.dialog.confirm({
                      title: 'Clear All Snapshots',
                      message: 'Are you sure you want to delete all snapshots? This cannot be undone.'
                    });
                    if (confirmed) {
                      await window.api.analysis.clearSnapshots(selectedWatchlistId);
                      setSnapshots([]);
                    }
                  }}
                  title="Delete all snapshots"
                >
                  Clear All
                </button>
              </div>
              <ul className="snapshot-list">
                {snapshots.slice(0, 10).map((s) => (
                  <li key={s.id} className="snapshot-item">
                    <button
                      className="snapshot-btn"
                      onClick={() => openSnapshot(s)}
                      title={`${s.resultCount} results`}
                    >
                      <span className="snapshot-mode">{s.mode}</span>
                      <span className="snapshot-date">{new Date(s.runAt).toLocaleDateString()}</span>
                      <span className="snapshot-count">{s.resultCount} results</span>
                    </button>
                    <button
                      className="snapshot-delete-btn"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await window.api.analysis.deleteSnapshot(s.id);
                        setSnapshots(prev => prev.filter(snap => snap.id !== s.id));
                      }}
                      title="Delete this snapshot"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {/* ── Right: results ── */}
        <main className="analysis-results">
          {!runResult && !isRunning && !singleTickerMode && (
            <div className="empty-state">
              <p>Select a watchlist and an analysis mode, then click <strong>Run Analysis</strong>.</p>
              <p className="hint">Results are saved as a snapshot and can be re-opened later.</p>
            </div>
          )}

          {isRunning && singleTickerMode && (
            <div className="empty-state">
              <p>Running {selectedMode ?? 'buy'} analysis on <strong>{singleTickerMode}</strong>…</p>
            </div>
          )}

          {results.length > 0 && (
            <>
              <div className="results-toolbar">
                <span>{results.length} result{results.length === 1 ? '' : 's'}</span>
                {runResult && (
                  <span className="meta" style={{ marginLeft: 8 }}>
                    {runResult.mode} · {new Date(runResult.runAt).toLocaleString()}
                  </span>
                )}
                <div style={{ flex: 1 }} />
                <button onClick={() => setSelected(new Set(results.map((_, i) => i)))} className="tiny-btn">
                  Select all
                </button>
                <button onClick={() => setSelected(new Set())} className="tiny-btn" style={{ marginLeft: 4 }}>
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
                <button onClick={exportCsv} className="tiny-btn" style={{ marginLeft: 4 }}>
                  Export CSV
                </button>
              </div>

              <div className="results-table-wrap">
                <table className="results-table">
                  <thead>
                    <tr>
                      <th style={{ width: 24 }}></th>
                      {modeColumns(selectedMode ?? '').map((col) => (
                        <th
                          key={col}
                          className={
                            col === 'Ticker' || col === 'Trend' || col === 'Strategy' || col === 'Structure' || col === 'Fund OK'
                              ? ''
                              : 'num'
                          }
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result, idx) => (
                      <tr key={idx} className={selected.has(idx) ? 'selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(idx)}
                            onChange={() =>
                              setSelected((prev) => {
                                const n = new Set(prev);
                                if (n.has(idx)) n.delete(idx); else n.add(idx);
                                return n;
                              })
                            }
                          />
                        </td>
                        {modeColumns(selectedMode ?? '').map((col) => (
                          <td
                            key={col}
                            className={
                              col === 'Ticker' || col === 'Trend' || col === 'Strategy' || col === 'Structure' || col === 'Fund OK'
                                ? ''
                                : col === 'Score/10' || col === 'Suitability' || col === 'POP'
                                  ? 'num score-cell'
                                  : 'num'
                            }
                            style={
                              col === 'Score/10' || col === 'Suitability'
                                ? { color: scoreColor(
                                    result.mode === 'buy'
                                      ? (result as { compositeScore: number }).compositeScore
                                      : result.mode === 'wheel'
                                        ? (result as { suitabilityScore: number }).suitabilityScore
                                        : 5)
                                  }
                                : {}
                            }
                          >
                            {renderCell(result, col)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Historical Charts Section */}
          {showCharts && selectedTickerForChart && (
            <div className="charts-section" ref={chartsSectionRef}>
              <div className="charts-header">
                <h3>{selectedTickerForChart} - Historical Charts</h3>
                <button
                  className="close-charts-btn"
                  onClick={() => {
                    setShowCharts(false);
                    setSelectedTickerForChart(null);
                  }}
                >
                  ✕ Close Charts
                </button>
              </div>

              <div className="charts-grid">
                <div className="chart-panel">
                  <HistoricalPriceChart ticker={selectedTickerForChart} />
                </div>

                <div className="chart-panel">
                  <HistoricalFinancialChart ticker={selectedTickerForChart} />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}