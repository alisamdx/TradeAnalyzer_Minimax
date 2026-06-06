# Batch Performance — Intraday Run Speed
_Created: 2026-06-05 | App version: v0.23.7_

---

## Problem Statement

Running "Run All in Sequence" during market hours takes 40–60 minutes end-to-end
(IV Update ~20–40 min + Options Snapshot ~20 min + Brief generation). The goal is to
be able to trigger a full refresh mid-day and get actionable output — primarily the
Daily Brief — quickly enough to act on intraday market conditions.

**Key constraints:**
- All E*Trade jobs must remain sequential — parallel E*Trade calls will hit rate limits
- No staleness tolerance: IV job must re-capture even if today's row already exists
  (the point of running it multiple times a day is to track IV movement intraday)
- Strategy Lab and Options Chain views fetch live data per ticker on demand — they
  are not part of the batch bottleneck
- Polygon-based jobs (Market Sync, Price Gap Fill) do not share E*Trade rate limits

---

## Current Timing Breakdown

| Job | Approx Duration | Provider | Notes |
|-----|----------------|----------|-------|
| Daily Market Sync (Stocks) | 1–5 min | Polygon | Not a bottleneck |
| Daily Market Sync (ETFs) | ~5 sec | Polygon | Negligible |
| Daily Screener | ~10 sec | DB only | Pure cache reads after Market Sync |
| Daily Price Gap Fill | ~0 | Polygon | Negligible |
| Daily Technical Signals | ~0–1 sec | DB only | Negligible |
| Daily IV Update | **~11 min** ✅ | E*Trade | Was 42 min at 1100ms; now 200ms |
| Daily Options Snapshot | **~10-11 min** ✅ | E*Trade | Full universe ~1,100 tickers at 0.57s/ticker (was 300 tickers/10 min) |
| Daily Intelligence Brief | ~1 min | DB + AI | Not a bottleneck |
| **Total (sequential)** | **~16–17 min** | | Down from ~75–90 min |

---

## Requirements

### PERF-1 — Reduce IV Update inter-call delay ✅ Done v0.24.5

**Result:** Tested 200ms, 300ms, 600ms — no 429 rate-limit errors at any level.
200ms confirmed stable across full 1,068-ticker run.

| Run | Time | Delay |
|-----|------|-------|
| Jun 5, 10:00 AM | 41m 59s | 1,100ms |
| Jun 5, 9:40 PM  | 11m 10s | **200ms** |

73% reduction. Per-ticker time also benefits from lower E*Trade server load post-market.
Configurable delay (200–2000ms) wired into Edit Job modal for both IV Update and
Options Snapshot. Default remains 1,100ms for safety on fresh installs.

### PERF-3 — Remove intraday skip for IV Update (High Priority)

**Current:** The IV job skips tickers that already have a row in `iv_history` for today.  
**Problem:** This makes sense for a once-daily overnight run but defeats the purpose of
running it multiple times during the trading day to track IV movement.  
**Requirement:**
- Remove (or make configurable via a job setting) the "already have today's row" skip
- When running intraday, always re-fetch and upsert — overwrite today's row with the
  latest ATM IV value
- The existing `captureFromEtradeChain` method writes with `INSERT OR REPLACE` so the
  DB layer already handles this correctly — only the job-level skip logic needs to change
- Add a job-level toggle in the Edit Job modal: **"Re-capture if today's row exists"**
  (default ON for intraday use, could be turned OFF for overnight runs to save calls)

### PERF-4 — Run Polygon jobs in parallel with E*Trade jobs (Medium Priority)

**Problem:** Market Sync and Price Gap Fill hit Polygon only — they have no dependency
on E*Trade and no shared rate limit. Running them sequentially after slow E*Trade jobs
wastes wall-clock time.

**Requirement:**
- When "Run All in Sequence" is triggered, detect which jobs use independent providers
  and allow them to run concurrently with the E*Trade job sequence
- Specifically: Market Sync (Stocks), Market Sync (ETFs), and Price Gap Fill can all
  start concurrently while the IV Update is running
- The Daily Brief must still wait until IV Update and Options Snapshot are complete
  (it reads IV rank from the DB)
- The Batch UI should reflect multiple simultaneous running jobs clearly
- Each job still has its own cancel control

### PERF-5 — "Intraday Refresh" preset run mode (Medium Priority)

**Problem:** Market Sync and Price Gap Fill are post-market jobs — they update historical
bars and fundamentals. Re-running these mid-day adds 30+ minutes for data that won't
change until after close. The user only needs IV + Options + Brief for intraday decisions.

**Requirement:**
- Add an **"Intraday Refresh"** button alongside "Run All in Sequence"
- This preset runs only: Daily IV Update → Options Snapshot → Daily Brief (in sequence)
- Skips: Market Sync (Stocks), Market Sync (ETFs), Price Gap Fill, and any other
  post-market jobs
- The button is only enabled if all three intraday jobs are enabled
- Label clearly as "Intraday" so the user knows it's the fast path

### PERF-7 — Daily Screener batch job (High Priority) ✅ Done v0.24.3

**Problem:** `screen_results` was only populated when you manually opened the Screener tab.
The Daily Brief and Options Snapshot read from the most recent `screen_results` row —
if that row was from a prior day, the Brief was scoring stale candidates even after Market
Sync had refreshed all the underlying cache data.

**Requirement:**
- New `DailyScreenerJob` runs after Market Sync in the batch sequence
- Pass 1: S&P 500 + Russell 1000, strict mode, using the user's saved default preset
  (falls back to DEFAULT_FILTER_SPECS enabled defaults if no preset saved)
- Pass 2: ETF universe, soft mode, filters: avg_volume ≥ 500 k + price ≥ $10
- Each pass saves its own `screen_runs` row
- `loadCandidates` in Daily Brief and Options Snapshot updated to merge ALL runs
  created today (ET date) so both the stocks and ETF runs feed into the candidate pool
- Falls back to most-recent single run when no today-runs exist (backward-compatible
  with manual screener runs)

---

### PERF-8 — Options Snapshot candidate sort order regression (High Priority)

**Problem:** Before v0.24.4, `loadTopCandidates()` in `DailyOptionsSnapshotJob` pulled
the top 300 candidates sorted by `passScore` descending — highest-quality stocks first.
After v0.24.4's full-universe refactor, the query reads from `constituents` directly and
sorts `ORDER BY ticker ASC`, so it now takes the first 300 **alphabetically** (AAPL,
ABBV, ABT… ZTS never gets included). This is a silent regression — the job still runs
and produces results, but it no longer prioritises the best candidates.

**Requirement:**
- `loadTopCandidates(limit)` must select the 300 most actionable tickers, not
  the first 300 alphabetically.
- Sort priority (descending quality):
  1. IV rank from `iv_history` (high IV = rich premium, best options candidates)
  2. `buySignalScore` from `technical_signals` as secondary sort
  3. Alphabetical as final tiebreaker
- Tickers with no `iv_history` row are deprioritised (sorted after those that have IV data)
- `MAX_TICKERS = 300` cap stays in place to keep runtime ≤ ~15 min

---

### PERF-6 — Estimated time remaining in Batch UI (Low Priority)

**Requirement:**
- During a running job, show estimated time remaining in the Live Activity panel
- Calculation: `(remaining_tickers × avg_ms_per_ticker_last_10)` — rolling average
- Display as "~12 min remaining" next to the progress bar
- If < 60 seconds, show seconds instead

---

## Implementation Notes

- **PERF-1** is the highest-leverage fix if E*Trade's actual limit allows a shorter delay.
  Should be investigated first — run a test with 200ms delay and watch for 429 responses.
- **PERF-3** is already implemented (intraday skip removed in v0.23.10).
- **PERF-4** requires the BatchService to support a parallel execution track — current
  `runNowSync` is strictly serial. This is the most architectural change.
- **PERF-5** builds on PERF-4 or can be implemented independently as a filtered
  "run only these 3 jobs" shortcut even with serial execution.
- **PERF-6** is cosmetic but helps the user decide whether to wait or come back later.

---

## Expected Outcome

With PERF-1 + PERF-3 implemented (delay tuned + no intraday skip):
- Total E*Trade run time reduced if E*Trade tolerates a shorter delay
- PERF-3 already done in v0.23.10

With PERF-4 + PERF-5 added:
- Intraday Refresh (IV + Snapshot + Brief) runs in ~40–60 min wall-clock if delay
  stays at 1,100ms, or ~20–30 min if tuned to 550ms
- Post-market jobs no longer block intraday decisions
- Full sequence wall-clock time reduced by ~30 min (Polygon jobs overlap E*Trade jobs)
