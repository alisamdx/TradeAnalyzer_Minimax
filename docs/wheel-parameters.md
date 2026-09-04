# Wheel parameter inventory

Every parameter that stands between "the market opened" and "Roll the Dice recommends this cash-secured put" — with its current value, where it is set, and **where it came from**.

Audited 2026-09-03 against the live database and `master`.

## How to read this

Provenance is the column that matters. Four kinds:

| tag | meaning |
|---|---|
| **validated** | backed by a study on this project's own data, recorded in `changelogs/` or `docs/formulas.md` |
| **convention** | borrowed from tastytrade / industry practice, never tested here |
| **invented** | chosen by reasoning at the time it was written, never tested |
| **structural** | forced by what the data can support — not really a choice |

An **invented** parameter is not automatically wrong. It means nothing would tell us if it were.

## The four layers

The dice gates are the last and thinnest layer. Most of what decides a pick happens upstream.

```
Layer 1  UNIVERSE & PIPELINE   which tickers exist, how many survive each stage
Layer 2  COMPOSITE SCORE       decides the RANKING
Layer 3  STRUCTURE             decides the ACTUAL TRADE — strike and expiry
Layer 4  GATES                 decides pass / fail
```

---

## Layer 1 — Universe and pipeline

`src/main/services/jobs/daily-intelligence-brief-job.ts`

| parameter | value | provenance | note |
|---|---|---|---|
| universe | S&P 500 + Russell 1000 + ETFs, from the constituents table | **structural** | A screener pre-filter was deliberately removed as "redundant and harmful" — it excluded overleveraged names that Bearish needs. |
| `MAX_PICK_PRICE` | **750** | **invented** | Excludes any stock over $750 from *all* brief picks. See finding **F1**. |
| `STAGE4_POOL_SIZE` | **15** per strategy | **validated (partly)** | Deepened from 10 in v0.32.70 so the liquidity gate still leaves 5 picks. Tuned to an output constraint, not to outcomes. |
| `STAGE_4_CAP` | `15 × STRATEGIES.length` = **90** | derived | The inline comment says "≤ 75" — stale, written when there were 5 strategies. See **F5**. |
| `PICKS_PER_STRATEGY` | **5** | **invented** | The final cap per strategy. This is the entire pool the dice ever sees. See **F2**. |
| earnings penalty | **−20** composite, earnings within **45 days** | **invented** | Both the size and the window. |
| penalised strategies | income, wheel, bearish | reasoned | The three carrying naked short legs through the hold. |
| `MIN_LIQUIDITY_SCORE` (brief gate) | **5** / 15 | **invented** | Reasoned from examples (OI=1 + wide spread ≈ 3; OI<100 + moderate ≈ 7). See **F3**. |
| liquidity gate on missing data | **passes** (`labResult === null → true`) | reasoned | "Can't gate what we didn't measure." Fails **open**. See **F4**. |
| `RETENTION_DAYS` | 90 | housekeeping | Not a trade parameter. |

---

## Layer 2 — The wheel composite

Live config is **`custom_v1_no_option_liquidity`**, saved **2026-08-07** — it differs from `BASELINE_WHEEL` in code.

| signal | weight | direction | scale | provenance |
|---|---|---|---|---|
| `ivRank` | **22** | higher better | normMax 100 | **convention** — tastytrade "IVR < 30 = don't sell" |
| `premiumYield` | **19** | higher better | normMax 60 | **invented** (the 60 cap especially) |
| `fundamentalScore` | **17** | higher better | normMax 100 | **invented** |
| `technicalNeutral` | **11** | target range | RSI **40–60** | **convention** |
| `recentVolatility` | **10** | lower better | normMax 60 | **invented** |
| `notDowntrend` | **8** | higher better | normMax 100 | reasoned |
| `optionLiquidity` | ~~9~~ | — | — | **validated** — DISABLED 2026-08-07, re-confirmed v1.1.170. See **F3** |
| `leverageQuality` | **4** | lower better | normMax 5 (ND/EBITDA) | **convention** |

Enabled weight sums to **91**. I verified this does *not* silently deflate scores: `totalWeight` accumulates only enabled signals, so the composite renormalises correctly.

**Two feature flags sit on this layer:**

| flag | state | provenance |
|---|---|---|
| `USE_ADX_IN_SCORING` | **false** | **validated** — full-year replay A/B showed enabling it is net negative across bullish/bearish/income. Correctly off. |
| `ETF_AWARE_WHEEL_SCORING` | **true** (v1.1.172) | **validated** — replay A/B, see **F6** / **T4**. `SCORING_ETF_AWARE_WHEEL=0` rolls it back. |

**Minimum composite gate:** `MIN_COMPOSITE_BY_STRATEGY` gates **bearish at 70** (validated on a full-year replay) and **nothing else**. Wheel is ungated — and v1.1.173 showed it should stay that way. See **F7** and **F8**.

---

## Layer 3 — Structure construction

`src/main/services/strategy-lab-service.ts`. **This layer decides the actual trade.** The composite only picks the ticker.

| parameter | value | provenance | note |
|---|---|---|---|
| `deltaTarget` (short put) | **0.30** | **validated** (v1.1.171) | One constant, every ticker, every IV regime. Tested on 16,902 settled CSPs + 937 matched-pair episodes — **passes where it stands**; nothing supports lowering it. See **T1**. |
| `selectExpiration` window | DTE **20–50**, target **30** | **convention** | |
| expiry fallback | nearest ≥ **14** DTE | **invented** | |
| strike fallback when no greeks | `otmFraction = 1 − delta × 1.5` | **invented** | A rough linearisation used when the chain has no deltas. |
| `MIN_TRADABLE_LIQUIDITY_SCORE` | **8** / 15 | **invented** | Different from Layer 1's bar of 5. See **F3**. |

Expiry selection has some evidence: a weekly→monthly A/B ran 2026-08-04 and **failed** FR-SEY-5. Delta was tested in v1.1.171 and **passes**. The remaining unvalidated items on this layer are the two fallbacks — the ≥14 DTE expiry fallback and the no-greeks strike linearisation — both of which fire only when the primary path cannot.

---

## Layer 4 — Gates (Roll the Dice)

`src/main/services/roll-the-dice.ts`. Since v1.1.168 these judge the **trade**, never the operator.

| gate | rule | provenance |
|---|---|---|
| critic verdict | must be `pass` | reasoned — rejects by far the most (172 of 248) |
| critic degraded | `degraded === true` rejected | reasoned — fail-closed, matches the v2 entry gate |
| CSP constructible | `short-naked-put` setup with a short put leg | structural |
| liquidity | ≥ **8** / 15 | **invented** |
| earnings | present, not stale, strictly after expiry | reasoned — fail-closed on unknown |
| net credit | > 0 | structural |
| `STALE_AFTER_DAYS` | 1 (warning, not a gate) | reasoned |
| `DEFAULT_MAX_CAPITAL` | $30,000 — **reporting split, not a gate** (v1.1.168) | operator's own figure |
| own-at-strike read | annotation only (v1.1.169) | **validated but thin** — 17.4pp separation on 12 episodes in one 4-week window |

---

## Findings

**F1 — `MAX_PICK_PRICE = 750` is a hidden capital ceiling.** At the typical 0.93 moneyness, a $750 stock strikes near $697 — about **$69,700** of committed capital. So there has always been a de facto capital ceiling upstream of the dice, roughly 2.3× the $30,000 line, and it is expressed in the wrong unit (share price, the same lossy proxy v1.1.164 removed from the dice for being lossy). It also fails **open** on a missing price (`price == null` passes the filter), so a ticker with no quote is never excluded by it.

**F2 — `PICKS_PER_STRATEGY = 5` is why over-budget days rarely have an alternative.** The dice never sees more than 5 wheel picks. This directly explains the v1.1.168 measurement that only **3 of 12** over-budget pick-days had a within-budget alternative — there simply weren't enough candidates. Raising this is the lever for that problem, not lowering any bar.

**F3 — Liquidity is deliberately a gate and not a ranking signal. CLOSED, and REPLICATED.** Graded at Layer 2 (**disabled**), gated at **5/15** at Layer 1, gated again at **8/15** at Layer 4. An 8/15 chain and a 15/15 chain rank identically, and that is the intended design, not an oversight.

*An earlier version of this document claimed the reason for the 2026-08-07 disable was unrecorded. That was wrong* — it is documented across v1.1.131/132/133/135, and **re-tested on 2.7× the sample in v1.1.170**: 18,219 settled CSPs over 31 dates, where the weight sweep is now **monotone** (13 → −0.47%, 9 → −0.27%, 6 → −0.20%, 3 → −0.08%, **0 → +0.54%** mean return on capital). Disabling is the best arm and every reduction improves it. The mechanism: liquidity is a **noisy proxy for IV rank** (top legacy quartile ivRank 63 vs 53 at the bottom), which the composite already weights at 30 — so extra weight dilutes the signals that actually carry the edge. Liquidity is an execution-cost property, not an outcome-prediction property. **No action.**

*Independently replicated in v1.1.176 on a different dataset and 3.5× the sample*: across 23,722 settled `analysis_snapshots` rows the liquid subset (≥5/10) underperforms the illiquid one on **all three** measures — mean −0.58% vs +0.73%, median +1.07% vs +1.53%, trimmed +0.31% vs +1.29%. Two independent datasets now agree.

**F4 — The two liquidity gates fail in opposite directions.** Layer 1 passes a pick whose lab result is missing ("can't gate what we didn't measure"); Layer 4 rejects one. Defensible individually, but a pick can clear the brief on absent data and then die at the dice — which reads as a dice rejection when it is really a data gap.

**F5 — `STAGE_4_CAP`'s comment is stale.** Says "≤ 75 unique tickers"; the arithmetic gives **90** now that there are 6 strategies. Cosmetic, but it is the number someone would reason from about E\*Trade call budget.

**F6 — ETFs ran ~23% light on the wheel composite. FIXED v1.1.172.** `fundamentalScore` (17) + `leverageQuality` (4) are structurally inapplicable to a fund wrapper, were always null, and so contributed 0 while still occupying **21 of 91** enabled weight — capping every ETF at 76.9% of an otherwise-identical stock. Measured: 56 of 60 curated ETFs have no `fundamentals_cache` row, while all 60 have `iv_history` and `historical_prices`. `ETF_AWARE_WHEEL_SCORING` now excludes both from numerator *and* denominator (×1.30 uplift, ETFs only). See **T4** for the A/B. Rollback: `SCORING_ETF_AWARE_WHEEL=0`.

**F7 — Wheel has no quality floor, and testing showed it must not get one. CLOSED v1.1.173.** Bearish earned its 70 gate from a full-year replay. Wheel was ungated by omission; it is now ungated on evidence. Every candidate threshold made the surviving book monotonically worse (at 70: kept return −3.89% vs +0.56% ungated) while emptying 14 of 35 brief dates. See **T2**.

**F8 — The wheel composite is ANTI-PREDICTIVE at the top. Finding stands; the MECHANISM was wrong.** Across 101 settled episodes, mean return on capital by composite band: 58–63 **+1.91%**, 63–68 +1.84%, 68–73 **−1.08%**, 73+ **−4.99%**, with assignment climbing 16.3% → 61.5%. Not outlier-driven — medians agree (≥68 **+0.27%**, <68 **+2.44%**). That much is measured and unchanged.

*The original explanation — that `ivRank` (22) + `premiumYield` (19), 41 of 91 weight, reward premium richness which is compensation for risk — was inference from weights and the worst tickers, and **v1.1.176 refuted it**.* Tested directly on 23,722 settled rows across the whole universe, ranking on premium richness **helps**: top annualized return beats no-selection by **+1.03 mean / +2.67 median**, and the *lowest*-annualized-return rule is the worst of every rule tried (−1.21 / −0.61). See **T5**.

**The suspicion moved to the other 50 of 91 weight**, and **T6 has now tested the 29 that can be**: `technicalNeutral` (11) is flat, `recentVolatility` (10) is weak and mildly inverted, and **`notDowntrend` (8) is anti-predictive** — its bullish band assigns 31.9% against the bearish band's 20.5% and returns −1.01% mean. Weighted together as the composite does, the three add +0.14 mean / −0.18 median over no selection at all; inverting them is the only rule that beats it on both. **That leaves `fundamentalScore` (17) + `leverageQuality` (4) as the only untested weight — and both draw on `fundamentals_cache`, which has no history and can never be replayed.** So F8's residual is now split between a measured small anti-predictive term and 21 points of permanently unverifiable weight. Still deliberately NOT acted on — n=13 per top band, one regime.

**F9 — "Is the strike a price I'd want to own?" is the strongest thing measured on this path — but the Validate view's ENTRY ZONE is not how to ask it. CLOSED 2026-09-04, see T8.** 4,917 settled liquidity-gated rows across 45 dates, collapsed to 1,585 episodes. Two measures separate outcomes, they are **complementary**, and both survive controlling for raw distance:

| split | eps | mean | median | assigned | SPY |
|---|---|---|---|---|---|
| universe (no selection) | 1585 | −0.29% | 1.13% | 25.3% | 1.5% |
| basis ≤ SMA200 / basis > SMA200 | 1099 / 671 | **+0.55% / −2.19%** | 1.28 / 0.69 | **17.0% / 42.1%** | 1.5 / 1.3 |
| strike below 20-bar swing low / not | 869 / 1111 | **+1.22% / −1.66%** | 1.38 / 0.91 | **13.2% / 35.7%** | 1.5 / 1.3 |

**The entry zone adds nothing.** Its split (858 episodes, +1.23%) is within noise of the swing-low split (869, +1.22%) because `entryZoneLow = min(swingLow, SMA50)` and the swing low is nearly always the min — it is the swing low renamed. The zone's own verdict state, *"IN ENTRY ZONE"*, is the mediocre middle: **+0.50%, 20.6% assigned**, between below (+1.23%) and above (−1.62%). Its bounds are the 20-bar low and SMA50, **both recency anchors**, so it re-anchors as price rises and can never say "too expensive" — the same construction that made the conviction band fire on 0 of 39 picks. Live example (2026-09-04, AMD): zone $440.50–$499.18 against an SMA200 of $340.97, reading "IN ENTRY ZONE" at 39% above the 200-day.

**Both survive the confound.** Below-swing strikes sit 2.6× further OTM (8.46% vs 3.28%), so the swing-low result looked like the distance effect renamed. Held inside ATR-cushion quartiles it persists in **all four**, largest where it matters most — in the thinnest-cushion quartile, below-swing returns **+1.48% at 19.5% assignment** against **−4.55% at 60.8%**. Own-at-strike survives the same treatment in all four bands. Crossed against each other (1b) neither collapses: best cell basis ≤ SMA200 **and** below swing = +1.26% / 11.3% assigned (699 eps); worst = −3.06% / 48.4% (562 eps).

**Own-at-strike is now replicated at ~100× its original sample.** v1.1.169 rested on 12 accept episodes in one ~4-week window, which is why it annotates rather than gates. Here it is the **best selection rule tested** — top 5/date by lowest basis-vs-SMA200: **+2.44% mean / +2.83% median / +2.97% trimmed / 11.6% assigned** against a −0.29% / 1.13% / 0.46% / 25.3% universe. Different base (whole scanned universe, not brief survivors), same direction, 1,770 episodes.

**Correction recorded:** the prediction going in was that ATR-normalised cushion would beat raw % OTM. **It does not, on returns** — widest raw-OTM quartile +1.10% / 1.92% median beats widest ATR quartile +0.49% / 0.99%, and as a top-5 selection rule ATR (−0.46% mean) is *worse than no selection*. ATR wins only on **assignment monotonicity** (51.7 → 17.4 → 16.8 → 11.3% across quartiles; raw % OTM is non-monotone at 50.3 → 14.6 → 15.8 → 18.9%). So ATR is the better risk gauge and raw distance captures more premium; neither dominates. Another mechanism read off a formula that the data declined to confirm.

**Harness check passed:** RSI(14) reproduces its published v1.1.178 null — 0.19% / −0.34% / −0.74% across oversold / target / extended bands, a 0.9-point spread against 4.3 points for the 2×2 above.

*Still one regime (45 dates, settled through 2026-09-04), and measured on the scanned universe rather than the brief's picks. Promoting either measure to a gate needs a brief-replay delta under FR-SEY-5. `scripts/fr-wheel-entry-quality-study.mjs`.*

---

## Test queue

All four are testable on the stored-brief replay under FR-SEY-5. Ordered by expected impact.

### ~~T1 — `deltaTarget = 0.30` on the short put~~ — CLOSED 2026-09-03, keep 0.30

Run and settled in **v1.1.171** (`scripts/fr-wheel-delta-study.mjs`).

**The method proposed above was impossible.** There are no stored chains — `options_cache` is a
live cache holding 0 rows. Synthesising alternative strikes through Black-Scholes would ignore the
volatility smile, understating OTM premium and biasing against the low-delta arm under test. What
exists instead is better: `options_premium_history` records one **real** CSP per ticker per day per
strategy with its real delta, premium and strike, settled against the real close at expiry — an
observational experiment over 0.20–0.35.

**16,902 settled wheel CSPs, 1,005 tickers, 31 dates.** Higher delta returns more, consistently:

| | low delta (0.23) | high delta (0.28) |
|---|---|---|
| premium / strike | 1.93% | 2.47% |
| assigned | 15.2% | 17.6% |
| **mean return on capital** | **+0.48%** | **+1.14%** |

That row is from **937 matched-pair episodes** — the same ticker, same day, same expiry, where
wheel and income happened to pick different strikes, so ticker, regime, IV and DTE are constant by
construction. Higher delta won **78.3%** of decided episodes, and the dose–response is monotone
(+0.22 → +0.41 → +2.26 pts as the delta gap widens). Income data extends it: monotone to **0.35**
(+1.48% return), with *lower* IV rank in the top bins, so the confound runs against the finding.

**The "risk to watch" was the wrong risk.** The comparison was already per dollar committed —
return on capital normalises by strike. The real risk was the opposite one: the extra premium
comfortably covers the extra assignment.

**Why not raise it, then?** Section D of the study prices the tension with the own-at-strike finding
(v1.1.169). Delta moves premium return and cost-basis quality in opposite directions: moving ~0.21 →
~0.29 buys ~0.17pp of return on collateral and costs ~7pp of picks landing at or below the 200-day
average (70.0% → 62.9%). Those are different quantities over different windows and are **not
nettable**. With section C's top bin at 542 rows from one regime, and own-at-strike itself resting
on 12 episodes, FR-SEY-5 does not justify moving a live parameter. **0.30 sits where the premium
evidence is strongest and the cost-basis cost has not yet compounded.**

### ~~T2 — A minimum composite gate for wheel~~ — CLOSED 2026-09-03, REJECTED

Run and settled in **v1.1.173** (`scripts/fr-wheel-composite-floor-study.mjs`).

**Replay could not be used.** It is blind to `premiumYield` (19 of wheel's 91), which shifts the
composite scale — the service says never to carry an absolute wheel threshold between replay and
live, and a gate is exactly that. So this ran on **live brief picks** with real settled CSP
outcomes: 180 picks → **101 independent episodes**, scale guard excluding 0 rows.

**Every threshold made the book worse, monotonically:**

| gate | kept | kept return | Δ vs ungated | days emptied |
|---|---|---|---|---|
| none | 101 | **+0.56%** | — | 0/35 |
| 62 | 57 | −0.35% | −0.91 | 7/35 |
| 65 | 38 | −1.13% | −1.69 | 8/35 |
| 68 | 26 | −3.03% | −3.59 | 13/35 |
| 70 | 19 | −3.89% | −4.45 | 14/35 |

**The "risk to watch" was right about the cost and wrong about the direction.** A gate does cut
most days — 14 of 35 emptied at 70 — but the deeper problem is that it keeps the *wrong* picks.
See **F8**: the composite is anti-predictive at the top, so a floor systematically retains the
high-IV names that blow up short puts.

**Follow-up — RESOLVED v1.1.174: the tiebreak is nearly vacuous.** It fires on **7 of 62** brief
days, and on **27 of 34 pick-days (79%) there is exactly one eligible candidate** — nothing to
choose between. The gates ahead of the sort do essentially all the work. So F8's implication does
not land at the dice's selection step. `scripts/fr-dice-tiebreak-study.mjs`.

**Where it does land: the brief's top-5 cut.** `PICKS_PER_STRATEGY = 5` of a `STAGE4_POOL_SIZE = 15`
pool, ranked by composite — and the dice only ever sees those 5. That is not testable from
`daily_briefs`, which stores only survivors. `analysis_snapshots` holds the full universe (65
dates, ~1,223 rows each) with real strikes and premiums, but no `compositeScore`, and 21 of the
composite's 91 weight comes from `fundamentals_cache` which has no history — so a selection study
on reconstructable signals is possible, a faithful composite replay is not. **The cheap fix:
persist composite + outcome for all 15 Stage-4 candidates, not just the 5 that survive.**

### ~~T3 — `optionLiquidity` back on in scoring~~ — CLOSED 2026-09-03, keep it off

Run and settled in **v1.1.170**. The replay harness cannot test this signal at all (no historical
option chains, so `optionLiquidityScore` is null for every ticker on every replay date — see
`REPLAY_BLIND_SIGNAL_KEYS`); the real harness is
`scripts/fr-income-liquidity-realized-ab.mjs`, which settles CSPs at intrinsic against
`options_premium_history`.

On **18,219 settled CSPs over 31 dates** — 2.7× the sample that produced the original judgement —
the weight sweep is **monotone**, which is the exact test v1.1.135 named for distinguishing signal
from noise:

| weight | 13 | 9 | 6 | 3 | **0** |
|---|---|---|---|---|---|
| mean return on capital | −0.47% | −0.27% | −0.20% | −0.08% | **+0.54%** |

Disabling flips the arm from losing to profitable. **The "risk to watch" was the right call**:
liquidity is a floor, not a gradient.

**Still open on wheel specifically.** v1.1.132 began persisting wheel's liquidity inputs on
2026-08-06; 10,792 wheel rows now carry them but **0 have settled**. Re-run around **2026-10-01**
to test wheel on its own population instead of income as a proxy.

### ~~T4 — ETF composite deflation~~ — CLOSED 2026-09-03, fix SHIPPED

Run and settled in **v1.1.172**.

**The validation gate was unsatisfiable, and that was the finding.** The code required "a Brief
Replay improvement (or at least neutrality) on ETF wheel outcomes" before enabling — but **0** ETF
picks existed across 62 briefs, **0** appearances across 88 wheel analysis snapshots covering 1,077
tickers, and **0** rows in `options_premium_history`. None could ever be generated while the flag
was off, because the deflation is what kept ETFs out of the Stage-4 pool where options data is
fetched. *The distortion suppressed the evidence needed to remove it.*

Resolved inside Brief Replay, where the ON arm **can** produce ETF picks
(`scripts/replay-arm.mjs`; 45 dates, 2026-06-02 → 2026-08-05, 225 wheel picks per arm, outcomes
100% matured):

| | OFF | ON |
|---|---|---|
| ETF picks | **0** | **6 (2.7%)** — QQQ ×2, IYR ×2, XRT, KBE |
| stayed above strike | 77.8% | 77.8% |

Six swaps, each an ETF displacing one stock **on a higher composite every time**. The swapped
picks tied exactly on the CSP-relevant metric — **6/6 stayed above strike on both sides**. The
added ETFs returned less on the 21-day underlying (+0.22% vs +3.49%), but a short put is capped at
the premium and never earns a runaway stock's upside, so that column is not the P&L.

**What it does not establish:** all 12 swapped picks stayed above their strike, so the metric never
discriminated — a tie because nothing failed, not because ETFs were shown to handle stress. Six
swaps, one regime. Replay also still under-ranks ETFs (blind to `premiumYield`, leaving them
51/70 populated vs stocks' 72/91), so **2.7% is a floor on the live effect, not a ceiling**.

**Note that proved right:** this was a correctness question as much as a performance one. The
neutral result is what let a category error be fixed rather than left in place forever.

---

### T5 — does premium-richness selection hurt? — CLOSED 2026-09-03, NO

Added after T2 raised F8. `scripts/fr-wheel-selection-study.mjs` applies selection rules to the
**whole wheel universe** from `analysis_snapshots` (23,722 settled rows, 40 dates) and compares
each against no selection at all — the test F8's mechanism claim needed and never had.

| rule | Δ mean | Δ median |
|---|---|---|
| **top annualized return** | **+1.03** | **+2.67** |
| top ivRank + annRet | +0.25 | +1.60 |
| top ivRank | +0.16 | +0.91 |
| **lowest annualized return** | **−1.21** | **−0.61** |

Premium richness **helps**. F8's finding survives; its explanation does not. Judged on medians as
well as means because the worst single outcome in the sample is −87.5%.

**Also corrected here:** an earlier draft claimed this study could apply the earnings gate, since
`analysis_snapshots` carries a `daysToEarnings` field. It is **null on 100% of rows** — the column
exists and is never populated. A fourth place where the earnings gate cannot be evaluated.

### T6 — the composite's price-derived signals — CLOSED 2026-09-03, they add nothing

`scripts/fr-wheel-price-signals-study.mjs`. After T5 cleared premium richness, the remaining
suspicion fell on the other 50 of 91 weight — of which 29 are testable (`technicalNeutral` 11,
`recentVolatility` 10, `notDowntrend` 8; the other 21 draw on `fundamentals_cache` and never can
be). Each replicated exactly from `scoring-service.ts`, computed point-in-time, applied as a
selection rule to the whole universe. **4,816 settled rows, 40 dates.**

| rule | Δ mean | Δ median |
|---|---|---|
| top technicalNeutral | +0.12 | +1.50 |
| top recentVolatility | +0.15 | −0.09 |
| **top notDowntrend** | **−1.31** | +0.81 |
| all three weighted as the composite does | +0.14 | −0.18 |
| **INVERTED — worst of all three** | **+0.43** | **+0.95** |

**`notDowntrend` is anti-predictive**, and the banded view shows it cleanly — bearish band 20.5%
assigned, sideways 24.6%, **bullish 31.9%**, with the top band returning −1.01% mean. That
assignment gradient is monotone and is the robust part, assignment being immune to the return
tails. `technicalNeutral` is flat at every level (no signal either way); `recentVolatility` is
weak and mildly inverted — its high-vol end returned a better median (+1.92%) than its low-vol end
(+0.72%), the opposite of what a `lower_better` weight assumes.

**This is the ADX finding again.** `USE_ADX_IN_SCORING` was set false in v1.1.33 on a full-year
replay because *strong-trend names mean-revert over ~21 days*. `notDowntrend` measures nearly the
same thing via the SMA stack and reproduces it on different data — a trend-following term inside a
short-premium composite, found anti-predictive twice, independently.

**Not acted on**: 8 of 91 weight, small effect, one regime, observational rather than an A/B — and
a faithful weight sweep is impossible today (the wheel composite needs `fundamentals_cache`, and
income carries no `notDowntrend` term). **What changes that is the v1.1.175/177 capture**:
`brief_candidates.signals_json` stores per-signal `{raw, normalized, weight, missing}` for every
candidate, so after a quarter the composite can be recomputed with one term removed and compared
on real outcomes. First concrete payoff of that instrumentation.

### T7 — does the critic's treatment of TREND survive contact with the data? — OPEN

Raised 2026-09-03 by a live pick. The Roll the Dice panel showed both readings of the same fact
side by side, disagreeing:

> **Critic:** "IV rank at 82 with a **confirmed uptrend** and strong fundamentals **supports** the
> short put thesis"
> **Own-at-strike:** "46.6% **ABOVE** its 200-day average… an **extended price, not a discount**"

Both describe DINO having run +132% off its 52-week low. Only one of them is supported here.

**Where the assumption lives — two places, and they are different problems.**

1. `critic-service.ts` `checkTrendAlignment` (~line 404) fires only on a *confirmed downtrend*
   (`notDowntrend.normalized < 35`) and states the rationale in code: *"wheel works best on stocks
   trending sideways to up."* That is an assertion, and **T6 measured the opposite ordering** —
   bearish band **20.5%** assigned, sideways 24.6%, bullish **31.9%**, with the bullish band also
   worst on mean return (−1.01%).
2. The LLM **system prompt says nothing about trend for wheel at all**. So "confirmed uptrend
   supports the short put thesis" is the model's own inference, neither requested nor corrected —
   an intuition imported from directional strategies, where it is right, into short premium, where
   the evidence disputes it.

**Corroboration:** `USE_ADX_IN_SCORING` was set false in v1.1.33 on a full-year Brief Replay A/B,
recorded reason *strong-trend names mean-revert over the next ~21 days*. Two independent findings
now point the same way.

**What is NOT established, and why this is logged rather than fixed:**

- **Assignment rate is not tail severity.** T6 measured how often each band assigned and its mean
  return. A confirmed downtrend assigning *less often* does not mean a falling knife is safer when
  it does assign — the warning may be defensible even if its stated reason is wrong.
- T6 tested trend **as a selection signal**, not as a warning. Different question.
- One regime, and `notDowntrend` is 8 of 91 weight.

**How it becomes answerable:** `brief_candidates.signals_json` (v1.1.175) now stores
`notDowntrend` raw/normalized per candidate, and `daily_briefs.picks` stores the critic verdict.
After a quarter, verdict × trend band × settled outcome is a direct three-way test — including
whether `pass` on a bullish name underperforms `pass` on a sideways one.

**Do not tweak the prompt on the current evidence.** Same discipline that stopped `notDowntrend`
being acted on at 8 of 91 weight.

### ~~T8 — can the Validate view's entry machinery judge a CSP strike?~~ — CLOSED 2026-09-04

Asked by the operator: *"I can't wheel something I'm not comfortable owning, and to own it the
strike needs to be a reasonable price."* The Validate view already computes an entry zone, a swing
low, an ATR stop and an RSI read, and the wheel path consults none of them.

**Answer: the principle is right and now quantified; the entry zone is the wrong instrument.**
Full result in **F9**. Three of the panel's four technical ingredients were already settled before
this ran — RSI *is* `technicalNeutral` (flat, T6), the SMA50/200 stack *is* `notDowntrend`
(anti-predictive, T6), and distance-to-SMA200 *is* own-at-strike — so only the swing low, the ATR
cushion and the zone itself were open. Of those, the swing low is real and additive, the ATR
cushion is a risk gauge rather than a return signal, and the zone is the swing low renamed.

**Follow-up worth running, not yet run:** the swing low and own-at-strike as a 2×2 *annotation* on
the dice (not a gate), replayed against stored briefs for an FR-SEY-5 delta. The worst cell —
basis above SMA200 **and** strike above the swing low — is 562 of 1,585 episodes at −3.06% mean
and 48.4% assignment, which is a large enough share to matter and a specific enough condition to
state in one sentence to the operator.

**Also unresolved and deliberately out of scope here:** the Validate view's *fundamental* half
(P/E, ROE, D/E, the AVOID verdict, analyst rating) disagrees with the wheel critic on live picks —
AMD read AVOID / analysts SELL on 2026-06-12 and 06-18 while being a critic-**passed** wheel pick
at +76.5% and +79.2% cost basis vs its own SMA200. That half **cannot be tested**:
`fundamentals_cache` holds one row per ticker with no history. See "Not testable, and why".

## Not testable, and why

Recording these so they are not re-litigated:

- **The earnings gate.** `earnings_calendar` keeps one row per ticker with no history, so a replay sees today's next-report date. Correct on live data, invisible to any backtest.
- **Anything from `fundamentals_cache`.** Same shape — one row per ticker, no history. `fundamentalScore` (weight 17) and `leverageQuality` (weight 4) therefore cannot be honestly A/B'd on the replay at all. **21 of 91 enabled weight is permanently unvalidatable.**
- **The critic verdict.** An LLM judgement, not a threshold. Its *effect* is measurable (it rejects the most by far) but it cannot be swept like a number.
- **`MAX_PICK_PRICE` and `PICKS_PER_STRATEGY`.** Testable in principle, but they change the candidate set rather than the ranking, so a replay can only show what *would* have been added — not how it would have performed without re-running the whole pipeline.

## Standing caution

Every study here draws on **62 stored wheel briefs from 2026-06-06 onward**, and outcome measurement truncates to picks whose expiry has matured. That is one regime. This project has rejected the SPY-regime gate, the overbought guard, ADX, and the expiry-selection lever after each looked convincing on a similar sample. Two de-biasing steps are mandatory in any study on this data (`scripts/own-at-strike-study.mjs` implements both): measure **excess of a benchmark over the identical window**, and **collapse repeated picks of the same position into one episode**.

see `docs/formulas.md#roll-the-dice`, `docs/formulas.md#own-at-strike`, `Requirements/spec/14-daily-brief-and-critic.md`
