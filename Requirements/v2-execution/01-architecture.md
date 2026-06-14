# v2 Execution Subsystem — Architecture

> **Status:** Requirements (forward-looking). Builds on `00-overview.md`. Specifies the
> runtime model, the broker abstraction, the IBKR adapter, the three loops, the new data,
> and exactly how the always-on core coexists with the existing Electron app.

---

## 1.1 The central problem: always-on vs a windowed app

v1 is an Electron app — it runs when the user opens it and stops when they quit. v2 needs
a position-management loop that runs **during market hours whether or not the window is
open** (to fire protective exits and manage discretionary ones). The locked decision
(§0.2) resolves this: a **headless execution core** owns execution and the loops; the
**Electron app is a control panel** that connects to it and can come and go.

Because the strategy is **weekly swing** (multi-day holds, exits at ~day 5 / midpoint, no
intraday round-trips — §0.65), the core needs *reliable market-hours uptime*, not
millisecond availability. That materially lowers the bar and shapes everything below.

## 1.2 Process & runtime model

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  Electron app (UI client)   │  HTTP   │  Execution Core (headless, daemon) │
│  - all v1 features          │ <─────> │  - ExecutionBroker (IBKR adapter)  │
│  - NEW Trading Desk views   │   +SSE  │  - entry-proposal loop             │
│  - approves proposals       │         │  - position-management loop        │
│  writes v1 tables           │         │  - reconciliation loop             │
│  reads exec_* (via API)     │         │  - risk governor (§2)              │
└──────────────┬──────────────┘         │  owns exec_* tables + IBKR conn    │
               │                         └───────────────┬──────────────────┘
               │  same SQLite file (WAL)                 │  TWS API socket
               └─────────────────────────────────────────┤
                          trade-analyzer.sqlite           │
                                                  ┌───────┴────────┐
                                                  │  IB Gateway    │  (IBC-managed,
                                                  │  paper :4002   │   weekly login)
                                                  │  live  :4001   │
                                                  └────────────────┘
```

- **The core is a separate, long-lived process**, installable to run unattended
  (Windows Scheduled Task at logon, or a service wrapper such as NSSM / `node-windows`).
  It survives the Electron window closing and can run with no UI open at all.
- **The core is the single owner of the IBKR connection.** No other process talks to
  IB Gateway — eliminates connection contention and double-submit-across-processes risk.
- **The Electron app is a client.** Its new Trading Desk views read core state and submit
  approvals over the local control API (§1.6). v1 features are untouched.

## 1.3 Coexistence with the existing app (the wrinkles, solved)

Three concrete integration problems, each with a chosen answer:

**(a) better-sqlite3 ABI split.** The known quirk: better-sqlite3 must be compiled for the
**Electron** ABI for the app and the **Node** ABI for plain Node. A second Node process
with its own binary would reintroduce that conflict. **Solution: launch the core using the
bundled Electron binary in Node mode** (`ELECTRON_RUN_AS_NODE=1 electron core.js`). It runs
as Node (no Electron app APIs) but links the **same Electron-ABI native modules** already
shipped — no second build, no ABI swap, consistent with the existing `ELECTRON_RUN_AS_NODE`
usage in the `dev` script.

**(b) Two processes, one SQLite file — and zero data drift.** SQLite in **WAL** mode
supports multiple processes (many readers + one writer, file-locked) — the project already
does live multi-process reads against the DB. **Solution + invariant: disjoint write
sets.** The core writes *only* the new `exec_*` tables; the Electron main process keeps
writing the v1 tables. Each opens its own connection with a `busy_timeout` and retries
`SQLITE_BUSY`. Cross-table reads are fine (WAL). No table is written by both processes.

**Freshness is a foundational requirement, not best-effort.** There must be *no* delay or
version skew between what the daily brief writes, what the control panel shows, and what
the trade engine reads. Enforced by:

1. **One file, one source of truth** — no second store, cache, or replica. Brief writer,
   panel, and engine operate on the same `trade-analyzer.sqlite`. There is no copied data
   that *can* drift.
2. **Write-capable connections only** — the core opens `new Database(path)` (**never**
   `readonly: true`). This is the documented fix for the known Windows quirk where a
   readonly connection cannot attach the WAL `-shm` index and silently reads only
   pre-checkpoint state (AI_CONTEXT §10). With a write-capable connection, WAL visibility
   is at **commit boundaries, not checkpoint boundaries**: the instant the brief's txn
   commits, the core sees it on its next read. **Regression test required:** assert the
   core connection is non-readonly and that a write committed by one connection is visible
   to the core's connection immediately.
3. **Explicit handoff for zero poll-latency** — when the daily-brief job completes,
   Electron main calls `POST /exec/brief-ready` so the core reads the just-committed picks
   at once; the core's poll tick is a fallback, not the primary path.
4. **Panel reads `exec_*` only via the core's API + SSE** (§1.6), never by direct DB read,
   so the engine is the single authority and the panel can never show a staler execution
   state than the engine holds.

**(c) Electron-only path/secret resolution.** Several services resolve the DB path via
`app.getPath('userData')` and secrets via DPAPI inside Electron. The core has no Electron
`app`. **Solution: factor path + secret resolution into a small shared module** that works
in both contexts (resolve `%AppData%/trade-analyzer/trade-analyzer.sqlite` directly when
no Electron `app` is present; reuse `secure-settings.ts`'s DPAPI calls, which are Node-level
and don't require the Electron app object).

**Service reuse:** the core imports the same `src/main/services/*` modules (scoring read,
providers, `withTransaction`, logger). New execution-only services live alongside them. No
service is forked.

## 1.4 The `ExecutionBroker` interface

Mirrors the existing switchable `OptionsProvider` pattern (§3 data-providers) so the broker
is swappable and **paper vs live is pure config**, never a code branch.

```ts
interface ExecutionBroker {
  // lifecycle
  connect(): Promise<void>;            // brings up / attaches the IBKR session
  isConnected(): boolean;
  onConnectionState(cb: (s: ConnState) => void): void;  // up/down/reauth-needed

  // reference / pricing (priced at the execution venue — see §0.6)
  qualifyContract(spec: LegSpec): Promise<QualifiedContract>;
  priceCombo(legs: LegSpec[]): Promise<ComboQuote>;     // live NBBO net credit/debit
  getBuyingPower(): Promise<BuyingPower>;

  // orders (idempotent — client order id required; see §2)
  placeOrder(o: OrderRequest): Promise<OrderAck>;       // combo/BAG for spreads
  cancelOrder(clientOrderId: string): Promise<void>;
  onOrderStatus(cb: (u: OrderStatusUpdate) => void): void;
  onFill(cb: (f: Fill) => void): void;

  // truth (for reconciliation — §2)
  getOpenPositions(): Promise<BrokerPosition[]>;
  getOrders(): Promise<BrokerOrder[]>;
}
```

- **One implementation in v2.0: `IbkrExecutionBroker`.** The interface exists so a second
  broker (or a pure mock for tests) can be added without touching the loops or governor.
- **Paper/live** is a setting (`executionMode: 'paper' | 'live'`) read at core startup,
  selecting Gateway port 4002 vs 4001 and the corresponding account id. Flipping it is a
  deliberate, gated action (§2 / §4), not a casual toggle.

## 1.5 The IBKR adapter

- **Transport:** `@stoqey/ib` (TypeScript TWS API client) over the IB Gateway socket.
- **Session lifecycle via IBC:** the core supervises IB Gateway through **IBC**, which
  needs a **single weekly login** (first run after 01:00 ET Sunday) and auto-restarts the
  Gateway daily, including 2FA handling. Credentials stored encrypted via `secure-settings`
  (DPAPI), same pattern as E\*Trade. The core treats `reauth-needed` as a fail-closed
  state (no new entries until reconnected; protective management continues if the socket
  is still live).
- **Spreads as combos:** multi-leg credit spreads are submitted as a **single BAG/combo
  order with a net-limit price** — never as independent legs (avoids legging risk).
- **Contract qualification** every time (conId resolution) before an order; never trust a
  cached/stale contract.
- **Execution-venue pricing (§0.6):** strike selection comes from the upstream brief
  (E\*Trade-sourced analysis), but the **order's net credit and final strikes are
  re-confirmed against IBKR's live chain at proposal time**. A proposal carries the IBKR
  price; if it drifts beyond tolerance before approval, the proposal re-prices or expires.

## 1.6 Control API + UI channel

- The **core hosts a Fastify control API** (token-authed, reusing the
  `~/.tradeanalyzer/agent.token` scheme) on its **own port** (e.g. `127.0.0.1:7433`) so it
  is reachable when the Electron window is closed. The existing agent API on `7432` (in
  Electron main) is unchanged for now; consolidation is a later cleanup.
- **Push to UI:** the core exposes **SSE (or WebSocket)** for live events — new proposal,
  order status, fill, position update, risk-state change, kill-switch trip — so the
  Trading Desk reflects state in real time without polling.
- **Endpoints (sketch):** `GET /exec/state`, `GET /exec/proposals`,
  `POST /exec/proposals/:id/approve|reject`, `GET /exec/positions`, `GET /exec/risk`,
  `POST /exec/kill-switch`, `GET /exec/audit`. Full surface in §4.
- **Approval flow:** core creates a proposal → SSE event + desktop/mobile notification →
  user opens panel (or actions the notification) → `approve` → core places the order. For
  weekly-swing entries, the proposal's shelf-life (minutes–hours, configurable) is ample.

## 1.7 New data

New, **namespaced** tables (the `exec_` prefix avoids collision with the existing v1
`positions`/`orders`-style names), added as numbered migrations **045+**. Full DDL in §2.

| Table | Purpose |
| --- | --- |
| `exec_config` | The risk/entry/exit rules (capital ceiling, per-trade & daily-loss limits, caps, eligible strategies, exit thresholds, propose-vs-auto flags). Single source of truth for the governor. |
| `exec_proposals` | Candidate orders awaiting approval (semi-auto). Status, shelf-life, priced legs, source brief pick, risk-check result. |
| `exec_orders` | Submitted orders + their state machine (client order id, status, venue ids). Idempotency key lives here. |
| `exec_fills` | Per-fill records reconciled from the broker (price, qty, commission, ts). |
| `exec_positions` | Bot-managed positions (distinct from the read-only E\*Trade portfolio mirror). Entry, structure, current mark/Greeks, exit-rule state. |
| `exec_risk_state` | Running daily P&L, capital deployed, day-trade counter, kill-switch status — the governor's live ledger. |
| `exec_audit_log` | **Append-only** record of every decision and action (proposal created, approved, order placed, fill, exit fired, limit hit, kill-switch). Non-deletable; the forensic trail. |

Secrets (IBKR login for IBC, account ids) stored encrypted via `secure-settings`.

## 1.8 Cold-start, supervision & safety posture

- **Reconcile-before-act cold start.** On every core start (including crash restart), the
  core first pulls broker positions/orders and reconciles them into `exec_*` **before**
  generating any proposal or exit. It never acts on stale local state.
- **Crash supervision.** The service wrapper auto-restarts the core; the kill-switch and
  risk state are **persisted** (`exec_risk_state`), so a restart resumes a tripped
  kill-switch rather than clearing it.
- **Market-hours / calendar gate.** Loops consult a trading-calendar + RTH gate; no
  entries outside policy windows; protective exits evaluate whenever the market is open.
- **Health watchdog / dead-man's alert.** If the core cannot reach the broker, or has not
  completed a management cycle, for N minutes during market hours, it **pushes a
  notification** so the user is never *silently* exposed and can intervene manually at the
  broker. Degraded health is itself a fail-closed state (no new entries).
- **Fail-closed everywhere.** Broker disconnected, reauth needed, reconciliation mismatch,
  data gap, or any governor uncertainty → **no new risk taken**; only risk-reducing
  actions (protective exits / cancels) proceed. Detail in §2 and §3.

## 1.9 What this doc defers

- **Risk math, the pre-trade gate, idempotency keys, reconciliation rules, full `exec_*`
  DDL** → `02-risk-governor.md`.
- **Entry policy, exit policy, order state-machine transitions, failure handling** →
  `03-lifecycle.md`.
- **Trading Desk views, proposal/approval UX, rules-config screens, notifications** →
  `04-ux.md`.

## 1.10 Open architecture questions

- **Service install mechanism on Windows:** Scheduled-Task-at-logon vs a true service
  (NSSM / `node-windows`). Logon task is simpler and runs in the user session (DPAPI
  secrets decrypt as the user); a true service runs without login but complicates DPAPI
  and IB Gateway's GUI. **Lean: Scheduled-Task-at-logon for v2.0** (matches a
  single-user desktop; the machine is on when the user trades).
- **Control-API port consolidation:** keep core on `7433` and Electron's agent API on
  `7432` for v2.0; consider merging later.
- **SSE vs WebSocket** for the UI channel — SSE is simpler and sufficient (server→client
  push only; approvals go over normal POST). **Lean: SSE.**
- **Does the core also take over the daily brief/scheduler,** or does Electron main keep
  running batch jobs? For v2.0, **leave batch jobs in Electron main** (the core only
  *reads* their output); revisit if the brief needs to run headless.
