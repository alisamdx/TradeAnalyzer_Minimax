# Changelog

## [1.1.14] — 2026-06-14

### Added
- **v2 execution — FR-SEY-2: drawdown-scaled risk (Seykota "equity-curve money management").** The risk governor now tracks a **closed-equity high-water mark** and, when drawdown from it reaches `drawdownThrottlePct`, multiplies the effective per-trade risk by `drawdownThrottleFactor` (e.g. 0.5 = half size) until the curve recovers — a graduated step between "normal" and the binary daily kill switch. **Default OFF** (`drawdownThrottlePct = 0`), so behaviour is unchanged until the operator opts in (Execution Settings → Risk limits). Migration **049** adds `exec_config.drawdown_throttle_pct`/`_factor` and `exec_risk_state.equity_high_water` (seeded to the ceiling, ratchets up only). Pure helper `drawdownThrottleFactor()` in `risk-gate.ts`; the gate's `per_trade_risk` check uses a new optional `effectiveMaxRiskPct`; `risk-governor` computes drawdown (closed-equity, to avoid unrealized-swing thrash), applies the throttle in `sizeEntry` + `checkEntry`, and exposes `drawdownPct` on the engine state view. The Trading Desk shows drawdown + HWM + throttle status. Tests: `risk-gate.test.ts` (+5) and `risk-governor.test.ts` (+4); full suite 450 green. Per FR-SEY-5 it ships **disabled by default** (a conservative size-reducer, not an edge claim — enabling is the operator's risk choice).

## [1.1.13] — 2026-06-14

### Changed
- **Moved 🔔 Alerts into the 🗂️ Misc landing screen.** Alerts was a standalone button under the Personal section; it's now a card on the Misc screen alongside Backtest / Test API / Data Sync / History, further trimming the sidebar. The 🗂️ Misc button highlights while Alerts (or any other Misc tool) is open. AlertsView and its IPC are unchanged.

## [1.1.12] — 2026-06-14

### Changed
- **Decluttered the sidebar: the Misc section is now a single 🗂️ Misc entry** that opens a landing screen with the four occasional tools as cards — **Backtest**, **Test API**, **Data Sync**, **History** (`src/renderer/src/views/MiscView.tsx`). Selecting one pushes it onto the nav stack, so a **← Back** returns to the Misc screen. The Misc sidebar button highlights while any of those four views is open. No functionality removed — the views and their IPC are unchanged; only the navigation path changed.

## [1.1.11] — 2026-06-14

### Fixed
- **Sidebar now scrolls when the menu is taller than the window.** The nav lives in a single `.nav-section` inside `.sidebar` (which is `overflow: hidden`), so on shorter windows the bottom items (Misc → History, and the new Execution section) were clipped and unreachable. `.nav-section` now fills the sidebar and scrolls (`flex: 1; min-height: 0; overflow-y: auto`) — `min-height: 0` lets the flex child shrink below its content height so the overflow scrolls instead of clipping. CSS-only; no testable unit (visual layout fix).

## [1.1.10] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5c/d (control panel UI), completing Phase 5.** New **🤝 Execution** sidebar section with two Electron views, both driving the (mock-backed) engine through `window.api.execution.*`. **Trading Desk** (`src/renderer/src/views/TradingDeskView.tsx`): master header with PAPER/LIVE badge + engine-state pill; Engine panel (Start/Pause/Stop — master Stop = hard stop — + broker/health/last-cycle); Kill Switch panel (status + Trip/Clear); Capital panel (deployed-vs-ceiling gauge, day P&L, trip threshold); proposals queue with Approve/Reject (**paper = 1-click, live = type-to-confirm**); open-positions table; activity log off the audit trail. Live-updates via `execution:event` + a 15 s poll fallback. **Execution Settings** (`src/renderer/src/views/ExecutionSettingsView.tsx`): an editor over the `exec_config` row (`getConfig`/`updateConfig`) grouped into Mode / Risk limits / Entry policy / Exit policy, with dirty-tracking, Save/Revert, and a confirmation gate on switching to live mode. `src/renderer/src/App.tsx` adds the section, `View` union entries, and `renderEntry` cases. No new automated tests (renderer views; underlying engine/IPC already covered — full suite green, 441). No auto-generated entries yet (brief→`PickInput` lands with Phase 6); the desk otherwise reflects live engine state. The product is now demonstrable end-to-end without IBKR.

## [1.1.9] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5b (activation).** The first **non-dormant** step: `ExecutionEngine` is now instantiated in `src/main/index.ts` against the deterministic `MockExecutionBroker` and starts `stopped` (constructing it opens no broker connection and places no orders), and its event stream is forwarded to the renderer (`webContents.send('execution:event', …)`). New `src/main/ipc/ipc-execution.ts` (`registerExecutionIpc`) exposes the engine facade as a thin pass-through — reads (`execution:get-state`/`:get-config`/`:get-risk-state`/`:get-positions`/`:get-proposals`/`:get-audit`), config (`:update-config`), control (`:start`/`:stop`/`:pause`, `:kill-trip`/`:kill-clear`), and approvals (`:approve-proposal` routing entry→order-manager, exit→management; `:reject-proposal`). New `window.api.execution.*` preload namespace (34th) mirrors it, with `onEvent(cb)` subscribing to the live event stream. New renderer-facing facade types in `src/shared/types.ts` (`ExecEngineStateView`, `ExecEngineHealth`, `ExecEngineEvent`, `ExecPositionRow`, `ExecProposalRow`, `ExecAuditRow`, `ExecApproveResult`, `ExecStartResult`). No new tests — the facade is covered by `tests/execution-engine.test.ts` and the IPC layer is a pure pass-through; full suite green (441). The Electron Trading Desk / Settings UI lands next (Phase 5c/d); live auto-entries (brief→`PickInput`) land with the IBKR adapter (Phase 6).

## [1.1.8] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5a (engine assembly).** `src/main/execution/execution-engine.ts` (`ExecutionEngine`) wires the whole subsystem into one object: governor, order manager, entry/exit policy, management loop, and the headless core — with the management loop bound to the core's market-cycle hook (so each market-open cycle evaluates exits and acts). The broker is **injected**, so the same assembly runs the `MockExecutionBroker` (tests/dev) or the IBKR adapter (Phase 6) with no code change. Exposes the small facade the IPC/control-API layers will call: lifecycle (`startEngine`/`stopEngine`/`pauseEngine`/kill-switch), `generateEntries`, approval routing (`approveProposal` dispatches entry→order-manager / exit→management; `rejectProposal`), and reads (`getState`/`getConfig`/`updateConfig`/`getRiskState`/`getPositions`/`getProposals`/`getAudit`). Constructing it is inert — engine starts `stopped`, no broker connection, no orders. `tests/execution-engine.test.ts` (6): start, generate→approve→open, the full open→mark-moves→protective-stop-close loop, discretionary exit-proposal approval routing, reject, config/risk reads. Still dormant — **not yet instantiated in the app.**

## [1.1.7] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4c (exit policy), completing Phase 4.** The position-management half of the trade logic. Migration **048** adds the configurable exit rules to `exec_config` (`stop_multiple` 2×, `defensive_dte` 2, `profit_target_pct` 50, `hold_days` 5, `time_exit_dte`, plus `profit_target_mode`/`time_exit_mode` propose|auto) and `exec_proposals.position_id`/`close_reason` (for exit proposals). `src/main/execution/exit-policy.ts` (`ExitPolicy.evaluate`, pure): priority-ordered rules — **protective** stop (loss ≥ 2× credit) and defensive-expiry close (auto, §0.3 invariant), then **discretionary** profit-target (≤ 50% of credit) and planned/time exit. `src/main/execution/position-manager.ts` (`ManagementLoop`): each cycle evaluates every open position and acts — protective → auto `submitClose`; discretionary → auto-close if the mode is `auto`, else raise an exit proposal (one pending per position); `approveExitProposal` closes on approval. Tests: `tests/exit-policy.test.ts` (9, every rule + priority + unpriced) and `tests/position-manager.test.ts` (6, protective auto-close, discretionary propose/auto, no-dup, no-trigger, approve-exit). Still dormant — wired to nothing yet; the engine assembly + brief→pick source land with the IBKR integration.

## [1.1.6] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4b (order manager).** The bridge between proposals/exits and the broker. Migration **047** adds `exec_orders.position_id` (links an order to the position it opens/closes). `src/main/execution/order-manager.ts` (`OrderManager`): `approveProposal` re-runs the pre-trade gate at submission (§2.5), mints a client order id and persists the order row **before** the broker send (idempotency, §2.8), then submits an open combo order; broker status/fill callbacks drive the order state machine and **open an `exec_positions` row** on fill (recomputing deployed capital). `submitClose` reverses the position's legs into a close order, marking the position `closing → closed` with its `close_reason` on fill. Fills are de-duplicated by broker exec id; expired/already-approved proposals and gate failures are rejected with reasons; everything is audited (`proposal_approved`, `order_submitted`, `fill`, `position_opened`, `position_closed`). `tests/order-manager.test.ts` (6): full approve→fill→position, not-pending, expired, gate-recheck reject, close→freed capital, already-closed. Still dormant — wired to nothing yet.

## [1.1.5] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4a (entry policy).** The first half of the trade logic: turning eligible brief picks into priced, risk-gated proposals awaiting approval. Migration **046** adds the configurable entry-policy columns to `exec_config` (`min_composite_score` 70, `max_new_entries_per_day` 1, `max_new_entries_per_week` 3, `avoid_earnings_before_expiry`, `entry_window_start`/`_end` 10:00–15:00 ET, `reprice_tolerance_pct`), surfaced through `ExecConfig` + the governor. `src/main/execution/entry-policy.ts` (`EntryPolicy`, on a normalized `PickInput` so it's decoupled from v1 brief internals): `filterPick` (eligible strategy · critic pass/caution · composite ≥ floor · liquidity · earnings · entry window), `buildProposal` (price the combo at the venue → size via the governor → run the pre-trade gate → persist a pending `exec_proposals` row with shelf-life, audited), and `generateEntries` (daily/weekly caps, highest-composite first). Helpers `etMinutesOfDay`/`hhmmToMinutes` added to `market-hours.ts`. Tests: `tests/entry-policy.test.ts` (14). Still dormant — wired to nothing yet.

## [1.1.4] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 3b (control API + SSE), completing Phase 3.** `src/main/execution/control-api.ts` (`ExecutionControlApi`): a Fastify server on `127.0.0.1:7433` — separate from the v1 agent API (`:7432`) so it's reachable when the app window is closed — that wraps the `ExecutionCore` + `RiskGovernor`. Token-authed via `X-Agent-Token` (reuses `~/.tradeanalyzer/agent.token`), with a public `/exec/health` probe. Routes: engine control (`POST /exec/engine/start|stop|pause`, `POST /exec/kill-switch/trip|clear`), reads (`GET /exec/state|config|risk|positions|audit`), the zero-latency `POST /exec/brief-ready` handoff (audits + invokes an optional Phase-4 `onBriefReady` hook), and an SSE stream `GET /exec/events` of the core's engine-state/cycle/health/reconcile events. `tests/control-api.test.ts` (9 tests, via `fastify.inject`): auth gating, state, engine start/pause/stop, pause-409, kill trip/clear, config/risk/positions/audit reads, brief-ready hook, SSE frame formatting. Still dormant — wired to nothing yet.

## [1.1.3] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 3a (headless core runtime).** The always-on engine that ties the governor + broker together (control API/SSE follow in 3b). `src/main/execution/market-hours.ts`: a DST-correct US RTH gate (`isMarketOpen`, Mon–Fri 09:30–16:00 ET via `Intl`, configurable holidays) + `etDateString` (ET date for the day-P&L anchor). `src/main/execution/reconciliation.ts`: `reconcile()` — the broker is the source of truth; syncs order status + position marks into `exec_*` and detects drift (positions the broker holds that the core doesn't, and vice-versa), plus `markNeedsAttention()`. `src/main/execution/execution-core.ts` (`ExecutionCore`): owns the broker + governor and runs the management cycle — **cold-start reconcile-before-act** (refuses to start on drift, flags the positions), a per-cycle flow that **fails closed** on a disconnected broker and **trips the kill switch** on drift, only invokes the entry/exit policy hook while the market is open (the hook is filled in Phase 4), a health watchdog (broker-disconnected / stale-cycle), and an event stream for the SSE layer. Tests: `tests/market-hours.test.ts` (7), `tests/reconciliation.test.ts` (5), `tests/execution-core.test.ts` (11). Still dormant — wired to nothing yet.

## [1.1.2] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 2 (risk governor, the safety core).** Added the fail-closed risk layer that no order may bypass, split into a pure decision layer and a stateful service. `src/main/execution/risk-gate.ts` (pure, no I/O): `sizePosition()` (contracts = floor(per-trade-risk / max-loss), capped by remaining deployable capital) and `evaluateGate()` — the ordered 10-check pre-trade gate (engine running · broker connected · defined-risk & eligible strategy · per-trade risk · max concurrent · per-ticker · per-strategy · capital ceiling · buying power · daily-loss headroom), first failure supplies the reject reason. `src/main/execution/risk-governor.ts` (`RiskGovernor`, DB-backed): the single source of risk truth — reads/writes `exec_config` + `exec_risk_state`, the engine state machine (`start`/`stop`/`pause`/`tripKillSwitch`/`clearKillSwitch` with validated transitions — can't start while kill-tripped, manual clear only), day-P&L accounting that auto-trips the kill switch at the configured % loss (realized + unrealized, resets at session anchor), deployed-capital recompute, COID minting, and the append-only audit log; every state change commits atomically with its audit entry. `checkEntry()` assembles a context from the DB + broker and runs the pure gate. Tests: `tests/risk-gate.test.ts` (17) + `tests/risk-governor.test.ts` (18). Still dormant — wired to nothing yet.

## [1.1.1] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 1 (broker seam + mock).** Added the `ExecutionBroker` interface (`src/main/execution/execution-broker.ts`) — the abstraction over the venue that prices, places, and fills orders, so the engine never depends on a concrete broker (paper vs live becomes a config of the IBKR implementation, not a code branch). Added `MockExecutionBroker` (`src/main/execution/mock-execution-broker.ts`): a deterministic, fully controllable in-memory broker (configurable pricing, fills full/partial/reject/manual, connection state, buying power, marks) that lets the entire engine — risk governor, loops, control panel — be built and tested with **no IBKR account**. It is idempotent on `clientOrderId` (a repeated COID never duplicates an order) and matches closing orders to their opening position regardless of leg direction. `tests/mock-execution-broker.test.ts` (12 tests) pins the contract: pricing, auto/manual/partial/reject fills, idempotency, fail-closed-when-disconnected, position open/close, marks, cancel. Still dormant — wired to nothing yet.

## [1.1.0] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 0 (schema foundation).** First increment toward automated trade execution (full requirements in `Requirements/v2-execution/`). Migration **045** creates the seven namespaced `exec_*` tables — `exec_config`, `exec_risk_state`, `exec_proposals`, `exec_orders`, `exec_fills`, `exec_positions`, and the append-only `exec_audit_log` — and seeds the singleton config + risk-state rows with the locked v2.0 defaults ($10k ceiling · 5% max-risk/trade · 5 concurrent · 10% daily-loss trip · 1 position/ticker · inflection-only · engine `stopped`). Added the `Exec*` domain types to `src/shared/types.ts` and `tests/exec-schema.test.ts` (table presence, seeded defaults, single-row + enum CHECK constraints, idempotent seeding, COID uniqueness). **The tables are dormant** — created and seeded but not yet wired to any service or UI; the headless execution core, risk governor, loops, and control panel come in later phases. No behavior change to the existing app.

## [1.0.0] — 2026-06-14

### Milestone
- **v1.0.0 — the decision-support app is feature-complete.** This release draws the line under v1: watchlists, screener, five-mode analysis, the configurable scoring engine, the daily AI intelligence brief + critic, Brief Replay, validation dashboards, multi-leg payoff modeling, E\*Trade-synced portfolio tracking, LEAPS+CSP / collared-LEAPS screeners, earnings calendar, News & Research, the Agent overhaul, and backtesting — all shipped and verified against the v1 spec (`Requirements/spec/`). The app remains **read-only at the broker** by design: it analyzes, recommends, and validates, but never places an order.
- **Next phase is v2: automated execution.** Work begins on a headless execution core (semi-auto, approve-each), trading a segregated IBKR account in paper first, then real capital under hard risk limits. This is a new subsystem with its own requirement set — see the new execution spec section and `.ai/AI_CONTEXT.md §11`. No behavior change in this release; it is the version marker that separates decision-support (v1) from execution (v2).

## [0.34.10] — 2026-06-14

### Added
- **💰 dollar P&L for directional strategies (buy / bullish / bearish)** — the Brief Replay summary's 💰 button now appears on the three directional rows too, so you can compare **buy vs bullish dollar-to-dollar**. These aren't premium structures, so instead of an option sim they run a **fixed-notional stock position**: $10,000 deployed per pick (long for buy/bullish, **short for bearish**), marked at the replay's 21-day forward close. Every pick uses the same $10k, so Total P&L is directly comparable between buy and bullish; the modal notes the premium strategies above use a different capital base (option collateral), so those are compared by ROC, not headline dollars. `AggregatePickBacktest.structure` gains `'stock'`; new `notionalPerTrade` field. The modal labels, subtitle, chart caption, and footnote adapt to the stock structure (ROC → "return").

## [0.34.9] — 2026-06-13

### Added
- **💰 aggregate backtest now covers Inflection (directional credit spread)** — the Brief Replay summary's 💰 button now appears on the **inflection** row too, not just wheel/income. Because inflection is a directional credit spread (not a CSP), it runs a new `simulateSingleSpread`: a **bull put spread** for up-breakouts / **bear call spread** for down-breakouts (sell ~0.30Δ, buy 0.15Δ — mirroring the live `short-put-vertical`/`short-call-vertical`), per pick, IV-priced, **defined-risk** (return on max-loss capital, each loss capped at the spread width). The modal labels and footnote adapt to the credit-spread structure. `AggregatePickBacktest` gains a `structure` ('csp' | 'credit-spread') field.

## [0.34.8] — 2026-06-13

### Fixed
- **💰 aggregate backtest: dollar-based equity curve + drawdown (was misleading)** — the modal previously showed a "Cumulative ROC" that summed per-trade *percentages* across all trades (e.g. +407%) and a "Max drawdown" of −158% — dimensionally meaningless (you can't draw down 158% of capital). The equity curve is now **cumulative realized dollar P&L** (ending exactly at Total P&L), and **Max drawdown is a real dollar figure** (largest peak-to-trough drop). The line turns red when the strategy is net-negative. Added an explanatory note for the common case of a **high win rate but net dollar loss** — the short-premium asymmetry (many small premium wins, a few large assignment losses; avg ROC is equal-weight per trade while Total P&L is collateral-weighted, so they legitimately diverge). Type: `AggregatePickBacktest.equityCurve[].cumReturnPct → cumPnl`, `maxDrawdownPct → maxDrawdownPnl`.

## [0.34.7] — 2026-06-13

### Added
- **💰 aggregate CSP backtest shows dollar P&L** — the "CSP backtest over every pick" modal now displays **Total P&L** ($) and **Avg $/trade** alongside the ROC metrics (the backend already computed `totalPnl`; it just wasn't surfaced). Total P&L = sum of one CSP contract (100 shares) per pick.

## [0.34.6] — 2026-06-13

### Changed
- **Backtest auto-runs when opened from a deep-link** — landing on Backtest via the 🔁 action (My Stocks / Brief picks) now runs the backtest automatically with the pre-filled ticker + strategy, instead of waiting for a manual "Run" click. It waits for IV coverage to load first so the start date defaults to the IV-accurate range, then kicks off. Manually opening the Backtest view still shows the form for you to fill in.

## [0.34.5] — 2026-06-13

### Changed
- **Backtest: dropped the Starting Capital input** — the field is gone; the engine auto-sizes the capital base to exactly one contract (`max spot × 100`) and reports metrics as return on the capital one contract ties up. This also **removes the capital gate** entirely, so high-priced stocks (META, etc.) just run — no more flat-zero curve and no need for the "raise capital" error added in v0.34.4. (`starting_capital` stays in the schema for back-compat but is unused.)
- **Backtest trade log is now sortable** — click any column header to sort (toggles asc/desc; nulls last). Defaults to **entry date, descending** (most recent trades first).

## [0.34.4] — 2026-06-13

### Fixed
- **Backtest no longer silently returns a flat-zero curve when capital is too small** — a CSP/Wheel backtest on a high-priced stock (e.g. META ~$645 → ~$60k collateral) with the default $25k starting capital could never open a position, producing a flat equity curve and all-zero metrics with no explanation. The engine now throws a clear error: *"No trades: starting capital ($25,000) is below the ~$60,000 collateral a 0.30-delta CSP needs for META. Raise Starting Capital."* (Also covers the no-premium/insufficient-data case.) Note: the aggregate 💰 P&L backtest is unaffected — it's per-trade ROC, not capital-constrained.

## [0.34.3] — 2026-06-13

### Added
- **Backtest trade log shows the underlying stock price at entry & exit** — new **Stk@Entry** and **Stk@Exit** columns (migration 044 adds `backtest_trades.entry_spot` / `exit_spot`, populated by the engine from the simulated spot at open and close). Makes each trade readable — you can see where the stock sat relative to the strike. Existing runs show "—" for these until re-run.

## [0.34.2] — 2026-06-13

### Added
- **Backtest trade log shows exit price** — the trade table now has an **Exit Px** column (the option's settlement/buyback price per share at close: the closing mid on a profit/stop exit, intrinsic on assignment, 0 on a worthless expiry). The entry premium column is relabeled **Entry Px** for symmetry. (No data change — `exitPremium` was already captured per trade.)

## [0.34.1] — 2026-06-13

### Added
- **Backtest form guides toward IV-accurate start dates** — the New Backtest form now defaults its start date to the oldest date in `iv_history` (when available) and sets that as the date input's `min`, so backtests are IV-priced by default. If a start date earlier than IV coverage is chosen, an inline ⚠ warning explains that earlier dates are priced from realized vol (not implied vol) and offers a one-click "Use {date}". When the start is within coverage, a "✓ IV-priced" hint confirms it. `BacktestEngine.ivHistoryStart()` + IPC `backtest:iv-coverage`. (IV history currently begins 2025-05-29 — ~1 year — so older backtests were silently realized-vol priced.)

## [0.34.0] — 2026-06-13

### Added
- **Aggregate "backtest my picks" in Brief Replay (integration phase 2 of 2)** — the summary table's new **💰 P&L** button (on the wheel & income rows) simulates a cash-secured put on **every** historical Brief-Replay pick for that strategy and pools the results into one view: trade count, win rate, avg/median return-on-capital, cumulative ROC, max drawdown, avg days held, and an **equity curve** (cumulative ROC by exit date). This answers *"if I'd traded every wheel/income pick, what would they have actually returned?"* — using **real option P&L** (Black-Scholes from historical price + IV), not the stock-move proxy the summary columns show. `BacktestEngine.backtestReplayPicks(strategy)`; IPC `backtest:replay-picks`. Each pick is one 0.30-delta / 30-DTE CSP with 50%-profit / 200%-stop exits; equal-weight, capital unconstrained. Completes the backtest integration begun in v0.33.7.

## [0.33.8] — 2026-06-13

### Changed
- **Backtest engine prices off historical implied volatility** — the simulator now uses `iv_history` ATM IV (as-of the entry date) for its Black-Scholes volatility input, falling back to 20-day realized vol only when no IV history exists. Previously it always used realized vol, which understated the premium a CSP/CC/Wheel actually collects (sellers are paid IV, which runs above realized — the variance risk premium). The same `sigma` drives strike selection, entry premium, and daily mark-to-market. See `docs/formulas.md#backtest-iv`.

## [0.33.7] — 2026-06-13

### Added
- **Backtest deep-link from recommendations (integration phase 1 of 2)** — a "🔁 Backtest" action now appears on **My Stocks** rows (every stock → pre-fills a CSP) and on **Daily Brief** wheel/income pick cards (wheel → Wheel, income → CSP), opening the Backtest view pre-filled with the ticker + strategy. No more manual one-stock data entry to test a recommendation. (Backtest only appears where its engine applies — premium-selling strategies; buy/bullish/bearish/inflection brief picks don't show it.) New `navigate-to-backtest` event; `BacktestView` accepts `initialTicker`/`initialStrategy`. Phase 2 (aggregate "backtest all my picks" with one equity curve) is next.

## [0.33.6] — 2026-06-13

### Fixed
- **My Stocks email: header/data column alignment** — the email table's header cells were all left-aligned while the numeric data cells were right-aligned, so headers didn't line up over their columns. Header and data alignment are now driven by a single per-column definition (numeric columns right, text columns left, flag centered).

## [0.33.5] — 2026-06-13

### Added
- **My Stocks: "in play" flag** — each stock in the conviction list has an on/off 🚩 flag (migration 043 adds `conviction_stocks.in_play`) to mark stocks you want to pay attention to / may act on. Toggle it from a new flag column in the table (flagged rows are highlighted and counted in the header). It's a transient marker — toggling does **not** write a band-history snapshot.
- **My Stocks: email the list** — a new "✉ Email My Stocks" button sends the list (via the existing SMTP/email config) as an HTML table including the 🚩 flag, sorted in-play first then by zone. The **Actions** column is omitted (UI-only, no information). The button is disabled with a tooltip when email isn't configured. New IPC: `conviction:set-in-play`, `conviction:send-email`, `conviction:email-configured`.

## [0.33.4] — 2026-06-13

### Changed
- **Daily Brief & email/PDF: strategy sections now ordered by the day's top composite score** — instead of a fixed sequence, the strategy with the highest-scoring single pick that day appears first, then descending. The previous fixed order (wheel→bullish→bearish→income→buy→inflection) is the tiebreaker and orders strategies with no picks last. Applied consistently to the on-screen brief, the HTML email, and the PDF (shared `orderByTopComposite`). Note: composite scores are strategy-specific (different signals/weights per strategy), so this is a surfacing heuristic — it floats the strongest-scored pick to the top, not a cross-strategy quality ranking (the score-badge tooltip already flags this). Also fixed the PDF cover's hardcoded "across 5 strategies" → actual count.

## [0.33.3] — 2026-06-13

### Changed
- **Brief Replay Score-Signal tab now shows all strategies** — the score-quintile and pick-rank charts were hardcoded to curated 3-strategy subsets (buy·bullish·bearish / buy·bullish·wheel), so inflection (and income/wheel) didn't appear. Both charts now render every strategy in the chart payload, driven by `data.strategies` with a per-strategy color fallback. Inflection's bars use its direction-adjusted 21d return.

## [0.33.2] — 2026-06-13

### Fixed
- **Brief Replay charts now include the Inflection strategy** — the Monthly hit-rate chart (labeled "all strategies") used a hardcoded 5-strategy list that omitted inflection, and the charts modal's color/label maps had no `inflection` entry (so it rendered gray/uncapitalized in the Performance, Regime, and Ticker tabs). Added inflection to `ReplayChartMonthlyRow` + the backend monthly builder (`mHr('inflection')`, using the already-direction-adjusted 21d return), and to `STRAT_COLORS`/`STRAT_LABEL` + the Monthly chart's line/legend lists. The curated Score-Signal and Rank charts (explicitly buy·bullish·bearish / buy·bullish·wheel) are unchanged by design.

## [0.33.1] — 2026-06-13

### Added
- **Bearish inflection (both directions complete)** — the Inflection strategy now also takes **down breakouts** (fresh 20-day-low break in a downtrend → **bear call spread**, `short-call-vertical`), not just up breakouts. `hasBreakout` accepts `breakout_state === ±1`. To make the metrics correct for a mixed long/short strategy, **Brief Replay outcomes are now direction-aware**: migration 042 adds `replay_outcomes.direction` (1 long / −1 short, populated per pick from the breakout sign; bearish = −1, others = 1; legacy rows fall back to the strategy-implied direction). The replay summary hit-rate uses it uniformly, and inflection's average return is direction-adjusted (positive = thesis worked) so long and short picks don't cancel; the charts direction-adjust inflection's 21-day return likewise. The critic now selects inflection's **higher-graded** relevant vertical (the lab's direction bias makes the correct one — bull put for up-breaks, bear call for down — grade higher), matching the brief card's existing best-score pick.

## [0.33.0] — 2026-06-13

### Added
- **Inflection strategy live in the Daily Brief (Phase 3 of 3)** — `inflection` joins the live brief as a 6th strategy: a **directional credit spread anchored at a fresh 20-day breakout** (bullish). It surfaces up to 5 top-ranked breakout picks per day; on days with few breakouts it shows fewer (the signal scores 0 without a fresh with-trend breakout). The structure is the existing **`short-put-vertical` (bull put spread)** credit vertical — already defined-risk with correct credit P&L; mapped via `STRATEGY_RELEVANT_SLUGS` so the liquidity gate, critic, and brief card all use it. Added a 6th section to the Daily Brief view (and the PDF/email report), with `short-put-vertical`/`short-call-vertical` shown as "Bull Put Spread"/"Bear Call Spread". Brief Replay scores the same 6 strategies (`REPLAY_STRATEGIES` now aliases `STRATEGIES`). **Still bullish-only**; bearish inflection (down-break → bear call spread) remains a follow-up needing direction-aware replay outcomes.

### Fixed
- Corrected the inflection relevant-slug mapping introduced in v0.32.99 — it referenced non-existent `bull-put-spread`/`bear-call-spread` slugs; the real Strategy Lab credit verticals are `short-put-vertical`/`short-call-vertical`.

## [0.32.99] — 2026-06-13

### Added
- **Inflection scoring strategy (Phase 2 of 3)** — `inflection` is now a 6th `ScoringStrategy`. Its composite ranks breakout-setup quality from four signals, **all gated on a fresh with-trend breakout** (`breakout_state`): `breakoutDecisiveness` (30), `volumeSurge` (25), `breakoutIvRank` (25, premium richness), `breakoutAtrPct` (20). A ticker with no fresh breakout scores 0 and never surfaces. Signals are read live from `technical_signals` (`gatherSignalData`) and point-in-time in Brief Replay. **Phase 2 surfaces bullish (up) breakouts only** so the replay "stock-up = win" aggregation is correct; bearish (down → bear call spread) is a follow-up needing direction-aware outcomes. The strategy scores in **Brief Replay** (`REPLAY_STRATEGIES`) for validation but is **not yet in the live Daily Brief** (`STRATEGIES` stays at 5) — that's Phase 3. Tune its weights in the Trade Scoring view.

## [0.32.98] — 2026-06-13

### Added
- **Breakout/continuation signals (Inflection strategy — Phase 1 of 3)** — `DailyTechnicalSignalsJob` now computes and stores five breakout signals per ticker (migration 041 adds them to `technical_signals`): `breakout_state` (−1 fresh 20-day-low breakdown in a downtrend / 0 none / 1 fresh 20-day-high breakout in an uptrend), `breakout_level` (the broken 20-day high/low), `breakout_decisiveness` (`|close − level| / ATR14`), `volume_surge` (today vs 20-day avg volume), and `atr_pct` (`ATR14 / close × 100`). Gated to **with-trend continuation** (up-breaks above SMA50, down-breaks below). These feed the forthcoming Inflection strategy (a directional credit spread anchored at the breakout level); nothing reads them yet, so this phase is purely additive. Validated offline: top-quintile breakouts let a credit spread placed ~0.5–1 ATR beyond the level expire OTM ~84–90% of the time. See `docs/formulas.md#breakout-signals`.

## [0.32.97] — 2026-06-13

### Changed
- **Realistic option fill modeling (slippage haircut)** — credits/debits are no longer priced at the optimistic mid. A new shared `fillPrice()` (`options-fill.ts`) models a leg's fill toward the disadvantageous side: sells fill below mid (toward the bid), buys above mid (toward the ask), by `SLIPPAGE_FRACTION` (0.5) × the half-spread. Applied to Strategy Lab `buildSetup` net credit/debit (incl. PMCC/calendar net debit) and to wheel/income premium in `analysis-service.ts`. **Wheel & income previously used `premium = mid/2`** — an indefensible flat 50% haircut; they now use the realistic fill (premiums rise toward accurate, which shifts their scoring rankings and the values captured in `options_premium_history`). The Strategy Lab previously used raw mid (optimistic); its credits now drop slightly. The effect is largest where liquidity is worst — exactly where it should be. See `docs/formulas.md#fill-model`.
- **Liquidity score now counts same-day volume** — the Strategy Lab `liquidityScore` (0–15) is rebalanced to spread 8 / open interest 4 / **volume 3**, and the wheel `optionLiquidityScore` (0–10) to OI 4 / spread 4 / **volume 2**. A high-OI/zero-volume strike (stale interest that won't fill well) no longer scores as fully liquid; an actively-traded low-OI strike is credited. `SetupLeg` gains a `volume` field. See `docs/formulas.md#liquidity-score`.

## [0.32.96] — 2026-06-13

### Added
- **Strategy Lab: PMCC & calendar second-expiration construction** — the lab now fetches a second far-dated chain (~120 DTE) so the four two-expiration structures (Poor Man's Covered Call/Put, Call/Put Calendar) build real legs instead of returning `unavailableReason: 'Requires two expirations'`. The long leg is drawn from the far chain, the short leg from the near chain. Max profit (which has no closed form for diagonals/calendars) is computed by valuing the long leg's residual time value at the short leg's expiry via Black-Scholes (`bsPrice`), assuming the underlying pins the short strike. This gives buy/bullish a defined-risk, B-grade-capable structure in high-IV regimes where single-leg debits grade C/F. One extra E*Trade `getOptionsChain` call per ticker in `validate()` (graceful: those strategies stay unavailable if no suitable far expiration exists). See `docs/formulas.md#calendar-diagonal-pnl`.

### Changed
- **Black-Scholes extracted to a shared util** (`src/main/services/black-scholes.ts`, exports `bsPrice` / `normCdf` / `RISK_FREE_RATE`); `collared-leaps-service.ts` and the new Strategy Lab calendar/PMCC math both use it (was duplicated).

## [0.32.95] — 2026-06-13

### Added
- **Brief Replay: premium-history readiness banner** — an in-app check that surfaces in the Brief Replay view once enough `options_premium_history` has accumulated to compute real income/wheel ROC. `BriefReplayService.getPremiumHistoryReadiness()` (IPC `replay:premium-history-readiness`) reports total rows, distinct days, date range, and **matured** days (entries older than ~45 days, so the recommended option would have expired). While accumulating it shows a muted progress note (`N/40 matured days`); once ≥40 matured days exist it shows a green "ready — ask Claude to build the ROC view" prompt. Renders nothing when the table is empty, so it stays invisible until the new daily capture job (v0.32.94) has run for a while.

## [0.32.94] — 2026-06-13

### Added
- **Daily Options Premium History job + table** — a new batch job (`daily-options-premium-history`, registered last in the sequence) and table (`options_premium_history`, migration 040) that captures a durable, query-friendly daily time series of the recommended option structure (strike, expiry, premium, delta, bid/ask, IV, annualized return) per ticker for **premium-based strategies**. Wheel CSP rows are reused from the same-day wheel snapshot (`analysis_snapshots`) so no extra E*Trade calls are made; income CSP/CC rows are fetched live via `analyzeTicker('options_income')` — the previously-missing data. One row per `(as_of_date, ticker, strategy)`, **never pruned**. This closes the gap where income/wheel premium had no durable history: a year from now this enables **true return-on-capital** analysis (and real income/wheel ROC in Brief Replay, replacing the stayed-above-strike proxy). Configurable via `config_json` (`callDelayMs`, `maxTickers`, `captureWheel`, `captureIncome`). No startup run; driven by the orchestrator or manual trigger.

## [0.32.93] — 2026-06-13

### Added
- **Bearish composite quality gate (≥70)** — bearish picks now require a composite score ≥70 to surface in the daily brief and Brief Replay (`minCompositeForStrategy()` in `scoring-service.ts`; applied at the Stage-4 pool filter in `daily-intelligence-brief-job.ts` and at replay pick selection in `brief-replay-service.ts`). Full-year replay (2025-05 → 2026-06, 1,300 bearish picks) shows sub-70 picks have ~0 alpha vs SPY and lose money in aggregate (short P&L −1.8%, win 46%), while ≥70 picks underperform SPY by ~3.3% — a real short edge (short P&L +1.0%, win 56%). The gate is rank-agnostic (a rank-2/3 pick clearing 70 is kept; a top-ranked pick below 70 is dropped) and self-suppresses bearish on weak days (~42% of dates yield zero ≥70 picks). Other strategies are ungated.

### Removed
- **Brief Replay: SPY regime risk gate / ⚠ badge (reverted from 0.32.90)** — the regime badge in the summary and picks tables (and `ReplaySummary.regimeRiskDates` / `ReplayPickRow.spyRegime`) is removed. Its "bearish HR ~25% in bullish regime vs ~79% in bearish regime" basis was a 5-month small-sample artifact; the full-year replay *inverts* it — gating bearish to bear-regime dates (SPY below its 50-day SMA at entry) actually performed worse (short P&L −6.7%, win 38%), because below-SMA dips kept V-bouncing and squeezing shorts. Replaced by the composite quality gate above. `computeSpyRegimes()` is retained solely for the descriptive Regime chart tab (no longer drives any filter or badge).

## [0.32.92] — 2026-06-13

### Added
- **Brief Replay: performance charts modal** — a "Charts" button appears after a replay run. Clicking it opens a full-screen modal with five tabs: Performance (avg 21d return + hit rate per strategy), Regime (bull vs bear SPY regime split), Monthly (HR21d line chart), Score Signal (score quintile → return chart exposing the anti-predictive scoring pattern, plus rank-order chart), and Tickers (top/worst tickers per strategy with at least 4 appearances). All aggregations are computed server-side in `BriefReplayService.getChartData()` using `computeSpyRegimes()` for regime splits. Bearish strategy HR/sorting is direction-aware (stock down = win). Charts use Recharts (existing dependency).

## [0.32.91] — 2026-06-13

### Fixed
- **Daily Brief: $5 price floor for briefing candidates** — the screener candidate SQL in `BriefingService` now filters `lastPrice >= 5`, preventing sub-$5 penny stocks (e.g. NWL at $4.92) from appearing in income/wheel/buy picks. The same screener data already had this filter in Brief Replay (replay job enforced it) but the live briefing query did not.

### Added
- **Critic: `high_vol_naked_structure` rule** — fires `warning` when the income strategy selects a `short-straddle` or `short-strangle` (unlimited-risk structures) for a stock whose 1Y price return exceeds 100%. High directional momentum contradicts the range-bound thesis required for straddles/strangles; rule recommends a defined-risk alternative (iron condor or iron fly).
- **Critic: `thin_breakeven` rule** — fires `warning` when income or wheel strategy has a breakeven buffer below 2%. Computed the same way as the LLM context: `|netCredit| / price` (per-contract ÷ per-share = %). A thin buffer means a small adverse move wipes the premium entirely.

## [0.32.90] — 2026-06-12

### Added
- **Brief Replay: SPY regime risk gate for bearish picks** — `BriefReplayService.computeSpyRegimes()` checks whether SPY closed above its 50-day SMA on each replay date. Bearish picks on bullish-regime dates are flagged with a ⚠ badge in the picks table (tooltip: "SPY above 50-day SMA — bullish regime reduces bearish win rate"). The hit-rate summary table shows a "⚠ N/Total regime risk" count on the bearish row (e.g. "⚠ 76/98 regime risk"), derived from replay data showing bearish HR averages ~25% in bullish regimes vs ~79% in bearish regimes. No schema change — computed at query time from existing `historical_prices` SPY bars.

## [0.32.89] — 2026-06-12

### Added
- **Brief Replay** — new Intelligence section screen that back-tests the 5-strategy scoring pipeline against historical dates. Pick a date range, hit Run, and the pipeline scores every NYSE trading day in the window using point-in-time price/IV data and current fundamentals. Produces a hit-rate summary table (5d/10d/21d) per strategy and a drillable picks detail table with entry price, forward returns, and max drawdown. No E*Trade options chains (Option A liquidity proxy: avgVolume ≥ 1 M + price ≥ $5). New tables: `replay_briefs`, `replay_outcomes` (migration 038). Cancellable in-progress runs; data cleared and re-populated on each Run.

## [0.32.88] — 2026-06-12

### Added
- **Daily Brief: 🔍 Analysis and 🏦 E*Trade quick-nav buttons** on every pick card, next to Payoff/Validate/Options. Analysis navigates to the Analysis view pre-loaded with the ticker; E*Trade opens the ticker's quote page (`us.etrade.com/e/t/invest/quotesandresearch?content=3&sym={ticker}`) in the system browser — same deep-link the Opportunity screen uses.
- **Brief email: ticker symbols are now E*Trade links** — each ticker in the per-strategy tables links to its E*Trade quote page, so you can jump from the morning email straight to the order screen.

## [0.32.87] — 2026-06-12

### Fixed
- **ORCL fake net-cash: stale EDGAR concepts no longer serve as current data** — Oracle's only `LongTermDebt` entry in us-gaap is a $0 value from FY2022 (its real ~$90B of debt lives in dimensioned per-instrument contexts that `companyfacts['us-gaap']` doesn't aggregate). The provider served that 4-year-old zero as "current debt" against $38B of current cash → `netDebtToEbitda` −1.37. New `conceptIsStale()` guard: any concept whose newest entry (any form) is older than 540 days is skipped during concept selection — active filers always have an entry within ~120 days, so this only rejects abandoned tags. ORCL's debt now correctly resolves to null (no fake numbers). Also applied to the composite D&A base. T/VZ/MO verified unaffected (current concepts).
- **Banks no longer spuriously pass the leverage value-score criterion** — `netDebtToEbitda` is now null for the financial sector (same detection as the existing D/E exemption): EBITDA is meaningless for banks, and their cash positions produced absurd negatives (RF: −176) that passed `passLte(≤3)` and inflated valueScore/growthScore. Also nulled when |ratio| > 50 (near-zero EBITDA denominators — observed 252, 909). Legitimate negatives for true net-cash companies are kept.
- **docs/formulas.md `#quality-signals` anchor now exists** — code comments referenced it but the section was never written; added with the FCF/NI, ROIC, and NetDebtToEBITDA formulas and null conditions.

## [0.32.86] — 2026-06-11

### Fixed
- **netDebtToEbitda null for 373/1,002 tickers — composite D&A fallback** — modern filers (MSFT, GOOGL, ORCL) no longer tag a combined D&A concept in us-gaap: they tag `Depreciation` (PP&E only) and amortization parts separately, with the combined cash-flow line often in a company extension namespace invisible to `facts['us-gaap']`. New `compositeEntries()` sums `Depreciation` + `AmortizationOfIntangibleAssets` + `FinanceLeaseRightOfUseAssetAmortization` per exact reporting period (each component deduped per period first so comparative re-reports can't double-count), producing a synthetic entry list that flows through the normal `annualSeries`/`ttmPair` machinery. Selection keeps the most-recent-annual-wins rule: the composite replaces a combined concept only when its annual series is strictly more recent — covering both "no combined concept at all" and "combined concept abandoned years ago". Base-only periods are acceptable: understating D&A overstates net-debt-to-EBITDA, the conservative direction for a leverage-risk signal. Validated against live filings: MSFT D&A $31.4B, GOOGL $21.7B, ORCL $6.2B. Banks/energy nulls (no `OperatingIncomeLoss`) are structural and remain null by design.

## [0.32.85] — 2026-06-11

### Fixed
- **Brief rationales: max_tokens sized for the real request volume** — stage 5 requests rationales for all stage-4 candidates (up to 15 per strategy = 75, not the final 25), because the liquidity gate runs later at assembly. The v0.32.81 cap of 4096 still truncated: the first live run salvaged 38/75 and the income/buy strategies (last in the array) got zero rationales. Raised to 16384 (~7K actually needed). The v0.32.81 salvage + `runMeta.aiError` visibility is what made this immediately diagnosable from run history.

## [0.32.84] — 2026-06-11

### Added
- **Dividend yield wired (was 100% null)** — `getFundamentals()` now also queries Polygon `/v3/reference/dividends` (included in the Stocks Starter plan): trailing yield = sum of regular cash dividends with ex-date in the last 365 days / current price × 100. Special dividends (`dividend_type='SC'`) are excluded so one-off payouts don't inflate the yield the wheel/income scoring sees. 0 = confirmed non-payer; null only when the fetch fails. see docs/formulas.md#dividend-yield
- **Beta wired (was 100% null)** — new `BetaService` computes 1-year daily beta vs SPY from local `historical_prices` (1,046/1,067 tickers have ≥250 bars; zero API cost): cov/var over date-joined returns, `adjusted_close` preferred, null under 200 overlapping observations. Injected into `PolygonDataProvider` as an optional callback. see docs/formulas.md#beta

## [0.32.83] — 2026-06-11

### Changed
- **EDGAR fundamentals: true TTM from 10-Q roll-forward** — slot-0 income/cash-flow values were the last 10-K, which is up to ~11 months stale for companies early in their fiscal year (MSFT's FY ends in June; its "TTM" revenue was from June 2025 while P/E used today's price). New `ttmPair()` implements the standard XBRL roll-forward: TTM = FY + YTD(current 10-Qs) − YTD(prior year same period). The prior-year TTM (YoY denominator) rolls the same way using the two-years-back comparative. TTM mode engages only when the full quarterly chain exists; otherwise both values fall back to consistent fiscal years — a TTM numerator over an FY denominator would misstate YoY growth by the stub-period difference. Verified live: MSFT TTM revenue now $318.3B through 2026-03-31 (was $282B through 2025-06-30), NI $125.2B (was $102B). 5Y CAGR keeps its annual base.

## [0.32.82] — 2026-06-11

### Fixed
- **Earnings blind spot: "no earnings data" no longer reads as "no earnings risk"** — ~11% of the universe (119/1,068 tickers) has no future row in `earnings_calendar` (Finnhub bulk-fill gaps; DELL was picked tonight while invisible to the earnings check). Three changes: (1) the brief job now runs a per-pick E*Trade earnings fallback for the ~25 final pick tickers before the critic stage — `refreshTickers` smart-skips tickers that already have valid future dates, so this is typically only a handful of API calls; result recorded in `runMeta.earningsFallback`. (2) The critic's rule check now distinguishes "known clear" from "no data": a pick with an options structure but no future earnings row gets an info-severity `earnings_unknown` flag telling the trader to verify the report date manually. (3) The critic's AI context gains `earningsKnown` so the LLM treats missing calendar data as unverified risk rather than absence of risk.

## [0.32.81] — 2026-06-11

### Fixed
- **Daily brief: all 25 AI rationales were dropped silently** — Stage 5 asks for 25 pick rationales in one call with `max_tokens: 2048`, but 25 × ~90 tokens needs ~2.3K+. The response truncated mid-JSON, the `\[[\s\S]*\]` extraction regex found no closing bracket, and every `aiRationale` stayed null while the ~$0.07 API spend was still incurred — with no error recorded. Fixes: (1) `max_tokens` raised to 4096; (2) new `parseRationaleResponse()` (own module, unit-tested) salvages every complete object from a truncated array instead of all-or-nothing regex matching; (3) `stop_reason === 'max_tokens'` and zero-parse outcomes are now recorded in `runMeta.aiError` so partial/failed synthesis is visible in the run history instead of silent.

## [0.32.80] — 2026-06-11

### Fixed
- **EDGAR 5Y CAGR was computed from a 2-years-ago base, not 5** — every 10-K re-reports the two prior fiscal years as comparatives, so the raw 10-K entry list contains each year 2–3 times (FY25, FY24, FY24, FY23, FY23, FY23…). The provider indexed this list as if entry N were N years back, landing the "5 years ago" slot on FY-2. Result: `revenueGrowth5Y`/`epsGrowth5Y` systematically understated for every steady grower (AAPL: computed 1.66% vs true 8.68%), which suppressed the `earningsGrowth`, `revenueGrowth5Y`, and `epsGrowth5Y` signals in the bullish/buy strategies plus valueScore/growthScore/stockGrade universe-wide. Fix: new `annualSeries()` dedupes by period end (most recently filed wins, so restatements are honored) and drops non-annual durations (<300 or >400 days) that some filers tag inside 10-Ks. `EdgarEntry` now captures `start` to enable the duration check.
- **5Y CAGR no longer silently degrades to a 3–4 year base** — the old fallback computed a "5Y" CAGR from whatever history existed. Now companies with fewer than 6 deduped annuals get null, which the scoring engine correctly treats as a missing signal and reweights.

## [0.32.79] — 2026-06-11

### Changed
- **Fundamentals now sourced from SEC EDGAR instead of Polygon** — Polygon `/vX/reference/financials` requires a Developer plan ($199/mo); the current Stocks Starter plan returns 403. Replaced with the free SEC EDGAR XBRL API (`data.sec.gov`), which requires no API key and exposes the same financial data via US-GAAP concept tags.
- **CapEx now included in FCF calculation** — EDGAR exposes CapEx (`PaymentsToAcquirePropertyPlantAndEquipment`), which Polygon never reliably provided. Added `capital_expenditures` to `PolygonFinancials.cash_flow_statement` so `computeRatios()` can compute proper FCF = Operating CF − |CapEx| instead of using Operating CF alone.
- **Removed Polygon plan-restriction workaround** — the `fundamentalsPlanRestricted` flag and 403 branch in `screener-service.syncUniverse()` have been removed. EDGAR does not have plan tiers.

### Implementation notes
- New `src/main/services/sec-edgar-provider.ts`: `resolveEdgarCik()` (ticker → CIK, cached per process), `getEdgarFundamentals()` (companyfacts fetch → `PolygonFinancials`). Concept selection uses "most-recent annual date wins" heuristic to handle ASC-606-style transitions (e.g. Apple: `Revenues` → `RevenueFromContractWithCustomer…` in 2019).
- Filing array layout: 20 slots (so `sumFiveYearAgoTtm()` length check passes). Real data at slots 0 (current annual), 4 (prior year), 16 (5-years-ago). All other slots hold an empty placeholder so `sumTtm()` skips them gracefully.
- Balance sheet at slot 0 uses the most-recent entry regardless of form (10-Q preferred over 10-K for currency).
- `EDGAR_HEADERS`, `resolveEdgarCik`, `pickEdgarLatest`, `EDGAR_FIELD_SPECS`, and `EdgarEntry` are exported from `sec-edgar-provider.ts` and imported by `ipc-test-api.ts` (no duplication).

## [0.32.78] — 2026-06-11

### Fixed
- **EDGAR test: concept selection picks most-recent data, not first-found** — when a company has multiple matching US-GAAP concepts (e.g. Apple has both `Revenues` with 2018 data and `RevenueFromContractWithCustomerExcludingAssessedTax` with current data), the old code returned the first one that had any entries, giving stale 2018 revenue. Fix: collect all matching candidates and pick the one with the most recent 10-K filing date.

## [0.32.77] — 2026-06-11

### Added
- **Test API — SEC EDGAR tab** — new tab in Test API screen for validating the SEC EDGAR XBRL data source before full provider implementation. Enter any ticker to: (1) resolve CIK via `company_tickers.json` (cached for the session); (2) fetch `companyfacts/{CIK}.json`; (3) check all 11 US-GAAP concepts that `computeRatios()` needs (revenue, net income, operating income, D&A, stockholders' equity, current assets/liabilities, long-term debt, cash, operating CF, CapEx). Results show per-field found/not-found, concept name used, latest annual (10-K) and quarterly (10-Q) values with dates, and filing counts. Concept browser shows all available GAAP concepts, highlighting the ones in use. No API key required; SEC rate limit is 10 req/s.

## [0.32.76] — 2026-06-11

### Fixed
- **Market sync: Polygon fundamentals plan restriction (403) is now visible, not silent** — `/vX/reference/financials` requires a Polygon Developer plan or higher; the Stocks Starter plan (currently in use) returns 403. Previously v0.32.75 silently skipped the 403 per-ticker, which meant fundamentals data was quietly missing with no indication in the job history. New behaviour: on the first 403 from the fundamentals endpoint the flag `fundamentalsPlanRestricted` is set, all subsequent tickers skip the fundamentals call (avoiding ~1000 redundant 403 round-trips), and the job completes with status `success` but with a note: "Fundamentals skipped — /vX/reference/financials requires a Polygon Developer plan or higher (current plan: Stocks Starter)." Quotes still sync normally. The note is visible in Batch Jobs → run history.
- **Root cause of "why only with the orchestrator"** — the fundamentals cache TTL is 24 hours (`TTL_SECONDS.FUNDAMENTALS = 86_400`). All prior manual runs happened within 24 hours of each other, so `isStale()` always returned false and `getFundamentals()` was never called. The orchestrator's strict daily schedule is the first code path that reliably runs with a stale cache, triggering the live Polygon call and exposing the plan restriction.

## [0.32.75] — 2026-06-11

### Fixed
- **Market sync: false "Invalid Polygon API Key" abort on 403 plan-restriction responses** — Polygon returns 403 (not 401) for plan-tier restrictions, and their 403 body frequently contains the phrase "apiKey" (e.g. "your apiKey plan does not include this endpoint"). The screener's `includes('api key')` check matched this and aborted the entire sync with a misleading "Invalid or missing Polygon API Key" error even though the key was perfectly valid. Fix: only hard-abort on a genuine HTTP 401 (`'Polygon HTTP 401'`); 403 plan-restriction errors now silently skip that ticker, matching the existing behaviour for other per-ticker failures.
- **Polygon provider: 4xx auth/plan errors were retried unnecessarily** — `fetchWithRetry` retried all non-ok responses including 401 and 403. These will never recover on retry. Fix: only retry 429 (rate limit) and 5xx (server errors), matching the comment that was already in the code.

## [0.32.74] — 2026-06-11

### Fixed
- **Orchestrator: second daily slot re-runs all jobs instead of skipping everything** — the previous skip rule (`lastSuccessDate === today`) caused the 16:30 slot to skip all 10 jobs because the 10:15 slot had already marked them as "succeeded today". Replaced with a 90-minute time window: a job is skipped only if its last successful run completed within the past 90 minutes. This means a resume (re-trigger minutes after a failure) still skips the already-done jobs, while a second scheduled slot hours later re-runs everything. Skip log message now shows how long ago the job ran (e.g. "skipped (succeeded 12m ago)").

## [0.32.73] — 2026-06-11

### Fixed
- **Orchestrator: false "token invalid" on active E*Trade sessions** — the orchestrator was calling `renewAccessToken()` as the validity check, but E*Trade rejects that call when the token is active (recently used, non-dormant). This caused the orchestrator to abort with "E*Trade token invalid — renewal failed" even though Settings showed "✓ Connected". Fix: use the same date-stamp check that `checkConnection` (Settings page) uses — if `etradeTokenDate` matches today's ET date the token is valid. `renewAccessToken()` is now called as a best-effort wakeup for dormant tokens only; a failure on an active token is silently ignored.

## [0.32.72] — 2026-06-11

### Fixed
- **Orchestrator Edit modal: schedule slots now editable** — replaced the "use raw config editor" note with a full slot manager: list current slots with remove (✕) buttons, add new slots via HH:MM input (Enter or + Add), auto-sorted, duplicate/format validation. The Schedule column in the jobs table now shows the orchestrator's actual `scheduleSlots` instead of the unused `dailyScheduleTime` fallback.

## [0.32.71] — 2026-06-11

### Added
- **Batch Orchestrator** — new `BatchOrchestratorJob` (`batch-orchestrator`, sequence position 1) is the single scheduled job that drives all others. Features: non-trading day guard (scheduled runs only), E*Trade token renewal check, consolidated start email (token status + resume state + outcome), stop-on-first-failure, natural resume via per-job `last_success_date`, multi-slot scheduling (`config_json.scheduleSlots` — each slot fires at most once per day). Sub-jobs are called via `BatchService.runJobDirect()` so their full run history is preserved. "Run All in Sequence" button excludes the orchestrator. Custom orchestrator config modal in Batch Jobs view: job enable/disable list (in sequence order), validateEtradeToken + emailOnStart toggles.
- **Remote trigger** — `POST /api/v1/orchestrator/run` + `GET /api/v1/orchestrator/status` routes (X-Agent-Token auth) allow triggering and polling from Termius / Claude Code CLI when away from home.
- **Trigger context in run history** — `batch_runs.trigger` (`manual|schedule|startup`) and `batch_runs.slot_time` are recorded on every run. Batch Jobs view shows a Trigger column in run history.
- **Migration 037** — shifts all `batch_jobs.sequence_order` +1 to reserve position 1 for the orchestrator; adds `trigger` and `slot_time` columns to `batch_runs`.

## [0.32.70] — 2026-06-10

### Changed
- **Brief Stage-4 pool deepened 10 → 15 per strategy** — the liquidity gate now correctly rejects thin chains (v0.32.69), which left wheel with 4 picks and income with 3. A deeper validation pool gives the gate more candidates so each strategy can still fill 5 picks. Worst-case E*Trade cap rises to 75 unique tickers/run (typically far fewer due to cross-strategy overlap).

## [0.32.69] — 2026-06-10

### Fixed
- **Strategy Lab: stale E*Trade Greeks no longer poison structures** — E*Trade serves months-old deltas on thin (OI=0) chains while option *prices* stay correct (2026-06-10 brief: WSO chain claimed delta −0.50 at $450 with spot at $375.66 → wheel put built 11.8% ITM; AWI income straddle struck 31% above spot *passed* the critic; MIDD, ALGM also affected — 4 of 25 picks). The lab estimated the underlying from those deltas. Now: underlying price comes from `chain.underlyingPrice` (E*Trade's real-time spot, was always available but unused) → live Polygon quote → chain-delta estimate as last resort. When the delta-implied ATM deviates >8% from real spot, chain deltas are distrusted and leg selection uses moneyness.
- **Critic prompt: `strikeOtmPct` defined side-aware** — the "positive = OTM" gloss is wrong for puts; it made the LLM read AWI's broken +31% straddle as "safely OTM". Now defined as strike-vs-spot with explicit per-side ITM/OTM semantics.

### Added
- **Critic rule: `stale_lab_price`** (warning) — fires when the lab's underlying price deviates >5% from the live pick price; deterministic catch-all for structure-data integrity regardless of LLM judgment.

## [0.32.68] — 2026-06-10

### Changed
- **Batch Jobs screen: stable three-panel layout** — all three panels now have fixed heights (Registered Jobs 300px, Run History ~4 rows, Live Activity log 200px) so nothing shifts or "dances" while a job runs. The Live Activity panel is permanently visible (placeholder when idle) and the log is no longer auto-cleared 3s after a run — it persists until the next run starts, so failures can be inspected. Added ⧉ Copy (clipboard) and ✕ Clear buttons. Auto-scroll now scrolls only the log's own scrollbar; previously `scrollIntoView` yanked the entire page down on every progress event, pushing the jobs grid out of view.

## [0.32.67] — 2026-06-10

### Fixed
- **`annualizedReturn` 100× unit bug** — per-share premium was divided by per-contract collateral (`strike × 100`), understating annualized options return 100×. This zeroed the wheel `premiumYield` (wt 19) and income `premiumRiskRatio` (wt 22) scoring signals for every ticker — both strategies effectively ranked without their premium signal, letting earnings-pumped high-IVR names float to rank 1. Values self-correct on the next analysis snapshot refresh.
- **`GRADE_RANK` missing `'A+'`** — an A+ structure ranked 0 (below F); a pick whose only available structures were A+ and F would incorrectly fire `poor_structure_grade`.
- **Critic liquidity flag now reads the chosen structure** — previously it reported the *best* liquidity across relevant structures while the LLM context showed the *chosen* structure's, producing contradictory numbers in the same prompt (observed: HAYW flagged 5/15, context said 3/15 — the LLM called out the discrepancy).

### Changed
- **Earnings penalty extended to wheel + bearish** — the −20 composite penalty for earnings within 45 days (previously income-only) now applies to all short-premium strategies. 3 of 5 wheel picks on 2026-06-10 carried confirmed earnings inside the expiry window.
- **Critic calibration: info flags are advisory** — prompt now states a pick whose only flags are info-severity can still merit `pass`; `low_liquidity` threshold lowered from <6 to <4 (4–6 is normal for single-name large caps).
- **Buy strategy is stock-first** — when no buy-relevant structure grades B or better (systematic in high-IV regimes, where all debit structures grade C/F), the pick is presented as a plain stock purchase: `📈 Buy Shares` chip in the brief view, structure demoted to "Optional", `poor_structure_grade` suppressed, and the critic LLM told to evaluate the stock thesis.

### Added
- **Critic rule: bearish SPY mirror** — bearish picks now get an info flag when SPY is above its 200-day MA (the bullish/buy macro-headwind check already existed; the mirror didn't).
- **Critic rule: `counter_trend_itm_strike`** — warning when a bearish short strike sits at/below the current price (zero cushion) while SPY trends up. 3 of 5 bearish picks on 2026-06-10 had ATM/ITM short strikes on a bullish tape.

## [0.32.66] — 2026-06-10

### Added
- **Brief Trend: total Return $ in summary bar** — sum of dollar returns across all rated picks shown next to avg return.

## [0.32.65] — 2026-06-10

### Added
- **Brief Trend: Return $ column** — shows dollar return (latest available price − brief price) alongside Return %. Uses the same colour coding as Return %. Sortable.

## [0.32.64] — 2026-06-10

### Added
- **Brief Trend: all columns sortable** — click any column header to sort ascending; click again to flip to descending. Active column shows ▲/▼; inactive columns show a faint ⇅. Nulls always sort last. Sort resets when changing the brief date or strategy filter.

## [0.32.63] — 2026-06-10

### Fixed
- **Portfolio sync now captures all legs of multi-leg strategies** — long option legs (e.g. the long call in a jade/big lizard) were silently skipped during E*Trade sync. Added `'Long Put'` and `'Long Call'` position types; upsertPosition now maps LONG CALL → `Long Call` and LONG PUT → `Long Put` instead of dropping them. Greeks for long positions use natural (un-negated) chain values. Migration 036 expands the `position_type` CHECK constraint via table recreation.

## [0.32.62] — 2026-06-09

### Fixed
- **Paper trades: stale picks from multi-run days now replaced, not accumulated** — each time the brief runs on the same date, `autoCapture` now deletes all existing open picks for that strategy/date before inserting the current run's picks. Previously, picks from earlier runs (e.g. debugging iterations) were permanently retained alongside the final run's picks via the `ON CONFLICT DO UPDATE` upsert that only updated matching tickers and couldn't remove ones that were dropped. Result: income could accumulate 13 picks across 7 runs when only 5 are correct.
- **Historical cleanup on next brief run** — `cleanupStalePicksAllDates()` is called once at the start of each Stage 6. Uses `json_each(picks)` to compare open paper trades against the latest brief for each date/strategy, and deletes any ticker not present in that final run. Removes stale picks from all past dates on the next brief generation (61 stale picks identified across June 3, 5, 8, 9 from dev/debugging runs).

## [0.32.61] — 2026-06-09

### Fixed
- **Critic context mismatch: structures with `unavailableReason` excluded from LLM context** — `synthesizeVerdict` was selecting the first structure where `setup != null`, but an unavailable structure (e.g. PMCC requiring two expirations) has a non-null `setup` object with `unavailableReason` set. The LLM was seeing grade-F ghost data (no legs, no credit, no strike) instead of the actual gate-passing structure. Fixed in both `synthesizeVerdict` and `getStructureExpiry` to require `!s.setup.unavailableReason`.
- **Critic prompt: LLM never gave `pass` verdict** — system prompt framing ("your job is to find problems") and the mandatory second sentence ("what should the user check") structurally biased the LLM to give `caution` even for clean picks. Updated prompt with explicit verdict calibration definitions, allows 1–2 sentences, and instructs "do not default to caution."

### Added
- **`checkStructureGrade` critic rule** — fires `warning` when every valid structure for the strategy is grade F. Catches picks like VRT (all buy structures grade F) via a deterministic rule rather than relying solely on LLM analysis. Severity `warning` → forces `flag` verdict and surfaces as an explicit rule flag in the UI.

## [0.32.60] — 2026-06-09

### Fixed
- **`breakevenDistancePct` formula was 100× too high** — `netCredit` is stored per-contract (×100 shares) but the formula was also multiplying by 100, causing every income pick to show e.g. 760% instead of 7.6%. Fixed by removing the `* 100` (dividing per-contract credit by per-share price already yields a percentage). Added formula documentation to `docs/formulas.md#breakeven-distance`.
- **`low_liquidity` critic rule inflating flag count** — severity was `'warning'` for picks at liqScore=5/15 (the gate minimum), which forced verdict to `flag` even when the LLM was unavailable. Downgraded to `'info'` so borderline-liquid picks that passed the gate become `caution` rather than false positives.
- **Grade-F structures passing the liquidity gate** — picks where the Strategy Lab ran but all relevant structures had `unavailableReason` set (e.g. PMCC requiring two expirations) were passing `hasAdequateLiquidity()` via the `best === null → true` fallback. Fixed: now only passes when `labResult` is `null` (validation failed entirely); a lab result with no valid structure returns `false`.

### Changed
- **Critic LLM batching: 25 concurrent → 5×5 serial** — AI critic calls were all fired in parallel across all 25 picks, causing ~50% LLM failure (rate limiting). Now runs one strategy's picks (≤5) in parallel, then the next strategy. Drastically reduces rate-limit failures while still completing all 5 strategies in sequence.
- **Income scoring: −20 penalty for earnings within 45 days** — income candidates (strangles, condors) with an earnings event in the next 45 days are penalised −20 composite points before the liquidity gate. Replaces the current pattern of scoring them highly and then flagging them via the critic; keeps them out of the top 5 unless no clean alternatives exist. Configurable via `loadIncomeEarningsPenalty()` in the brief job.

## [0.32.59] — 2026-06-09

### Fixed
- **Brief funnel log: distinguish liq-failed vs outranked** — the previous log conflated two different exclusion reasons under "gated": tickers that failed the liquidity gate (liq < 5) and tickers that passed the gate but were cut by the 5-pick output cap. Log now shows `liq-failed: FWONA(3/15), CSX(3/15)` separately from `outranked: MSFT(9/15), MPC(11/15)`. `totalGated` now only counts true gate failures, not cap-cuts.

## [0.32.58] — 2026-06-09

### Changed
- **Brief: pre-gate pool widened from 5 → 10 per strategy** — each strategy now sends its top 10 scored candidates to E*Trade validation (was top 5). Post-gate output is still capped at 5 picks per strategy. Gives the liquidity gate more candidates to work with — especially for income, which frequently loses 3+ picks to the gate in low-VIX trending markets. `STAGE_4_CAP` updated from 25 → 50 unique tickers.
- **Brief: $750 price cap** — stocks priced above $750 are excluded from all brief picks before Stage 4 validation. Avoids options with very large notional size (e.g. FIX at $1,860, COST at $935). Applied after scoring so high-priced stocks still contribute to relative-strength benchmarks. Configurable via `MAX_PICK_PRICE` constant in `daily-intelligence-brief-job.ts`.

## [0.32.57] — 2026-06-09

### Changed
- **Brief funnel log: show liquidity score for each gated ticker** — log now reads e.g. `income: 5 pre-gate → 2 final (gated: CSX(liq=4/15), FWONA(liq=2/15), OGE(liq=1/15))`. Extracted `getBestLiquidityScore()` helper; `hasAdequateLiquidity()` delegates to it. No behavior change.

## [0.32.56] — 2026-06-09

### Fixed
- **`sectorMomentum` signal: ~50% null rate fixed** — `SECTOR_ETF` used GICS sector names ("Technology") but Polygon stores lowercase SIC descriptions ("electronic computers", "semiconductors & related devices"). Added `sectorStringToEtf()` keyword-matching fallback that maps Polygon SIC descriptions to SPDR sector ETFs. Coverage goes from ~0% (only GICS exact matches) to ~58% of tickers in `fundamentals_cache`. Affects `sectorMomentum` (bullish/buy) and `sectorWeakness` (bearish) signals.
- **`leverageQuality` signal: always-null fixed for wheel/bearish** — `netDebtToEbitda` has only ~9% coverage in Polygon fundamentals. Falls back to `debtToEquity * 2.5` as an approximation (D/E 1.0 ≈ ND/EBITDA 2.5) when ND/EBITDA is null. Raises signal coverage from 9% to ~30% for wheel and bearish strategies.

### Added
- **Daily brief funnel logging** — `[brief funnel]` console log per strategy at the liquidity gate showing pre-gate count, post-gate count, and names of gated tickers. Diagnostic only — no behavior change. Helps distinguish liquidity-gate scarcity from genuine candidate scarcity.
- **Score badge tooltip in Daily Brief** — hovering the composite score badge shows "Scores are strategy-specific — not comparable across strategies" to prevent cross-strategy score misinterpretation.

## [0.32.55] — 2026-06-09

### Fixed
- **Critic: `strikeOtmPct` formula was inverted** — `(price - strike) / price` produces a negative value when the short strike is OTM (above current price for a call), directly contradicting the "positive = OTM" description sent in the LLM system prompt. Corrected to `(strike - price) / price`. This eliminates the ~3 false bullish flags (e.g. COHR, ALAB, MRVL) produced each brief run.

### Added
- **Critic rule: `data_anomaly_suspected`** — new `info`-severity rule flag emitted when `priceMomentumPct` exceeds 500%. Catches spinoff/reverse-merger tickers (e.g. SNDK after the WD spinoff) where the oldest available bar gives a nonsensical 1-year return, causing the pick to slip through as a false PASS when the LLM is unavailable.
- **Critic rule: `earnings_in_window`** — new `warning`-severity rule flag emitted when a known earnings date falls between today and the structure's expiry. Previously earnings were only passed as LLM context and disappeared when the LLM was rate-limited or unavailable. Now always present in `criticVerdict.flags` regardless of LLM status.

## [0.32.54] — 2026-06-09

### Added
- **Retrospect › Brief Trend: click ticker to view 45-day chart** — clicking any ticker in the grid opens a candlestick popup showing price from the brief date through a 45-calendar-day window (the typical options expiry horizon). Overlays: dashed blue horizontal line at the brief price, `Brief` arrowUp marker on the brief date bar, `D5` arrowDown marker on the Day-5 bar (when available). Click outside the card or press Escape to close. No new IPC — reuses `historical.getPrices`. Data is partial for recent briefs (shows what's available in `historical_prices` through today).

## [0.32.53] — 2026-06-09

### Fixed
- **Brief Trend: critic column blank for all brief dates except today** — two bugs combined: (1) when the Anthropic LLM call inside `synthesizeVerdict` threw (rate-limit, transient API error, expired E*Trade token), the catch block only logged a warning and left `criticVerdict = null` with no fallback. Now falls back to a rule-check-only verdict (`confidence: 'low'`) so the column is never blank. (2) `getBriefPickDrilldown` looked up critic data via `WHERE DATE(generated_at) = ?` (UTC date) against `paper_trades.brief_date` (ET date), which is fragile. Replaced with a `brief_id` join (`MAX(brief_id) … GROUP BY brief_strategy`) that uses the direct FK already stored in `paper_trades`.

## [0.32.52] — 2026-06-09

### Fixed
- **Price Gap Fill: today's close never loaded on the same evening** — the stale-ticker threshold was `MAX(date) < date('now', '-1 day')`, so a ticker whose latest bar was yesterday was considered "fresh" and skipped. Changed threshold to `date('now')` so any ticker missing today's date is fetched. Same fix applied to the reference-ticker freshness check. Reference tickers that exist but are missing today now use a `fromDate` override (3-day lookback) instead of refetching the full 1Y range.

## [0.32.51] — 2026-06-09

### Changed
- **Retrospect › Brief Trend: 5-day trading-day price columns** — replaces the single Day+5 Price column with five individual columns (Day 1 – Day 5) showing the closing price on each of the first 5 trading days after the brief date. Weekends and market holidays are skipped naturally because data comes directly from `historical_prices` (which only contains market-open days). Each cell shows the price when available or ⏳ while that day is still in the future. Return % always reflects brief price → most recent available day; Outcome updates progressively as each day populates. Data caps at Day 5 — no tracking beyond 5 business days.
- **Retrospect › Brief Trend: drop Entry Zone / In Zone columns** — removed the buy-strategy entry zone and in-zone check columns to reduce clutter.
- **Service**: `getBriefPickDrilldown` now queries `historical_prices` directly via ROW_NUMBER() partition instead of `paper_trade_snapshots`; entry-zone lookup removed. `BriefPickDetail` type updated accordingly (`day1-5Price`, `returnPct`, `latestVerdict` replacing old day5 fields).

## [0.32.50] — 2026-06-09

### Added
- **Retrospect: Brief Trend tab** — new tab next to History that lets you drill into any individual brief's picks and compare prediction vs Day+5 outcome. Select a brief date from the dropdown, optionally filter by strategy. Table columns: Ticker (hover = AI rationale), Strategy, Score, Brief Price, Entry Zone (buy strategy only, from nearest analysis snapshot), In Zone? (was brief-day price inside the zone), Day+5 Price with actual days elapsed, Return % colour-coded per strategy direction, Outcome emoji (✅/❌/➖/⏳), Critic verdict badge with critic rationale on hover. Summary bar at top shows hit count, rated pick count, and average Day+5 return. New service methods `getBriefDates()` + `getBriefPickDrilldown()` in `paper-trading-service.ts`; new IPC `paper:brief-dates` + `paper:brief-pick-drilldown`; new `BriefPickDetail` shared type.

## [0.32.49] — 2026-06-09

### Improved
- **Daily Brief banners: hover tooltips** — both header banners now show explanatory tooltips on hover. The B-01 label explains "Day+5 hit-rate" and colour thresholds; each strategy chip shows exact hit counts and avg return. The B-02 label explains "critic pass-rate", trend arrow direction, and colour thresholds; each strategy chip shows the current pass-rate, trend description, and a full per-date pass-rate history (oldest → newest).

## [0.32.48] — 2026-06-09

### Added
- **Daily Brief: critic health trend banner (B-02)** — a second slim bar appears in the brief header showing per-strategy critic pass-rate trend across the last 7 briefs (e.g. `wheel ↑55% · buy →42% · bullish ↓28%`). Trend direction is computed by comparing the older half vs newer half of pass rates (>8pp difference = improving ↑ / declining ↓, otherwise stable →). Colour-coded: green ≥60% / amber ≥40% / red <40%; arrow coloured green (improving) / red (declining) / amber (stable). Only shows when at least one strategy has enough critic data; silently absent otherwise. New `getBriefHealthTrend()` method in `scoring-service.ts` queries `daily_briefs`, deduplicates per calendar-date, parses `picks` JSON for `criticVerdict.verdict` counts. New IPC `scoring:brief-health-trend` + preload entry.

## [0.32.47] — 2026-06-09

### Improved
- **Conviction Alerts moved to My Stocks** — the ⚡ entry-zone alert strip now lives at the top of the My Stocks screen where it belongs, reusing the already-loaded stocks list (no extra API call). Each in-zone stock shows as a colour-coded chip (green = Buy Zone, yellow = Mid Zone) with ticker, zone badge, current price, IV, and IVR. Removed from Daily Brief where it was a detour.

## [0.32.46] — 2026-06-09

### Added
- **Daily Brief: prior-brief performance banner (B-01)** — a slim bar appears directly below the brief toolbar showing last brief's Day+5 hit-rate and average return per strategy (e.g. `wheel 3/5 +1.8% avg · buy 2/4 +3.2% avg`). Colour-coded green ≥60% / amber ≥40% / red <40%. Only visible once Day+5 snapshot data exists for a prior brief; silently absent otherwise. New `getBriefPerformanceSummary()` service method uses a CTE to find the most-recent mature brief_date and aggregate per-strategy Day+5 metrics from `paper_trade_snapshots`. New IPC `paper:brief-performance-summary` + preload entry.

## [0.32.45] — 2026-06-09

### Added
- **My Stocks: AI Advisor** — new 🤖 AI Advisor button reviews all conviction stocks in a single Claude call and returns per-stock action signals + recommended price zones. For each stock it receives: current price, zone status, bands, trend direction, RSI, SMA50/200, P/E, EPS growth, grade, IV/IVR, and days to earnings. Claude returns `add` / `hold` / `reduce` / `remove` action, `keep` / `adjust` zone verdict, recommended Low/Mid/High prices, a short risk flag, and a one-sentence rationale. Results appear in a panel below the table with checkboxes per row; clicking **Apply Selected** (or **Apply All**) updates the zones in one pass (history snapshot written automatically for each change). Stocks with `adjust` verdict are pre-checked; `remove` action stocks start unchecked to prevent accidental deletion.

## [0.32.44] — 2026-06-09

### Improved
- **Filters screen: Strategy Lab button in results grid** — added 🔬 button to each row's action column, alongside the existing Analysis, Validate, Options chain, and Payoff buttons. Clicking navigates directly to Strategy Lab pre-loaded with that ticker.

## [0.32.43] — 2026-06-09

### Fixed
- **My Stocks (ConvictionView): IV showing as thousands percent** — `conviction-service.ts` was multiplying `atm_iv` values by 100 before using them, but `iv_history.atm_iv` is already stored as a percentage (e.g., 31.726 = 31.7% IV). The double-multiply produced values like 3172.6%. Removed the erroneous `* 100` from all three locations: the `list()` display path, the `recommend()` IV rank computation, and the `get()` single-ticker fetch.

## [0.32.42] — 2026-06-09

### Improved
- **Scoring engine: trend direction signals** — three strategies now penalize picks that conflict with the current price trend, making the Daily Brief's recommendations more directionally actionable:
  - **Buy** (`trendAlignment`, weight 10): uptrend=100, sideways=25, bearish=0. A sideways stock costs ~7.5 pts on the composite — enough to push a range-bound name below better-aligned alternatives. Previously sideways and uptrend stocks scored identically on this dimension.
  - **Bullish** (`trendAlignment`, weight 7): same mapping, same penalty logic. Bullish spreads need a directional tailwind.
  - **Wheel** (`notDowntrend`, weight 8): uptrend=100, sideways=75, bearish=10. Avoids selling CSPs into confirmed downtrends (falling-knife assignment risk); sideways remains acceptable for premium selling.
  - **Bearish** and **Income** unchanged — `downtrendScore` and `trendNeutral` already capture direction for those strategies.
- **Seed upgrade**: `seedBaselines()` auto-upgrades `baseline_v1`/`v2` DB configs → `baseline_v3` on startup, so existing installs pick up the new signals without resetting manual customizations.
- **Trend derivation**: when `trendLabel` is unavailable from analysis snapshots, direction is derived from `sma50`/`sma200` stack in `technical_signals` — providing coverage for all ~1055 universe tickers without requiring a prior analysis run.

## [0.32.41] — 2026-06-08

### Fixed
- **DailyBrief watchlist not appearing in dropdown**: after the brief job creates or refreshes the `DailyBrief-MMDD` watchlist, the main process now sends a `watchlists:updated` IPC push to the renderer. `App.tsx` subscribes via `window.api.watchlists.onUpdated` and calls `refreshLists()` immediately — the new watchlist appears in every dropdown without requiring an app restart or manual navigation. New `onUpdated` push listener added to the preload `watchlists` namespace.

## [0.32.40] — 2026-06-08

### Added
- **Daily Brief auto-watchlist**: after each brief run, a watchlist named `DailyBrief-MMDD` is automatically created (or cleared and refreshed if it already exists for today). All final picks from all 5 strategies are added as items; the notes field shows which strategies each ticker was picked for (e.g. `wheel · buy`). The watchlist is immediately available in Watchlists, Screener, Analysis, and anywhere else watchlists are consumed. New public methods `findByName()` and `clearItems()` added to `WatchlistService`.

## [0.32.39] — 2026-06-08

### Improved
- **Daily Brief: collapsible pick cards** — each pick is now a single-line summary row (rank · ticker · price · score · structure grade · critic verdict) that expands on click to reveal signals, strategy lab detail, nav buttons, AI rationale, and full critic analysis. Collapsed by default to reduce scrolling.

## [0.32.38] — 2026-06-08

### Fixed
- **trendNeutral signal (income)**: ADX was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes 14-period Wilder ADX for all ~1055 universe tickers and stores it in `technical_signals.adx` (migration 035). `loadTechnicalSignals()` populates `trendStrengthAdx` from it as a fallback, so income picks are now range-bound filtered even without a prior analysis run.
- **breakoutScore signal (buy)**: `entryZoneLow` was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes the 20-day price low as a support-zone proxy and stores it in `technical_signals.support_level`. `loadTechnicalSignals()` populates `entryZoneLow` from it, enabling the `priceNearSupport` component of `breakoutScore` for all batch-scored tickers.

## [0.32.37] — 2026-06-08

### Improved
- **AI Critic context enrichment**: four grounding improvements to reduce LLM hallucinations and improve verdict accuracy:
  - **DTE pre-computed**: `structure.dte` (calendar days to expiry) is now calculated server-side and passed directly — removes LLM date arithmetic errors (e.g. treating a 39-DTE July expiry as a "12-month hold")
  - **Market context**: VIX level and SPY trend (vs 200MA) now passed to the LLM as `marketContext` — model previously had no visibility into the macro environment
  - **Earnings in window**: `earningsInWindow` field added — queries `earnings_calendar` for any event between today and expiry; non-null result tells the model the exact date, days from now, and confirmation status of the biggest event risk
  - **Pre-computed risk metrics**: `strikeOtmPct` (how far the short strike is from current price) and `breakevenDistancePct` (income only — how far price can move before loss) are now computed server-side, removing another class of LLM arithmetic errors

## [0.32.36] — 2026-06-08

### Fixed
- **AI Critic price hallucination**: critic LLM was overriding correct live prices with stale training-data prices (e.g. flagging AMD at $490 as "fabricated" because it "remembered" AMD at ~$110). Fix: system prompt now explicitly instructs the model that all `marketData` fields are live and authoritative — training knowledge about prices is years out of date and must not be used to contradict provided data. Context also now includes `price52wReturnPct` so the model can calibrate price level from the known 1-year return without needing to recall an absolute price from training.

## [0.32.35] — 2026-06-08

### Fixed
- **Daily Brief scoring — fundamental signals always missing**: `loadFundamentals()` was reading from `screen_results` (the last screener run), so any ticker not in that run had null earningsGrowth, fundamentalScore, revenueGrowth5Y, epsGrowth5Y, leverageQuality etc. — which the AI Critic immediately flagged as `critical_signal_missing`. Root cause: the last screener run used the ETF universe (60 tickers), leaving all ~1000 stock picks with no fundamental data. Fix: `loadFundamentals()` and `loadSectorMomentum()` now read from `fundamentals_cache`, which is populated by the market-sync batch jobs for the full constituent universe (1067 rows, updated daily). `loadTechnicalSignals()` also now provides `rsi`, `smaStack`, and `lastPrice` as fallbacks from the nightly `DailyTechnicalSignalsJob` (1055 tickers), so those signals are no longer watchlist-scoped.

## [0.32.34] — 2026-06-08

### Fixed
- **Earnings Refresh bulk**: filter Finnhub bulk entries to constituent tickers only — bulk was storing 1500+ global entries (random small caps, international) of which only ~100 were S&P500/Russell1000. Counter and per-ticker delta now reflect actual constituent coverage.

## [0.32.33] — 2026-06-08

### Fixed
- **Earnings Refresh per-ticker loop**: Finnhub earnings calendar requires `from`/`to` date parameters — omitting them returns an empty response. Per-ticker calls now include a 365-day window so AAPL, MSFT etc. are correctly retrieved.

## [0.32.32] — 2026-06-08

### Fixed
- **Earnings Refresh Phase 2**: Finnhub's free-tier bulk call has a result cap (~1500 global entries); confirmed tickers like AAPL (Jul 29) were missing because they didn't fit in the bulk response. Added per-ticker Finnhub fallback loop for all constituents still missing a future date after the bulk calls. Rate-limited to 1 call/second (within 60/min free tier). Run notes show both bulk and per-ticker counts.

## [0.32.31] — 2026-06-08

### Changed
- **Earnings Refresh**: removed E*Trade loop entirely — job is now Finnhub-only. Companies without an announced next date simply have nothing to return yet; they appear on the next daily run once published. No more 950+ useless E*Trade no-data calls.

## [0.32.30] — 2026-06-08

### Added
- **Earnings Calendar**: 🗑 Reset button clears all non-manual entries (manual dates kept) — use before a clean Finnhub re-fetch

### Fixed
- **Earnings Refresh Phase 1**: Finnhub now makes two bulk calls (today→+90d and +90d→+180d) instead of one, doubling coverage and avoiding the free-tier result cap that left tickers like ABNB out of the first call. E*Trade Phase 2 delta is computed after both Finnhub calls.

## [0.32.29] — 2026-06-08

### Changed
- **Earnings Refresh**: Finnhub dates stored as `confirmed=true` — calendar shows "✓ Confirmed" instead of "~ Estimated"; Finnhub data quality verified to be reliable (ABNB, ADBE etc.). E*Trade Phase 2 loop still runs for tickers Finnhub didn't cover, but cannot overwrite Finnhub future dates (delta filter excludes them).

## [0.32.28] — 2026-06-08

### Added
- **Finnhub API key in Settings** (API & Data tab) — stored encrypted alongside Polygon/IVolatility keys; saved by the same Save Settings button
- **Earnings Refresh — Finnhub Phase 1**: when a Finnhub key is configured, the batch job now opens with a single bulk call (`today → +90d`) that pre-fills `earnings_calendar` for every ticker Finnhub covers (including ABNB, ADBE, AA, AAL etc. that E*Trade's API silently drops). Source stored as `'finnhub'`, `confirmed=false`. E*Trade Phase 2 then overwrites with confirmed dates for the remaining delta. Run notes show both phases.

## [0.32.27] — 2026-06-08

### Added
- **Test API — Finnhub tab**: API key save/load, date-range earnings calendar fetch (bulk, not per-ticker), constituent coverage counter, results table (Date · Symbol · BMO/AMC · Quarter · EPS Est/Actual · Revenue Est/Actual), raw JSON sample. Pre-implementation validation before wiring Finnhub into the earnings pipeline.

## [0.32.26] — 2026-06-08

### Fixed
- **Earnings Refresh delta filter**: the `force=true` flag passed by "Run All in Sequence" was bypassing the delta query and falling back to all 1000+ tickers. The delta filter now always runs regardless of the force flag — `force` is for non-trading-day guards in other jobs, not earnings caching.

## [0.32.25] — 2026-06-08

### Changed
- **My Stocks actions**: buttons consolidated to single row, icon-only (🎯🔬📐📉✎🕓✕) with tooltips — prevents 2-line wrapping

## [0.32.24] — 2026-06-08

### Added
- **My Stocks actions column**: four navigation buttons added — 🎯 Validate, 🔬 Lab, 📐 Payoff, 📉 Options — alongside the existing Edit / History / Remove buttons

## [0.32.23] — 2026-06-08

### Fixed
- **Earnings Refresh batch job**: switched from full-population iteration to delta mode — a single SQL LEFT JOIN now pre-filters the ticker list to only those with no stored date or a past/today date. The day after a full run, only tickers whose earnings just occurred are fetched instead of all 1000+. Manual entries and tickers with future dates are excluded before the loop even starts.

## [0.32.22] — 2026-06-08

### Fixed
- **Payoff risk matrix**: spot row is now vertically centred in the visible table area on load and whenever the strike list changes — no more scrolling to find current price

## [0.32.21] — 2026-06-08

### Fixed
- **Lizard → Payoff**: legs now always pre-populate when strikes + expiry are available; per-leg premiums default to 0 for snapshots run before v0.32.20 so the structure is pre-filled even on older data

## [0.32.20] — 2026-06-08

### Fixed
- **Lizard → Payoff navigation**: clicking 📐 Payoff from Jade Lizard or Big Lizard grid rows now pre-populates all 3 legs (sell put, sell call, buy call) with correct strikes and mid-premiums. `LizardResult` now stores per-leg premiums (`putPremium`, `shortCallPremium`, `longCallPremium`).

## [0.32.19] — 2026-06-08

### Changed
- **Grid width**: removed fixed `maxWidth` caps from Analysis Engine (1200px), My Stocks (1200px), Batch Jobs (1100px), and Strategy Lab (1000px) — grids now use full available width, eliminating horizontal scrollbars

## [0.32.18] — 2026-06-07

### Added
- **Analysis Engine — Jade Lizard & Big Lizard modes**: two new watchlist-screening tabs that find the best setup for each ticker (30–45 DTE), calculate net credit received, verify the "no upside risk" constraint (credit > spread width), and sort by total premium descending
  - **Jade Lizard** 🦎: short OTM put (~30Δ) + short OTM call (~20Δ) + long call one strike above
  - **Big Lizard** 🐊: short ATM straddle + long call one strike above ATM
  - Columns: Ticker · Price · Exp · DTE · Put Strike · Short Call · Long Call · Net Credit · Spread W · No ↑ Risk · Breakeven↓ · IV Rank · Actions
  - Both use the E*Trade options chain (same pipeline as Wheel/Options Income)

## [0.32.17] — 2026-06-07

### Added
- **Analysis Engine**: Actions column in all five mode grids (Buy, Options, Wheel, Bullish, Bearish) with 📐 Payoff, 📉 Options, and 🔬 Lab buttons — navigate directly to the respective view with the ticker (and strike/expiry where available) pre-filled

## [0.32.16] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cell and chip borders thickened from 1px to 2px

## [0.32.15] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cells and ticker chips now use the Batch Jobs color palette (`#131b2e` cells, `#2d3748` borders, `#89b4fa` blue accent, `#95a5a6` muted text)

## [0.32.14] — 2026-06-07

### Changed
- **Earnings Calendar**: reverted screen chrome (toolbar, background, buttons, list rows) back to app dark theme; calendar cell colors preserved for follow-up tuning

## [0.32.13] — 2026-06-07

### Changed
- **Earnings Calendar**: replaced near-black navy palette with a light blue theme — cell backgrounds `#eff6ff`/`#e0ecff`/`#bfdbfe`, borders `#bfdbfe`/`#93c5fd`, text `#1e3a5f`, toolbar `#dbeafe`

## [0.32.12] — 2026-06-07

### Changed
- **Sidebar**: Portfolio moved above My Stocks in the Personal section

## [0.32.11] — 2026-06-07

### Changed
- **Sidebar**: swapped Personal and Misc section order — Personal now follows Strategy, Misc is last

## [0.32.10] — 2026-06-07

### Changed
- **Sidebar**: moved 🤖 Agent to Intelligence section below 📡 News & Research; moved 🔔 Alerts to the bottom of the menu (below 📋 Watchlists)

## [0.32.9] — 2026-06-07

### Changed
- **Sidebar**: merged ⚡ LEAPS and 🛡️ Collared LEAPS into 🔬 Strategy Lab as in-view tabs — reduces sidebar from 26 to 24 entries; LEAPS and Collared LEAPS are now tab buttons at the top of the Strategy Lab screen

## [0.32.8] — 2026-06-07

### Changed
- **Sidebar**: moved 📡 News & Research from the Screeners section to the Intelligence section, directly below 📅 Earnings

## [0.32.7] — 2026-06-07

### Changed
- **Scoring engine**: removed vestigial `phase2` signal infrastructure — the field existed in `ScoringSignal` but no current baseline used it; all `!s.phase2` guards removed from scoring-service, critic-service, daily-intelligence-brief-job, and TradeScoringView. The "Phase 2" section and badge in the Trade Scoring config UI are gone. All signals are now fully active or disabled by the user toggle with no hidden suppression.
- **Daily Brief AI model**: upgraded from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6` for both the pick rationale synthesis (stage 5) and the AI Critic (stage 5b). Sonnet produces deeper second-order reasoning on signal interactions; cost estimate updated accordingly (~$3/M input, ~$15/M output).

## [0.31.5] — 2026-06-07

### Fixed
- Earnings Refresh Edit modal now shows correct default delay (500ms) instead of IV job's 1100ms
- `registerJob` now accepts `defaultConfig` option — seeded to DB on first registration, backfilled for existing rows where `config_json IS NULL` (upgrade path)

## [0.31.4] — 2026-06-07

### Changed — Earnings Refresh redesign
- **Universe**: now scans all unique tickers from `constituents` (S&P 500 + Russell 1000) instead of portfolio/watchlist/conviction only
- **Smart caching**: a ticker is skipped if it already has a *future* report_date stored — no re-fetch needed until that date passes. Only tickers with past/missing dates are refreshed each run
- **E*Trade only**: removed Polygon `analysis_snapshots` fallback — single source of truth, clearer failure mode
- **Rate limit**: configurable `callDelayMs` (default 500ms) in Edit modal, clamped 200–2000ms. Skipped tickers (cached) incur no delay — only tickers that actually call E*Trade
- **No-data clarity**: if E*Trade is not connected, job returns `skipped` with a message rather than looping 1,000 failed calls

## [0.31.3] — 2026-06-07

### Fixed
- Earnings Refresh: all tickers showed no-data due to a dead placeholder SQL query in `estimateFromPolygon` referencing `constituents.period_of_report_date` (column does not exist). SQLite validates column names at prepare() time even with WHERE 0. Removed the dead query; the analysis_snapshots fallback now runs correctly.

## [0.31.2] — 2026-06-07

### Changed
- Earnings Refresh is now a proper batch job visible in Batch Jobs screen (was a silent fire-and-forget in App.tsx)
- Runs on startup with 60s delay (after E*Trade tokens load) — respects 24h TTL so most launches are all-skips
- Manually triggerable via Run Now; shows per-ticker progress in live log
- Reverted silent App.tsx useEffect (v0.31.1) — batch job is the correct home

## [0.31.1] — 2026-06-07

### Fixed
- Earnings startup refresh (Earnings Refresh batch job) was missing — now fires on app open as a background task. 24h cache TTL means it is a no-op on most launches; only fetches stale or new tickers.

Reverse-chronological. Per spec EP-2.3, this is the index; per-version detail lives in `changelogs/`.

## v0.31.0 — 2026-06-07

Earnings Calendar: full feature shipping as v0.31.0. New migration 034, EarningsService (E*Trade FUNDAMENTAL quote primary, analysis-snapshot estimate fallback, manual override), IPC handlers, preload exposure. Dedicated "📅 Earnings" sidebar view with date groups, refresh, manual entry, and delete. Earnings warning banner in Validate view (fires when earnings ≤45 DTE from ticker selection). Earnings badge on Portfolio open positions (📅 with ! when before expiry). Payoff View: amber earnings annotation below P&L chart; Risk Matrix earnings column highlighted amber with 📅 icon.

## v0.30.7 — 2026-06-07

Risk Matrix critical fix: Black-Scholes was dividing leg.iv by 100 a second time. OptionContract.iv from the E*Trade chain is already a decimal fraction (0.38 = 38%), so the formula was computing sigma = 0.0038 (0.38% IV) instead of 38% — making all OTM options appear worthless and showing +$2.2k everywhere. Formula corrected to use leg.iv directly as sigma.

## v0.30.6 — 2026-06-07

Risk Matrix fix: when no options chain is loaded (manually-entered legs), intermediate date columns are now generated automatically as weekly synthetic intervals between today and the leg's expiry. Previously only the "Today" column existed, making time decay invisible. Synthetic column dates marked with ~ in the header. Footer now shows separate notices for synthetic columns and missing IV.

## v0.30.5 — 2026-06-07

Risk Matrix fix: strike rows now always include leg strikes and extend below them, even when the option strike is outside the ±25% spot range (e.g. TSLA CSP at $290 when stock is at $395). Previously all visible rows were above the strike showing only profit — now the table covers the full risk picture including losses below the strike. Leg strike rows highlighted in amber with "◀ strike" marker.

## v0.30.4 — 2026-06-07

Risk Matrix: click any cell to expand a per-leg breakdown panel showing each leg's entry price, current theoretical value, P&L, and action recommendation (Take profits / Consider closing / Close — loss exceeds premium / Watch / Hold). Click same cell or × to dismiss. Net P&L shown in header. Selected cell highlights blue.

## v0.30.3 — 2026-06-07

Payoff Visualizer: "📈 Chart / ⬛ Risk Matrix" toggle. Risk Matrix is a 2D P&L grid — rows are chain strike prices (±25% of spot), columns are Today + available chain expiry dates (all within 45 DTE; extends to 10 expiries for monthly-only chains). Pre-expiry cells computed via Black-Scholes (r=4.5%, IV from each leg; falls back to 30% when IV missing). Final column uses intrinsic-only math. Color-coded green→red, spot row highlighted, Zone label per row at expiry.

## v0.30.2 — 2026-06-07

Trade Management Alerts (ENH-5): collapsible "⚡ Trade Management" banner above the open positions table showing three rule-based alerts — Take Profits (≥50% gain via E*Trade totalGainPct), Manage Now (≤21 DTE), Delta Drift (|Δ| > 0.45). "View →" expands the relevant position row and scrolls to it. Pure frontend — no new backend code.

## v0.30.1 — 2026-06-07

Portfolio Greeks (ENH-3): "⚡ Refresh Greeks" button fetches live delta/theta/vega for all open CSP/CC positions from the options chain and writes them to the positions table. Portfolio Greeks bar now includes manually entered positions (not just E*Trade-synced ones). Short-position sign convention applied on write: positive theta/negative vega for premium sellers.

## v0.30.0 — 2026-06-07

Conviction List Phase 2: zone-entry toast notifications (FR-CV-01) when a stock transitions into Buy Zone, green count badge on the "⭐ My Stocks" sidebar item (FR-CV-03), and a "⚡ Conviction Alerts" section at the top of the Daily Brief listing any stocks currently in Buy or Mid zone (FR-CV-02).

## v0.27.0 — 2026-06-06

Payoff: InfoTip tooltip now flips to show below the trigger when the element is in the upper half of the viewport. Fixes the metrics bar tooltips being hidden under the title bar after the bar was moved to the top.

## v0.26.9 — 2026-06-06

Payoff layout: Max Profit, Max Loss, Breakeven, Net Credit/Debit, Δ, Θ, V now fit in a single compact horizontal bar above the chart. Chart height reduced (SVG 160→120, tighter padding). Options chain drawer reduced from 70vh to 45vh so chart remains visible below it.

## v0.26.8 — 2026-06-06

Payoff chart: hover tooltip. Mouse over shows a vertical crosshair, a dot on the P&L curve at that price, a faint horizontal hairline, and a tooltip box with exact price and P&L value (color-coded green/red). Tooltip flips to the opposite side when the cursor is in the right half of the chart.

## v0.26.7 — 2026-06-06

Payoff Visualizer: leg strikes are now click-to-edit (underlined, same UX as premium). Changing a sell leg strike snaps to the nearest real chain contract and updates premium + Greeks. For lizard strategies (Jade/Big/Reverse), changing any sell leg automatically recalculates the buy hedge strike using the credit ≥ spread width rule.

## v0.26.6 — 2026-06-06

Jade/Big/Reverse Lizard hedge leg selection: all three layers (Strategy Lab, Payoff auto-fill, Payoff reload) now select the buy call/put at the FURTHEST available strike where `credit ≥ spread width`, guaranteeing no upside/downside risk. Previously all three used nearest-to-percentage-of-spot, which could overshoot the credit due to $5 strike increments. Falls back to nearest OTM when no valid strike exists. `fillLegsFromChain` utility DRYs out Payoff template fill and reload logic.

## v0.26.5 — 2026-06-06

Payoff Visualizer: (1) Strategy Formula Panel — below the recognition badge, shows the key tastytrade rules for the detected strategy with actual computed values and ✓/✗ pass/fail. Covers Jade Lizard, Big Lizard, Reverse variants, Iron Condor, Iron Fly, Short Strangle/Straddle, CSP, Covered Call, vertical spreads, Bull/Bear spreads. (2) Reload Strategy button — appears at the top of the legs section when a template was applied and a chain expiry is selected; re-snaps all legs to the selected expiry using live mid-prices.

## v0.26.4 — 2026-06-06

Payoff Visualizer: fix false "∞ loss" on short-put strategies (CSP, Big Lizard, Jade Lizard, Short Straddle downside, etc.). Max loss is now computed at stock price = $0 (the true floor) rather than the chart's 50% boundary. Left-side slope removed from unlimited detection — stock cannot go below $0 so downside is always bounded. Right-side slope detection preserved for genuinely unlimited positions (naked short calls, short stock). Also fixes false "∞ profit" on long puts.

## v0.26.3 — 2026-06-06

Payoff template selection: spot price is no longer required when a ticker is set. Chain load provides the live spot automatically. Error message updated: only fires when both ticker and spot are absent.

## v0.26.2 — 2026-06-06

Payoff Visualizer: selecting a strategy template now auto-fills real premiums from the live chain when a ticker is set. Skeleton legs appear immediately; chain loads in background; each leg is snapped to the nearest real Friday expiry for that DTE and filled with the live mid-price + Greeks. Spot price updates to chain's live price. Chain panel opens automatically.

## v0.26.1 — 2026-06-06

Payoff Visualizer: templates section replaced with a grouped dropdown covering all 31 Strategy Lab strategies (Jade Lizard, Big Lizard, Reverse variants, Iron Fly, Zebras, Front Ratios, Butterflies, PMCC/PMCP, Calendars, etc.). `recognizeStrategy` expanded to identify all new structures including 3-leg lizard variants, zebras, front ratios, butterfly families (standard + broken-wing), calendar spreads, Poor Man's covered positions, and Short/Long Straddle/Strangle disambiguation.

## v0.26.0 — 2026-06-06

AI Critic — second-opinion engine for the Daily Brief. Every pick now gets a `pass / caution / flag` verdict from an adversarially-prompted Claude haiku call, backed by 6 deterministic rule checks (trend alignment, liquidity, missing signals, score concentration, cross-strategy conflict, market regime). Verdict badge shown inline on each pick card in the Brief UI with expandable flags and rationale. Strategy section headers show aggregate counts. Email now includes a Critic column. See `Requirements/ai-critic.md` for full spec.

## v0.25.0 — 2026-06-05

Options Snapshot now runs against the full S&P 500 + Russell 1000 universe (~1,100 tickers) instead of the top 300. At confirmed 0.57s/ticker this takes ~10-11 min — same as before the performance work but now covers all tickers, giving the Daily Brief `annualizedReturn` and `optionLiquidityScore` for every candidate rather than just the top 300 by IV rank.

## v0.24.9 — 2026-06-05

Options Snapshot speed fix (root cause found): `modeWheel` was making up to 9 E*Trade/Polygon calls per ticker. Two fixes: (1) `findSuitableChain` now checks DTE before calling `getOptionsChain` — cuts from 7 chain fetches to 1-2 per ticker since only the last 1-2 of the 7 generated Fridays fall in the 30-45 DTE window; (2) `forceCache=true` skips `getOptionsIV` (uses `iv_history.atm_iv` instead) and `getEarningsCalendar` (always returns null). Expected: ~2 E*Trade calls/ticker instead of ~9 → similar speed to IV Update.

## v0.24.8 — 2026-06-05

Options Snapshot: bypass Polygon API calls when run as a batch job. `analyzeTicker` now accepts `forceCache: true` which reads quote, fundamentals, and price bars directly from the local DB instead of making 3 Polygon API calls per ticker. Market Sync runs earlier in the sequence so the data is already warm. Eliminates the rate-limiter wait per ticker — expect ~0.4s/ticker vs ~2s/ticker (~4 min for 300 tickers vs ~10 min).

## v0.24.7 — 2026-06-05

Configurable call delay extended to Daily Options Snapshot (same 200–2000ms range, default 1100ms). Edit Job modal shows E*Trade Rate Limit section and run-time estimate for both IV Update and Options Snapshot.

## v0.24.6 — 2026-06-05

PERF-8: Fixed Options Snapshot candidate sort order regression (v0.24.4 introduced alphabetical ordering). Now sorts by most recent IV (atm_iv DESC) → buy_signal_score DESC → alphabetical, so the 300-ticker cap covers the most premium-rich candidates first.

## v0.24.5 — 2026-06-05

PERF-1: IV Update call delay is now configurable in the Edit Job modal (200–2000ms, default 1100ms). Shows live run-time estimate as you adjust. Migration 028 adds `config_json` to `batch_jobs` for per-job settings.

## v0.24.4 — 2026-06-05

Daily Brief and Options Snapshot now score the full S&P 500 + Russell 1000 + ETF universe directly instead of reading from screener results. Scoring engine handles quality ranking per strategy — removes Bearish blind spot and eliminates stale-screener dependency. Daily Screener job still runs for the Screener UI. See [`changelogs/v0.24.4_2026-06-05.md`](changelogs/v0.24.4_2026-06-05.md).

## v0.24.3 — 2026-06-05

New Daily Screener batch job (PERF-7): runs after Market Sync to keep `screen_results` fresh. Two passes — stocks (S&P 500 + Russell 1000, strict, default preset) and ETFs (soft, volume ≥ 500 k + price ≥ $10). Daily Brief and Options Snapshot now merge all today's screener runs instead of reading a potentially stale single row. See [`changelogs/v0.24.3_2026-06-05.md`](changelogs/v0.24.3_2026-06-05.md).

## v0.23.4 — 2026-06-04

Sidebar: Trade Scoring (⚖) moved from Intelligence to Data section, directly below Settings. See [`changelogs/v0.23.4_2026-06-04.md`](changelogs/v0.23.4_2026-06-04.md).

## v0.23.3 — 2026-06-04

E*Trade OAuth split into two non-interactive scripts for Claude Code on phone. `etrade-step1.mjs` fetches request token + prints auth URL + saves state. `etrade-step2.mjs <verifier>` completes the exchange — verifier passed as CLI arg, no readline needed. Original `etrade-login.mjs` kept for direct SSH terminal use. See [`changelogs/v0.23.3_2026-06-04.md`](changelogs/v0.23.3_2026-06-04.md).

## v0.23.2 — 2026-06-04

E*Trade remote token refresh via SSH from phone. New `scripts/etrade-login.mjs` does the full OAuth 1.0a flow in a terminal — reads consumer creds from the running app API (or `~/.tradeanalyzer/etrade-config.json` as fallback), prompts for verifier code, stores tokens immediately if app is running or writes a pending file imported on next launch. New API endpoints `GET /api/v1/etrade/credentials` + `POST /api/v1/etrade/token`. `api-server.ts` now writes `etrade-config.json` and imports pending tokens on every startup. See [`changelogs/v0.23.2_2026-06-04.md`](changelogs/v0.23.2_2026-06-04.md).

## v0.23.1 — 2026-06-04

Two fixes surfaced by Retrospect showing false negatives on day-0 paper trades:

**Retrospect day-0 verdict suppression**: open positions now show Neutral / Hold on day 0 (no full trading day elapsed). Previously `historical_prices` close (updated by the gap-fill job) could predate the brief's captured entry price, making any return % a data-freshness artefact rather than real price movement. Verdict and estimated P&L are now suppressed until `daysHeld ≥ 1`.

**`recentVolatility` scoring signal (Income + Wheel)**: new signal measuring 20-day annualized realized volatility from `historical_prices` (std dev of log returns × √252). `lower_better` — a stock making large recent moves (e.g. ADBE up 16% in 20 days) is a poor candidate for a short strangle or CSP. Income weight 20 (taken from ivRank/premiumRiskRatio/trendNeutral/optionLiquidity); Wheel weight 10. Baseline bumped to `baseline_v2` — existing configs need **Reset to Baseline** in Trade Scoring to pick up the new signal. Signal label `recentVolatility` added to DailyBriefView chip renderer.

## v0.23.0 — 2026-06-03

Paper Trading / Retrospect — closed-loop validation for the Daily Intelligence Brief. Every brief run now auto-captures all post-liquidity-gate picks as paper trades (server-side, no user action required). Unique key `(ticker, brief_strategy, brief_date)` means same-day re-runs update existing records rather than duplicate. New **🔍 Retrospect** screen (Intelligence section) with four tabs: **In Progress** (open positions grouped by brief date, with stock return %, delta-based estimated P&L, Positive/Negative/Neutral verdict, Hold/Close Signal recommendation, expandable legs detail, Close and Delete actions), **Summary** (win rate per strategy, avg return, best/worst trade, strategy accuracy table), **History** (closed/expired trades with outcomes), **Settings** (per-strategy thresholds for negative definition and Close Signal triggers — all configurable, sensible defaults applied). Positions auto-expire on view load when expiry date has passed; exit price auto-filled from `historical_prices`. Daily Brief history bar now shows brief accuracy chip (e.g. `71%`) next to each date when ≥ 3 closed picks exist; selecting a historical date shows an inline accuracy banner. No new Polygon API calls. Migration 025. See [`changelogs/v0.23.0_2026-06-03.md`](changelogs/v0.23.0_2026-06-03.md).

## v0.22.31 — 2026-06-03

Daily Brief email fixes: (1) Strategy order now matches the screen (`wheel → bullish → bearish → income → buy`). (2) "Score" column replaced with "Lab Score" (Strategy Lab `totalScore` 0-100, same system as the grade) instead of `compositeScore` (scoring engine rank used to select picks — a different system causing confusing mismatches like Grade A with Score 18). Both email and PDF updated. See [`changelogs/v0.22.31_2026-06-03.md`](changelogs/v0.22.31_2026-06-03.md).

## v0.22.30 — 2026-06-03

Fix Daily Brief showing stale data from earlier same-day runs. `persistBrief` now deletes all existing records for the same strategy on the same ET day before inserting, so each run is a clean replacement. Fixes mixed-run display (UI showing 2+4 from run 1 while email showed 5+5 from run 2) and the history view inconsistency where selecting today showed different data than the default latest view. DST-safe: uses JS `toLocaleDateString('en-CA', {timeZone: 'America/New_York'})` for the comparison. See [`changelogs/v0.22.30_2026-06-03.md`](changelogs/v0.22.30_2026-06-03.md).

## v0.22.29 — 2026-06-03

Fix two Daily Brief bugs: (1) Email showed 25 picks (pre-liquidity-gate) while UI showed 19 (post-gate) — email now uses the same `persistedPicks` map built from `liquidFiltered` data. (2) Brief history showed tomorrow's date (e.g. 6/4 for a run at 10:30pm ET on 6/3) because `generated_at` is UTC and `.slice(0,10)` gave the UTC date — fixed with `toETDate()` converting to ET before display and grouping. See [`changelogs/v0.22.29_2026-06-03.md`](changelogs/v0.22.29_2026-06-03.md).

## v0.22.28 — 2026-06-03

Daily Intelligence Brief: email delivery with PDF attachment. After the brief is generated, an HTML email is sent with trade-ready tables (ticker, grade, structure, strike, expiry, DTE, credit/debit, ann. return, POP, max loss) and a full PDF is attached (all 25 picks, complete AI rationale, signal breakdown). Uses existing SMTP config from Agent Config → Email. Email failure does not fail the job. New: `EmailService`, `BriefReportBuilder`, `pdfkit` dependency. See [`changelogs/v0.22.28_2026-06-03.md`](changelogs/v0.22.28_2026-06-03.md).

## v0.22.27 — 2026-06-03

Fix batch job stuck on "Running" with non-functional cancel. Two root causes: (1) stale `running` DB state from crashed/killed sessions — fixed by cleaning up `batch_runs` and `batch_jobs` in `BatchService` constructor on every startup. (2) `cancelJob` only signalled the abort but never updated the DB, so the UI never changed until the hung Promise settled — fixed by immediately writing `cancelled` to the DB and freeing `runningJobId` in `cancelJob`, with a guard in `runJob` to skip the final DB write if the signal was aborted. See [`changelogs/v0.22.27_2026-06-03.md`](changelogs/v0.22.27_2026-06-03.md).

## v0.22.26 — 2026-06-03

Daily Options Snapshot + Daily Intelligence Brief: graceful skip when options provider is unavailable. Both jobs now probe `getOptionsExpirations('SPY')` before doing any work. Expired E*Trade token (or any connectivity failure) returns `status: 'skipped'` with a clear reconnect message instead of timing out on every ticker. `DailyOptionsSnapshotJob` now takes `OptionsProvider` as a constructor arg. See [`changelogs/v0.22.26_2026-06-03.md`](changelogs/v0.22.26_2026-06-03.md).

## v0.22.25 — 2026-06-03

Fix Daily Options Snapshot stuck on "Running". Added a 30-second per-ticker timeout (`withTimeout`) around each `analyzeTicker` call. An expired E*Trade token (or any hung HTTP call) was causing the job to hang indefinitely on the first ticker with no way to recover. Timed-out tickers now count as failed and the loop moves on. See [`changelogs/v0.22.25_2026-06-03.md`](changelogs/v0.22.25_2026-06-03.md).

## v0.22.24 — 2026-06-03

Daily IV Capture: overwrite on every run. Removed the "already done today" skip so each run captures the latest snapshot and the 4:30pm job always writes EOD data. `storeReading()` already uses `ON CONFLICT DO UPDATE` so no schema change needed. Supports multiple intraday runs within the 10,000 credit/day MarketData.app limit (~1,500 credits per run). See [`changelogs/v0.22.24_2026-06-03.md`](changelogs/v0.22.24_2026-06-03.md).

## v0.22.23 — 2026-06-03

Daily IV Capture job switched from E*Trade to MarketData.app. Job now runs fully unattended — no OAuth token, no midnight expiry. Calls `getLiveChain(ticker, nearestMonthlyExpFor30Dte())` (single API call per ticker, `?expiration=` param), computes ATM IV inline, stores with `source='marketdata'`. E*Trade code untouched — only `DailyIvCaptureJob` and its constructor wiring in `index.ts` changed. See [`changelogs/v0.22.23_2026-06-03.md`](changelogs/v0.22.23_2026-06-03.md).

## v0.22.22 — 2026-06-03

Test API: MarketData.app live chain support. New **Live (today)** mode on the MarketData.app tab uses `?expiration=` instead of `?date=` (historical-only param that was causing 400 errors). Auto-selects the nearest monthly 3rd-Friday expiration to 30 DTE. New `getLiveChain()` / `getRawLiveChain()` methods on `MarketDataProvider`; `nearestMonthlyExpFor30Dte()` helper exported. New `test-api:get-marketdata-live-chain` IPC handler + `getMarketDataLiveChain` preload bridge. See [`changelogs/v0.22.22_2026-06-03.md`](changelogs/v0.22.22_2026-06-03.md).

## v0.22.21 — 2026-06-02

Quality signals wired into the Trade Scoring Engine and Daily Brief. `scoreFundamentals()` now uses ROIC and FCFToNetIncome alongside ROE/margin/growth. `computeEarningsGrowthScore()` blends 1Y and 5Y CAGR (1.5× weight on 5Y). Four new explicit scoring signals: `leverageQuality` (Wheel, wt 8), `leverageRisk` (Bearish, wt 8), `revenueGrowth5Y` (Bullish wt 10, Buy wt 10), `epsGrowth5Y` (Buy wt 8). AI rationales can now mention ROIC, FCF quality, and 5-year growth context. Note: existing strategy configs in DB are not auto-updated (INSERT OR IGNORE) — call Reset to Baseline in the Scoring Config UI to pick up new signals. See [`changelogs/v0.22.21_2026-06-02.md`](changelogs/v0.22.21_2026-06-02.md).

## v0.22.20 — 2026-06-02

WheelMetrics quality signals — FCFToNetIncome, ROIC, NetDebtToEBITDA, 5-year revenue/EPS CAGR, and VS/GS composite scores with StockGrade added to the fundamentals pipeline. All metrics computed from existing Polygon `/vX/reference/financials` data (no new API calls); quarterly filings limit bumped to 24 (≈6 years) for 5Y CAGR. New screener columns with star grade renderer. See [`changelogs/v0.22.20_2026-06-02.md`](changelogs/v0.22.20_2026-06-02.md).

## v0.22.19 — 2026-06-01

Phase 2 scoring signals — Relative Strength vs SPY + Sector Momentum. Four new signals wired into the Trade Scoring Engine from `historical_prices` only (no new API calls): `relativeStrength` (Bullish wt 15, Buy wt 20), `relativeWeakness` (Bearish wt 15), `sectorMomentum` (Bullish wt 10, Buy wt 10), `sectorWeakness` (Bearish wt 10). `PriceGapFillJob` now bootstraps SPY + 11 SPDR sector ETFs with 6M bars before the main stale-ticker pass so reference data is always available. Sector lookup uses `ScreenResultPayload.sector` → GICS→SPDR map. Relative strength = 90-day excess return vs SPY; sector momentum = 90-day return of the ticker's sector ETF. See [`changelogs/v0.22.19_2026-06-01.md`](changelogs/v0.22.19_2026-06-01.md).

## v0.22.18 — 2026-06-01

Daily Options Snapshot batch job — nightly Wheel analysis run on the top 300 screener candidates to keep `optionLiquidityScore` in `analysis_snapshots` current. Scheduled at 06:00 ET + on startup (5-min delay). Migration 024 makes `analysis_snapshots.watchlist_id` nullable so the batch snapshot has no watchlist affiliation. See [`changelogs/v0.22.18_2026-06-01.md`](changelogs/v0.22.18_2026-06-01.md).

## v0.22.17 — 2026-06-01

Nav: Data Sync moved to Misc (between Test API and History); Batch Jobs is now the default landing page on app launch. Data section simplified to Settings + Batch Jobs. See [`changelogs/v0.22.17_2026-06-01.md`](changelogs/v0.22.17_2026-06-01.md).

## v0.22.16 — 2026-06-01

Trade Scoring Config — full UI redesign. Pill strategy tabs with emoji, scrollable 4-column signal table (toggle, label+direction badge, weight+bar, rationale), Phase 2 divider, green/red total row, sticky footer with version input and Save/Reset buttons. See [`changelogs/v0.22.16_2026-06-01.md`](changelogs/v0.22.16_2026-06-01.md).

## v0.22.15 — 2026-06-01

Daily Brief — hard liquidity gate and specific setup details on pick cards. Picks are now dropped in Stage 6 if the best relevant Strategy Lab structure has `liquidityScore < 5` (catches OI=1 + wide spreads, threshold ≈ 3). Progress message reports gated count. Pick cards now show a second line under the grade badge: `$240 · Jul 17 · $3.25 cr` — the exact strike, expiry, and net premium from the Strategy Lab setup. See [`changelogs/v0.22.15_2026-06-01.md`](changelogs/v0.22.15_2026-06-01.md).

## v0.22.14 — 2026-06-01

Fix Payoff Assess Trade — AI was reading the expiry year (`2026`) as the DTE value, producing responses like *"long 2026 DTE provides ample theta runway"*. DTE is now computed from `leg.expiry` and injected into the prompt as `expiry 2026-07-17 (45 DTE)`. See [`changelogs/v0.22.14_2026-06-01.md`](changelogs/v0.22.14_2026-06-01.md).

## v0.22.13 — 2026-06-01

Daily Brief — Payoff, Validate, and Options quick-nav buttons on pick cards. Each card now has a compact row of three buttons: **📊 Payoff** opens the Payoff Visualizer pre-loaded with the Strategy Lab legs (slug, expiry, all option strikes/premiums/deltas); **✓ Validate** opens the Validate tab for the ticker; **📋 Options** opens the Options Chain pre-filtered to the expiry that Strategy Lab used. All three use the existing `navigate-to-*` CustomEvent deep-link system. See [`changelogs/v0.22.13_2026-06-01.md`](changelogs/v0.22.13_2026-06-01.md).

## v0.22.12 — 2026-06-01

Daily Brief — stock price and Wheel capital requirement on pick cards. Each pick now shows the last known price (`$245.30`). Wheel picks additionally show the CSP buying-power requirement (`~$24,530 cap` = price × 100) so you can gauge capital needs before opening Strategy Lab. `BriefPick.price` added to shared types; populated from `signalData.lastPrice` in the brief job at no extra DB cost. See [`changelogs/v0.22.12_2026-06-01.md`](changelogs/v0.22.12_2026-06-01.md).

## v0.22.11 — 2026-06-01

Fix Strategy Lab scrolling. Root div had no `overflow-y: auto` so `.main`'s `overflow: hidden` clipped the list after ~6–8 rows — C/F grades were rendered but unreachable. Added `overflowY: auto` + `height: 100%` to the root container. See [`changelogs/v0.22.11_2026-06-01.md`](changelogs/v0.22.11_2026-06-01.md).

## v0.22.10 — 2026-06-01

Daily Brief — Strategy Lab grade alignment on pick cards. Each validated pick now shows the grade for the strategy-relevant structure (e.g. `CSP  B`) and the best overall fit when they differ (e.g. `·  Best fit: Reverse Big Lizard  A+`). Makes the gap between stock-level scoring and live-chain execution immediately visible. See [`changelogs/v0.22.10_2026-06-01.md`](changelogs/v0.22.10_2026-06-01.md).

## v0.22.9 — 2026-06-01

Daily Intelligence Brief UI redesign. Previous layout had zero CSS — signal labels, scores, and badges were unstyled inline text. New design: bordered rounded strategy sections with collapsible headers (emoji prefix, pick count pill), two-column pick cards (circular rank badge | ticker · score badge · Validated chip · Strategy Lab button), signal chips with human-readable labels and smart value formatting, italic AI rationale with left-border accent. See [`changelogs/v0.22.9_2026-06-01.md`](changelogs/v0.22.9_2026-06-01.md).

## v0.22.8 — 2026-06-01

Daily Technical Signals batch job. New `DailyTechnicalSignalsJob` runs nightly after price-gap-fill — reads `historical_prices`, computes MACD, RSI, Bollinger Bands, SMA stack, candlestick patterns, and a `buySignalScore` (0–100, mirrors Validate screen logic), then upserts to a new `technical_signals` table. `ScoringService` now reads `buySignalScore` from this table, enabling the scoring engine to include buy-signal strength as a signal for the **Buy** (weight 20) and **Bullish** (weight 15) strategies without any live API calls. See [`changelogs/v0.22.8_2026-06-01.md`](changelogs/v0.22.8_2026-06-01.md).

## v0.22.7 — 2026-06-01

Daily Intelligence Brief & Trade Scoring Engine. New capability: configurable per-strategy scoring engine (5 strategies × expert-backed weights) + post-market batch job that screens the universe, scores candidates, validates top picks via E*Trade Strategy Lab, synthesizes AI rationale (Claude Haiku), and persists a dated brief. Two new sidebar views: **Daily Brief** (ranked picks per strategy, AI rationale, → Strategy Lab button, history dropdown) and **Trade Scoring Config** (weight sliders, signal toggles, version labels, Reset to Baseline). Two new computed signal fields: `priceMomentumPct` (52-week return from `historical_prices`) and `breakoutScore` (MA alignment + price near support). Phase 2 signal slots (`relativeStrengthVsSpy`, `sectorMomentum`) reserved in config as disabled placeholders. See [`changelogs/v0.22.7_2026-06-01.md`](changelogs/v0.22.7_2026-06-01.md).

## v0.22.6 — 2026-06-01

Batch Jobs sequence order — move to edit modal. Removed ▲/▼ buttons from the job table. The `#` column now shows the sequence number read-only. Sequence order is editable as a number field in the Edit Job modal (min 1). Saving updates the single job's `sequence_order` via `updateJobConfig` (no full-list reorder required). See [`changelogs/v0.22.6_2026-06-01.md`](changelogs/v0.22.6_2026-06-01.md).

## v0.22.5 — 2026-06-01

Fix Daily IV Update batch job — all tickers returned "no-data". Two bugs: (1) `etrade-options.ts` looked for `currentPrice` in `OptionChainResponse` but E*Trade returns the underlying price as `nearPrice` — so `underlyingPrice` was always `null`, causing `captureFromEtradeChain` to bail out immediately on every ticker. Fixed by checking `nearPrice` first with `currentPrice` as fallback. (2) `OptionContract.iv` is a decimal fraction (0.285 = 28.5%) but `captureFromEtradeChain` passed it straight to `computeAtmIv` with a wrong "already a percentage" comment — stored IV values would have been 100× too small. Fixed by multiplying by 100 when mapping. See [`changelogs/v0.22.5_2026-06-01.md`](changelogs/v0.22.5_2026-06-01.md).

## v0.22.4 — 2026-06-01

Batch Jobs sequence ordering. Jobs now have a `sequence_order` field; jobs with the same schedule run in that order. `BatchView` job table gains a `#` column with ▲/▼ buttons to move jobs up or down — changes persist to the DB immediately. New migration `021_batch_sequence.sql` adds the column (existing rows numbered by insertion order). `BatchService.reorderJobs(jobIds[])` writes new positions; `batch:reorder` IPC + `window.api.batch.reorderJobs` preload bridge expose it to the renderer. See [`changelogs/v0.22.4_2026-06-01.md`](changelogs/v0.22.4_2026-06-01.md).

## v0.22.3 — 2026-06-01

Single instance lock. Clicking the shortcut while TradeAnalyzer is already running now focuses the existing window instead of launching a second copy. Uses `app.requestSingleInstanceLock()` + `second-instance` event. See [`changelogs/v0.22.3_2026-06-01.md`](changelogs/v0.22.3_2026-06-01.md).

## v0.22.2 — 2026-06-01

Analysis sidebar order + per-tab default sort + Options Income extra columns. **Sidebar:** 📊 Analysis moved above 🔬 Strategy Lab. **Default sort:** Buy → Score desc; Options Income → Premium desc; Wheel → Suitability desc; Bullish/Bearish → Max Loss desc — applied on every tab switch and after each run. **Options Income:** three new columns — Bid, Ask, OI (open interest) — pulled from the selected contract; `OptionsIncomeResult` type and analysis service updated. See [`changelogs/v0.22.2_2026-06-01.md`](changelogs/v0.22.2_2026-06-01.md).

## v0.22.1 — 2026-06-01

Batch Jobs global session toggle. New toggle switch in `BatchView` header enables/disables all automatic batch jobs (startup + scheduled) for the current session. Defaults ON on every launch — never persists. Manual "Run Now" is unaffected. Amber warning banner shown when disabled. See [`changelogs/v0.22.1_2026-06-01.md`](changelogs/v0.22.1_2026-06-01.md).

## v0.22.0 — 2026-06-01

Analysis Engine redesign — one-click runs all 5 modes in sequence. Mode selector removed; replaced with strategy tabs (📈 Buy / 💰 Options Income / 🎯 Wheel / 🐂 Bullish / 🐻 Bearish) that populate after run. Snapshots moved below results, newest first, with per-row delete and Clear All. Each run saves a single combined snapshot (`mode='all'`) containing all 5 mode outputs. New backend: `analyzeWatchlistAllModes()`, `saveAllModesSnapshot()`, `getAllModesSnapshot()` in analysis service; `analysis:run-all` and `analysis:get-all-modes-snapshot` IPC handlers; `runAll`/`getAllModesSnapshot` on `window.api.analysis`. Progress events now include `mode` field. See [`changelogs/v0.22.0_2026-06-01.md`](changelogs/v0.22.0_2026-06-01.md).

## v0.21.1 — 2026-06-01

Batch Jobs UI — moved Run History above Live Activity panel so completed run data is visible without scrolling past the (conditionally shown) live log. See [`changelogs/v0.21.1_2026-06-01.md`](changelogs/v0.21.1_2026-06-01.md).

## v0.21.0 — 2026-06-01

Automated Batch Jobs + Live Progress Log. Three daily background jobs now run automatically: **Daily Market Sync (Stocks)** — runs `screenerService.syncUniverse('both')` at startup (+60s) and 16:30 ET; **Daily Market Sync (ETFs)** — same for the ETF universe (+90s); **Daily Price Gap Fill** — detects tickers missing recent price history and backfills via Polygon (+120s). All three chain sequentially under the existing `BatchService` scheduler. `DailyIvCaptureJob` now auto-renews dormant E*Trade tokens and surfaces a "Reconnect" CTA notification when the midnight-rollover token must be re-authed manually. `BatchView` gains a **Live Activity** panel — streaming per-ticker log with spinner header, animated progress bar, live counters (✓ updated / — skipped / ✗ failed), monospace ticker log (max 300 events, auto-scroll, auto-clears 3s after job completes). App auto-launches on Windows login. Production DB path fixed for packaged exe (`app.getPath('userData')`). `npm run package` fixed: `CSC_IDENTITY_AUTO_DISCOVERY=false` + `win.forceCodeSigning: false` prevent winCodeSign symlink errors; Windows Developer Mode required (one-time). See [`changelogs/v0.21.0_2026-06-01.md`](changelogs/v0.21.0_2026-06-01.md).

## v0.20.0 — 2026-05-31

Strategy Lab — score and explore all 31 tastylive option strategies for any single ticker using entirely fresh live data (no cache). New **🔬 Strategy Lab** sidebar entry in the Strategy section, just above 📚 Knowledge. Two tabs: **Validate** (scores all 31 strategies — IV score, direction score, premium score, liquidity score → letter grade A+/A/B/C/F, sorted best first) and **Explore** (pick any strategy + ticker → build the concrete setup with legs, strikes, P&L summary). Live data path: fresh 90-day bars for direction bias (MA20/MA50), live `getOptionsExpirations` + `getOptionsChain` for the nearest 20–50 DTE expiry, and `iv_history` table for IV rank/percentile. Each strategy card shows expandable score bars, condition flags (✓/~✗), leg table, and action buttons: **→ Explore Strategy** (cross-tab navigation), **📈 View in Payoff** (fires existing `navigate-to-payoff` event), **✨ AI Rationale** (cost-conscious on-demand Claude haiku call ~$0.003–0.005/click). New service `StrategyLabService` with `validate()`, `explore()`, `getContext()`. New IPC file `ipc-strategy-lab.ts` with handlers `strategyLab:validate`, `strategyLab:explore`, `strategyLab:aiRationale`. All 31 strategy types added to `shared/types.ts`. See [`changelogs/v0.20.0_2026-05-31.md`](changelogs/v0.20.0_2026-05-31.md).

## v0.19.2 — 2026-05-31

History screen overhaul + price bulk load. "IV History" sidebar entry renamed to **"History"**. The Gap Fill run button removed from the History screen (it already existed in Data Sync section 3). **History screen** now hosts two sections: IV (key status, coverage summary with gap count, Step 1/2 initial load) and Price History (new Bulk Price Load — fetches 2Y daily OHLCV bars for S&P 500 / Russell 1000 / Both via Polygon, universe selector, progress bar, cancelable, coverage count displayed). **Data Sync** gains section 5 **Price Gap Fill** — finds all tickers already in `historical_prices` whose latest bar is >2 days old and refreshes the last month for each; stale count shown with a ↻ Check button. Three new IPC handlers: `historical:getUniverseTickers`, `historical:getStalePriceTickers`, `historical:getPriceTickerCount`. See [`changelogs/v0.19.2_2026-05-31.md`](changelogs/v0.19.2_2026-05-31.md).

## v0.19.1 — 2026-05-31

Closed positions sync from E*Trade transaction history. New **↓ Import Closed (YTD)** button on the Portfolio Closed tab. `EtradePortfolioService.syncClosedPositions()` fetches the full YTD transaction history via `/v1/accounts/{id}/transactions` (paginated, marker-based), classifies each transaction as open/close/expired/assigned using OCC symbol parsing, pairs open+close legs FIFO per symbol, and inserts matched closed positions into the local DB with dedup guard (ticker + position_type + entry_date + exit_date). New `portfolio:etrade:sync-closed` IPC handler + `window.api.portfolio.etrade.syncClosed()` preload bridge. See [`changelogs/v0.19.1_2026-05-31.md`](changelogs/v0.19.1_2026-05-31.md).

## v0.19.0 — 2026-05-31

Knowledge Base — tastylive strategy guide (TT1469) embedded as a quick-reference view. New `📚 Knowledge` sidebar entry at the bottom of the Strategy section. 31 option strategies extracted from the PDF across 6 categories (Bullish, Bearish, Omnidirectional, Neutral, Neutral-Bullish, Neutral-Bearish). Each strategy stored as a high-resolution PNG (150 DPI) and a structured JSON one-pager in `src/renderer/src/knowledge/`. `KnowledgeView` with collapsible left drawer (search + categorized strategy list with colored section labels and active-highlight), and a content panel with **🖼 Image / 📄 Text** toggle. Image mode shows the original PDF page exactly. Text mode renders structured layout: key params (Direction, IV, DTE, PoP), setup steps, risk/reward grid, Greeks row (color-coded Long/Short/Flat/Dynamic), How It Works cards (Ideal / Not Ideal / Defensive Tactics), Volatility 2-col grid, At Expiration cards, and Takeaways. Sidebar reorganized into labeled sections (Data / Analysis / Strategy / Settings / Personal). See [`changelogs/v0.19.0_2026-05-31.md`](changelogs/v0.19.0_2026-05-31.md).

## v0.18.2 — 2026-05-31

ENH-3 Portfolio Greeks Monitor. Aggregate Greeks summary bar added to `PortfolioView`, visible whenever open positions exist. Shows **Net Δ** (sum of position deltas, stock + options), **Θ/day** (daily theta income in dollars, options only), **Vega** (aggregate vega, options only), **BP Used %** (capital deployed / configured account size — hidden until account size is set), and **Expiration buckets** (count of positions expiring ≤7d / ≤14d / ≤21d, color-coded red/amber/gray). Greeks sourced from existing `PositionEtrade` E*Trade sync data — no new API calls. `accountSize` added to `AppSettings` (default 0); inline "Set account size" prompt saves via `settings.setAll`. Formula documented at `docs/formulas.md#portfolio-greeks`. See [`changelogs/v0.18.2_2026-05-31.md`](changelogs/v0.18.2_2026-05-31.md).

## v0.18.1 — 2026-05-30

**Bug fix: `atm_iv` stored as decimal fraction instead of percentage.** IVolatility API returns IV as decimal fractions (0.285 = 28.5%). The ingest path in `IvHistoryService.backfillIvHistory()` was storing them raw, and the E*Trade auto-capture path was explicitly dividing `OptionContract.iv` (already a %) by 100 before `computeAtmIv`, producing a decimal result. Both paths now store percentages: IVolatility reads are multiplied × 100 before `storeReading()`; E*Trade reads pass `c.iv` directly (no division). Migration 017 (`UPDATE iv_history SET atm_iv = atm_iv * 100`) converts all previously stored decimal rows to percentages. The `Curr IV` column in the Opportunity Dashboard now shows e.g. `30%` instead of `0.3%`. See [`changelogs/v0.18.1_2026-05-30.md`](changelogs/v0.18.1_2026-05-30.md).

## v0.18.0 — 2026-05-30

ENH-2 Opportunity Dashboard. Removed Morning Briefing screen. New `🎯 Opportunity` sidebar view with composite scoring engine: fundamentals 25% (ROE, P/E, D/E, margin, revenue growth) + IV rank 30% + technical 25% (from analysis snapshots) + premium yield 20% (estimated 1.5%/mo). Strategy mode selector (Wheel / CSP / Spreads / Bullish / Bearish) — premium-selling modes rank high IV as favorable; directional modes invert the score. Universe selector (S&P 500 / Russell 1000 / Both). All data pulled from local DB (quote cache, iv_history, screen_results, analysis_snapshots) — no additional API calls. `OpportunityService` with batch SQL queries for IV ranks (one window-function query for entire universe), quote cache lookup, latest screen fundamentals, and latest analysis snapshot scores. `ipc-opportunity.ts` + `window.api.opportunity.run()` preload bridge. `OpportunityView` with score circles, mini score bars, IV rank badges, one-click drill-in to Analysis and Options Chain views. See [`changelogs/v0.18.0_2026-05-30.md`](changelogs/v0.18.0_2026-05-30.md).

## v0.17.0 — 2026-05-30

IV History feature — true IV rank and IV percentile from 252 days of daily 30-day constant-maturity ATM IV. New `iv_history` SQLite table (migration 016). `MarketDataProvider` HTTP client for MarketData.app historical options chains. `IvHistoryService` computes ATM IV via DTE-weighted interpolation between two expirations bracketing 30 days, detects gaps, orchestrates backfill, and queries IV rank/percentile. `IvHistoryView` management screen with token config, coverage summary, Step 1/2 initial load controls, ongoing gap fill, and live progress panel. E*Trade auto-capture: silently stores today's ATM IV whenever an options chain is fetched — free, no extra API call. `window.api.ivHistory.*` preload bridge. `marketdataApiToken` added to secure encrypted storage. Formula docs added at `docs/formulas.md#iv-history`, `#atm-iv-interpolation`, `#trading-days`. See [`changelogs/v0.17.0_2026-05-30.md`](changelogs/v0.17.0_2026-05-30.md).

## v0.16.0 — 2026-05-30

Payoff Visualizer improvements + E*Trade Quote Inspector + IV History design. Payoff: fixed Anthropic API key injection (`new Anthropic({ apiKey })`), fixed `probOfProfit` tool schema type, redesigned assessment panel with structured risks/opportunities/exit guidance cards and collapsible chain drawer. E*Trade Test API: new `etrade:get-raw-quote` IPC handler calls `/v1/market/quote/{symbol}?detailFlag=ALL` and returns full raw JSON; `QuoteInspector` component in `TestApiView` auto-highlights any IV/volatility fields found in the response. Planning: `Requirements/enhancements.md` and `Requirements/iv-history-design.md` capture the full IV rank build plan. See [`changelogs/v0.16.0_2026-05-30.md`](changelogs/v0.16.0_2026-05-30.md).

## v0.15.0 — 2026-05-26

Dual-provider architecture for options data. New `OptionsProvider` interface (`options-provider.ts`) with `getOptionsExpirations`, `getOptionsChain`, `getOptionsIV`, `getOptionsIVAndPremium`. `PolygonDataProvider` implements both `DataProvider` and `OptionsProvider`. New `ETradeDataProvider` implements `OptionsProvider` using the E*Trade Market API with live OAuth tokens. Provider chosen at startup via `optionsProvider` settings key ('polygon'|'etrade'). `LeapsCspService` refactored to take separate `DataProvider` (quotes/fundamentals/bars) and `OptionsProvider` (options calls). Settings UI adds "Options Data Source" dropdown; `window.api.settings.getOptionsProvider/setOptionsProvider` bridge. Fixed 7 pre-existing TypeScript strict-mode errors. Screener filter tests updated to match Polygon-compatible defaults. See [`changelogs/v0.15.0_2026-05-26.md`](changelogs/v0.15.0_2026-05-26.md).

## v0.14.0 — 2026-05-25

LEAPS + CSP Strategy Screener. New `⚡ LEAPS+CSP` sidebar tab. Market gate (SPY trend vs 50d/200d MA, VIX level + 5d change, HYG/IEF ratio) returns PASS/CAUTION/FAIL. Universe loaded from screener cache (no redundant API calls). LEAPS candidates screened by delta 0.70–0.90, DTE 365–730, spread ≤5%, OI ≥100, extrinsic ≤15%. CSP candidates screened by delta −0.15 to −0.30, DTE 25–50, annualised return ≥12%. Cross-ticker pairing: CSP on same OR different ticker. Combined score = LEAPS sub-score × 60% + CSP sub-score × 40%. Grades A+ (≥9.0) / A / B / C / F. Results ranked table with expandable scoring breakdowns, caution flags, alternative CSPs per LEAPS, and "Mark as Opened" tracking. Migration 011. See [`changelogs/v0.14.0_2026-05-25.md`](changelogs/v0.14.0_2026-05-25.md).

## v0.13.0 — 2026-05-25

Backtesting Engine. `BacktestEngine` service with multi-strategy back-test against historical OHLCV data. IPC handlers via `ipc-backtest.ts`. `BacktestView` in renderer. `🔁 Backtest` sidebar tab.

## v0.10.0 — 2026-05-08

Phase 10: Settings Enhancements (Priority 9). Extended AppSettings with soundAlertsEnabled, autoConnectWebSocket, defaultScreenerIndex ('sp500'|'russell1000'|'both'), theme ('dark'|'light'), keyboardShortcuts config. Added Keyboard Shortcuts tab to SettingsView. Theme support via CSS variables and data-theme attribute. Conditional WebSocket auto-connect in main process based on setting. ScreenerView loads default universe from settings. See [`changelogs/v0.10.0_2026-05-08.md`](changelogs/v0.10.0_2026-05-08.md).

## v0.9.0 — 2026-05-08

Phase 9: Morning Briefing Dashboard (Priority 7) + Alerts System (Priority 8). `007_alerts.sql` migration with `alerts` table (price, position types with thresholds). `BriefingService` with market regime detection (SPY trend via 20/50 SMA, VIX classification), action items (expiring positions, delta breaches), top 15 quality setups (ROE>15%, D/E<1.0, MarketCap>$10B). `AlertsService` with price alert checking via WebSocket updates. IPC handlers: `briefing:getFull`, `briefing:refresh` and `alerts:create`, `list`, `delete`, `markTriggered`. `BriefingView` component with MarketRegimeCard (trend/vix badges), ActionItemsList (priority icons), TopSetupsTable (sortable columns). Auto-refresh every 5 minutes. See [`changelogs/v0.9.0_2026-05-08.md`](changelogs/v0.9.0_2026-05-08.md).

## v0.8.0 — 2026-05-08

Phase 8: Portfolio Tracking (Priority 6). `006_portfolio.sql` migration with `positions` table (CSP, CC, Stock types with entry/exit prices, quantities, strike/exp dates). `PortfolioService` with CRUD operations and P&L calculations. IPC handlers: `portfolio:add`, `list`, `update`, `close`, `pnlSummary`. `PortfolioView` component with add position form, Open/Closed tabs, sortable columns, P&L summary cards (total positions, unrealized/realized P&L, capital deployed, win rate). Added to sidebar navigation. See [`changelogs/v0.8.0_2026-05-08.md`](changelogs/v0.8.0_2026-05-08.md).

## v0.7.0 — 2026-05-07

Phase 7: Screener Enhancements (Priority 5). Sortable columns using `useSortable` hook on all 17+ columns (Ticker, Company, Sector, Last Price, Day %, P/E, EPS, Market Cap, Revenue Growth, EPS Growth, D/E, ROE, Margin, FCF, Current Ratio, Volume, Beta, Pass Score). Quick Actions per row: "Add to Watchlist" dropdown and "Run Analysis" button. CSV export for filtered results. Pagination (50 items per page) with page navigation. Cache status indicator in Screener header with auto-refresh warning when data >1 hour old. See [`changelogs/v0.7.0_2026-05-07.md`](changelogs/v0.7.0_2026-05-07.md).

## v0.6.0 — 2026-05-07

Phase 6: Historical Charts (Priority 4). **Database**: `005_historical_data.sql` with `historical_financials` and `historical_prices` tables, indexes, views. **Backend**: `HistoricalDataService` with `getFinancials`, `upsertFinancial`, `getPrices`, `upsertPrice`, `calculateSMA`, `getDateRangeFromTimeRange`; IPC handlers `historical:getFinancials`, `historical:getPrices`, `historical:getPricesWithSMA`, `historical:fetchFinancials`, `historical:fetchPrices`, `historical:fetchAndStore`, `historical:needsRefresh`; Polygon API integration for financials and aggregates. **Frontend**: `HistoricalFinancialChart` (Recharts Area chart with metric selector: Revenue, Net Income, EPS, EBITDA, Total Assets, Shareholders Equity, Free Cash Flow; Quarterly/Annual toggle; CSV export), `HistoricalPriceChart` (line chart with volume, timeframe selector 1M/3M/6M/1Y/2Y/5Y, 50-day SMA overlay, price change indicator; CSV export); integrated into AnalysisView with click-to-open from ticker symbols. See [`changelogs/v0.6.0_2026-05-07.md`](changelogs/v0.6.0_2026-05-07.md).

## v0.5.0 — 2026-05-07

Phase 5: Cache Management + Wheel Columns + Real-Time WebSocket. **Cache Management System**: `cache_metadata` table, `CacheManager` service, staleness tracking with 1-hour threshold, `CacheStatusIndicator` UI component (green/red with timestamp), `useCacheStatus` hook polling every 5 minutes, auto-refresh trigger. **Wheel Strategy Columns**: `WheelCalculator` service with suitability formula (ROE×30% + D/E_Quality×30% + MarketCap×20% + Stability×25%), Target Strike (Current × 0.92), Est. Premium (Strike × 1.2%), integrated into watchlist table with color coding and sortable columns via `useSortable` hook. **Real-Time WebSocket**: `WebSocketService` connecting to `wss://delayed.polygon.io/stocks`, trade/aggregate message handlers, exponential backoff reconnection (3s, 6s, 12s, 24s, 48s), `RealtimePriceTicker` component for Analysis view, live price updates in watchlist with green/red indicators, connection status in status bar. New dependencies: `ws`, `recharts`. See [`changelogs/v0.5.0_2026-05-07.md`](changelogs/v0.5.0_2026-05-07.md).

## v0.4.0 — 2026-05-02

Phase 4: Validation Dashboard Polish + Settings/Diagnostics. Chart: pattern callouts at correct price/time coordinates, entry zone band, target line (amber), stop loss, demand/supply zone labels. Section A: EPS sparkline (SVG). Full Settings panel (SettingsView): General, API & Data, Cache & Limits, Diagnostics self-check, Backup & Restore. Settings IPC (9 handlers). Diagnostics IPC. Bug fix: `detectEveningStar` guard was inverted. See [`changelogs/v0.4.0_2026-05-02.md`](changelogs/v0.4.0_2026-05-02.md).

## v0.3.0 — 2026-05-02

Phase 3: Analysis Engine + Producer/Consumer Pipeline. FR-3 fully implemented — 5 analysis modes (Buy Opportunities, Options Income, Wheel Strategy, Bullish Strategies, Bearish Strategies) over any watchlist with composite scoring, entry/stop/target, annualized returns. FR-4.4 Validate All — batch deep-dive with verdict (Strong/Acceptable/Caution/Avoid), full indicator suite. Pipeline: `TokenBucketRateLimiter` + SQLite-backed `JobQueue` for resumable batch jobs. New `analysis_snapshots` + `job_runs` + `job_progress` DB tables. Full indicator library (`computeSMA`, `computeEMA`, `computeRSI`, `computeATR`, `computeADX`, Bollinger, MACD, swing high/low) documented in `docs/formulas.md`. AnalysisView with mode cards, run/cancel, progress bar, mode-specific results, snapshot history, save-as-watchlist.

See [`changelogs/v0.3.0_2026-05-02.md`](changelogs/v0.3.0_2026-05-02.md).

## v0.2.0 — 2026-05-02

Phase 2: Index Screener. FR-2 fully implemented — S&P 500/Russell 1000 screener with 17 default filters, strict/soft-match modes, presets, run history, save-as-watchlist. Polygon DataProvider + fundamentals computer with all ratios documented in `docs/formulas.md`. Quote auto-refresh (60s) on watchlist view. Structured API + error logging (EP-3/EP-4).

See [`changelogs/v0.2.0_2026-05-02.md`](changelogs/v0.2.0_2026-05-02.md).

## v0.1.2 — 2026-05-02

Fix `rebuild:electron` so it actually swaps the better-sqlite3 binary's ABI (v0.1.1's `electron-builder install-app-deps` was a no-op when a Node binary was already in place). Replaces both rebuild scripts with a small `scripts/rebuild-better-sqlite3.mjs` helper that calls `prebuild-install --force` and derives the Electron target dynamically. `npm run dev` now opens the window cleanly and migrations run.

See [`changelogs/v0.1.2_2026-05-02.md`](changelogs/v0.1.2_2026-05-02.md).

## v0.1.1 — 2026-05-02

Swap DB driver back from `node:sqlite` to `better-sqlite3` 12.x now that VS Build Tools 2022 is installed on the dev box. Drops the `createRequire` workaround and the vitest forks-pool/`node:` externals. Adds paired `rebuild:electron` / `rebuild:node` scripts wired into `predev` / `pretest` so the native binary's ABI always matches the runtime. Tests + typecheck still green; no behavior change.

See [`changelogs/v0.1.1_2026-05-02.md`](changelogs/v0.1.1_2026-05-02.md).

## v0.1.0 — 2026-05-01

Initial scaffold. Section 7 (Engineering Practices) infrastructure in place. Phase 1 (FR-1 — watchlist management) implemented end-to-end with persistence, CSV round-trip, and tests. No market-data integration yet.

See [`changelogs/v0.1.0_2026-05-01.md`](changelogs/v0.1.0_2026-05-01.md).
