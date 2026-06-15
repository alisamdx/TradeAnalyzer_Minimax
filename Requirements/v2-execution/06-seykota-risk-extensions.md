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

## FR-SEY-1 — Correlation / sector concentration cap — 📋

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

## FR-SEY-3 — Per-name trend-alignment filter for inflection — 📋 (validate first)

**Principle:** Trade in the direction of the established trend — at the *name* level, not the
market level (the market-level version is rejected; see non-goals).

**Requirement (provisional, pending validation):** Only take an inflection credit spread when
the underlying's own trend agrees with the breakout direction — e.g. price vs its 50-day SMA,
or an ADX floor (`technical_signals` already has `adx` and `atr_pct`). Bull-put verticals
require an up-trend/non-downtrend; bear-call verticals require a down-trend.

**Validation gate (FR-SEY-5):** Before any code ships active, run this filter through Brief
Replay on inflection picks and confirm it improves (or is neutral on) direction-aware hit
rate / return. If it doesn't help, it ships **disabled** (or not at all) with the finding
recorded here.

**Acceptance:** TBD after the replay study.

---

## Sequencing

Build order (operator-approved): **FR-SEY-5 → FR-SEY-2 → FR-SEY-1 → FR-SEY-3.** Each ships
per repo discipline (tests green, version bump, CHANGELOG + changelog + AI_CONTEXT + this
doc, one Conventional Commit, then `npm run package`). FR-SEY-3 is gated on its replay study.
