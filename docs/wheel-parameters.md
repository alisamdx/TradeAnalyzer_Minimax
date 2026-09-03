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
| `optionLiquidity` | ~~9~~ | — | — | **DISABLED 2026-08-07** — see **F3** |
| `leverageQuality` | **4** | lower better | normMax 5 (ND/EBITDA) | **convention** |

Enabled weight sums to **91**. I verified this does *not* silently deflate scores: `totalWeight` accumulates only enabled signals, so the composite renormalises correctly.

**Two feature flags sit on this layer:**

| flag | state | provenance |
|---|---|---|
| `USE_ADX_IN_SCORING` | **false** | **validated** — full-year replay A/B showed enabling it is net negative across bullish/bearish/income. Correctly off. |
| `ETF_AWARE_WHEEL_SCORING` | **false** | **unvalidated** — and being off causes a live distortion. See **F6**. |

**Minimum composite gate:** `MIN_COMPOSITE_BY_STRATEGY` gates **bearish at 70** (validated on a full-year replay) and **nothing else**. Wheel is ungated. See **F7**.

---

## Layer 3 — Structure construction

`src/main/services/strategy-lab-service.ts`. **This layer decides the actual trade.** The composite only picks the ticker.

| parameter | value | provenance | note |
|---|---|---|---|
| `deltaTarget` (short put) | **0.30** | **convention** | One constant, every ticker, every IV regime. Sets assignment probability, premium, and therefore cost basis. **The least-audited number in the entire path.** |
| `selectExpiration` window | DTE **20–50**, target **30** | **convention** | |
| expiry fallback | nearest ≥ **14** DTE | **invented** | |
| strike fallback when no greeks | `otmFraction = 1 − delta × 1.5` | **invented** | A rough linearisation used when the chain has no deltas. |
| `MIN_TRADABLE_LIQUIDITY_SCORE` | **8** / 15 | **invented** | Different from Layer 1's bar of 5. See **F3**. |

Partly tested: a weekly→monthly expiry A/B ran 2026-08-04 and **failed** FR-SEY-5, so expiry selection has *some* evidence behind it. Delta has none.

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

**F3 — Liquidity is applied three different ways, at two different bars.** Graded at Layer 2 (**now disabled**), gated at **5/15** at Layer 1, gated again at **8/15** at Layer 4. Since the signal was switched off on 2026-08-07, liquidity is purely pass/fail — an 8/15 chain and a 15/15 chain rank identically. *The reason for that change is not recorded anywhere and needs the operator's memory.*

**F4 — The two liquidity gates fail in opposite directions.** Layer 1 passes a pick whose lab result is missing ("can't gate what we didn't measure"); Layer 4 rejects one. Defensible individually, but a pick can clear the brief on absent data and then die at the dice — which reads as a dice rejection when it is really a data gap.

**F5 — `STAGE_4_CAP`'s comment is stale.** Says "≤ 75 unique tickers"; the arithmetic gives **90** now that there are 6 strategies. Cosmetic, but it is the number someone would reason from about E\*Trade call budget.

**F6 — ETFs run ~23% light on the wheel composite, live.** With `ETF_AWARE_WHEEL_SCORING` off, `fundamentalScore` (17) + `leverageQuality` (4) are structurally inapplicable to a fund wrapper, always null, and therefore contribute 0 while still occupying **21 of 91** enabled weight. SPY and VOO are on the conviction list, so this is not hypothetical. The fix exists in code and is disabled pending validation.

**F7 — Wheel has no quality floor.** Bearish earned a 70 gate from a full-year replay. Wheel is ungated, so on a weak day the dice pick can be a low composite that simply happened to be least-bad. Nothing has ever tested whether that is harmful.

---

## Test queue

All four are testable on the stored-brief replay under FR-SEY-5. Ordered by expected impact.

### T1 — `deltaTarget = 0.30` on the short put

*The highest-value test here.* Delta sets assignment probability, premium, and cost basis simultaneously — and the cost basis is exactly what `own-at-strike-study.mjs` already knows how to score.

- **Method**: re-derive the CSP at 0.20 / 0.25 / 0.30 / 0.35 from the stored chains, then compare outcomes from the resulting cost basis, excess of SPY, collapsed to independent episodes.
- **Passes if**: an alternative delta is at worst neutral on both return-from-basis *and* assignment frequency.
- **Risk to watch**: lower delta means less premium for the same capital; the comparison must be per dollar committed, not per contract.

### T2 — A minimum composite gate for wheel

- **Method**: exactly how bearish's 70 was derived — bucket wheel picks by composite, measure forward outcomes per bucket, look for a threshold below which edge disappears.
- **Passes if**: a clean threshold exists with enough picks above it to keep the hit rate usable.
- **Risk to watch**: wheel composites cluster tightly (58.9–76.0, median 65.9), so a gate could cut most days for little gain.

### T3 — `optionLiquidity` back on in scoring

- **Blocked on one question**: why was it disabled on 2026-08-07? If that was a deliberate finding, this test is already answered.
- **Method**: A/B the composite with the signal on vs off, measuring outcomes among picks that *already* clear the hard gate — the question is whether grading adds anything beyond pass/fail.
- **Risk to watch**: liquidity may be a floor rather than a gradient, in which case a hard gate is the correct design and re-enabling adds noise.

### T4 — ETF composite deflation

- **Method**: flip `ETF_AWARE_WHEEL_SCORING` on in a replay and measure how ETF picks re-rank and how those picks then perform.
- **Passes if**: ETFs rise in rank *and* their outcomes justify the rise.
- **Note**: this one is a **correctness** question as much as a performance one — the current behaviour penalises a ticker for a reason unrelated to trade quality. It may deserve fixing even if performance is flat.

---

## Not testable, and why

Recording these so they are not re-litigated:

- **The earnings gate.** `earnings_calendar` keeps one row per ticker with no history, so a replay sees today's next-report date. Correct on live data, invisible to any backtest.
- **Anything from `fundamentals_cache`.** Same shape — one row per ticker, no history. `fundamentalScore` (weight 17) and `leverageQuality` (weight 4) therefore cannot be honestly A/B'd on the replay at all. **21 of 91 enabled weight is permanently unvalidatable.**
- **The critic verdict.** An LLM judgement, not a threshold. Its *effect* is measurable (it rejects the most by far) but it cannot be swept like a number.
- **`MAX_PICK_PRICE` and `PICKS_PER_STRATEGY`.** Testable in principle, but they change the candidate set rather than the ranking, so a replay can only show what *would* have been added — not how it would have performed without re-running the whole pipeline.

## Standing caution

Every study here draws on **62 stored wheel briefs from 2026-06-06 onward**, and outcome measurement truncates to picks whose expiry has matured. That is one regime. This project has rejected the SPY-regime gate, the overbought guard, ADX, and the expiry-selection lever after each looked convincing on a similar sample. Two de-biasing steps are mandatory in any study on this data (`scripts/own-at-strike-study.mjs` implements both): measure **excess of a benchmark over the identical window**, and **collapse repeated picks of the same position into one episode**.

see `docs/formulas.md#roll-the-dice`, `docs/formulas.md#own-at-strike`, `Requirements/spec/14-daily-brief-and-critic.md`
