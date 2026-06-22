# v2 Execution Subsystem — Risk Governor

> **Status:** Requirements (forward-looking). The safety core. Builds on `00-overview.md`
> and `01-architecture.md`. Defines the capital model, the configurable limit set, the
> pre-trade gate, the kill switch, the engine state machine, order idempotency,
> reconciliation, and the full `exec_*` schema.

---

## 2.1 Principles

1. **In-app and fail-closed.** Every limit lives in TradeAnalyzer, not the broker. Any
   uncertainty — missing data, disconnected broker, reconciliation mismatch, a limit that
   can't be evaluated — resolves to **do not take new risk**. Only risk-reducing actions
   proceed.
2. **No order bypasses the gate.** Every entry passes the pre-trade gate twice: when the
   proposal is created, **and again immediately before submission** (state may have moved
   between approval and send).
3. **The governor is the single source of risk truth.** `exec_risk_state` is its live
   ledger; the pre-trade gate reads it, never a recomputation scattered elsewhere.
4. **Defined-risk only (§0.4).** Every position has a known max loss at entry, so capital
   and daily-loss math is exact and the worst unattended outcome is bounded.

## 2.2 Capital model

- **Capital base** = the configured **capital ceiling** (default **$10,000**, configurable).
  All percentage limits are computed against this base. (Equity-based scaling — basing the
  percentages on live account equity — is a future option; v2.0 uses the fixed ceiling for
  predictability.)
- **Capital deployed** = Σ (max loss of each open position). For a defined-risk spread the
  broker's buying-power hold ≈ its max loss `(width − credit) × 100 × contracts`; for a CSP
  it's the cash-secured amount `strike × 100 × contracts`. Deployed must never exceed the
  ceiling (and in practice is bound tighter by the per-trade and concurrency limits).

## 2.3 The configurable limit set (locked defaults)

All stored in `exec_config`; all user-editable; these are the **v2.0 defaults**:

| Limit | Default | Meaning |
| --- | --- | --- |
| `capital_ceiling` | **$10,000** | Capital base; denominator for all % limits; hard cap on total deployed. |
| `max_risk_per_trade_pct` | **5%** ($500 at $10k) | A single position's max loss may not exceed this. Drives position sizing (§2.4). |
| `max_concurrent_positions` | **5** | Most open bot positions at once (range 3–5 intended for weekly-swing). |
| `daily_loss_trip_pct` | **10%** ($1,000 at $10k) | Day's loss that trips the kill switch (§2.6). |
| `max_positions_per_ticker` | **1** | No second open position on a ticker already held — concentration guard. |
| `max_positions_per_strategy` | *unset (off)* | Optional cap per strategy; off by default (concurrency limit governs). |

**Combined exposure** at defaults: 5 × 5% = **25% of capital** max simultaneously at risk.

## 2.4 Position sizing

For a candidate structure with a per-contract max loss `L`:

```
contracts = floor( (max_risk_per_trade_pct × capital_ceiling) / L )
```

- If `contracts < 1` (even one contract exceeds the per-trade risk cap) → **reject the
  proposal** with reason `exceeds_per_trade_risk`. (At $10k/5%/$500, this naturally limits
  the bot to narrower spreads — intended.)
- v2.0 default is conservative **1-lot unless sizing allows more**; the engine never sizes
  above what the per-trade cap, the concurrency cap, *and* remaining deployable capital all
  permit — the **minimum** of those constraints wins.

## 2.5 The pre-trade gate

An ordered, fail-closed checklist. **Any failure rejects** (proposal is marked rejected
with the specific reason; nothing is sent). Evaluated at proposal creation and re-evaluated
at submission:

1. **Engine state** is `running` (not stopped/paused/kill-tripped).
2. **Broker healthy** — connected, authenticated, recent heartbeat (else fail-closed).
3. **Structure is defined-risk** and on the eligible-strategy list (§0.4).
4. **Per-trade risk** — sized max loss ≤ `max_risk_per_trade_pct × ceiling`.
5. **Concurrency** — open positions < `max_concurrent_positions`.
6. **Per-ticker** — no existing open position on this ticker (`max_positions_per_ticker`).
7. **Per-strategy** — if configured, under `max_positions_per_strategy`.
8. **Deployable capital** — `deployed + thisMaxLoss ≤ capital_ceiling`.
9. **Buying power** — broker `getBuyingPower()` confirms the hold is available (truth check
   against the venue, not just our ledger).
10. **Daily-loss headroom** — kill switch not tripped and the day's loss is within
    `daily_loss_trip_pct`.

Every evaluation (pass or fail, with the deciding reason) is written to `exec_audit_log`.

## 2.6 Kill switch

- **Trip conditions:** (a) day's loss ≥ `daily_loss_trip_pct`; (b) **manual** user trip;
  (c) a reconciliation mismatch (§2.9); (d) sustained degraded health (§1.8) — configurable.
- **Day's-loss basis:** **realized + unrealized**, marked-to-market intraday, reset at the
  session open (00:00 ET boundary for accounting). *(Open point — see §2.12.)*
- **Trip action (default): halt new entries only.** The engine **keeps managing open
  positions** (protective + discretionary exits stay active) — a tripped kill switch is a
  safety *pause on new risk*, not a shutdown, and never force-realizes a temporary
  drawdown. (An optional stricter "hard trip → Flatten" mode is configurable but **off** by
  default.)
- **Persistence + clear:** the tripped state is persisted in `exec_risk_state`; it
  **requires an explicit manual clear** by the user (it does **not** silently auto-reset at
  the next session), so a bad day can't quietly resume trading the next morning.

## 2.7 Engine state machine

States (persisted in `exec_risk_state`): `running`, `stopped`, `paused`,
`kill_tripped`.

```
        start (→ reconcile-before-act)             trip (auto/manual)
 stopped ───────────────────────────► running ──────────────────────► kill_tripped
    ▲   ◄─────────── stop ────────────  │  ▲                                  │
    │      (hard stop; optional          │  │ pause                  clear (manual)
    │       Flatten & Stop)              │  └──────── unpause ───────┘  │
    └──────────── stop ──────────────────┴──────────── paused ◄─────────┘
```

- **`running`** — full operation (propose entries, manage exits).
- **`stopped` (hard stop, primary master control)** — engine does **nothing**: no entries,
  no exits, no management. Open positions unmanaged (defined-risk cap is the backstop).
  Guarded; offers **Flatten & Stop**.
- **`paused` (optional)** — no new entries; **keeps managing** open positions.
- **`kill_tripped`** — safety halt: no new entries, **keeps managing**; requires manual
  clear.
- **`start` always runs reconcile-before-act** (§1.8). State is persisted: restart resumes
  the prior state, never silently jumps to `running`, never clears a trip.

## 2.8 Order idempotency & state machine

- **Client order id (COID):** the core generates a unique, persisted COID *before* sending.
  The broker order is tagged with it. A retry after a network blip reuses the **same** COID
  so the broker/reconciliation can detect and refuse a duplicate — **never double-submit.**
- **Order states:** `pending` → `submitted` → `working` → (`filled` | `partially_filled` |
  `rejected` | `cancelled`). Persisted in `exec_orders`; transitions are append-logged.
- **Crash safety:** the COID and `submitted` marker are written **before** the network
  send, so a crash mid-send is recoverable — on restart, reconciliation (§2.9) matches the
  COID against broker truth to learn whether it actually landed, rather than re-sending
  blindly.
- **Partial fills on a combo:** a defined-risk spread is one BAG order, so a true legging
  partial is rare; if the broker reports a partial, the position is flagged
  `needs_attention`, working remainder is cancelled, and the user is notified — never left
  silently broken-legged.

## 2.9 Reconciliation loop

- **Purpose:** make the core's belief (`exec_positions`/`exec_orders`) match the broker's
  actual state. The broker is the source of truth.
- **Cadence:** on every order/fill event, on a short interval during market hours, and
  **always at cold start before any action** (§1.8).
- **Procedure:** pull `getOpenPositions()` + `getOrders()`/`getFills()`; match by COID and
  contract; classify each difference:
  - *Expected* (a known order filled) → update state, record fill.
  - *Unexpected* (a position/fill the core didn't initiate — e.g., a manual trade, or a
    fill for an order the core thought failed) → **mismatch**.
- **On mismatch: fail closed.** Trip the kill switch (halt new entries), flag the affected
  position `needs_attention`, notify the user. The engine never *guesses* its way back into
  a consistent state by trading.

## 2.10 Schema (`exec_*`, migration 045)

All seven `exec_*` tables ship in a **single cohesive migration `045_execution_engine.sql`**
(matching the precedent of `022_scoring_engine.sql`), with the singleton `exec_config` /
`exec_risk_state` rows seeded in-migration via `INSERT OR IGNORE`. The migration file is the
authoritative DDL; the block below is representative (the `-- NNN:` labels are logical
groupings, not separate migrations). Idempotent `CREATE TABLE IF NOT EXISTS`, count-agnostic
in tests. Timestamps use the repo idiom `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.

```sql
-- 045: execution configuration (single row, id=1)
CREATE TABLE IF NOT EXISTS exec_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  execution_mode TEXT NOT NULL DEFAULT 'paper'   -- 'paper' | 'live'
    CHECK (execution_mode IN ('paper','live')),
  capital_ceiling REAL NOT NULL DEFAULT 10000,
  max_risk_per_trade_pct REAL NOT NULL DEFAULT 5,
  max_concurrent_positions INTEGER NOT NULL DEFAULT 5,
  daily_loss_trip_pct REAL NOT NULL DEFAULT 10,
  max_positions_per_ticker INTEGER NOT NULL DEFAULT 1,
  max_positions_per_strategy INTEGER,             -- NULL = off
  eligible_strategies TEXT NOT NULL DEFAULT 'inflection',  -- launch: inflection only; add wheel later
  proposal_shelf_life_min INTEGER NOT NULL DEFAULT 120,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 046: live risk ledger / engine state (single row, id=1)
CREATE TABLE IF NOT EXISTS exec_risk_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  engine_state TEXT NOT NULL DEFAULT 'stopped'    -- running|stopped|paused|kill_tripped
    CHECK (engine_state IN ('running','stopped','paused','kill_tripped')),
  kill_switch_tripped INTEGER NOT NULL DEFAULT 0,
  kill_switch_reason TEXT,
  capital_deployed REAL NOT NULL DEFAULT 0,
  day_realized_pnl REAL NOT NULL DEFAULT 0,
  day_unrealized_pnl REAL NOT NULL DEFAULT 0,
  day_anchor_date TEXT,                           -- session the day P&L is measured against
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 047: proposals (candidate orders awaiting approval)
CREATE TABLE IF NOT EXISTS exec_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'           -- pending|approved|rejected|expired|superseded
    CHECK (status IN ('pending','approved','rejected','expired','superseded')),
  kind TEXT NOT NULL,                              -- 'entry' | 'exit'
  ticker TEXT NOT NULL,
  strategy TEXT NOT NULL,
  structure TEXT NOT NULL,                         -- 'short-put-vertical' | 'short-call-vertical' | 'csp'
  legs_json TEXT NOT NULL,                         -- priced legs (IBKR-confirmed)
  net_credit REAL,                                 -- per-share
  max_loss REAL NOT NULL,                          -- per-contract $ (sizing input)
  contracts INTEGER NOT NULL,
  source_brief_id INTEGER,                         -- provenance into v1 brief pick
  risk_check_json TEXT,                            -- gate result snapshot
  reject_reason TEXT
);

-- 048: orders (state machine)
CREATE TABLE IF NOT EXISTS exec_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id TEXT NOT NULL UNIQUE,            -- idempotency key (COID)
  proposal_id INTEGER REFERENCES exec_proposals(id),
  broker_order_id TEXT,                            -- IBKR id once known
  status TEXT NOT NULL DEFAULT 'pending'           -- pending|submitted|working|filled|partially_filled|rejected|cancelled
    CHECK (status IN ('pending','submitted','working','filled','partially_filled','rejected','cancelled')),
  side TEXT NOT NULL,                              -- 'open' | 'close'
  submitted_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 049: fills (reconciled from broker truth)
CREATE TABLE IF NOT EXISTS exec_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES exec_orders(id),
  broker_exec_id TEXT UNIQUE,                      -- dedup key from broker
  filled_at TEXT NOT NULL,
  price REAL NOT NULL,                             -- net per-share for the combo
  quantity INTEGER NOT NULL,                       -- contracts
  commission REAL
);

-- 050: managed positions (bot-owned; distinct from v1 'positions')
CREATE TABLE IF NOT EXISTS exec_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  strategy TEXT NOT NULL,
  structure TEXT NOT NULL,
  legs_json TEXT NOT NULL,
  contracts INTEGER NOT NULL,
  entry_order_id INTEGER REFERENCES exec_orders(id),
  entry_net_credit REAL,
  max_loss REAL NOT NULL,                          -- capital this position ties up
  opened_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'              -- open|closing|closed|needs_attention
    CHECK (status IN ('open','closing','closed','needs_attention')),
  exit_rule_json TEXT,                             -- profit target / stop / time-stop config snapshot
  current_mark REAL,                              -- last reconciled mark
  current_pnl REAL,
  closed_at TEXT,
  close_reason TEXT                                -- profit_target|stop|time_stop|defensive|manual|flatten
);

-- 051: append-only audit log
CREATE TABLE IF NOT EXISTS exec_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  event TEXT NOT NULL,                             -- proposal_created|approved|rejected|order_submitted|fill|exit_fired|limit_hit|kill_tripped|kill_cleared|engine_state|reconcile_mismatch|...
  ref_table TEXT, ref_id INTEGER,
  detail_json TEXT NOT NULL
);
```

*(No `UPDATE`/`DELETE` on `exec_audit_log` — append-only; enforced by convention + a
test.)*

## 2.11 Audit log

Every decision and action is appended: proposal created/approved/rejected (with gate
reasons), order submitted, fill, exit fired (with `close_reason`), limit hit, kill-switch
trip/clear, engine-state change, reconciliation mismatch. It is the forensic record for
"why did the bot do that?" — and the basis for the paper-phase review before going live.

## 2.12 Open points (need confirmation)

- **Day's-loss basis** — speced as **realized + unrealized** marked-to-market, trip =
  **halt new entries only** (keeps managing, no forced flatten). This trips on temporary
  unrealized drawdowns, which is conservative-safe (it only pauses *new* risk). Alternative:
  realized-only (won't trip on paper drawdown but ignores a deteriorating open book).
  **Lean: realized + unrealized, halt-only.** Confirm.
- **Kill-switch clear** — speced as **manual only**. Alternative: auto-clear at next
  session. **Lean: manual.** Confirm.
- **Per-strategy cap** — left **off** by default (concurrency + per-ticker suffice for
  weekly-swing). Enable later if one strategy crowds the book.
- **Eligible strategies at launch — CONFIRMED: `inflection` only.** `exec_config.
  eligible_strategies` defaults to `inflection` (the breakout bull-put/bear-call credit
  spreads — the most contained, fully defined-risk structure). **Wheel CSPs are added once
  the plumbing is proven**; income later (and only its defined-risk variants, since the
  defined-risk gate filters naked structures). Entry policy detail is `03-lifecycle`.
- **CONFIRMED:** day's-loss basis = **realized + unrealized, halt-new-entries only**;
  kill-switch reset = **manual clear only**.

## 2.13 Live preflight: spread-permission gate

The engine's entire book is **defined-risk multi-leg spreads** (inflection vertical, wheel put
credit spread, income iron condor). A broker account that lacks spread-level options permission
(e.g. IBKR **Options Level 1**, or a cash account) will *accept the connection and then reject
every combo order* — leaving the engine live but unable to trade, silently. To make that
fail-closed, **`startEngine()` runs a permission preflight in LIVE mode only** (paper is skipped
— the paper account always has full permissions, and we don't burden the soak path with a probe):

1. Connect the broker if needed (a connect failure refuses to start, reason
   `broker_connect_failed:…`).
2. `ExecutionBroker.checkSpreadPermission()` confirms the account can place a spread. The TWS API
   does **not** expose the options trading level directly, so the IBKR adapter probes with a
   **non-transmitted `whatIf` combo order** on a reference vertical (default SPY, two adjacent
   strikes on the soonest expiry): an `OrderState` back ⇒ permitted; an order **error** ⇒ not
   permitted. The whatIf never rests an order.
3. The check is **fail-closed**: not-connected, no probe buildable, a permission/eligibility
   error, an unrelated order error, or a timeout all return `ok: false`, and the engine refuses
   to start with reason `spread_permission:<code>` (`no_spread_permission` for a confirmed
   entitlement gap, `check_failed` otherwise). Outcomes are written to the audit log
   (`preflight_permission_ok` / `_failed` / `preflight_connect_failed`).

The mock broker always grants permission (a simulator models no entitlement). This is defensive
insurance for the eventual live flip; it has no effect on paper-mode operation.
