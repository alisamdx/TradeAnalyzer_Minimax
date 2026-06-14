# v2 Execution Subsystem — Overview & Scope

> **Status:** Requirements (forward-looking). Not yet built. These documents specify a
> **new subsystem** that moves TradeAnalyzer from decision-support (v1, read-only at the
> broker) to **placing and closing real trades**. They live here, separate from
> `Requirements/spec/`, because `spec/` is authoritative for *what exists today*. Each
> piece graduates into `spec/` (the 40-series) as it ships.
>
> **First drafted:** 2026-06-14, immediately after the v1.0.0 cut.

---

## 0.1 Why this is a new subsystem, not a feature

Everything in v1 **recommends**; nothing **acts**. The app screens, scores, briefs,
critiques, replays, and tracks an E\*Trade portfolio that it only ever *reads*. The
moment it places an order, the system's risk posture flips:

| | v1 (decision-support) | v2 (execution) |
| --- | --- | --- |
| Failure mode | best-effort (a missing field surfaces as null) | **fail-closed** (uncertainty → do not trade) |
| State | ephemeral / recomputable | **durable + audited** (real money moved) |
| Broker | read-only (E\*Trade) | **read-write** (IBKR) |
| Truth | the app's model | **the broker's fills** (reconciled) |

That categorical shift is why v2 gets its own requirement set behind a clean v1.0.0
line, its own safety doc (§2), and its own always-on runtime (§1).

## 0.2 Locked design decisions (2026-06-14)

These four are settled and frame everything downstream:

1. **Headless execution core + Electron control panel.** Execution and a continuous
   position-management loop run in an **always-on service** (sharing service code and
   the local Fastify API on `127.0.0.1:7432`). The Electron UI is a *control surface*
   that the core does not depend on — closing the window must not strand open positions.
   *(Detailed in §1 Architecture.)*

2. **Semi-auto (approve-each) on entry.** The core never opens a position on its own.
   It *proposes* every entry; the user *confirms* before anything reaches the wire.
   No autonomous entry in v2.0. *(Detailed in §3 Lifecycle.)*

3. **Segregated IBKR account.** The bot trades a dedicated, **ring-fenced** IBKR balance
   (paper first via the same API, then real capital, ~$10k to start), kept fully separate
   from E\*Trade manual positions. Risk accounting is over the bot's account only.

4. **In-app, fail-closed risk governor.** The capital/risk rules live in TradeAnalyzer,
   not delegated to the broker. Pre-trade gate, kill switch, idempotent order state
   machine, and a reconciliation loop against actual broker fills. *(Detailed in §2.)*

## 0.3 Exit-autonomy model (safety invariant)

Semi-auto applies to **entry**. Exits split by **trigger type**, and this split is an
invariant — not a configurable default:

- **Protective exits → always AUTOMATIC** (never gated on approval): stop-loss breach;
  daily-loss kill-switch trip; a reconciliation-discovered over-limit position; defensive
  close of a defined-risk spread going ITM into expiry (assignment/pin risk). A
  protective trigger that waited for a human tap would defeat the entire risk system.
- **Discretionary exits → APPROVE-EACH** (proposed, user confirms): profit target hit
  (e.g. 50% of max profit); time stop (e.g. manage at 21 DTE); any user-initiated close.

**Configurability:** all exit *thresholds* are user-configurable; each *discretionary*
exit type may be set to `propose` (default) or `auto`. **Protective exits can never be
downgraded to `propose`.** A discretionary proposal that expires unactioned leaves the
position open under continued protective management.

## 0.35 Unattended-safety invariant (foundational)

The control panel (Electron UI) is for **visibility and approvals — never for safety**.
All safety lives in the headless core (§2 risk governor, fail-closed posture), so whether
the UI is connected changes nothing about how safe the system is. From this follows the
governing invariant:

> **Unattended, the engine can only ever *reduce* risk — never *add* it.**

- **Entries are structurally impossible without a human.** Semi-auto means the core
  *proposes*; it cannot place an entry without explicit approval. With no UI connected, a
  proposal simply waits and expires — the worst case is that *nothing opens*.
- **The only autonomous money-moving action is a protective exit** (stop / kill-switch /
  defensive expiry), and those are **always risk-reducing** (close/cancel, never open).
- **Even if the core goes completely dark** (crash, broker/internet down) at the worst
  moment, **defined-risk scope (§0.4) caps the loss at the spread width accepted at
  entry** — the worst unattended outcome is bounded and known the moment the trade opens,
  with no dependence on the engine being alive. This is a primary reason v2.0 is
  defined-risk-only.
- A **health watchdog** (§1.8) pushes a notification on degraded broker/cycle health, so
  the user is never *silently* exposed.

## 0.36 Data-freshness invariant (foundational)

There must be **no delay or version skew** between what the daily brief writes, what the
control panel shows, and what the trade engine reads. Guaranteed by a single
source-of-truth SQLite file (no caches/replicas), **write-capable connections only** (WAL
visibility is at commit, not checkpoint — avoiding the known readonly-connection quirk),
an explicit `brief-ready` handoff for zero poll-latency, and the panel reading execution
state only via the core's API/SSE. Mechanics + regression test in `01-architecture.md`
§1.3(b).

## 0.4 Scope of v2.0 (deliberately narrow)

**In:**
- One execution broker — **Interactive Brokers** (paper + live, same API).
- **Defined-risk structures first**: inflection bull-put / bear-call credit spreads and
  cash-secured puts — anything with a knowable max loss. Naked/undefined structures are
  **out** of v2.0.
- Entry signal source: the **Daily Brief picks** (the existing scoring engine + critic),
  filtered by a **configurable entry policy** (§3).
- Close-only exits (profit target / stop / time stop / defensive). **Rolling is deferred
  to v2.1.**
- Semi-auto approve-each on entries and discretionary exits.

**Out (later phases):**
- Autonomous (no-approval) entry.
- Rolling, scaling, and multi-account / portfolio-margin models.
- A second execution broker.
- Naked short-premium execution.

## 0.5 How v1 feeds v2 (reuse map)

The *brain* exists; v2 adds the *hands* and the *safety rails*.

| v1 asset | Role in v2 |
| --- | --- |
| Daily brief + scoring engine | Signal source — ranked picks become trade *candidates* |
| Critic | Pre-trade filter — only `pass`/`caution` may become proposals; `flag` never trades |
| Strategy Lab / payoff-service | Order blueprint — existing multi-leg structures → broker order |
| Brief Replay / backtest | Confidence weighting — per-strategy edge gates which strategies trade live |
| position-analysis / Greeks math | Reused to monitor the bot's managed positions |
| Batch scheduler + rate limiter | Hosts the execution + position-management loops |
| Fastify API (7432) | Control surface the Electron panel talks to |

**New, with no v1 analog:** the order state machine, the reconciliation loop, the risk
governor / kill switch, the approve-each proposal queue, and IBKR-gateway connection
management.

## 0.6 Data-vs-execution broker split (architectural note)

v1 options data is **E\*Trade**; execution is **IBKR**. Quotes differ slightly between
brokers, so the engine must **price the actual order off IBKR's chain at execution time**
— E\*Trade still drives the brief/analysis upstream, but the order's net credit and
strike selection are confirmed against the venue that will fill it. Never trust a stale
cross-broker price on a live order.

## 0.65 Broker logistics (verified 2026-06-14)

Confirmed against current sources before committing to IBKR:

- **Account:** IBKR Pro, individual **Reg-T margin** account. Margin (not cash) is the
  recommendation purely for capital efficiency — a defined-risk spread's buying-power
  hold equals its max loss `(width − credit) × 100`, with no settled-cash/T+1 friction.
- **PDT is gone.** The SEC approved amending FINRA Rule 4210 (Apr 14 2026); the $25k
  Pattern-Day-Trader minimum and the PDT designation are **eliminated effective
  Jun 4 2026**, replaced by a modernized intraday-margin standard (brokers have until
  Oct 2027 to fully implement). The $10k start is unconstrained by PDT. (This is *not* a
  reason to be cavalier — the risk governor still enforces our own limits.)
- **Trading cadence (design default):** weekly swing — a few quality trades/week, enter
  day 1, exit by a forward target / time stop / ~midpoint before expiry. **Multi-day
  holds, not intraday round-trips.** Day-trading is explicitly out of v2.0.
- **Market data:** US Securities Snapshot & Futures Value Bundle, ~$10/mo for
  **non-professionals**, **includes OPRA (US options)**, and is **waived above ~$30/mo
  commissions**. Non-professional status must be preserved (the questionnaire) — pro
  fees are 10–50×.
- **API:** IB Gateway + TWS API; paper port **4002**, live **4001**. Node client
  `@stoqey/ib`. **IBC** automates the Gateway lifecycle so authentication is needed only
  **once per week** (first run after 01:00 ET Sunday), with daily auto-restarts and 2FA
  handling — the headless core (§1) manages this weekly login, not a daily one.
- **Pacing:** ~50 msg/s, throttled historical-data requests, ~100 default streaming
  lines — far above a low-frequency swing bot's needs.

## 0.7 Document set

| # | File | Covers |
| --- | --- | --- |
| 00 | `00-overview.md` | This document — scope, the v1/v2 boundary, locked decisions, reuse map |
| 01 | `01-architecture.md` | Headless core, `ExecutionBroker` interface, IBKR adapter, the loops, new tables, process/runtime model |
| 02 | `02-risk-governor.md` | Capital model, pre-trade gate, kill switch, idempotency, reconciliation (the safety core) |
| 03 | `03-lifecycle.md` | Entry policy (configurable), exit policy, order state machine, failure handling |
| 04 | `04-ux.md` | Trading Desk view, proposal/approval flow, rules-config surface, notifications |

*(01–04 to be drafted next.)*

## 0.8 Glossary (v2 additions)

| Term | Definition |
| --- | --- |
| **Execution core** | The always-on headless service that owns order placement and position management, independent of the Electron window. |
| **ExecutionBroker** | The interface abstracting order placement/cancellation/fills/positions; IBKR is the first (and v2.0-only) implementation. Paper vs live is a config of the same interface. |
| **Proposal** | A fully-specified candidate order awaiting user approval (semi-auto). Has a shelf-life; expires or re-prices if not actioned. |
| **Managed position** | A position opened by the bot, tracked in the bot's own store (distinct from the read-only E\*Trade portfolio mirror). |
| **Risk governor** | The in-app, fail-closed pre-trade gate + runtime limits that no order may bypass. |
| **Kill switch** | A halt that stops new entries (and may flatten per policy) when a daily-loss or hard-limit trigger fires; manually triggerable too. |
| **Protective vs discretionary exit** | Protective = automatic (safety); discretionary = approve-each (profit-take / time stop). See §0.3. |
| **Reconciliation** | The loop that makes the bot's belief about its positions match the broker's actual fills; a mismatch fails closed. |
| **Segregated account** | The dedicated, ring-fenced IBKR account the bot trades; risk accounting is over this account only. |
