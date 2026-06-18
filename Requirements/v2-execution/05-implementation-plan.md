# v2 Execution Subsystem — Implementation Plan

> **Status:** Build sequencing for the requirements in `00`–`04`. The guiding principle:
> **build inside-out against a `MockExecutionBroker` so phases 0–5 are fully implementable
> and testable with no IBKR account.** Only phases 6–7 need the (pending) paper account.
> Each phase ships per the repo's discipline: tests green, `CHANGELOG` + changelog file +
> `.ai/AI_CONTEXT.md` + the relevant requirement section updated, Conventional Commit, then
> `npm run package`.

---

## Strategy

The `ExecutionBroker` interface (§1.4) is the seam. A **deterministic mock** behind it lets
the entire engine — schema, risk governor, loops, policy, UI — be built and exhaustively
tested *offline*. When IBKR approves, we implement `IbkrExecutionBroker` behind the same
interface and flip a config value. **No throwaway work; the account is only needed to prove
the last mile.**

Versioning: increments land as `1.1.x` milestones; cut **`2.0.0` when live execution
ships** (paper-validated). The requirement docs graduate into `spec/` (40-series) as each
phase lands.

---

## Phase 0 — Foundations *(no broker)* — ✅ DONE (v1.1.0)

- Migration **045** (`045_execution_engine.sql`) — all seven `exec_*` tables in one
  cohesive migration (§2.10); idempotent, count-agnostic tests (`tests/exec-schema.test.ts`).
- Seed `exec_config` (locked defaults) and `exec_risk_state` (`engine_state='stopped'`).
- Shared **path + secret resolution** module that works outside Electron (§1.3c).
- Execution types in `src/shared/types.ts` (Proposal, Order, Fill, ManagedPosition,
  RiskState, ExecConfig, gate-result).
- **Deliverable:** schema + types + config, migration tests green.

## Phase 1 — Broker seam + mock *(no broker)* — ✅ DONE (v1.1.1)

- Define `ExecutionBroker` (§1.4).
- `MockExecutionBroker`: deterministic combo pricing, controllable fills (full/partial/
  reject), simulated positions/buying-power — the test + offline-dev backbone.
- Unit tests against the mock.
- **Deliverable:** the seam everything else builds on.

## Phase 2 — Risk governor *(no broker — the safety core)* — ✅ DONE (v1.1.2)

- Pre-trade gate (10 checks, §2.5), position sizing (§2.4), capital accounting, kill switch
  (§2.6), engine state machine (§2.7), COID idempotency + order state machine (§2.8).
- **Exhaustive unit tests** — this is the safety core; test every limit, every fail-closed
  path, every state transition, double-submit prevention. Include the **data-freshness
  regression test** (write-capable connection sees a fresh cross-connection commit — §1.3b).
- **Deliverable:** a governor that can be trusted, proven entirely offline.

## Phase 3 — Headless core + loops *(no broker)* — ✅ DONE (3a v1.1.3, 3b v1.1.4)

**3a (v1.1.3):** `market-hours.ts` (DST-correct RTH gate), `reconciliation.ts`
(broker-is-truth sync + drift detection), `execution-core.ts` (`ExecutionCore`: owns
broker+governor, cold-start reconcile-before-act / refuse-to-start, the management cycle
with market-hours gate + fail-closed disconnect handling + trip-on-drift, a market-cycle
hook for Phase 4 policy, health watchdog, and an event stream for the SSE layer).
**3b (v1.1.4):** `control-api.ts` (`ExecutionControlApi`) — Fastify on `:7433`, token-authed
(reuses `~/.tradeanalyzer/agent.token`): engine control (start/stop/pause + kill trip/clear),
state/config/risk/positions/audit reads, the `POST /exec/brief-ready` handoff (with a
Phase-4 `onBriefReady` hook), and an SSE stream (`/exec/events`) of the core's events.

- Core entrypoint launched via `ELECTRON_RUN_AS_NODE` (§1.3a).
- The three loops (entry-proposal / position-management / reconciliation) wired to the mock.
- Cold-start **reconcile-before-act**, market-hours/calendar gate, health watchdog (§1.8).
- Control API (Fastify `:7433`) + SSE; `POST /exec/brief-ready` handoff (§1.3b/1.6).
- **Deliverable:** a running headless engine (mock-fed) exposing live state over the API.

## Phase 4 — Entry & exit policy *(no broker)* — ✅ DONE (4a v1.1.5, 4b v1.1.6, 4c v1.1.7)

**4c (v1.1.7):** migration 048 (exit config columns + `exec_proposals.position_id`/`close_reason`)
+ `exit-policy.ts` (`ExitPolicy.evaluate`: priority-ordered stop/defensive [protective] +
profit-target/time [discretionary]) + `position-manager.ts` (`ManagementLoop.runOnce`:
protective → auto `submitClose`, discretionary → propose or auto per mode; `approveExitProposal`).
**Integration glue:** `ExecutionEngine` assembly (v1.1.8, `execution-engine.ts`) wires governor
+ broker + order manager + entry/exit policy + management loop + core (management → core
market-cycle hook) and exposes the facade the IPC/control-API call. Still dormant. **Still
pending:** a brief→`PickInput` source feeding `generateEntries` on `/exec/brief-ready` (needs
real brief data to map `strategyLabResult` → legs → lands with the IBKR integration, Phase 6).

**4a (v1.1.5):** migration 046 (entry-policy config columns) + `entry-policy.ts` (`EntryPolicy`:
`filterPick` configurable filters, `buildProposal` price→size→gate→persist, `generateEntries`
with daily/weekly caps) operating on a normalized `PickInput`. **4b (v1.1.6):** migration 047
(`exec_orders.position_id`) + `order-manager.ts` (`OrderManager`: `approveProposal` re-gates →
COID order → broker fill callbacks open `exec_positions`; `submitClose` reverses legs to close;
idempotent COID + fill dedup; both open/close flows drive the order state machine + audit).
**4c (next):** `ExitPolicy` + the management loop wired into the `ExecutionCore` market-cycle hook.

- Entry: read inflection brief picks via the freshness path, apply filters (§3.2), build +
  price proposals (via `broker.priceCombo`, mock), shelf-life + re-price guard.
- Exit: management loop evaluates rules in priority order (§3.3) — protective auto,
  discretionary propose.
- Integration tests: seed a brief → proposal → approve (via API) → mock fill → manage →
  exit → reconcile → audit, end-to-end on the mock.
- **Deliverable:** the full trade lifecycle working against the mock.

## Phase 5 — Control panel (Electron UI) *(no broker)* — ✅ DONE (5a v1.1.8 · 5b v1.1.9 · 5c/d v1.1.10)

**5b (v1.1.9) — activation, the first non-dormant step.** `ExecutionEngine` is instantiated
in `src/main/index.ts` against the `MockExecutionBroker`, engine `stopped` (inert
construction). `src/main/ipc/ipc-execution.ts` (`registerExecutionIpc`) exposes the facade
(reads / config / control / approvals) as a thin pass-through; `window.api.execution.*`
(34th preload namespace) mirrors it with an `onEvent` subscription to the forwarded
`execution:event` stream. Renderer-facing facade types added to `src/shared/types.ts`.

**5c/d (v1.1.10) — control panel UI.** New **🤝 Execution** sidebar section (`App.tsx`) with
`TradingDeskView` (master PAPER/LIVE badge + engine-state pill; Engine Start/Pause/Stop
[master Stop = hard stop] + broker/health/last-cycle; Kill Switch trip/clear; Capital
deployed-vs-ceiling gauge + day P&L + trip threshold; proposals queue with Approve
[paper 1-click / live type-to-confirm] / Reject; open-positions table; audit activity log;
live via `execution.onEvent` + 15 s poll) and `ExecutionSettingsView` (editor over
`exec_config` via `getConfig`/`updateConfig`, grouped Mode/Risk/Entry/Exit, dirty-track
Save/Revert, live-mode confirmation gate). **The entire product is now demonstrable
end-to-end on the mock with no IBKR.** No auto-generated entries until the Phase-6
brief→`PickInput` source.

- **🤝 Execution** sidebar section: **Trading Desk** + **Execution Settings** (§4).
- Connect to core API/SSE; "Engine offline → Start". Master control header (PAPER/LIVE
  badge, engine state, hard-Stop, broker health, kill switch, capital gauges), proposals
  queue, open positions, activity log.
- Approval flow (paper 1-click; live type-to-confirm scaffolded), rules-config editor over
  `exec_config`, notifications (desktop + core email/push).
- **Deliverable:** the human can drive the whole mock-backed system from the UI. **At this
  point the entire product is demonstrable end-to-end without IBKR.**

## Phase 6 — IBKR adapter *(needs paper account)* — 🚧 6a DONE (v1.1.45), 6b next

**6a (v1.1.45) — the adapter + factory.** IBKR account approved; a live **TWS** paper session
connects. `IbkrExecutionBroker` (`src/main/execution/ibkr-execution-broker.ts`) implements the
`ExecutionBroker` seam via `@stoqey/ib`: lifecycle (connect on `nextValidId`, fail-closed on
1100/502/504, ignore benign data-farm notices), `qualifyContract` / `priceCombo` (BAG snapshot) /
`getBuyingPower`, idempotent combo `placeOrder` (BAG net-LMT keyed on COID) + cancel + status/fill
subscriptions, and `getOpenPositions`/`getOrders` for reconciliation. The combo net-price sign
convention is centralised in `comboLimitOrderParams()` for paper calibration. New `broker-factory.ts`
selects mock (default) vs IBKR (`TA_EXEC_BROKER=ibkr`), resolving host/port/clientId from the
`executionMode` (TWS 7497/7496, Gateway 4002/4001 via `TA_IBKR_GATEWAY=1`, or explicit
`TA_IBKR_PORT`); `index.ts` builds the broker through it. **Live-verified on paper** (no options
permission needed): handshake, `reqAccountSummary`, `reqPositions` via `scripts/ibkr-probe.mjs`.
Pure mapping + factory covered by `tests/ibkr-execution-broker.test.ts` (16). **Connection/UI/engine
unchanged — paper↔live is a port.** *Account caveat:* the live account is currently **Cash** with
Options **Pending Approval**; credit spreads need a Reg-T margin upgrade + spread-level options. The
**paper** account is a margin account, so paper validation is unblocked.

**6b part 1 (v1.1.46) — the entry source. DONE.** `brief-entry-source.ts`: `briefPickToPickInput`
(pure) selects the direction-locked defined-risk vertical from a brief pick's Strategy Lab result
(`pickRelevantStructure`) and maps it to `PickInput` (legs, composite, critic verdict, liquidity from
lab `liquidityScore` + two-sided legs, earnings-before-expiry from `earnings_calendar`, abs max loss);
`loadInflectionPickInputs` reads the latest committed inflection brief. The `ExecutionEngine`
market-cycle hook now runs **manage-then-generate** (`generateEntriesFromLatestBrief`, fail-safe).
Generation runs on the **market-open cycle**, not at brief-commit (16:30 ET), so the entry window
(10:00–15:00), caps, critic/composite filters, and live re-pricing apply; the daily cap stops repeats.
`tests/brief-entry-source.test.ts` (15).

**6b part 2 (next) — live order calibration.** Verify `priceCombo` (BAG snapshot) + combo `placeOrder`
+ the fill/commission pipeline against real paper fills. Needs options-spread approval on the paper
account; runs offline on the mock broker today.

- **Deliverable:** real (paper) fills through the same engine.

## Phase 7 — Paper-mode validation *(needs paper account)*

- Run the full pipeline on the **IBKR paper account** for weeks: brief → proposal →
  approve → fill → manage → exit → reconcile.
- Tune the §3.7 knobs (stop multiple, profit-target/time-exit, composite floor) against
  **real inflection results** via the audit log. Confirm paper fills track the modeled
  prices; validate the watchdog, reconciliation, and kill switch fire correctly live.
- **Deliverable:** evidence the system behaves as specified on a real venue.

## Phase 8 — Live promotion *(after paper validation)*

- The guarded **paper→live** toggle (§4.5): engine Stopped + checklist + type-to-confirm,
  live account (port **4001**), $10k ceiling.
- Start small; the risk governor + kill switch are the safety net.
- **Cut `2.0.0`.**

---

## What the pending account does / doesn't gate

| Buildable **now** (no account) | Needs the paper account |
| --- | --- |
| Phases 0–5: schema, governor, core, loops, full policy, **entire UI** — all tested against the mock | Phases 6–7: the IBKR adapter + paper-mode validation |

**Recommended first milestone:** Phases 0–2 (schema + broker seam + the fully-tested risk
governor). It's the highest-value, highest-assurance core, needs no account, and everything
else stands on it.

## Open sequencing notes

- **Service install** (Scheduled-Task-at-logon, §1.10) can come late in Phase 3 / early
  Phase 6 — during dev the core runs in a terminal.
- **`spec/` graduation**: fold each landed phase's behavior into a new `spec/` 40-series
  section as part of that phase's doc updates.
- **Brief dependency**: the engine only *reads* inflection picks; no change to the v1 brief
  is required for Phase 4 (the `brief-ready` ping is an additive call from the existing job).
