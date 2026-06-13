// Daily Intelligence Brief view — shows today's trade shortlist by strategy.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §6

import { useState, useEffect, useCallback } from 'react';
import type { DailyBriefEntry, BriefPick, ScoringStrategy, StrategyLabValidateResult, StrategyLabGrade, StrategySetup, SetupLeg, PayoffLeg, BriefAccuracy, CriticVerdict, BriefPerformanceSummary, BriefHealthTrend } from '@shared/types.js';

const STRATEGY_LABELS: Record<ScoringStrategy, string> = {
  wheel:   '🎡  Wheel — CSP / Covered Call',
  bullish: '🐂  Bullish — Call Spread / Long Call',
  bearish: '🐻  Bearish — Put Spread / Long Put',
  income:  '💰  Options Income — Strangle / Iron Condor',
  buy:     '📈  Buy / Swing Trade',
  inflection: '🎯  Inflection — Breakout Credit Spread',
};

// Human-readable labels for signal keys shown in chips
const SIGNAL_LABELS: Record<string, string> = {
  ivRank:           'IV Rank',
  premiumYield:     'Prem Yield',
  premiumRiskRatio: 'Prem/Risk',
  fundamentalScore: 'Fundamentals',
  fundamentalWeakness: 'Fund. Weakness',
  technicalNeutral: 'RSI Neutral',
  rsiMomentum:      'RSI',
  rsiOverbought:    'RSI',
  optionLiquidity:  'Liq.',
  recentVolatility: 'Recent Vol',
  trendStrength:    'Trend Strength',
  downtrendScore:   'Downtrend',
  trendNeutral:     'Trend Neutral',
  earningsGrowth:   'Earnings',
  priceMomentumPct: '52w Momentum',
  priceDecayPct:    '52w Decay',
  breakoutScore:    'Breakout',
  buySignalScore:   'Buy Signal',
};

const STRATEGY_ORDER: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy', 'inflection'];

// Strategy Lab slugs that represent each Brief strategy.
// Used to find the relevant structure grade inside strategyLabResult.
const STRATEGY_TO_SLUGS: Record<ScoringStrategy, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
  inflection: ['short-put-vertical', 'short-call-vertical'],
};

// Human-readable short name for the primary slug shown on the card
const SLUG_SHORT: Record<string, string> = {
  'short-naked-put':           'CSP',
  'covered-call':              'Covered Call',
  'long-call-vertical':        'Call Spread',
  'big-lizard':                'Big Lizard',
  'call-zebra':                'Call Zebra',
  'call-butterfly':            'Call Butterfly',
  'poor-mans-covered-call':    'PMCC',
  'long-put-vertical':         'Put Spread',
  'reverse-big-lizard':        'Rev. Big Lizard',
  'put-zebra':                 'Put Zebra',
  'put-butterfly':             'Put Butterfly',
  'poor-mans-covered-put':     'PMCP',
  'short-strangle':            'Strangle',
  'iron-condor':               'Iron Condor',
  'short-straddle':            'Straddle',
  'dynamic-width-iron-condor': 'Dyn. IC',
  'iron-fly':                  'Iron Fly',
  'call-calendar':             'Call Calendar',
  'short-put-vertical':        'Bull Put Spread',
  'short-call-vertical':       'Bear Call Spread',
};

const GRADE_COLOR: Record<StrategyLabGrade, string> = {
  'A+': '#3fb950',
  'A':  '#57cc6e',
  'B':  '#e3a008',
  'C':  '#f0783a',
  'F':  '#f85149',
};

function gradeOf(result: StrategyLabValidateResult, slugs: string[]): { slug: string; name: string; grade: StrategyLabGrade; score: number; setup: StrategySetup | null } | null {
  let best: (typeof result.scores)[number] | null = null;
  for (const s of result.scores) {
    if (slugs.includes(s.slug)) {
      if (!best || s.totalScore > best.totalScore) best = s;
    }
  }
  if (!best) return null;
  return { slug: best.slug, name: best.name, grade: best.grade, score: best.totalScore, setup: best.setup };
}

// Grade ordering — mirrors CriticService.GRADE_RANK ('A+' must be present).
const GRADE_RANK: Record<StrategyLabGrade, number> = { 'A+': 6, 'A': 5, 'B': 4, 'C': 3, 'F': 1 };

// Buy is stock-first: its relevant structures are all debit and grade C/F
// systematically in high-IV regimes. When no available relevant structure is
// B or better, the pick is presented as a plain stock purchase.
// Mirrors CriticService.shouldPresentAsStock().
function presentAsStock(result: StrategyLabValidateResult, strategy: ScoringStrategy): boolean {
  if (strategy !== 'buy') return false;
  const slugs = STRATEGY_TO_SLUGS[strategy];
  for (const s of result.scores) {
    if (slugs.includes(s.slug) && s.setup && !s.setup.unavailableReason &&
        (GRADE_RANK[s.grade] ?? 0) >= GRADE_RANK['B']) {
      return false;
    }
  }
  return true;
}

// Format ISO expiry as "Jul 17"
function fmtExpShort(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Return the primary (short-side) strike for a setup — the most relevant single number to show.
function primaryStrike(setup: StrategySetup): number | null {
  const shortLeg = setup.legs.find(l => l.action === 'sell');
  return (shortLeg ?? setup.legs[0])?.strike ?? null;
}

function bestOverall(result: StrategyLabValidateResult): { name: string; grade: StrategyLabGrade } | null {
  const top = result.scores[0];
  return top ? { name: top.name, grade: top.grade } : null;
}

function StrategyLabSummary({
  strategyLabResult,
  strategy,
}: {
  strategyLabResult: object | null;
  strategy: ScoringStrategy;
}) {
  if (!strategyLabResult) return null;

  const result = strategyLabResult as StrategyLabValidateResult;
  if (!result.scores?.length) return null;

  const slugs = STRATEGY_TO_SLUGS[strategy];
  const relevant = gradeOf(result, slugs);
  const best = bestOverall(result);

  if (!relevant && !best) return null;

  const relevantIsBest = relevant && best && relevant.slug === result.scores[0]?.slug;
  const stockFirst = presentAsStock(result, strategy);

  // Setup detail line for the relevant structure (strike · expiry · premium)
  const setup = relevant?.setup ?? null;
  const setupAvailable = setup !== null && !setup.unavailableReason;
  const strike = setupAvailable ? primaryStrike(setup!) : null;
  const credit = setupAvailable && setup!.netCredit !== null && setup!.netCredit > 0 ? setup!.netCredit : null;
  const debit  = setupAvailable && setup!.netDebit  !== null && setup!.netDebit  > 0 ? setup!.netDebit  : null;

  return (
    <div className="pick-lab-summary">
      {/* Grade row */}
      <div className="pick-lab-grade-row">
        {stockFirst && (
          <span className="lab-grade-item" title="All option structures graded C/F in the current IV regime — buy shares; the structure shown is an optional alternative">
            <span className="lab-grade-label" style={{ color: '#3fb950', fontWeight: 700 }}>📈 Buy Shares</span>
          </span>
        )}
        {relevant ? (
          <span className="lab-grade-item" style={stockFirst ? { opacity: 0.7 } : undefined}>
            {stockFirst && <span className="lab-grade-sep">·  Optional:</span>}
            <span className="lab-grade-label">{SLUG_SHORT[relevant.slug] ?? relevant.name}</span>
            <span className="lab-grade-badge" style={{ color: GRADE_COLOR[relevant.grade], borderColor: GRADE_COLOR[relevant.grade] }}>
              {relevant.grade}
            </span>
          </span>
        ) : (
          !stockFirst && <span className="lab-grade-item lab-grade-missing">No {strategy} structure graded</span>
        )}
        {best && !relevantIsBest && (
          <>
            <span className="lab-grade-sep">·  Best fit:</span>
            <span className="lab-grade-item">
              <span className="lab-grade-label">{best.name}</span>
              <span className="lab-grade-badge" style={{ color: GRADE_COLOR[best.grade], borderColor: GRADE_COLOR[best.grade] }}>
                {best.grade}
              </span>
            </span>
          </>
        )}
      </div>

      {/* Setup detail row — strike · expiry · premium */}
      {setupAvailable && (
        <div className="pick-setup-detail">
          {strike !== null && <span className="setup-strike">${strike}</span>}
          <span className="setup-expiry">{fmtExpShort(setup!.expiration)}</span>
          {credit !== null && <span className="setup-premium setup-credit">${credit.toFixed(2)} cr</span>}
          {debit  !== null && <span className="setup-premium setup-debit">${debit.toFixed(2)}  dr</span>}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  });
}

function isStale(validUntil: string): boolean {
  return new Date() > new Date(validUntil);
}

// generatedAt is stored as UTC by SQLite 'now'. Convert to ET date so a run
// at 10:30pm ET on 6/3 doesn't display as 6/4 (which is what UTC would show).
function toETDate(isoStr: string): string {
  return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function scoreBg(score: number): string {
  if (score >= 75) return '#1f6b38';
  if (score >= 55) return '#7a5400';
  return '#7a1f1a';
}
function scoreColor(score: number): string {
  if (score >= 75) return '#3fb950';
  if (score >= 55) return '#e3a008';
  return '#f85149';
}

function fmtRaw(raw: number | null, key: string): string {
  if (raw === null) return '—';
  // Percentage signals
  if (['ivRank','fundamentalScore','fundamentalWeakness','trendStrength',
       'downtrendScore','earningsGrowth','breakoutScore','buySignalScore',
       'rsiMomentum','rsiOverbought','technicalNeutral'].includes(key)) {
    return raw.toFixed(0);
  }
  // Momentum — show sign + 1dp
  if (key === 'recentVolatility') return raw.toFixed(1) + '%';
  if (key === 'priceMomentumPct' || key === 'priceDecayPct') {
    return (raw >= 0 ? '+' : '') + raw.toFixed(1) + '%';
  }
  // Liquidity score 0–10
  if (key === 'optionLiquidity') return raw.toFixed(1) + '/10';
  // Yield/return — annualised %
  if (key === 'premiumYield' || key === 'premiumRiskRatio') return raw.toFixed(1) + '%';
  return raw.toFixed(1);
}

// Convert a StrategySetup leg to a PayoffLeg for the Payoff Visualizer deep-link.
function labLegToPayoffLeg(leg: SetupLeg, idx: number): PayoffLeg {
  const side = leg.action === 'buy' ? 'Long' : 'Short';
  const type = leg.side.charAt(0).toUpperCase() + leg.side.slice(1);
  return {
    id: `brief-leg-${idx}`,
    side: leg.action,
    type: leg.side,
    strike: leg.strike,
    expiry: leg.expiration,
    premium: leg.mid,
    quantity: leg.qty,
    delta: leg.delta,
    theta: null,
    vega: null,
    iv: leg.iv,
    label: `${side} ${type} $${leg.strike}`,
  };
}

const CRITIC_LABEL: Record<CriticVerdict['verdict'], string> = {
  pass:    '✓ Pass',
  caution: '⚠ Caution',
  flag:    '⚑ Flag',
};

function CriticBadge({ verdict }: { verdict: CriticVerdict }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="critic-verdict">
      <div className="critic-badge-row">
        <span className="critic-label">🔍 Critic:</span>
        <span className={`critic-badge critic-badge-${verdict.verdict}`}>
          {CRITIC_LABEL[verdict.verdict]}
        </span>
        {verdict.confidence === 'low' && (
          <span className="critic-confidence-low" title="Critic ran without LLM synthesis (API key missing or unavailable)">
            low confidence
          </span>
        )}
        <button
          className="critic-expand-btn"
          onClick={() => setExpanded(p => !p)}
          aria-label={expanded ? 'Collapse critic details' : 'Expand critic details'}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {expanded && (
        <div className="critic-detail">
          {verdict.rationale && (
            <p className="critic-rationale-text">{verdict.rationale}</p>
          )}
          {verdict.flags.length > 0 && (
            <ul className="critic-flags-list">
              {verdict.flags.map((flag, i) => (
                <li key={i} className={`critic-flag critic-flag-${flag.severity}`}>
                  <span className="critic-flag-icon">{flag.severity === 'warning' ? '⚠' : 'ℹ'}</span>
                  {flag.description}
                </li>
              ))}
            </ul>
          )}
          {!verdict.rationale && verdict.flags.length === 0 && (
            <p className="critic-rationale-text muted">No specific concerns identified.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TopSignals({ signals }: { signals: BriefPick['signals'] }) {
  const entries = Object.entries(signals)
    .filter(([, v]) => !v.missing && v.raw !== null)
    .sort((a, b) => (b[1].weight * b[1].normalized) - (a[1].weight * a[1].normalized))
    .slice(0, 4);

  if (entries.length === 0) return null;
  return (
    <div className="pick-signals">
      {entries.map(([key, v]) => (
        <span key={key} className="signal-chip">
          <span className="signal-chip-label">{SIGNAL_LABELS[key] ?? key}</span>
          <span className="signal-chip-value">{fmtRaw(v.raw, key)}</span>
        </span>
      ))}
    </div>
  );
}

// Quick-navigation row — Payoff, Validate, Options, Analysis, E*Trade buttons
// pre-populated from strategyLabResult.
function PickNavRow({ pick }: { pick: BriefPick }) {
  const result = pick.strategyLabResult ? (pick.strategyLabResult as StrategyLabValidateResult) : null;
  const best   = result?.scores?.[0] ?? null;
  const setup  = best?.setup ?? null;
  const expiry = setup?.expiration ?? null;
  const legs   = setup?.legs?.length
    ? setup.legs.map((l, i) => labLegToPayoffLeg(l, i))
    : null;

  const handleValidate = () => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', {
      detail: { ticker: pick.ticker },
    }));
  };

  const handleAnalysis = () => {
    window.dispatchEvent(new CustomEvent('navigate-to-analysis', {
      detail: { ticker: pick.ticker },
    }));
  };

  const handleEtrade = () => {
    window.open(
      `https://us.etrade.com/e/t/invest/quotesandresearch?content=3&sym=${pick.ticker.toLowerCase()}`,
      '_blank'
    );
  };

  const handleOptions = () => {
    window.dispatchEvent(new CustomEvent('navigate-to-options', {
      detail: { ticker: pick.ticker, ...(expiry ? { expiry } : {}) },
    }));
  };

  const handlePayoff = () => {
    const detail: Record<string, unknown> = { ticker: pick.ticker };
    if (pick.price != null)  detail.spot     = pick.price;
    if (expiry)              detail.expiry   = expiry;
    if (best)                detail.strategy = best.slug;
    if (legs)                detail.legs     = legs;
    window.dispatchEvent(new CustomEvent('navigate-to-payoff', { detail }));
  };

  const expiryLabel = expiry ? ` · ${expiry}` : '';

  return (
    <div className="pick-nav-row">
      <button className="pick-nav-btn" onClick={handlePayoff}
        title={legs ? `Open Payoff Visualizer pre-loaded with ${best?.name ?? 'strategy'} legs` : 'Open Payoff Visualizer for this ticker'}>
        📊 Payoff
      </button>
      <button className="pick-nav-btn" onClick={handleValidate}
        title="Open Validate for this ticker">
        ✓ Validate
      </button>
      <button className="pick-nav-btn" onClick={handleOptions}
        title={expiry ? `Open Options Chain — expiry ${expiry}` : 'Open Options Chain for this ticker'}>
        📋 Options{expiryLabel}
      </button>
      <button className="pick-nav-btn" onClick={handleAnalysis}
        title="Run Analysis for this ticker">
        🔍 Analysis
      </button>
      <button className="pick-nav-btn" onClick={handleEtrade}
        title="Open on E*Trade">
        🏦 E*Trade
      </button>
    </div>
  );
}

function PickCard({
  pick,
  strategy,
  onGoToStrategyLab,
}: {
  pick: BriefPick;
  strategy: ScoringStrategy;
  onGoToStrategyLab: (ticker: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const result = pick.strategyLabResult ? (pick.strategyLabResult as StrategyLabValidateResult) : null;
  const labGrade = result ? gradeOf(result, STRATEGY_TO_SLUGS[strategy]) : null;
  const verdict = pick.criticVerdict?.verdict ?? null;

  return (
    <div className={`brief-pick-card brief-pick-card--collapsible${expanded ? ' brief-pick-card--expanded' : ''}`}>
      {/* Summary row — always visible, click to expand/collapse */}
      <button className="pick-summary-row" onClick={() => setExpanded(p => !p)}>
        <span className="pick-rank">#{pick.rank}</span>
        <span className="pick-ticker">{pick.ticker}</span>
        {pick.price != null && (
          <span className="pick-price">${pick.price.toFixed(2)}</span>
        )}
        <span
          className="pick-score-badge"
          style={{ background: scoreBg(pick.compositeScore), color: scoreColor(pick.compositeScore), cursor: 'help' }}
          title={`Composite score: ${pick.compositeScore.toFixed(1)}\nScores are strategy-specific — not comparable across strategies (each uses different signals and weights).`}
        >
          {pick.compositeScore.toFixed(1)}
        </span>
        {labGrade && (
          <span className="pick-summary-lab">
            <span className="lab-grade-label">{SLUG_SHORT[labGrade.slug] ?? labGrade.name}</span>
            <span className="lab-grade-badge" style={{ color: GRADE_COLOR[labGrade.grade], borderColor: GRADE_COLOR[labGrade.grade] }}>
              {labGrade.grade}
            </span>
          </span>
        )}
        {verdict && (
          <span className={`pick-summary-verdict critic-badge-${verdict}`}>
            {CRITIC_LABEL[verdict]}
          </span>
        )}
        {strategy === 'wheel' && pick.price != null && (
          <span className="pick-capital" title="Cash needed to secure 1 CSP (100 shares)">
            ~${Math.round(pick.price * 100).toLocaleString()}
          </span>
        )}
        <span className="pick-summary-chevron">{expanded ? '▼' : '▶'}</span>
      </button>

      {/* Detail section — visible when expanded */}
      {expanded && (
        <div className="pick-detail">
          <div className="pick-detail-actions">
            {pick.validated
              ? <span className="pick-badge validated">✓ Validated</span>
              : <span className="pick-badge unvalidated">Unvalidated</span>
            }
            <button className="pick-lab-btn" onClick={() => onGoToStrategyLab(pick.ticker)}>
              Strategy Lab →
            </button>
          </div>
          <TopSignals signals={pick.signals} />
          <StrategyLabSummary strategyLabResult={pick.strategyLabResult ?? null} strategy={strategy} />
          <PickNavRow pick={pick} />
          {pick.aiRationale
            ? <p className="pick-rationale">{pick.aiRationale}</p>
            : <p className="pick-rationale muted">AI reasoning unavailable</p>
          }
          {pick.criticVerdict
            ? <CriticBadge verdict={pick.criticVerdict} />
            : <div className="critic-verdict critic-unavailable">🔍 Second opinion unavailable</div>
          }
        </div>
      )}
    </div>
  );
}

function criticSummary(picks: BriefPick[]): { pass: number; caution: number; flag: number } | null {
  if (!picks.some(p => p.criticVerdict)) return null;
  return picks.reduce(
    (acc, p) => {
      if (!p.criticVerdict) return acc;
      acc[p.criticVerdict.verdict]++;
      return acc;
    },
    { pass: 0, caution: 0, flag: 0 },
  );
}

function StrategySection({
  strategy,
  entry,
  collapsed,
  onToggle,
  onGoToStrategyLab,
}: {
  strategy: ScoringStrategy;
  entry: DailyBriefEntry | undefined;
  collapsed: boolean;
  onToggle: () => void;
  onGoToStrategyLab: (ticker: string) => void;
}) {
  const summary = entry ? criticSummary(entry.picks) : null;

  return (
    <div className="brief-strategy-section">
      <button className="strategy-header" onClick={onToggle}>
        <span className="strategy-label">{STRATEGY_LABELS[strategy]}</span>
        {entry && (
          <span className="strategy-pick-count">
            {entry.picks.length} pick{entry.picks.length !== 1 ? 's' : ''}
          </span>
        )}
        {summary && (
          <span className="strategy-critic-summary">
            {summary.pass > 0 && <span className="critic-summary-pass">{summary.pass} pass</span>}
            {summary.caution > 0 && <span className="critic-summary-caution">{summary.caution} caution</span>}
            {summary.flag > 0 && <span className="critic-summary-flag">{summary.flag} flagged</span>}
          </span>
        )}
        <span className="strategy-chevron">{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div className="strategy-picks">
          {!entry || entry.picks.length === 0 ? (
            <div className="empty-section">No picks for this strategy today.</div>
          ) : (
            entry.picks.map(pick => (
              <PickCard
                key={pick.ticker}
                pick={pick}
                strategy={strategy}
                onGoToStrategyLab={onGoToStrategyLab}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}


interface DailyBriefViewProps {
  onGoToStrategyLab?: (ticker: string) => void;
}

export function DailyBriefView({ onGoToStrategyLab }: DailyBriefViewProps) {
  const [briefs, setBriefs] = useState<DailyBriefEntry[]>([]);
  const [history, setHistory] = useState<DailyBriefEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);
  const [accuracyMap, setAccuracyMap] = useState<Map<string, BriefAccuracy>>(new Map());

  const [perfSummary, setPerfSummary]     = useState<BriefPerformanceSummary | null>(null);
  const [healthTrend, setHealthTrend]     = useState<BriefHealthTrend[]>([]);

  const [collapsed, setCollapsed] = useState<Record<ScoringStrategy, boolean>>(() => {
    try {
      const saved = localStorage.getItem('brief-collapsed');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const latest = await window.api.scoring.getLatestBrief();
      setBriefs(latest as DailyBriefEntry[]);
    } catch (err) {
      console.error('[brief] load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const h = await window.api.scoring.getBriefHistory(30);
      setHistory(h as DailyBriefEntry[]);
      // Load accuracy data for all history dates in one batch call
      const dates = [...new Set((h as DailyBriefEntry[]).map(e => toETDate(e.generatedAt)))];
      if (dates.length > 0) {
        try {
          const acc = await window.api.paper.briefAccuracy(dates);
          setAccuracyMap(new Map(acc.map(a => [a.date, a])));
        } catch { /* paper trading may not have data yet — non-fatal */ }
      }
    } catch (err) {
      console.error('[brief] history error:', err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load prior-brief performance summary for the header banner (B-01)
  useEffect(() => {
    window.api.paper.briefPerformanceSummary()
      .then(summary => setPerfSummary(summary))
      .catch(() => { /* non-fatal — no paper data yet */ });
  }, []);

  // Load critic pass-rate trend per strategy (B-02)
  useEffect(() => {
    window.api.scoring.briefHealthTrend()
      .then(trends => setHealthTrend(trends))
      .catch(() => { /* non-fatal */ });
  }, []);

  useEffect(() => {
    if (showHistory) loadHistory();
  }, [showHistory, loadHistory]);

  // Listen for batch progress completion to auto-refresh
  useEffect(() => {
    const unsub = window.api.batch.onProgress(evt => {
      if (evt.jobId === 'daily-intelligence-brief') {
        if (evt.message?.includes('Brief generated')) {
          setRunning(false);
          load();
        }
      }
    });
    return () => unsub();
  }, [load]);

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await window.api.batch.runNow('daily-intelligence-brief');
    } catch (err) {
      console.error('[brief] run error:', err);
      setRunning(false);
    }
  };

  const handleResendEmail = async () => {
    setResending(true);
    setResendMsg(null);
    try {
      const result = await window.api.scoring.resendBriefEmail();
      setResendMsg(result.message);
    } catch (err) {
      setResendMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResending(false);
      setTimeout(() => setResendMsg(null), 6000);
    }
  };

  const toggleCollapse = (strategy: ScoringStrategy) => {
    setCollapsed(prev => {
      const next = { ...prev, [strategy]: !prev[strategy] };
      localStorage.setItem('brief-collapsed', JSON.stringify(next));
      return next;
    });
  };

  const goToStrategyLab = (ticker: string) => {
    onGoToStrategyLab?.(ticker);
  };

  // Pick displayed briefs — either latest or selected historical
  const displayedBriefs = selectedHistoryId !== null
    ? history.filter(b => {
        // Show all strategies for the same run group (same generated_at prefix day)
        const sel = history.find(h => h.id === selectedHistoryId);
        if (!sel) return false;
        return toETDate(b.generatedAt) === toETDate(sel.generatedAt);
      })
    : briefs;

  const latestEntry = displayedBriefs[0];
  const generatedAt = latestEntry?.generatedAt ?? null;
  const validUntil = latestEntry?.validUntil ?? null;
  const stale = validUntil ? isStale(validUntil) : false;

  const briefMap = new Map(displayedBriefs.map(b => [b.strategy as ScoringStrategy, b]));

  // Unique history dates for the dropdown
  const historyDates = Array.from(new Map(
    history.map(h => [toETDate(h.generatedAt), h])
  ).values()).slice(0, 30);

  return (
    <div className="view daily-brief-view">
      <div className="brief-header toolbar">
        <h2>Daily Intelligence Brief</h2>
        {generatedAt && (
          <span className="meta">{fmtDate(generatedAt)}</span>
        )}
        {stale && (
          <span className="stale-badge">This brief is from a previous session — run to refresh</span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="brief-history-btn"
          onClick={() => { setShowHistory(p => !p); setSelectedHistoryId(null); }}
        >
          History {showHistory ? '▲' : '▼'}
        </button>
        <button
          className="brief-resend-btn"
          onClick={handleResendEmail}
          disabled={resending || running}
          title="Re-generate email + PDF from the last saved brief and send to your inbox"
        >
          {resending ? 'Sending…' : 'Resend Email'}
        </button>
        {resendMsg && (
          <span className="brief-resend-msg">{resendMsg}</span>
        )}
        <button
          className="brief-run-btn"
          onClick={handleRunNow}
          disabled={running}
        >
          {running ? 'Running…' : 'Run Now'}
        </button>
      </div>

      {/* B-01: Prior-brief performance banner */}
      {perfSummary && perfSummary.strategies.length > 0 && (
        <div className="brief-perf-banner">
          <span
            className="brief-perf-label"
            title={
              'Day+5 hit-rate: how many picks from the last brief closed profitable within 5 calendar days.\n' +
              'Format per strategy:  hits / total picks  (avg % return across all closed picks)\n' +
              'Colour: green ≥60% hit-rate · amber ≥40% · red <40%'
            }
            style={{ cursor: 'help' }}
          >
            📊 Last brief ({perfSummary.briefDate}):
          </span>
          {perfSummary.strategies.map(s => {
            const hitRate = s.picks > 0 ? Math.round((s.hits / s.picks) * 100) : 0;
            const ret = s.avgReturnPct;
            const retStr = ret !== null
              ? (ret >= 0 ? `+${ret.toFixed(1)}%` : `${ret.toFixed(1)}%`)
              : null;
            const color = hitRate >= 60 ? '#3fb950' : hitRate >= 40 ? '#e3a008' : '#f85149';
            const chipTip =
              `${s.strategy}: ${s.hits} of ${s.picks} picks were profitable by Day+5 (${hitRate}% hit-rate)` +
              (retStr ? `\nAvg return across all ${s.picks} picks: ${retStr}` : '');
            return (
              <span key={s.strategy} className="brief-perf-chip" title={chipTip} style={{ cursor: 'help' }}>
                <span style={{ color: '#89b4fa', textTransform: 'capitalize' }}>{s.strategy}</span>
                {' '}
                <span style={{ color, fontWeight: 700 }}>{s.hits}/{s.picks}</span>
                {retStr && (
                  <span style={{ color: ret! >= 0 ? '#3fb950' : '#f85149', marginLeft: 3 }}>
                    {retStr} avg
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* B-02: Critic pass-rate trend banner */}
      {healthTrend.some(t => t.currentPct !== null) && (
        <div className="brief-perf-banner" style={{ gap: 12 }}>
          <span
            className="brief-perf-label"
            title={
              'AI-critic pass-rate: % of picks rated "pass" (vs "caution" or "flag") by the post-brief critic across up to 7 recent briefs.\n' +
              'Trend arrow: ↑ improving · → stable · ↓ declining\n' +
              '  (computed by comparing older-half vs newer-half average pass rates; >8pp shift = directional)\n' +
              'Colour: green ≥60% pass-rate · amber ≥40% · red <40%'
            }
            style={{ cursor: 'help' }}
          >
            🔬 Critic trend (last 7 briefs):
          </span>
          {healthTrend
            .filter(t => t.currentPct !== null)
            .map(t => {
              const arrow =
                t.trend === 'improving'  ? '↑' :
                t.trend === 'declining'  ? '↓' :
                t.trend === 'stable'     ? '→' : '—';
              const arrowColor =
                t.trend === 'improving'  ? '#3fb950' :
                t.trend === 'declining'  ? '#f85149' : '#e3a008';
              const pct = t.currentPct!;
              const pctColor = pct >= 60 ? '#3fb950' : pct >= 40 ? '#e3a008' : '#f85149';

              // Build sparkline history string from rated points
              const ratedPoints = t.points.filter(p => p.passRate !== null);
              const historyStr = ratedPoints.length > 1
                ? ratedPoints.map(p => `${p.date}: ${p.passes}/${p.total} pass (${p.passRate}%)`).join('\n')
                : '';
              const trendLabel =
                t.trend === 'improving' ? 'improving (pass-rate rising)' :
                t.trend === 'declining' ? 'declining (pass-rate falling)' :
                t.trend === 'stable'    ? 'stable (pass-rate flat)' : 'insufficient data';
              const chipTip =
                `${t.strategy}: ${pct}% critic pass-rate on most recent brief\n` +
                `Trend: ${trendLabel}\n` +
                (historyStr ? `\nPass-rate history (oldest → newest):\n${historyStr}` : '');

              return (
                <span key={t.strategy} className="brief-perf-chip" title={chipTip} style={{ cursor: 'help' }}>
                  <span style={{ color: '#89b4fa', textTransform: 'capitalize' }}>{t.strategy}</span>
                  {' '}
                  <span style={{ color: arrowColor, fontWeight: 700 }}>{arrow}</span>
                  <span style={{ color: pctColor, marginLeft: 2 }}>{pct}%</span>
                </span>
              );
            })}
        </div>
      )}

      {showHistory && history.length > 0 && (
        <div className="brief-history-bar">
          {historyDates.map(h => {
            const date = toETDate(h.generatedAt);
            const acc = accuracyMap.get(date);
            const isActive = selectedHistoryId !== null && date === toETDate(history.find(x => x.id === selectedHistoryId)?.generatedAt ?? '');
            return (
              <button
                key={h.id}
                className={`history-date-btn ${isActive ? 'active' : ''}`}
                onClick={() => setSelectedHistoryId(selectedHistoryId === h.id ? null : h.id)}
                title={acc?.accuracy != null ? `${acc.wins}/${acc.totalClosed} picks profitable` : undefined}
              >
                {date}
                {acc?.accuracy != null && (
                  <span className="brief-accuracy-chip" style={{ color: acc.accuracy >= 60 ? '#3fb950' : acc.accuracy >= 40 ? '#e3a008' : '#f85149' }}>
                    {acc.accuracy.toFixed(0)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Accuracy banner for selected historical brief */}
      {selectedHistoryId !== null && (() => {
        const selDate = toETDate(history.find(x => x.id === selectedHistoryId)?.generatedAt ?? '');
        const acc = accuracyMap.get(selDate);
        if (!acc || acc.totalClosed === 0) return null;
        const pct = acc.accuracy;
        const color = pct !== null ? (pct >= 60 ? '#3fb950' : pct >= 40 ? '#e3a008' : '#f85149') : '#8b949e';
        return (
          <div className="brief-accuracy-banner" style={{ borderColor: color + '44', background: color + '11' }}>
            <span style={{ color }}>
              {pct !== null ? `${pct.toFixed(0)}% accurate` : 'Insufficient data'}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              · {acc.wins} of {acc.totalClosed} picks closed profitably
              {acc.accuracy === null ? ' (need ≥ 3 closed picks to report)' : ''}
            </span>
          </div>
        );
      })()}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : displayedBriefs.length === 0 ? (
        <div className="brief-empty-state">
          <p>No brief yet for today.</p>
          <p className="meta">Run the Daily Intelligence Brief job to generate your first shortlist.</p>
          <button onClick={handleRunNow} disabled={running}>
            {running ? 'Running…' : 'Run Now'}
          </button>
        </div>
      ) : (
        <div className="brief-strategies">
          {STRATEGY_ORDER.map(strategy => (
            <StrategySection
              key={strategy}
              strategy={strategy}
              entry={briefMap.get(strategy)}
              collapsed={collapsed[strategy] ?? false}
              onToggle={() => toggleCollapse(strategy)}
              onGoToStrategyLab={goToStrategyLab}
            />
          ))}
        </div>
      )}
    </div>
  );
}
