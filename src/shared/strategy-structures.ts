// Single source of truth for which Strategy Lab slugs represent each Brief strategy,
// and which structure the Brief / Critic / report / UI presents for a strategy.
//
// This map was previously duplicated in four places (daily-intelligence-brief-job,
// critic-service, brief-report-builder, DailyBriefView). The copies DRIFTED: the
// critic's lacked an `inflection` entry, so `pickRelevantStructure` returned null for
// every inflection pick — the critic ran structure-blind on the v2 launch strategy
// (no liquidity/grade checks, no structure in the LLM context) and the LLM invented a
// non-existent straddle. Keeping one exported constant makes that class of drift
// impossible; `tests/strategy-structures.test.ts` asserts every strategy is covered.

/** Strategy Lab slugs relevant to each Brief strategy (best-first preference order). */
export const STRATEGY_RELEVANT_SLUGS: Record<string, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
  // Inflection = directional credit spread at the breakout level. Bull put first
  // (Phase 2/3 is bullish-only); bear call is for the bearish follow-up.
  inflection: ['short-put-vertical', 'short-call-vertical'],
};

// Grade ordering (A+ best). A missing key ranks 0 — below F.
const GRADE_RANK: Record<string, number> = { 'A+': 6, A: 5, B: 4, C: 3, D: 2, F: 1 };

/** Minimal shape needed to choose a structure — any Strategy Lab score satisfies it. */
export interface RelevantScoreLike {
  slug: string;
  grade: string;
  setup: { unavailableReason?: string | null } | null;
}

/**
 * The single structure the Brief / Critic presents for a strategy: the first
 * strategy-relevant score with a valid (non-unavailable) setup. Lab scores are
 * ordered best-first, so the first match is the chosen structure.
 *
 * Inflection is special: its two relevant verticals are direction-opposite
 * (bull put vs bear call), so the higher-graded one — which matches the breakout
 * direction — is chosen instead of preference order.
 */
export function pickRelevantStructure<T extends RelevantScoreLike>(
  scores: readonly T[] | undefined | null,
  strategy: string,
): T | null {
  const slugs = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
  const valid = (scores ?? []).filter(
    s => slugs.includes(s.slug) && s.setup != null && !s.setup.unavailableReason,
  );
  if (valid.length === 0) return null;
  if (strategy === 'inflection') {
    return valid.reduce((best, s) => ((GRADE_RANK[s.grade] ?? 0) > (GRADE_RANK[best.grade] ?? 0) ? s : best));
  }
  return valid[0] ?? null;
}
