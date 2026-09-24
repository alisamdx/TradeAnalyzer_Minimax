# v2 Execution — Seykota-inspired risk & discipline extensions

> A small, deliberately-scoped set of requirements distilled from Ed Seykota's trading
> principles, translated to fit **this app** (defined-risk options income + inflection
> credit spreads, single $10k segregated account, semi-auto). The guiding judgement: keep
> the *principles* (risk control, discipline, validation), drop the *1970s parameters*, and
> **do not** re-introduce ideas already disproven on our own data.
>
> Status legend: ✅ shipped · 🚧 in progress · 📋 planned · ❌ rejected/declined.

---

## Scope & non-goals

These extend the risk governor (`02-risk-governor`) and entry lifecycle (`03-lifecycle`).
They are **configurable and default to OFF/disabled**, so they are inert until the operator
enables them in Execution Settings after reading this doc. None of them change the locked
limits ($10k / 5% per-trade / 5 concurrent / 10% daily-loss trip / 1 per ticker).

**Explicitly NOT doing (and why):**

- **"Let winners run" / pyramiding.** Our launch structures (inflection credit spreads, CSP/CC
  income) have **capped upside** — max profit is the credit. There is nothing to let run, and
  the 50%-of-credit profit target is *correct* for short-premium. This principle only becomes
  available with a directional long/debit sleeve (open-ended profit) — a future *product*
  decision, not a parameter, tracked separately.
- **Market-regime trend gate.** Already built and **reverted** (the SPY-vs-50-day gate,
  v0.32.90) — it inverted on full-year replay. FR-SEY-3 is deliberately *per-name*, not
  market-wide, to avoid repeating this.
- **Full autonomous entry.** Out of scope by the v2.0 semi-auto (approve-each) design.
- **"Bearish credit" strategy (sell bear call spreads on bearish picks).** Proposed 2026-06-25
  after a discretionary MSFT scan looked clean (bearish + IV rank 84 + liquid + no earnings).
  Validated first (`scripts/fr-bearish-credit-study.mjs`) and **rejected** — bear call spreads on
  the bearish replay picks win 80.5% / 2.8% return-on-capital vs an **84.1% / 4.6% random-day
  baseline** (worse on every metric). High IV rank is mildly predictive (≥70 → 82.3%/3.5%) but
  still sub-baseline. Same anti-predictiveness as the rejected debit verticals: the bearish
  scorer flags already-fallen names, and selling calls into them invites the bounce. No edge to
  bake into the brief; a discretionary one-off is fine but it's not a systematic strategy.

---

## FR-SEY-5 — Validate-before-ship (process rule) — ✅

**Principle:** Seykota tested systems rigorously before trusting them; we already live this
(the SPY-regime gate and overbought guard were both tested and *rejected* on full-year
Brief Replay).

**Requirement:** No change to a scoring weight/signal, an entry/exit policy parameter, or a
risk-gate rule that affects *which trades the engine takes or how it sizes/exits them* ships
to the live path without a **Brief Replay and/or Backtest delta** demonstrating it is at
worst neutral on the historical sample. A rule that cannot be shown to help on the data is
not shipped (it may ship **disabled**, as a configurable option, with the finding recorded).

**Acceptance:**
- The rule is recorded in `CLAUDE.md` (operating manual) under standing instructions.
- Each of FR-SEY-1/2/3 below carries its validation evidence (or ships disabled with the
  null/negative result noted) before its `active`-by-default flip.

**Operator-approved exceptions register** (shipped enabled without a replay delta, by explicit decision):
- **v1.1.255 — `STALE_GREEK_GUARD` (existing app).** Withholds an E*Trade chain's Greeks when its
  deltas imply a spot > 1 % from both the chain price and the put-call-parity price, so no strike is
  chosen by them. Not replayable: stored candidates keep the stale delta but not the chain. Approved
  on the evidence of `scripts/pick-greek-audit.mjs` (2026-01-01..09-16): 33 of 322 invertible picks
  more than 1 % off, 7 rows by ≥ 2.8 % (OLLI 9/16 wheel put implied 76.09 on 73.23; ORCL 9/10 wheel and
  income puts; AVAV 9/9 income put — each nearer the money than its delta said). It changes a data
  input, not a scoring weight or policy, and adds no selection rule of its own. `STALE_GREEK_GUARD=0`
  restores the old behaviour for a comparison run.

**Shipped-disabled, pending validation:**
- **v1.1.319 — `STALE_GREEK_MODEL_DELTA` (existing app), OFF.** On a chain `STALE_GREEK_GUARD` flags,
  give delta our Black-Scholes value at the chain's own price (E*Trade IV) instead of null, so the wheel
  picks a correctly targeted put rather than skipping the ticker and Strategy Lab selects by delta rather
  than its moneyness heuristic. `scripts/wheel-delta-selection-study.mjs` (TradeAnalyzer 2 raw chains,
  2026-09-14..23): ~200 of 228 flagged ticker-days regain a wheel pick, ~25 a day; E*Trade IV agrees with
  a mid-solved IV on 93 % of chosen contracts. Not enabled because it ADDS candidates on tickers whose
  feed is currently unreliable, and none can be scored before expiry (earliest 2026-10-16). Decide on
  realized outcomes of the flagged-ticker picks it would have made, against the picks actually taken.

**Rejected-on-data register** (changes that looked compelling and did *not* ship):
SPY-regime gate · overbought guard · ADX in scoring · FR-SEY-3 per-name trend filter ·
bear-call inflection recalibration · Step-3 debit-spread directional path · gap-risk entry
filter · **graded option-liquidity scoring for composite ranking** (2026-08-07, `scripts/fr-income-liquidity-realized-ab.mjs` — better-calibrated liquidity scoring made realized income-CSP outcomes WORSE, Δ −1.88 pts/trade; liquidity has no predictive relation to outcome at all (|ρ| ≤ 0.03) and tracks realized vol, so it belongs as a gate not a ranking signal) · **monthly expiry preference in `selectExpiration`** (2026-08-04,
`scripts/fr-expiry-realized-ab.mjs` — see `Requirements/NEW_FRONTIER.md §12`: the confirmed
weekly-vs-monthly liquidity gap does not convert into realized edge, because the
`liquidityScore ≥ 8` entry gate already screens the thin weeklies out and a monthly moved off
~30 DTE is thinner than the weekly it replaces).

---

## FR-SEY-2 — Drawdown-scaled risk (equity-curve money management) — ✅ (v1.1.14, default OFF)

**Principle:** Reduce exposure during drawdowns; the equity curve is itself a signal. Today
the only step between "normal" and "halt" is the binary 10% daily kill switch — nothing
graduated.

**Requirement:** Track a **closed-equity high-water mark** (`equity = capitalCeiling + Σ
realized P&L of closed positions`; HWM ratchets up only). When the drawdown from the HWM
reaches `drawdownThrottlePct`, multiply the effective per-trade risk by
`drawdownThrottleFactor` (e.g. 0.5 = half size) until the curve recovers above the
threshold. Disabled when `drawdownThrottlePct = 0`.

**Design:**
- New `exec_config` columns: `drawdown_throttle_pct` (default `0` = off),
  `drawdown_throttle_factor` (default `0.5`).
- New `exec_risk_state` column: `equity_high_water` (seeded to `capital_ceiling`).
- Pure helper `drawdownThrottleFactor(drawdownPct, config)` in `risk-gate.ts`; the governor
  applies the factor to `perTradeRiskDollar` (sizing) and passes `effectiveMaxRiskPct`
  into `GateContext` so the `per_trade_risk` check matches the throttled budget.
- Closed-equity (not mark-to-market) avoids unrealized-swing thrash.

**Acceptance:**
- Drawdown ≥ threshold → `sizeEntry` returns proportionally fewer contracts; gate's
  `per_trade_risk` limit is the throttled value.
- New HWM after a winning close → drawdown resets to 0, full size restored.
- `drawdownThrottlePct = 0` → identical behaviour to today (regression-safe).
- Unit tests in `tests/risk-gate.test.ts` + `tests/risk-governor.test.ts`.

---

## FR-SEY-1 — Correlation / sector concentration cap — ✅ (v1.1.15, default OFF)

**Principle:** Diversify across *uncorrelated* bets. Five semiconductor spreads is one bet,
not five — the count caps (5 concurrent, 1/ticker) don't see that.

**Requirement:** Cap the number of concurrent open positions sharing a correlation bucket.
v1 bucket = **GICS-ish sector** (already in `fundamentals_cache`; lowercase SIC description).
Disabled when `maxPositionsPerSector` is null.

**Design:**
- New `exec_config` column: `max_positions_per_sector` (default `NULL` = off).
- Governor resolves the candidate's sector and each open position's sector from
  `fundamentals_cache`; passes them on `GateCandidate.sector` / `GateContext.openPositions[].sector`.
- New pure gate check `per_sector` in `evaluateGate` (skipped when the cap is null).
- Beta-bucket / true-correlation grouping is a documented **future** refinement.

**Acceptance:**
- With the cap set to N, an (N+1)th candidate in the same sector is rejected with
  `per_sector`; a candidate in a different sector passes.
- Null cap → no `per_sector` constraint (regression-safe).
- Unit tests in `tests/risk-gate.test.ts`.

---

## FR-SEY-3 — Per-name trend-alignment filter for inflection — ❌ NOT SHIPPED (validated, rejected)

**Principle:** Trade in the direction of the established trend — at the *name* level, not the
market level (the market-level version is rejected; see non-goals).

**Validation study (2026-06-14, Brief Replay, 1,300 inflection picks; `scripts/fr-sey-3-*`):**

1. **Naive price-vs-SMA filter (the originally-specified rule) is redundant.** Every pick
   already "agrees" (0 filtered) — a breakout *by definition* puts price on the trend-agreeing
   side of its own short SMA. Zero signal added.
2. **50/200 SMA regime stack helps only the up side.** Bull-put (up-breakout) picks with
   50>200 lift stock-HR 58.4%→63.8% (dir-adj 21d return 4.8%→7.6%), dropping ~40% of picks.
   Bear-call (down-breakout) picks are unaffected by regime.
3. **The down side isn't actually weak — that was a stock-HR artifact.** On the proper
   credit-spread metric (OTM-expiry within a ±7.5% short-strike buffer), bear calls win
   **68.3%** (±10% → 74.5%) vs bull puts 77.1%. Profitable, not broken — do **not** drop it.
4. **Gating the down side is neutral-to-harmful.** Composite score is *monotonically
   anti-predictive* for bear-call inflection (OTM-win: all 68.3%, ≥70 66.5%, ≥80 62.1%,
   ≥85 58.6%; top score quintile 60.8% vs bottom 71.7%). A min-composite gate would *reduce*
   win rate. The 50/200 regime filter doesn't help the down side either.

**Resolution:** **Ship no per-name trend/composite gate for inflection.** The naive filter is
redundant; the down side works as-is and every gate we'd reach for makes it worse. The one
positive (up-breakout 50/200 regime filter) is parked, not shipped — it needs confirmation on
real `simulateSingleSpread` P&L (the study used a stock-move proxy; inflection has no stored
strikes in replay). Validate-first (FR-SEY-5) did its job: it stopped us from gating a
profitable strategy into a worse one.

**Follow-ups (not blocking, future):** (a) re-confirm the up-breakout regime filter on real
spread P&L before any ship; (b) investigate *why* composite is anti-predictive on bear-call
inflection — the breakout score weights may not translate to the short-call side.

### UPDATE (2026-06-14) — authoritative spread-P&L confirmation (`scripts/fr-sey-spread-pnl-confirm.mjs`)

Both follow-ups were run through a faithful offline replica of `BacktestEngine.simulateSingleSpread`
(Black-Scholes, IV-priced 0.30/0.15-delta vertical, 30 DTE, 50% PT / 200% stop) over every
inflection replay pick. Returns below are **% of the spread's max-loss capital** (credit-correct,
so this resolves the IV/credit confound the buffer proxy had). **This overturns two proxy-based
conclusions above:**

| Subset | n | win | avg ret / max-loss |
| --- | --- | --- | --- |
| up-breakout (bull put) | 742 | 76.0% | **+6.1%** |
| down-breakout (bear call) | 616 | 66.6% | **−1.4%** (net loser) |
| up, regime agrees / disagrees | 413 / 305 | 77.0 / 75.7% | +6.8% / +6.1% (no real edge) |
| down, ATR% high / IV high | 206 / 196 | 59.7 / 62.8% | −4.2% / −3.1% (worst, but no slice is good) |

1. **Down-breakout (bear call) inflection is a net loser (−1.4%/trade)** on real P&L — the buffer
   proxy's "≈68% OTM-win, marginally fine" was too generous. The earlier "don't drop it" was a
   proxy artifact and is **superseded**.
2. **The up-breakout 50/200 regime filter adds no meaningful real edge** (+6.8% vs +6.1%
   return-on-capital). Do **not** ship it. (The stock-HR / OTM-win gap washes out under real
   credits + management.)
3. **No ATR%/IV slice rescues the down side** — every tercile is ≤ marginal.

**Validated conclusion: inflection should be up-breakout-only.** Bull puts on up-breakouts are
solidly profitable (+6.1%, 76% win); the bear-call side is a structural loser no filter fixes.
This is the validate-before-ship rule (FR-SEY-5) earning its keep twice over: it caught a
profitable-looking-but-losing side and a helpful-looking-but-inert filter.

**IMPLEMENTED (configurable, default up-only) in both layers:**
- **Strategy/brief (v1.1.16):** `inflectionDirection` app setting ('up'/'down'/'both'),
  enforced in `ScoringService.hasBreakout`; the Daily Brief and Brief Replay inherit it via
  `scoreFromSignalData`. ⚙ Settings → General.
- **Execution engine (v1.1.17):** `exec_config.inflection_direction` (migration 051),
  enforced in `EntryPolicy.filterPick` (reason `inflection_direction`). 🤝 Execution Settings → Mode.
  Defense-in-depth: even a down-breakout pick reaching the engine is rejected.

### Recalibration study (2026-06-14) — DECLINED (`scripts/fr-sey-recalibration-study.mjs`)

Tested whether *any* alternative ranking of down-breakout picks yields a profitable bear-call
book on real spread P&L (616 resolved trades; bar to beat = up-breakout book +6.1%/trade,
76% win):

| down-breakout ranking | top 20% | top 33% |
| --- | --- | --- |
| baseline (all down) | −1.4% / 66.6% | — |
| current composite (DESC) | **−6.2% / 56%** (worst) | −3.6% |
| composite ASC (invert) | +0.5% | +0.9% |
| ATR% ascending (calmest) | **+2.4% / 74%** | −1.3% |
| IV ascending | −3.0% | −1.3% |
| low-ATR + low-IV ("safe") | −1.1% | −1.2% |

**Findings:** the current composite is the *worst* ranking for bear calls (it actively selects
losers — top 20% = −6.2%). The only positive ranking is "prefer the calmest names" (low ATR%)
at +2.4%/74%, but it's fragile (negative once widened past the top quintile) and still ~⅓ the
up side's edge. **No ranking produces a robust, sizeable, profitable bear-call book.**

**Resolution: recalibration declined — no scoring change makes bear-call inflection worth
trading.** Keep inflection up-only (shipped v1.1.16/v1.1.17). This also confirms the up-only
default is right: flipping to `'down'`/`'both'` surfaces actively-losing, worst-selected picks.
The Seykota workstream is now fully closed.

---

## Structure-grading: PoP-weighted premium (lizard vs bull put spread) — ⏸ DISABLED, pending realized backtest (v1.1.86)

**Question.** For *bullish* brief picks the recommended structure is almost always a **Big Lizard**
(87.7% of 114 historical picks; Jun 2026 sample). A bull put spread (`short-put-vertical`) expresses
the same bullish + high-IV thesis with defined risk — should the lab grade favour it?

**Static finding (102 picks where both constructible; lab's own stored `maxLoss`/`popEstimate`).**
The Big Lizard is risk-adjusted *worse* on every axis yet grades ~1.8 pts **higher**:

| | Big Lizard | Bull Put Spread |
|---|---|---|
| avg lab totalScore | 84.1 | 82.3 |
| avg max loss / capital | $34,175 | $2,298 |
| avg return-on-risk | 15.7% | **30.3%** |
| avg PoP (lab estimate) | **52.7%** | **70.6%** |
| breakeven cushion | 12.8% | 11.3% |

Spread has higher return-on-risk in 86% of picks, higher PoP in **100%**, for ~15× less capital.
The Big Lizard's "no upside risk" property only holds when net credit ≥ call-spread width — often
**not** met (the hedge picker falls back to the nearest strike), so it's frequently a coin-flip
range trade (PoP ~52%), not a one-sided premium play.

**Diagnosis.** The shipped `premiumScore` already divides credit by capital, but **saturates** at a
1.5%/30d threshold (both structures peg the 25-pt cap) and ignores PoP entirely. The blindspot is
PoP-weighting + graduated capital-efficiency, not the candidate list (adding the slug to the bullish
bucket changed selection in only 22.6% of picks, by ~1 pt — rejected as ineffective).

**Change (disabled).** `USE_POP_WEIGHTED_PREMIUM` (default **false**) re-grades the short-premium
`premiumScore` as `25 × clamp(ret30d/3,0,1) × clamp((PoP−40)/35,0.3,1)` (see
`docs/formulas.md#pop-weighted-premium`). On the sample it docks the lizard ~25→9 and the spread
~25→22, flipping selection toward the spread.

**Why not shipped on.** Static + PoP geometry is *necessary but not sufficient* — it shows better
probability-weighted risk-adjusted shape, not realized dollars (the lizard's larger absolute credit
means it wins bigger in the ~53% it wins). Per FR-SEY-5 a structure-selection change needs a realized
delta showing it is at-worst-neutral. The 2026-06 bullish sample **does not settle until Jul 2–24
2026** (none had expired at analysis time), so the realized backtest cannot run yet. Harness:
`scripts/backtest-lizard-vs-spread.mjs` (hold-to-expiry intrinsic, no IV assumptions; legs + price
paths already stored). **Re-run after Jul 24 2026; flip the flag on only if `spv − lizard` realized
return-on-capital ≥ 0.**

## Sequencing

Build order (operator-approved): **FR-SEY-5 → FR-SEY-2 → FR-SEY-1 → FR-SEY-3.** Each ships
per repo discipline (tests green, version bump, CHANGELOG + changelog + AI_CONTEXT + this
doc, one Conventional Commit, then `npm run package`).

**Status:** FR-SEY-5 ✅ (v—, process rule) · FR-SEY-2 ✅ (v1.1.14, default OFF) ·
FR-SEY-1 ✅ (v1.1.15, default OFF) · FR-SEY-3 ❌ (validated 2026-06-14, **not shipped** —
naive filter redundant, down side works as-is, gating it is harmful). The set is **complete**:
two configurable risk controls shipped (off by default) and one rule correctly rejected on the
data.


## Hold-period sweep — validated and REJECTED (2026-09-01, v1.1.142)

**Question.** `exec_config.hold_days` is a global planned-exit at 5 days. A hand-run P&L study
(2026-08-28) suggested brief picks are positive over ~5 days and negative over ~27, which would make
the hold period the dominant lever — the stop fired 16 times for −$52k and the profit target 73 times
for +$40k, while 85 positions bled out on defensive-DTE for −$95k.

**Method.** Brief Replay already stores `ret_5d` / `ret_10d` / `ret_21d` per pick, so the sweep needed
no new machinery. Range **2026-02-02 → 2026-07-31** (125 trading days, 750 replay briefs, **3,189
picks**), run *after* the v1.1.139–141 split and ticker-reuse repairs so the price series is clean.
Returns are direction-adjusted (`direction` column) and SPY-relative, and the test is **paired** — the
same pick measured at both horizons — so cross-sectional dispersion cancels.

**Result.** `alpha(5d) − alpha(21d)` = **−1.01%, t = −3.18**. Statistically significant, and the sign is
the opposite of the hypothesis: over the full window, holding 21 days beat holding 5.

| month | diff | t | winner |
| --- | --- | --- | --- |
| 2026-02 | −2.15% | −4.44 | 21d |
| 2026-03 | −0.55% | −0.96 | 21d |
| 2026-04 | −6.66% | −5.57 | 21d |
| 2026-05 | −5.10% | −5.18 | 21d |
| 2026-06 | **+6.99%** | **+13.00** | 5d |
| 2026-07 | +1.16% | +2.81 | 5d |

**The sign flips and every month is individually "significant."** 5d wins 2 of 6. Per-strategy is just
as split: wheel +1.52 (t 3.50) and inflection +1.99 (t 2.37) favour short holds, bullish −3.11
(t −3.51) and buy −5.59 (t −6.32) favour long, income flat (t 0.93).

**Verdict: REJECTED. `hold_days` stays 5.** FR-SEY-5 requires at-worst-neutral on the historical
sample; a sign-unstable effect means any fitted value is fitted to the month you happened to sample.

**Process lesson, recorded deliberately.** A one-month preliminary read (June 2026, on pre-repair
prices) showed clean monotone decay and the *opposite* per-strategy story — income improving with time,
buy collapsing. Six months reverses both. June is the single most pro-short-hold month in the sample.
**One month cannot establish a duration or regime effect**, however monotone it looks; this is the same
trap as the SPY-regime gate and the overbought guard.

**What survives — structural, not a lever.** Mean alpha *rises* with horizon (+0.69 → +1.05 → +1.70)
while median *falls* (+0.32 → +0.01 → −1.01): the typical pick decays while a few large winners carry
the tail. Feb–Jul 2026 was a semiconductor/memory melt-up (INTC 41→133, MU 322→1214, SNDK 573→2335 —
all verified as genuine sustained rallies, max single-day 19–26%, not data artifacts). So a long hold
is a **positive-skew bet on a trending regime**, which pays there and bleeds otherwise. Any future
work here should target *regime detection*, not a fixed hold length.


### Follow-up: regime detection — explored, NOT viable on current data (2026-09-01)

The hold-period rejection above closed with "any future work here should target *regime
detection*, not a fixed hold length." That was explored immediately. **It does not work on the
data available, and the reason is structural rather than a tuning problem.**

**The question is NOT the one already rejected.** The v0.32.90 SPY-regime gate asked *should I
enter in this regime*. This asks: does an entry-time regime feature predict **whether a 21-day
hold beats a 5-day hold**? Four features, all computable at entry with no lookahead, regressed
against the per-date mean of `alpha(21d) − alpha(5d)` over the same 125-date replay:

| feature | r | naive t |
| --- | --- | --- |
| `ret20` — SPY trailing 20d return | **0.582** | 7.94 |
| `distSma50` — SPY vs 50d SMA | 0.323 | 3.79 |
| `sma20v50` | −0.061 | −0.68 |
| `vol20` — SPY 20d realized vol | −0.119 | −1.33 |

**Those t-statistics are meaningless.** 125 dates with overlapping 21-day forward windows, and
adjacent dates share near-identical regime features — the effective independent sample is ~6
(125/21), not 125. This is the same inflation that made the one-month read look decisive.

**The counterexample is visible before any statistics:**

| month | SPY `ret20` | `distSma50` | mean(21d − 5d) |
| --- | --- | --- | --- |
| 2026-04 | +4.93% | **+2.56%** | **+6.60%** |
| 2026-06 | +0.41% | **+2.75%** | **−6.98%** |

April and June carry essentially the same `distSma50` and produce opposite outcomes. Any rule
keyed on distance-from-SMA50 must classify them identically and be wrong on one.

**Leave-one-month-out** (fit the sign on five months, predict the held-out one): `ret20` 4/6,
`distSma50` 3/6. `distSma50` is a coin flip. `ret20`'s 4/6 is not evidence — 3 is chance and 4
arises ~34% of the time from coin flips. Both of `ret20`'s misses are Feb and Mar, in the same
direction. The existing binary gate is flat too: SPY>SMA50 → +1.17%, SPY<SMA50 → +0.65%.

**Why this is structural.** Whether a 21-day hold beats a 5-day one depends on whether the market
*trends over the following 21 days*. An entry-time feature can only help if trend persists, so
what is really being measured is "does SPY momentum persist a month out" — and `ret20` is a
momentum proxy in the same family as the feature that already inverted on full-year data in
v0.32.90. Over Feb–Jul 2026 it persisted in Apr/May and did not in Jun/Jul. **Six observations of
a phenomenon that changes on a monthly cadence cannot support a rule**, at any effort level.

**What it would take.** ~3+ years of replay for 36+ monthly observations. `historical_prices`
starts 2024-05-31 for most tickers and `iv_history` is far shorter, so this is not testable today.

**Disposition: do not build.** Re-open only if the price/IV panel ever reaches 3+ years AND a
pre-registered feature is chosen before looking at outcomes.

## Finding: Big Lizard vs Short Put Vertical — settled 2026-09-02 (v1.1.161)

The FR-SEY-5 backtest deferred in v1.1.86 finally has a settled sample: **160 trades**, June and
July 2026 entries, hold-to-expiry intrinsic settlement (no IV assumptions).

| | Big Lizard | Short Put Vertical |
|---|---|---|
| total P&L | **+$97,561** | +$30,482 |
| win rate | **74.4%** | 68.1% |
| avg return-on-capital | 1.30% | **2.65%** |
| worst single trade | −$7,690 | **−$4,985** |
| capital consumed | $4,924,345 | **$422,153** |

**Delta (spv − lizard) = +1.35pp → the `≥ 0` gate is MET.** The lizard earns 3.2× the dollars on
11.7× the capital; per dollar deployed the spread is roughly twice as efficient with a smaller
tail. Note the lizard's *higher* win rate — it wins more often and loses bigger, which is what a
52.7% static PoP estimate failed to capture and why realized settlement was required.

### Why `USE_POP_WEIGHTED_PREMIUM` stays OFF despite passing

The gate answers "is the spread at worst neutral against the lizard?" — yes. But it does not
answer the question enabling the flag actually poses. `short-put-vertical` is in
`STRATEGY_RELEVANT_SLUGS.inflection`, **not `bullish`**, so in the bullish bucket the flag cannot
substitute the spread. It can only *dock the lizard*, handing picks to `long-call-vertical`,
`call-zebra`, `call-butterfly` or `poor-mans-covered-call` — none of which this backtest measured.
Enabling would ship an unvalidated selection change under cover of a validated one.

**To enable:** backtest the bullish bucket's post-dock alternatives, or move `short-put-vertical`
into `bullish` (tested and rejected in v1.1.86 — changed 22.6% of picks by ~1pt).

### Methodology warning

The first run of this harness reported the lizard at **−$70,955** — the wrong sign. Four CRWD
picks carried pre-split strikes (4:1 split; strike/spot 4.12×) settled against post-split closes,
contributing **−$168,516** of fiction. `split-repair` fixes `historical_prices` but never the legs
frozen in `daily_briefs.picks`, so repairing the series made the stored legs *more* inconsistent,
not less. The harness now carries a scale guard and prints what it excludes. Any future replay
reading stored legs needs the same guard.
