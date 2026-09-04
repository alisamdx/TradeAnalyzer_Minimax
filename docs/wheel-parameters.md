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
| `ETF_AWARE_WHEEL_SCORING` | **false** | **unvalidated** — and being off causes a live distortion. See **F6**. |

**Minimum composite gate:** `MIN_COMPOSITE_BY_STRATEGY` gates **bearish at 70** (validated on a full-year replay) and **nothing else**. Wheel is ungated. See **F7**.

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

**F3 — Liquidity is deliberately a gate and not a ranking signal. CLOSED.** Graded at Layer 2 (**disabled**), gated at **5/15** at Layer 1, gated again at **8/15** at Layer 4. An 8/15 chain and a 15/15 chain rank identically, and that is the intended design, not an oversight.

*An earlier version of this document claimed the reason for the 2026-08-07 disable was unrecorded. That was wrong* — it is documented across v1.1.131/132/133/135, and **re-tested on 2.7× the sample in v1.1.170**: 18,219 settled CSPs over 31 dates, where the weight sweep is now **monotone** (13 → −0.47%, 9 → −0.27%, 6 → −0.20%, 3 → −0.08%, **0 → +0.54%** mean return on capital). Disabling is the best arm and every reduction improves it. The mechanism: liquidity is a **noisy proxy for IV rank** (top legacy quartile ivRank 63 vs 53 at the bottom), which the composite already weights at 30 — so extra weight dilutes the signals that actually carry the edge. Liquidity is an execution-cost property, not an outcome-prediction property. **No action.**

**F4 — The two liquidity gates fail in opposite directions.** Layer 1 passes a pick whose lab result is missing ("can't gate what we didn't measure"); Layer 4 rejects one. Defensible individually, but a pick can clear the brief on absent data and then die at the dice — which reads as a dice rejection when it is really a data gap.

**F5 — `STAGE_4_CAP`'s comment is stale.** Says "≤ 75 unique tickers"; the arithmetic gives **90** now that there are 6 strategies. Cosmetic, but it is the number someone would reason from about E\*Trade call budget.

**F6 — ETFs run ~23% light on the wheel composite, live.** With `ETF_AWARE_WHEEL_SCORING` off, `fundamentalScore` (17) + `leverageQuality` (4) are structurally inapplicable to a fund wrapper, always null, and therefore contribute 0 while still occupying **21 of 91** enabled weight. SPY and VOO are on the conviction list, so this is not hypothetical. The fix exists in code and is disabled pending validation.

**F7 — Wheel has no quality floor.** Bearish earned a 70 gate from a full-year replay. Wheel is ungated, so on a weak day the dice pick can be a low composite that simply happened to be least-bad. Nothing has ever tested whether that is harmful.

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

### T2 — A minimum composite gate for wheel

- **Method**: exactly how bearish's 70 was derived — bucket wheel picks by composite, measure forward outcomes per bucket, look for a threshold below which edge disappears.
- **Passes if**: a clean threshold exists with enough picks above it to keep the hit rate usable.
- **Risk to watch**: wheel composites cluster tightly (58.9–76.0, median 65.9), so a gate could cut most days for little gain.

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
