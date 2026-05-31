// KnowledgeView — tastylive Strategy Guide quick reference
// 31 strategies, collapsible left drawer, Image / Text toggle

import { useState, useMemo } from 'react';
import {
  STRATEGIES,
  STRATEGIES_BY_CATEGORY,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type Strategy,
  type StrategyCategory,
} from '../knowledge/index.js';

// ─── Image map (Vite bundles all PNGs at build time) ─────────────────────────

const imageModules = import.meta.glob('../knowledge/images/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

function imageUrl(slug: string): string {
  return imageModules[`../knowledge/images/${slug}.png`] ?? '';
}

// ─── Category styling ─────────────────────────────────────────────────────────

const CATEGORY_COLOR: Record<StrategyCategory, string> = {
  'bullish':         '#22c55e',
  'bearish':         '#ef4444',
  'omnidirectional': '#a78bfa',
  'neutral':         '#60a5fa',
  'neutral-bullish': '#34d399',
  'neutral-bearish': '#f97316',
};

const GREEK_COLOR: Record<string, string> = {
  'Long':    '#22c55e',
  'Short':   '#ef4444',
  'Flat':    '#6b7280',
  'Dynamic': '#60a5fa',
};

function greekColor(val: string): string {
  return GREEK_COLOR[val] ?? '#9ca3af';
}

function ivColor(val: string): string {
  if (/high/i.test(val)) return '#ef4444';
  if (/low/i.test(val))  return '#22c55e';
  return '#9ca3af';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatChip({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ background: '#111827', borderRadius: 6, padding: '6px 12px', minWidth: 90 }}>
      <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: valueColor ?? '#f9fafb' }}>{value || '—'}</div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6b7280', marginBottom: 8, marginTop: 20 }}>
      {children}
    </div>
  );
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: `${color}22`, color, fontWeight: 700, border: `1px solid ${color}44` }}>
      {text}
    </span>
  );
}

// ─── Text view ────────────────────────────────────────────────────────────────

function TextPanel({ s }: { s: Strategy }) {
  const catColor = CATEGORY_COLOR[s.category];

  return (
    <div style={{ padding: '0 4px' }}>
      {/* Key params */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <StatChip label="Direction"   value={s.directionalAssumption} />
        <StatChip label="IV"          value={s.ivEnvironment} valueColor={ivColor(s.ivEnvironment)} />
        <StatChip label="DTE"         value={s.dte ? `${s.dte} days` : '—'} />
        <StatChip label="PoP"         value={s.probabilityOfProfit} valueColor="#22c55e" />
      </div>

      {/* Setup */}
      {s.setup.length > 0 && (
        <>
          <SectionHeader>Setup</SectionHeader>
          <div style={{ background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 4 }}>
            {s.setup.map((leg, i) => (
              <div key={i} style={{ fontSize: 12, color: '#d1d5db', padding: '3px 0', borderBottom: i < s.setup.length - 1 ? '1px solid #1f2937' : 'none' }}>
                {leg}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Risk / Reward */}
      <SectionHeader>Risk / Reward</SectionHeader>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>
        {[
          { label: 'Max Profit',     value: s.maxProfit,     color: '#22c55e' },
          { label: 'Max Loss',       value: s.maxLoss,       color: '#ef4444' },
          { label: 'Profit Target',  value: s.profitTarget,  color: '#34d399' },
          { label: 'Breakeven',      value: s.breakeven,     color: '#9ca3af' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#111827', borderRadius: 6, padding: '8px 12px' }}>
            <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 11, color, lineHeight: 1.4 }}>{value || '—'}</div>
          </div>
        ))}
      </div>

      {/* Greeks */}
      <SectionHeader>Greeks</SectionHeader>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        {(['delta', 'vega', 'theta', 'gamma'] as const).map(g => (
          <div key={g} style={{ background: '#111827', borderRadius: 6, padding: '6px 12px', flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: '#6b7280', textTransform: 'uppercase', marginBottom: 3 }}>{g}</div>
            <div style={{ fontSize: 11, fontWeight: 700, color: greekColor(s.greeks[g]) }}>{s.greeks[g] || '—'}</div>
          </div>
        ))}
      </div>

      {/* How it works */}
      <SectionHeader>How the Trade Works</SectionHeader>
      {[
        { label: 'Ideal',              text: s.howItWorks.ideal,            icon: '✅' },
        { label: 'Not Ideal',          text: s.howItWorks.notIdeal,         icon: '⚠️' },
        { label: 'Defensive Tactics',  text: s.howItWorks.defensiveTactics, icon: '🛡️' },
      ].filter(x => x.text).map(({ label, text, icon }) => (
        <div key={label} style={{ background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', marginBottom: 4 }}>{icon} {label}</div>
          <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{text}</div>
        </div>
      ))}

      {/* Volatility */}
      {(s.volatility.ifExpands || s.volatility.ifContracts) && (
        <>
          <SectionHeader>Volatility</SectionHeader>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>
            {[
              { label: 'If IV Expands',   text: s.volatility.ifExpands },
              { label: 'If IV Contracts', text: s.volatility.ifContracts },
            ].filter(x => x.text).map(({ label, text }) => (
              <div key={label} style={{ background: '#111827', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
                <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{text}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Expiration */}
      {(s.expiration.ifOTM || s.expiration.ifITM || s.expiration.other?.length > 0) && (
        <>
          <SectionHeader>At Expiration</SectionHeader>
          {[
            { label: 'If OTM', text: s.expiration.ifOTM },
            { label: 'If ITM', text: s.expiration.ifITM },
            ...(s.expiration.other ?? []).map((o, i) => ({ label: `Other (${i + 1})`, text: o })),
          ].filter(x => x.text).map(({ label, text }) => (
            <div key={label} style={{ background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{text}</div>
            </div>
          ))}
        </>
      )}

      {/* Takeaways */}
      {s.takeaways.length > 0 && (
        <>
          <SectionHeader>Takeaways</SectionHeader>
          {s.takeaways.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, background: '#111827', borderRadius: 8, padding: '10px 14px', marginBottom: 6 }}>
              <span style={{ color: catColor, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>→</span>
              <div style={{ fontSize: 12, color: '#d1d5db', lineHeight: 1.6 }}>{t}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export function KnowledgeView() {
  const [drawerOpen, setDrawerOpen]       = useState(true);
  const [activeSlug, setActiveSlug]       = useState<string>(STRATEGIES[0]?.slug ?? '');
  const [viewMode, setViewMode]           = useState<'image' | 'text'>('image');
  const [search, setSearch]               = useState('');

  const active = useMemo(
    () => STRATEGIES.find(s => s.slug === activeSlug) ?? STRATEGIES[0],
    [activeSlug],
  );

  const filteredByCategory = useMemo(() => {
    const q = search.toLowerCase();
    const result: Partial<Record<StrategyCategory, Strategy[]>> = {};
    for (const cat of CATEGORY_ORDER) {
      const matches = STRATEGIES_BY_CATEGORY[cat].filter(s =>
        !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
      );
      if (matches.length) result[cat] = matches;
    }
    return result;
  }, [search]);

  const catColor = active ? CATEGORY_COLOR[active.category] : '#6b7280';

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>

      {/* ── Collapsible left drawer ── */}
      <div style={{
        width: drawerOpen ? 220 : 36,
        flexShrink: 0,
        transition: 'width 0.2s ease',
        background: '#111827',
        borderRight: '1px solid #1f2937',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Drawer toggle button */}
        <button
          onClick={() => setDrawerOpen(o => !o)}
          title={drawerOpen ? 'Collapse' : 'Expand strategy list'}
          style={{
            flexShrink: 0, height: 36, background: 'none', border: 'none',
            borderBottom: '1px solid #1f2937', color: '#6b7280', cursor: 'pointer',
            fontSize: 14, display: 'flex', alignItems: 'center',
            justifyContent: drawerOpen ? 'flex-end' : 'center',
            paddingRight: drawerOpen ? 10 : 0,
          }}
        >
          {drawerOpen ? '◀' : '▶'}
        </button>

        {drawerOpen && (
          <>
            {/* Search */}
            <div style={{ padding: '8px 10px', flexShrink: 0 }}>
              <input
                type="text"
                placeholder="Search strategies…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '5px 8px', fontSize: 11,
                  background: '#1f2937', border: '1px solid #374151',
                  borderRadius: 4, color: '#f9fafb', outline: 'none',
                }}
              />
            </div>

            {/* Strategy list */}
            <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
              {CATEGORY_ORDER.map(cat => {
                const strategies = filteredByCategory[cat];
                if (!strategies) return null;
                return (
                  <div key={cat}>
                    <div style={{
                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.08em', padding: '10px 12px 4px',
                      color: CATEGORY_COLOR[cat],
                    }}>
                      {CATEGORY_LABELS[cat]}
                    </div>
                    {strategies.map(s => (
                      <button
                        key={s.slug}
                        onClick={() => setActiveSlug(s.slug)}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '6px 12px 6px 16px', border: 'none',
                          fontSize: 11, cursor: 'pointer', lineHeight: 1.3,
                          color: activeSlug === s.slug ? '#f9fafb' : '#9ca3af',
                          background: activeSlug === s.slug
                            ? `${CATEGORY_COLOR[s.category]}18`
                            : 'transparent',
                          borderLeft: activeSlug === s.slug
                            ? `2px solid ${CATEGORY_COLOR[s.category]}`
                            : '2px solid transparent',
                        }}
                      >
                        {s.name}
                      </button>
                    ))}
                  </div>
                );
              })}
              {Object.keys(filteredByCategory).length === 0 && (
                <div style={{ fontSize: 11, color: '#6b7280', padding: '16px 12px' }}>No matches</div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Content panel ── */}
      {active && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

          {/* Header bar */}
          <div style={{
            flexShrink: 0, padding: '12px 20px',
            borderBottom: '1px solid #1f2937',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f9fafb' }}>{active.name}</h2>
                <Pill text={CATEGORY_LABELS[active.category]} color={catColor} />
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {active.description}
              </div>
            </div>

            {/* Image / Text toggle */}
            <div style={{
              display: 'flex', background: '#1f2937', borderRadius: 6,
              border: '1px solid #374151', overflow: 'hidden', flexShrink: 0,
            }}>
              {(['image', 'text'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
                    background: viewMode === mode ? catColor : 'transparent',
                    color: viewMode === mode ? '#fff' : '#9ca3af',
                    transition: 'background 0.15s',
                  }}
                >
                  {mode === 'image' ? '🖼 Image' : '📄 Text'}
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
            {viewMode === 'image' ? (
              <img
                src={imageUrl(active.slug)}
                alt={active.name}
                style={{ width: '100%', height: 'auto', borderRadius: 8, display: 'block' }}
              />
            ) : (
              <TextPanel s={active} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
