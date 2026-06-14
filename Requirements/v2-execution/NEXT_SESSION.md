# v2 Execution — Next-Session Kickoff

> Hand-off note so a fresh session resumes exactly where the build stopped. The auto-memory
> (`project_v2_execution_engine.md`) and `.ai/AI_CONTEXT.md §11` also carry this; this file
> is the explicit, paste-ready version. Last updated after **v1.1.10** (Phase 5c/d UI — Phase 5 COMPLETE).

## Where we are

- **Phases 0–5 are COMPLETE.** The execution engine is built, tested (441 green), committed,
  **activated in mock mode, and fully drivable from the Electron UI** through v1.1.10. The
  whole product is demonstrable end-to-end with **no IBKR account**.
- **The next step (Phase 6) is THE WALL — it needs the pending IBKR paper account.**
- **Done:** Phase 0 (schema, migrations 045–048) · Phase 1 (`ExecutionBroker` + `MockExecutionBroker`)
  · Phase 2 (`RiskGovernor` + `risk-gate`) · Phase 3 (`ExecutionCore` + `reconciliation` +
  `market-hours` + control API `:7433`/SSE) · Phase 4 (`EntryPolicy`, `OrderManager`,
  `ExitPolicy` + `ManagementLoop`) · Phase 5a (`ExecutionEngine` assembly) · Phase 5b
  (activation: `index.ts` + `ipc-execution.ts` + `window.api.execution.*` + facade types +
  `execution:event` stream) · **Phase 5c/d (UI: 🤝 Execution sidebar section — `TradingDeskView`
  + `ExecutionSettingsView`).**
- **Locked decisions:** headless core + Electron control panel · semi-auto approve-each ·
  segregated IBKR margin account · defined-risk only · **inflection-only at launch** ·
  limits `$10k / 5% per-trade / 5 concurrent / 10% daily-loss trip / 1 per ticker` ·
  realized+unrealized kill-switch, manual clear · **Stop = hard stop**.

## Read first

`.ai/AI_CONTEXT.md` §11 (build progress) + `Requirements/v2-execution/05-implementation-plan.md`
(per-phase ✅/🚧 with versions). Spec is `00`–`04` in this folder.

## Paste this to start

```
Read .ai/AI_CONTEXT.md §11 and Requirements/v2-execution/05-implementation-plan.md
(+ 01-architecture.md §1.4/§1.5 and 03-lifecycle.md §3.2), then continue the v2
execution build at Phase 6.

Status: Phases 0–5 are COMPLETE through v1.1.10 — engine built, tested (441 green),
activated in mock mode, and fully drivable from the Electron "🤝 Execution" UI
(TradingDeskView + ExecutionSettingsView). Everything runs on the MockExecutionBroker.

Phase 6 = THE WALL: it needs the IBKR PAPER ACCOUNT (check it's approved first).
Two pieces, both behind seams that already exist — NO engine/UI changes:
  1. IbkrExecutionBroker (new src/main/execution/ibkr-execution-broker.ts)
     implementing the ExecutionBroker interface via @stoqey/ib + IB Gateway/IBC:
     connect (paper port 4002), contract qualification, combo/BAG orders, order +
     exec subscriptions, live combo pricing, buying-power. Run the SAME interface
     test-suite the mock passes against this adapter. Select it via
     exec_config.executionMode / a broker factory in index.ts (mock vs ibkr).
  2. The brief→PickInput entry source: map an inflection brief's strategyLabResult
     → spread legs → PickInput[], call engine.generateEntries on the
     /exec/brief-ready handoff (the hook already exists in execution-core/control-api).

If the account is NOT yet approved, there is no further mock work — Phase 5 is the
end of the no-account road. Options while waiting: polish the UI, add renderer
tests, or tune §3.7 knobs in ExecutionSettings defaults.

Repo discipline: tests green + typecheck + lint, version bump + CHANGELOG +
changelog file + AI_CONTEXT, one Conventional Commit per increment, then
npm run package. Serialize build steps — don't run `npm test` while
`npm run package` is mid-build (ABI race).
```

## Also keep in mind

- **Phase 6 needs the account — confirm IBKR paper is approved before starting.** If not
  approved, Phase 5 is the end of the buildable-without-account road.
- **The brief→`PickInput` source** (map a brief's `strategyLabResult` → spread legs) lands
  with Phase 6. Until then the UI correctly shows an engine with no auto-generated entries;
  the proposals queue stays empty unless `generateEntries` is called manually.
- **Both seams are ready:** `ExecutionBroker` (swap mock→IBKR via config/factory) and the
  `/exec/brief-ready` hook (`onBriefReady` in control-api/core). Paper port 4002 → live 4001
  is a config flip; no engine/UI changes.
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
