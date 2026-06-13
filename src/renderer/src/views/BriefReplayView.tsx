import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReplayPickRow, ReplayProgressEvent, ReplaySummary, ReplayChartData, PremiumHistoryReadiness } from '@shared/types.js';
import ReplayChartsModal from '../components/ReplayChartsModal.js';

const STRATEGIES = ['wheel', 'bullish', 'bearish', 'income', 'buy'] as const;
type Strategy = (typeof STRATEGIES)[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}%`;
}

function fmtScore(v: number): string {
  return v.toFixed(1);
}

function hitRateColor(v: number | null): string {
  if (v === null) return '';
  if (v >= 60) return '#4caf50';
  if (v >= 45) return '#ff9800';
  return '#ef5350';
}

function retColor(v: number | null, strategy?: string): string {
  if (v === null) return '';
  const win = strategy === 'bearish' ? v < 0 : v > 0;
  return win ? '#4caf50' : '#ef5350';
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunState {
  running: boolean;
  phase: ReplayProgressEvent['phase'];
  current: number;
  total: number;
  message: string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type SummarySortKey = keyof ReplaySummary;

function sortSummaries(rows: ReplaySummary[], key: SummarySortKey, dir: 'asc' | 'desc'): ReplaySummary[] {
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

function SummaryTable({ summaries }: { summaries: ReplaySummary[] }) {
  const [sortKey, setSortKey] = useState<SummarySortKey>('strategy');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  if (summaries.length === 0) return null;

  const handleSort = (key: SummarySortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sorted = sortSummaries(summaries, sortKey, sortDir);
  const arrow = (key: SummarySortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const thStyle = (key: SummarySortKey, align: 'left' | 'right' = 'right'): React.CSSProperties => ({
    textAlign: align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
    color: sortKey === key ? 'var(--accent)' : undefined,
  });

  return (
    <div style={{ overflowX: 'auto', marginBottom: 24 }}>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={thStyle('strategy', 'left')}    onClick={() => handleSort('strategy')}>Strategy{arrow('strategy')}</th>
            <th style={thStyle('totalDates')}  onClick={() => handleSort('totalDates')}>Days{arrow('totalDates')}</th>
            <th style={thStyle('totalPicks')}  onClick={() => handleSort('totalPicks')}>Picks{arrow('totalPicks')}</th>
            <th style={thStyle('n5d')}         onClick={() => handleSort('n5d')} title="Picks with 5d data">n(5d){arrow('n5d')}</th>
            <th style={thStyle('hitRate5d')}   onClick={() => handleSort('hitRate5d')}>HR 5d{arrow('hitRate5d')}</th>
            <th style={thStyle('n10d')}        onClick={() => handleSort('n10d')} title="Picks with 10d data">n(10d){arrow('n10d')}</th>
            <th style={thStyle('hitRate10d')}  onClick={() => handleSort('hitRate10d')}>HR 10d{arrow('hitRate10d')}</th>
            <th style={thStyle('n21d')}        onClick={() => handleSort('n21d')} title="Picks with 21d data">n(21d){arrow('n21d')}</th>
            <th style={thStyle('hitRate21d')}  onClick={() => handleSort('hitRate21d')}>HR 21d{arrow('hitRate21d')}</th>
            <th style={thStyle('avgReturn5d')}         onClick={() => handleSort('avgReturn5d')}>Avg 5d{arrow('avgReturn5d')}</th>
            <th style={thStyle('avgReturn10d')}        onClick={() => handleSort('avgReturn10d')}>Avg 10d{arrow('avgReturn10d')}</th>
            <th style={thStyle('avgReturn21d')}        onClick={() => handleSort('avgReturn21d')}>Avg 21d{arrow('avgReturn21d')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(s => (
            <tr key={s.strategy}>
              <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{s.strategy}</td>
              <td style={{ textAlign: 'right' }}>{s.totalDates}</td>
              <td style={{ textAlign: 'right' }}>{s.totalPicks}</td>
              <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{s.n5d}</td>
              <td style={{ textAlign: 'right', color: hitRateColor(s.hitRate5d) }}>
                {s.hitRate5d !== null ? `${s.hitRate5d}%` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{s.n10d}</td>
              <td style={{ textAlign: 'right', color: hitRateColor(s.hitRate10d) }}>
                {s.hitRate10d !== null ? `${s.hitRate10d}%` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{s.n21d}</td>
              <td style={{ textAlign: 'right', color: hitRateColor(s.hitRate21d) }}>
                {s.hitRate21d !== null ? `${s.hitRate21d}%` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: retColor(s.avgReturn5d,  s.strategy) }}>{fmtPct(s.avgReturn5d)}</td>
              <td style={{ textAlign: 'right', color: retColor(s.avgReturn10d, s.strategy) }}>{fmtPct(s.avgReturn10d)}</td>
              <td style={{ textAlign: 'right', color: retColor(s.avgReturn21d, s.strategy) }}>{fmtPct(s.avgReturn21d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PickSortKey = 'asOfDate' | 'strategy' | 'ticker' | 'rank' | 'compositeScore' | 'entryPrice' | 'ret5d' | 'ret10d' | 'ret21d' | 'closeDate' | 'closePrice' | 'maxDrawdown21d';

function sortPicks(rows: ReplayPickRow[], key: PickSortKey, dir: 'asc' | 'desc'): ReplayPickRow[] {
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    // nulls last regardless of direction
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

function PicksTable({ picks }: { picks: ReplayPickRow[] }) {
  const [sortKey, setSortKey] = useState<PickSortKey>('asOfDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  if (picks.length === 0) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No picks yet.</p>;

  const handleSort = (key: PickSortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sorted = sortPicks(picks, sortKey, sortDir);
  const arrow = (key: PickSortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  const thStyle = (key: PickSortKey, align: 'left' | 'right' = 'right'): React.CSSProperties => ({
    textAlign: align, cursor: 'pointer', userSelect: 'none',
    color: sortKey === key ? 'var(--accent)' : undefined,
  });

  return (
    <div className="results-table-wrap" style={{ maxHeight: 480 }}>
      <table className="results-table">
        <thead>
          <tr>
            <th style={thStyle('asOfDate', 'left')}    onClick={() => handleSort('asOfDate')}>Date{arrow('asOfDate')}</th>
            <th style={thStyle('strategy', 'left')}    onClick={() => handleSort('strategy')}>Strategy{arrow('strategy')}</th>
            <th style={thStyle('ticker', 'left')}      onClick={() => handleSort('ticker')}>Ticker{arrow('ticker')}</th>
            <th style={thStyle('rank')}                onClick={() => handleSort('rank')}>Rank{arrow('rank')}</th>
            <th style={thStyle('compositeScore')}      onClick={() => handleSort('compositeScore')}>Score{arrow('compositeScore')}</th>
            <th style={thStyle('entryPrice')}          onClick={() => handleSort('entryPrice')}>Entry{arrow('entryPrice')}</th>
            <th style={thStyle('ret5d')}               onClick={() => handleSort('ret5d')}>5d{arrow('ret5d')}</th>
            <th style={thStyle('ret10d')}              onClick={() => handleSort('ret10d')}>10d{arrow('ret10d')}</th>
            <th style={thStyle('ret21d')}              onClick={() => handleSort('ret21d')}>21d{arrow('ret21d')}</th>
            <th style={thStyle('closeDate')}           onClick={() => handleSort('closeDate')}>Close Date{arrow('closeDate')}</th>
            <th style={thStyle('closePrice')}          onClick={() => handleSort('closePrice')}>Close{arrow('closePrice')}</th>
            <th style={thStyle('maxDrawdown21d')}      onClick={() => handleSort('maxDrawdown21d')}>Drawdown{arrow('maxDrawdown21d')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p, i) => (
            <tr key={i}>
              <td>{p.asOfDate}</td>
              <td style={{ textTransform: 'capitalize' }}>{p.strategy}</td>
              <td style={{ fontWeight: 600 }}>{p.ticker}</td>
              <td style={{ textAlign: 'right' }}>{p.rank}</td>
              <td style={{ textAlign: 'right' }}>{fmtScore(p.compositeScore)}</td>
              <td style={{ textAlign: 'right' }}>
                {p.entryPrice !== null ? `$${p.entryPrice.toFixed(2)}` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: retColor(p.ret5d,  p.strategy) }}>{fmtPct(p.ret5d)}</td>
              <td style={{ textAlign: 'right', color: retColor(p.ret10d, p.strategy) }}>{fmtPct(p.ret10d)}</td>
              <td style={{ textAlign: 'right', color: retColor(p.ret21d, p.strategy) }}>{fmtPct(p.ret21d)}</td>
              <td style={{ textAlign: 'right' }}>{p.closeDate ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>
                {p.closePrice !== null ? `$${p.closePrice.toFixed(2)}` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: p.maxDrawdown21d !== null && p.maxDrawdown21d < -5 ? '#ef5350' : '' }}>
                {fmtPct(p.maxDrawdown21d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

// Approx 21 trading days = 30 calendar days before today
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// In-app readiness note for the options_premium_history table. Stays out of the way
// while data accumulates, then surfaces a prompt to build real income/wheel ROC once
// enough matured premium history exists. Renders nothing until the table has any rows.
function PremiumHistoryBanner({ readiness }: { readiness: PremiumHistoryReadiness | null }) {
  if (!readiness || readiness.days === 0) return null;

  const { ready, maturedDays, thresholdDays, days, fromDate } = readiness;
  const style: React.CSSProperties = {
    borderRadius: 6, padding: '8px 12px', marginBottom: 16, fontSize: 13,
    border: ready ? '1px solid #4caf50' : '1px solid var(--border)',
    background: ready ? '#0c1a0c' : 'var(--bg-elevated)',
    color: ready ? '#a5d6a7' : 'var(--text-muted)',
  };

  return (
    <div style={style}>
      {ready ? (
        <>
          📊 <strong>Options premium history is ready</strong> — {maturedDays} matured days captured
          {fromDate ? ` since ${fromDate}` : ''}. Real income/wheel return-on-capital can now be computed
          from actual premium (not the stayed-above-strike proxy). Ask Claude to build the ROC view.
        </>
      ) : (
        <>
          ⏳ Options premium history accumulating: <strong>{maturedDays}/{thresholdDays}</strong> matured days
          ({days} captured{fromDate ? ` since ${fromDate}` : ''}). Real income/wheel ROC unlocks once enough
          premium entries have matured past expiry.
        </>
      )}
    </div>
  );
}

export default function BriefReplayView() {
  const today = new Date().toISOString().slice(0, 10);
  // Default "to" = 30 cal days back (≈21 trading days) so 21d returns can be evaluated.
  // Default "from" = 60 cal days back for a ~1-month scoring window.
  const defaultTo   = subtractDays(today, 30);
  const defaultFrom = subtractDays(today, 60);

  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate]     = useState(defaultTo);
  const [runState, setRunState] = useState<RunState>({
    running: false, phase: 'done', current: 0, total: 0, message: '',
  });
  const [summaries,        setSummaries]        = useState<ReplaySummary[]>([]);
  const [picks,            setPicks]            = useState<ReplayPickRow[]>([]);
  const [filterStrategy,   setFilterStrategy]   = useState<Strategy | ''>('');
  const [existingRange,    setExistingRange]     = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [error,            setError]             = useState<string | null>(null);
  const [showCharts,       setShowCharts]        = useState(false);
  const [chartData,        setChartData]         = useState<ReplayChartData | null>(null);
  const [premiumReadiness, setPremiumReadiness]  = useState<PremiumHistoryReadiness | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);

  const loadData = useCallback(async () => {
    const [sums, pickRows, range, readiness] = await Promise.all([
      window.api.briefReplay.getSummaries(),
      window.api.briefReplay.getPicks(filterStrategy || undefined, 1000),
      window.api.briefReplay.getDateRange(),
      window.api.briefReplay.premiumHistoryReadiness(),
    ]);
    setSummaries(sums);
    setPicks(pickRows);
    setExistingRange(range);
    setPremiumReadiness(readiness);
  }, [filterStrategy]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRun = async () => {
    if (!fromDate || !toDate || fromDate > toDate) {
      setError('Invalid date range.'); return;
    }
    setError(null);

    // Subscribe to progress before starting
    if (unsubRef.current) unsubRef.current();
    unsubRef.current = window.api.briefReplay.onProgress((evt: ReplayProgressEvent) => {
      if (evt.phase === 'done') {
        setRunState({ running: false, phase: 'done', current: evt.current, total: evt.total, message: 'Done.' });
        loadData();
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      } else if (evt.phase === 'error') {
        setRunState(s => ({ ...s, running: false, phase: 'error', message: evt.message }));
        setError(evt.message);
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      } else {
        setRunState({ running: true, phase: evt.phase, current: evt.current, total: evt.total, message: evt.message });
      }
    });

    setRunState({ running: true, phase: 'scoring', current: 0, total: 0, message: 'Starting…' });
    await window.api.briefReplay.runRange(fromDate, toDate);
  };

  const handleCancel = async () => {
    await window.api.briefReplay.cancel();
    setRunState(s => ({ ...s, running: false, message: 'Cancelled.' }));
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
  };

  const handleClear = async () => {
    if (!confirm('Clear all replay data?')) return;
    await window.api.briefReplay.clear();
    setSummaries([]);
    setPicks([]);
    setExistingRange({ from: null, to: null });
  };

  const handleCharts = async () => {
    const data = await window.api.briefReplay.getChartData();
    if (data) {
      setChartData(data);
      setShowCharts(true);
    }
  };

  // Cleanup subscription on unmount
  useEffect(() => () => { if (unsubRef.current) unsubRef.current(); }, []);

  const progressPct = runState.total > 0 ? Math.round((runState.current / runState.total) * 100) : 0;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4, fontSize: 18, fontWeight: 700 }}>Brief Replay</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0, marginBottom: 8 }}>
        Back-test the scoring pipeline against historical dates. Clears existing replay data on each run.
      </p>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0, marginBottom: 20 }}>
        <strong style={{ color: 'var(--text-secondary)' }}>Note:</strong> Forward returns require price data <em>after</em> the pick date.
        For 5d returns, <strong>To</strong> must be at least 5 trading days before today (&asymp;7 cal days).
        For all three columns, set <strong>To</strong> at least 21 trading days back (&asymp;30 cal days).
        Picks from recent days will show &mdash; until those dates have passed.
      </p>

      <PremiumHistoryBanner readiness={premiumReadiness} />

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 13 }}>
          From&nbsp;
          <input
            type="date" value={fromDate} max={toDate}
            onChange={e => setFromDate(e.target.value)}
            disabled={runState.running}
            style={{ marginLeft: 4 }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          To&nbsp;
          <input
            type="date" value={toDate} min={fromDate} max={today}
            onChange={e => setToDate(e.target.value)}
            disabled={runState.running}
            style={{ marginLeft: 4 }}
          />
          {toDate > subtractDays(today, 7) && (
            <span style={{ marginLeft: 6, fontSize: 11, color: '#ff9800' }} title="To date is within 7 calendar days of today — forward returns may be missing">
              ⚠ recent
            </span>
          )}
        </label>
        {!runState.running ? (
          <button className="btn-primary" onClick={handleRun} style={{ minWidth: 80 }}>
            Run
          </button>
        ) : (
          <button className="btn-secondary" onClick={handleCancel} style={{ minWidth: 80 }}>
            Cancel
          </button>
        )}
        {!runState.running && (summaries.length > 0 || picks.length > 0) && (
          <button className="btn-ghost" onClick={handleClear} style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Clear data
          </button>
        )}
        {!runState.running && summaries.length > 0 && (
          <button className="btn-secondary" onClick={handleCharts} style={{ fontSize: 13 }}>
            Charts
          </button>
        )}
      </div>

      {/* Existing data notice */}
      {existingRange.from && !runState.running && (
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Existing data: {existingRange.from} → {existingRange.to}
        </p>
      )}

      {/* Progress bar */}
      {(runState.running || runState.phase === 'done' && runState.total > 0) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {runState.message}
          </div>
          <div style={{ background: 'var(--bg-elevated)', borderRadius: 4, height: 6, overflow: 'hidden', width: '100%', maxWidth: 480 }}>
            <div style={{
              background: runState.phase === 'error' ? '#ef5350' : 'var(--accent)',
              width: `${runState.phase === 'done' ? 100 : progressPct}%`,
              height: '100%',
              transition: 'width 0.3s ease',
            }} />
          </div>
          {runState.total > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {runState.current}/{runState.total} days {runState.phase !== 'done' && `(${progressPct}%)`}
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ background: '#1a0a0a', border: '1px solid #ef5350', borderRadius: 6, padding: '8px 12px', marginBottom: 16, fontSize: 13, color: '#ef9a9a' }}>
          {error}
        </div>
      )}

      {/* Summary table */}
      {summaries.length > 0 && (
        <>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, marginTop: 8 }}>Hit-Rate Summary</h3>
          <SummaryTable summaries={summaries} />
        </>
      )}

      {/* Picks table */}
      {picks.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Picks Detail</h3>
            <select
              value={filterStrategy}
              onChange={e => setFilterStrategy(e.target.value as Strategy | '')}
              style={{ fontSize: 12, padding: '2px 6px' }}
            >
              <option value="">All strategies</option>
              {STRATEGIES.map(s => (
                <option key={s} value={s} style={{ textTransform: 'capitalize' }}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {picks.length.toLocaleString()} rows
            </span>
          </div>
          <PicksTable picks={picks} />
        </>
      )}

      {showCharts && chartData && (
        <ReplayChartsModal data={chartData} onClose={() => setShowCharts(false)} />
      )}
    </div>
  );
}
