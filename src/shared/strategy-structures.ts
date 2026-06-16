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

// Narrow-range "pin bet" structures: max profit only if the underlying lands in a tight
// window at expiry (low probability of profit), so they don't express a directional thesis.
// For directional strategies we present a directional structure instead when a reasonably
// graded one exists. (Calendars are deliberately NOT here — only the butterflies.)
const PIN_BET_SLUGS = new Set(['put-butterfly', 'call-butterfly']);

// Strategies whose thesis is a directional move (not range-bound income). For these, a pin
// bet is a poor structural fit — see the de-prioritisation in pickRelevantStructure.
const DIRECTIONAL_STRATEGIES = new Set(['bullish', 'bearish', 'buy']);

// A directional structure must be at least this graded to displace a viable pin bet — we
// won't surface a badly-priced (D/F) directional structure just to avoid a butterfly.
const MIN_DIRECTIONAL_GRADE = GRADE_RANK['C']!;

/** Minimal shape needed to choose a structure — any Strategy Lab score satisfies it. */
export interface RelevantScoreLike {
  slug: string;
  grade: string;
  // `maxLoss === null` (or absent) ⇒ unbounded loss (naked short call / strangle /
  // reverse lizard); a finite value ⇒ defined risk. Drives the defined-risk preference.
  setup: { unavailableReason?: string | null; maxLoss?: number | null } | null;
}

/**
 * The single structure the Brief / Critic presents for a strategy: the best valid
 * (non-unavailable) strategy-relevant structure, **preferring defined-risk over
 * unbounded-risk**. Lab scores are ordered best-first, so within a risk tier the first
 * match is the chosen structure.
 *
 * **Defined-risk preference (real-money safety):** when a viable structure with a bounded
 * max loss exists, it is presented instead of an unbounded-risk one (naked short call,
 * strangle/straddle, reverse lizard — all `maxLoss === null`). We never surface an
 * unlimited-risk structure as the recommendation when a capped-risk alternative is
 * available; only when no defined-risk structure is viable do we fall back to the
 * unbounded set. This shifts bearish picks (reverse-big-lizard → put vertical) and income
 * picks (strangle/straddle → iron condor) toward defined risk. It is a no-op for
 * inflection/wheel/bullish/buy, whose relevant structures are already all defined-risk.
 *
 * **Directional-fit preference (real-money suitability):** for a directional strategy
 * (bullish/bearish/buy), a narrow-range "pin bet" butterfly is a poor expression of the
 * thesis, so a directional structure is presented instead — but only when a reasonably
 * graded one (≥ C) exists; we won't surface a badly-priced (D/F) directional structure
 * just to avoid a butterfly, so a viable butterfly is kept when the alternatives are broken.
 *
 * Inflection is special: its two relevant verticals are direction-opposite (bull put vs
 * bear call), so the higher-graded one — matching the breakout direction — is chosen.
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
  // 1. Prefer defined-risk (finite max loss); fall back to the full set only when none exist.
  const definedRisk = valid.filter(s => s.setup?.maxLoss != null);
  let pool = definedRisk.length > 0 ? definedRisk : valid;
  // 2. Directional strategies: prefer a reasonably-graded directional structure over a
  //    pin-bet butterfly. Keep the butterfly only when no directional alternative grades ≥ C.
  if (DIRECTIONAL_STRATEGIES.has(strategy)) {
    const directional = pool.filter(
      s => !PIN_BET_SLUGS.has(s.slug) && (GRADE_RANK[s.grade] ?? 0) >= MIN_DIRECTIONAL_GRADE,
    );
    if (directional.length > 0) pool = directional;
  }
  if (strategy === 'inflection') {
    return pool.reduce((best, s) => ((GRADE_RANK[s.grade] ?? 0) > (GRADE_RANK[best.grade] ?? 0) ? s : best));
  }
  return pool[0] ?? null;
}

/**
 * Display-oriented selection used by the Brief view / email / PDF: the chosen valid
 * structure (defined-risk preferred), else the first strategy-relevant structure even if
 * unavailable (so its name can still be labelled), else the top-overall structure.
 * Never null when any score exists — UIs always have something to render.
 */
export function pickDisplayStructure<T extends RelevantScoreLike>(
  scores: readonly T[] | undefined | null,
  strategy: string,
): T | null {
  const chosen = pickRelevantStructure(scores, strategy);
  if (chosen) return chosen;
  const slugs = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
  const list = scores ?? [];
  return list.find(s => slugs.includes(s.slug)) ?? list[0] ?? null;
}
