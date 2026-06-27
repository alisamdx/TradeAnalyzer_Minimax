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

import type { BriefPick, ScoringStrategy, StrategyLabValidateResult, CriticVerdict } from './types.js';
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

export type PassFilter = 'all' | 'pass-caution' | 'pass';

/** Critic pass-filter. Not-vetted picks (no verdict / degraded) are excluded from pass filters. */
export function passesFilter(pick: BriefPick, filter: PassFilter): boolean {
  if (filter === 'all') return true;
  const v = pick.criticVerdict;
  if (!v || v.degraded) return false;
  if (filter === 'pass') return v.verdict === 'pass';
  return v.verdict === 'pass' || v.verdict === 'caution';
}
