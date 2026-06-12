import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReplayPickRow, ReplayProgressEvent, ReplaySummary } from '@shared/types.js';

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

function retColor(v: number | null): string {
  if (v === null) return '';
  return v >= 0 ? '#4caf50' : '#ef5350';
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

function SummaryTable({ summaries }: { summaries: ReplaySummary[] }) {
  if (summaries.length === 0) return null;
  return (
    <div style={{ overflowX: 'auto', marginBottom: 24 }}>
      <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Strategy</th>
            <th>Days</th>
            <th>Picks</th>
            <th>Eval'd</th>
            <th>HR 5d</th>
            <th>HR 10d</th>
            <th>HR 21d</th>
            <th>Avg 5d</th>
            <th>Avg 10d</th>
            <th>Avg 21d</th>
          </tr>
        </thead>
        <tbody>
          {summaries.map(s => (
            <tr key={s.strategy}>
              <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{s.strategy}</td>
              <td style={{ textAlign: 'right' }}>{s.totalDates}</td>
              <td style={{ textAlign: 'right' }}>{s.totalPicks}</td>
              <td style={{ textAlign: 'right' }}>{s.evaluatedPicks}</td>
              <td style={{ textAlign: 'right', color: hitRateColor(s.hitRate5d) }}>
                {s.hitRate5d !== null ? `${s.hitRate5d}%` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: hitRateColor(s.hitRate10d) }}>
                {s.hitRate10d !== null ? `${s.hitRate10d}%` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: hitRateColor(s.hitRate21d) }}>
                {s.hitRate21d !== null ? `${s.hitRate21d}%` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: retColor(s.avgReturn5d) }}>
                {fmtPct(s.avgReturn5d)}
              </td>
              <td style={{ textAlign: 'right', color: retColor(s.avgReturn10d) }}>
                {fmtPct(s.avgReturn10d)}
              </td>
              <td style={{ textAlign: 'right', color: retColor(s.avgReturn21d) }}>
                {fmtPct(s.avgReturn21d)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PicksTable({ picks }: { picks: ReplayPickRow[] }) {
  if (picks.length === 0) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No picks yet.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Date</th>
            <th style={{ textAlign: 'left' }}>Strategy</th>
            <th style={{ textAlign: 'left' }}>Ticker</th>
            <th>Rank</th>
            <th>Score</th>
            <th>Entry</th>
            <th>5d</th>
            <th>10d</th>
            <th>21d</th>
            <th>Drawdown</th>
          </tr>
        </thead>
        <tbody>
          {picks.map((p, i) => (
            <tr key={i}>
              <td>{p.asOfDate}</td>
              <td style={{ textTransform: 'capitalize' }}>{p.strategy}</td>
              <td style={{ fontWeight: 600 }}>{p.ticker}</td>
              <td style={{ textAlign: 'right' }}>{p.rank}</td>
              <td style={{ textAlign: 'right' }}>{fmtScore(p.compositeScore)}</td>
              <td style={{ textAlign: 'right' }}>
                {p.entryPrice !== null ? `$${p.entryPrice.toFixed(2)}` : '—'}
              </td>
              <td style={{ textAlign: 'right', color: retColor(p.ret5d) }}>{fmtPct(p.ret5d)}</td>
              <td style={{ textAlign: 'right', color: retColor(p.ret10d) }}>{fmtPct(p.ret10d)}</td>
              <td style={{ textAlign: 'right', color: retColor(p.ret21d) }}>{fmtPct(p.ret21d)}</td>
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

export default function BriefReplayView() {
  const today = new Date().toISOString().slice(0, 10);
  const oneMonthAgo = (() => {
    const d = new Date(today + 'T12:00:00Z');
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const [fromDate, setFromDate] = useState(oneMonthAgo);
  const [toDate, setToDate]     = useState(today);
  const [runState, setRunState] = useState<RunState>({
    running: false, phase: 'done', current: 0, total: 0, message: '',
  });
  const [summaries,        setSummaries]        = useState<ReplaySummary[]>([]);
  const [picks,            setPicks]            = useState<ReplayPickRow[]>([]);
  const [filterStrategy,   setFilterStrategy]   = useState<Strategy | ''>('');
  const [existingRange,    setExistingRange]     = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [error,            setError]             = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);

  const loadData = useCallback(async () => {
    const [sums, pickRows, range] = await Promise.all([
      window.api.briefReplay.getSummaries(),
      window.api.briefReplay.getPicks(filterStrategy || undefined, 1000),
      window.api.briefReplay.getDateRange(),
    ]);
    setSummaries(sums);
    setPicks(pickRows);
    setExistingRange(range);
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

  // Cleanup subscription on unmount
  useEffect(() => () => { if (unsubRef.current) unsubRef.current(); }, []);

  const progressPct = runState.total > 0 ? Math.round((runState.current / runState.total) * 100) : 0;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ marginBottom: 4, fontSize: 18, fontWeight: 700 }}>Brief Replay</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 0, marginBottom: 20 }}>
        Back-test the scoring pipeline against historical dates. Clears existing replay data on each run.
      </p>

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
    </div>
  );
}
