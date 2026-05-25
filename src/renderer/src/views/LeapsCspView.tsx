import React, { useState, useEffect, useCallback, useRef } from 'react';
import type {
  LeapsCspRunResult,
  LeapsCspRunSummary,
  LeapsCspOpportunity,
  LeapsCspGrade,
  LeapsCspGate,
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

// ─── Grade filter ─────────────────────────────────────────────────────────────

const ALL_GRADES: LeapsCspGrade[] = ['A+', 'A', 'B', 'C', 'F'];
const DEFAULT_GRADES = new Set<LeapsCspGrade>(['A+', 'A', 'B']);

// ─── Main View ────────────────────────────────────────────────────────────────

export function LeapsCspView() {
  const [universe, setUniverse] = useState<'sp500' | 'russell1000' | 'both'>('sp500');
  const [isRunning, setIsRunning] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [result, setResult] = useState<LeapsCspRunResult | null>(null);
  const [recentRuns, setRecentRuns] = useState<LeapsCspRunSummary[]>([]);
  const [selectedGrades, setSelectedGrades] = useState<Set<LeapsCspGrade>>(new Set(DEFAULT_GRADES));
  const [sortField, setSortField] = useState<'combinedScore' | 'leapsSubScore' | 'cspSubScore' | 'cspAnnReturnPct'>('combinedScore');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.api.leapsCsp.getRuns().then(setRecentRuns).catch(() => {});
    return () => { unsubRef.current?.(); };
  }, []);

  useEffect(() => {
    if (progressRef.current) {
      progressRef.current.scrollTop = progressRef.current.scrollHeight;
    }
  }, [progressLog]);

  const runScreen = useCallback(async () => {
    setIsRunning(true);
    setProgressLog([]);
    setError(null);
    setResult(null);

    unsubRef.current?.();
    unsubRef.current = window.api.leapsCsp.onProgress(msg => {
      setProgressLog(prev => [...prev, msg]);
    });

    try {
      const r = await window.api.leapsCsp.runScreen(universe);
      setResult(r);
      setRecentRuns(prev => [r.run, ...prev].slice(0, 20));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
      unsubRef.current?.();
      unsubRef.current = null;
    }
  }, [universe]);

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

  const toggleGrade = (g: LeapsCspGrade) => {
    setSelectedGrades(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const opportunities = result?.opportunities ?? [];
  const filtered = opportunities
    .filter(o => selectedGrades.has(o.grade))
    .sort((a, b) => {
      const av = a[sortField] ?? 0;
      const bv = b[sortField] ?? 0;
      return (bv as number) - (av as number);
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

        {/* Universe selector */}
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

        <button
          className="btn btn-primary btn-sm"
          onClick={runScreen}
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

      {/* ── Progress log ────────────────────────────────────────────────────── */}
      {(isRunning || progressLog.length > 0) && (
        <div
          ref={progressRef}
          style={{
            padding: '8px 16px',
            background: 'rgba(0,0,0,0.3)',
            maxHeight: 80,
            overflowY: 'auto',
            fontSize: 11,
            color: 'var(--text-muted)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {progressLog.map((m, i) => <div key={i}>{m}</div>)}
          {isRunning && <div style={{ color: 'var(--accent)' }}>Running…</div>}
        </div>
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

          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>Sort:</span>
          <select
            value={sortField}
            onChange={e => setSortField(e.target.value as typeof sortField)}
            className="form-select form-select-sm"
            style={{ width: 160 }}
          >
            <option value="combinedScore">Combined Score</option>
            <option value="leapsSubScore">LEAPS Score</option>
            <option value="cspSubScore">CSP Score</option>
            <option value="cspAnnReturnPct">CSP Ann. Return</option>
          </select>

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
            <button className="btn btn-primary" onClick={runScreen}>Run Screen</button>
            {recentRuns.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Recent runs:</div>
                {recentRuns.slice(0, 5).map(r => (
                  <button
                    key={r.id}
                    className="btn btn-sm"
                    style={{ marginRight: 8, marginBottom: 4 }}
                    onClick={() => loadRun(r.id)}
                  >
                    {r.runAt.slice(0, 16).replace('T', ' ')} — {r.opportunityCount} opps <GateBadge gate={r.marketGate} />
                  </button>
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
                <th style={thStyle}>#</th>
                <th style={thStyle}>LEAPS Ticker</th>
                <th style={thStyle}>Strike / Expiry</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Delta</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Premium</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Ext%</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>L-Score</th>
                <th style={thStyle}>CSP Ticker</th>
                <th style={thStyle}>Strike / Expiry</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Ann%</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>C-Score</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Combined</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Grade</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Mode</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Cash</th>
                <th style={{ ...thStyle, textAlign: 'center' }}>Flags</th>
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
