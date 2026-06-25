# Pre-Trade Validator — design spec (Payoff view)

> **Status: ✅ SHIPPED v1.1.76 (2026-06-25)** — graduated into `spec/08-options-chain-and-payoff.md`
> §8.B.7 (authoritative). Decision-support only — it judges a trade you hand-build; it does
> **not** place orders and is **not** wired to the v2 execution engine. This doc remains the
> detailed design rationale + deferred-questions record.

## Goal

Let the user **validate a structure they hand-build in the Payoff view before placing it** —
the system returns a **verdict** (good / caution / bad idea) with concrete reasons, and when it
flags the trade, **suggests a better structure** for the same name. It encodes, as explicit
checks, the discretionary discipline the user already applies by hand (own-at-strike, match
structure to thesis horizon *and* IV regime, earnings-in-window, cushion-vs-volatility,
defined-risk, reward/risk).

Origin: a 2026-06-25 position-by-position review (see memory `user-trading-principles`) where
the same NVDA short put was a *bad premium trade* but a *fine ownership trade* — proving the
verdict must be **intent-aware**, not generic.

## Why this is mostly assembly

~80% of the machinery exists and is reused, not rebuilt:

| Need | Reuse |
|---|---|
| Payoff math (maxProfit/maxLoss/breakevens/credit) | `payoff-service.ts` (already models multi-leg + has an AI assessment) |
| Verdict model (pass/caution/flag + flags + rationale) | `critic-service.ts` `runRuleChecks` + LLM critic |
| IV regime (IV rank/percentile) | `quote_cache.iv_rank/iv_percentile`, lab `ivScore` |
| Direction vs trend (bias, MA20/MA50) | strategy-lab context (`directionBias`, `ma20/ma50`) |
| Earnings before expiry | `earnings_calendar` (nearest-date fix v1.1.75) + critic `earningsInWindow` |
| Structure grade / premium richness / liquidity | `strategy-lab-service.ts` (`ivScore`/`premiumScore`/`liquidityScore`/grade) |
| "Suggest a better structure" | `strategy-lab-service` + `pickRelevantStructure` (regime+intent-filtered) |
| Cushion vs volatility | `beta-service` + ATR% (`technical_signals`) |

## UX

- A **Validate** panel on the Payoff view, run on demand against the currently-built structure.
- **Intent capture** (the new piece — small, required, because the verdict depends on it):
  1. *Happy to own at the strike?* (Y / N / N-A) — gates short-put earnings/assignment severity.
  2. *Trade purpose:* income · directional · ownership-entry (wheel) · hedge.
  3. *Thesis horizon:* by expiry · multi-quarter.
  - Default to remembered last-used values; always overridable per validation.
- Output: a verdict pill (✅ good / ⚠ caution / ⛔ bad idea) + an ordered list of checks
  (pass/warn/fail with one-line reasons) + optional LLM narrative + (when flagged) a
  **suggested alternative** block.

## Deterministic checks (the trustworthy core — lead with these)

Computed from the structure + underlying + intent. LLM narrative is additive, not the verdict.

1. **Liquidity / data integrity** — each leg two-sided (bid>0, ask>0); bid/ask spread width
   (`wide_market`); per-leg liquidity score vs `MIN_TRADABLE_LIQUIDITY_SCORE` (8).
2. **Structure sanity / reward-risk** — maxProfit/maxLoss/breakevens; flag terrible R/R (the
   BRBR "$11 credit vs $239 risk" case); flag **undefined risk** (naked short legs).
3. **IV-regime fit** (the NVDA insight) — net-credit structure + **low** IV rank (<~30) →
   `selling_cheap_vol` (premium isn't rich for the regime, despite a big dollar figure on a
   high-priced name); net-debit + **high** IV rank → `buying_expensive_vol`.
4. **Direction-vs-thesis fit** — lab `directionBias` (MA-based) vs the structure's directional
   sign vs stated intent. Contradiction *without* a declared "fading / owner" intent →
   `against_trend` caution (the NVDA bullish-put-into-downtrend case).
5. **Earnings-in-window** — any earnings ≤ expiry → flag; severity **intent-gated**: with
   "happy to own at strike" → `info` (the acceptable TSLA-CSP case); otherwise → `warning`
   (the NFLX held-through-earnings case).
6. **Cushion vs volatility** — short option moneyness vs the name's ATR%/typical move. A 2%
   cushion on a high-ATR name (NVDA) → `thin_cushion` "live wire"; same 2% on a low-vol name
   passes. (Encodes the NVDA-vs-TSLA-cushion distinction.)
7. **Wheel discipline** (intent = income/ownership + short put) — confirm the effective basis
   (strike − net credit) and that the strike is genuinely OTM for the name's vol; surface
   "assigned-at-X-while-trading-lower" risk for thin-cushion names.
8. **Horizon match** — multi-quarter thesis declared but structure expires soon →
   `horizon_mismatch` (the NFLX "long thesis, short instrument" case).

Verdict = roll-up of check severities into pass/caution/flag (reuse the critic's severity
model). Any `fail` → ⛔; any `warning` → ⚠; else ✅.

## Suggest-a-better-structure (when flagged)

Reuse the Strategy Lab for the **same ticker + expiry**: score its structures, then surface the
best one that (a) **matches the user's intent** (income→credit; directional→matches bias;
ownership→put-based at a want-to-own strike; hedge→protective), (b) **fits the IV regime**
(high IV→sell, low IV→buy/wait), and (c) clears liquidity + earnings + R/R. Present as
"the lab would instead suggest **[structure] [strikes]** — here's why it scores better."

Critically, it must be allowed to recommend **not selling premium** — e.g. "IV rank is 25%;
for owning NVDA, a debit structure or simply waiting beats selling a cheap put." (This is what
subsumes the abandoned "CSP × big-lizard hybrid" idea: there is no edge-bearing structure
*between* a CSP and a big lizard — adding call premium *is* the lizard — so rather than a new
structure, the validator just picks the right existing one for the regime + intent.)

## Scope boundaries

- **Decision-support only.** No order placement; not wired to the auto-execution engine. (If it
  ever feeds engine entries, FR-SEY-5 validation applies — but as a Payoff advisor it does not.)
- Single structure at a time, against the currently-built Payoff legs (scope choice (a)).
- Reuses live data already in the app; "suggest better" may reuse cached lab data or trigger
  one chain fetch (see open questions).

## Decisions (locked 2026-06-25)

- **Validation history = PERSISTED.** A `pretrade_validations` table logs each validation
  (ticker, legs JSON, intent, verdict, flags JSON, suggested-alternative JSON, created_at) for
  later review and eventual outcome-learning. Migration + a "Validation history" list on the
  panel.
- **"Suggest better" = reuse cached lab data, with a Refresh action.** Default to cached
  strikes/scores for speed; a **Refresh** button triggers one fresh chain fetch when the user
  wants accurate live strikes. (Stale-cache risk is acceptable for an advisory suggestion;
  refresh covers the "about to actually place it" moment.)
- **LLM critic = opt-in** per validation (deterministic checks run free + instant; the LLM adds
  cost + latency, so it's a "get AI narrative" button, not automatic).
- **Intent = remembered last-used**, re-confirmed each validation.

## Open questions (deferred, non-blocking)

1. Should the validator also accept an **existing open position** as input later (scope (b))?
   Out of scope now, natural follow-up.
2. Do we want the intent inputs to **pre-populate** from the structure (e.g. infer "income" from
   a net-credit build) to reduce friction? (Nice-to-have; not v1-blocking.)
