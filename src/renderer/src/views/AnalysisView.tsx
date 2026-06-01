// AnalysisView — FR-3: Multi-mode Analysis Engine.
// Runs all 5 modes in one pass, strategy tabs to switch between results.
// Snapshots listed below results, newest first.
// see SPEC: FR-3
// v0.22.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Watchlist,
  AnalysisAllModesPayload,
  AnalysisSnapshotRow,
  AnalysisMode
} from '@shared/types.js';

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

// ─── Result types (decoded from JSON) ────────────────────────────────────────

type BuyRow = { mode: 'buy'; ticker: string; lastPrice: number | null; compositeScore: number; trend: string; rsi: number | null; entryZoneLow: number | null; stopLoss: number | null; targetPrice: number | null; riskReward: number | null; fundamentalsPass: boolean; explanation: string };
type OptionsRow = { mode: 'options_income'; ticker: string; lastPrice: number | null; strategy: 'CSP' | 'CC'; strike: number | null; expiration: string | null; dte: number | null; delta: number | null; premium: number | null; annualizedReturn: number | null; ivRank: number | null; breakeven: number | null; capitalRequired: number | null; explanation: string };
type WheelRow = { mode: 'wheel'; ticker: string; lastPrice: number | null; recommendedStrike: number | null; expiration: string | null; dte: number | null; delta: number | null; premium: number | null; annualizedReturn: number | null; currentIv: number | null; ivRank: number | null; daysToEarnings: number | null; optionLiquidityScore: number; suitabilityScore: number; explanation: string };
type StrategyRow = { mode: 'bullish' | 'bearish'; ticker: string; lastPrice: number | null; trendStrength: number | null; suggestedStrategy: string; structure: string; maxProfit: number | null; maxLoss: number | null; breakeven: number | null; probabilityOfProfit: number | null; explanation: string };
type DecodedResult = BuyRow | OptionsRow | WheelRow | StrategyRow;

// ─── Tab config ───────────────────────────────────────────────────────────────

const TABS: { mode: AnalysisMode; icon: string; label: string; key: keyof AnalysisAllModesPayload }[] = [
  { mode: 'buy',           icon: '📈', label: 'Buy Opportunities', key: 'buy' },
  { mode: 'options_income',icon: '💰', label: 'Options Income',    key: 'options_income' },
  { mode: 'wheel',         icon: '🎯', label: 'Wheel Strategy',    key: 'wheel' },
  { mode: 'bullish',       icon: '🐂', label: 'Bullish',           key: 'bullish' },
  { mode: 'bearish',       icon: '🐻', label: 'Bearish',           key: 'bearish' },
];

const MODE_LABEL: Record<string, string> = {
  buy: 'Buy Opportunities', options_income: 'Options Income',
  wheel: 'Wheel Strategy', bullish: 'Bullish Strategies', bearish: 'Bearish Strategies',
};

// ─── Column definitions ───────────────────────────────────────────────────────

function modeColumns(mode: AnalysisMode): string[] {
  switch (mode) {
    case 'buy':           return ['Ticker', 'Price', 'Score/10', 'Trend', 'RSI', 'Entry Low', 'Stop', 'Target', 'R:R', 'Fund OK'];
    case 'options_income': return ['Ticker', 'Price', 'Strategy', 'Strike', 'Exp', 'DTE', 'Delta', 'Premium', 'Ann Return%', 'Capital'];
    case 'wheel':         return ['Ticker', 'Price', 'Strike', 'Exp', 'DTE', 'Premium', 'Ann Return%', 'IV %', 'Suitability', 'Liquidity'];
    case 'bullish':
    case 'bearish':       return ['Ticker', 'Price', 'ADX', 'Strategy', 'Structure', 'Max Profit', 'Max Loss', 'Breakeven', 'POP'];
  }
}

function scoreColor(score: number): string {
  if (score >= 7) return '#2ecc71';
  if (score >= 5) return '#f39c12';
  return '#e74c3c';
}

// ─── Snapshot display helpers ─────────────────────────────────────────────────

function parseSnapshotCounts(snap: AnalysisSnapshotRow) {
  try {
    const p = JSON.parse(snap.payloadJson) as { tickerCount?: number; results?: Record<string, unknown[]> };
    return {
      tickerCount: p.tickerCount ?? snap.resultCount,
      buy: p.results?.buy?.length ?? 0,
      options_income: p.results?.options_income?.length ?? 0,
      wheel: p.results?.wheel?.length ?? 0,
      bullish: p.results?.bullish?.length ?? 0,
      bearish: p.results?.bearish?.length ?? 0,
    };
  } catch { return null; }
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AnalysisView({ initialTicker, clearInitialTicker }: AnalysisViewProps) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [tickerCount, setTickerCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; ticker: string; mode: string } | null>(null);
  const [allResults, setAllResults] = useState<AnalysisAllModesPayload | null>(null);
  const [activeTab, setActiveTab] = useState<AnalysisMode>('buy');
  const [snapshots, setSnapshots] = useState<AnalysisSnapshotRow[]>([]);
  const [activeSnapshotId, setActiveSnapshotId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // For single-ticker auto-run (launched from screener/validate)
  const pendingTickerRef = useRef<string | null>(null);

  // Load watchlists on mount
  useEffect(() => {
    window.api.watchlists.list()
      .then(setWatchlists)
      .catch(e => setError((e as Error).message));
  }, []);

  // Handle initial ticker from screener — pick first watchlist and queue the ticker
  useEffect(() => {
    if (initialTicker && watchlists.length > 0) {
      pendingTickerRef.current = initialTicker;
      setSelectedWatchlistId(watchlists[0]!.id);
      if (clearInitialTicker) clearInitialTicker();
    }
  }, [initialTicker, watchlists, clearInitialTicker]);

  // Load ticker count + snapshots when watchlist changes
  const loadSnapshots = useCallback(async (wlId: number) => {
    const all = await window.api.analysis.getSnapshots(wlId).catch(() => []);
    setSnapshots(all.filter(s => s.mode === 'all'));
  }, []);

  useEffect(() => {
    if (!selectedWatchlistId) { setTickerCount(0); setSnapshots([]); return; }
    window.api.watchlists.items.list(selectedWatchlistId)
      .then(items => setTickerCount(items.length))
      .catch(() => setTickerCount(0));
    loadSnapshots(selectedWatchlistId);
  }, [selectedWatchlistId, loadSnapshots]);

  // ── Run analysis ─────────────────────────────────────────────────────────

  const runAnalysis = useCallback(async (tickerSubset?: string[]) => {
    if (!selectedWatchlistId) return;
    setIsRunning(true);
    setError(null);
    setAllResults(null);
    setActiveSnapshotId(null);
    setSortCol(null);

    const unsub = window.api.analysis.onProgress(data => {
      setProgress({ current: data.current, total: data.total, ticker: data.ticker, mode: data.mode ?? '' });
    });

    try {
      const result = await window.api.analysis.runAll(selectedWatchlistId, tickerSubset);
      setAllResults(result.results);
      setActiveSnapshotId(result.snapshotId);
      setActiveTab('buy');
      await loadSnapshots(selectedWatchlistId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      unsub();
      setIsRunning(false);
      setProgress(null);
    }
  }, [selectedWatchlistId, loadSnapshots]);

  // Auto-run for single ticker once the watchlist is selected
  useEffect(() => {
    if (pendingTickerRef.current && selectedWatchlistId && !isRunning) {
      const ticker = pendingTickerRef.current;
      pendingTickerRef.current = null;
      runAnalysis([ticker]);
    }
  }, [selectedWatchlistId, isRunning, runAnalysis]);

  const cancelAnalysis = useCallback(async () => {
    await window.api.analysis.cancel();
    setIsRunning(false);
    setProgress(null);
  }, []);

  // ── Load snapshot ────────────────────────────────────────────────────────

  const openSnapshot = useCallback(async (snap: AnalysisSnapshotRow) => {
    const full = await window.api.analysis.getAllModesSnapshot(snap.id).catch(() => null);
    if (!full) { setError('Snapshot not found.'); return; }
    setAllResults(full.results);
    setActiveSnapshotId(snap.id);
    setActiveTab('buy');
    setSortCol(null);
  }, []);

  // ── Delete snapshot ──────────────────────────────────────────────────────

  const deleteSnapshot = useCallback(async (id: number) => {
    await window.api.analysis.deleteSnapshot(id);
    setSnapshots(prev => prev.filter(s => s.id !== id));
    if (activeSnapshotId === id) { setAllResults(null); setActiveSnapshotId(null); }
  }, [activeSnapshotId]);

  const clearAllSnapshots = useCallback(async () => {
    if (!selectedWatchlistId) return;
    const confirmed = await window.dialog.confirm({
      title: 'Clear All Snapshots',
      message: 'Delete all analysis snapshots for this watchlist? This cannot be undone.'
    });
    if (!confirmed) return;
    await window.api.analysis.clearSnapshots(selectedWatchlistId);
    setSnapshots([]);
    setAllResults(null);
    setActiveSnapshotId(null);
  }, [selectedWatchlistId]);

  // ── Sort ─────────────────────────────────────────────────────────────────

  const handleSortClick = (col: string) => {
    setSortCol(prev => {
      if (prev === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return col; }
      setSortDir('desc');
      return col;
    });
  };

  const getSortValue = (result: DecodedResult, col: string): number | string | null => {
    if (result.mode === 'buy') {
      switch (col) {
        case 'Ticker': return result.ticker; case 'Price': return result.lastPrice;
        case 'Score/10': return result.compositeScore; case 'Trend': return result.trend;
        case 'RSI': return result.rsi; case 'Entry Low': return result.entryZoneLow;
        case 'Stop': return result.stopLoss; case 'Target': return result.targetPrice;
        case 'R:R': return result.riskReward; case 'Fund OK': return result.fundamentalsPass ? 1 : 0;
      }
    } else if (result.mode === 'options_income') {
      switch (col) {
        case 'Ticker': return result.ticker; case 'Price': return result.lastPrice;
        case 'Strategy': return result.strategy; case 'Strike': return result.strike;
        case 'Exp': return result.expiration; case 'DTE': return result.dte;
        case 'Delta': return result.delta; case 'Premium': return result.premium;
        case 'Ann Return%': return result.annualizedReturn; case 'Capital': return result.capitalRequired;
      }
    } else if (result.mode === 'wheel') {
      switch (col) {
        case 'Ticker': return result.ticker; case 'Price': return result.lastPrice;
        case 'Strike': return result.recommendedStrike; case 'Exp': return result.expiration;
        case 'DTE': return result.dte; case 'Premium': return result.premium;
        case 'Ann Return%': return result.annualizedReturn; case 'IV %': return result.currentIv;
        case 'Suitability': return result.suitabilityScore; case 'Liquidity': return result.optionLiquidityScore;
      }
    } else {
      switch (col) {
        case 'Ticker': return result.ticker; case 'Price': return result.lastPrice;
        case 'ADX': return result.trendStrength; case 'Strategy': return result.suggestedStrategy;
        case 'Structure': return result.structure; case 'Max Profit': return result.maxProfit;
        case 'Max Loss': return result.maxLoss; case 'Breakeven': return result.breakeven;
        case 'POP': return result.probabilityOfProfit;
      }
    }
    return null;
  };

  // Current tab results
  const tabResults: DecodedResult[] = useMemo(() => {
    if (!allResults) return [];
    return (allResults[activeTab] ?? []) as DecodedResult[];
  }, [allResults, activeTab]);

  const sortedResults = useMemo(() => {
    const indexed = tabResults.map((r, i) => ({ r, i }));
    if (!sortCol) return indexed;
    return [...indexed].sort((a, b) => {
      const av = getSortValue(a.r, sortCol);
      const bv = getSortValue(b.r, sortCol);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [tabResults, sortCol, sortDir]);

  // ── Cell renderer ────────────────────────────────────────────────────────

  const openValidateForTicker = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
  };

  const renderCell = (result: DecodedResult, col: string): React.ReactNode => {
    if (result.mode === 'buy') {
      switch (col) {
        case 'Ticker':    return <span className="clickable-ticker" onClick={() => openValidateForTicker(result.ticker)} title="Click to validate">{result.ticker}</span>;
        case 'Price':     return fmtPrice(result.lastPrice);
        case 'Score/10':  return `${result.compositeScore}/10`;
        case 'Trend':     return result.trend;
        case 'RSI':       return fmtNum(result.rsi, 1);
        case 'Entry Low': return fmtPrice(result.entryZoneLow);
        case 'Stop':      return fmtPrice(result.stopLoss);
        case 'Target':    return fmtPrice(result.targetPrice);
        case 'R:R':       return fmtNum(result.riskReward, 2);
        case 'Fund OK':   return result.fundamentalsPass ? '✓' : '✗';
      }
    } else if (result.mode === 'options_income') {
      switch (col) {
        case 'Ticker':      return <span className="clickable-ticker" onClick={() => openValidateForTicker(result.ticker)} title="Click to validate">{result.ticker}</span>;
        case 'Price':       return fmtPrice(result.lastPrice);
        case 'Strategy':    return result.strategy;
        case 'Strike':      return fmtNum(result.strike, 2);
        case 'Exp':         return result.expiration ?? '—';
        case 'DTE':         return result.dte?.toString() ?? '—';
        case 'Delta':       return fmtNum(result.delta, 3);
        case 'Premium':     return fmtPrice(result.premium);
        case 'Ann Return%': return fmtPct(result.annualizedReturn);
        case 'Capital':     return result.capitalRequired ? `$${(result.capitalRequired / 1000).toFixed(0)}K` : '—';
      }
    } else if (result.mode === 'wheel') {
      switch (col) {
        case 'Ticker':      return <span className="clickable-ticker" onClick={() => openValidateForTicker(result.ticker)} title="Click to validate">{result.ticker}</span>;
        case 'Price':       return fmtPrice(result.lastPrice);
        case 'Strike':      return fmtNum(result.recommendedStrike, 2);
        case 'Exp':         return result.expiration ?? '—';
        case 'DTE':         return result.dte?.toString() ?? '—';
        case 'Premium':     return fmtPrice(result.premium);
        case 'Ann Return%': return fmtPct(result.annualizedReturn);
        case 'IV %':        return result.currentIv !== null ? (
          <span style={{ color: result.currentIv >= 30 ? '#2ecc71' : result.currentIv >= 20 ? '#f39c12' : '#95a5a6' }}>
            {result.currentIv.toFixed(1)}%
          </span>
        ) : '—';
        case 'Suitability': return `${result.suitabilityScore}/10`;
        case 'Liquidity':   return `${result.optionLiquidityScore}/10`;
      }
    } else {
      switch (col) {
        case 'Ticker':     return <span className="clickable-ticker" onClick={() => openValidateForTicker(result.ticker)} title="Click to validate">{result.ticker}</span>;
        case 'Price':      return fmtPrice(result.lastPrice);
        case 'ADX':        return fmtNum(result.trendStrength, 1);
        case 'Strategy':   return result.suggestedStrategy;
        case 'Structure':  return result.structure;
        case 'Max Profit': return result.maxProfit !== null ? `$${result.maxProfit.toLocaleString()}` : 'Unlimited';
        case 'Max Loss':   return result.maxLoss !== null ? `$${result.maxLoss.toLocaleString()}` : 'Unlimited';
        case 'Breakeven':  return fmtPrice(result.breakeven);
        case 'POP':        return result.probabilityOfProfit !== null ? `${(result.probabilityOfProfit * 100).toFixed(0)}%` : '—';
      }
    }
    return '—';
  };

  // ── Render ───────────────────────────────────────────────────────────────

  const selectedWatchlist = watchlists.find(w => w.id === selectedWatchlistId);
  const pct = progress ? Math.round((progress.current / Math.max(progress.total, 1)) * 100) : 0;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>
      <style>{`
        .an-tab { padding: 7px 16px; border-radius: 6px 6px 0 0; border: 1px solid #2d3748; border-bottom: none; background: #131b2e; color: #95a5a6; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.15s; }
        .an-tab:hover { background: #1a2535; color: #ecf0f1; }
        .an-tab.active { background: #1a2a3a; color: #89b4fa; border-color: #3d4f6e; }
        .an-tab .tab-count { margin-left: 6px; font-size: 11px; color: #666; }
        .an-tab.active .tab-count { color: #89b4fa; }
        .an-results-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .an-results-table th { background: #1a2235; color: #89b4fa; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 1px solid #2d3748; cursor: pointer; user-select: none; white-space: nowrap; }
        .an-results-table th:hover { color: #ecf0f1; }
        .an-results-table td { padding: 7px 10px; border-bottom: 1px solid #1e2535; vertical-align: middle; }
        .an-results-table tr:hover td { background: #1a2535; }
        .clickable-ticker { color: #89b4fa; cursor: pointer; font-weight: 600; }
        .clickable-ticker:hover { text-decoration: underline; }
        .snap-row { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #1e2535; cursor: pointer; border-radius: 6px; transition: background 0.1s; }
        .snap-row:hover { background: #1a2535; }
        .snap-row.active { background: #1a2a3a; border: 1px solid #3d4f6e; }
        .snap-badge { padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; background: #1e2a3a; color: #89b4fa; }
        .an-del-btn { background: none; border: none; color: #555; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 4px; }
        .an-del-btn:hover { color: #e74c3c; background: #2a1a1a; }
      `}</style>

      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      <h2 style={{ color: '#ecf0f1', margin: '0 0 20px' }}>📊 Analysis Engine</h2>

      {/* ── Controls row ── */}
      <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748', padding: '16px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 220 }}>
            <label style={{ color: '#a0aec0', fontSize: 13, whiteSpace: 'nowrap' }}>Watchlist</label>
            <select
              value={selectedWatchlistId ?? ''}
              onChange={e => {
                const id = Number(e.target.value);
                setSelectedWatchlistId(id || null);
                setAllResults(null);
                setActiveSnapshotId(null);
                setSortCol(null);
              }}
              style={{ flex: 1, background: '#1e2a3a', border: '1px solid #3d4f6e', borderRadius: 6, color: '#ecf0f1', padding: '6px 10px', fontSize: 13 }}
            >
              <option value="">— select —</option>
              {watchlists.map(w => (
                <option key={w.id} value={w.id}>{w.name} ({w.itemCount})</option>
              ))}
            </select>
          </div>

          {selectedWatchlist && !isRunning && (
            <span style={{ color: '#95a5a6', fontSize: 12 }}>
              {tickerCount} ticker{tickerCount !== 1 ? 's' : ''}
            </span>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            {isRunning ? (
              <button
                onClick={cancelAnalysis}
                style={{ padding: '7px 18px', background: '#2a1a1a', border: '1px solid #e74c3c', borderRadius: 6, color: '#e74c3c', cursor: 'pointer', fontSize: 13 }}
              >
                ■ Cancel
              </button>
            ) : (
              <button
                onClick={() => runAnalysis()}
                disabled={!selectedWatchlistId}
                style={{
                  padding: '7px 20px', background: selectedWatchlistId ? '#2980b9' : '#1e2535',
                  border: 'none', borderRadius: 6, color: selectedWatchlistId ? '#fff' : '#555',
                  cursor: selectedWatchlistId ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 600
                }}
              >
                ▶ Run Analysis
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {isRunning && progress && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 12 }}>
              <span style={{ color: '#89b4fa' }}>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', marginRight: 6 }}>⟳</span>
                {progress.mode ? (MODE_LABEL[progress.mode] ?? progress.mode) : 'Analyzing…'}
              </span>
              <span style={{ color: '#95a5a6' }}>{progress.current} / {progress.total} · {pct}%</span>
            </div>
            <div style={{ background: '#1a2235', borderRadius: 4, height: 5, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: '#3498db', borderRadius: 4, transition: 'width 0.3s ease' }} />
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#666' }}>{progress.ticker}</div>
          </div>
        )}
      </div>

      {/* ── Strategy tabs + results ── */}
      {allResults && (
        <>
          {/* Tab strip */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', marginBottom: 0 }}>
            {TABS.map(tab => {
              const count = (allResults[tab.key] ?? []).length;
              return (
                <button
                  key={tab.mode}
                  className={`an-tab${activeTab === tab.mode ? ' active' : ''}`}
                  onClick={() => { setActiveTab(tab.mode); setSortCol(null); }}
                >
                  {tab.icon} {tab.label}
                  <span className="tab-count">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Results panel */}
          <div style={{ background: '#131b2e', border: '1px solid #2d3748', borderRadius: '0 8px 8px 8px', marginBottom: 24, overflow: 'hidden' }}>
            {tabResults.length === 0 ? (
              <div style={{ padding: 24, color: '#95a5a6', textAlign: 'center' }}>
                No results for {MODE_LABEL[activeTab] ?? activeTab} in this run.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <div style={{ padding: '8px 14px', borderBottom: '1px solid #1e2535', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#95a5a6', fontSize: 12 }}>{tabResults.length} result{tabResults.length !== 1 ? 's' : ''}</span>
                </div>
                <table className="an-results-table">
                  <thead>
                    <tr>
                      {modeColumns(activeTab).map(col => {
                        const isSorted = sortCol === col;
                        return (
                          <th key={col} onClick={() => handleSortClick(col)}>
                            {col}
                            <span style={{ marginLeft: 4, opacity: 0.6, fontSize: 10 }}>
                              {isSorted ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedResults.map(({ r: result, i: origIdx }) => (
                      <tr key={origIdx}>
                        {modeColumns(activeTab).map(col => (
                          <td
                            key={col}
                            style={
                              col === 'Score/10' || col === 'Suitability'
                                ? { color: scoreColor(
                                    result.mode === 'buy' ? (result as BuyRow).compositeScore
                                    : result.mode === 'wheel' ? (result as WheelRow).suitabilityScore : 5
                                  ), fontWeight: 600 }
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
            )}
          </div>
        </>
      )}

      {/* Empty state */}
      {!allResults && !isRunning && (
        <div style={{ background: '#131b2e', border: '1px solid #2d3748', borderRadius: 10, padding: 40, textAlign: 'center', marginBottom: 24 }}>
          <p style={{ color: '#95a5a6', margin: 0 }}>Select a watchlist and click <strong style={{ color: '#ecf0f1' }}>Run Analysis</strong> to analyze all strategies at once.</p>
          <p style={{ color: '#666', margin: '8px 0 0', fontSize: 12 }}>Results are saved as a snapshot and can be re-opened below.</p>
        </div>
      )}

      {/* ── Snapshots ── */}
      {(snapshots.length > 0 || selectedWatchlistId) && (
        <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>Past Runs</span>
            {snapshots.length > 0 && (
              <button
                onClick={clearAllSnapshots}
                style={{ background: 'none', border: '1px solid #555', borderRadius: 5, color: '#95a5a6', cursor: 'pointer', fontSize: 12, padding: '3px 10px' }}
              >
                Clear All
              </button>
            )}
          </div>

          {snapshots.length === 0 ? (
            <div style={{ padding: 20, color: '#555', textAlign: 'center', fontSize: 13 }}>No runs yet for this watchlist.</div>
          ) : (
            <div>
              {snapshots.map(snap => {
                const counts = parseSnapshotCounts(snap);
                const isActive = snap.id === activeSnapshotId;
                return (
                  <div
                    key={snap.id}
                    className={`snap-row${isActive ? ' active' : ''}`}
                    onClick={() => openSnapshot(snap)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <span style={{ color: '#ecf0f1', fontSize: 13, fontWeight: 500 }}>{fmtDateTime(snap.runAt)}</span>
                        {counts && (
                          <span style={{ color: '#666', fontSize: 12 }}>· {counts.tickerCount} tickers</span>
                        )}
                        {counts && (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                            <span className="snap-badge">📈 {counts.buy}</span>
                            <span className="snap-badge">💰 {counts.options_income}</span>
                            <span className="snap-badge">🎯 {counts.wheel}</span>
                            <span className="snap-badge">🐂 {counts.bullish}</span>
                            <span className="snap-badge">🐻 {counts.bearish}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <button
                      className="an-del-btn"
                      onClick={e => { e.stopPropagation(); deleteSnapshot(snap.id); }}
                      title="Delete this snapshot"
                    >
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
