# v2 Execution — Next-Session Kickoff

> Hand-off note so a fresh session resumes exactly where the build stopped. The auto-memory
> (`project_v2_execution_engine.md`) and `.ai/AI_CONTEXT.md §11` also carry this; this file
> is the explicit, paste-ready version. Last updated after **v1.1.8** (Phase 5a).

## Where we are

- The **entire execution-engine backend is built, tested (~490 tests green), and committed
  through v1.1.8** — all in `src/main/execution/`, and **still DORMANT** (not instantiated
  in `index.ts`; zero impact on the running app).
- **Done:** Phase 0 (schema, migrations 045–048) · Phase 1 (`ExecutionBroker` + `MockExecutionBroker`)
  · Phase 2 (`RiskGovernor` + `risk-gate`) · Phase 3 (`ExecutionCore` + `reconciliation` +
  `market-hours` + control API `:7433`/SSE) · Phase 4 (`EntryPolicy`, `OrderManager`,
  `ExitPolicy` + `ManagementLoop`) · Phase 5a (`ExecutionEngine` assembly facade).
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

Status: the entire execution engine BACKEND is built, tested (~490 tests green),
and committed through v1.1.8 — all in src/main/execution/, still DORMANT (not
instantiated in index.ts). Phases 0–4 done; Phase 5a (ExecutionEngine assembly) done.

Next = Phase 5b: ACTIVATION (the first non-dormant step). Build it carefully and
incrementally:
  1. Instantiate ExecutionEngine in src/main/index.ts using the MockExecutionBroker,
     engine starts 'stopped' (no real orders).
  2. Add src/main/ipc/ipc-execution.ts exposing the ExecutionEngine facade
     (getState/getConfig/updateConfig/getRiskState/getPositions/getProposals/getAudit,
     start/stop/pause, kill trip/clear, approveProposal/rejectProposal), register it.
  3. Bridge it in src/preload/index.ts as window.api.execution.* and type it in
     src/renderer/src/global.d.ts (only place window.api is declared).
  4. Forward ExecutionEngine.onEvent → webContents.send for live UI updates.
Then Phase 5c/d: the Electron "🤝 Execution" sidebar section — Trading Desk view
(PAPER/LIVE badge, engine state, start/stop/kill, positions, proposals queue +
approval flow, audit log) and Execution Settings (config editor over exec_config).

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
