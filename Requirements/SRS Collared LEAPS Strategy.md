# Software Requirements Specification

## Strategy Module — Collared LEAPS

### Leveraged Long Exposure with a Defined Floor

*(Internal codename: collared-leaps)*

-----

**Stock Screening & Analysis Application**
**Document Version:** 1.0
**Target build platform:** Claude Code (Opus 4.7)
**Data provider:** Polygon.io
**Author:** Shaikh Ali
**Date:** 2026-05-26

-----

## Table of Contents

1. [Executive Summary](#1-executive-summary)
1. [Scope and Integration with Existing System](#2-scope-and-integration-with-existing-system)
1. [Strategy Mechanics](#3-strategy-mechanics)
1. [Screening Pipeline Integration](#4-screening-pipeline-integration)
1. [Scoring Model (Score out of 10)](#5-scoring-model-score-out-of-10)
1. [Market Gate Overlay](#6-market-gate-overlay)
1. [Exit Strategy and Risk Mitigation](#7-exit-strategy-and-risk-mitigation)
1. [Next-Leg Variable Recommendations](#8-next-leg-variable-recommendations)
1. [Output Artifacts](#9-output-artifacts)
1. [Data Requirements (Polygon.io)](#10-data-requirements-polygonio)
1. [Engineering Practices and UX Requirements](#11-engineering-practices-and-ux-requirements)
1. [Acceptance Criteria](#12-acceptance-criteria)
1. [Appendix](#13-appendix)

-----

## 1. Executive Summary

This SRS defines a new strategy module — **Collared LEAPS** — for the existing Stock Screening & Analysis application. The strategy combines a deep ITM long-dated call (LEAPS) with a long out-of-the-money put on the SAME underlying, creating a position with leveraged upside exposure and a defined downside floor. Unlike the v2 LEAPS+CSP strategy (where the two legs are independent), this strategy has GENUINE structural interaction: the put’s strike, expiry, and cost are all selected as a function of the LEAPS chosen, and the two legs together define a single P&L curve.

> **Why this is a real multi-leg strategy**
> 
> The put exists to insure the LEAPS. Its strike is chosen relative to the LEAPS strike. Its expiry is chosen relative to the LEAPS expiry. Its cost is evaluated as a percentage drag on the LEAPS upside. If the LEAPS is rolled, the put must be reconsidered. If the put expires, replacement is a forced decision. The two legs cannot be evaluated independently.
> 
> This is fundamentally different from a LEAPS + separately-screened CSP. There, the two legs share nothing. Here, the put’s entire purpose is to bound the LEAPS’s catastrophic loss case.

### 1.1 Strategy Thesis

LEAPS give you capital-efficient leveraged long exposure but carry a brutal failure mode: if the underlying crashes 30–50%, the LEAPS can lose 60–90% of its value. The collar fixes this. By spending a small portion of the LEAPS upside on a protective put, you cap the worst-case loss at a known dollar amount. The position becomes a defined-risk leveraged long — most of the upside, none of the catastrophic tail.

### 1.2 Position Structure

A single Collared LEAPS position consists of:

- Long 1 deep ITM LEAPS call on ticker X, delta 0.70–0.90, 12–24 months to expiry (target 14–18).
- Long 1 OTM put on the same ticker X, delta −0.15 to −0.30, expiry between 90 DTE and matching the LEAPS expiry.

The combined position has these characteristics:

- **Max loss** = (LEAPS debit + put debit) − (put strike × 100 − put debit at floor scenario). Computed and surfaced explicitly per candidate.
- **Max gain** = uncapped, reduced by the put debit drag.
- **Breakeven** = LEAPS strike + LEAPS debit + put debit (at LEAPS expiry, ignoring residual put value).
- **Cost drag** = put debit / LEAPS debit, expressed as a percentage. This is the price of the insurance.

### 1.3 Why This Strategy Earns a Module

- Solves naked LEAPS’s worst case (single-name crash, sector crash, broad bear market).
- True multi-leg interaction — put parameters are functions of LEAPS parameters.
- Risk/reward is the EXPLICIT optimization target — the screener’s job is to find combinations that maximize upside retention per dollar of floor protection.
- Fits high-conviction long positions on stocks with elevated single-name or sector risk (large-cap tech in a regulatory cycle, semiconductors in a geopolitical cycle, etc.).
- Cleanly separates from existing modules — not a wheel variant, not a PMCC, not stock replacement, not the v2 LEAPS+CSP combo.

### 1.4 What This Strategy Is NOT

- Not a PMCC (no short call written; upside is uncapped).
- Not a synthetic stock (no short put; no obligation to buy shares).
- Not a true “collar” in the textbook sense — a textbook collar wraps 100 owned shares with a short call and long put. This wraps a LEAPS with a long put only.
- Not an income strategy — there is no premium collected. The put COSTS premium. This is a directional strategy with insurance.
- Not appropriate for low-conviction trades — the put drag is real, and on flat or mildly bullish moves you give up real money for protection you didn’t need.

### 1.5 Design Philosophy

> **Same as v2 — opportunity ranking, not capital management**
> 
> This tool surfaces and ranks the best Collared LEAPS opportunities by risk-adjusted quality. It does NOT make capital, allocation, or position-sizing decisions. The user evaluates the ranked output against their own capital, risk tolerance, and existing exposure. No slot logic, no allocation rules, no “max positions” filtering.

-----

## 2. Scope and Integration with Existing System

### 2.1 New Files to Create

```
strategies/collared-leaps.md                  ← strategy playbook (router target)
outputs/collared-leaps-watchlist-schema.md   ← ranked opportunity table schema
outputs/collared-leaps-dashboard-schema.md   ← per-opportunity validation dashboard
references/collared-leaps-worked-example.md  ← reference run on a known ticker
references/collar-payoff-math.md             ← P&L math reference for the engine
```

### 2.2 Files to Update

- `SKILL.md` — add routing row for the new strategy.
- `screening/strategy-overrides.md` — add the collared-leaps section.
- `screening/07-scoring-long-premium.md` — referenced for the LEAPS leg; this strategy adds the put-leg scoring inline in its own playbook.
- `changelog/CHANGELOG.md` — bump version, log the new strategy.

### 2.3 Router Trigger Phrases

Add the following row to the routing table in `SKILL.md`. Place it immediately after the LEAPS-CSP row from v2:

|User intent / trigger phrases                                                                                                                                                                      |Strategy playbook             |
|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------|
|“collared LEAPS”, “collar on LEAPS”, “protected LEAPS”, “LEAPS with put protection”, “defined-risk LEAPS”, “LEAPS with downside floor”, “insure my LEAPS”, “hedged LEAPS”, “LEAPS + protective put”|`strategies/collared-leaps.md`|

### 2.4 Disambiguation Rules

> **Routing distinctions**
> 
> - “Collar” alone (without LEAPS context) — ask: “Standard collar on 100 owned shares, or collar on a LEAPS position?” Standard collars on shares go to advanced-options.
> - “PMCC” or “poor man’s covered call” — routes to advanced-options (different structure: short call, not long put).
> - “LEAPS + CSP” or “LEAPS with income” — routes to leaps-csp-replacement (the v2 strategy, no protective put).
> - “Hedged LEAPS” without specifying structure — defaults to this strategy with a clarifying note in the output: “Assumed protective put hedge; for short-call hedge see PMCC.”

### 2.5 Data Source

All market data sourced from Polygon.io via existing data layer. The strategy requires options chain access for BOTH calls and puts on the same underlying, with greeks, IV, OI, and bid/ask. No new endpoints beyond what existing strategies already consume.

-----

## 3. Strategy Mechanics

### 3.1 The Core Coupling

The defining feature of this strategy is that the put leg parameters are mathematical functions of the LEAPS leg parameters, not independent selections. The engine evaluates put candidates RELATIVE to the LEAPS that has been chosen.

#### 3.1.1 Put Strike Selection

Given a LEAPS at strike K_call with stock spot S, the put strike K_put is selected from candidates in this band:

```
K_put ∈ [S × 0.80, S × 0.92]

Floor depth = (S − K_put) / S × 100
  Shallow floor:  8–12%  (cheaper, less protection)
  Standard floor: 12–16% (balanced)
  Deep floor:     16–20% (expensive, strong protection)
```

#### 3.1.2 Put Expiry Selection

Put expiry is selected from this set, in priority order:

1. Match LEAPS expiry (gold standard — full-duration protection, one decision point).
1. LEAPS expiry minus 90 days (cheaper, but creates a gap where LEAPS is unprotected at end of life).
1. 180 DTE (half-duration, rolled at expiry — most flexibility, most management overhead).
1. 90 DTE (quarterly roll, lowest cost per quarter but highest annual cost and most rolls).

The screener evaluates all four expiry options for each LEAPS and presents the one with the best risk-adjusted score, with the alternatives surfaced in the dashboard.

#### 3.1.3 Cost Drag Constraint

The put debit is evaluated as a percentage of the LEAPS debit:

```
Cost drag % = (put debit / LEAPS debit) × 100
```

- Cost drag ≤ 8% → excellent (insurance is cheap relative to position)
- Cost drag 8–15% → standard
- Cost drag 15–25% → expensive but acceptable for high-conviction or high-vol names
- Cost drag > 25% → hard fail (insurance eats too much of the upside thesis)

### 3.2 P&L Math

The combined position has a well-defined P&L curve. The engine computes the following for every candidate:

#### 3.2.1 Max Loss

```
Max Loss = LEAPS debit + Put debit − Put intrinsic at floor

Where Put intrinsic at floor = max(0, K_put − S_min) × 100
And S_min = the stock price at which we'd close the position (typically K_put itself,
since the put cushions losses below this level).

At expiry, if stock = K_put:
  Max Loss = LEAPS debit + Put debit − (LEAPS intrinsic at K_put)
           = LEAPS debit + Put debit − max(0, K_put − K_call) × 100

For deep ITM LEAPS where K_call < K_put (always true when buying ITM call + OTM put):
  Max Loss at K_put = LEAPS debit + Put debit − (K_put − K_call) × 100
```

#### 3.2.2 Max Loss at Catastrophe (S = 0)

```
Max Loss at $0 = LEAPS debit + Put debit − (K_put × 100)

This is the worst-case loss. The put pays K_put × 100 at stock = $0, offsetting
most of the LEAPS debit. The hedge fully activates.
```

#### 3.2.3 Breakeven

```
Breakeven (at LEAPS expiry, put expired worthless) = K_call + (LEAPS debit + Put debit) / 100

Note: if put expires before LEAPS, breakeven calculation shifts — put debit is already
a sunk cost and you need to reset for whether to renew protection.
```

#### 3.2.4 Upside Retention

```
Upside retention % vs naked LEAPS at +20% stock move:
  = (Collared P&L / Naked LEAPS P&L) × 100

A well-structured collar retains 85–95% of LEAPS upside on a +20% move.
A poorly-structured collar (expensive put) retains 70–80%.
```

### 3.3 Strategy Lifecycle

#### 3.3.1 Discovery (Screening Run)

1. Run market gate. If FAIL, no new opportunities surfaced; report state and stop.
1. Run universe filters (file 01) on stock universe.
1. Apply stock hard fails (file 02) — earnings within 14 days, below 200d MA, recent M&A, etc.
1. For each surviving stock, identify the best LEAPS candidate per the LEAPS rubric (section 4.3.1).
1. Apply LEAPS trade hard fails on the candidate.
1. For each qualifying LEAPS, identify candidate puts across the four expiry options and three floor depth bands (12 candidates per LEAPS to evaluate).
1. Apply put trade hard fails on each.
1. Compute combined P&L metrics (max loss, breakeven, upside retention at +20%, cost drag).
1. Score the LEAPS leg, the put leg, and the structural quality of the combination per section 5.
1. Emit the highest-scoring put for each qualifying LEAPS as the primary recommendation. Surface up to 2 alternative collar structures (different floor depths or expiries) as alternatives in the dashboard.
1. Rank all opportunities by combined score, descending. All qualifying opportunities included.
1. Generate output: ranked opportunity table + per-opportunity validation dashboard.

#### 3.3.2 Monitoring (Post-Entry, User-Initiated)

- LEAPS leg: still in delta band, still acceptable extrinsic %, IV not collapsed below floor.
- Put leg: still ≥ 60 DTE if shorter-duration option chosen, still providing meaningful protection.
- Combined position: P&L scenarios re-computed daily against current spot.
- Catastrophe-rule conditions checked (section 7.3).

#### 3.3.3 Exit

Exit guidance is generated per opportunity per section 7. The strategy has THREE distinct exit considerations because the legs interact:

- Exit both legs (close position entirely).
- Roll the LEAPS, keep the put (LEAPS hit DTE/delta trigger; put still has duration).
- Roll the put, keep the LEAPS (put expired or near expiry; renew protection).

-----

## 4. Screening Pipeline Integration

### 4.1 File 01 — Stock Universe Filters

Same as v2 LEAPS-CSP strategy (price ≥ $10, ADV ≥ 2M, market cap ≥ $10B, 12+ month chain depth, excludes biotech / leveraged ETFs / SPACs / recent IPOs).

ADDITIONAL collar-specific requirement: the underlying must have a liquid PUT chain at OTM strikes (≥ 5 strikes between 70% and 95% of spot with OI ≥ 200 each). Without put liquidity, the collar can’t be constructed.

### 4.2 File 02 — Stock Hard Fails

All v2 LEAPS-CSP hard fails apply. Strategy-specific additions/modifications:

- Earnings within 14 days → reject (same as v2).
- Stock below 200-day MA AND below 50-day MA → reject.
- Stock has dropped >15% in last 5 sessions → reject.
- Pending M&A → reject.
- Short float > 20% → reject.
- IV Rank > 80 → reject for LEAPS (same as v2 — IV crush risk on the long leg).
- IV Rank < 15 → CAUTION on put leg (put insurance is cheap when IVR is low — actually good; but very low IVR can mean stock is too “sleepy” to justify protection). Not a fail, just a caution flag.

### 4.3 File 04 — Trade Hard Fails

#### 4.3.1 LEAPS Leg Hard Fails

- Delta < 0.70 or > 0.90 → reject.
- DTE < 365 or > 730 → reject.
- Bid/ask spread > 5% of mid → reject.
- Open interest < 100 → reject.
- Daily volume = 0 for last 5 sessions → reject.
- Extrinsic value > 15% of contract price → reject.
- Contract IV > 1.5× IV30 baseline → reject.

#### 4.3.2 Put Leg Hard Fails

- Delta outside [−0.30, −0.10] band → reject (target −0.15 to −0.25).
- Strike outside [S × 0.78, S × 0.94] band → reject (floor depth must be 6–22%).
- DTE < 60 → reject (too short to provide meaningful protection over LEAPS holding period).
- DTE > LEAPS DTE → reject (put cannot outlive LEAPS in this structure).
- Bid/ask spread > 10% of mid OR > $0.15 absolute → reject.
- Open interest < 200 → reject.
- Daily volume = 0 for last 5 sessions → reject.

#### 4.3.3 Combined Structure Hard Fails

- Cost drag > 25% → reject (insurance too expensive relative to position).
- Max loss at catastrophe (S = 0) ≥ 65% of total debit → reject (the collar isn’t actually capping enough downside).
- Upside retention at +20% move < 75% → reject (collar drag eats too much upside; structure is inefficient).

> **Why these combined-structure fails matter**
> 
> Individual legs can each pass their own hard fails but combine into a bad collar. Example: LEAPS at 0.75 delta with 12% extrinsic + put with 8% cost drag, but the put expires 6 months before the LEAPS — the structure leaves the LEAPS naked for half its life. The combined check catches these.

### 4.4 File 03 — Caution Flags (Informational Only)

- Earnings within 14–30 days → −1.0.
- Stock between 50d and 200d MA → −0.5.
- IV Rank 60–80 on LEAPS leg → −0.5.
- Put DTE significantly less than LEAPS DTE (gap > 180 days) → −0.5 (you’ll need to renew the put before LEAPS exit).
- Cost drag 15–25% → −0.5 (expensive insurance; acceptable but flagged).
- Upside retention at +20% in 75–85% range → −0.3 (mediocre structure).
- Put strike near key support level (within 2% of 200d MA) → **+0.3 (BONUS: technically intelligent floor placement).**
- FOMC/CPI/NFP within 5 trading days → −0.5.

-----

## 5. Scoring Model (Score out of 10)

This strategy uses THREE sub-scores (LEAPS leg, put leg, structural quality) combined into a single opportunity score. The structural quality score is what makes this a multi-leg strategy — it measures how well the legs work TOGETHER, not just individually.

### 5.1 LEAPS Leg Sub-Score

Identical to v2 LEAPS-CSP rubric. See section 5.1 of that SRS. Components: stock trend strength, delta band, extrinsic %, IV state, liquidity, fundamental grade, distance to earnings.

### 5.2 Put Leg Sub-Score

Different from any prior module — puts in this strategy are insurance, not income. Scoring favors CHEAP, LONG-DATED protection at a STRATEGIC floor:

|Component                              |Weight|Scoring rule                                                                                                                                                                                           |
|---------------------------------------|------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|Floor placement quality                |25%   |Put strike at/near 200d MA: 10. Within 3% of 200d MA: 8. Within 8% of 200d MA: 5. Above 200d MA: 3 (too high; not a real floor). Far below 200d MA: 2 (floor exists but stock would already be broken).|
|Cost efficiency (cost per % protection)|25%   |(Cost drag %) / (Floor depth %) ratio. ≤ 0.6: 10. 0.6–1.0: 8. 1.0–1.5: 5. 1.5–2.0: 2.                                                                                                                  |
|Duration alignment with LEAPS          |20%   |Put DTE = LEAPS DTE: 10. Put DTE within 90 days of LEAPS DTE: 8. Within 180 days: 5. More than 180 days short: 2.                                                                                      |
|Delta in target band                   |10%   |−0.18 to −0.22: 10. −0.15 to −0.18 or −0.22 to −0.25: 8. Outside but in [−0.30, −0.10]: 5.                                                                                                             |
|IV state on put                        |10%   |Put IV ≤ 25th percentile of 252-day IV: 10. 25–50th percentile: 8. 50–75th: 5. >75th: 2 (put is expensive).                                                                                            |
|Liquidity (spread + OI)                |10%   |Spread <3% AND OI >500: 10. <5% AND >250: 8. <10% AND >200: 5.                                                                                                                                         |

### 5.3 Structural Quality Sub-Score (THE KEY ONE)

This is what makes Collared LEAPS a real multi-leg strategy. The structural quality score measures how well the put and LEAPS work TOGETHER as a single position. Components:

|Component                                           |Weight|Scoring rule                                                                                                          |
|----------------------------------------------------|------|----------------------------------------------------------------------------------------------------------------------|
|Upside retention at +20% move                       |30%   |≥95%: 10. 90–95%: 9. 85–90%: 7. 80–85%: 5. 75–80%: 3. <75% already hard-failed.                                       |
|Max loss as % of total debit                        |25%   |≤30%: 10. 30–40%: 8. 40–50%: 6. 50–60%: 4. 60–65%: 2. >65% already hard-failed.                                       |
|Breakeven distance from spot                        |15%   |Breakeven within 5% of spot: 10. 5–8%: 8. 8–12%: 5. >12%: 2 (need substantial move just to break even).               |
|Risk/reward ratio (upside potential / max loss)     |15%   |Ratio ≥3.0: 10. 2.0–3.0: 8. 1.5–2.0: 6. 1.0–1.5: 4. <1.0: 2.                                                          |
|Hedge efficiency (max loss reduction vs naked LEAPS)|15%   |Collar reduces max loss by ≥60% vs naked LEAPS: 10. 50–60%: 8. 40–50%: 6. 30–40%: 4. <30%: 2 (put isn’t doing enough).|


> **How to interpret structural quality**
> 
> A LEAPS scoring 9.0 paired with a put scoring 8.0 might have structural quality of 5.5 if the put protects too little of the LEAPS, or if upside retention is poor. Conversely, mediocre individual legs can combine into an excellent collar if they’re well-matched. The structural score is the strategy’s actual edge — it rewards GOOD STRUCTURE over good individual contracts.

### 5.4 Combined Opportunity Score

Final combined score weights the three sub-scores:

```
Combined Score = (LEAPS Sub-Score × 0.35)
               + (Put Sub-Score × 0.25)
               + (Structural Quality × 0.40)

Then subtract caution flag deductions, add bonuses, floor at 0, ceiling at 10, round to 1 decimal.
```

Why structural quality is weighted highest: in a true multi-leg strategy, the structure matters MORE than any individual leg. A great LEAPS with a poorly-matched put is a worse position than a good LEAPS with a well-matched put.

### 5.5 Grade Bands

|Score     |Grade|Quality interpretation                                                                                                |
|----------|-----|----------------------------------------------------------------------------------------------------------------------|
|9.0 – 10.0|A+   |Excellent collar. Strong LEAPS, well-priced put, structure retains most upside while sharply limiting downside.       |
|8.0 – 8.9 |A    |Strong collar. Some compromise on one of three dimensions (typically cost drag or duration alignment).                |
|7.0 – 7.9 |B    |Acceptable. Functional collar with notable drag OR alignment compromise.                                              |
|6.0 – 6.9 |C    |Marginal. Surfaced for transparency; structure is doing less than it should.                                          |
|< 6.0     |F    |Low quality collar. Likely better to run naked LEAPS or different strategy entirely. Shown only via “show all” toggle.|


> **All qualifying opportunities surfaced, no truncation by count or capital**
> 
> Same philosophy as v2 LEAPS-CSP. All scored opportunities included. Default views show A+, A, B. C and F accessible via toggle. The user decides deployment based on their capital.

-----

## 6. Market Gate Overlay

Same gate conditions as v2 LEAPS-CSP (SPX vs 50d MA, VIX level, VIX 5d change, SPX vs 200d, HYG/IEF ratio). Strategy-specific overlay:

### 6.1 Gate Actions for Collared LEAPS

- **PASS** — all qualifying opportunities surfaced normally.
- **CAUTION** — opportunities still surfaced. Combined score floor for default view raised from 7.0 to 7.5. Put leg scoring weight in combined score increased from 0.25 to 0.30 (insurance more valued in choppy regime).
- **FAIL** — opportunities still surfaced (this is the key difference from naked LEAPS strategies). The collar’s whole purpose is to handle bear regimes. In FAIL state, ONLY collared LEAPS opportunities with cost drag ≤ 15% and floor depth ≥ 12% are shown — i.e., strong protection at reasonable cost.

> **Why this strategy survives FAIL gates**
> 
> Naked LEAPS and LEAPS+CSP are suppressed when the market gate fails because the downside risk is unbounded. Collared LEAPS has a hard floor by construction — that’s the entire point. So it remains deployable in FAIL regimes, with the screener tightening structural requirements rather than blocking entries.

### 6.2 Required Output Header

Standard format, with collar-specific footer line:

```
Market Gate: [PASS|CAUTION|FAIL]
SPX: 5,xxx.xx | 50d MA: 5,xxx.xx | 200d MA: 5,xxx.xx
VIX: xx.xx | VIX 5d change: ±xx%
HYG/IEF: x.xxxx (trend: ↑/↓/→)
Effect on this run: [Normal | Filtered to A/A+ only | Strong-protection-only (FAIL mode)]
Avg cost drag in surfaced set: xx.x%
Avg floor depth in surfaced set: xx.x%
```

-----

## 7. Exit Strategy and Risk Mitigation

Collared LEAPS exit management is more complex than single-leg or independent-leg strategies because the two legs can be rolled, kept, or closed in any combination. The dashboard surfaces guidance for each of the three exit paths.

### 7.1 Close Both Legs (Exit Position Entirely)

|Condition                                        |Action                                                                                    |Reasoning                                                                                  |
|-------------------------------------------------|------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
|Combined position P&L reaches +40% of total debit|Close both legs. Take profit.                                                             |Collar caps upside slope above a point; taking 40% gain is efficient capital recycling.    |
|Stock breaks below put strike on closing basis   |Close both legs. Put is now ITM and providing its insurance value; LEAPS thesis is broken.|Realize the put gain; LEAPS continues to lose. Net result is bounded loss as designed.     |
|Stock breaks below 200-day MA on closing basis   |Close both legs.                                                                          |Trend break invalidates LEAPS thesis even if put is still OTM.                             |
|Combined position P&L drops to −30%              |Close both legs.                                                                          |The collar isn’t doing its job; cut and reassess. (Should be rare given structural design.)|
|LEAPS DTE < 90 AND put DTE < 60                  |Close both, evaluate new structure                                                        |End-of-life on both legs; cleaner to re-open fresh than roll both simultaneously.          |

### 7.2 Roll the LEAPS, Keep the Put

|Condition                                        |Action                                                                    |Reasoning                                                                                |
|-------------------------------------------------|--------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
|LEAPS DTE < 90 days AND put DTE > 180            |Roll LEAPS to new 12–18 month expiry, same delta band. Keep existing put. |Put still has duration; LEAPS needs refresh.                                             |
|LEAPS delta > 0.95 AND put still OTM             |Roll LEAPS up and out to restore 0.78 delta. Keep put (still valid floor).|Lock in directional profit on LEAPS; put continues to protect the (new, higher) position.|
|LEAPS premium reaches +50% AND put still ≥ 90 DTE|Take partial LEAPS profit (close 50%). Keep put at full size.             |Put now over-insures remaining LEAPS — accept the over-protection as a free hedge.       |

### 7.3 Roll the Put, Keep the LEAPS

|Condition                                                         |Action                                                                                 |Reasoning                                                                   |
|------------------------------------------------------------------|---------------------------------------------------------------------------------------|----------------------------------------------------------------------------|
|Put DTE < 60 AND LEAPS DTE > 180                                  |Buy a new put (same band as initial selection); close or let expire the existing one.  |Protection gap forming; refresh the floor.                                  |
|Put expired worthless (stock above strike at expiry)              |Buy new put at fresh delta/DTE band per current spot.                                  |Insurance lapsed; restore protection.                                       |
|Put strike now far OTM (>20% below spot due to stock appreciation)|Roll put UP to maintain 12–16% floor depth below new spot. Cost: incremental put debit.|Original put no longer provides meaningful protection at current spot level.|
|IVR on put leg has dropped below 25th percentile                  |Consider rolling to a longer-dated put while IV is cheap.                              |Lock in cheap insurance while available.                                    |

### 7.4 Whole-Position Catastrophe Rules

> ⚠️ **Hard kill switches**
> 
> These conditions trigger the highest-priority alert. The collar protects against most catastrophes by design, but these still warrant manual review:
> 
> 1. Underlying halts trading or has flash crash event (put may not be exercisable at intended price).
> 1. Issuer announces fraud, accounting restatement, or going-concern warning.
> 1. SPX drops >7% in single session AND put delta has spiked above −0.60 (collar is engaging — confirm execution capacity).
> 1. VIX > 40 AND put IV has tripled (consider closing put early to lock in massive gain, then deciding LEAPS fate separately).

### 7.5 Recovery / Cool-Down

- Stop-loss closure on both legs — ticker flagged 30 days; new opportunities get caution flag, not suppressed.
- Collar engaged (closed both legs profitably at put strike breach) — ticker NOT flagged; the strategy worked as designed.
- Catastrophe rule triggered — ticker flagged 90 days.

-----

## 8. Next-Leg Variable Recommendations

The dashboard pre-computes variables for each of the three exit paths. The user picks which path matches their situation; the variables are ready.

### 8.1 LEAPS Roll Candidates (Keep Put)

|Field                                |Source                        |Notes                                                                        |
|-------------------------------------|------------------------------|-----------------------------------------------------------------------------|
|Roll-out target expiry               |Polygon chain                 |12–18 months out                                                             |
|Roll-out strikes (3 candidates)      |Polygon chain, delta 0.75–0.85|Show delta, premium, extrinsic %                                             |
|Net debit per roll                   |Computed                      |(new ask) − (current bid)                                                    |
|Resulting cost drag with EXISTING put|Computed                      |Re-evaluate structural quality with the new LEAPS + existing put             |
|New structural quality score         |Computed                      |If structural quality drops below 7.0, alert: “Consider also refreshing put.”|
|IVR at new expiry                    |Computed                      |Flag if >60                                                                  |

### 8.2 Put Roll Candidates (Keep LEAPS)

|Field                                  |Source                             |Notes                                                        |
|---------------------------------------|-----------------------------------|-------------------------------------------------------------|
|Floor depth options                    |Computed                           |Shallow / Standard / Deep — three candidates                 |
|Duration options                       |Computed                           |Match LEAPS / 180 DTE / 90 DTE                               |
|Cost per candidate                     |Polygon chain                      |Put ask                                                      |
|Resulting cost drag with EXISTING LEAPS|Computed                           |Each candidate’s drag % shown                                |
|Upside retention impact                |Computed                           |How does the new put change the +20% scenario?               |
|Recommended candidate                  |Highest structural-quality re-score|The one that best preserves the original strategy’s character|

### 8.3 Position Conversion Variables

If conditions warrant restructuring entirely:

- **Convert to PMCC:** sell OTM call against the LEAPS to generate income, drop the put. (Note: this removes the floor and adds upside cap — routes to advanced-options for management.)
- **Convert to naked LEAPS:** close the put to capture any remaining value and accept naked downside (rational if you’ve become more bullish OR if IV crush has decimated the put).
- **Convert to LEAPS + CSP (the v2 strategy):** close the put, write a CSP on a separately-scored ticker for income. (Loses the hedge, gains income on a separate name.)
- **Convert to vertical bull call spread:** sell an OTM call AND close the put. Caps upside, removes floor, recovers capital.

-----

## 9. Output Artifacts

### 9.1 Ranked Opportunity Table Schema

Add to `outputs/collared-leaps-watchlist-schema.md`. One row per ranked opportunity, sorted by combined score descending. No truncation.

|Column                 |Type             |Source / Format                                     |
|-----------------------|-----------------|----------------------------------------------------|
|Rank                   |Integer          |Ordering by combined score                          |
|Ticker                 |String           |Underlying (same for both legs)                     |
|LEAPS Strike           |Currency         |From chain                                          |
|LEAPS Expiry           |Date             |YYYY-MM-DD                                          |
|LEAPS Delta            |Decimal          |From greeks                                         |
|LEAPS Premium          |Currency         |Mid × 100                                           |
|Put Strike             |Currency         |From chain                                          |
|Put Expiry             |Date             |YYYY-MM-DD                                          |
|Put Delta              |Decimal          |Negative                                            |
|Put Premium            |Currency         |Mid × 100                                           |
|Floor Depth %          |Percent          |(S − K_put) / S × 100                               |
|Cost Drag %            |Percent          |Put debit / LEAPS debit × 100                       |
|Total Debit            |Currency         |LEAPS premium + Put premium (reported, not enforced)|
|Max Loss               |Currency         |Per section 3.2.1                                   |
|Max Loss vs Naked LEAPS|Percent reduction|Hedge efficiency                                    |
|Breakeven              |Currency         |Stock price at LEAPS expiry                         |
|Upside Retention @ +20%|Percent          |Vs naked LEAPS                                      |
|LEAPS Sub-Score        |0–10             |Per section 5.1                                     |
|Put Sub-Score          |0–10             |Per section 5.2                                     |
|Structural Quality     |0–10             |Per section 5.3                                     |
|Combined Score         |0–10             |Per section 5.4                                     |
|Grade                  |A+/A/B/C/F       |Per section 5.5                                     |
|Caution Flags          |List             |Comma-separated codes                               |

### 9.2 Per-Opportunity Validation Dashboard

Add to `outputs/collared-leaps-dashboard-schema.md`. Sections:

1. **Header** — ticker, combined score, grade, market gate state.
1. **LEAPS Leg Panel** — contract details, sub-score breakdown, caution flags.
1. **Put Leg Panel** — contract details, sub-score breakdown, IV percentile, caution flags.
1. **Structural Quality Panel** — upside retention chart, max loss visualization, cost drag breakdown, hedge efficiency.
1. **P&L Curve Visualization** — full payoff diagram at expiry showing combined position vs naked LEAPS comparison.
1. **P&L Scenarios** — table showing combined P&L at −30%, −20%, −10%, flat, +10%, +20%, +30% price moves at three time horizons.
1. **Alternative Collar Structures** — top 2 alternative put pairings for the same LEAPS (different floor depths or expiries) with their structural scores.
1. **Exit Rules Active** — checklist of section 7 rules across all three exit paths.
1. **Next-Leg Variables** — pre-populated per section 8.
1. **Audit Trail** — every field tagged with source.

### 9.3 P&L Curve Visualization Requirements

The payoff diagram is essential for this strategy — users need to SEE the floor. Requirements:

- X-axis: stock price from 50% to 150% of current spot.
- Y-axis: P&L in dollars.
- Two lines: “Collared” (blue) and “Naked LEAPS only” (gray, dashed).
- Vertical markers: current spot (green), put strike (orange), LEAPS strike (purple), breakeven (red).
- Shaded region: “floor zone” below put strike showing max loss clearly bounded.
- Visible at expiry by default; toggleable to 30/60/90/180 days from now.

### 9.4 File Outputs

- Excel workbook (.xlsx) — ranked tab + one tab per opportunity dashboard.
- Word document (.docx) — formal report version.
- Optional React dashboard component with the P&L curve as the centerpiece visualization.

-----

## 10. Data Requirements (Polygon.io)

### 10.1 Required Endpoints

Same endpoint set as v2 LEAPS-CSP. The only addition is heavier use of the put side of the options chain — every qualifying LEAPS triggers evaluation of ~12 put candidates (4 expiries × 3 floor depths).

|Endpoint                                          |Purpose                            |Frequency                                                |
|--------------------------------------------------|-----------------------------------|---------------------------------------------------------|
|`/v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}`|Daily bars for MAs, ATR, IV history|Daily, 252+ days                                         |
|`/v2/snapshot/.../{ticker}`                       |Current price, day change          |Per screening run                                        |
|`/v3/snapshot/options/{underlyingAsset}`          |Full chain — calls AND puts        |Per screening run (heavier than v2 due to put evaluation)|
|`/v3/reference/options/contracts`                 |Contract metadata                  |Daily                                                    |
|`/vX/reference/financials`                        |Fundamental data                   |Quarterly                                                |
|`/v3/reference/tickers/{ticker}`                  |Sector, market cap                 |Weekly                                                   |
|Earnings calendar                                 |14-day gate                        |Daily                                                    |

### 10.2 Computed Fields

- Put IV percentile (252-day) — separate from underlying IVR; specific to put-side skew.
- Combined position P&L at price grid (200 points from 50%–150% of spot) — needed for payoff visualization.
- Upside retention % — computed at +20% move scenario.
- Hedge efficiency % — (naked LEAPS max loss − collared max loss) / naked LEAPS max loss.
- Combined greeks: delta (LEAPS Δ − Put Δ since put delta is negative for long puts), theta (LEAPS θ + Put θ, both negative for long positions), vega (LEAPS ν + Put ν).

### 10.3 Caching Strategy

- Standard cache rules apply (daily bars 24h, chains 15min during market hours, fundamentals 7d).
- Combined-position P&L grids are computed live per opportunity, not cached (depend on current spot which changes constantly).

### 10.4 Live Data Rule Compliance

> ⚠️ **Mandatory**
> 
> Per `core/live-data-rule.md`, every price, earnings date, MA level, and IV value must be sourced live. Memory-recalled values forbidden. Every field carries a source label. Unavailable fields → candidate fails trade hard fails (file 04). Particularly important here because the P&L math depends on accurate live premiums for BOTH legs — a stale put premium causes systematically wrong structural quality scores.

-----

## 11. Engineering Practices and UX Requirements

### 11.1 Module Structure

```
src/
  strategies/
    collared_leaps/
      __init__.py
      pipeline.py             # orchestrates screening 01–08
      leaps_filter.py         # LEAPS leg selection + hard fails
      put_filter.py           # Put leg candidate generation (12 per LEAPS)
      structure_evaluator.py  # The KEY module — computes P&L, structural quality
      scoring.py              # Implements 3-sub-score model from section 5
      exit_rules.py           # 3-path exit logic from section 7
      next_leg.py             # Pre-computed roll variables per section 8
      payoff_curve.py         # Generates P&L data series for visualization
      output_builder.py       # xlsx / docx / dashboard JSON
      tests/
        test_filters.py
        test_scoring.py
        test_structure.py     # Critical: validates P&L math against known cases
        test_exit_rules.py
        fixtures/
```

### 11.2 The Critical Module: structure_evaluator.py

This module is where the strategy’s edge lives. It must be reviewed carefully and tested thoroughly. Required functionality:

- Given a LEAPS contract and a put contract, compute: max loss, max loss at S=0, breakeven, upside retention at +20%, hedge efficiency, cost drag.
- Generate a P&L curve with at least 200 stock-price points across [0.5×S, 1.5×S].
- Verify mathematically: at K_put, combined P&L should equal (− total debit + LEAPS intrinsic at K_put). Unit test this for known cases.
- Verify: as stock → 0, combined P&L should approach (put strike × 100 − total debit).
- Verify: above LEAPS strike + total debit / 100, position should be profitable.

### 11.3 Configuration

`config/strategies/collared_leaps.yaml` exposes user-overridable quality thresholds:

- Delta bands for both legs.
- DTE bands for both legs.
- Floor depth bands (default: 8–22%).
- Cost drag hard fail threshold (default 25%).
- Upside retention hard fail threshold (default 75%).
- Max loss as % of debit hard fail (default 65%).
- Sub-score weights in combined score (default 0.35/0.25/0.40).
- Default grade-filter floor (default B).

> **Configuration philosophy**
> 
> Config controls QUALITY thresholds, not capital. No “max debit per opportunity,” no “max positions,” no “min ROI required.” The user evaluates the ranked output against their capital.

### 11.4 Logging and Audit

- Every run produces a run log with run_id, timestamp, market gate state, LEAPS evaluated, put candidates per LEAPS evaluated, hard fails recorded, final ranking.
- P&L math results logged per opportunity for forensic review (the structural quality calculations are the most likely source of subtle bugs).
- Run logs retained 1 year minimum.

### 11.5 Testing Requirements

- Unit tests for every hard fail rule (pass/fail cases).
- Unit tests for every scoring component.
- **CRITICAL: P&L math tests against hand-computed scenarios.** At minimum: 5 manually computed positions with known max loss, breakeven, upside retention — engine must reproduce within $1 and 0.5% respectively.
- Unit test confirming structural quality correctly rewards good structure over good individual legs (constructed adversarial fixture).
- Integration test: full pipeline run on a fixture universe, asserting expected ranking.
- Backtest harness: replay historical Polygon data, generate hypothetical collared positions, verify P&L curves match what actually happened on those dates.

### 11.6 UX Requirements

- Screening run completes within 90 seconds for a 500-ticker universe (longer than v2 because each LEAPS triggers 12 put evaluations).
- Ranked table is the default landing screen.
- Each row clickable, opens dashboard.
- Dashboard’s payoff curve is the centerpiece — large, interactive, scrubable across time.
- Hover any P&L scenario row → highlights the corresponding point on the payoff curve.
- Three “exit path” sections in dashboard clearly separated (close both / roll LEAPS / roll put).
- Optional affordability filter — user-driven slider, NEVER default behavior.

### 11.7 Error Handling

- Polygon API failure → retry with backoff up to 3 attempts; mark Unavailable if still failing.
- Put chain returns no qualifying candidates for a LEAPS → LEAPS is dropped from this strategy’s output (the strategy requires a put). User is shown a hint: “LEAPS qualified but no acceptable put hedge available; consider leaps-csp-replacement or naked LEAPS via advanced-options.”
- P&L math returns NaN or impossible values → reject the candidate AND log it as a defect for engineering review.
- Universe filter eliminates all tickers → empty ranking with explicit message.

-----

## 12. Acceptance Criteria

### 12.1 Functional Acceptance

1. **Routing** — “collared LEAPS” and other trigger phrases route to new strategy file.
1. **Hard fails** — test universe of 50 tickers including known-bad cases. Pipeline rejects each with correct reason.
1. **Scoring** — 10 fixture candidates with hand-computed expected scores; engine within ±0.1.
1. **P&L math** — 5 hand-computed positions; engine reproduces max loss within $1, breakeven within $0.10, upside retention within 0.5%.
1. **Structural quality scoring** — adversarial fixture proves structural score correctly differentiates well-matched from poorly-matched leg combinations.
1. **Market gate** — PASS / CAUTION / FAIL all correctly handled. Confirm FAIL state still surfaces opportunities (this is the key collar distinction).
1. **No capital filtering** — regression test confirms $500-stock and $30-stock opportunities can rank adjacent purely on quality.
1. **No truncation** — all qualifying opportunities surfaced. Default view filters by grade.
1. **Three exit paths** — each implemented and unit-tested in exit_rules.py.
1. **Next-leg pre-computation** — when an opened position is flagged, all three exit paths have variables pre-populated.
1. **Payoff curve visualization** — renders correctly with all required markers and toggles.
1. **Outputs** — Excel and Word generate without errors with all sections.

### 12.2 Non-Functional Acceptance

- 90-second screening run for 500-ticker universe.
- Audit trail present on every output row.
- Polygon failure handling tested.
- Config overrides all quality-threshold parameters (and zero capital parameters by design).

### 12.3 Edge Cases the Engine Must Handle

|Edge case                                                            |Expected behavior                                                                                                  |
|---------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
|LEAPS qualifies but no put expiry matches LEAPS expiry               |Try shorter-duration puts (180 / 90 DTE); structural score will reflect duration misalignment penalty              |
|Put IV is dramatically higher than LEAPS IV (high put skew)          |Cost drag will be high; combined score reflects the expensive insurance; may still be acceptable for high-vol names|
|Stock has put chain but no OI in the target floor band               |Reject all put candidates in that band; if no put leg qualifies, drop this LEAPS opportunity                       |
|LEAPS strike happens to be ABOVE put strike (impossible structurally)|Verify K_call < K_put always; if not, reject as data error and log defect                                          |
|Market gate FAIL but opportunity has 20% cost drag                   |Reject this opportunity (FAIL mode requires drag ≤15%)                                                             |
|User has 5 opportunities already opened on same ticker               |Module surfaces new opportunities normally — concentration is user’s call, not module’s                            |
|Both LEAPS and put are illiquid mid-day                              |Reject; surface data quality warning                                                                               |

-----

### 12.4 Out-of-Scope (v1)

- Capital, slot, and position-sizing logic.
- Portfolio-level diversification rules.
- Dynamic put-rolling logic during a single screening run (the strategy rolls puts as a discrete user-initiated action).
- Multi-account allocation.
- Tax-lot accounting.
- Real-time intraday alerts.
- Auto-execution.
- Asymmetric collars (different put quantity than LEAPS — e.g., 1 LEAPS + 2 puts for amplified protection). Possible v2 feature.
- Calls on the short leg (that’s a PMCC; lives in advanced-options).

-----

## 13. Appendix

### 13.1 Worked Example (Illustrative)

All numbers illustrative — engine must compute live.

> ✅ **Example A+ collared LEAPS — illustrative**
> 
> - **Ticker:** NVDA @ $720
> - **LEAPS:** Jan 2028 $600 Call, delta 0.79, premium $185.00 ($18,500 per contract)
> - **Put:** Jan 2028 $620 Put, delta −0.21, premium $42.50 ($4,250 per contract)
> - **Floor Depth:** ($720 − $620) / $720 = 13.9% (standard)
> - **Cost Drag:** $4,250 / $18,500 = 23.0% (high — but acceptable for high-vol name)
> - **Total Debit:** $22,750
> - **Max Loss at $620 (put strike):** $22,750 − ($620 − $600) × 100 = $20,750
> - **Max Loss at $0:** $22,750 − $620 × 100 = $22,750 − $62,000 = floor protects in full; loss = $22,750 − $62,000 + $18,500 LEAPS = put fully offsets, max loss bounded ≈ $22,750 − floor recovery
> - **Breakeven at LEAPS expiry:** $600 + ($22,750 / 100) = $827.50
> - **Upside Retention @ +20% ($864):** LEAPS profit = ($864 − $600) × 100 − $18,500 = $7,900. Collared profit = $7,900 − $4,250 put debit = $3,650. Retention = 46%. POOR — this would actually FAIL the 75% retention threshold.
> 
> **Result:** this example would NOT pass hard fails. Engine would re-evaluate with a deeper-OTM put (lower cost) to improve retention, or different LEAPS strike. Iterative selection.
> 
> This is exactly why the structural quality scoring matters — individual legs each look fine, but the combination has poor risk/reward. The screener catches it.

### 13.2 Relationship to Existing Modules

|Existing Module                |Relationship to Collared LEAPS                                                                                |
|-------------------------------|--------------------------------------------------------------------------------------------------------------|
|leaps-csp-replacement (v2)     |Different ticker for CSP; no protective put. Independent legs.                                                |
|advanced-options (PMCC)        |Short call against LEAPS for income, CAPS upside. Collared LEAPS uses long put instead, KEEPS upside uncapped.|
|advanced-options (collar wheel)|Different — wraps owned shares with put + short call. Collared LEAPS wraps LEAPS with put only.               |
|vertical-spread                |Defined risk/reward in same expiry. Collared LEAPS is multi-expiry, multi-leg.                                |
|option-validator               |Can validate individual legs of a collar trade after construction.                                            |
|wheel-50 / 100 / 200           |Pure stock-replacement income; no LEAPS, no hedge.                                                            |

### 13.3 Glossary

|Term              |Definition                                                                       |
|------------------|---------------------------------------------------------------------------------|
|Collared LEAPS    |Long deep ITM LEAPS call paired with long OTM put on same underlying             |
|Floor depth       |Distance from spot to put strike, as % of spot. Defines worst-case loss boundary.|
|Cost drag         |Put debit as % of LEAPS debit. The price of the insurance.                       |
|Upside retention  |% of naked-LEAPS gain the collar preserves at a given price move (default +20%)  |
|Hedge efficiency  |% reduction in max loss vs naked LEAPS                                           |
|Structural quality|Sub-score measuring how well the two legs work TOGETHER (not individually)       |
|Floor zone        |Range below put strike where loss is bounded by the put                          |

### 13.4 Changelog

|Version|Date      |Change                                                                                                         |
|-------|----------|---------------------------------------------------------------------------------------------------------------|
|1.0    |2026-05-26|Initial SRS for Collared LEAPS strategy module — first true multi-leg strategy with structural quality scoring.|

-----

*End of Document.*