/**
 * Strategy Lab — score all 31 strategies for a ticker (Validate) or explore
 * a specific strategy setup (Explore) using entirely fresh live data.
 *
 * v0.20.0
 */
import React, { useState, useCallback, useEffect } from 'react';
import type {
  StrategyLabValidateResult,
  StrategyLabContext,
  StrategyScore,
  StrategySetup,
  SetupLeg,
  StrategyLabGrade,
  StrategyLabComplexity,
  PayoffLeg,
  Watchlist,
  WatchlistItem,
} from '@shared/types.js';

// ─── SetupLeg → PayoffLeg conversion ─────────────────────────────────────────

function labLegToPayoffLeg(leg: SetupLeg): PayoffLeg {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const actionLabel = leg.action === 'buy' ? 'Buy' : 'Sell';
  const typeLabel   = leg.side.charAt(0).toUpperCase() + leg.side.slice(1);
  return {
    id,
    side:     leg.action,
    type:     leg.side,
    strike:   leg.strike,
    expiry:   leg.expiration,
    premium:  leg.mid,
    quantity: leg.qty,
    delta:    leg.delta,
    theta:    null,
    vega:     null,
    iv:       leg.iv / 100,  // SetupLeg.iv is %; PayoffLeg.iv is decimal fraction (PayoffView multiplies ×100 on display)
    label:    `${actionLabel} ${typeLabel} $${leg.strike}`,
  };
}

// ─── Formatters ────────────────────────────────────────────────────────────────

const fmt$ = (v: number | null | undefined, dec = 2) =>
  v == null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;

const fmtPct = (v: number | null | undefined, dec = 1) =>
  v == null ? '—' : `${v.toFixed(dec)}%`;

const fmtNum = (v: number | null | undefined, dec = 2) =>
  v == null ? '—' : v.toFixed(dec);

// ─── Grade badge ───────────────────────────────────────────────────────────────

const GRADE_COLORS: Record<StrategyLabGrade, string> = {
  'A+': '#22c55e', A: '#4ade80', B: '#facc15', C: '#f97316', F: '#ef4444',
};

function GradeBadge({ grade }: { grade: StrategyLabGrade }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
      fontWeight: 700, fontSize: 12, color: '#000',
      background: GRADE_COLORS[grade] ?? '#888',
    }}>{grade}</span>
  );
}

// ─── Complexity badge ──────────────────────────────────────────────────────────

const COMPLEXITY_COLORS: Record<StrategyLabComplexity, string> = {
  simple: '#3b82f6', moderate: '#f59e0b', complex: '#8b5cf6',
};

function ComplexityBadge({ c }: { c: StrategyLabComplexity }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 3,
      fontWeight: 600, fontSize: 10, color: '#fff', letterSpacing: '0.04em',
      background: COMPLEXITY_COLORS[c],
    }}>{c.toUpperCase()}</span>
  );
}

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div style={{ height: 4, background: '#333', borderRadius: 2, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
    </div>
  );
}

// ─── Context card ─────────────────────────────────────────────────────────────

function ContextCard({ ctx }: { ctx: StrategyLabContext }) {
  const biasColor = ctx.directionBias === 'bullish' ? '#22c55e'
    : ctx.directionBias === 'bearish' ? '#ef4444' : '#94a3b8';

  return (
    <div style={{
      background: '#1a1a2e', border: '1px solid #2d2d4a', borderRadius: 8,
      padding: '12px 16px', marginBottom: 16,
    }}>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <span style={{ color: '#94a3b8', fontSize: 11 }}>UNDERLYING</span>
          <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 20 }}>
            {ctx.ticker} <span style={{ fontSize: 14, fontWeight: 400 }}>{fmt$(ctx.underlyingPx)}</span>
          </div>
        </div>
        <div>
          <span style={{ color: '#94a3b8', fontSize: 11 }}>EXPIRATION</span>
          <div style={{ color: '#e2e8f0', fontSize: 14 }}>{ctx.expiration} <span style={{ color: '#94a3b8' }}>({ctx.dte}d)</span></div>
        </div>
        <div>
          <span style={{ color: '#94a3b8', fontSize: 11 }}>ATM IV</span>
          <div style={{ color: '#e2e8f0', fontSize: 14 }}>{fmtPct(ctx.currentAtmIv)}</div>
        </div>
        <div>
          <span style={{ color: '#94a3b8', fontSize: 11 }}>IV RANK</span>
          <div style={{ color: '#facc15', fontSize: 14, fontWeight: 600 }}>
            {ctx.ivRank != null ? `${ctx.ivRank.toFixed(0)}%` : 'N/A'}
            {ctx.ivPercentile != null && <span style={{ color: '#94a3b8', fontSize: 11, fontWeight: 400 }}> · Pct {ctx.ivPercentile.toFixed(0)}%</span>}
          </div>
        </div>
        <div>
          <span style={{ color: '#94a3b8', fontSize: 11 }}>DIRECTION</span>
          <div style={{ color: biasColor, fontSize: 14, fontWeight: 600, textTransform: 'capitalize' }}>
            {ctx.directionBias}
          </div>
        </div>
        {ctx.ma20 != null && (
          <div>
            <span style={{ color: '#94a3b8', fontSize: 11 }}>MA20 / MA50</span>
            <div style={{ color: '#e2e8f0', fontSize: 13 }}>
              {fmtNum(ctx.ma20)} / {ctx.ma50 != null ? fmtNum(ctx.ma50) : '—'}
            </div>
          </div>
        )}
        {ctx.ivDataPoints < 10 && (
          <div style={{ color: '#f97316', fontSize: 12 }}>
            ⚠ Only {ctx.ivDataPoints} IV data points — run History bulk load for better IV rank
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Setup legs table ─────────────────────────────────────────────────────────

function LegsTable({ legs }: { legs: SetupLeg[] }) {
  if (!legs.length) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #2d2d4a', color: '#94a3b8' }}>
          {['Action', 'Side', 'Strike', 'Expiry', 'Qty', 'Bid', 'Ask', 'Mid', 'IV', 'Delta', 'OI'].map(h => (
            <th key={h} style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {legs.map((leg, i) => (
          <tr key={i} style={{ borderBottom: '1px solid #1e2030', color: '#e2e8f0' }}>
            <td style={{ textAlign: 'right', padding: '5px 8px', color: leg.action === 'sell' ? '#22c55e' : '#60a5fa', fontWeight: 700 }}>
              {leg.action.toUpperCase()}
            </td>
            <td style={{ textAlign: 'right', padding: '5px 8px', color: leg.side === 'call' ? '#60a5fa' : '#f472b6' }}>
              {leg.side.toUpperCase()}
            </td>
            <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 600 }}>{leg.strike}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px', color: '#94a3b8' }}>{leg.expiration}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px' }}>{leg.qty}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px' }}>{fmt$(leg.bid)}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px' }}>{fmt$(leg.ask)}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px', fontWeight: 600 }}>{fmt$(leg.mid)}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px' }}>{fmtPct(leg.iv)}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px' }}>{fmtNum(leg.delta, 3)}</td>
            <td style={{ textAlign: 'right', padding: '5px 8px', color: '#94a3b8' }}>
              {leg.openInterest != null ? leg.openInterest.toLocaleString() : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Setup summary strip ──────────────────────────────────────────────────────

function SetupSummary({ setup }: { setup: StrategySetup }) {
  if (setup.unavailableReason) {
    return (
      <div style={{ color: '#f97316', fontSize: 12, marginTop: 6 }}>
        ⚠ {setup.unavailableReason}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12, marginTop: 8 }}>
      {setup.netCredit != null && (
        <span><span style={{ color: '#94a3b8' }}>Credit: </span><span style={{ color: '#22c55e', fontWeight: 700 }}>{fmt$(setup.netCredit, 0)}</span></span>
      )}
      {setup.netDebit != null && (
        <span><span style={{ color: '#94a3b8' }}>Debit: </span><span style={{ color: '#f97316', fontWeight: 700 }}>{fmt$(setup.netDebit, 0)}</span></span>
      )}
      <span><span style={{ color: '#94a3b8' }}>Max Profit: </span><span style={{ color: '#22c55e', fontWeight: 600 }}>{setup.maxProfit != null ? fmt$(setup.maxProfit, 0) : '∞'}</span></span>
      <span><span style={{ color: '#94a3b8' }}>Max Loss: </span><span style={{ color: '#ef4444', fontWeight: 600 }}>{setup.maxLoss != null ? fmt$(Math.abs(setup.maxLoss), 0) : '∞'}</span></span>
      {setup.annualizedReturn != null && (
        <span><span style={{ color: '#94a3b8' }}>Ann. Return: </span><span style={{ color: '#facc15', fontWeight: 600 }}>{fmtPct(setup.annualizedReturn)}</span></span>
      )}
      {setup.popEstimate != null && (
        <span><span style={{ color: '#94a3b8' }}>PoP: </span><span style={{ color: '#e2e8f0' }}>{fmtPct(setup.popEstimate, 0)}</span></span>
      )}
      {setup.breakevens.length > 0 && (
        <span><span style={{ color: '#94a3b8' }}>B/E: </span>{setup.breakevens.map(b => fmt$(b)).join(' / ')}</span>
      )}
    </div>
  );
}

// ─── Watchlist picker ─────────────────────────────────────────────────────────

interface WatchlistPickerProps {
  watchlists: Watchlist[];
  onSelect: (ticker: string) => void;
}

function WatchlistPicker({ watchlists, onSelect }: WatchlistPickerProps) {
  const [selectedWlId, setSelectedWlId]     = useState<number | null>(null);
  const [watchlistItems, setWatchlistItems] = useState<WatchlistItem[]>([]);

  useEffect(() => {
    if (selectedWlId === null) { setWatchlistItems([]); return; }
    window.api.watchlists.items.list(selectedWlId).then(setWatchlistItems).catch(() => setWatchlistItems([]));
  }, [selectedWlId]);

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <div>
        <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>WATCHLIST</div>
        <select
          value={selectedWlId ?? ''}
          onChange={e => setSelectedWlId(e.target.value ? Number(e.target.value) : null)}
          style={{
            padding: '6px 10px', background: '#1e2030', border: '1px solid #2d3748',
            borderRadius: 5, color: '#e2e8f0', fontSize: 13, minWidth: 130,
          }}
        >
          <option value=''>— select —</option>
          {watchlists.map(w => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
      </div>
      <div>
        <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>TICKER FROM LIST</div>
        <select
          value=''
          disabled={watchlistItems.length === 0}
          onChange={e => { if (e.target.value) onSelect(e.target.value); }}
          style={{
            padding: '6px 10px', background: '#1e2030', border: '1px solid #2d3748',
            borderRadius: 5, color: '#e2e8f0', fontSize: 13, minWidth: 150,
            opacity: watchlistItems.length === 0 ? 0.5 : 1,
          }}
        >
          <option value=''>— pick ticker —</option>
          {watchlistItems.map(t => (
            <option key={t.id} value={t.ticker}>
              {t.ticker}{t.notes ? ` — ${t.notes}` : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─── Validate Tab ─────────────────────────────────────────────────────────────

type AiState = Record<string, { loading: boolean; text: string | null }>;

interface ValidateTabProps {
  ctx: StrategyLabContext;
  scores: StrategyScore[];
  onExplore: (slug: string) => void;
}

function ValidateTab({ ctx, scores, onExplore }: ValidateTabProps) {
  const [aiState, setAiState] = useState<AiState>({});
  const [expandedSlugs, setExpandedSlugs] = useState<Set<string>>(new Set());

  const toggleExpand = (slug: string) => {
    setExpandedSlugs(prev => {
      const next = new Set(prev);
      next.has(slug) ? next.delete(slug) : next.add(slug);
      return next;
    });
  };

  const fetchAi = async (score: StrategyScore) => {
    setAiState(prev => ({ ...prev, [score.slug]: { loading: true, text: null } }));
    try {
      const text = await window.api.strategyLab.aiRationale(score, ctx);
      setAiState(prev => ({ ...prev, [score.slug]: { loading: false, text } }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAiState(prev => ({ ...prev, [score.slug]: { loading: false, text: `Error: ${msg}` } }));
    }
  };

  const navigateToPayoff = (score: StrategyScore) => {
    if (!score.setup || score.setup.unavailableReason) return;
    const setup = score.setup;
    window.dispatchEvent(new CustomEvent('navigate-to-payoff', {
      detail: {
        ticker:   ctx.ticker,
        spot:     ctx.underlyingPx,
        expiry:   setup.expiration,
        strategy: score.slug,
        strike:   setup.legs[0]?.strike ?? undefined,
        legs:     setup.legs.map(labLegToPayoffLeg),
      },
    }));
  };

  return (
    <div>
      <ContextCard ctx={ctx} />
      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>
        {scores.length} strategies scored · {scores.filter(s => s.grade === 'A+' || s.grade === 'A').length} grade A or better
      </div>
      {scores.map(score => {
        const expanded = expandedSlugs.has(score.slug);
        const ai = aiState[score.slug];
        const hasSetup = score.setup && !score.setup.unavailableReason;
        return (
          <div key={score.slug} style={{
            background: '#111827', border: '1px solid #1f2937',
            borderRadius: 8, marginBottom: 8, overflow: 'hidden',
          }}>
            {/* Header row */}
            <div
              style={{ padding: '10px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
              onClick={() => toggleExpand(score.slug)}
            >
              <GradeBadge grade={score.grade} />
              <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 14, flex: 1 }}>{score.name}</span>
              <ComplexityBadge c={score.complexity} />
              <span style={{ color: '#94a3b8', fontSize: 12 }}>{score.category}</span>
              {score.requiresStock && (
                <span style={{ color: '#f59e0b', fontSize: 11, background: '#292209', padding: '1px 5px', borderRadius: 3 }}>STOCK</span>
              )}
              <span style={{ color: '#94a3b8', fontWeight: 700, fontSize: 13 }}>{score.totalScore}/100</span>
              <span style={{ color: '#4b5563', fontSize: 11 }}>{expanded ? '▲' : '▼'}</span>
            </div>

            {/* Score bars */}
            <div style={{ padding: '0 14px 4px', display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
              {[
                { label: 'IV', value: score.ivScore, max: 30, color: '#facc15' },
                { label: 'Direction', value: score.directionScore, max: 30, color: '#60a5fa' },
                { label: 'Premium', value: score.premiumScore, max: 25, color: '#22c55e' },
                { label: 'Liquidity', value: score.liquidityScore, max: 15, color: '#a78bfa' },
              ].map(({ label, value, max, color }) => (
                <div key={label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#6b7280', marginBottom: 2 }}>
                    <span>{label}</span><span>{value}/{max}</span>
                  </div>
                  <ScoreBar value={value} max={max} color={color} />
                </div>
              ))}
            </div>

            {/* Expanded detail */}
            {expanded && (
              <div style={{ padding: '10px 14px 14px', borderTop: '1px solid #1f2937' }}>
                {/* Flags */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {score.flags.map((f, i) => (
                    <span key={i} style={{
                      fontSize: 11, padding: '2px 8px', borderRadius: 12,
                      background: f.startsWith('✓') ? '#14261a' : f.startsWith('✗') ? '#2a1010' : '#1c1c2e',
                      color: f.startsWith('✓') ? '#4ade80' : f.startsWith('✗') ? '#f87171' : '#94a3b8',
                      border: `1px solid ${f.startsWith('✓') ? '#166534' : f.startsWith('✗') ? '#7f1d1d' : '#2d2d4a'}`,
                    }}>{f}</span>
                  ))}
                </div>

                {/* Setup */}
                {score.setup && (
                  <>
                    <SetupSummary setup={score.setup} />
                    {hasSetup && <LegsTable legs={score.setup.legs} />}
                  </>
                )}

                {/* Action buttons */}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button
                    onClick={() => onExplore(score.slug)}
                    style={{
                      padding: '5px 14px', borderRadius: 5, border: '1px solid #3b4a6b',
                      background: '#1e3a5f', color: '#93c5fd', cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    → Explore Strategy
                  </button>
                  {hasSetup && (
                    <button
                      onClick={() => navigateToPayoff(score)}
                      style={{
                        padding: '5px 14px', borderRadius: 5, border: '1px solid #2d3a2d',
                        background: '#1a2e1a', color: '#86efac', cursor: 'pointer', fontSize: 12,
                      }}
                    >
                      📈 View in Payoff
                    </button>
                  )}
                  <button
                    disabled={ai?.loading}
                    onClick={() => fetchAi(score)}
                    style={{
                      padding: '5px 14px', borderRadius: 5, border: '1px solid #3d2d5a',
                      background: '#1e1030', color: '#c084fc', cursor: ai?.loading ? 'default' : 'pointer',
                      fontSize: 12, opacity: ai?.loading ? 0.7 : 1,
                    }}
                  >
                    {ai?.loading ? '⏳ Fetching…' : '✨ AI Rationale'}
                  </button>
                </div>

                {/* AI rationale */}
                {ai?.text && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px', background: '#120e1e',
                    border: '1px solid #2d1f4a', borderRadius: 6, fontSize: 12,
                    color: '#d8b4fe', lineHeight: 1.6,
                  }}>
                    <span style={{ color: '#9333ea', fontWeight: 600 }}>✨ AI: </span>{ai.text}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Explore Tab ──────────────────────────────────────────────────────────────

// All 31 slugs in display order matching PROFILES array in the service
const ALL_SLUGS: { slug: string; name: string; category: string }[] = [
  { slug: 'covered-call',               name: 'Covered Call',               category: 'bullish' },
  { slug: 'long-call-vertical',         name: 'Long Call Vertical',         category: 'bullish' },
  { slug: 'call-zebra',                 name: 'Call Zebra',                 category: 'bullish' },
  { slug: 'poor-mans-covered-call',     name: "Poor Man's Covered Call",    category: 'bullish' },
  { slug: 'call-calendar',              name: 'Call Calendar',              category: 'bullish' },
  { slug: 'call-butterfly',             name: 'Call Butterfly',             category: 'bullish' },
  { slug: 'big-lizard',                 name: 'Big Lizard',                 category: 'bullish' },
  { slug: 'covered-put',               name: 'Covered Put',               category: 'bearish' },
  { slug: 'long-put-vertical',         name: 'Long Put Vertical',         category: 'bearish' },
  { slug: 'put-zebra',                 name: 'Put Zebra',                 category: 'bearish' },
  { slug: 'poor-mans-covered-put',     name: "Poor Man's Covered Put",    category: 'bearish' },
  { slug: 'put-calendar',              name: 'Put Calendar',              category: 'bearish' },
  { slug: 'put-butterfly',             name: 'Put Butterfly',             category: 'bearish' },
  { slug: 'reverse-big-lizard',        name: 'Reverse Big Lizard',        category: 'bearish' },
  { slug: 'put-front-ratio',           name: 'Put Front Ratio',           category: 'omni' },
  { slug: 'call-front-ratio',          name: 'Call Front Ratio',          category: 'omni' },
  { slug: 'put-broken-wing-butterfly', name: 'Put BWB',                   category: 'omni' },
  { slug: 'call-broken-wing-butterfly',name: 'Call BWB',                  category: 'omni' },
  { slug: 'call-broken-heart-butterfly',name:'Call BHB',                  category: 'omni' },
  { slug: 'put-broken-heart-butterfly', name:'Put BHB',                   category: 'omni' },
  { slug: 'short-strangle',            name: 'Short Strangle',            category: 'neutral' },
  { slug: 'short-straddle',            name: 'Short Straddle',            category: 'neutral' },
  { slug: 'iron-condor',               name: 'Iron Condor',               category: 'neutral' },
  { slug: 'dynamic-width-iron-condor', name: 'Dynamic IC',                category: 'neutral' },
  { slug: 'iron-fly',                  name: 'Iron Fly',                  category: 'neutral' },
  { slug: 'short-naked-put',           name: 'Short Naked Put',           category: 'neut-bull' },
  { slug: 'short-put-vertical',        name: 'Short Put Vertical',        category: 'neut-bull' },
  { slug: 'jade-lizard',               name: 'Jade Lizard',               category: 'neut-bull' },
  { slug: 'short-naked-call',          name: 'Short Naked Call',          category: 'neut-bear' },
  { slug: 'short-call-vertical',       name: 'Short Call Vertical',       category: 'neut-bear' },
  { slug: 'reverse-jade-lizard',       name: 'Reverse Jade Lizard',       category: 'neut-bear' },
];

const CATEGORY_COLORS: Record<string, string> = {
  bullish: '#22c55e', bearish: '#ef4444', neutral: '#94a3b8',
  omni: '#a78bfa', 'neut-bull': '#4ade80', 'neut-bear': '#f87171',
};

interface ExploreTabProps {
  initialSlug?: string;
  initialCtx?: StrategyLabContext;
  watchlists: Watchlist[];
}

function ExploreTab({ initialSlug, initialCtx, watchlists }: ExploreTabProps) {
  const [ticker, setTicker]       = useState(initialCtx?.ticker ?? '');
  const [slug, setSlug]           = useState(initialSlug ?? 'short-naked-put');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [setup, setSetup]         = useState<StrategySetup | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiText, setAiText]       = useState<string | null>(null);

  // Reset on ticker/slug change
  const handleTickerChange = (v: string) => { setTicker(v); setSetup(null); setError(null); setAiText(null); };
  const handleSlugChange   = (v: string) => { setSlug(v);   setSetup(null); setError(null); setAiText(null); };

  const run = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t || !slug) return;
    setLoading(true);
    setError(null);
    setSetup(null);
    setAiText(null);
    try {
      const result = await window.api.strategyLab.explore(t, slug);
      setSetup(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const fetchAi = async () => {
    if (!setup) return;
    // Build a minimal score/ctx for the rationale prompt
    const dummyScore: StrategyScore = {
      slug, name: ALL_SLUGS.find(s => s.slug === slug)?.name ?? slug,
      category: ALL_SLUGS.find(s => s.slug === slug)?.category ?? '',
      totalScore: 0, grade: 'C', ivScore: 0, directionScore: 0, premiumScore: 0, liquidityScore: 0,
      requiresStock: false, complexity: 'moderate', flags: [], setup, aiRationale: null,
    };
    const dummyCtx: StrategyLabContext = {
      ticker: setup.ticker, underlyingPx: setup.underlyingPrice,
      expiration: setup.expiration, dte: setup.dte,
      currentAtmIv: setup.currentAtmIv,
      ivRank: null, ivPercentile: null, ivDataPoints: 0,
      directionBias: 'neutral', ma20: null, ma50: null, momentum5d: null,
    };
    setAiLoading(true);
    try {
      const text = await window.api.strategyLab.aiRationale(dummyScore, dummyCtx);
      setAiText(text);
    } catch (err) {
      setAiText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAiLoading(false);
    }
  };

  const navigateToPayoff = () => {
    if (!setup || setup.unavailableReason) return;
    window.dispatchEvent(new CustomEvent('navigate-to-payoff', {
      detail: {
        ticker:   setup.ticker,
        spot:     setup.underlyingPrice,
        expiry:   setup.expiration,
        strategy: slug,
        strike:   setup.legs[0]?.strike ?? undefined,
        legs:     setup.legs.map(labLegToPayoffLeg),
      },
    }));
  };

  const selectedProfile = ALL_SLUGS.find(s => s.slug === slug);

  return (
    <div>
      {/* Watchlist picker */}
      <div style={{ marginBottom: 12 }}>
        <WatchlistPicker watchlists={watchlists} onSelect={t => handleTickerChange(t)} />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>TICKER</div>
          <input
            value={ticker}
            onChange={e => handleTickerChange(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && run()}
            placeholder="e.g. AAPL"
            style={{
              padding: '6px 10px', background: '#1e2030', border: '1px solid #2d3748',
              borderRadius: 5, color: '#e2e8f0', fontSize: 14, width: 100,
            }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>STRATEGY</div>
          <select
            value={slug}
            onChange={e => handleSlugChange(e.target.value)}
            style={{
              padding: '6px 10px', background: '#1e2030', border: '1px solid #2d3748',
              borderRadius: 5, color: '#e2e8f0', fontSize: 13, width: '100%',
            }}
          >
            {ALL_SLUGS.map(s => (
              <option key={s.slug} value={s.slug}>
                [{s.category.toUpperCase()}] {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={run}
          disabled={loading || !ticker.trim()}
          style={{
            padding: '7px 18px', background: '#1d4ed8', color: '#fff', border: 'none',
            borderRadius: 5, cursor: loading ? 'default' : 'pointer', fontWeight: 600,
            opacity: loading || !ticker.trim() ? 0.6 : 1,
          }}
        >
          {loading ? '⏳ Loading…' : '🔍 Build Setup'}
        </button>
      </div>

      {/* Strategy category pill */}
      {selectedProfile && (
        <div style={{ marginBottom: 12 }}>
          <span style={{
            fontSize: 12, padding: '3px 10px', borderRadius: 12,
            background: '#1a1a2e', border: '1px solid #2d2d4a',
            color: CATEGORY_COLORS[selectedProfile.category] ?? '#94a3b8',
          }}>
            {selectedProfile.category.toUpperCase()} · {selectedProfile.name}
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ color: '#f87171', background: '#2a1010', padding: '10px 14px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* Setup result */}
      {setup && (
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 8, padding: '14px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span style={{ color: '#e2e8f0', fontWeight: 700, fontSize: 16 }}>{setup.ticker}</span>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>{setup.expiration} ({setup.dte}d)</span>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>Underlying {fmt$(setup.underlyingPrice)}</span>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>ATM IV {fmtPct(setup.currentAtmIv)}</span>
          </div>

          <SetupSummary setup={setup} />

          {!setup.unavailableReason && setup.legs.length > 0 && (
            <LegsTable legs={setup.legs} />
          )}

          {/* Action buttons */}
          {!setup.unavailableReason && (
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button
                onClick={navigateToPayoff}
                style={{
                  padding: '5px 14px', borderRadius: 5, border: '1px solid #2d3a2d',
                  background: '#1a2e1a', color: '#86efac', cursor: 'pointer', fontSize: 12,
                }}
              >
                📈 View in Payoff
              </button>
              <button
                disabled={aiLoading}
                onClick={fetchAi}
                style={{
                  padding: '5px 14px', borderRadius: 5, border: '1px solid #3d2d5a',
                  background: '#1e1030', color: '#c084fc', cursor: aiLoading ? 'default' : 'pointer',
                  fontSize: 12, opacity: aiLoading ? 0.7 : 1,
                }}
              >
                {aiLoading ? '⏳ Fetching…' : '✨ AI Rationale'}
              </button>
            </div>
          )}

          {/* AI rationale */}
          {aiText && (
            <div style={{
              marginTop: 10, padding: '10px 12px', background: '#120e1e',
              border: '1px solid #2d1f4a', borderRadius: 6, fontSize: 12,
              color: '#d8b4fe', lineHeight: 1.6,
            }}>
              <span style={{ color: '#9333ea', fontWeight: 600 }}>✨ AI: </span>{aiText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

type Tab = 'validate' | 'explore';

export function StrategyLabView() {
  const [tab, setTab]             = useState<Tab>('validate');
  const [ticker, setTicker]       = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [result, setResult]       = useState<StrategyLabValidateResult | null>(null);

  // Watchlists — loaded once, shared by both tabs
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  useEffect(() => {
    window.api.watchlists.list().then(setWatchlists).catch(() => {});
  }, []);

  // When user clicks "→ Explore Strategy" from Validate tab
  const [exploreSlug, setExploreSlug]   = useState<string | undefined>(undefined);
  const [exploreCtx, setExploreCtx]     = useState<StrategyLabContext | undefined>(undefined);

  const handleExplore = useCallback((slug: string) => {
    setExploreSlug(slug);
    setExploreCtx(result?.context);
    setTab('explore');
  }, [result]);

  const runValidate = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await window.api.strategyLab.validate(t);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '20px 24px', color: '#e2e8f0', maxWidth: 1000, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#f8fafc' }}>🔬 Strategy Lab</h2>
        <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 13 }}>
          Score all 31 strategies for any ticker using live data — or explore a specific setup.
        </p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '1px solid #1f2937' }}>
        {([['validate', '📊 Validate'], ['explore', '🔍 Explore']] as [Tab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 20px', border: 'none', borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
              background: 'transparent', color: tab === t ? '#93c5fd' : '#64748b',
              cursor: 'pointer', fontWeight: tab === t ? 600 : 400, fontSize: 13,
            }}
          >{label}</button>
        ))}
      </div>

      {/* Validate tab — ticker input always visible at top */}
      {tab === 'validate' && (
        <>
          {/* Watchlist picker */}
          <div style={{ marginBottom: 12 }}>
            <WatchlistPicker
              watchlists={watchlists}
              onSelect={t => { setTicker(t); setResult(null); setError(null); }}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'flex-end' }}>
            <div>
              <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>TICKER</div>
              <input
                value={ticker}
                onChange={e => { setTicker(e.target.value.toUpperCase()); setResult(null); setError(null); }}
                onKeyDown={e => e.key === 'Enter' && runValidate()}
                placeholder="e.g. SPY"
                style={{
                  padding: '7px 12px', background: '#1e2030', border: '1px solid #2d3748',
                  borderRadius: 5, color: '#e2e8f0', fontSize: 15, width: 110,
                }}
              />
            </div>
            <button
              onClick={runValidate}
              disabled={loading || !ticker.trim()}
              style={{
                padding: '8px 20px', background: '#1d4ed8', color: '#fff', border: 'none',
                borderRadius: 5, cursor: loading ? 'default' : 'pointer', fontWeight: 700, fontSize: 14,
                opacity: loading || !ticker.trim() ? 0.6 : 1,
              }}
            >
              {loading ? '⏳ Running…' : '▶ Run Validate'}
            </button>
            {loading && (
              <span style={{ color: '#94a3b8', fontSize: 12 }}>Fetching live chain + bars — ~5–15s…</span>
            )}
          </div>

          {error && (
            <div style={{ color: '#f87171', background: '#2a1010', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
              ⚠ {error}
            </div>
          )}

          {result && (
            <ValidateTab ctx={result.context} scores={result.scores} onExplore={handleExplore} />
          )}

          {!result && !loading && !error && (
            <div style={{ textAlign: 'center', color: '#4b5563', fontSize: 14, paddingTop: 60 }}>
              Enter a ticker and click Run Validate to score all 31 strategies with live data.
            </div>
          )}
        </>
      )}

      {/* Explore tab */}
      {tab === 'explore' && (
        <ExploreTab initialSlug={exploreSlug} initialCtx={exploreCtx} watchlists={watchlists} />
      )}
    </div>
  );
}
