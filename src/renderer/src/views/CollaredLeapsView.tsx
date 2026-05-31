// Collared LEAPS Strategy Screener — main view
// Position = long deep-ITM LEAPS call + long OTM protective put on same underlying.
// The put is insurance on the LEAPS; its parameters derive from the LEAPS chosen.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  CollaredLeapsRunResult,
  CollaredLeapsRunSummary,
  CollaredLeapsOpportunity,
  CollaredLeapsGrade,
  CollaredLeapsGate,
  CollaredLeapsProgressDetail,
  CollaredLeapsScoreComponent,
  CollaredLeapsPnlPoint,
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

function GradeBadge({ grade }: { grade: CollaredLeapsGrade }) {
  const colors: Record<CollaredLeapsGrade, string> = {
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

function GateBadge({ gate }: { gate: CollaredLeapsGate }) {
  const map: Record<CollaredLeapsGate, { bg: string; label: string }> = {
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

// ─── Gate-survived pill ────────────────────────────────────────────────────────

function GatePill({ survived }: { survived: boolean }) {
  if (!survived) return null;
  return (
    <span style={{
      fontSize: 10, padding: '1px 5px', borderRadius: 3,
      background: 'rgba(34,197,94,0.18)', color: '#4ade80', fontWeight: 600,
    }}>
      GATE✓
    </span>
  );
}

// ─── Score breakdown table ────────────────────────────────────────────────────

function ScoreBreakdown({ label, components, subScore }: {
  label: string;
  components: CollaredLeapsScoreComponent[];
  subScore: number;
}) {
  return (
    <div style={{ minWidth: 200 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
        {label}
      </div>
      {components.map(c => (
        <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 2 }}>
          <span style={{ color: 'var(--text-muted)' }}>{c.name} ({Math.round(c.weight * 100)}%)</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {c.rawScore.toFixed(0)}/10 → <strong>{c.weightedScore.toFixed(2)}</strong>
          </span>
        </div>
      ))}
      <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
        Sub-score: <ScoreChip score={subScore} />
      </div>
    </div>
  );
}

// ─── P&L grid table ───────────────────────────────────────────────────────────

function PnlTable({
  grid,
  spot,
  label,
}: {
  grid: CollaredLeapsPnlPoint[];
  spot: number;
  label: string;
}) {
  // Show a sample of rows (every ~10th) plus the spot row
  const step = Math.max(1, Math.floor(grid.length / 12));
  const shown = grid.filter((_, i) => i % step === 0 || Math.abs(grid[i]!.price - spot) < spot * 0.01);
  const dedup = shown.filter((pt, i, arr) => i === 0 || pt.price !== arr[i - 1]!.price);
  return (
    <div style={{ minWidth: 240 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
        {label}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            <th style={ptHead}>Price</th>
            <th style={{ ...ptHead, textAlign: 'right' }}>Collar P&L</th>
            <th style={{ ...ptHead, textAlign: 'right' }}>Naked P&L</th>
          </tr>
        </thead>
        <tbody>
          {dedup.map(pt => {
            const atSpot = Math.abs(pt.price - spot) < spot * 0.01;
            return (
              <tr key={pt.price} style={{ background: atSpot ? 'rgba(99,102,241,0.12)' : undefined }}>
                <td style={ptCell}>{fmt$(pt.price)}{atSpot ? ' ←' : ''}</td>
                <td style={{ ...ptCell, textAlign: 'right', color: pt.collarPnl >= 0 ? '#4ade80' : '#f87171' }}>
                  {fmt$(pt.collarPnl)}
                </td>
                <td style={{ ...ptCell, textAlign: 'right', color: pt.nakedPnl >= 0 ? '#4ade80' : '#f87171' }}>
                  {fmt$(pt.nakedPnl)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ptHead: React.CSSProperties = {
  textAlign: 'left',
  padding: '2px 4px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  borderBottom: '1px solid var(--border)',
};
const ptCell: React.CSSProperties = {
  padding: '2px 4px',
  fontVariantNumeric: 'tabular-nums',
};

// ─── Opportunity detail panel ─────────────────────────────────────────────────

function OpportunityDetail({
  opp,
  onMarkOpened,
}: {
  opp: CollaredLeapsOpportunity;
  onMarkOpened: (id: number) => void;
}) {
  const totalDebit = opp.leapsDebit + opp.putDebit;
  return (
    <div style={{
      padding: '14px 16px',
      background: 'rgba(0,0,0,0.28)',
      borderLeft: '3px solid var(--accent)',
    }}>

      {/* ── Structural metrics bar ─────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 24, flexWrap: 'wrap',
        padding: '8px 12px', marginBottom: 14,
        background: 'rgba(255,255,255,0.04)', borderRadius: 6, fontSize: 12,
      }}>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Total Debit</span>
          <div style={{ fontWeight: 700 }}>{fmt$(totalDebit / 100)}<span style={{ fontSize: 10, color: 'var(--text-muted)' }}>/contract</span></div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Breakeven</span>
          <div style={{ fontWeight: 700 }}>{fmt$(opp.breakeven)}</div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Cost Drag</span>
          <div style={{ fontWeight: 700 }}>{fmtPct(opp.costDragPct)}</div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Floor Depth</span>
          <div style={{ fontWeight: 700 }}>{fmtPct(opp.floorDepthPct)}</div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Max Loss @ Put</span>
          <div style={{ fontWeight: 700, color: '#f87171' }}>{fmt$(opp.maxLossAtPut != null ? opp.maxLossAtPut / 100 : null)}</div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Max Loss @ 0</span>
          <div style={{ fontWeight: 700, color: opp.maxLossAtZero < 0 ? '#4ade80' : '#f87171' }}>
            {fmt$(opp.maxLossAtZero / 100)}
            {opp.maxLossAtZero < 0 && <span style={{ fontSize: 10, marginLeft: 4, color: '#4ade80' }}>fully hedged</span>}
          </div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Upside Retention</span>
          <div style={{ fontWeight: 700 }}>{fmtPct(opp.upsideRetentionPct)}</div>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Hedge Efficiency</span>
          <div style={{ fontWeight: 700 }}>{fmtPct(opp.hedgeEfficiencyPct)}</div>
        </div>
        {opp.rrRatio != null && (
          <div>
            <span style={{ color: 'var(--text-muted)' }}>R/R</span>
            <div style={{ fontWeight: 700 }}>{fmtNum(opp.rrRatio, 2)}</div>
          </div>
        )}
        {opp.ma200d != null && (
          <div>
            <span style={{ color: 'var(--text-muted)' }}>200d SMA</span>
            <div style={{ fontWeight: 700 }}>{fmt$(opp.ma200d)}</div>
          </div>
        )}
      </div>

      {/* ── Score breakdowns + P&L grid ────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>

        {/* LEAPS leg breakdown */}
        <ScoreBreakdown
          label={`LEAPS Leg — ${opp.ticker} ${fmt$(opp.leapsStrike)} ${opp.leapsExpiry}`}
          components={opp.detail.leapsScoreBreakdown}
          subScore={opp.leapsSubScore}
        />

        {/* LEAPS leg details */}
        <div style={{ minWidth: 180, fontSize: 11, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
            LEAPS Details
          </div>
          <div>Debit: <strong style={{ color: 'var(--text)' }}>{fmt$(opp.leapsDebit / 100)}/contract</strong></div>
          <div>Delta: {fmtNum(opp.leapsDelta)}</div>
          <div>IV: {fmtPct(opp.leapsIvPct)} | IVR: {fmtNum(opp.leapsIvr, 0)}</div>
          <div>DTE: {opp.leapsDte ?? '—'} | OI: {opp.leapsOi?.toLocaleString() ?? '—'}</div>
          <div>Extrinsic: {fmtPct(opp.leapsExtrinsicPct)} | Spread: {fmtPct(opp.leapsSpreadPct)}</div>
        </div>

        {/* Put leg breakdown */}
        <ScoreBreakdown
          label={`Put Leg — ${opp.ticker} ${fmt$(opp.putStrike)} ${opp.putExpiry}`}
          components={opp.detail.putScoreBreakdown}
          subScore={opp.putSubScore}
        />

        {/* Put leg details */}
        <div style={{ minWidth: 180, fontSize: 11, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--text-muted)' }}>
            Put Details
          </div>
          <div>Debit: <strong style={{ color: 'var(--text)' }}>{fmt$(opp.putDebit / 100)}/contract</strong></div>
          <div>Delta: {fmtNum(opp.putDelta)} (put)</div>
          <div>IV: {fmtPct(opp.putIvPct)} | IVR: {fmtNum(opp.putIvr, 0)}</div>
          <div>DTE: {opp.putDte ?? '—'} | OI: {opp.putOi?.toLocaleString() ?? '—'}</div>
          <div>Spread: {fmtPct(opp.putSpreadPct)}</div>
        </div>

        {/* Structural score breakdown */}
        <ScoreBreakdown
          label="Structural Quality"
          components={opp.detail.structuralScoreBreakdown}
          subScore={opp.structuralSubScore}
        />

        {/* P&L grid at expiry */}
        {opp.detail.pnlGrid.length > 0 && (
          <PnlTable grid={opp.detail.pnlGrid} spot={opp.spot} label="P&L at LEAPS Expiry" />
        )}

        {/* P&L grid at 180d */}
        {opp.detail.pnlGrid180d && opp.detail.pnlGrid180d.length > 0 && (
          <PnlTable grid={opp.detail.pnlGrid180d} spot={opp.spot} label="P&L at 180 Days" />
        )}
      </div>

      {/* ── Caution flags ──────────────────────────────────────────────── */}
      {opp.cautionFlags.length > 0 && (
        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(249,115,22,0.08)', borderRadius: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#f97316' }}>
            ⚑ Caution Flags
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {opp.cautionFlags.map(f => (
              <span key={f} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4,
                background: 'rgba(249,115,22,0.15)', color: '#f97316',
              }}>
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Exit rules ─────────────────────────────────────────────────── */}
      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        <strong style={{ color: 'var(--text)' }}>Exit rules:</strong>
        {' '}Take profit if LEAPS gains &gt;50% of debit.
        {' '}Roll the put if the stock closes within 5% of the put strike.
        {' '}Close entire collar if stock breaks below put strike on closing basis.
      </div>

      {/* ── Mark as opened ─────────────────────────────────────────────── */}
      <div style={{ marginTop: 12 }}>
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

type SortableCol = keyof CollaredLeapsOpportunity | 'rank';

function SortHeader({ label, col, sortCol, sortDir, onSort, align }: {
  label: string;
  col: SortableCol;
  sortCol: SortableCol;
  sortDir: 'asc' | 'desc';
  onSort: (col: SortableCol) => void;
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

// ─── Opportunity row ──────────────────────────────────────────────────────────

function OpportunityRow({
  opp,
  isExpanded,
  onToggle,
  onMarkOpened,
}: {
  opp: CollaredLeapsOpportunity;
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

        {/* Underlying */}
        <td>
          <div style={{ fontWeight: 700, letterSpacing: 0.5 }}>{opp.ticker}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmt$(opp.spot)}</div>
        </td>

        {/* LEAPS leg */}
        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
          <div>{fmt$(opp.leapsStrike)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opp.leapsExpiry}</div>
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtNum(opp.leapsDelta, 2)}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmt$(opp.leapsDebit / 100)}
        </td>
        <td style={{ textAlign: 'center' }}>
          <ScoreChip score={opp.leapsSubScore} />
        </td>

        {/* Put leg */}
        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
          <div>{fmt$(opp.putStrike)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opp.putExpiry}</div>
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmt$(opp.putDebit / 100)}
        </td>
        <td style={{ textAlign: 'center' }}>
          <ScoreChip score={opp.putSubScore} />
        </td>

        {/* Structural */}
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtPct(opp.costDragPct)}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtPct(opp.floorDepthPct)}
        </td>
        <td style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
          {fmtPct(opp.upsideRetentionPct)}
        </td>

        {/* Combined */}
        <td style={{ textAlign: 'center' }}>
          <ScoreChip score={opp.combinedScore} />
        </td>
        <td style={{ textAlign: 'center' }}>
          <GradeBadge grade={opp.grade} />
        </td>
        <td style={{ textAlign: 'center' }}>
          {opp.gateSurvived && <GatePill survived={opp.gateSurvived} />}
        </td>
        <td style={{ textAlign: 'center', fontSize: 11, color: '#f97316' }}>
          {opp.cautionFlags.length > 0 ? `⚑ ${opp.cautionFlags.length}` : ''}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={16} style={{ padding: 0 }}>
            <OpportunityDetail opp={opp} onMarkOpened={onMarkOpened} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Grade filter ─────────────────────────────────────────────────────────────

const ALL_GRADES: CollaredLeapsGrade[] = ['A+', 'A', 'B', 'C', 'F'];
const DEFAULT_GRADES = new Set<CollaredLeapsGrade>(['A+', 'A', 'B']);

// ─── Phase labels ─────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<CollaredLeapsProgressDetail['phase'], string> = {
  gate: 'Checking market gate',
  universe: 'Loading universe',
  leaps: 'Screening LEAPS candidates',
  puts: 'Selecting put legs',
  structural: 'Computing structural metrics',
  persist: 'Persisting results',
};

// ─── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ detail }: { detail: CollaredLeapsProgressDetail }) {
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
      <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`, borderRadius: 3,
          background: 'var(--accent)', transition: 'width 0.15s ease',
        }} />
      </div>
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function CollaredLeapsView() {
  const [source, setSource] = useState<'universe' | 'watchlist'>('universe');
  const [universe, setUniverse] = useState<'sp500' | 'russell1000' | 'both' | 'etf'>('sp500');
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [progressDetail, setProgressDetail] = useState<CollaredLeapsProgressDetail | null>(null);
  const [result, setResult] = useState<CollaredLeapsRunResult | null>(null);
  const [recentRuns, setRecentRuns] = useState<CollaredLeapsRunSummary[]>([]);
  const [selectedGrades, setSelectedGrades] = useState<Set<CollaredLeapsGrade>>(new Set(DEFAULT_GRADES));
  const [gateSurvivedOnly, setGateSurvivedOnly] = useState(false);
  const [sortCol, setSortCol] = useState<SortableCol>('combinedScore');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const unsubDetailRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.api.collaredLeaps.getRuns().then(setRecentRuns).catch(() => {});
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

    unsubRef.current?.();
    unsubDetailRef.current?.();
    unsubRef.current = window.api.collaredLeaps.onProgress(msg => {
      setProgressLog(prev => [...prev, msg]);
    });
    unsubDetailRef.current = window.api.collaredLeaps.onProgressDetail(detail => {
      setProgressDetail(detail);
    });

    try {
      const watchlistId = source === 'watchlist' ? selectedWatchlistId : null;
      const r = await window.api.collaredLeaps.runScreen(universe, forceRun, watchlistId);
      setResult(r);
      setRecentRuns(prev => [r.run, ...prev].slice(0, 20));
      // Collars survive FAIL gate — widen grade filter for CAUTION
      if (r.run.marketGate === 'CAUTION') {
        setSelectedGrades(new Set(ALL_GRADES));
      }
      // For FAIL gate, show gate-survived filter automatically
      if (r.run.marketGate === 'FAIL') {
        setGateSurvivedOnly(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
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
      const r = await window.api.collaredLeaps.getRun(runId);
      if (r) {
        setResult(r);
        setExpandedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const markOpened = useCallback(async (id: number) => {
    try {
      await window.api.collaredLeaps.markOpened(id, {});
      setExpandedId(null);
    } catch { /* ignore */ }
  }, []);

  const deleteRun = useCallback(async (runId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await window.api.collaredLeaps.deleteRun(runId);
      setRecentRuns(prev => prev.filter(r => r.id !== runId));
      if (result?.run.id === runId) setResult(null);
    } catch { /* ignore */ }
  }, [result]);

  const toggleGrade = (g: CollaredLeapsGrade) => {
    setSelectedGrades(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const toggleSort = (col: SortableCol) => {
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
    .filter(o => !gateSurvivedOnly || o.gateSurvived)
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
        <span style={{ fontWeight: 700, fontSize: 15, marginRight: 4 }}>Collared LEAPS</span>

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
              <option value="etf">ETFs</option>
            </select>
            {universe === 'etf' && (
              <div style={{ fontSize: 10, color: '#c8a000', maxWidth: 260 }}>
                📋 ETF mode — market cap filter skipped; scoring is fully options/price-based (no fundamental dependencies). Run Data Sync → ETFs first.
              </div>
            )}
          </div>
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

        {/* Market gate — collared LEAPS always runs, never suppressed */}
        {run && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Market Gate:</span>
            <GateBadge gate={run.marketGate} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{run.gateEffect}</span>
            {run.marketGate === 'FAIL' && (
              <span style={{ fontSize: 11, color: '#4ade80', fontStyle: 'italic' }}>
                (collars run regardless — defined-risk strategy)
              </span>
            )}
          </div>
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
      {isRunning && progressDetail && <ProgressBar detail={progressDetail} />}
      {isRunning && !progressDetail && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--accent)' }}>
          Starting…
        </div>
      )}

      {/* ── Progress log (collapsible) ─────────────────────────────────────── */}
      {(isRunning || progressLog.length > 0) && (
        <details style={{ borderBottom: '1px solid var(--border)' }}>
          <summary style={{ padding: '4px 16px', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>
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

          {/* Gate-survived filter — most useful during FAIL gate */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={gateSurvivedOnly}
              onChange={e => setGateSurvivedOnly(e.target.checked)}
            />
            <span style={{ color: '#4ade80' }}>Gate-survived only</span>
          </label>

          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
            {filtered.length} of {opportunities.length} shown
          </span>
        </div>
      )}

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto' }}>

        {/* Empty state with run history */}
        {!result && !isRunning && (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🛡️</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Collared LEAPS Screener</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 520, margin: '0 auto 16px' }}>
              Finds deep-ITM LEAPS calls paired with OTM protective puts on the same underlying.
              The put leg limits downside; the collar runs even in FAIL market conditions by design.
            </div>
            <button className="btn btn-primary" onClick={() => runScreen()}>Run Screen</button>
            {recentRuns.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Recent runs:</div>
                {recentRuns.slice(0, 10).map(r => (
                  <div key={r.id} style={{
                    display: 'inline-flex', alignItems: 'center',
                    marginRight: 8, marginBottom: 6,
                    border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden',
                  }}>
                    <button
                      className="btn btn-sm"
                      style={{ border: 'none', borderRadius: 0 }}
                      onClick={() => loadRun(r.id)}
                    >
                      {r.runAt.slice(0, 16).replace('T', ' ')} — {r.opportunityCount} opps
                      {r.watchlistId ? ' (WL)' : ''} <GateBadge gate={r.marketGate} />
                    </button>
                    <button
                      title="Delete this run"
                      style={{
                        padding: '2px 6px', border: 'none',
                        borderLeft: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--text-muted)',
                        cursor: 'pointer', fontSize: 11,
                      }}
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

        {/* No results after filter */}
        {result && filtered.length === 0 && !isRunning && (
          <div className="empty-state" style={{ margin: 24 }}>
            No opportunities match the selected filters.
            {(selectedGrades.size < ALL_GRADES.length || gateSurvivedOnly) && (
              <button
                className="btn btn-sm"
                style={{ marginLeft: 8 }}
                onClick={() => { setSelectedGrades(new Set(ALL_GRADES)); setGateSurvivedOnly(false); }}
              >
                Clear Filters
              </button>
            )}
          </div>
        )}

        {/* Results table */}
        {filtered.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
                <SortHeader label="#" col="rank" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Ticker" col="ticker" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="LEAPS Strike" col="leapsStrike" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Δ" col="leapsDelta" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="LEAPS Debit" col="leapsDebit" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="L-Score" col="leapsSubScore" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Put Strike" col="putStrike" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="Put Debit" col="putDebit" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="P-Score" col="putSubScore" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Drag%" col="costDragPct" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="Floor%" col="floorDepthPct" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="Upside%" col="upsideRetentionPct" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="right" />
                <SortHeader label="Score" col="combinedScore" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <SortHeader label="Grade" col="grade" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} align="center" />
                <th style={{ ...thStyle, textAlign: 'center' }}>Gate</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>⚑</th>
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
