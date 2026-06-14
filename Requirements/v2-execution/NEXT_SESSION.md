# v2 Execution — Next-Session Kickoff

> Hand-off note so a fresh session resumes exactly where the build stopped. The auto-memory
> (`project_v2_execution_engine.md`) and `.ai/AI_CONTEXT.md §11` also carry this; this file
> is the explicit, paste-ready version. Last updated after **v1.1.9** (Phase 5b activation).

## Where we are

- The **entire execution-engine backend is built, tested (441 tests green), committed, and
  now ACTIVATED (mock mode)** through v1.1.9. `ExecutionEngine` is instantiated in
  `index.ts` with the `MockExecutionBroker`, engine `stopped` — drivable from the renderer
  via `ipc-execution` / `window.api.execution.*`, but **no UI yet** and **no live broker /
  auto-entries**.
- **Done:** Phase 0 (schema, migrations 045–048) · Phase 1 (`ExecutionBroker` + `MockExecutionBroker`)
  · Phase 2 (`RiskGovernor` + `risk-gate`) · Phase 3 (`ExecutionCore` + `reconciliation` +
  `market-hours` + control API `:7433`/SSE) · Phase 4 (`EntryPolicy`, `OrderManager`,
  `ExitPolicy` + `ManagementLoop`) · Phase 5a (`ExecutionEngine` assembly facade) · **Phase 5b
  (activation: instantiated in `index.ts` + `ipc-execution.ts` + `window.api.execution.*`
  + facade types in `shared/types.ts` + `execution:event` stream forwarding).**
- **Locked decisions:** headless core + Electron control panel · semi-auto approve-each ·
  segregated IBKR margin account · defined-risk only · **inflection-only at launch** ·
  limits `$10k / 5% per-trade / 5 concurrent / 10% daily-loss trip / 1 per ticker` ·
  realized+unrealized kill-switch, manual clear · **Stop = hard stop**.

## Read first

`.ai/AI_CONTEXT.md` §11 (build progress) + `Requirements/v2-execution/05-implementation-plan.md`
(per-phase ✅/🚧 with versions). Spec is `00`–`04` in this folder.

## Paste this to start

```
Read .ai/AI_CONTEXT.md §11 and Requirements/v2-execution/05-implementation-plan.md,
then continue the v2 execution build exactly where we left off.

Status: the execution engine is built, tested (441 green), committed, and now
ACTIVATED in mock mode through v1.1.9. ExecutionEngine is instantiated in
src/main/index.ts with the MockExecutionBroker (engine 'stopped'); it's drivable
from the renderer via src/main/ipc/ipc-execution.ts and window.api.execution.*
(facade types in src/shared/types.ts), with engine events forwarded over
'execution:event'. Phases 0–4 done; Phase 5a (assembly) + 5b (activation) done.

Next = Phase 5c/d: the Electron "🤝 Execution" sidebar section (App.tsx routing),
two views in src/renderer/src/views/:
  - Trading Desk: master header (PAPER/LIVE badge from getState().executionMode,
    engine state, Start/Stop/Pause, hard-Stop, kill switch trip/clear, broker
    health, capital gauges from getRiskState()), proposals queue with the approval
    flow (paper = 1-click approve/reject; live type-to-confirm scaffolded), open
    positions table, activity/audit log. Subscribe to window.api.execution.onEvent
    for live refresh.
  - Execution Settings: a config editor over exec_config via getConfig/updateConfig
    (limits, entry/exit policy knobs, eligible strategies).
Use window.api.execution.* exclusively — the backend is done; this is pure UI.

Still NO IBKR account needed for Phase 5 — keep using the mock. The account is the
wall at Phase 6 (IbkrExecutionBroker). Follow the repo discipline: tests green +
typecheck + lint, version bump + CHANGELOG + changelog file + AI_CONTEXT, one
Conventional Commit per increment, then npm run package. Serialize build steps —
don't run `npm test` while `npm run package` is mid-build (ABI race).
```

## Also keep in mind

- **Deferred to Phase 6:** the brief→`PickInput` source (map a brief's `strategyLabResult`
  → spread legs) — needs real brief data, so it lands with the IBKR integration. Until then
  the activated UI shows an engine with no auto-generated entries (correct).
- **IBKR account (Phase 6, the wall):** when approved, implement `IbkrExecutionBroker` via
  `@stoqey/ib` + IB Gateway/IBC and swap it in behind the same `ExecutionBroker` interface —
  no engine/UI changes (paper port 4002 → live 4001 is a config flip).
- **Build gotcha:** `npm test` (pretest = node ABI) and `npm run package` (prepackage =
  electron ABI) both swap the better-sqlite3 binary — never run them concurrently.

## `src/main/execution/` module map (all done)

| File | Role |
| --- | --- |
| `execution-broker.ts` | `ExecutionBroker` interface + types |
| `mock-execution-broker.ts` | deterministic mock (tests/dev) |
| `risk-gate.ts` | pure sizing + 10-check pre-trade gate |
| `risk-governor.ts` | `RiskGovernor` — config, state machine, kill switch, day-P&L, COID, audit |
| `market-hours.ts` | RTH gate + ET date/time helpers |
| `reconciliation.ts` | broker-is-truth sync + drift detection |
| `execution-core.ts` | `ExecutionCore` — cold-start reconcile, cycle, watchdog, event stream |
| `control-api.ts` | `ExecutionControlApi` — Fastify `:7433` + SSE |
| `entry-policy.ts` | `EntryPolicy` — pick → proposal |
| `order-manager.ts` | `OrderManager` — approve → order → fill → position |
| `exit-policy.ts` | `ExitPolicy.evaluate` — exit rules |
| `position-manager.ts` | `ManagementLoop` — per-cycle exits |
| `execution-engine.ts` | `ExecutionEngine` — the assembly facade (start here for activation) |
