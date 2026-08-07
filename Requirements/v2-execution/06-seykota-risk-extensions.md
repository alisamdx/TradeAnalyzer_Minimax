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
