// Daily Intelligence Brief view — shows today's trade shortlist by strategy.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §6

import { useState, useEffect, useCallback } from 'react';
import type { DailyBriefEntry, BriefPick, ScoringStrategy, StrategyLabValidateResult, StrategyLabGrade, StrategySetup, SetupLeg, PayoffLeg, BriefAccuracy, CriticVerdict, BriefPerformanceSummary, BriefHealthTrend } from '@shared/types.js';
import { STRATEGY_RELEVANT_SLUGS, pickDisplayStructure } from '@shared/strategy-structures.js';
import { convictionOf, rsiOf, passesFilter, definedRiskAlternative, level2DebitAlternative, type PassFilter } from '@shared/brief-ranking.js';

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

// Order sections by the day's TOP composite score per strategy (highest first);
// STRATEGY_ORDER breaks ties and orders strategies with no picks last. Composite scores
// are strategy-specific (each uses different signals/weights), so this is a surfacing
// heuristic — it floats the day's strongest-scored pick to the top, not a cross-strategy
// ranking. Mirrored in brief-report-builder.ts (email/PDF) to keep surfaces in sync.
function orderByTopComposite(order: ScoringStrategy[], briefMap: Map<ScoringStrategy, DailyBriefEntry>): ScoringStrategy[] {
  const top = (s: ScoringStrategy): number => {
    const picks = briefMap.get(s)?.picks ?? [];
    return picks.length ? Math.max(...picks.map(p => p.compositeScore)) : -1;
  };
  return [...order].sort((a, b) => (top(b) - top(a)) || (order.indexOf(a) - order.indexOf(b)));
}

// Strategy Lab slugs that represent each Brief strategy.
// Used to find the relevant structure grade inside strategyLabResult.
// Shared single source of truth (see '@shared/strategy-structures.js'); re-asserted
// with the finite-key type so existing ScoringStrategy-indexed reads stay defined.
const STRATEGY_TO_SLUGS = STRATEGY_RELEVANT_SLUGS as Record<ScoringStrategy, string[]>;

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

// Relevant structure to feature for a pick — shared selector (defined-risk preferred over
// unbounded), so the card matches what the Critic evaluated and the email/PDF show.
function gradeOf(result: StrategyLabValidateResult, strategy: ScoringStrategy, breakoutDirection?: 'up' | 'down'): { slug: string; name: string; grade: StrategyLabGrade; score: number; setup: StrategySetup | null } | null {
  const best = pickDisplayStructure(result.scores, strategy, breakoutDirection);
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
  breakoutDirection,
}: {
  strategyLabResult: object | null;
  strategy: ScoringStrategy;
  breakoutDirection?: 'up' | 'down';
}) {
  if (!strategyLabResult) return null;

  const result = strategyLabResult as StrategyLabValidateResult;
  if (!result.scores?.length) return null;

  const relevant = gradeOf(result, strategy, breakoutDirection);
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
      {/* Single line: relevant structure + its setup, then the Top-lab-pick cross-reference:
          "CSP A+ : $470 Jul 17 $2305.00 cr | Top lab pick: Big Lizard A+". The setup sits right
          after the relevant grade so its strike/expiry/premium read as that structure's. */}
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

        {/* Relevant structure's setup, inline right after its grade. */}
        {setupAvailable && (
          <span className="pick-setup-detail">
            <span className="setup-struct-sep">:</span>
            {strike !== null && <span className="setup-strike">${strike}</span>}
            <span className="setup-expiry">{fmtExpShort(setup!.expiration)}</span>
            {credit !== null && <span className="setup-premium setup-credit">${credit.toFixed(2)} cr</span>}
            {debit  !== null && <span className="setup-premium setup-debit">${debit.toFixed(2)}  dr</span>}
          </span>
        )}

        {/* Top lab pick — informational cross-reference (best-overall structure), after the trade. */}
        {best && !relevantIsBest && (
          <>
            <span className="lab-grade-sep">|  Top lab pick:</span>
            <span className="lab-grade-item">
              <span className="lab-grade-label">{best.name}</span>
              <span className="lab-grade-badge" style={{ color: GRADE_COLOR[best.grade], borderColor: GRADE_COLOR[best.grade] }}>
                {best.grade}
              </span>
            </span>
          </>
        )}
      </div>
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

// Shared deep-link handlers for a brief pick — used by both the card's nav row and the
// Ranked-Grid Actions cell so both navigate identically (same chosen structure → same
// Payoff legs, same options-chain expiry).
function pickNav(pick: BriefPick, strategy: ScoringStrategy) {
  const result = pick.strategyLabResult ? (pick.strategyLabResult as StrategyLabValidateResult) : null;
  const chosen = result ? pickDisplayStructure(result.scores, strategy, pick.breakoutDirection) : null;
  const setup  = chosen?.setup && !chosen.setup.unavailableReason ? chosen.setup : null;
  const expiry = setup?.expiration ?? null;
  const legs   = setup?.legs?.length ? setup.legs.map((l, i) => labLegToPayoffLeg(l, i)) : null;

  return {
    chosen, setup, expiry, legs,
    payoff: () => {
      const detail: Record<string, unknown> = { ticker: pick.ticker };
      if (pick.price != null) detail.spot     = pick.price;
      if (expiry)             detail.expiry   = expiry;
      if (chosen)             detail.strategy = chosen.slug;
      if (legs)               detail.legs     = legs;
      window.dispatchEvent(new CustomEvent('navigate-to-payoff', { detail }));
    },
    validate: () => window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: pick.ticker } })),
    options:  () => window.dispatchEvent(new CustomEvent('navigate-to-options',  { detail: { ticker: pick.ticker, ...(expiry ? { expiry } : {}) } })),
    analysis: () => window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: pick.ticker } })),
    etrade:   () => window.open(`https://us.etrade.com/e/t/invest/quotesandresearch?content=3&sym=${pick.ticker.toLowerCase()}`, '_blank'),
  };
}

// Cross-strategy Conviction ranking, RSI extraction, and the critic pass-filter all live in
// '@shared/brief-ranking.js' (imported above) so the same logic is unit-tested in isolation.

function CriticBadge({ verdict }: { verdict: CriticVerdict }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="critic-verdict">
      <div className="critic-badge-row">
        <span className="critic-label">🔍 Critic:</span>
        <span className={`critic-badge critic-badge-${verdict.degraded ? 'degraded' : verdict.verdict}`}>
          {verdict.degraded ? '⚠ Critic unavailable' : CRITIC_LABEL[verdict.verdict]}
        </span>
        {verdict.degraded ? (
          <span className="critic-confidence-low" title="The LLM critic did NOT run (e.g. the AI service was overloaded). This is a rule-based fallback, not a vetted pass — re-run the brief.">
            not vetted
          </span>
        ) : verdict.confidence === 'low' && (
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
          {verdict.degraded && (
            <p className="critic-rationale-text muted">⚠ The LLM critic did not run for this pick (the AI service was unavailable or overloaded), so this verdict is a rule-based fallback only — <strong>not</strong> an adversarial review. Re-run the brief to get a real verdict.</p>
          )}
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
          {!verdict.degraded && !verdict.rationale && verdict.flags.length === 0 && (
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
function PickNavRow({ pick, strategy }: { pick: BriefPick; strategy: ScoringStrategy }) {
  // Shared deep-link handlers — uses the STRATEGY-RELEVANT structure (the recommended trade
  // shown on the card), not the best-overall scores[0], so Payoff for a wheel CSP loads the
  // CSP and not the best-overall Big Lizard.
  const nav = pickNav(pick, strategy);

  // Backtest only applies to premium-selling strategies the engine supports.
  const backtestStrategy: 'CSP' | 'Wheel' | null =
    strategy === 'wheel' ? 'Wheel' : strategy === 'income' ? 'CSP' : null;
  const handleBacktest = () => {
    window.dispatchEvent(new CustomEvent('navigate-to-backtest', {
      detail: { ticker: pick.ticker, strategy: backtestStrategy },
    }));
  };

  const expiryLabel = nav.expiry ? ` · ${nav.expiry}` : '';

  return (
    <div className="pick-nav-row">
      <button className="pick-nav-btn" onClick={nav.payoff}
        title={nav.legs ? `Open Payoff Visualizer pre-loaded with ${nav.chosen?.name ?? 'strategy'} legs` : 'Open Payoff Visualizer for this ticker'}>
        📊 Payoff
      </button>
      <button className="pick-nav-btn" onClick={nav.validate}
        title="Open Validate for this ticker">
        ✓ Validate
      </button>
      <button className="pick-nav-btn" onClick={nav.options}
        title={nav.expiry ? `Open Options Chain — expiry ${nav.expiry}` : 'Open Options Chain for this ticker'}>
        📋 Options{expiryLabel}
      </button>
      <button className="pick-nav-btn" onClick={nav.analysis}
        title="Run Analysis for this ticker">
        🔍 Analysis
      </button>
      <button className="pick-nav-btn" onClick={nav.etrade}
        title="Open on E*Trade">
        🏦 E*Trade
      </button>
      {backtestStrategy && (
        <button className="pick-nav-btn" onClick={handleBacktest}
          title={`Backtest a ${backtestStrategy} on this ticker`}>
          🔁 Backtest
        </button>
      )}
    </div>
  );
}

// Display-only defined-risk alternative (bull put spread) for a bullish pick whose
// recommended structure carries a larger tail. Click → Payoff pre-loaded with the spread.
// Informational only — does not change what the brief recommends (no FR-SEY-5 impact).
function DefinedRiskAltLine({ pick, strategy, compact }: { pick: BriefPick; strategy: ScoringStrategy; compact?: boolean }) {
  const alt = definedRiskAlternative(pick, strategy);
  if (!alt) return null;
  const setup = alt.setup;
  const strike = primaryStrike(setup);
  const credit = setup.netCredit !== null && setup.netCredit > 0 ? setup.netCredit : null;
  const tail = alt.maxLoss != null ? Math.abs(alt.maxLoss) : null;

  const handlePayoff = () => {
    const detail: Record<string, unknown> = { ticker: pick.ticker, strategy: alt.slug, expiry: setup.expiration };
    if (pick.price != null) detail.spot = pick.price;
    detail.legs = setup.legs.map((l, i) => labLegToPayoffLeg(l, i));
    window.dispatchEvent(new CustomEvent('navigate-to-payoff', { detail }));
  };

  return (
    <button
      className={`defined-risk-alt${compact ? ' defined-risk-alt--compact' : ''}`}
      onClick={handlePayoff}
      title={`Defined-risk alternative to the recommended structure${tail != null ? ` — max loss $${tail.toLocaleString()}` : ''}${alt.popEstimate != null ? `, PoP ${alt.popEstimate.toFixed(0)}%` : ''}. Click → Payoff Visualizer.`}
    >
      <span className="alt-tag">⚖ Defined-risk alt</span>
      <span className="lab-grade-label">{SLUG_SHORT[alt.slug] ?? alt.name}</span>
      <span className="lab-grade-badge" style={{ color: GRADE_COLOR[alt.grade], borderColor: GRADE_COLOR[alt.grade] }}>{alt.grade}</span>
      {strike !== null && <span className="setup-strike">${strike}</span>}
      <span className="setup-expiry">{fmtExpShort(setup.expiration)}</span>
      {credit !== null && <span className="setup-premium setup-credit">${credit.toFixed(2)} cr</span>}
      {alt.popEstimate != null && <span className="alt-pop">PoP {alt.popEstimate.toFixed(0)}%</span>}
    </button>
  );
}

// ── Level-2 (debit) vertical chip ─────────────────────────────────────────────
// Bullish → long call spread; bearish → long put spread, narrowed to a small max-risk budget at
// brief-generation time. Lets a Level-2 IBKR account place a small, defined-risk directional trade
// (account-building toward Level 3) instead of the L3 credit spreads it can't trade. Shows
// breakeven + move-to-profit (NOT a credit-spread PoP, which is the wrong semantics for a debit
// spread). Informational only — does not change what the brief recommends (no FR-SEY-5 impact).
function Level2DebitAltLine({ pick, strategy, compact }: { pick: BriefPick; strategy: ScoringStrategy; compact?: boolean }) {
  const alt = level2DebitAlternative(pick, strategy);
  if (!alt) return null;
  const spreadName = alt.side === 'call' ? 'Long Call Spread' : 'Long Put Spread';
  const moveTxt = alt.movePctToBreakeven != null
    ? `${alt.movePctToBreakeven >= 0 ? '+' : ''}${alt.movePctToBreakeven.toFixed(1)}%`
    : null;

  const handlePayoff = () => {
    const typeLabel = alt.side.charAt(0).toUpperCase() + alt.side.slice(1);
    const legs: PayoffLeg[] = [
      { id: 'l2-long',  side: 'buy',  type: alt.side, strike: alt.longStrike,  expiry: alt.expiration, premium: alt.longPremium,  quantity: 1, delta: null, theta: null, vega: null, iv: null, label: `Long ${typeLabel} $${alt.longStrike}` },
      { id: 'l2-short', side: 'sell', type: alt.side, strike: alt.shortStrike, expiry: alt.expiration, premium: alt.shortPremium, quantity: 1, delta: null, theta: null, vega: null, iv: null, label: `Short ${typeLabel} $${alt.shortStrike}` },
    ];
    const detail: Record<string, unknown> = {
      ticker: pick.ticker,
      strategy: alt.side === 'call' ? 'long-call-vertical' : 'long-put-vertical',
      expiry: alt.expiration,
      legs,
    };
    if (pick.price != null) detail.spot = pick.price;
    window.dispatchEvent(new CustomEvent('navigate-to-payoff', { detail }));
  };

  return (
    <button
      className={`level2-alt${compact ? ' level2-alt--compact' : ''}`}
      onClick={handlePayoff}
      title={`Level-2-tradeable ${spreadName.toLowerCase()} for IBKR account-building — max risk $${alt.maxRisk.toLocaleString()}, max profit $${alt.maxProfit.toLocaleString()}, breakeven $${alt.breakeven}${moveTxt ? ` (${moveTxt} move)` : ''}.${alt.exceededBudget ? ' NOTE: narrowest available spread still exceeds the ~$750 risk target — size down or skip.' : ''} Buying premium at high IV is not the optimal structure — this is a small, defined-risk directional trade. Click → Payoff Visualizer.`}
    >
      <span className="alt-tag">📈 L2-tradeable</span>
      <span className="lab-grade-label">{spreadName}</span>
      <span className="setup-strike">${alt.longStrike}/${alt.shortStrike}</span>
      <span className="setup-expiry">{fmtExpShort(alt.expiration)}</span>
      <span className="setup-premium setup-debit">${alt.debitPerShare.toFixed(2)} db</span>
      <span className={`alt-risk${alt.exceededBudget ? ' alt-risk--over' : ''}`}>risk ${alt.maxRisk.toLocaleString()}{alt.exceededBudget ? '!' : ''}</span>
      {moveTxt && <span className="alt-pop">BE {moveTxt}</span>}
    </button>
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
  const labGrade = result ? gradeOf(result, strategy, pick.breakoutDirection) : null;
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
          <span
            className={`pick-summary-verdict critic-badge-${pick.criticVerdict?.degraded ? 'degraded' : verdict}`}
            title={pick.criticVerdict?.degraded ? 'LLM critic did not run — not a vetted pass' : undefined}
          >
            {pick.criticVerdict?.degraded ? '⚠ Critic n/a' : CRITIC_LABEL[verdict]}
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
          <StrategyLabSummary strategyLabResult={pick.strategyLabResult ?? null} strategy={strategy} breakoutDirection={pick.breakoutDirection} />
          <DefinedRiskAltLine pick={pick} strategy={strategy} />
          <Level2DebitAltLine pick={pick} strategy={strategy} />
          <PickNavRow pick={pick} strategy={strategy} />
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


// ── Ranked Grid (Tab B) ─────────────────────────────────────────────────────
// One flat, sortable row per pick across every strategy. Default-sorted by Conviction
// (the cross-strategy ranking) so the strongest setups float to the top.

interface GridRow {
  pick: BriefPick;
  strategy: ScoringStrategy;
  conviction: number;
  rsi: number | null;
  structure: { slug: string; name: string; grade: StrategyLabGrade } | null;
  expiry: string | null;
  strike: number | null;
  premium: { value: number; kind: 'cr' | 'dr' } | null;
}

function buildGridRow(pick: BriefPick, strategy: ScoringStrategy): GridRow {
  const result = pick.strategyLabResult ? (pick.strategyLabResult as StrategyLabValidateResult) : null;
  const lab    = result ? gradeOf(result, strategy, pick.breakoutDirection) : null;
  const setup  = lab?.setup && !lab.setup.unavailableReason ? lab.setup : null;
  const credit = setup && setup.netCredit !== null && setup.netCredit > 0 ? setup.netCredit : null;
  const debit  = setup && setup.netDebit  !== null && setup.netDebit  > 0 ? setup.netDebit  : null;
  return {
    pick, strategy,
    conviction: convictionOf(pick, strategy),
    rsi:        rsiOf(pick),
    structure:  lab ? { slug: lab.slug, name: lab.name, grade: lab.grade } : null,
    expiry:     setup?.expiration ?? null,
    strike:     setup ? primaryStrike(setup) : null,
    premium:    credit !== null ? { value: credit, kind: 'cr' } : debit !== null ? { value: debit, kind: 'dr' } : null,
  };
}

type SortKey = 'conviction' | 'ticker' | 'price' | 'composite' | 'strategy'
             | 'structure' | 'expiry' | 'strike' | 'premium' | 'grade' | 'verdict' | 'rsi';
const TEXT_SORT_KEYS = new Set<SortKey>(['ticker', 'strategy', 'structure', 'expiry']);
const VERDICT_RANK: Record<string, number> = { pass: 3, caution: 2, flag: 1 };

function sortValue(row: GridRow, key: SortKey): number | string | null {
  switch (key) {
    case 'conviction': return row.conviction;
    case 'ticker':     return row.pick.ticker;
    case 'price':      return row.pick.price;
    case 'composite':  return row.pick.compositeScore;
    case 'strategy':   return row.strategy;
    case 'structure':  return row.structure?.name ?? null;
    case 'expiry':     return row.expiry;
    case 'strike':     return row.strike;
    case 'premium':    return row.premium?.value ?? null;
    case 'grade':      return row.structure ? (GRADE_RANK[row.structure.grade] ?? 0) : null;
    case 'verdict': {
      const v = row.pick.criticVerdict;
      return !v || v.degraded ? 0 : (VERDICT_RANK[v.verdict] ?? 0);
    }
    case 'rsi':        return row.rsi;
  }
}

function BriefGrid({ rows }: { rows: GridRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>('conviction');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const clickHeader = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(TEXT_SORT_KEYS.has(key) ? 'asc' : 'desc');
    }
  };

  const sorted = [...rows].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    // Nulls always sort last, regardless of direction.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    const r = typeof av === 'string'
      ? av.localeCompare(bv as string)
      : (av as number) - (bv as number);
    return sortDir === 'asc' ? r : -r;
  });

  if (rows.length === 0) {
    return <div className="empty-section">No picks match the current filter.</div>;
  }

  const arrow = (key: SortKey) => (key === sortKey ? <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span> : null);
  const cols: { key: SortKey; label: string; title?: string }[] = [
    { key: 'ticker',     label: 'Ticker' },
    { key: 'price',      label: 'Price' },
    { key: 'conviction', label: 'Conviction', title: 'Cross-strategy ranking: Strategy-Lab structure score (0–100, shared rubric) minus a critic penalty (caution −15, flag/not-vetted −25 to −35). A quality/triage order — not a profit forecast.' },
    { key: 'strategy',   label: 'Strategy' },
    { key: 'composite',  label: 'Composite', title: 'Strategy-specific score — NOT comparable across strategies (each uses different signals and weights). Use Conviction to rank across strategies.' },
    { key: 'structure',  label: 'Best Structure', title: 'Recommended structure (click → Payoff Visualizer)' },
    { key: 'expiry',     label: 'Expiry' },
    { key: 'strike',     label: 'Strike' },
    { key: 'premium',    label: 'Premium' },
    { key: 'grade',      label: 'Rating', title: 'Strategy-Lab grade of the recommended structure' },
    { key: 'verdict',    label: 'Flag', title: 'AI critic verdict' },
    { key: 'rsi',        label: 'RSI', title: 'Only scored for buy / bullish / bearish picks' },
  ];

  return (
    <table className="brief-grid-table">
      <thead>
        <tr>
          {cols.map(c => (
            <th key={c.key} onClick={() => clickHeader(c.key)} title={c.title}>
              {c.label}{arrow(c.key)}
            </th>
          ))}
          <th className="grid-actions-head">Actions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(row => {
          const { pick, strategy } = row;
          const nav = pickNav(pick, strategy);
          const v = pick.criticVerdict;
          const verdictClass = v ? (v.degraded ? 'degraded' : v.verdict) : null;
          return (
            <tr key={`${strategy}-${pick.ticker}`}>
              <td className="grid-ticker">{pick.ticker}</td>
              <td>{pick.price != null ? `$${pick.price.toFixed(2)}` : <span className="grid-muted">—</span>}</td>
              <td>
                <span className="grid-conviction" style={{ background: scoreBg(row.conviction), color: scoreColor(row.conviction) }}>
                  {row.conviction}
                </span>
              </td>
              <td className="grid-strategy">{strategy}</td>
              <td title="Strategy-specific — not comparable across strategies">{pick.compositeScore.toFixed(1)}</td>
              <td className="grid-structure-cell">
                {row.structure
                  ? <button className="grid-structure-link" onClick={nav.payoff}
                      title={nav.legs ? `Open Payoff Visualizer pre-loaded with ${row.structure.name} legs` : 'Open Payoff Visualizer'}>
                      {SLUG_SHORT[row.structure.slug] ?? row.structure.name}
                    </button>
                  : <span className="grid-muted">—</span>}
                <DefinedRiskAltLine pick={pick} strategy={strategy} compact />
                <Level2DebitAltLine pick={pick} strategy={strategy} compact />
              </td>
              <td>{row.expiry ? fmtExpShort(row.expiry) : <span className="grid-muted">—</span>}</td>
              <td>{row.strike != null ? `$${row.strike}` : <span className="grid-muted">—</span>}</td>
              <td>
                {row.premium
                  ? <span className={row.premium.kind === 'cr' ? 'setup-credit' : 'setup-debit'}>${row.premium.value.toFixed(2)} {row.premium.kind}</span>
                  : <span className="grid-muted">—</span>}
              </td>
              <td>
                {row.structure
                  ? <span className="lab-grade-badge" style={{ color: GRADE_COLOR[row.structure.grade], borderColor: GRADE_COLOR[row.structure.grade] }}>{row.structure.grade}</span>
                  : <span className="grid-muted">—</span>}
              </td>
              <td>
                {verdictClass
                  ? <span className={`pick-summary-verdict critic-badge-${verdictClass}`}
                      title={v!.degraded ? 'LLM critic did not run — not a vetted pass' : undefined}>
                      {v!.degraded ? '⚠ n/a' : CRITIC_LABEL[v!.verdict]}
                    </span>
                  : <span className="grid-muted">—</span>}
              </td>
              <td>{row.rsi != null ? row.rsi.toFixed(0) : <span className="grid-muted">—</span>}</td>
              <td>
                <div className="grid-actions">
                  <button className="grid-action-btn" onClick={nav.payoff}   title="Payoff">📐</button>
                  <button className="grid-action-btn" onClick={nav.validate} title="Validate">🎯</button>
                  <button className="grid-action-btn" onClick={nav.options}  title="Options Chain">📉</button>
                  <button className="grid-action-btn" onClick={nav.analysis} title="Analysis">📊</button>
                  <button className="grid-action-btn" onClick={nav.etrade}   title="E*Trade">🏦</button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface DailyBriefViewProps {
  onGoToStrategyLab?: (ticker: string) => void;
}

/** Shape returned by `scoring:roll-the-dice` (see src/main/services/roll-the-dice.ts). */
type DiceResult = Awaited<ReturnType<typeof window.api.scoring.rollTheDice>>;

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

  const [dice, setDice]                   = useState<DiceResult | null>(null);
  const [diceBusy, setDiceBusy]           = useState(false);
  const [diceMailMsg, setDiceMailMsg]     = useState<string | null>(null);
  const [diceMailing, setDiceMailing]     = useState(false);

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

  const [activeTab, setActiveTab] = useState<'grouped' | 'grid'>(
    () => (localStorage.getItem('brief-tab') === 'grid' ? 'grid' : 'grouped'),
  );
  const [passFilter, setPassFilter] = useState<PassFilter>(() => {
    const saved = localStorage.getItem('brief-pass-filter');
    return saved === 'pass' || saved === 'pass-caution' ? saved : 'all';
  });
  const selectTab = (t: 'grouped' | 'grid') => { setActiveTab(t); localStorage.setItem('brief-tab', t); };
  const selectFilter = (f: PassFilter) => { setPassFilter(f); localStorage.setItem('brief-pass-filter', f); };

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

  // Roll the Dice — one wheel entry from the latest brief, or an explicit nothing.
  const handleRollDice = async () => {
    setDiceBusy(true);
    try {
      setDice(await window.api.scoring.rollTheDice());
    } catch (err) {
      console.error('[dice] error:', err);
      setDice(null);
    } finally {
      setDiceBusy(false);
    }
  };

  const handleEmailDice = async () => {
    setDiceMailing(true);
    setDiceMailMsg(null);
    try {
      const r = await window.api.scoring.emailRollTheDice();
      setDiceMailMsg(r.message);
    } catch (err) {
      setDiceMailMsg(err instanceof Error ? err.message : 'Email failed');
    } finally {
      setDiceMailing(false);
      setTimeout(() => setDiceMailMsg(null), 6000);
    }
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

  // Apply the critic pass-filter to both tabs by filtering each entry's picks up front.
  const filteredBriefs = displayedBriefs.map(b => ({
    ...b,
    picks: b.picks.filter(p => passesFilter(p, passFilter)),
  }));
  const briefMap = new Map(filteredBriefs.map(b => [b.strategy as ScoringStrategy, b]));
  const gridRows = filteredBriefs.flatMap(b =>
    b.picks.map(p => buildGridRow(p, b.strategy as ScoringStrategy)),
  );

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
          className="brief-dice-btn"
          onClick={handleRollDice}
          disabled={diceBusy || running}
          title="One wheel entry from the latest brief: critic pass (no flag, no caution), share price within the limit, liquid, and no earnings before expiry. Returns nothing when nothing clears."
        >
          {diceBusy ? 'Rolling…' : '🎲 Roll the Dice'}
        </button>
        <button
          className="brief-run-btn"
          onClick={handleRunNow}
          disabled={running}
        >
          {running ? 'Running…' : 'Run Now'}
        </button>
      </div>

      {/* Roll the Dice — a single actionable wheel entry, or an explicit nothing. */}
      {dice && (
        <div className={`dice-panel${dice.pick ? '' : ' dice-empty'}`}>
          <div className="dice-head">
            <span className="dice-title">🎲 Roll the Dice</span>
            <span className="dice-sub">
              wheel entry · {dice.considered} pick{dice.considered === 1 ? '' : 's'} considered
              {dice.briefDate ? ` · brief ${dice.briefDate}` : ''}
            </span>
            <div style={{ flex: 1 }} />
            {diceMailMsg && <span className="dice-mail-msg">{diceMailMsg}</span>}
            <button
              className="dice-mail-btn"
              onClick={handleEmailDice}
              disabled={diceMailing}
              title="Email this single opportunity — the same card the nightly chain sends"
            >
              {diceMailing ? 'Sending…' : '✉ Email it'}
            </button>
            <button className="dice-close" onClick={() => setDice(null)} title="Dismiss">×</button>
          </div>

          {dice.staleWarning && <div className="dice-stale">⚠ {dice.staleWarning}</div>}

          {dice.pick ? (
            <>
              {dice.pick.tier === 'stretch' && (
                <div className="dice-stretch">
                  <b>Above your normal size — ${dice.pick.capitalRequired.toLocaleString()}.</b>{' '}
                  An exception, taken because it is {dice.pick.stretchReason}. Worth a look before
                  you place it rather than a reflex.
                </div>
              )}
              <div className="dice-headline">
                Sell the <b>{dice.pick.ticker}</b> ${dice.pick.strike} put,{' '}
                {dice.pick.expiration} ({dice.pick.dte}d)
              </div>
              <div className="dice-stats">
                <div className="dice-stat">
                  <span className="dice-k">Credit</span>
                  <span className="dice-v">${dice.pick.creditTotal.toFixed(0)}</span>
                  <span className="dice-n">${dice.pick.premiumPerShare.toFixed(2)}/sh</span>
                </div>
                <div className="dice-stat">
                  <span className="dice-k">Capital</span>
                  <span className="dice-v">${dice.pick.capitalRequired.toLocaleString()}</span>
                  <span className="dice-n">{dice.pick.tier === 'stretch' ? 'cash-secured · over normal limit' : 'cash-secured'}</span>
                </div>
                <div className="dice-stat">
                  <span className="dice-k">Cost basis if assigned</span>
                  <span className="dice-v">${dice.pick.effectiveCostBasis.toFixed(2)}</span>
                  <span className="dice-n">{dice.pick.discountToSpotPct.toFixed(1)}% below ${dice.pick.price.toFixed(2)}</span>
                </div>
                <div className="dice-stat">
                  <span className="dice-k">Annualized</span>
                  <span className="dice-v">{dice.pick.annualizedReturn?.toFixed(0) ?? '—'}%</span>
                  <span className="dice-n">PoP {dice.pick.popEstimate?.toFixed(0) ?? '—'}%</span>
                </div>
                <div className="dice-stat">
                  <span className="dice-k">Quality</span>
                  <span className="dice-v">{dice.pick.grade}</span>
                  <span className="dice-n">score {dice.pick.compositeScore.toFixed(1)} · liq {dice.pick.liquidityScore.toFixed(0)}/15</span>
                </div>
              </div>
              {dice.pick.criticRationale && (
                <div className="dice-rationale"><b>Critic:</b> {dice.pick.criticRationale}</div>
              )}
              {dice.runnerUp && (
                <div className="dice-runner">
                  Runner-up: {dice.runnerUp.ticker} ({dice.runnerUp.compositeScore.toFixed(1)})
                </div>
              )}
            </>
          ) : (
            <div className="dice-none">{dice.noPickReason}</div>
          )}

          {dice.rejections.length > 0 && (
            <details className="dice-rejects">
              <summary>{dice.rejections.length} rejected — why</summary>
              <ul>
                {dice.rejections.map((r, i) => (
                  <li key={i}><b>{r.ticker}</b> — {r.reason}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

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

      {!loading && displayedBriefs.length > 0 && (
        <div className="brief-subtoolbar">
          <div className="brief-tabs">
            <button className={`brief-tab ${activeTab === 'grouped' ? 'active' : ''}`} onClick={() => selectTab('grouped')}>
              Grouped
            </button>
            <button className={`brief-tab ${activeTab === 'grid' ? 'active' : ''}`} onClick={() => selectTab('grid')}>
              Ranked Grid
            </button>
          </div>
          <div style={{ flex: 1 }} />
          <div className="brief-filter-seg" title="Filter by AI-critic verdict. Pass filters exclude not-vetted picks.">
            <span className="brief-filter-label">Critic:</span>
            <button className={passFilter === 'all' ? 'active' : ''} onClick={() => selectFilter('all')}>All</button>
            <button className={passFilter === 'pass-caution' ? 'active' : ''} onClick={() => selectFilter('pass-caution')}>Pass + Caution</button>
            <button className={passFilter === 'pass' ? 'active' : ''} onClick={() => selectFilter('pass')}>Pass only</button>
          </div>
        </div>
      )}

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
      ) : activeTab === 'grid' ? (
        <div className="brief-grid-scroll">
          <BriefGrid rows={gridRows} />
        </div>
      ) : (
        <div className="brief-strategies">
          {orderByTopComposite(STRATEGY_ORDER, briefMap)
            // When a pass-filter is active, hide strategies left with no matching picks.
            .filter(strategy => passFilter === 'all' || (briefMap.get(strategy)?.picks.length ?? 0) > 0)
            .map(strategy => (
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
