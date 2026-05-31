// ENH-2 Opportunity Dashboard
// Composite-scored ranked table of top setups for the day.
// Weights: fundamentals 25% | IV rank 30% | technical 25% | premium yield 20%
// see docs/formulas.md#opportunity-score

import { useState, useCallback, useEffect, useMemo } from 'react';
import type { OpportunityRow, OpportunityRunOptions, StrategyMode, OpportunityUniverse } from '@shared/types.js';

// ── Sub-components ──────────────────────────────────────────────────────────

function ScoreBar({ value, max = 100 }: { value: number | null; max?: number }) {
  if (value === null) return <span style={{ color: '#666', fontSize: 11 }}>—</span>;
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color = value >= 70 ? '#2ecc71' : value >= 45 ? '#f39c12' : '#e74c3c';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: 40, height: 6, borderRadius: 3, background: '#333',
        overflow: 'hidden', flexShrink: 0,
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color, minWidth: 24, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function IvBadge({ ivRank }: { ivRank: number | null }) {
  if (ivRank === null) return <span style={{ color: '#666' }}>—</span>;
  const color = ivRank >= 70 ? '#e74c3c' : ivRank >= 40 ? '#f39c12' : '#2ecc71';
  const label = ivRank >= 70 ? 'HIGH' : ivRank >= 40 ? 'MED' : 'LOW';
  return (
    <span style={{
      background: color + '22', color, border: `1px solid ${color}55`,
      borderRadius: 3, padding: '1px 5px', fontSize: 10, fontWeight: 700,
    }}>
      {label} {ivRank.toFixed(0)}
    </span>
  );
}

function CompositeScore({ score }: { score: number }) {
  const color = score >= 70 ? '#2ecc71' : score >= 50 ? '#f39c12' : '#e74c3c';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 36, height: 36, borderRadius: '50%',
      background: color + '22', border: `2px solid ${color}`,
      color, fontWeight: 700, fontSize: 14,
    }}>
      {score}
    </span>
  );
}

// ── Sort helpers ───────────────────────────────────────────────────────────

type SortKey =
  | 'rank' | 'ticker' | 'lastPrice' | 'dayChangePct' | 'compositeScore'
  | 'fundamentalsScore' | 'ivRank' | 'technicalScore' | 'premiumYieldScore'
  | 'currentIv' | 'targetStrike' | 'estimatedPremium' | 'dataPoints';

type SortDir = 'asc' | 'desc';

function sortRows(rows: OpportunityRow[], key: SortKey, dir: SortDir): OpportunityRow[] {
  return [...rows].sort((a, b) => {
    const av = a[key] as number | string | null;
    const bv = b[key] as number | string | null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;   // nulls last
    if (bv === null) return -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ── Main view ──────────────────────────────────────────────────────────────

const UNIVERSE_OPTIONS: { value: OpportunityUniverse; label: string }[] = [
  { value: 'sp500',       label: 'S&P 500' },
  { value: 'russell1000', label: 'Russell 1000' },
  { value: 'both',        label: 'Both Universes' },
];

// Per-strategy weight labels shown in the header — mirrors STRATEGY_WEIGHTS in opportunity-service
const STRATEGY_WEIGHT_LABELS: Record<StrategyMode, string> = {
  wheel:   'Composite = Fund 30% + IV Rank 30% + Technical 20% + Yield 20%',
  csp:     'Composite = Fund 20% + IV Rank 35% + Technical 20% + Yield 25%',
  spreads: 'Composite = Fund 15% + IV Rank 30% + Technical 25% + Yield 30%',
  bullish: 'Composite = Fund 25% + IV Rank 25% (inverted) + Technical 40% + Yield 10%',
  bearish: 'Composite = Fund 10% + IV Rank 25% (inverted) + Technical 45% + Yield 20%',
};

// Per-strategy context shown in the amber warning strip
const STRATEGY_CONTEXT: Record<StrategyMode, string> = {
  wheel:   'Wheel favours quality companies + high IV (30% wt). Strike at 90% of price.',
  csp:     'CSP favours high IV (35% wt) for premium income. Strike at 85% OTM.',
  spreads: 'Spreads favour premium yield (30% wt) + defined risk. Strike at 90%.',
  bullish: 'Bullish favours strong momentum (40% wt) + low IV for cheaper calls (inverted). Strike at 105%.',
  bearish: 'Bearish favours strong bearish momentum (45% wt) + low IV for cheaper puts (inverted). Strike at 92%.',
};

const STRATEGY_STRIKE_LEGEND: Record<StrategyMode, string> = {
  wheel:   '90% of price (sell put, willing to own)',
  csp:     '85% of price (OTM put, prefer not to be assigned)',
  spreads: '90% of price (short leg; protection leg ~5% lower)',
  bullish: '105% of price (OTM call target)',
  bearish: '92% of price (OTM put target)',
};

const STRATEGY_OPTIONS: { value: StrategyMode; label: string; icon: string }[] = [
  { value: 'wheel',   label: 'Wheel',    icon: '⚙️' },
  { value: 'csp',     label: 'CSP',      icon: '🛡' },
  { value: 'spreads', label: 'Spreads',  icon: '↔️' },
  { value: 'bullish', label: 'Bullish',  icon: '📈' },
  { value: 'bearish', label: 'Bearish',  icon: '📉' },
];

export function OpportunityView() {
  const [universe, setUniverse] = useState<OpportunityUniverse>('both');
  const [strategy, setStrategy] = useState<StrategyMode>('wheel');
  const [minScore, setMinScore] = useState(0);
  const [limit, setLimit] = useState(50);

  const [rows, setRows] = useState<OpportunityRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [runMs, setRunMs] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('compositeScore');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sortedRows = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIndicator = (key: SortKey) =>
    sortKey !== key ? ' ↕' : sortDir === 'desc' ? ' ↓' : ' ↑';

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    const t0 = Date.now();
    try {
      const opts: OpportunityRunOptions = {
        universe,
        strategy,
        minCompositeScore: minScore,
        limit,
      };
      const result = await window.api.opportunity.run(opts);
      setRows(result);
      setLastRunAt(new Date().toLocaleTimeString());
      setRunMs(Date.now() - t0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [universe, strategy, minScore, limit]);

  // Auto-run on mount
  useEffect(() => { run(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const navigateToAnalysis = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker } }));
  };

  const navigateToOptions = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker } }));
  };

  const navigateToValidate = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
  };

  const fmtPrice = (p: number | null) => p === null ? '—' : `$${p.toFixed(2)}`;
  const fmtPct   = (p: number | null) =>
    p === null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;

  const dayPctColor = (p: number | null) =>
    p === null ? '' : p >= 0 ? '#2ecc71' : '#e74c3c';

  const ivCoverageColor = (dp: number) =>
    dp >= 200 ? '#2ecc71' : dp >= 100 ? '#f39c12' : '#e74c3c';

  // Stats
  const withIv        = rows.filter(r => r.ivRank !== null).length;
  const withFund      = rows.filter(r => r.fundamentalsScore !== null).length;
  const withTech      = rows.filter(r => r.technicalScore !== null).length;
  const avgComposite  = rows.length ? Math.round(rows.reduce((s, r) => s + r.compositeScore, 0) / rows.length) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: '12px 16px', gap: 10 }}>

      {/* ── Header bar ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>🎯 Opportunity Dashboard</h2>
        <span style={{ color: '#888', fontSize: 12 }}>
          {STRATEGY_WEIGHT_LABELS[strategy]}
        </span>
        <div style={{ flex: 1 }} />
        {lastRunAt && (
          <span style={{ color: '#888', fontSize: 11 }}>
            Last run: {lastRunAt} {runMs ? `(${runMs}ms)` : ''}
          </span>
        )}
      </div>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        padding: '8px 12px', background: '#1a1a2e', borderRadius: 6, border: '1px solid #333',
      }}>
        {/* Universe */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#aaa' }}>Universe:</label>
          {UNIVERSE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setUniverse(opt.value)}
              style={{
                padding: '3px 10px', fontSize: 12, borderRadius: 4,
                background: universe === opt.value ? '#3498db' : '#333',
                color: universe === opt.value ? '#fff' : '#ccc',
                border: 'none', cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: '#444' }} />

        {/* Strategy */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: '#aaa' }}>Strategy:</label>
          {STRATEGY_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setStrategy(opt.value)}
              style={{
                padding: '3px 10px', fontSize: 12, borderRadius: 4,
                background: strategy === opt.value ? '#9b59b6' : '#333',
                color: strategy === opt.value ? '#fff' : '#ccc',
                border: 'none', cursor: 'pointer',
              }}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: '#444' }} />

        {/* Min score + limit */}
        <label style={{ fontSize: 12, color: '#aaa' }}>Min score:</label>
        <input
          type="number" min={0} max={100} value={minScore}
          onChange={e => setMinScore(+e.target.value)}
          style={{ width: 50, padding: '2px 6px', fontSize: 12, background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 4 }}
        />
        <label style={{ fontSize: 12, color: '#aaa' }}>Top:</label>
        <select
          value={limit}
          onChange={e => setLimit(+e.target.value)}
          style={{ padding: '2px 4px', fontSize: 12, background: '#333', color: '#fff', border: '1px solid #555', borderRadius: 4 }}
        >
          {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
        </select>

        <button
          onClick={run}
          disabled={loading}
          style={{
            padding: '5px 16px', fontSize: 13, fontWeight: 600,
            background: loading ? '#555' : '#27ae60', color: '#fff',
            border: 'none', borderRadius: 4, cursor: loading ? 'default' : 'pointer',
          }}
        >
          {loading ? '⏳ Running…' : '▶ Run'}
        </button>
      </div>

      {/* ── Stats strip ────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 16, padding: '6px 12px', background: '#111', borderRadius: 5, fontSize: 12, flexWrap: 'wrap' }}>
          <span><strong>{rows.length}</strong> <span style={{ color: '#888' }}>results</span></span>
          <span><strong style={{ color: '#f39c12' }}>{avgComposite}</strong> <span style={{ color: '#888' }}>avg composite</span></span>
          <span><strong style={{ color: '#2ecc71' }}>{withIv}</strong> <span style={{ color: '#888' }}>with IV rank</span></span>
          <span><strong style={{ color: '#3498db' }}>{withFund}</strong> <span style={{ color: '#888' }}>with fundamentals</span></span>
          <span><strong style={{ color: '#9b59b6' }}>{withTech}</strong> <span style={{ color: '#888' }}>with technical score</span></span>
          <span style={{ color: '#f39c12', fontStyle: 'italic' }}>
            ⚠ Score ≠ buy signal — {STRATEGY_CONTEXT[strategy]}
          </span>
        </div>
      )}

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ background: '#4a1a1a', border: '1px solid #c0392b', borderRadius: 4, padding: '8px 12px', color: '#e74c3c', fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Empty state ────────────────────────────────────────────────── */}
      {!loading && rows.length === 0 && !error && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 32 }}>📊</div>
          <div>No results yet. Click <strong>▶ Run</strong> to score the universe.</div>
          <div style={{ fontSize: 12, color: '#555' }}>
            Tip: run <em>Data Sync → Sync Market Data</em> first to ensure quote cache is fresh.
          </div>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <div style={{ flex: 1, overflowY: 'auto', borderRadius: 5, border: '1px solid #333' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#1e1e2e', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={thNum} onClick={() => handleSort('rank')}>#{ sortIndicator('rank')}</th>
                <th style={th}    onClick={() => handleSort('ticker')}>Ticker{sortIndicator('ticker')}</th>
                <th style={th}>Company</th>
                <th style={thNum} onClick={() => handleSort('lastPrice')}>Price{sortIndicator('lastPrice')}</th>
                <th style={thNum} onClick={() => handleSort('dayChangePct')}>Day%{sortIndicator('dayChangePct')}</th>
                <th style={thCtr} onClick={() => handleSort('compositeScore')} title="Composite opportunity score optimized for the selected strategy — NOT a buy signal. High score = favorable conditions to sell premium (Wheel/CSP) or buy options (Bullish/Bearish).">Score{sortIndicator('compositeScore')}</th>
                <th style={thNum} onClick={() => handleSort('fundamentalsScore')}>Fund{sortIndicator('fundamentalsScore')}</th>
                <th style={thNum} onClick={() => handleSort('ivRank')}>IV Rank{sortIndicator('ivRank')}</th>
                <th style={thNum} onClick={() => handleSort('technicalScore')}>Tech{sortIndicator('technicalScore')}</th>
                <th style={thNum} onClick={() => handleSort('premiumYieldScore')}>Yield{sortIndicator('premiumYieldScore')}</th>
                <th style={thNum} onClick={() => handleSort('currentIv')}>Curr IV{sortIndicator('currentIv')}</th>
                <th style={thNum} onClick={() => handleSort('targetStrike')} title="~92% of price — CSP target strike">Strike{sortIndicator('targetStrike')}</th>
                <th style={thNum} title="Nearest Friday ≥ 30 DTE from today">Exp / DTE</th>
                <th style={thNum} onClick={() => handleSort('estimatedPremium')} title="Estimated premium at target strike for the target expiry (~1.5%/mo rule of thumb)">Est Prem{sortIndicator('estimatedPremium')}</th>
                <th style={thCtr} onClick={() => handleSort('dataPoints')}>Data{sortIndicator('dataPoints')}</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, idx) => (
                <tr
                  key={row.ticker}
                  style={{
                    borderBottom: '1px solid #222',
                    background: idx % 2 === 1 ? '#141420' : 'transparent',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1e1e3a')}
                  onMouseLeave={e => (e.currentTarget.style.background = idx % 2 === 1 ? '#141420' : 'transparent')}
                >
                  <td style={td}><span style={{ color: '#666', fontSize: 11 }}>{row.rank}</span></td>
                  <td style={td}>
                    <strong style={{ color: '#7fbbff' }}>{row.ticker}</strong>
                  </td>
                  <td style={{ ...td, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ color: '#aaa', fontSize: 11 }}>{row.companyName ?? '—'}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtPrice(row.lastPrice)}</td>
                  <td style={{ ...td, textAlign: 'right', color: dayPctColor(row.dayChangePct) }}>
                    {fmtPct(row.dayChangePct)}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <CompositeScore score={row.compositeScore} />
                  </td>
                  <td style={td}><ScoreBar value={row.fundamentalsScore} /></td>
                  <td style={td}><IvBadge ivRank={row.ivRank} /></td>
                  <td style={td}><ScoreBar value={row.technicalScore} /></td>
                  <td style={td}><ScoreBar value={row.premiumYieldScore} /></td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {row.currentIv !== null
                      ? <span style={{ color: row.currentIv >= 40 ? '#e74c3c' : row.currentIv >= 25 ? '#f39c12' : '#2ecc71' }}>
                          {row.currentIv.toFixed(1)}%
                        </span>
                      : <span style={{ color: '#555' }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#888' }}>
                    {row.targetStrike !== null ? `$${row.targetStrike.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {row.targetExpiry !== null ? (
                      <span style={{ fontSize: 11, color: '#aaa' }}>
                        {row.targetExpiry}<br />
                        <span style={{ color: '#666' }}>{row.targetDte}d</span>
                      </span>
                    ) : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#2ecc71' }}>
                    {row.estimatedPremium !== null ? `$${row.estimatedPremium.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <span style={{ color: ivCoverageColor(row.dataPoints), fontSize: 11 }}>
                      {row.dataPoints}d
                    </span>
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        title="Run analysis"
                        onClick={() => navigateToAnalysis(row.ticker)}
                        style={actionBtn}
                      >
                        📊
                      </button>
                      <button
                        title="Options chain"
                        onClick={() => navigateToOptions(row.ticker)}
                        style={actionBtn}
                      >
                        📉
                      </button>
                      <button
                        title="Validate"
                        onClick={() => navigateToValidate(row.ticker)}
                        style={actionBtn}
                      >
                        🎯
                      </button>
                      <button
                        title="Open on E*Trade"
                        onClick={() => window.open(
                          `https://us.etrade.com/e/t/invest/quotesandresearch?content=3&sym=${row.ticker.toLowerCase()}`,
                          '_blank'
                        )}
                        style={actionBtn}
                      >
                        🏦
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Legend ─────────────────────────────────────────────────────── */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#666', padding: '4px 0' }}>
          <span><span style={{ color: '#2ecc71' }}>●</span> Score ≥ 70 = strong</span>
          <span><span style={{ color: '#f39c12' }}>●</span> 45–69 = moderate</span>
          <span><span style={{ color: '#e74c3c' }}>●</span> &lt; 45 = weak</span>
          <span style={{ marginLeft: 16 }}><strong>Data</strong> = IV history days (green ≥ 200, yellow ≥ 100)</span>
          <span><strong>Strike</strong> = {STRATEGY_STRIKE_LEGEND[strategy]}</span>
          <span><strong>Exp</strong> = nearest Friday ≥ 30 DTE</span>
          <span><strong>Est Prem</strong> = ~1.5%/mo of strike (rule of thumb — verify in Options Chain)</span>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const thBase: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  fontWeight: 600,
  color: '#aaa',
  borderBottom: '1px solid #333',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  userSelect: 'none',
};

/** Left-aligned sortable header (text columns) */
const th: React.CSSProperties = { ...thBase, textAlign: 'left' };

/** Right-aligned sortable header (numeric columns) */
const thNum: React.CSSProperties = { ...thBase, textAlign: 'right' };

/** Center-aligned sortable header (score circles, counts) */
const thCtr: React.CSSProperties = { ...thBase, textAlign: 'center' };

const td: React.CSSProperties = {
  padding: '6px 10px',
  verticalAlign: 'middle',
};

const actionBtn: React.CSSProperties = {
  background: 'none',
  border: '1px solid #444',
  borderRadius: 3,
  padding: '2px 6px',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
};
