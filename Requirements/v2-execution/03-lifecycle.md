# v2 Execution Subsystem — Trade Lifecycle

> **Status:** Requirements (forward-looking). Builds on `00`–`02`. Defines the entry
> policy (configurable; inflection at launch), the exit policy (protective vs
> discretionary), the order state machine, and failure handling. All gated by the risk
> governor (§2).

---

## 3.1 Lifecycle at a glance

```
 brief pick ─► entry policy filter ─► risk gate (§2.5) ─► PROPOSAL (priced @ IBKR)
                                                              │
                                              user approves ◄─┘ (semi-auto; shelf-life)
                                                              │
                            re-run risk gate ─► SUBMIT (combo/BAG, COID) ─► working ─► FILL
                                                              │
                                                      MANAGED POSITION
                                                              │
                       ┌──────── management loop (each cycle, market hours) ────────┐
                       │  evaluate exit rules in priority order (§3.3):             │
                       │   1 protective stop      → AUTO close                      │
                       │   2 defensive expiry      → AUTO close                     │
                       │   3 profit target         → propose close (or auto)        │
                       │   4 planned/time exit     → propose close (or auto)        │
                       └────────────────────────────┬──────────────────────────────┘
                                                     │
                              CLOSE order (COID) ─► fill ─► CLOSED ─► reconcile + audit
```

## 3.2 Entry policy (configurable; **inflection** at launch)

**Signal source.** The daily brief's **inflection** picks (scoring engine + critic), read
from the v1 tables via the freshness-guaranteed path (§1.3b) after the `brief-ready`
handoff. The brief already emits the structure (`short-put-vertical` for an up-breakout,
`short-call-vertical` for a down-breakout) with strikes/legs from Strategy Lab.

> **Implemented (v1.1.46).** `brief-entry-source.ts` (`briefPickToPickInput` + `loadInflectionPickInputs`)
> maps the latest committed inflection brief's picks → `PickInput[]` (direction-locked structure via
> `pickRelevantStructure`; legs, composite, critic verdict, lab-liquidity, earnings-before-expiry from
> `earnings_calendar`, abs max loss). The `ExecutionEngine` generates entries on each **market-open
> cycle** (`generateEntriesFromLatestBrief`, fail-safe) — **not at brief-commit (16:30 ET)** — so the
> entry window, caps, filters, and live re-pricing all apply and the daily cap prevents repeats. (The
> `brief-ready` POST handoff remains for the future always-on headless service.)

**Filters (all configurable in `exec_config`; defaults shown):**

| Filter | Default | Rationale |
| --- | --- | --- |
| Eligible strategy | `inflection` | Launch scope (§2.12). |
| Critic verdict | `pass` or `caution` only — **never `flag`**, and **never a degraded verdict** | The existing adversarial gate becomes a hard pre-trade filter. **Fail-closed (v1.1.67):** if the LLM critic didn't actually run (e.g. Anthropic 529 → `CriticVerdict.degraded=true`, a rule-only fallback `pass`), the pick is rejected `critic_degraded` — the engine never trades an un-vetted brief. |
| Min composite score | `70` | Configurable entry-quality floor (inflection has no min-composite gate in v1; the engine adds one). |
| Liquidity | reuse brief `hasAdequateLiquidity` | No execution into thin chains. |
| Max new entries / day | `1` | Weekly-swing, quality-over-quantity. |
| Max new entries / week | `3` | Matches "a few quality trades/week." |
| Avoid earnings before expiry | `on` | Even defined-risk, skip event-gap surprises (configurable off). |
| Entry window (ET) | `10:00–15:00` | Skip the open's noise; leave room before close. |

**Proposal build:** take the top-ranked eligible pick(s) within the daily cap → confirm
the structure/strikes against **IBKR's live chain** (§0.6) → size contracts per §2.4 →
run the full risk gate (§2.5) → if it passes, persist an `exec_proposals` row with a
**shelf-life** (`proposal_shelf_life_min`, default 120 min) and emit the SSE/notification.

**Per-ticker dedup + count-once cap (v1.1.64):** a pick is skipped (`duplicate_ticker`) if the
engine already holds a non-closed position **or** has a `pending`/`approved` entry proposal for
that ticker — the engine never stacks a name it's already in or has in flight; the cap is a
quantity limit, not the only dedup. Repeats within one entry batch are deduped too. The daily/weekly
caps count each entry **exactly once**: a `pending`/`approved` proposal while in flight, then the
open position once filled (the proposal is retired to `superseded` on fill so it stops counting).
Without this, a fill double-counted (approved proposal *and* position), and an order that never
filled left its `approved` proposal counting forever (see §3.5 stale-order reconciliation).

**Re-price guard:** if the IBKR net credit drifts beyond a configurable tolerance between
proposal and approval, the proposal **re-prices** (new credit shown) or **expires** — the
user never approves a number that's no longer fillable.

## 3.3 Exit policy

Every managed position carries an `exit_rule_json` snapshot (so rules are fixed at entry,
not retro-changed). The management loop evaluates rules **in priority order each cycle**;
the first that triggers wins. Protective rules are **automatic** (§0.3 invariant);
discretionary rules are **propose** by default, **auto** if the user opts in.

| # | Rule | Class | Default | Action |
| --- | --- | --- | --- | --- |
| 1 | **Stop** — loss reaches `stop_multiple × credit` received (default **2×**) | Protective | on | **AUTO** close |
| 2 | **Defensive expiry** — short strike ITM within `defensive_dte` (default **2** DTE) | Protective | on | **AUTO** close (avoid assignment/pin) |
| 3 | **Profit target** — close at `profit_target_pct` of max profit (default **50%** of credit) | Discretionary | propose | propose close (or auto) |
| 4 | **Planned/time exit** — close at `hold_days` (default **5**) or `time_exit_dte` (default ~**50% of original DTE**), whichever first | Discretionary | propose | propose close (or auto) |

- Defaults encode your **weekly-swing cadence**: enter day 1, exit ~day 5 / midpoint
  before expiry (rule 4), with a 50% profit-take (rule 3) and a 2×-credit protective stop
  (rule 1) as overlays.
- **Rolling is out of v2.0** (§0.4) — all exits are **close-only**.
- A discretionary proposal that **expires unactioned** leaves the position open under
  continued protective management (rules 1–2 still active).

## 3.4 Order state machine (entry & exit)

Reuses §2.8. The full path, with the idempotency and crash-safety points called out:

1. **`pending`** — proposal approved; the core mints a **client order id (COID)** and
   writes the `exec_orders` row **before** any network call.
2. **`submitted`** — combo/BAG sent to IBKR (single net-limit order, never legged). The
   `submitted_at` marker is persisted pre-send, so a crash mid-send is recoverable by
   reconciliation (§2.9), not a blind re-send. **The combo order MUST set `eTradeOnly:false`
   + `firmQuoteOnly:false`** (built via the shared `buildComboOrder()`): newer TWS *silently
   drops* a combo order lacking them — no `orderStatus`, no error, no fill — so the order
   would sit in `submitted` forever with nothing at the broker (bug fixed v1.1.62; the engine
   path had been missing the flags even though the diagnostic scripts always set them).
3. **`working`** — IBKR acknowledges; `broker_order_id` recorded.
4. Terminal: **`filled`** (→ open/close the `exec_positions` row), **`partially_filled`**
   (flag `needs_attention`, cancel remainder, notify — §2.8), **`rejected`** (record
   reason, notify, no retry), or **`cancelled`**.
5. **Close orders** follow the identical machine with `side='close'`; on fill the position
   moves `closing → closed` with a `close_reason` (`profit_target|stop|time_stop|
   defensive|manual|flatten`).

Every transition is appended to `exec_audit_log`.

### Boot reconciliation (force-stopped-on-boot)
`engine_state` is **persisted** in `exec_risk_state`, but the **broker connection and the cycle
loop are process-local** — they are created only by `startEngine()` (`broker.connect()` +
`startLoop()`) and are **not** restored on a process restart. To avoid the engine showing
`running`/`armed` after a relaunch while actually inert (no connection, no loop → silently no
trades), app boot resets any persisted `running`/`paused` state to `stopped`
(`RiskGovernor.forceStopOnBoot()`, audited as `engine_state { action: "boot_reset" }`). A tripped
kill switch is left tripped (manual-clear only). The operator must explicitly **Start** after a
restart, which reconnects the broker and restarts the loop. (Auto-resume-on-boot was considered and
rejected as too surprising/risk-bearing for a trading engine — force-stopped is strictly more
conservative.)

## 3.5 Failure handling (all fail-closed)

| Failure | Behavior |
| --- | --- |
| **Broker disconnected / reauth needed** | No new entries (gate check 2 fails). Working orders remain at the broker; on reconnect, **reconcile before acting**. Protective management resumes once data/connection is back. Notify. |
| **Order rejected** | Persist the reject reason, mark the proposal/position, **notify; no blind retry**. A rejected *close* on a position needing protection escalates the notification. |
| **Order silently dropped / never acked** (v1.1.64) | An order stuck `pending`/`submitted` past `STALE_ORDER_MS` (90s) with no broker callback is treated as dropped: best-effort broker cancel, mark `cancelled` (`stale_no_ack`), then free the entry — OPEN → proposal `expired` (releases the cap slot); CLOSE → position back to `open` for a management retry. Runs at the start of each market cycle (`OrderManager.reconcileStaleOrders`). Guards against a fill that lands during the cancel (only frees the entry if the order row actually transitioned). |
| **Partial fill on a combo** | Position `needs_attention`; cancel working remainder; notify. Never left silently broken-legged. |
| **Data gap (no marks)** | Cannot evaluate exits → **fail-closed**: do not fire discretionary exits; protective rules that need a mark can't be computed, so **notify** and lean on the defined-risk cap + watchdog (§1.8). No guessing. |
| **Re-price drift before approval** | Proposal re-prices or expires (§3.2) — never fills at a worse-than-shown price. |
| **Reconciliation mismatch** | Trip kill switch (halt new entries), flag affected position, notify (§2.9). |
| **Approval shelf-life elapsed** | Proposal → `expired`; no action. |

## 3.6 Entry/exit parameters (added to `exec_config`)

Beyond the §2.3 risk limits, the lifecycle adds (all configurable): `min_composite_score`
(50 — lowered from 70 in migration 052; a 5-year/32,760-breakout backtest showed the
inflection composite is non- to mildly *anti*-predictive of spread outcomes, so the 70
gate selected slightly-worse trades and starved the engine — the gate is a sanity floor,
not an edge; quality control is the critic gate + defined-risk + stops/targets + caps),
`max_new_entries_per_day` (1), `max_new_entries_per_week` (3),
`avoid_earnings_before_expiry` (on), `entry_window_start`/`_end` (10:00/15:00 ET),
`proposal_shelf_life_min` (120), `reprice_tolerance_pct`, `stop_multiple` (2),
`defensive_dte` (2), `profit_target_pct` (50), `hold_days` (5), `time_exit_dte`
(~50% DTE), and per-discretionary-rule `propose|auto` flags. *(Protective rules have no
`propose` option — §0.3.)*

## 3.7 Open points

- **Stop semantics for a defined-risk spread** — speced as `2× credit`. Alternative
  anchors: a % of max loss, or short-strike breach. **Lean: 2× credit** (tastytrade-style,
  simple, well below the defined max). Confirm during paper tuning.
- **Profit-target / time-exit `propose` vs `auto`** — default **propose** (semi-auto, your
  click). Many traders move profit-takes to `auto` once comfortable; left as a per-rule
  toggle.
- **Min-composite floor (70)** — inherited from the bearish-gate intuition; tune against
  paper-phase inflection results before live.
- These are **paper-phase tuning knobs**, not blockers — defaults are sensible; the audit
  log (§2.11) provides the data to tune them before going live.
