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
Excluding it is the highest-confidence improvement — pending the operator's decision on *where*
to implement (execution-side entry filter vs strategy-level). This is the validate-before-ship
rule (FR-SEY-5) earning its keep twice over: it caught a profitable-looking-but-losing side and
a helpful-looking-but-inert filter.

---

## Sequencing

Build order (operator-approved): **FR-SEY-5 → FR-SEY-2 → FR-SEY-1 → FR-SEY-3.** Each ships
per repo discipline (tests green, version bump, CHANGELOG + changelog + AI_CONTEXT + this
doc, one Conventional Commit, then `npm run package`).

**Status:** FR-SEY-5 ✅ (v—, process rule) · FR-SEY-2 ✅ (v1.1.14, default OFF) ·
FR-SEY-1 ✅ (v1.1.15, default OFF) · FR-SEY-3 ❌ (validated 2026-06-14, **not shipped** —
naive filter redundant, down side works as-is, gating it is harmful). The set is **complete**:
two configurable risk controls shipped (off by default) and one rule correctly rejected on the
data.
