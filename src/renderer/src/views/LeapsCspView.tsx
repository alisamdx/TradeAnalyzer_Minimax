import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  LeapsCspRunResult,
  LeapsCspRunSummary,
  LeapsCspOpportunity,
  LeapsCspGrade,
  LeapsCspGate,
  LeapsCspProgressDetail,
  Watchlist,
} from '@shared/types.js';

// ─── Formatting helpers ───────────────────────────────────────────────────────

const fmt$ = (v: number | null | undefined) =>
  v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtPct = (v: number | null | undefined, decimals = 1) =>
  v == null ? '—' : `${v.toFixed(decimals)}%`;

const fmtNum = (v: number | null | undefined, decimals = 2) =>
  v == null ? '—' : v.toFixed(decimals);

const fmtK = (v: number | null | undefined) => {
  if (v == null) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return fmt$(v);
};

// ─── Grade badge ─────────────────────────────────────────────────────────────

function GradeBadge({ grade }: { grade: LeapsCspGrade }) {
  const colors: Record<LeapsCspGrade, string> = {
    'A+': '#22c55e',
    'A':  '#4ade80',
    'B':  '#facc15',
    'C':  '#f97316',
    'F':  '#ef4444',
  };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 7px',
      borderRadius: 4,
      fontWeight: 700,
      fontSize: 12,
      color: '#000',
      background: colors[grade] ?? '#888',
    }}>
      {grade}
    </span>
  );
}

// ─── Market gate badge ────────────────────────────────────────────────────────

function GateBadge({ gate }: { gate: LeapsCspGate }) {
  const map: Record<LeapsCspGate, { bg: string; label: string }> = {
    PASS:    { bg: '#22c55e', label: 'PASS' },
    CAUTION: { bg: '#facc15', label: 'CAUTION' },
    FAIL:    { bg: '#ef4444', label: 'FAIL' },
  };
  const { bg, label } = map[gate];
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 4,
      fontWeight: 700,
      fontSize: 12,
      color: '#000',
      background: bg,
    }}>
      {label}
    </span>
  );
}

// ─── Score chip ───────────────────────────────────────────────────────────────

function ScoreChip({ score }: { score: number }) {
  const color = score >= 8 ? '#22c55e' : score >= 7 ? '#facc15' : score >= 6 ? '#f97316' : '#ef4444';
  return (
    <span style={{ fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
      {score.toFixed(1)}
    </span>
  );
}

// ─── Pairing mode pill ────────────────────────────────────────────────────────

function PairingPill({ mode }: { mode: string }) {
  const label = mode === 'same_ticker' ? 'Same' : mode === 'different_ticker' ? 'Cross' : 'LEAPS Only';
  const bg = mode === 'same_ticker' ? 'rgba(99,102,241,0.2)' : mode === 'different_ticker' ? 'rgba(20,184,166,0.2)' : 'rgba(239,68,68,0.15)';
  const color = mode === 'same_ticker' ? '#818cf8' : mode === 'different_ticker' ? '#2dd4bf' : '#f87171';
  return (
    <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: bg, color, fontWeight: 600 }}>
      {label}
    </span>
  );
}

// ─── Opportunity row ──────────────────────────────────────────────────────────

function OpportunityRow({
  opp,
  isExpanded,
  onToggle,
  onMarkOpened,
}: {
  opp: LeapsCspOpportunity;
  isExpanded: boolean;
  onToggle: () => void;
  onMarkOpened: (id: number) => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: 'pointer', background: isExpanded ? 'rgba(255,255,255,0.04)' : undefined }}
        className="hover-row"
      >
        {/* Rank */}
        <td style={{ color: 'var(--text-muted)', textAlign: 'center', width: 36 }}>{opp.rank}</td>

        {/* LEAPS leg */}
        <td>
          <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>{opp.leapsTicker}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {fmt$(opp.leapsCurrentPrice)}
          </div>
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
          <div>{fmt$(opp.leapsStrike)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opp.leapsExpiry}</div>
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtNum(opp.leapsDelta, 2)}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtK(opp.leapsPremium)}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', fontSize: 12 }}>
          {fmtPct(opp.leapsExtrinsicPct)}
        </td>
        <td style={{ textAlign: 'center' }}>
          <ScoreChip score={opp.leapsSubScore} />
        </td>

        {/* CSP leg */}
        <td>
          {opp.cspTicker ? (
            <>
              <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>{opp.cspTicker}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmt$(opp.cspCurrentPrice)}
              </div>
            </>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>None</span>
          )}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
          {opp.cspStrike ? (
            <>
              <div>{fmt$(opp.cspStrike)}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opp.cspExpiry}</div>
            </>
          ) : '—'}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', fontSize: 12 }}>
          {fmtPct(opp.cspAnnReturnPct)}
        </td>
        <td style={{ textAlign: 'center' }}>
          {opp.cspSubScore != null ? <ScoreChip score={opp.cspSubScore} /> : '—'}
        </td>

        {/* Combined */}
        <td style={{ textAlign: 'center' }}>
          <ScoreChip score={opp.combinedScore} />
        </td>
        <td style={{ textAlign: 'center' }}>
          <GradeBadge grade={opp.grade} />
        </td>
        <td style={{ textAlign: 'center' }}>
          <PairingPill mode={opp.pairingMode} />
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', fontSize: 12 }}>
          {fmtK(opp.totalCashToDeploy)}
        </td>
        <td style={{ textAlign: 'center', fontSize: 11, color: '#f97316' }}>
          {opp.cautionFlags.length > 0 ? `⚑ ${opp.cautionFlags.length}` : ''}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={17} style={{ padding: 0 }}>
            <OpportunityDetail opp={opp} onMarkOpened={onMarkOpened} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Opportunity detail panel ─────────────────────────────────────────────────

function OpportunityDetail({
  opp,
  onMarkOpened,
}: {
  opp: LeapsCspOpportunity;
  onMarkOpened: (id: number) => void;
}) {
  return (
    <div style={{
      padding: '12px 16px',
      background: 'rgba(0,0,0,0.25)',
      borderLeft: '3px solid var(--accent)',
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
    }}>
      {/* LEAPS scoring breakdown */}
      <div style={{ minWidth: 220 }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
          LEAPS Leg Breakdown ({opp.leapsTicker})
        </div>
        {opp.detail.leapsScoreBreakdown.map(c => (
          <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
            <span style={{ color: 'var(--text-muted)' }}>{c.name} ({Math.round(c.weight * 100)}%)</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {c.rawScore.toFixed(0)}/10 → <strong>{c.weightedScore.toFixed(2)}</strong>
            </span>
          </div>
        ))}
        <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700 }}>
          Sub-score: <ScoreChip score={opp.leapsSubScore} />
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <div>Strike: {fmt$(opp.leapsStrike)} | Delta: {fmtNum(opp.leapsDelta)}</div>
          <div>Extrinsic: {fmtPct(opp.leapsExtrinsicPct)} | IVR: {fmtNum(opp.leapsIvr, 0)}</div>
          <div>DTE: {opp.leapsDte} | OI: {opp.leapsOi?.toLocaleString() ?? '—'}</div>
        </div>
      </div>

      {/* CSP scoring breakdown */}
      {opp.cspTicker && (
        <div style={{ minWidth: 220 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
            CSP Leg Breakdown ({opp.cspTicker})
          </div>
          {opp.detail.cspScoreBreakdown.map(c => (
            <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
              <span style={{ color: 'var(--text-muted)' }}>{c.name} ({Math.round(c.weight * 100)}%)</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {c.rawScore.toFixed(0)}/10 → <strong>{c.weightedScore.toFixed(2)}</strong>
              </span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700 }}>
            Sub-score: {opp.cspSubScore != null ? <ScoreChip score={opp.cspSubScore} /> : '—'}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            <div>Strike: {fmt$(opp.cspStrike)} | Delta: {fmtNum(opp.cspDelta)}</div>
            <div>Ann. Return: {fmtPct(opp.cspAnnReturnPct)} | IVR: {fmtNum(opp.cspIvr, 0)}</div>
            <div>DTE: {opp.cspDte} | Collateral: {fmtK(opp.cspCollateral)}</div>
          </div>
        </div>
      )}

      {/* Caution flags */}
      {opp.cautionFlags.length > 0 && (
        <div style={{ minWidth: 180 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: '#f97316' }}>
            ⚑ Caution Flags
          </div>
          {opp.cautionFlags.map(f => (
            <div key={f} style={{ fontSize: 11, color: '#f97316', marginBottom: 2 }}>• {f}</div>
          ))}
        </div>
      )}

      {/* Alternatives */}
      {opp.detail.alternatives.length > 0 && (
        <div style={{ minWidth: 240 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
            Alternative CSP Pairings
          </div>
          {opp.detail.alternatives.map((alt, i) => (
            <div key={i} style={{
              fontSize: 11, padding: '4px 8px', marginBottom: 4,
              background: 'rgba(255,255,255,0.04)', borderRadius: 4,
            }}>
              <strong>{alt.cspTicker}</strong> {fmt$(alt.cspStrike)} {alt.cspExpiry}
              <span style={{ marginLeft: 8 }}>Ann: {fmtPct(alt.cspAnnReturnPct)}</span>
              <span style={{ marginLeft: 8 }}>Score: <ScoreChip score={alt.combinedScore} /></span>
              <GradeBadge grade={alt.grade} />
            </div>
          ))}
        </div>
      )}

      {/* Mark as opened */}
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
        <button
          className="btn btn-sm btn-primary"
          style={{ fontSize: 12 }}
          onClick={e => { e.stopPropagation(); onMarkOpened(opp.id); }}
        >
          Mark as Opened
        </button>
      </div>
    </div>
  );
}

// ─── Sortable column header ────────────────────────────────────────────────────

function SortHeader({ label, col, sortCol, sortDir, onSort, align }: {
  label: string;
  col: keyof LeapsCspOpportunity | 'rank';
  sortCol: keyof LeapsCspOpportunity | 'rank';
  sortDir: 'asc' | 'desc';
  onSort: (col: keyof LeapsCspOpportunity | 'rank') => void;
  align?: 'left' | 'right' | 'center';
}) {
  const active = sortCol === col;
  const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      style={{
        ...thStyle,
        cursor: 'pointer',
        userSelect: 'none',
        textAlign: align ?? 'left',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        whiteSpace: 'nowrap',
      }}
      onClick={() => onSort(col)}
    >
      {label}{arrow}
    </th>
  );
}

// ─── Grade filter ─────────────────────────────────────────────────────────────

const ALL_GRADES: LeapsCspGrade[] = ['A+', 'A', 'B', 'C', 'F'];
const DEFAULT_GRADES = new Set<LeapsCspGrade>(['A+', 'A', 'B']);

// ─── Phase labels ─────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<LeapsCspProgressDetail['phase'], string> = {
  gate: 'Checking market gate',
  universe: 'Loading universe',
  leaps: 'Screening LEAPS',
  csp: 'Building CSP pool',
  pairing: 'Pairing opportunities',
};

// ─── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ detail }: { detail: LeapsCspProgressDetail }) {
  const pct = detail.total > 0 ? (detail.current / detail.total) * 100 : 0;
  return (
    <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {PHASE_LABELS[detail.phase]}
          {detail.ticker ? ` — ${detail.ticker}` : ''}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
          {detail.current} / {detail.total}
        </span>
      </div>
      <div style={{
        height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 3,
          background: 'var(--accent)', transition: 'width 0.15s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function LeapsCspView() {
  const [source, setSource] = useState<'universe' | 'watchlist'>('universe');
  const [universe, setUniverse] = useState<'sp500' | 'russell1000' | 'both'>('sp500');
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [progressDetail, setProgressDetail] = useState<LeapsCspProgressDetail | null>(null);
  const [result, setResult] = useState<LeapsCspRunResult | null>(null);
  const [recentRuns, setRecentRuns] = useState<LeapsCspRunSummary[]>([]);
  const [selectedGrades, setSelectedGrades] = useState<Set<LeapsCspGrade>>(new Set(DEFAULT_GRADES));
  const [sortCol, setSortCol] = useState<keyof LeapsCspOpportunity | 'rank'>('combinedScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wasForced, setWasForced] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const unsubDetailRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.api.leapsCsp.getRuns().then(setRecentRuns).catch(() => {});
    window.api.watchlists.list().then(wl => {
      setWatchlists(wl);
      if (wl.length > 0 && selectedWatchlistId === null) {
        setSelectedWatchlistId(wl[0]?.id ?? null);
      }
    }).catch(() => {});
    return () => { unsubRef.current?.(); unsubDetailRef.current?.(); };
  }, []);

  useEffect(() => {
    if (progressRef.current) {
      progressRef.current.scrollTop = progressRef.current.scrollHeight;
    }
  }, [progressLog]);

  const runScreen = useCallback(async (forceRun = false) => {
    setIsRunning(true);
    setProgressLog([]);
    setProgressDetail(null);
    setError(null);
    setResult(null);
    setWasForced(forceRun);

    unsubRef.current?.();
    unsubDetailRef.current?.();
    unsubRef.current = window.api.leapsCsp.onProgress(msg => {
      setProgressLog(prev => [...prev, msg]);
    });
    unsubDetailRef.current = window.api.leapsCsp.onProgressDetail(detail => {
      setProgressDetail(detail);
    });

    try {
      const watchlistId = source === 'watchlist' ? selectedWatchlistId : null;
      const r = await window.api.leapsCsp.runScreen(universe, forceRun, watchlistId);
      setResult(r);
      setRecentRuns(prev => [r.run, ...prev].slice(0, 20));
      // Under a gate override or CAUTION, widen the grade filter automatically
      if (forceRun || r.run.marketGate === 'CAUTION') {
        setSelectedGrades(new Set(ALL_GRADES));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      if (msg.includes('token_rejected') || msg.includes('oauth_problem') || msg.includes('auth failed')) {
        window.dispatchEvent(new CustomEvent('navigate-to-settings-etrade', {
          detail: { warning: 'E*Trade token rejected. The token may have expired or been revoked — please reconnect.' }
        }));
      }
    } finally {
      setIsRunning(false);
      setProgressDetail(null);
      unsubRef.current?.();
      unsubRef.current = null;
      unsubDetailRef.current?.();
      unsubDetailRef.current = null;
    }
  }, [universe, source, selectedWatchlistId]);

  const loadRun = useCallback(async (runId: number) => {
    try {
      const r = await window.api.leapsCsp.getRun(runId);
      if (r) setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const markOpened = useCallback(async (id: number) => {
    try {
      await window.api.leapsCsp.markOpened(id, {});
      setExpandedId(null);
    } catch { /* ignore */ }
  }, []);

  const deleteRun = useCallback(async (runId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.api.leapsCsp.deleteRun(runId);
      setRecentRuns(prev => prev.filter(r => r.id !== runId));
      if (result?.run.id === runId) setResult(null);
    } catch { /* ignore */ }
  }, [result]);

  const toggleGrade = (g: LeapsCspGrade) => {
    setSelectedGrades(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const toggleSort = (col: keyof LeapsCspOpportunity | 'rank') => {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('desc');
    }
  };

  const opportunities = result?.opportunities ?? [];
  const filtered = opportunities
    .filter(o => selectedGrades.has(o.grade))
    .sort((a, b) => {
      const av = sortCol === 'rank' ? a.rank : (a[sortCol] ?? 0);
      const bv = sortCol === 'rank' ? b.rank : (b[sortCol] ?? 0);
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? (av as number) - (bv as number)
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const run = result?.run;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <span style={{ fontWeight: 700, fontSize: 15, marginRight: 4 }}>LEAPS + CSP</span>

        {/* Source toggle: Universe vs Watchlist */}
        <div style={{ display: 'flex', gap: 0, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <button
            style={{
              borderRadius: 0, fontSize: 12, padding: '4px 12px', cursor: isRunning ? 'not-allowed' : 'pointer',
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
              borderRadius: 0, fontSize: 12, padding: '4px 12px', cursor: isRunning ? 'not-allowed' : 'pointer',
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
            onChange={e => setUniverse(e.target.value as typeof universe)}
            className="form-select form-select-sm"
            style={{ width: 140 }}
            disabled={isRunning}
        >
          <option value="sp500">S&P 500</option>
            <option value="russell1000">Russell 1000</option>
            <option value="both">Both</option>
          </select>
        ) : (
          <select
            value={selectedWatchlistId ?? ''}
            onChange={e => setSelectedWatchlistId(Number(e.target.value))}
            className="form-select form-select-sm"
            style={{ width: 180 }}
            disabled={isRunning}
          >
            {watchlists.length === 0 && <option value="">No watchlists</option>}
            {watchlists.map(wl => (
              <option key={wl.id} value={wl.id}>{wl.name} ({wl.itemCount} tickers)</option>
            ))}
          </select>
        )}

        <button
          className="btn btn-primary btn-sm"
          onClick={() => runScreen()}
          disabled={isRunning}
        >
          {isRunning ? 'Screening…' : 'Run Screen'}
        </button>

        {/* Market gate */}
        {run && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Market Gate:</span>
            <GateBadge gate={run.marketGate} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{run.gateEffect}</span>
            {run.marketGate === 'FAIL' && !isRunning && (
              <button
                className="btn btn-sm"
                style={{ fontSize: 11, borderColor: '#f97316', color: '#f97316' }}
                onClick={() => runScreen(true)}
              >
                Run Anyway
              </button>
            )}
          </div>
        )}

        {/* Run Anyway when no run yet and gate unknown */}
        {!run && !isRunning && (
          <button
            className="btn btn-sm"
            style={{ fontSize: 11, opacity: 0.6 }}
            title="Bypass market gate and screen regardless of conditions"
            onClick={() => runScreen(true)}
          >
            Run Anyway
          </button>
        )}

        {run && (
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)', textAlign: 'right' }}>
            <div>{run.opportunityCount} opportunities · {run.runAt.slice(0, 16).replace('T', ' ')}</div>
            {run.gateDetail.spx != null && (
              <div>SPX {run.gateDetail.spx.toFixed(0)} · VIX {run.gateDetail.vix?.toFixed(1) ?? '—'}</div>
            )}
          </div>
        )}
      </div>

      {/* ── Progress bar ────────────────────────────────────────────────────── */}
      {isRunning && progressDetail && (
        <ProgressBar detail={progressDetail} />
      )}
      {isRunning && !progressDetail && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--accent)' }}>
          Starting…
        </div>
      )}

      {/* ── Progress log (collapsible) ─────────────────────────────────────── */}
      {(isRunning || progressLog.length > 0) && (
        <details style={{ borderBottom: '1px solid var(--border)' }}>
          <summary style={{
            padding: '4px 16px', fontSize: 11, color: 'var(--text-muted)',
            cursor: 'pointer', userSelect: 'none',
          }}>
            Log ({progressLog.length} messages)
          </summary>
          <div
            ref={progressRef}
            style={{
              padding: '6px 16px',
              background: 'rgba(0,0,0,0.2)',
              maxHeight: 100,
              overflowY: 'auto',
              fontSize: 11,
              color: 'var(--text-muted)',
            }}
          >
            {progressLog.map((m, i) => <div key={i}>{m}</div>)}
          </div>
        </details>
      )}

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ padding: '8px 16px', background: 'rgba(239,68,68,0.1)', color: '#f87171', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* ── Gate override warning ───────────────────────────────────────────── */}
      {wasForced && result && result.run.marketGate === 'FAIL' && (
        <div style={{
          padding: '6px 16px',
          background: 'rgba(249,115,22,0.12)',
          borderBottom: '1px solid rgba(249,115,22,0.3)',
          fontSize: 12,
          color: '#f97316',
        }}>
          ⚠ Gate override active — results shown despite FAIL market conditions. Use with caution.
        </div>
      )}

      {/* ── Filter bar ──────────────────────────────────────────────────────── */}
      {result && (
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Grade:</span>
          {ALL_GRADES.map(g => (
            <button
              key={g}
              onClick={() => toggleGrade(g)}
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                border: selectedGrades.has(g) ? '1px solid transparent' : '1px solid var(--border)',
                background: selectedGrades.has(g)
                  ? (g === 'A+' ? '#22c55e' : g === 'A' ? '#4ade80' : g === 'B' ? '#facc15' : g === 'C' ? '#f97316' : '#ef4444')
                  : 'transparent',
                color: selectedGrades.has(g) ? '#000' : 'var(--text-muted)',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 12,
              }}
            >
              {g}
            </button>
          ))}


          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
            {filtered.length} of {opportunities.length} shown
          </span>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!result && !isRunning && (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>LEAPS + CSP Strategy Screener</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 480, margin: '0 auto 16px' }}>
              Finds deep-ITM LEAPS calls paired with independently selected cash-secured puts.
              Requires at least one screener run to populate the stock universe.
            </div>
            <button className="btn btn-primary" onClick={() => runScreen()}>Run Screen</button>
            <button
              className="btn btn-sm"
              style={{ marginLeft: 8, borderColor: '#f97316', color: '#f97316' }}
              title="Bypass market gate — run regardless of market conditions"
              onClick={() => runScreen(true)}
            >
              Run Anyway
            </button>
            {recentRuns.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Recent runs:</div>
                {recentRuns.slice(0, 10).map(r => (
                  <div key={r.id} style={{ display: 'inline-flex', alignItems: 'center', marginRight: 8, marginBottom: 6, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
                    <button
                      className="btn btn-sm"
                      style={{ border: 'none', borderRadius: 0 }}
                      onClick={() => loadRun(r.id)}
                    >
                      {r.runAt.slice(0, 16).replace('T', ' ')} — {r.opportunityCount} opps {r.watchlistId ? '(WL)' : ''} <GateBadge gate={r.marketGate} />
                    </button>
                    <button
                      title="Delete this run"
                      style={{ padding: '2px 6px', border: 'none', borderLeft: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
                      onClick={e => deleteRun(r.id, e)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {result && filtered.length === 0 && !isRunning && (
          <div className="empty-state" style={{ margin: 24 }}>
            No opportunities match the selected grade filters.
            {selectedGrades.size < ALL_GRADES.length && (
              <button
                className="btn btn-sm"
                style={{ marginLeft: 8 }}
                onClick={() => setSelectedGrades(new Set(ALL_GRADES))}
              >
                Show All Grades
              </button>
            )}
          </div>
        )}

        {filtered.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
                <SortHeader label="#" col="rank" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="LEAPS Ticker" col="leapsTicker" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Strike / Expiry" col="leapsStrike" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Delta" col="leapsDelta" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="Premium" col="leapsPremium" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="Ext%" col="leapsExtrinsicPct" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="L-Score" col="leapsSubScore" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="CSP Ticker" col="cspTicker" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Strike / Expiry" col="cspStrike" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Ann%" col="cspAnnReturnPct" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="C-Score" col="cspSubScore" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Combined" col="combinedScore" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Grade" col="grade" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Mode" col="pairingMode" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Cash" col="totalCashToDeploy" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="Flags" col="cautionFlags" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(opp => (
                <OpportunityRow
                  key={opp.id}
                  opp={opp}
                  isExpanded={expandedId === opp.id}
                  onToggle={() => setExpandedId(prev => prev === opp.id ? null : opp.id)}
                  onMarkOpened={markOpened}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};
