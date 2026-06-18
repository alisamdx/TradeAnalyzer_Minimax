# v2 Execution — Next-Session Kickoff

> Hand-off note so a fresh session resumes exactly where the build stopped. The auto-memory
> (`project_v2_execution_engine.md`) and `.ai/AI_CONTEXT.md §11` also carry this; this file
> is the explicit, paste-ready version. Last updated after **v1.1.45** (Phase 6a — IBKR adapter).

## Where we are

- **Phases 0–5 COMPLETE + Phase 6a DONE (v1.1.45).** IBKR account approved; a live **TWS** paper
  session (`DUQ795672`) connects. `IbkrExecutionBroker` implements the `ExecutionBroker` seam via
  `@stoqey/ib`; `broker-factory.ts` selects mock (default) vs IBKR (`TA_EXEC_BROKER=ibkr`). The
  connection, account-summary (buying power), and positions paths are **live-verified** on paper
  (`scripts/ibkr-probe.mjs`). Pure mapping + factory tested (`tests/ibkr-execution-broker.test.ts`).
- **To run IBKR locally:** start **TWS**, log into **Paper**, enable API (Global Config → API →
  Settings: socket clients ON, port **7497**, trusted IP 127.0.0.1, Read-Only OFF), then launch the
  app with `TA_EXEC_BROKER=ibkr`. Gateway instead of TWS: add `TA_IBKR_GATEWAY=1` (port 4002).
- **Account caveat:** the live account is **Cash** with Options **Pending Approval**. Credit spreads
  (the engine's structures) need a **Reg-T margin upgrade + spread-level options approval** before
  *live* trading. The **paper** account is a margin account, so paper validation is unblocked once
  options approval propagates to paper.
- **Next: Phase 6b** — the brief→`PickInput` entry source, then live order/pricing calibration on
  paper (`priceCombo` + combo `placeOrder` + fill/commission) once options-spread approval lands.
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
execution build at Phase 6b.

Status: Phases 0–5 COMPLETE + Phase 6a DONE (v1.1.45). IbkrExecutionBroker
(src/main/execution/ibkr-execution-broker.ts) implements the ExecutionBroker seam
via @stoqey/ib; broker-factory.ts selects mock (default) vs IBKR (TA_EXEC_BROKER=ibkr).
A live TWS paper session connects; connect + reqAccountSummary (buying power) +
reqPositions are live-verified on paper (scripts/ibkr-probe.mjs). Pure mapping +
factory tested (tests/ibkr-execution-broker.test.ts, 16). NO engine/UI changes.

Phase 6b = two things:
  1. The brief→PickInput entry source: map an inflection brief's strategyLabResult
     → spread legs → PickInput[], call engine.generateEntries on the
     /exec/brief-ready handoff (the hook already exists in execution-core/control-api).
  2. Live order/pricing calibration on PAPER: verify priceCombo (BAG snapshot) +
     combo placeOrder (net-LMT, sign convention in comboLimitOrderParams) + the
     fill/commission pipeline against real paper fills. NEEDS options-spread approval
     on the paper account (currently pending). Until then, 6a's connection/account/
     positions paths are the verified surface.

To run IBKR locally: TWS logged into Paper, API enabled (port 7497, trusted IP
127.0.0.1, Read-Only OFF), launch app with TA_EXEC_BROKER=ibkr. Gateway: add
TA_IBKR_GATEWAY=1 (port 4002).

Account caveat: live account is Cash + Options Pending Approval — credit spreads need
a Reg-T margin upgrade + spread-level options before LIVE. Paper is a margin account,
so paper validation is unblocked once options approval reaches paper.

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
