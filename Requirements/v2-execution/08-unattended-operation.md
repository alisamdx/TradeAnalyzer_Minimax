# v2 Execution Subsystem — Unattended Paper Operation

> **Status:** IMPLEMENTED (v1.1.58–v1.1.60). Captured 2026-06-22. Treats three coupled
> threads — full paper automation (Part A, v1.1.58), brief orchestration / freshness gate (Part B,
> v1.1.58), and a lean intraday batch (Part C, v1.1.59) — plus a Trading Desk UI redesign (Part D,
> v1.1.60) as **one feature**: *run a complete unattended paper trading day*.
>
> Companion: `01-architecture.md` (the 3 loops, control API, `ExecutionBroker` seam),
> `02-risk-governor.md` (gate, caps, kill switch, §2.13 live preflight), `03-lifecycle.md`
> (entry/exit policy), `04-ux.md` (Execution UI), `07-broker-alternatives.md`. Memory:
> `project_v2_execution_engine`.
>
> **Validation note (FR-SEY-5):** nothing here changes *which* trades the engine selects or how it
> sizes/exits them — auto-entry only removes the human click on already-selected picks; the
> freshness gate only *prevents* acting on stale picks (a safety tightening); the lean batch
> produces a **bit-identical brief** (same upstream job closure). So this feature is validation-exempt
> by construction. Any future change that trims the brief's *upstream* jobs would not be.

---

## 1. Goal & invariants

**Goal:** the operator leaves the laptop running; the system regenerates the brief mid-morning,
enters/manages/exits paper trades all day with **zero clicks**, and reports what it did in real time
and in an end-of-day digest. The operator can also run a **dry-run** (decide everything, place
nothing) to build confidence first.

**Invariants (carried from the locked v2 design):**
- **Auto-entry is PAPER-ONLY.** If `executionMode === 'live'`, the engine never auto-approves an
  entry — it falls back to semi-auto (human + type-to-confirm). The UI cannot arm "unattended" in
  live. (Auto-*exits*, incl. protective stops, remain allowed in live — they reduce risk.)
- **Every auto-entry passes the full risk gate**, re-priced live, exactly as a human approval does.
  All caps (1/day, 3/week, concurrent, per-ticker, per-sector, capital ceiling) and the kill switch
  bind unchanged.
- **Fail-closed everywhere:** disconnected broker → cycle no-op; reconcile drift → kill-switch trip;
  stale/absent brief → no entries.

---

## 2. Part A — Full paper automation (#2)

### 2.1 The arm-switch: a third behavior axis

Engine **run-state** (stopped/running/paused/kill_tripped) is unchanged. Automation is a **separate
axis** set by an arm switch in the Trading Desk header, persisted as `exec_config.automation_mode`:

| Stance (UI label) | `automation_mode` | Behavior when engine is running |
|---|---|---|
| **Off** | `semi` | Current behavior — propose entries for approval; discretionary exits per the granular exit modes; protective exits auto. |
| **Dry-run** | `dry_run` | Run the **full** cycle (pull fresh brief, evaluate entries + exits) but **place no orders** — record would-be decisions only. Nothing is sent to the broker; no positions open. |
| **Armed** | `unattended` | **Auto-approve entries (paper-only)** + **auto-fire discretionary exits**; protective exits auto. No clicks. |

- `automation_mode` is the master control. In `unattended` it implies entry auto-approve **and**
  discretionary-exit auto-fire (overriding the granular `profitTargetMode`/`timeExitMode`, which
  remain editable "advanced" knobs that only take effect in `semi`).
- **Live guard:** selecting **Armed** is disabled in live mode; and the engine enforces paper-only
  auto-entry regardless of config (defense in depth).

### 2.2 Auto-entry — IMPLEMENTED (v1.1.58)

- **`automation_mode` is the single control** (the planned separate `entry_mode` column was folded
  in — one source of truth). `unattended` ⇒ auto-entry; discretionary exits also auto-fire.
- When `unattended` **and paper**, the cycle's entry step routes each freshly-generated proposal
  straight through `OrderManager.approveProposal` (re-price + full gate) — same path as a UI click.
- **Paper-only enforced in the engine:** `tryGenerateEntries` auto-approves only when
  `executionMode === 'paper'`; live always stays semi-auto regardless of `automation_mode`.

### 2.3 The cycle loop driver (currently missing)

`ExecutionCore.startLoop(intervalMs)` exists but **is never called** — so nothing ticks unattended
today. Build:
- On engine **start → running**, start the loop; on **pause/stop**, stop it.
- Interval = new `exec_config.cycle_interval_sec` (default **120s**). Each tick already does
  reconcile → manage (auto-exits) → generate+auto-approve entries, all gated by market-hours and the
  entry window (10:00–15:00 ET).
- The loop must survive the Electron window closing (the core is headless; see `01-architecture`).

### 2.4 Dry-run mechanics

- In `dry_run`, the cycle runs entry/exit **evaluation** but short-circuits before any
  `placeOrder`/`submitClose`. Would-be decisions are written to a **dedicated `exec_dry_run_log`
  table** (RESOLVED — not a flag on `exec_proposals`, so dry-run never pollutes the real
  proposal/position/audit streams) and surfaced in the Entries/Exits tabs marked **"dry-run — not
  placed."**
- No positions open, no capital deploys, no broker contact beyond pricing reads. Lets the operator
  watch the brief→entry pipeline and freshness gate / caps behave for a few days before arming.

### 2.5 Notifications (real-time per-action + EOD digest)

Four surfaces:
1. **In-app live feed** — the Trading Desk **Live tab** (§5).
2. **Per-action email** — on each entry, each exit, each kill-switch trip (`email-service.ts`).
   Toggle `exec_config.notify_per_action`.
3. **Desktop / OS push** (RESOLVED — wanted in addition to email) — a native OS notification on the
   same per-action events, via Electron's `Notification`. Toggle `exec_config.notify_push`.
4. **End-of-day digest email** — one summary at/after close (entries, exits, P&L, rejects, any
   trips). Toggle `exec_config.notify_eod_digest`. **Fires only when Armed** (RESOLVED — no digest in
   semi/dry-run).

### 2.6 Keeping the machine awake (all-day runs)

The operator **disables OS sleep for all-day runs** (RESOLVED). Implement defensively in-app: while
**Armed** (engine running + `automation_mode='unattended'`), start an Electron
`powerSaveBlocker.start('prevent-display-sleep')` to keep the system awake; release it on
disarm/stop. Document the OS-level "don't sleep on AC" setting as the operator's belt-and-suspenders.

---

## 3. Part B — Orchestration: which brief the engine acts on (#3)

### 3.1 Decision

The engine acts on **today's intraday (~10:15 ET) brief only** — never yesterday's after-close
brief. The after-close (~17:00) brief is **review/replay-only** (it commits after the entry window
closes).

### 3.2 Brief-freshness gate (the core change)

`loadBriefPickInputs` currently takes the latest brief **by `generated_at`, no date filter**
([brief-entry-source.ts:136](../../src/main/execution/brief-entry-source.ts)). Add a gate: only
return picks from a brief whose `generated_at` **ET-date == today**. If the latest brief is
prior-day → return no picks (engine no-ops). It already computes `today = etDateString(now)`; this
is a one-line `AND`. This cleanly eliminates the 10:00–10:15 window where the engine would otherwise
grab yesterday's brief, without touching the entry-window time.

### 3.3 Sequencing — freshness gate + polling (no event hook)

The engine's periodic cycle (§2.3) picks up the fresh brief on the first tick after the ~10:15
commit; pre-commit ticks are safely no-op via the gate. **No `/exec/brief-ready` event wiring
needed** (that hook stays available for a future latency optimization). Every entry is re-priced
live + re-gated, so a cycle never trades a stale price even within a fresh brief.

### 3.4 Cadence

**One morning refresh, kept at ~10:15 ET.** The ~45-min post-open delay is deliberate — the
breakout/volume-surge signals need accumulated volume to be reliable, and the opening 30 min has the
worst spreads. With `maxNewEntriesPerDay = 1`, one fresh brief is sufficient (the engine takes its
single best entry and is done). Multiple intraday refreshes are a **future** option, only worthwhile
if the daily cap is raised to deploy more capital — and only practical because of the lean batch
(Part C).

### 3.5 The sequenced unattended day

```
~10:15 ET  orchestrator → LEAN batch (Part C) → regenerate today's brief → commit
   ↓ (next engine cycle, ~120s)
cycle (market open, in window, brief fresh by §3.2):
   reconcile → manage exits (auto) → generate entry from fresh brief → auto-approve (paper) → order → fill
... cycles keep managing positions intraday (auto protective + discretionary exits) ...
15:00 ET   entry window closes — no new entries (management continues)
~17:00 ET  orchestrator → FULL batch (lean jobs re-run w/ final bars + the deferred tail)
```

---

## 4. Part C — Lean intraday batch (#4)

### 4.1 Classification (by "does it feed the brief?")

Jobs run in registration order; the brief sits at position 8. Everything after it cannot affect
today's brief (it's already committed).

| # | Job | Feeds brief? | Lean (~10:15) | After-close (~17:00) |
|---|---|---|---|---|
| 2 | daily-iv-capture | ✅ IVR | run | run |
| 3 | market-sync (stocks) | ✅ prices/fundamentals/quotes | run | run |
| 4 | market-sync (ETFs) | ✅ sector momentum | run | run |
| 5 | daily-screener | ✅ candidate universe / cache | run | run |
| 6 | price-gap-fill | ✅ bars (breakout/beta) | run | run |
| 7 | daily-technical-signals | ✅ **breakout/volume-surge (core)** | run | run |
| 8 | **daily-intelligence-brief** | ★ is the brief | run | run |
| 9 | daily-options-snapshot | ❌ after brief | **skip** | run |
| 10 | daily-paper-snapshot | ❌ forward perf | **skip** | run |
| 11 | earnings-refresh | ❌ after brief; slow-moving | **skip** | run |
| 12 | daily-options-premium-history | ❌ durable capture | **skip** | run |

**Lean = jobs 2–8** (the brief's full upstream closure → identical brief quality). **After-close =
all 12.** The deferred tail is options-API-heavy (9, 12), so skipping it in the morning is the free
speedup that gets the operator trade-ready sooner — with **zero brief-quality loss**.

### 4.2 Mechanism — configurable per-job flag — IMPLEMENTED (v1.1.59)

- Per-job flag **`batch_jobs.after_close_only`** (migration 059; default `0`, set `1` for jobs 9–12
  via the migration UPDATE for existing installs + `registerJob({afterCloseOnly:true})` for fresh).
- The orchestrator runs a **lean filter per slot** (`isLeanSlot` pure helper): a lean slot skips
  `after_close_only` jobs; the after-close slot runs everything. Slot lean-ness = `OrchestratorJobConfig.
  leanSlots` (explicit) **or the default = every slot except the latest** (the after-close slot is the
  full run). Manual/startup runs (no slotTime) always run the full batch.
- Editable from the Batch view (§5.4) — a per-job **Lean / After-close** toggle (`batch:update-job`
  with `afterCloseOnly`), so a job can be re-classified without a code change.

### 4.3 Guardrail

The lean batch keeps the **entire upstream closure** — never trim a brief-contributing job for
speed. Any future intra-upstream trimming changes brief output and must clear FR-SEY-5 first.

---

## 5. Part D — Trading Desk UI redesign — IMPLEMENTED (v1.1.60)

### 5.1 Presentation requirements (all grids)
- Proper stylesheet; **aligned column headers**; **click-to-sort**; comfortable row density.
- **Don't show everything at once** — tabs keep each grid large enough for many rows.

### 5.2 Always-visible header (above the tabs)
- PAPER/LIVE badge + engine-state pill.
- **Arm switch** — top of the desk: **Off / Dry-run / Armed**, with the **PAPER-only guard
  prominent** (Armed disabled + explained in live) and an **"armed / running" indicator**.
- Existing controls: Start / Pause / Stop, Kill Switch trip/clear, capital-deployed gauge, day P&L,
  health/broker status.

### 5.3 Tabs

| # | Tab | Grid / content |
|---|---|---|
| 1 | **Live / Notifications** | Default landing. Real-time activity feed + the **daily activity timeline** (§5.5). The live display. |
| 2 | **Proposals** | **Surfaced/badged only when human intervention is needed** (pending approve/reject). Quietly empty when armed-unattended; **auto-focuses** (RESOLVED) the moment a new pending proposal appears. |
| 3 | **Entries** | Today's entries + reason (incl. dry-run "not placed" rows). |
| 4 | **Exits** | Today's exits + reason (protective vs discretionary). |
| 5 | **Rejects** | Today's rejected candidates + gate reason. |
| 6 | **Positions** | All open positions. |
| 7 | **Activity Log** | Full audit trail. |

### 5.4 Batch view additions — IMPLEMENTED (v1.1.59)
- Per-job **Lean / After-close** badge (a **Slot** column) reflecting `after_close_only`, **toggleable
  inline**; the orchestrator row shows its lean slots.
- **Brief-freshness banner** (`batch:brief-freshness`): "✓ Today's brief committed …" / "⚠ Latest brief
  is … (not today)" — at-a-glance whether the engine has a fresh brief to act on.
- (Not built: a dedicated next-slot-preview beyond the orchestrator row's lean-slot label.)

### 5.5 Daily activity timeline
A horizontal "story of the day" at the top of the Live tab: market open/close markers, shaded entry
window, and pinned events (`10:17 brief committed · 10:48 entered AMAT 580/575 put spread · 13:20
profit-target exit XYZ · kill clear`). Turns the audit log into a glanceable day-in-review.

---

## 6. Config / schema additions (consolidated)

`exec_config` (new columns — migration 058, IMPLEMENTED; no CHECK constraints, governor validates
the `automation_mode` enum defensively):
- `automation_mode TEXT NOT NULL DEFAULT 'semi'`   (semi | dry_run | unattended — sole control)
- `cycle_interval_sec INTEGER NOT NULL DEFAULT 120`
- `notify_per_action INTEGER NOT NULL DEFAULT 1`
- `notify_push INTEGER NOT NULL DEFAULT 1`
- `notify_eod_digest INTEGER NOT NULL DEFAULT 1`  (digest only emitted when Armed)

`batch_jobs` (new column):
- `after_close_only INTEGER NOT NULL DEFAULT 0` (set `1` for jobs 9–12 in the migration)

New table **`exec_dry_run_log`** (dry-run decisions, kept separate from `exec_proposals`): at minimum
`id, at, kind ('entry'|'exit'), ticker, strategy, structure, legs_json, net_credit, max_loss,
contracts, would_be_action, reason`.

`ExecConfig` (src/shared/types.ts) gains the matching fields; `RiskGovernor` get/updateConfig map
them; orchestrator slot config carries `lean`.

---

## 7. Code touchpoints
- `src/main/execution/execution-engine.ts` — auto-approve in the entry step when `entry_mode='auto'`
  (paper-only); dry-run short-circuit; start/stop the loop with run-state.
- `src/main/execution/execution-core.ts` — `startLoop` wiring + interval from config.
- `src/main/execution/brief-entry-source.ts` — freshness gate in `loadBriefPickInputs`.
- `src/main/execution/position-manager.ts` — already auto/propose-capable; honor `automation_mode`.
- `src/main/services/jobs/batch-orchestrator-job.ts` + `batch-service.ts` — per-slot lean filter on
  `after_close_only`.
- `src/main/services/email-service.ts` — per-action + EOD digest emails.
- `src/renderer/src/views/TradingDeskView.tsx` — tabbed redesign, arm switch, grids, timeline.
- `src/renderer/src/views/ExecutionSettingsView.tsx` — automation/notify config.
- `src/renderer/src/views/BatchView.tsx` — lean badges, freshness banner, next-slot.
- Migration: the new `exec_config` + `batch_jobs` columns.

---

## 8. Suggested build phases (for a future session)
1. **Config + schema** — migration, `ExecConfig` fields, governor mapping, settings UI stubs.
2. **Brief freshness gate** (#3) — smallest, independently testable safety win.
3. **Lean batch** (#4) — `after_close_only` flag + orchestrator per-slot filter + Batch view.
4. **Loop driver + auto-entry + dry-run** (#2 core) — paper-only enforcement, full gate path, tests.
5. **Notifications** — per-action + EOD digest.
6. **Trading Desk redesign** — tabs, arm switch, grids, activity timeline.

Each phase ships against the mock broker with no IBKR; tests mirror the existing
`tests/execution-*.test.ts` patterns. All steps are validation-exempt per §0 (no trade-selection
change).

---

## 9. Resolved decisions (2026-06-22)
- **Dry-run storage** → a dedicated **`exec_dry_run_log`** table (§2.4, §6).
- **EOD digest** → fires **only when Armed** (§2.5).
- **Laptop sleep** → **disable OS sleep** for all-day runs; in-app `powerSaveBlocker` while Armed +
  operator OS setting (§2.6).
- **Notification channel** → email **and** desktop/OS push, plus the in-app Live feed (§2.5).
- **Proposals tab** → **auto-focus** on a new pending proposal (§5.3).

All open questions resolved — requirements are final pending operator sign-off.
