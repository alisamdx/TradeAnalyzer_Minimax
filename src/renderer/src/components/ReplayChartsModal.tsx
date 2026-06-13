import React, { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Cell, ReferenceLine,
} from 'recharts';
import type { ReplayChartData } from '@shared/types.js';

type ChartTab = 'performance' | 'regime' | 'monthly' | 'signals' | 'tickers';

const TABS: { key: ChartTab; label: string }[] = [
  { key: 'performance', label: 'Performance' },
  { key: 'regime',      label: 'Regime' },
  { key: 'monthly',     label: 'Monthly' },
  { key: 'signals',     label: 'Score Signal' },
  { key: 'tickers',     label: 'Tickers' },
];

const STRAT_COLORS: Record<string, string> = {
  buy:     '#4caf50',
  bullish: '#2196f3',
  income:  '#ff9800',
  wheel:   '#9c27b0',
  bearish: '#f44336',
};

const STRAT_LABEL: Record<string, string> = {
  buy: 'Buy', bullish: 'Bullish', income: 'Income', wheel: 'Wheel', bearish: 'Bearish',
};

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--bg-elevated, #1a1a2e)',
  border: '1px solid var(--border, rgba(255,255,255,0.12))',
  borderRadius: 6, fontSize: 12,
  color: 'var(--text-primary, #fff)',
};

function fmtPct(v: number | null, showPlus = false): string {
  if (v === null) return '—';
  return (showPlus && v > 0 ? '+' : '') + v.toFixed(1) + '%';
}

function pctFmt(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

function SectionTitle({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted, #888)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
      {label}
    </div>
  );
}

function TwoCol({ children }: { children: React.ReactNode[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
      {children}
    </div>
  );
}

export default function ReplayChartsModal({ data, onClose }: { data: ReplayChartData; onClose: () => void }) {
  const [tab, setTab] = useState<ChartTab>('performance');

  const { from, to, dates, picks } = data.dateRange;

  const perfData = data.strategies.map(s => ({
    name: STRAT_LABEL[s.strategy] ?? s.strategy,
    strategy: s.strategy,
    avg21d: s.avg21d,
    hr21d: s.hr21d,
  }));

  const regimeData = data.strategies.map(s => ({
    name: STRAT_LABEL[s.strategy] ?? s.strategy,
    strategy: s.strategy,
    bull: s.bullAvg21d,
    bear: s.bearAvg21d,
  }));

  const quintileData = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((q, i) => {
    const row: Record<string, string | number | null> = { name: q };
    for (const s of data.strategies.filter(x => ['buy', 'bullish', 'bearish'].includes(x.strategy))) {
      row[s.strategy] = s.scoreQuintiles[i] ?? null;
    }
    return row;
  });

  const rankData = [1, 2, 3, 4, 5].map((r, i) => {
    const row: Record<string, string | number | null> = { name: `#${r}` };
    for (const s of data.strategies.filter(x => ['buy', 'bullish', 'wheel'].includes(x.strategy))) {
      row[s.strategy] = s.rankAvg[i] ?? null;
    }
    return row;
  });

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 16px',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--accent, #5c9cf5)' : 'var(--text-muted, #888)',
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent, #5c9cf5)' : '2px solid transparent',
    cursor: 'pointer',
    marginBottom: -1,
    whiteSpace: 'nowrap' as const,
  });

  const gridStyle: React.CSSProperties = { stroke: 'rgba(128,128,128,0.12)' };

  // Formatter for tooltip — recharts passes unknown, cast it
  const makeFmt = (fn: (v: number) => string) => (value: unknown, name: unknown) => {
    const v = typeof value === 'number' ? fn(value) : '—';
    const n = typeof name === 'string' ? (STRAT_LABEL[name] ?? name) : String(name);
    return [v, n];
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary, #121212)', zIndex: 1000, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.1))', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Replay Performance Charts</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {from} → {to} · {dates} dates · {picks.toLocaleString()} picks
            · {data.regimeDates.bull}B / {data.regimeDates.bear}R regime
          </span>
        </div>
        <button onClick={onClose} style={{ fontSize: 16, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '0 4px', lineHeight: 1 }} title="Close">
          ✕
        </button>
      </div>

      {/* ── Tab bar ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', padding: '0 20px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.1))', flexShrink: 0, gap: 0 }}>
        {TABS.map(t => (
          <button key={t.key} style={tabStyle(tab === t.key)} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>

        {/* ── Performance tab ─────────────────────────────────────────── */}
        {tab === 'performance' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <TwoCol>
              <div>
                <SectionTitle label="Avg 21-day return" />
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={perfData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={pctFmt} tick={{ fontSize: 11 }} width={52} />
                    <Tooltip formatter={makeFmt(pctFmt)} contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-muted)' }} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                    <Bar dataKey="avg21d" name="avg21d" radius={[4, 4, 0, 0]}>
                      {perfData.map((entry, i) => (
                        <Cell key={i} fill={STRAT_COLORS[entry.strategy] ?? '#888'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <SectionTitle label="Hit rate 21d (%)" />
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={perfData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis domain={[0, 100]} tickFormatter={v => v + '%'} tick={{ fontSize: 11 }} width={40} />
                    <Tooltip formatter={makeFmt(v => v.toFixed(0) + '%')} contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-muted)' }} />
                    <ReferenceLine y={50} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                    <Bar dataKey="hr21d" name="hr21d" radius={[4, 4, 0, 0]}>
                      {perfData.map((entry, i) => (
                        <Cell key={i} fill={STRAT_COLORS[entry.strategy] ?? '#888'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </TwoCol>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {['Strategy', 'Picks', 'Avg 21d', 'HR 21d'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Strategy' ? 'left' : 'right', padding: '4px 10px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.strategies.map(s => (
                  <tr key={s.strategy}>
                    <td style={{ padding: '5px 10px', fontWeight: 600, color: STRAT_COLORS[s.strategy] ?? 'inherit', textTransform: 'capitalize' }}>{s.strategy}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: 'var(--text-muted)' }}>{s.n.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: (s.avg21d ?? 0) >= 0 ? '#4caf50' : '#f44336' }}>{fmtPct(s.avg21d, true)}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: (s.hr21d ?? 0) >= 50 ? '#4caf50' : '#f44336' }}>{s.hr21d !== null ? s.hr21d + '%' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Regime tab ──────────────────────────────────────────────── */}
        {tab === 'regime' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: -8 }}>
              Bull = SPY above 50-day SMA · Bear = SPY below 50-day SMA
              · {data.regimeDates.bull} bull dates · {data.regimeDates.bear} bear dates
            </div>
            <div>
              <SectionTitle label="Avg 21d return — bull regime vs bear regime" />
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={regimeData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={pctFmt} tick={{ fontSize: 11 }} width={52} />
                  <Tooltip formatter={makeFmt(pctFmt)} contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-muted)' }} />
                  <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                  <Bar dataKey="bull" name="bull" fill="#4caf50" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="bear" name="bear" fill="#ef5350" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
                {[['#4caf50', 'Bull regime'], ['#ef5350', 'Bear regime']].map(([c, l]) => (
                  <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 10, height: 10, background: c, borderRadius: 2, display: 'inline-block' }} />
                    <span style={{ color: 'var(--text-muted)' }}>{l}</span>
                  </span>
                ))}
              </div>
            </div>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {['Strategy', 'Bull avg21d', 'Bull HR', 'Bull n', 'Bear avg21d', 'Bear HR', 'Bear n'].map(h => (
                    <th key={h} style={{ textAlign: h === 'Strategy' ? 'left' : 'right', padding: '4px 10px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.strategies.map(s => (
                  <tr key={s.strategy}>
                    <td style={{ padding: '5px 10px', fontWeight: 600, color: STRAT_COLORS[s.strategy] ?? 'inherit', textTransform: 'capitalize' }}>{s.strategy}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: (s.bullAvg21d ?? 0) >= 0 ? '#4caf50' : '#f44336' }}>{fmtPct(s.bullAvg21d, true)}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px' }}>{s.bullHr21d !== null ? s.bullHr21d + '%' : '—'}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: 'var(--text-muted)' }}>{s.bullN.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: (s.bearAvg21d ?? 0) >= 0 ? '#4caf50' : '#f44336' }}>{fmtPct(s.bearAvg21d, true)}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px' }}>{s.bearHr21d !== null ? s.bearHr21d + '%' : '—'}</td>
                    <td style={{ textAlign: 'right', padding: '5px 10px', color: 'var(--text-muted)' }}>{s.bearN.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ── Monthly tab ──────────────────────────────────────────────── */}
        {tab === 'monthly' && (
          <div>
            <SectionTitle label="Monthly hit rate 21d (%) — all strategies" />
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={data.monthly} margin={{ top: 8, right: 20, bottom: 24, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} angle={-35} textAnchor="end" height={50} />
                <YAxis domain={[0, 100]} tickFormatter={v => v + '%'} tick={{ fontSize: 11 }} width={40} />
                <Tooltip formatter={makeFmt(v => v.toFixed(0) + '%')} contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-muted)' }} />
                <ReferenceLine y={50} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
                {(['buy', 'bullish', 'income', 'wheel', 'bearish'] as const).map(s => (
                  <Line
                    key={s}
                    type="monotone"
                    dataKey={s}
                    name={s}
                    stroke={STRAT_COLORS[s]}
                    strokeWidth={s === 'buy' || s === 'bullish' ? 2 : 1.5}
                    dot={{ r: 3, fill: STRAT_COLORS[s] }}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4, fontSize: 12 }}>
              {(['buy', 'bullish', 'income', 'wheel', 'bearish'] as const).map(s => (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 14, height: 2, background: STRAT_COLORS[s], display: 'inline-block' }} />
                  <span style={{ color: 'var(--text-muted)' }}>{STRAT_LABEL[s]}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Score Signal tab ─────────────────────────────────────────── */}
        {tab === 'signals' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <div style={{ padding: '8px 12px', background: 'rgba(239,83,80,0.08)', border: '1px solid rgba(239,83,80,0.25)', borderRadius: 6, fontSize: 12, color: '#ef9a9a' }}>
              ⚠ Scoring is anti-predictive: lower-scored picks (Q1) consistently outperform Q5 for buy, bullish, and bearish. Higher rank does not mean better outcome. Score filtering actively reduces returns.
            </div>
            <TwoCol>
              <div>
                <SectionTitle label="Score quintile → avg 21d return (buy · bullish · bearish)" />
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={quintileData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={pctFmt} tick={{ fontSize: 11 }} width={52} />
                    <Tooltip formatter={makeFmt(pctFmt)} contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-muted)' }} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                    {(['buy', 'bullish', 'bearish'] as const).map(s => (
                      <Bar key={s} dataKey={s} name={s} fill={STRAT_COLORS[s]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div>
                <SectionTitle label="Pick rank in brief → avg 21d return (buy · bullish · wheel)" />
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={rankData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.12)" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={pctFmt} tick={{ fontSize: 11 }} width={52} />
                    <Tooltip formatter={makeFmt(pctFmt)} contentStyle={TOOLTIP_STYLE} labelStyle={{ color: 'var(--text-muted)' }} />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                    {(['buy', 'bullish', 'wheel'] as const).map(s => (
                      <Bar key={s} dataKey={s} name={s} fill={STRAT_COLORS[s]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </TwoCol>
            <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
              {(['buy', 'bullish', 'bearish', 'wheel'] as const).map(s => (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 10, height: 10, background: STRAT_COLORS[s], borderRadius: 2, display: 'inline-block' }} />
                  <span style={{ color: 'var(--text-muted)' }}>{STRAT_LABEL[s]}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Tickers tab ──────────────────────────────────────────────── */}
        {tab === 'tickers' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 20 }}>
            {data.strategies.map(s => {
              const isBearish = s.strategy === 'bearish';
              return (
                <div key={s.strategy}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: STRAT_COLORS[s.strategy] ?? 'inherit', textTransform: 'capitalize', marginBottom: 8 }}>
                    {s.strategy}
                  </div>
                  <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                        {['Ticker', 'n', 'Avg 21d', 'HR'].map(h => (
                          <th key={h} style={{ textAlign: h === 'Ticker' ? 'left' : 'right', padding: '3px 6px', borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.topTickers.slice(0, 4).map(t => (
                        <tr key={t.ticker}>
                          <td style={{ padding: '3px 6px', fontWeight: 600 }}>{t.ticker}</td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: 'var(--text-muted)' }}>{t.n}</td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: isBearish ? (t.avg21d <= 0 ? '#4caf50' : '#f44336') : (t.avg21d >= 0 ? '#4caf50' : '#f44336') }}>
                            {fmtPct(t.avg21d, true)}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px' }}>{t.hr}%</td>
                        </tr>
                      ))}
                      <tr>
                        <td colSpan={4} style={{ padding: '2px 6px', fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>— worst —</td>
                      </tr>
                      {s.worstTickers.slice(0, 3).map(t => (
                        <tr key={t.ticker}>
                          <td style={{ padding: '3px 6px', fontWeight: 600 }}>{t.ticker}</td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: 'var(--text-muted)' }}>{t.n}</td>
                          <td style={{ textAlign: 'right', padding: '3px 6px', color: isBearish ? (t.avg21d <= 0 ? '#4caf50' : '#f44336') : (t.avg21d >= 0 ? '#4caf50' : '#f44336') }}>
                            {fmtPct(t.avg21d, true)}
                          </td>
                          <td style={{ textAlign: 'right', padding: '3px 6px' }}>{t.hr}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
