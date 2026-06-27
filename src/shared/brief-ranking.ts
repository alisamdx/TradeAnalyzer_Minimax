// Cross-strategy Conviction ranking + critic pass-filter for the Daily Brief.
//
// Composite scores are strategy-specific (each strategy scores different signals with
// different weights), so they CANNOT be ranked head-to-head across strategies. Two things
// CAN: the Strategy-Lab structure score (0–100 on the shared IV + direction + premium +
// liquidity rubric — see strategy-lab-service.ts) and the adversarial critic verdict.
// Conviction blends them so critic-passed, high-grade structures float to the top of the
// Ranked Grid and flagged / F-grade ones sink. It is a quality/triage ordering — NOT a
// backtested profit forecast (brief-replay found composites weak-to-anti-predictive
// cross-strategy; see Requirements/v2-execution/06-seykota-risk-extensions.md).

import type { BriefPick, ScoringStrategy, StrategyLabValidateResult, CriticVerdict, StrategySetup, StrategyLabGrade } from './types.js';
import { pickDisplayStructure } from './strategy-structures.js';

export const CRITIC_PENALTY: Record<CriticVerdict['verdict'], number> = { pass: 0, caution: 15, flag: 35 };
export const NOT_VETTED_PENALTY = 25; // no critic verdict, or critic degraded (rule-based fallback)

/** Cross-strategy Conviction score (0–100): Strategy-Lab structure score minus a critic penalty. */
export function convictionOf(pick: BriefPick, strategy: ScoringStrategy): number {
  const result = pick.strategyLabResult ? (pick.strategyLabResult as StrategyLabValidateResult) : null;
  const best = result ? pickDisplayStructure(result.scores, strategy, pick.breakoutDirection) : null;
  const base = best?.totalScore ?? 0;
  const v = pick.criticVerdict;
  const penalty = !v || v.degraded ? NOT_VETTED_PENALTY : CRITIC_PENALTY[v.verdict];
  return Math.max(0, Math.round(base - penalty));
}

/** Raw RSI (0–100). Only scored for buy / bullish / bearish picks; null otherwise. */
export function rsiOf(pick: BriefPick): number | null {
  for (const key of ['rsiMomentum', 'rsiOverbought']) {
    const s = pick.signals[key];
    if (s && !s.missing && s.raw !== null) return s.raw;
  }
  return null;
}

/** A defined-risk credit-spread alternative to surface alongside a recommended structure. */
export interface DefinedRiskAlt {
  slug: string;
  name: string;
  grade: StrategyLabGrade;
  setup: StrategySetup;
  popEstimate: number | null;
  maxLoss: number | null;
}

/**
 * Display-only: the defined-risk bull put spread (`short-put-vertical`) to surface as an
 * alternative for a BULLISH pick whose recommended structure (usually a Big Lizard) carries a
 * larger max-loss tail. Returns null unless the spread is constructible, isn't already the
 * recommended structure, and has a strictly smaller max loss. Purely informational — it does
 * NOT change which structure the brief recommends or the engine trades (no FR-SEY-5 impact).
 * (Bullish-scoped to match the validated finding; the spread is the wrong direction/intent
 * for the other strategies.) see Requirements/v2-execution/06-seykota-risk-extensions.md.
 */
export function definedRiskAlternative(pick: BriefPick, strategy: ScoringStrategy): DefinedRiskAlt | null {
  if (strategy !== 'bullish') return null;
  const result = pick.strategyLabResult ? (pick.strategyLabResult as StrategyLabValidateResult) : null;
  const scores = result?.scores;
  if (!scores?.length) return null;
  const rec = pickDisplayStructure(scores, strategy, pick.breakoutDirection);
  const spv = scores.find(s => s.slug === 'short-put-vertical');
  if (!rec || rec.slug === 'short-put-vertical' || !spv?.setup || spv.setup.unavailableReason) return null;
  const recLoss = rec.setup?.maxLoss != null ? Math.abs(rec.setup.maxLoss) : null;
  const spvLoss = spv.setup.maxLoss != null ? Math.abs(spv.setup.maxLoss) : null;
  if (recLoss != null && spvLoss != null && spvLoss >= recLoss) return null; // not actually smaller-risk
  return { slug: spv.slug, name: spv.name, grade: spv.grade, setup: spv.setup, popEstimate: spv.setup.popEstimate, maxLoss: spv.setup.maxLoss };
}

export type PassFilter = 'all' | 'pass-caution' | 'pass';

/** Critic pass-filter. Not-vetted picks (no verdict / degraded) are excluded from pass filters. */
export function passesFilter(pick: BriefPick, filter: PassFilter): boolean {
  if (filter === 'all') return true;
  const v = pick.criticVerdict;
  if (!v || v.degraded) return false;
  if (filter === 'pass') return v.verdict === 'pass';
  return v.verdict === 'pass' || v.verdict === 'caution';
}
