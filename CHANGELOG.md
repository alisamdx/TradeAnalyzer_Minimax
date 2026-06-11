# Changelog

## [0.32.74] — 2026-06-11

### Fixed
- **Orchestrator: second daily slot re-runs all jobs instead of skipping everything** — the previous skip rule (`lastSuccessDate === today`) caused the 16:30 slot to skip all 10 jobs because the 10:15 slot had already marked them as "succeeded today". Replaced with a 90-minute time window: a job is skipped only if its last successful run completed within the past 90 minutes. This means a resume (re-trigger minutes after a failure) still skips the already-done jobs, while a second scheduled slot hours later re-runs everything. Skip log message now shows how long ago the job ran (e.g. "skipped (succeeded 12m ago)").

## [0.32.73] — 2026-06-11

### Fixed
- **Orchestrator: false "token invalid" on active E*Trade sessions** — the orchestrator was calling `renewAccessToken()` as the validity check, but E*Trade rejects that call when the token is active (recently used, non-dormant). This caused the orchestrator to abort with "E*Trade token invalid — renewal failed" even though Settings showed "✓ Connected". Fix: use the same date-stamp check that `checkConnection` (Settings page) uses — if `etradeTokenDate` matches today's ET date the token is valid. `renewAccessToken()` is now called as a best-effort wakeup for dormant tokens only; a failure on an active token is silently ignored.

## [0.32.72] — 2026-06-11

### Fixed
- **Orchestrator Edit modal: schedule slots now editable** — replaced the "use raw config editor" note with a full slot manager: list current slots with remove (✕) buttons, add new slots via HH:MM input (Enter or + Add), auto-sorted, duplicate/format validation. The Schedule column in the jobs table now shows the orchestrator's actual `scheduleSlots` instead of the unused `dailyScheduleTime` fallback.

## [0.32.71] — 2026-06-11

### Added
- **Batch Orchestrator** — new `BatchOrchestratorJob` (`batch-orchestrator`, sequence position 1) is the single scheduled job that drives all others. Features: non-trading day guard (scheduled runs only), E*Trade token renewal check, consolidated start email (token status + resume state + outcome), stop-on-first-failure, natural resume via per-job `last_success_date`, multi-slot scheduling (`config_json.scheduleSlots` — each slot fires at most once per day). Sub-jobs are called via `BatchService.runJobDirect()` so their full run history is preserved. "Run All in Sequence" button excludes the orchestrator. Custom orchestrator config modal in Batch Jobs view: job enable/disable list (in sequence order), validateEtradeToken + emailOnStart toggles.
- **Remote trigger** — `POST /api/v1/orchestrator/run` + `GET /api/v1/orchestrator/status` routes (X-Agent-Token auth) allow triggering and polling from Termius / Claude Code CLI when away from home.
- **Trigger context in run history** — `batch_runs.trigger` (`manual|schedule|startup`) and `batch_runs.slot_time` are recorded on every run. Batch Jobs view shows a Trigger column in run history.
- **Migration 037** — shifts all `batch_jobs.sequence_order` +1 to reserve position 1 for the orchestrator; adds `trigger` and `slot_time` columns to `batch_runs`.

## [0.32.70] — 2026-06-10

### Changed
- **Brief Stage-4 pool deepened 10 → 15 per strategy** — the liquidity gate now correctly rejects thin chains (v0.32.69), which left wheel with 4 picks and income with 3. A deeper validation pool gives the gate more candidates so each strategy can still fill 5 picks. Worst-case E*Trade cap rises to 75 unique tickers/run (typically far fewer due to cross-strategy overlap).

## [0.32.69] — 2026-06-10

### Fixed
- **Strategy Lab: stale E*Trade Greeks no longer poison structures** — E*Trade serves months-old deltas on thin (OI=0) chains while option *prices* stay correct (2026-06-10 brief: WSO chain claimed delta −0.50 at $450 with spot at $375.66 → wheel put built 11.8% ITM; AWI income straddle struck 31% above spot *passed* the critic; MIDD, ALGM also affected — 4 of 25 picks). The lab estimated the underlying from those deltas. Now: underlying price comes from `chain.underlyingPrice` (E*Trade's real-time spot, was always available but unused) → live Polygon quote → chain-delta estimate as last resort. When the delta-implied ATM deviates >8% from real spot, chain deltas are distrusted and leg selection uses moneyness.
- **Critic prompt: `strikeOtmPct` defined side-aware** — the "positive = OTM" gloss is wrong for puts; it made the LLM read AWI's broken +31% straddle as "safely OTM". Now defined as strike-vs-spot with explicit per-side ITM/OTM semantics.

### Added
- **Critic rule: `stale_lab_price`** (warning) — fires when the lab's underlying price deviates >5% from the live pick price; deterministic catch-all for structure-data integrity regardless of LLM judgment.

## [0.32.68] — 2026-06-10

### Changed
- **Batch Jobs screen: stable three-panel layout** — all three panels now have fixed heights (Registered Jobs 300px, Run History ~4 rows, Live Activity log 200px) so nothing shifts or "dances" while a job runs. The Live Activity panel is permanently visible (placeholder when idle) and the log is no longer auto-cleared 3s after a run — it persists until the next run starts, so failures can be inspected. Added ⧉ Copy (clipboard) and ✕ Clear buttons. Auto-scroll now scrolls only the log's own scrollbar; previously `scrollIntoView` yanked the entire page down on every progress event, pushing the jobs grid out of view.

## [0.32.67] — 2026-06-10

### Fixed
- **`annualizedReturn` 100× unit bug** — per-share premium was divided by per-contract collateral (`strike × 100`), understating annualized options return 100×. This zeroed the wheel `premiumYield` (wt 19) and income `premiumRiskRatio` (wt 22) scoring signals for every ticker — both strategies effectively ranked without their premium signal, letting earnings-pumped high-IVR names float to rank 1. Values self-correct on the next analysis snapshot refresh.
- **`GRADE_RANK` missing `'A+'`** — an A+ structure ranked 0 (below F); a pick whose only available structures were A+ and F would incorrectly fire `poor_structure_grade`.
- **Critic liquidity flag now reads the chosen structure** — previously it reported the *best* liquidity across relevant structures while the LLM context showed the *chosen* structure's, producing contradictory numbers in the same prompt (observed: HAYW flagged 5/15, context said 3/15 — the LLM called out the discrepancy).

### Changed
- **Earnings penalty extended to wheel + bearish** — the −20 composite penalty for earnings within 45 days (previously income-only) now applies to all short-premium strategies. 3 of 5 wheel picks on 2026-06-10 carried confirmed earnings inside the expiry window.
- **Critic calibration: info flags are advisory** — prompt now states a pick whose only flags are info-severity can still merit `pass`; `low_liquidity` threshold lowered from <6 to <4 (4–6 is normal for single-name large caps).
- **Buy strategy is stock-first** — when no buy-relevant structure grades B or better (systematic in high-IV regimes, where all debit structures grade C/F), the pick is presented as a plain stock purchase: `📈 Buy Shares` chip in the brief view, structure demoted to "Optional", `poor_structure_grade` suppressed, and the critic LLM told to evaluate the stock thesis.

### Added
- **Critic rule: bearish SPY mirror** — bearish picks now get an info flag when SPY is above its 200-day MA (the bullish/buy macro-headwind check already existed; the mirror didn't).
- **Critic rule: `counter_trend_itm_strike`** — warning when a bearish short strike sits at/below the current price (zero cushion) while SPY trends up. 3 of 5 bearish picks on 2026-06-10 had ATM/ITM short strikes on a bullish tape.

## [0.32.66] — 2026-06-10

### Added
- **Brief Trend: total Return $ in summary bar** — sum of dollar returns across all rated picks shown next to avg return.

## [0.32.65] — 2026-06-10

### Added
- **Brief Trend: Return $ column** — shows dollar return (latest available price − brief price) alongside Return %. Uses the same colour coding as Return %. Sortable.

## [0.32.64] — 2026-06-10

### Added
- **Brief Trend: all columns sortable** — click any column header to sort ascending; click again to flip to descending. Active column shows ▲/▼; inactive columns show a faint ⇅. Nulls always sort last. Sort resets when changing the brief date or strategy filter.

## [0.32.63] — 2026-06-10

### Fixed
- **Portfolio sync now captures all legs of multi-leg strategies** — long option legs (e.g. the long call in a jade/big lizard) were silently skipped during E*Trade sync. Added `'Long Put'` and `'Long Call'` position types; upsertPosition now maps LONG CALL → `Long Call` and LONG PUT → `Long Put` instead of dropping them. Greeks for long positions use natural (un-negated) chain values. Migration 036 expands the `position_type` CHECK constraint via table recreation.

## [0.32.62] — 2026-06-09

### Fixed
- **Paper trades: stale picks from multi-run days now replaced, not accumulated** — each time the brief runs on the same date, `autoCapture` now deletes all existing open picks for that strategy/date before inserting the current run's picks. Previously, picks from earlier runs (e.g. debugging iterations) were permanently retained alongside the final run's picks via the `ON CONFLICT DO UPDATE` upsert that only updated matching tickers and couldn't remove ones that were dropped. Result: income could accumulate 13 picks across 7 runs when only 5 are correct.
- **Historical cleanup on next brief run** — `cleanupStalePicksAllDates()` is called once at the start of each Stage 6. Uses `json_each(picks)` to compare open paper trades against the latest brief for each date/strategy, and deletes any ticker not present in that final run. Removes stale picks from all past dates on the next brief generation (61 stale picks identified across June 3, 5, 8, 9 from dev/debugging runs).

## [0.32.61] — 2026-06-09

### Fixed
- **Critic context mismatch: structures with `unavailableReason` excluded from LLM context** — `synthesizeVerdict` was selecting the first structure where `setup != null`, but an unavailable structure (e.g. PMCC requiring two expirations) has a non-null `setup` object with `unavailableReason` set. The LLM was seeing grade-F ghost data (no legs, no credit, no strike) instead of the actual gate-passing structure. Fixed in both `synthesizeVerdict` and `getStructureExpiry` to require `!s.setup.unavailableReason`.
- **Critic prompt: LLM never gave `pass` verdict** — system prompt framing ("your job is to find problems") and the mandatory second sentence ("what should the user check") structurally biased the LLM to give `caution` even for clean picks. Updated prompt with explicit verdict calibration definitions, allows 1–2 sentences, and instructs "do not default to caution."

### Added
- **`checkStructureGrade` critic rule** — fires `warning` when every valid structure for the strategy is grade F. Catches picks like VRT (all buy structures grade F) via a deterministic rule rather than relying solely on LLM analysis. Severity `warning` → forces `flag` verdict and surfaces as an explicit rule flag in the UI.

## [0.32.60] — 2026-06-09

### Fixed
- **`breakevenDistancePct` formula was 100× too high** — `netCredit` is stored per-contract (×100 shares) but the formula was also multiplying by 100, causing every income pick to show e.g. 760% instead of 7.6%. Fixed by removing the `* 100` (dividing per-contract credit by per-share price already yields a percentage). Added formula documentation to `docs/formulas.md#breakeven-distance`.
- **`low_liquidity` critic rule inflating flag count** — severity was `'warning'` for picks at liqScore=5/15 (the gate minimum), which forced verdict to `flag` even when the LLM was unavailable. Downgraded to `'info'` so borderline-liquid picks that passed the gate become `caution` rather than false positives.
- **Grade-F structures passing the liquidity gate** — picks where the Strategy Lab ran but all relevant structures had `unavailableReason` set (e.g. PMCC requiring two expirations) were passing `hasAdequateLiquidity()` via the `best === null → true` fallback. Fixed: now only passes when `labResult` is `null` (validation failed entirely); a lab result with no valid structure returns `false`.

### Changed
- **Critic LLM batching: 25 concurrent → 5×5 serial** — AI critic calls were all fired in parallel across all 25 picks, causing ~50% LLM failure (rate limiting). Now runs one strategy's picks (≤5) in parallel, then the next strategy. Drastically reduces rate-limit failures while still completing all 5 strategies in sequence.
- **Income scoring: −20 penalty for earnings within 45 days** — income candidates (strangles, condors) with an earnings event in the next 45 days are penalised −20 composite points before the liquidity gate. Replaces the current pattern of scoring them highly and then flagging them via the critic; keeps them out of the top 5 unless no clean alternatives exist. Configurable via `loadIncomeEarningsPenalty()` in the brief job.

## [0.32.59] — 2026-06-09

### Fixed
- **Brief funnel log: distinguish liq-failed vs outranked** — the previous log conflated two different exclusion reasons under "gated": tickers that failed the liquidity gate (liq < 5) and tickers that passed the gate but were cut by the 5-pick output cap. Log now shows `liq-failed: FWONA(3/15), CSX(3/15)` separately from `outranked: MSFT(9/15), MPC(11/15)`. `totalGated` now only counts true gate failures, not cap-cuts.

## [0.32.58] — 2026-06-09

### Changed
- **Brief: pre-gate pool widened from 5 → 10 per strategy** — each strategy now sends its top 10 scored candidates to E*Trade validation (was top 5). Post-gate output is still capped at 5 picks per strategy. Gives the liquidity gate more candidates to work with — especially for income, which frequently loses 3+ picks to the gate in low-VIX trending markets. `STAGE_4_CAP` updated from 25 → 50 unique tickers.
- **Brief: $750 price cap** — stocks priced above $750 are excluded from all brief picks before Stage 4 validation. Avoids options with very large notional size (e.g. FIX at $1,860, COST at $935). Applied after scoring so high-priced stocks still contribute to relative-strength benchmarks. Configurable via `MAX_PICK_PRICE` constant in `daily-intelligence-brief-job.ts`.

## [0.32.57] — 2026-06-09

### Changed
- **Brief funnel log: show liquidity score for each gated ticker** — log now reads e.g. `income: 5 pre-gate → 2 final (gated: CSX(liq=4/15), FWONA(liq=2/15), OGE(liq=1/15))`. Extracted `getBestLiquidityScore()` helper; `hasAdequateLiquidity()` delegates to it. No behavior change.

## [0.32.56] — 2026-06-09

### Fixed
- **`sectorMomentum` signal: ~50% null rate fixed** — `SECTOR_ETF` used GICS sector names ("Technology") but Polygon stores lowercase SIC descriptions ("electronic computers", "semiconductors & related devices"). Added `sectorStringToEtf()` keyword-matching fallback that maps Polygon SIC descriptions to SPDR sector ETFs. Coverage goes from ~0% (only GICS exact matches) to ~58% of tickers in `fundamentals_cache`. Affects `sectorMomentum` (bullish/buy) and `sectorWeakness` (bearish) signals.
- **`leverageQuality` signal: always-null fixed for wheel/bearish** — `netDebtToEbitda` has only ~9% coverage in Polygon fundamentals. Falls back to `debtToEquity * 2.5` as an approximation (D/E 1.0 ≈ ND/EBITDA 2.5) when ND/EBITDA is null. Raises signal coverage from 9% to ~30% for wheel and bearish strategies.

### Added
- **Daily brief funnel logging** — `[brief funnel]` console log per strategy at the liquidity gate showing pre-gate count, post-gate count, and names of gated tickers. Diagnostic only — no behavior change. Helps distinguish liquidity-gate scarcity from genuine candidate scarcity.
- **Score badge tooltip in Daily Brief** — hovering the composite score badge shows "Scores are strategy-specific — not comparable across strategies" to prevent cross-strategy score misinterpretation.

## [0.32.55] — 2026-06-09

### Fixed
- **Critic: `strikeOtmPct` formula was inverted** — `(price - strike) / price` produces a negative value when the short strike is OTM (above current price for a call), directly contradicting the "positive = OTM" description sent in the LLM system prompt. Corrected to `(strike - price) / price`. This eliminates the ~3 false bullish flags (e.g. COHR, ALAB, MRVL) produced each brief run.

### Added
- **Critic rule: `data_anomaly_suspected`** — new `info`-severity rule flag emitted when `priceMomentumPct` exceeds 500%. Catches spinoff/reverse-merger tickers (e.g. SNDK after the WD spinoff) where the oldest available bar gives a nonsensical 1-year return, causing the pick to slip through as a false PASS when the LLM is unavailable.
- **Critic rule: `earnings_in_window`** — new `warning`-severity rule flag emitted when a known earnings date falls between today and the structure's expiry. Previously earnings were only passed as LLM context and disappeared when the LLM was rate-limited or unavailable. Now always present in `criticVerdict.flags` regardless of LLM status.

## [0.32.54] — 2026-06-09

### Added
- **Retrospect › Brief Trend: click ticker to view 45-day chart** — clicking any ticker in the grid opens a candlestick popup showing price from the brief date through a 45-calendar-day window (the typical options expiry horizon). Overlays: dashed blue horizontal line at the brief price, `Brief` arrowUp marker on the brief date bar, `D5` arrowDown marker on the Day-5 bar (when available). Click outside the card or press Escape to close. No new IPC — reuses `historical.getPrices`. Data is partial for recent briefs (shows what's available in `historical_prices` through today).

## [0.32.53] — 2026-06-09

### Fixed
- **Brief Trend: critic column blank for all brief dates except today** — two bugs combined: (1) when the Anthropic LLM call inside `synthesizeVerdict` threw (rate-limit, transient API error, expired E*Trade token), the catch block only logged a warning and left `criticVerdict = null` with no fallback. Now falls back to a rule-check-only verdict (`confidence: 'low'`) so the column is never blank. (2) `getBriefPickDrilldown` looked up critic data via `WHERE DATE(generated_at) = ?` (UTC date) against `paper_trades.brief_date` (ET date), which is fragile. Replaced with a `brief_id` join (`MAX(brief_id) … GROUP BY brief_strategy`) that uses the direct FK already stored in `paper_trades`.

## [0.32.52] — 2026-06-09

### Fixed
- **Price Gap Fill: today's close never loaded on the same evening** — the stale-ticker threshold was `MAX(date) < date('now', '-1 day')`, so a ticker whose latest bar was yesterday was considered "fresh" and skipped. Changed threshold to `date('now')` so any ticker missing today's date is fetched. Same fix applied to the reference-ticker freshness check. Reference tickers that exist but are missing today now use a `fromDate` override (3-day lookback) instead of refetching the full 1Y range.

## [0.32.51] — 2026-06-09

### Changed
- **Retrospect › Brief Trend: 5-day trading-day price columns** — replaces the single Day+5 Price column with five individual columns (Day 1 – Day 5) showing the closing price on each of the first 5 trading days after the brief date. Weekends and market holidays are skipped naturally because data comes directly from `historical_prices` (which only contains market-open days). Each cell shows the price when available or ⏳ while that day is still in the future. Return % always reflects brief price → most recent available day; Outcome updates progressively as each day populates. Data caps at Day 5 — no tracking beyond 5 business days.
- **Retrospect › Brief Trend: drop Entry Zone / In Zone columns** — removed the buy-strategy entry zone and in-zone check columns to reduce clutter.
- **Service**: `getBriefPickDrilldown` now queries `historical_prices` directly via ROW_NUMBER() partition instead of `paper_trade_snapshots`; entry-zone lookup removed. `BriefPickDetail` type updated accordingly (`day1-5Price`, `returnPct`, `latestVerdict` replacing old day5 fields).

## [0.32.50] — 2026-06-09

### Added
- **Retrospect: Brief Trend tab** — new tab next to History that lets you drill into any individual brief's picks and compare prediction vs Day+5 outcome. Select a brief date from the dropdown, optionally filter by strategy. Table columns: Ticker (hover = AI rationale), Strategy, Score, Brief Price, Entry Zone (buy strategy only, from nearest analysis snapshot), In Zone? (was brief-day price inside the zone), Day+5 Price with actual days elapsed, Return % colour-coded per strategy direction, Outcome emoji (✅/❌/➖/⏳), Critic verdict badge with critic rationale on hover. Summary bar at top shows hit count, rated pick count, and average Day+5 return. New service methods `getBriefDates()` + `getBriefPickDrilldown()` in `paper-trading-service.ts`; new IPC `paper:brief-dates` + `paper:brief-pick-drilldown`; new `BriefPickDetail` shared type.

## [0.32.49] — 2026-06-09

### Improved
- **Daily Brief banners: hover tooltips** — both header banners now show explanatory tooltips on hover. The B-01 label explains "Day+5 hit-rate" and colour thresholds; each strategy chip shows exact hit counts and avg return. The B-02 label explains "critic pass-rate", trend arrow direction, and colour thresholds; each strategy chip shows the current pass-rate, trend description, and a full per-date pass-rate history (oldest → newest).

## [0.32.48] — 2026-06-09

### Added
- **Daily Brief: critic health trend banner (B-02)** — a second slim bar appears in the brief header showing per-strategy critic pass-rate trend across the last 7 briefs (e.g. `wheel ↑55% · buy →42% · bullish ↓28%`). Trend direction is computed by comparing the older half vs newer half of pass rates (>8pp difference = improving ↑ / declining ↓, otherwise stable →). Colour-coded: green ≥60% / amber ≥40% / red <40%; arrow coloured green (improving) / red (declining) / amber (stable). Only shows when at least one strategy has enough critic data; silently absent otherwise. New `getBriefHealthTrend()` method in `scoring-service.ts` queries `daily_briefs`, deduplicates per calendar-date, parses `picks` JSON for `criticVerdict.verdict` counts. New IPC `scoring:brief-health-trend` + preload entry.

## [0.32.47] — 2026-06-09

### Improved
- **Conviction Alerts moved to My Stocks** — the ⚡ entry-zone alert strip now lives at the top of the My Stocks screen where it belongs, reusing the already-loaded stocks list (no extra API call). Each in-zone stock shows as a colour-coded chip (green = Buy Zone, yellow = Mid Zone) with ticker, zone badge, current price, IV, and IVR. Removed from Daily Brief where it was a detour.

## [0.32.46] — 2026-06-09

### Added
- **Daily Brief: prior-brief performance banner (B-01)** — a slim bar appears directly below the brief toolbar showing last brief's Day+5 hit-rate and average return per strategy (e.g. `wheel 3/5 +1.8% avg · buy 2/4 +3.2% avg`). Colour-coded green ≥60% / amber ≥40% / red <40%. Only visible once Day+5 snapshot data exists for a prior brief; silently absent otherwise. New `getBriefPerformanceSummary()` service method uses a CTE to find the most-recent mature brief_date and aggregate per-strategy Day+5 metrics from `paper_trade_snapshots`. New IPC `paper:brief-performance-summary` + preload entry.

## [0.32.45] — 2026-06-09

### Added
- **My Stocks: AI Advisor** — new 🤖 AI Advisor button reviews all conviction stocks in a single Claude call and returns per-stock action signals + recommended price zones. For each stock it receives: current price, zone status, bands, trend direction, RSI, SMA50/200, P/E, EPS growth, grade, IV/IVR, and days to earnings. Claude returns `add` / `hold` / `reduce` / `remove` action, `keep` / `adjust` zone verdict, recommended Low/Mid/High prices, a short risk flag, and a one-sentence rationale. Results appear in a panel below the table with checkboxes per row; clicking **Apply Selected** (or **Apply All**) updates the zones in one pass (history snapshot written automatically for each change). Stocks with `adjust` verdict are pre-checked; `remove` action stocks start unchecked to prevent accidental deletion.

## [0.32.44] — 2026-06-09

### Improved
- **Filters screen: Strategy Lab button in results grid** — added 🔬 button to each row's action column, alongside the existing Analysis, Validate, Options chain, and Payoff buttons. Clicking navigates directly to Strategy Lab pre-loaded with that ticker.

## [0.32.43] — 2026-06-09

### Fixed
- **My Stocks (ConvictionView): IV showing as thousands percent** — `conviction-service.ts` was multiplying `atm_iv` values by 100 before using them, but `iv_history.atm_iv` is already stored as a percentage (e.g., 31.726 = 31.7% IV). The double-multiply produced values like 3172.6%. Removed the erroneous `* 100` from all three locations: the `list()` display path, the `recommend()` IV rank computation, and the `get()` single-ticker fetch.

## [0.32.42] — 2026-06-09

### Improved
- **Scoring engine: trend direction signals** — three strategies now penalize picks that conflict with the current price trend, making the Daily Brief's recommendations more directionally actionable:
  - **Buy** (`trendAlignment`, weight 10): uptrend=100, sideways=25, bearish=0. A sideways stock costs ~7.5 pts on the composite — enough to push a range-bound name below better-aligned alternatives. Previously sideways and uptrend stocks scored identically on this dimension.
  - **Bullish** (`trendAlignment`, weight 7): same mapping, same penalty logic. Bullish spreads need a directional tailwind.
  - **Wheel** (`notDowntrend`, weight 8): uptrend=100, sideways=75, bearish=10. Avoids selling CSPs into confirmed downtrends (falling-knife assignment risk); sideways remains acceptable for premium selling.
  - **Bearish** and **Income** unchanged — `downtrendScore` and `trendNeutral` already capture direction for those strategies.
- **Seed upgrade**: `seedBaselines()` auto-upgrades `baseline_v1`/`v2` DB configs → `baseline_v3` on startup, so existing installs pick up the new signals without resetting manual customizations.
- **Trend derivation**: when `trendLabel` is unavailable from analysis snapshots, direction is derived from `sma50`/`sma200` stack in `technical_signals` — providing coverage for all ~1055 universe tickers without requiring a prior analysis run.

## [0.32.41] — 2026-06-08

### Fixed
- **DailyBrief watchlist not appearing in dropdown**: after the brief job creates or refreshes the `DailyBrief-MMDD` watchlist, the main process now sends a `watchlists:updated` IPC push to the renderer. `App.tsx` subscribes via `window.api.watchlists.onUpdated` and calls `refreshLists()` immediately — the new watchlist appears in every dropdown without requiring an app restart or manual navigation. New `onUpdated` push listener added to the preload `watchlists` namespace.

## [0.32.40] — 2026-06-08

### Added
- **Daily Brief auto-watchlist**: after each brief run, a watchlist named `DailyBrief-MMDD` is automatically created (or cleared and refreshed if it already exists for today). All final picks from all 5 strategies are added as items; the notes field shows which strategies each ticker was picked for (e.g. `wheel · buy`). The watchlist is immediately available in Watchlists, Screener, Analysis, and anywhere else watchlists are consumed. New public methods `findByName()` and `clearItems()` added to `WatchlistService`.

## [0.32.39] — 2026-06-08

### Improved
- **Daily Brief: collapsible pick cards** — each pick is now a single-line summary row (rank · ticker · price · score · structure grade · critic verdict) that expands on click to reveal signals, strategy lab detail, nav buttons, AI rationale, and full critic analysis. Collapsed by default to reduce scrolling.

## [0.32.38] — 2026-06-08

### Fixed
- **trendNeutral signal (income)**: ADX was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes 14-period Wilder ADX for all ~1055 universe tickers and stores it in `technical_signals.adx` (migration 035). `loadTechnicalSignals()` populates `trendStrengthAdx` from it as a fallback, so income picks are now range-bound filtered even without a prior analysis run.
- **breakoutScore signal (buy)**: `entryZoneLow` was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes the 20-day price low as a support-zone proxy and stores it in `technical_signals.support_level`. `loadTechnicalSignals()` populates `entryZoneLow` from it, enabling the `priceNearSupport` component of `breakoutScore` for all batch-scored tickers.

## [0.32.37] — 2026-06-08

### Improved
- **AI Critic context enrichment**: four grounding improvements to reduce LLM hallucinations and improve verdict accuracy:
  - **DTE pre-computed**: `structure.dte` (calendar days to expiry) is now calculated server-side and passed directly — removes LLM date arithmetic errors (e.g. treating a 39-DTE July expiry as a "12-month hold")
  - **Market context**: VIX level and SPY trend (vs 200MA) now passed to the LLM as `marketContext` — model previously had no visibility into the macro environment
  - **Earnings in window**: `earningsInWindow` field added — queries `earnings_calendar` for any event between today and expiry; non-null result tells the model the exact date, days from now, and confirmation status of the biggest event risk
  - **Pre-computed risk metrics**: `strikeOtmPct` (how far the short strike is from current price) and `breakevenDistancePct` (income only — how far price can move before loss) are now computed server-side, removing another class of LLM arithmetic errors

## [0.32.36] — 2026-06-08

### Fixed
- **AI Critic price hallucination**: critic LLM was overriding correct live prices with stale training-data prices (e.g. flagging AMD at $490 as "fabricated" because it "remembered" AMD at ~$110). Fix: system prompt now explicitly instructs the model that all `marketData` fields are live and authoritative — training knowledge about prices is years out of date and must not be used to contradict provided data. Context also now includes `price52wReturnPct` so the model can calibrate price level from the known 1-year return without needing to recall an absolute price from training.

## [0.32.35] — 2026-06-08

### Fixed
- **Daily Brief scoring — fundamental signals always missing**: `loadFundamentals()` was reading from `screen_results` (the last screener run), so any ticker not in that run had null earningsGrowth, fundamentalScore, revenueGrowth5Y, epsGrowth5Y, leverageQuality etc. — which the AI Critic immediately flagged as `critical_signal_missing`. Root cause: the last screener run used the ETF universe (60 tickers), leaving all ~1000 stock picks with no fundamental data. Fix: `loadFundamentals()` and `loadSectorMomentum()` now read from `fundamentals_cache`, which is populated by the market-sync batch jobs for the full constituent universe (1067 rows, updated daily). `loadTechnicalSignals()` also now provides `rsi`, `smaStack`, and `lastPrice` as fallbacks from the nightly `DailyTechnicalSignalsJob` (1055 tickers), so those signals are no longer watchlist-scoped.

## [0.32.34] — 2026-06-08

### Fixed
- **Earnings Refresh bulk**: filter Finnhub bulk entries to constituent tickers only — bulk was storing 1500+ global entries (random small caps, international) of which only ~100 were S&P500/Russell1000. Counter and per-ticker delta now reflect actual constituent coverage.

## [0.32.33] — 2026-06-08

### Fixed
- **Earnings Refresh per-ticker loop**: Finnhub earnings calendar requires `from`/`to` date parameters — omitting them returns an empty response. Per-ticker calls now include a 365-day window so AAPL, MSFT etc. are correctly retrieved.

## [0.32.32] — 2026-06-08

### Fixed
- **Earnings Refresh Phase 2**: Finnhub's free-tier bulk call has a result cap (~1500 global entries); confirmed tickers like AAPL (Jul 29) were missing because they didn't fit in the bulk response. Added per-ticker Finnhub fallback loop for all constituents still missing a future date after the bulk calls. Rate-limited to 1 call/second (within 60/min free tier). Run notes show both bulk and per-ticker counts.

## [0.32.31] — 2026-06-08

### Changed
- **Earnings Refresh**: removed E*Trade loop entirely — job is now Finnhub-only. Companies without an announced next date simply have nothing to return yet; they appear on the next daily run once published. No more 950+ useless E*Trade no-data calls.

## [0.32.30] — 2026-06-08

### Added
- **Earnings Calendar**: 🗑 Reset button clears all non-manual entries (manual dates kept) — use before a clean Finnhub re-fetch

### Fixed
- **Earnings Refresh Phase 1**: Finnhub now makes two bulk calls (today→+90d and +90d→+180d) instead of one, doubling coverage and avoiding the free-tier result cap that left tickers like ABNB out of the first call. E*Trade Phase 2 delta is computed after both Finnhub calls.

## [0.32.29] — 2026-06-08

### Changed
- **Earnings Refresh**: Finnhub dates stored as `confirmed=true` — calendar shows "✓ Confirmed" instead of "~ Estimated"; Finnhub data quality verified to be reliable (ABNB, ADBE etc.). E*Trade Phase 2 loop still runs for tickers Finnhub didn't cover, but cannot overwrite Finnhub future dates (delta filter excludes them).

## [0.32.28] — 2026-06-08

### Added
- **Finnhub API key in Settings** (API & Data tab) — stored encrypted alongside Polygon/IVolatility keys; saved by the same Save Settings button
- **Earnings Refresh — Finnhub Phase 1**: when a Finnhub key is configured, the batch job now opens with a single bulk call (`today → +90d`) that pre-fills `earnings_calendar` for every ticker Finnhub covers (including ABNB, ADBE, AA, AAL etc. that E*Trade's API silently drops). Source stored as `'finnhub'`, `confirmed=false`. E*Trade Phase 2 then overwrites with confirmed dates for the remaining delta. Run notes show both phases.

## [0.32.27] — 2026-06-08

### Added
- **Test API — Finnhub tab**: API key save/load, date-range earnings calendar fetch (bulk, not per-ticker), constituent coverage counter, results table (Date · Symbol · BMO/AMC · Quarter · EPS Est/Actual · Revenue Est/Actual), raw JSON sample. Pre-implementation validation before wiring Finnhub into the earnings pipeline.

## [0.32.26] — 2026-06-08

### Fixed
- **Earnings Refresh delta filter**: the `force=true` flag passed by "Run All in Sequence" was bypassing the delta query and falling back to all 1000+ tickers. The delta filter now always runs regardless of the force flag — `force` is for non-trading-day guards in other jobs, not earnings caching.

## [0.32.25] — 2026-06-08

### Changed
- **My Stocks actions**: buttons consolidated to single row, icon-only (🎯🔬📐📉✎🕓✕) with tooltips — prevents 2-line wrapping

## [0.32.24] — 2026-06-08

### Added
- **My Stocks actions column**: four navigation buttons added — 🎯 Validate, 🔬 Lab, 📐 Payoff, 📉 Options — alongside the existing Edit / History / Remove buttons

## [0.32.23] — 2026-06-08

### Fixed
- **Earnings Refresh batch job**: switched from full-population iteration to delta mode — a single SQL LEFT JOIN now pre-filters the ticker list to only those with no stored date or a past/today date. The day after a full run, only tickers whose earnings just occurred are fetched instead of all 1000+. Manual entries and tickers with future dates are excluded before the loop even starts.

## [0.32.22] — 2026-06-08

### Fixed
- **Payoff risk matrix**: spot row is now vertically centred in the visible table area on load and whenever the strike list changes — no more scrolling to find current price

## [0.32.21] — 2026-06-08

### Fixed
- **Lizard → Payoff**: legs now always pre-populate when strikes + expiry are available; per-leg premiums default to 0 for snapshots run before v0.32.20 so the structure is pre-filled even on older data

## [0.32.20] — 2026-06-08

### Fixed
- **Lizard → Payoff navigation**: clicking 📐 Payoff from Jade Lizard or Big Lizard grid rows now pre-populates all 3 legs (sell put, sell call, buy call) with correct strikes and mid-premiums. `LizardResult` now stores per-leg premiums (`putPremium`, `shortCallPremium`, `longCallPremium`).

## [0.32.19] — 2026-06-08

### Changed
- **Grid width**: removed fixed `maxWidth` caps from Analysis Engine (1200px), My Stocks (1200px), Batch Jobs (1100px), and Strategy Lab (1000px) — grids now use full available width, eliminating horizontal scrollbars

## [0.32.18] — 2026-06-07

### Added
- **Analysis Engine — Jade Lizard & Big Lizard modes**: two new watchlist-screening tabs that find the best setup for each ticker (30–45 DTE), calculate net credit received, verify the "no upside risk" constraint (credit > spread width), and sort by total premium descending
  - **Jade Lizard** 🦎: short OTM put (~30Δ) + short OTM call (~20Δ) + long call one strike above
  - **Big Lizard** 🐊: short ATM straddle + long call one strike above ATM
  - Columns: Ticker · Price · Exp · DTE · Put Strike · Short Call · Long Call · Net Credit · Spread W · No ↑ Risk · Breakeven↓ · IV Rank · Actions
  - Both use the E*Trade options chain (same pipeline as Wheel/Options Income)

## [0.32.17] — 2026-06-07

### Added
- **Analysis Engine**: Actions column in all five mode grids (Buy, Options, Wheel, Bullish, Bearish) with 📐 Payoff, 📉 Options, and 🔬 Lab buttons — navigate directly to the respective view with the ticker (and strike/expiry where available) pre-filled

## [0.32.16] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cell and chip borders thickened from 1px to 2px

## [0.32.15] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cells and ticker chips now use the Batch Jobs color palette (`#131b2e` cells, `#2d3748` borders, `#89b4fa` blue accent, `#95a5a6` muted text)

## [0.32.14] — 2026-06-07

### Changed
- **Earnings Calendar**: reverted screen chrome (toolbar, background, buttons, list rows) back to app dark theme; calendar cell colors preserved for follow-up tuning

## [0.32.13] — 2026-06-07

### Changed
- **Earnings Calendar**: replaced near-black navy palette with a light blue theme — cell backgrounds `#eff6ff`/`#e0ecff`/`#bfdbfe`, borders `#bfdbfe`/`#93c5fd`, text `#1e3a5f`, toolbar `#dbeafe`

## [0.32.12] — 2026-06-07

### Changed
- **Sidebar**: Portfolio moved above My Stocks in the Personal section

## [0.32.11] — 2026-06-07

### Changed
- **Sidebar**: swapped Personal and Misc section order — Personal now follows Strategy, Misc is last

## [0.32.10] — 2026-06-07

### Changed
- **Sidebar**: moved 🤖 Agent to Intelligence section below 📡 News & Research; moved 🔔 Alerts to the bottom of the menu (below 📋 Watchlists)

## [0.32.9] — 2026-06-07

### Changed
- **Sidebar**: merged ⚡ LEAPS and 🛡️ Collared LEAPS into 🔬 Strategy Lab as in-view tabs — reduces sidebar from 26 to 24 entries; LEAPS and Collared LEAPS are now tab buttons at the top of the Strategy Lab screen

## [0.32.8] — 2026-06-07

### Changed
- **Sidebar**: moved 📡 News & Research from the Screeners section to the Intelligence section, directly below 📅 Earnings

## [0.32.7] — 2026-06-07

### Changed
- **Scoring engine**: removed vestigial `phase2` signal infrastructure — the field existed in `ScoringSignal` but no current baseline used it; all `!s.phase2` guards removed from scoring-service, critic-service, daily-intelligence-brief-job, and TradeScoringView. The "Phase 2" section and badge in the Trade Scoring config UI are gone. All signals are now fully active or disabled by the user toggle with no hidden suppression.
- **Daily Brief AI model**: upgraded from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6` for both the pick rationale synthesis (stage 5) and the AI Critic (stage 5b). Sonnet produces deeper second-order reasoning on signal interactions; cost estimate updated accordingly (~$3/M input, ~$15/M output).

## [0.31.5] — 2026-06-07

### Fixed
- Earnings Refresh Edit modal now shows correct default delay (500ms) instead of IV job's 1100ms
- `registerJob` now accepts `defaultConfig` option — seeded to DB on first registration, backfilled for existing rows where `config_json IS NULL` (upgrade path)

## [0.31.4] — 2026-06-07

### Changed — Earnings Refresh redesign
- **Universe**: now scans all unique tickers from `constituents` (S&P 500 + Russell 1000) instead of portfolio/watchlist/conviction only
- **Smart caching**: a ticker is skipped if it already has a *future* report_date stored — no re-fetch needed until that date passes. Only tickers with past/missing dates are refreshed each run
- **E*Trade only**: removed Polygon `analysis_snapshots` fallback — single source of truth, clearer failure mode
- **Rate limit**: configurable `callDelayMs` (default 500ms) in Edit modal, clamped 200–2000ms. Skipped tickers (cached) incur no delay — only tickers that actually call E*Trade
- **No-data clarity**: if E*Trade is not connected, job returns `skipped` with a message rather than looping 1,000 failed calls

## [0.31.3] — 2026-06-07

### Fixed
- Earnings Refresh: all tickers showed no-data due to a dead placeholder SQL query in `estimateFromPolygon` referencing `constituents.period_of_report_date` (column does not exist). SQLite validates column names at prepare() time even with WHERE 0. Removed the dead query; the analysis_snapshots fallback now runs correctly.

## [0.31.2] — 2026-06-07

### Changed
- Earnings Refresh is now a proper batch job visible in Batch Jobs screen (was a silent fire-and-forget in App.tsx)
- Runs on startup with 60s delay (after E*Trade tokens load) — respects 24h TTL so most launches are all-skips
- Manually triggerable via Run Now; shows per-ticker progress in live log
- Reverted silent App.tsx useEffect (v0.31.1) — batch job is the correct home

## [0.31.1] — 2026-06-07

### Fixed
- Earnings startup refresh (Earnings Refresh batch job) was missing — now fires on app open as a background task. 24h cache TTL means it is a no-op on most launches; only fetches stale or new tickers.

Reverse-chronological. Per spec EP-2.3, this is the index; per-version detail lives in `changelogs/`.

## v0.31.0 — 2026-06-07

Earnings Calendar: full feature shipping as v0.31.0. New migration 034, EarningsService (E*Trade FUNDAMENTAL quote primary, analysis-snapshot estimate fallback, manual override), IPC handlers, preload exposure. Dedicated "📅 Earnings" sidebar view with date groups, refresh, manual entry, and delete. Earnings warning banner in Validate view (fires when earnings ≤45 DTE from ticker selection). Earnings badge on Portfolio open positions (📅 with ! when before expiry). Payoff View: amber earnings annotation below P&L chart; Risk Matrix earnings column highlighted amber with 📅 icon.

## v0.30.7 — 2026-06-07

Risk Matrix critical fix: Black-Scholes was dividing leg.iv by 100 a second time. OptionContract.iv from the E*Trade chain is already a decimal fraction (0.38 = 38%), so the formula was computing sigma = 0.0038 (0.38% IV) instead of 38% — making all OTM options appear worthless and showing +$2.2k everywhere. Formula corrected to use leg.iv directly as sigma.

## v0.30.6 — 2026-06-07

Risk Matrix fix: when no options chain is loaded (manually-entered legs), intermediate date columns are now generated automatically as weekly synthetic intervals between today and the leg's expiry. Previously only the "Today" column existed, making time decay invisible. Synthetic column dates marked with ~ in the header. Footer now shows separate notices for synthetic columns and missing IV.

## v0.30.5 — 2026-06-07

Risk Matrix fix: strike rows now always include leg strikes and extend below them, even when the option strike is outside the ±25% spot range (e.g. TSLA CSP at $290 when stock is at $395). Previously all visible rows were above the strike showing only profit — now the table covers the full risk picture including losses below the strike. Leg strike rows highlighted in amber with "◀ strike" marker.

## v0.30.4 — 2026-06-07

Risk Matrix: click any cell to expand a per-leg breakdown panel showing each leg's entry price, current theoretical value, P&L, and action recommendation (Take profits / Consider closing / Close — loss exceeds premium / Watch / Hold). Click same cell or × to dismiss. Net P&L shown in header. Selected cell highlights blue.

## v0.30.3 — 2026-06-07

Payoff Visualizer: "📈 Chart / ⬛ Risk Matrix" toggle. Risk Matrix is a 2D P&L grid — rows are chain strike prices (±25% of spot), columns are Today + available chain expiry dates (all within 45 DTE; extends to 10 expiries for monthly-only chains). Pre-expiry cells computed via Black-Scholes (r=4.5%, IV from each leg; falls back to 30% when IV missing). Final column uses intrinsic-only math. Color-coded green→red, spot row highlighted, Zone label per row at expiry.

## v0.30.2 — 2026-06-07

Trade Management Alerts (ENH-5): collapsible "⚡ Trade Management" banner above the open positions table showing three rule-based alerts — Take Profits (≥50% gain via E*Trade totalGainPct), Manage Now (≤21 DTE), Delta Drift (|Δ| > 0.45). "View →" expands the relevant position row and scrolls to it. Pure frontend — no new backend code.

## v0.30.1 — 2026-06-07

Portfolio Greeks (ENH-3): "⚡ Refresh Greeks" button fetches live delta/theta/vega for all open CSP/CC positions from the options chain and writes them to the positions table. Portfolio Greeks bar now includes manually entered positions (not just E*Trade-synced ones). Short-position sign convention applied on write: positive theta/negative vega for premium sellers.

## v0.30.0 — 2026-06-07

Conviction List Phase 2: zone-entry toast notifications (FR-CV-01) when a stock transitions into Buy Zone, green count badge on the "⭐ My Stocks" sidebar item (FR-CV-03), and a "⚡ Conviction Alerts" section at the top of the Daily Brief listing any stocks currently in Buy or Mid zone (FR-CV-02).

## v0.27.0 — 2026-06-06

Payoff: InfoTip tooltip now flips to show below the trigger when the element is in the upper half of the viewport. Fixes the metrics bar tooltips being hidden under the title bar after the bar was moved to the top.

## v0.26.9 — 2026-06-06

Payoff layout: Max Profit, Max Loss, Breakeven, Net Credit/Debit, Δ, Θ, V now fit in a single compact horizontal bar above the chart. Chart height reduced (SVG 160→120, tighter padding). Options chain drawer reduced from 70vh to 45vh so chart remains visible below it.

## v0.26.8 — 2026-06-06

Payoff chart: hover tooltip. Mouse over shows a vertical crosshair, a dot on the P&L curve at that price, a faint horizontal hairline, and a tooltip box with exact price and P&L value (color-coded green/red). Tooltip flips to the opposite side when the cursor is in the right half of the chart.

## v0.26.7 — 2026-06-06

Payoff Visualizer: leg strikes are now click-to-edit (underlined, same UX as premium). Changing a sell leg strike snaps to the nearest real chain contract and updates premium + Greeks. For lizard strategies (Jade/Big/Reverse), changing any sell leg automatically recalculates the buy hedge strike using the credit ≥ spread width rule.

## v0.26.6 — 2026-06-06

Jade/Big/Reverse Lizard hedge leg selection: all three layers (Strategy Lab, Payoff auto-fill, Payoff reload) now select the buy call/put at the FURTHEST available strike where `credit ≥ spread width`, guaranteeing no upside/downside risk. Previously all three used nearest-to-percentage-of-spot, which could overshoot the credit due to $5 strike increments. Falls back to nearest OTM when no valid strike exists. `fillLegsFromChain` utility DRYs out Payoff template fill and reload logic.

## v0.26.5 — 2026-06-06

Payoff Visualizer: (1) Strategy Formula Panel — below the recognition badge, shows the key tastytrade rules for the detected strategy with actual computed values and ✓/✗ pass/fail. Covers Jade Lizard, Big Lizard, Reverse variants, Iron Condor, Iron Fly, Short Strangle/Straddle, CSP, Covered Call, vertical spreads, Bull/Bear spreads. (2) Reload Strategy button — appears at the top of the legs section when a template was applied and a chain expiry is selected; re-snaps all legs to the selected expiry using live mid-prices.

## v0.26.4 — 2026-06-06

Payoff Visualizer: fix false "∞ loss" on short-put strategies (CSP, Big Lizard, Jade Lizard, Short Straddle downside, etc.). Max loss is now computed at stock price = $0 (the true floor) rather than the chart's 50% boundary. Left-side slope removed from unlimited detection — stock cannot go below $0 so downside is always bounded. Right-side slope detection preserved for genuinely unlimited positions (naked short calls, short stock). Also fixes false "∞ profit" on long puts.

## v0.26.3 — 2026-06-06

Payoff template selection: spot price is no longer required when a ticker is set. Chain load provides the live spot automatically. Error message updated: only fires when both ticker and spot are absent.

## v0.26.2 — 2026-06-06

Payoff Visualizer: selecting a strategy template now auto-fills real premiums from the live chain when a ticker is set. Skeleton legs appear immediately; chain loads in background; each leg is snapped to the nearest real Friday expiry for that DTE and filled with the live mid-price + Greeks. Spot price updates to chain's live price. Chain panel opens automatically.

## v0.26.1 — 2026-06-06

Payoff Visualizer: templates section replaced with a grouped dropdown covering all 31 Strategy Lab strategies (Jade Lizard, Big Lizard, Reverse variants, Iron Fly, Zebras, Front Ratios, Butterflies, PMCC/PMCP, Calendars, etc.). `recognizeStrategy` expanded to identify all new structures including 3-leg lizard variants, zebras, front ratios, butterfly families (standard + broken-wing), calendar spreads, Poor Man's covered positions, and Short/Long Straddle/Strangle disambiguation.

## v0.26.0 — 2026-06-06

AI Critic — second-opinion engine for the Daily Brief. Every pick now gets a `pass / caution / flag` verdict from an adversarially-prompted Claude haiku call, backed by 6 deterministic rule checks (trend alignment, liquidity, missing signals, score concentration, cross-strategy conflict, market regime). Verdict badge shown inline on each pick card in the Brief UI with expandable flags and rationale. Strategy section headers show aggregate counts. Email now includes a Critic column. See `Requirements/ai-critic.md` for full spec.

## v0.25.0 — 2026-06-05

Options Snapshot now runs against the full S&P 500 + Russell 1000 universe (~1,100 tickers) instead of the top 300. At confirmed 0.57s/ticker this takes ~10-11 min — same as before the performance work but now covers all tickers, giving the Daily Brief `annualizedReturn` and `optionLiquidityScore` for every candidate rather than just the top 300 by IV rank.

## v0.24.9 — 2026-06-05

Options Snapshot speed fix (root cause found): `modeWheel` was making up to 9 E*Trade/Polygon calls per ticker. Two fixes: (1) `findSuitableChain` now checks DTE before calling `getOptionsChain` — cuts from 7 chain fetches to 1-2 per ticker since only the last 1-2 of the 7 generated Fridays fall in the 30-45 DTE window; (2) `forceCache=true` skips `getOptionsIV` (uses `iv_history.atm_iv` instead) and `getEarningsCalendar` (always returns null). Expected: ~2 E*Trade calls/ticker instead of ~9 → similar speed to IV Update.

## v0.24.8 — 2026-06-05

Options Snapshot: bypass Polygon API calls when run as a batch job. `analyzeTicker` now accepts `forceCache: true` which reads quote, fundamentals, and price bars directly from the local DB instead of making 3 Polygon API calls per ticker. Market Sync runs earlier in the sequence so the data is already warm. Eliminates the rate-limiter wait per ticker — expect ~0.4s/ticker vs ~2s/ticker (~4 min for 300 tickers vs ~10 min).

## v0.24.7 — 2026-06-05

Configurable call delay extended to Daily Options Snapshot (same 200–2000ms range, default 1100ms). Edit Job modal shows E*Trade Rate Limit section and run-time estimate for both IV Update and Options Snapshot.

## v0.24.6 — 2026-06-05

PERF-8: Fixed Options Snapshot candidate sort order regression (v0.24.4 introduced alphabetical ordering). Now sorts by most recent IV (atm_iv DESC) → buy_signal_score DESC → alphabetical, so the 300-ticker cap covers the most premium-rich candidates first.

## v0.24.5 — 2026-06-05

PERF-1: IV Update call delay is now configurable in the Edit Job modal (200–2000ms, default 1100ms). Shows live run-time estimate as you adjust. Migration 028 adds `config_json` to `batch_jobs` for per-job settings.

## v0.24.4 — 2026-06-05

Daily Brief and Options Snapshot now score the full S&P 500 + Russell 1000 + ETF universe directly instead of reading from screener results. Scoring engine handles quality ranking per strategy — removes Bearish blind spot and eliminates stale-screener dependency. Daily Screener job still runs for the Screener UI. See [`changelogs/v0.24.4_2026-06-05.md`](changelogs/v0.24.4_2026-06-05.md).

## v0.24.3 — 2026-06-05

New Daily Screener batch job (PERF-7): runs after Market Sync to keep `screen_results` fresh. Two passes — stocks (S&P 500 + Russell 1000, strict, default preset) and ETFs (soft, volume ≥ 500 k + price ≥ $10). Daily Brief and Options Snapshot now merge all today's screener runs instead of reading a potentially stale single row. See [`changelogs/v0.24.3_2026-06-05.md`](changelogs/v0.24.3_2026-06-05.md).

## v0.23.4 — 2026-06-04

Sidebar: Trade Scoring (⚖) moved from Intelligence to Data section, directly below Settings. See [`changelogs/v0.23.4_2026-06-04.md`](changelogs/v0.23.4_2026-06-04.md).

## v0.23.3 — 2026-06-04

E*Trade OAuth split into two non-interactive scripts for Claude Code on phone. `etrade-step1.mjs` fetches request token + prints auth URL + saves state. `etrade-step2.mjs <verifier>` completes the exchange — verifier passed as CLI arg, no readline needed. Original `etrade-login.mjs` kept for direct SSH terminal use. See [`changelogs/v0.23.3_2026-06-04.md`](changelogs/v0.23.3_2026-06-04.md).

## v0.23.2 — 2026-06-04

E*Trade remote token refresh via SSH from phone. New `scripts/etrade-login.mjs` does the full OAuth 1.0a flow in a terminal — reads consumer creds from the running app API (or `~/.tradeanalyzer/etrade-config.json` as fallback), prompts for verifier code, stores tokens immediately if app is running or writes a pending file imported on next launch. New API endpoints `GET /api/v1/etrade/credentials` + `POST /api/v1/etrade/token`. `api-server.ts` now writes `etrade-config.json` and imports pending tokens on every startup. See [`changelogs/v0.23.2_2026-06-04.md`](changelogs/v0.23.2_2026-06-04.md).

## v0.23.1 — 2026-06-04

Two fixes surfaced by Retrospect showing false negatives on day-0 paper trades:

**Retrospect day-0 verdict suppression**: open positions now show Neutral / Hold on day 0 (no full trading day elapsed). Previously `historical_prices` close (updated by the gap-fill job) could predate the brief's captured entry price, making any return % a data-freshness artefact rather than real price movement. Verdict and estimated P&L are now suppressed until `daysHeld ≥ 1`.

**`recentVolatility` scoring signal (Income + Wheel)**: new signal measuring 20-day annualized realized volatility from `historical_prices` (std dev of log returns × √252). `lower_better` — a stock making large recent moves (e.g. ADBE up 16% in 20 days) is a poor candidate for a short strangle or CSP. Income weight 20 (taken from ivRank/premiumRiskRatio/trendNeutral/optionLiquidity); Wheel weight 10. Baseline bumped to `baseline_v2` — existing configs need **Reset to Baseline** in Trade Scoring to pick up the new signal. Signal label `recentVolatility` added to DailyBriefView chip renderer.

## v0.23.0 — 2026-06-03

Paper Trading / Retrospect — closed-loop validation for the Daily Intelligence Brief. Every brief run now auto-captures all post-liquidity-gate picks as paper trades (server-side, no user action required). Unique key `(ticker, brief_strategy, brief_date)` means same-day re-runs update existing records rather than duplicate. New **🔍 Retrospect** screen (Intelligence section) with four tabs: **In Progress** (open positions grouped by brief date, with stock return %, delta-based estimated P&L, Positive/Negative/Neutral verdict, Hold/Close Signal recommendation, expandable legs detail, Close and Delete actions), **Summary** (win rate per strategy, avg return, best/worst trade, strategy accuracy table), **History** (closed/expired trades with outcomes), **Settings** (per-strategy thresholds for negative definition and Close Signal triggers — all configurable, sensible defaults applied). Positions auto-expire on view load when expiry date has passed; exit price auto-filled from `historical_prices`. Daily Brief history bar now shows brief accuracy chip (e.g. `71%`) next to each date when ≥ 3 closed picks exist; selecting a historical date shows an inline accuracy banner. No new Polygon API calls. Migration 025. See [`changelogs/v0.23.0_2026-06-03.md`](changelogs/v0.23.0_2026-06-03.md).

## v0.22.31 — 2026-06-03

Daily Brief email fixes: (1) Strategy order now matches the screen (`wheel → bullish → bearish → income → buy`). (2) "Score" column replaced with "Lab Score" (Strategy Lab `totalScore` 0-100, same system as the grade) instead of `compositeScore` (scoring engine rank used to select picks — a different system causing confusing mismatches like Grade A with Score 18). Both email and PDF updated. See [`changelogs/v0.22.31_2026-06-03.md`](changelogs/v0.22.31_2026-06-03.md).

## v0.22.30 — 2026-06-03

Fix Daily Brief showing stale data from earlier same-day runs. `persistBrief` now deletes all existing records for the same strategy on the same ET day before inserting, so each run is a clean replacement. Fixes mixed-run display (UI showing 2+4 from run 1 while email showed 5+5 from run 2) and the history view inconsistency where selecting today showed different data than the default latest view. DST-safe: uses JS `toLocaleDateString('en-CA', {timeZone: 'America/New_York'})` for the comparison. See [`changelogs/v0.22.30_2026-06-03.md`](changelogs/v0.22.30_2026-06-03.md).

## v0.22.29 — 2026-06-03

Fix two Daily Brief bugs: (1) Email showed 25 picks (pre-liquidity-gate) while UI showed 19 (post-gate) — email now uses the same `persistedPicks` map built from `liquidFiltered` data. (2) Brief history showed tomorrow's date (e.g. 6/4 for a run at 10:30pm ET on 6/3) because `generated_at` is UTC and `.slice(0,10)` gave the UTC date — fixed with `toETDate()` converting to ET before display and grouping. See [`changelogs/v0.22.29_2026-06-03.md`](changelogs/v0.22.29_2026-06-03.md).

## v0.22.28 — 2026-06-03

Daily Intelligence Brief: email delivery with PDF attachment. After the brief is generated, an HTML email is sent with trade-ready tables (ticker, grade, structure, strike, expiry, DTE, credit/debit, ann. return, POP, max loss) and a full PDF is attached (all 25 picks, complete AI rationale, signal breakdown). Uses existing SMTP config from Agent Config → Email. Email failure does not fail the job. New: `EmailService`, `BriefReportBuilder`, `pdfkit` dependency. See [`changelogs/v0.22.28_2026-06-03.md`](changelogs/v0.22.28_2026-06-03.md).

## v0.22.27 — 2026-06-03

Fix batch job stuck on "Running" with non-functional cancel. Two root causes: (1) stale `running` DB state from crashed/killed sessions — fixed by cleaning up `batch_runs` and `batch_jobs` in `BatchService` constructor on every startup. (2) `cancelJob` only signalled the abort but never updated the DB, so the UI never changed until the hung Promise settled — fixed by immediately writing `cancelled` to the DB and freeing `runningJobId` in `cancelJob`, with a guard in `runJob` to skip the final DB write if the signal was aborted. See [`changelogs/v0.22.27_2026-06-03.md`](changelogs/v0.22.27_2026-06-03.md).

## v0.22.26 — 2026-06-03

Daily Options Snapshot + Daily Intelligence Brief: graceful skip when options provider is unavailable. Both jobs now probe `getOptionsExpirations('SPY')` before doing any work. Expired E*Trade token (or any connectivity failure) returns `status: 'skipped'` with a clear reconnect message instead of timing out on every ticker. `DailyOptionsSnapshotJob` now takes `OptionsProvider` as a constructor arg. See [`changelogs/v0.22.26_2026-06-03.md`](changelogs/v0.22.26_2026-06-03.md).

## v0.22.25 — 2026-06-03

Fix Daily Options Snapshot stuck on "Running". Added a 30-second per-ticker timeout (`withTimeout`) around each `analyzeTicker` call. An expired E*Trade token (or any hung HTTP call) was causing the job to hang indefinitely on the first ticker with no way to recover. Timed-out tickers now count as failed and the loop moves on. See [`changelogs/v0.22.25_2026-06-03.md`](changelogs/v0.22.25_2026-06-03.md).

## v0.22.24 — 2026-06-03

Daily IV Capture: overwrite on every run. Removed the "already done today" skip so each run captures the latest snapshot and the 4:30pm job always writes EOD data. `storeReading()` already uses `ON CONFLICT DO UPDATE` so no schema change needed. Supports multiple intraday runs within the 10,000 credit/day MarketData.app limit (~1,500 credits per run). See [`changelogs/v0.22.24_2026-06-03.md`](changelogs/v0.22.24_2026-06-03.md).

## v0.22.23 — 2026-06-03

Daily IV Capture job switched from E*Trade to MarketData.app. Job now runs fully unattended — no OAuth token, no midnight expiry. Calls `getLiveChain(ticker, nearestMonthlyExpFor30Dte())` (single API call per ticker, `?expiration=` param), computes ATM IV inline, stores with `source='marketdata'`. E*Trade code untouched — only `DailyIvCaptureJob` and its constructor wiring in `index.ts` changed. See [`changelogs/v0.22.23_2026-06-03.md`](changelogs/v0.22.23_2026-06-03.md).

## v0.22.22 — 2026-06-03

Test API: MarketData.app live chain support. New **Live (today)** mode on the MarketData.app tab uses `?expiration=` instead of `?date=` (historical-only param that was causing 400 errors). Auto-selects the nearest monthly 3rd-Friday expiration to 30 DTE. New `getLiveChain()` / `getRawLiveChain()` methods on `MarketDataProvider`; `nearestMonthlyExpFor30Dte()` helper exported. New `test-api:get-marketdata-live-chain` IPC handler + `getMarketDataLiveChain` preload bridge. See [`changelogs/v0.22.22_2026-06-03.md`](changelogs/v0.22.22_2026-06-03.md).

## v0.22.21 — 2026-06-02

Quality signals wired into the Trade Scoring Engine and Daily Brief. `scoreFundamentals()` now uses ROIC and FCFToNetIncome alongside ROE/margin/growth. `computeEarningsGrowthScore()` blends 1Y and 5Y CAGR (1.5× weight on 5Y). Four new explicit scoring signals: `leverageQuality` (Wheel, wt 8), `leverageRisk` (Bearish, wt 8), `revenueGrowth5Y` (Bullish wt 10, Buy wt 10), `epsGrowth5Y` (Buy wt 8). AI rationales can now mention ROIC, FCF quality, and 5-year growth context. Note: existing strategy configs in DB are not auto-updated (INSERT OR IGNORE) — call Reset to Baseline in the Scoring Config UI to pick up new signals. See [`changelogs/v0.22.21_2026-06-02.md`](changelogs/v0.22.21_2026-06-02.md).

## v0.22.20 — 2026-06-02

WheelMetrics quality signals — FCFToNetIncome, ROIC, NetDebtToEBITDA, 5-year revenue/EPS CAGR, and VS/GS composite scores with StockGrade added to the fundamentals pipeline. All metrics computed from existing Polygon `/vX/reference/financials` data (no new API calls); quarterly filings limit bumped to 24 (≈6 years) for 5Y CAGR. New screener columns with star grade renderer. See [`changelogs/v0.22.20_2026-06-02.md`](changelogs/v0.22.20_2026-06-02.md).

## v0.22.19 — 2026-06-01

Phase 2 scoring signals — Relative Strength vs SPY + Sector Momentum. Four new signals wired into the Trade Scoring Engine from `historical_prices` only (no new API calls): `relativeStrength` (Bullish wt 15, Buy wt 20), `relativeWeakness` (Bearish wt 15), `sectorMomentum` (Bullish wt 10, Buy wt 10), `sectorWeakness` (Bearish wt 10). `PriceGapFillJob` now bootstraps SPY + 11 SPDR sector ETFs with 6M bars before the main stale-ticker pass so reference data is always available. Sector lookup uses `ScreenResultPayload.sector` → GICS→SPDR map. Relative strength = 90-day excess return vs SPY; sector momentum = 90-day return of the ticker's sector ETF. See [`changelogs/v0.22.19_2026-06-01.md`](changelogs/v0.22.19_2026-06-01.md).

## v0.22.18 — 2026-06-01

Daily Options Snapshot batch job — nightly Wheel analysis run on the top 300 screener candidates to keep `optionLiquidityScore` in `analysis_snapshots` current. Scheduled at 06:00 ET + on startup (5-min delay). Migration 024 makes `analysis_snapshots.watchlist_id` nullable so the batch snapshot has no watchlist affiliation. See [`changelogs/v0.22.18_2026-06-01.md`](changelogs/v0.22.18_2026-06-01.md).

## v0.22.17 — 2026-06-01

Nav: Data Sync moved to Misc (between Test API and History); Batch Jobs is now the default landing page on app launch. Data section simplified to Settings + Batch Jobs. See [`changelogs/v0.22.17_2026-06-01.md`](changelogs/v0.22.17_2026-06-01.md).

## v0.22.16 — 2026-06-01

Trade Scoring Config — full UI redesign. Pill strategy tabs with emoji, scrollable 4-column signal table (toggle, label+direction badge, weight+bar, rationale), Phase 2 divider, green/red total row, sticky footer with version input and Save/Reset buttons. See [`changelogs/v0.22.16_2026-06-01.md`](changelogs/v0.22.16_2026-06-01.md).

## v0.22.15 — 2026-06-01

Daily Brief — hard liquidity gate and specific setup details on pick cards. Picks are now dropped in Stage 6 if the best relevant Strategy Lab structure has `liquidityScore < 5` (catches OI=1 + wide spreads, threshold ≈ 3). Progress message reports gated count. Pick cards now show a second line under the grade badge: `$240 · Jul 17 · $3.25 cr` — the exact strike, expiry, and net premium from the Strategy Lab setup. See [`changelogs/v0.22.15_2026-06-01.md`](changelogs/v0.22.15_2026-06-01.md).

## v0.22.14 — 2026-06-01

Fix Payoff Assess Trade — AI was reading the expiry year (`2026`) as the DTE value, producing responses like *"long 2026 DTE provides ample theta runway"*. DTE is now computed from `leg.expiry` and injected into the prompt as `expiry 2026-07-17 (45 DTE)`. See [`changelogs/v0.22.14_2026-06-01.md`](changelogs/v0.22.14_2026-06-01.md).

## v0.22.13 — 2026-06-01

Daily Brief — Payoff, Validate, and Options quick-nav buttons on pick cards. Each card now has a compact row of three buttons: **📊 Payoff** opens the Payoff Visualizer pre-loaded with the Strategy Lab legs (slug, expiry, all option strikes/premiums/deltas); **✓ Validate** opens the Validate tab for the ticker; **📋 Options** opens the Options Chain pre-filtered to the expiry that Strategy Lab used. All three use the existing `navigate-to-*` CustomEvent deep-link system. See [`changelogs/v0.22.13_2026-06-01.md`](changelogs/v0.22.13_2026-06-01.md).

## v0.22.12 — 2026-06-01

Daily Brief — stock price and Wheel capital requirement on pick cards. Each pick now shows the last known price (`$245.30`). Wheel picks additionally show the CSP buying-power requirement (`~$24,530 cap` = price × 100) so you can gauge capital needs before opening Strategy Lab. `BriefPick.price` added to shared types; populated from `signalData.lastPrice` in the brief job at no extra DB cost. See [`changelogs/v0.22.12_2026-06-01.md`](changelogs/v0.22.12_2026-06-01.md).

## v0.22.11 — 2026-06-01

Fix Strategy Lab scrolling. Root div had no `overflow-y: auto` so `.main`'s `overflow: hidden` clipped the list after ~6–8 rows — C/F grades were rendered but unreachable. Added `overflowY: auto` + `height: 100%` to the root container. See [`changelogs/v0.22.11_2026-06-01.md`](changelogs/v0.22.11_2026-06-01.md).

## v0.22.10 — 2026-06-01

Daily Brief — Strategy Lab grade alignment on pick cards. Each validated pick now shows the grade for the strategy-relevant structure (e.g. `CSP  B`) and the best overall fit when they differ (e.g. `·  Best fit: Reverse Big Lizard  A+`). Makes the gap between stock-level scoring and live-chain execution immediately visible. See [`changelogs/v0.22.10_2026-06-01.md`](changelogs/v0.22.10_2026-06-01.md).

## v0.22.9 — 2026-06-01

Daily Intelligence Brief UI redesign. Previous layout had zero CSS — signal labels, scores, and badges were unstyled inline text. New design: bordered rounded strategy sections with collapsible headers (emoji prefix, pick count pill), two-column pick cards (circular rank badge | ticker · score badge · Validated chip · Strategy Lab button), signal chips with human-readable labels and smart value formatting, italic AI rationale with left-border accent. See [`changelogs/v0.22.9_2026-06-01.md`](changelogs/v0.22.9_2026-06-01.md).

## v0.22.8 — 2026-06-01

Daily Technical Signals batch job. New `DailyTechnicalSignalsJob` runs nightly after price-gap-fill — reads `historical_prices`, computes MACD, RSI, Bollinger Bands, SMA stack, candlestick patterns, and a `buySignalScore` (0–100, mirrors Validate screen logic), then upserts to a new `technical_signals` table. `ScoringService` now reads `buySignalScore` from this table, enabling the scoring engine to include buy-signal strength as a signal for the **Buy** (weight 20) and **Bullish** (weight 15) strategies without any live API calls. See [`changelogs/v0.22.8_2026-06-01.md`](changelogs/v0.22.8_2026-06-01.md).

## v0.22.7 — 2026-06-01

Daily Intelligence Brief & Trade Scoring Engine. New capability: configurable per-strategy scoring engine (5 strategies × expert-backed weights) + post-market batch job that screens the universe, scores candidates, validates top picks via E*Trade Strategy Lab, synthesizes AI rationale (Claude Haiku), and persists a dated brief. Two new sidebar views: **Daily Brief** (ranked picks per strategy, AI rationale, → Strategy Lab button, history dropdown) and **Trade Scoring Config** (weight sliders, signal toggles, version labels, Reset to Baseline). Two new computed signal fields: `priceMomentumPct` (52-week return from `historical_prices`) and `breakoutScore` (MA alignment + price near support). Phase 2 signal slots (`relativeStrengthVsSpy`, `sectorMomentum`) reserved in config as disabled placeholders. See [`changelogs/v0.22.7_2026-06-01.md`](changelogs/v0.22.7_2026-06-01.md).

## v0.22.6 — 2026-06-01

Batch Jobs sequence order — move to edit modal. Removed ▲/▼ buttons from the job table. The `#` column now shows the sequence number read-only. Sequence order is editable as a number field in the Edit Job modal (min 1). Saving updates the single job's `sequence_order` via `updateJobConfig` (no full-list reorder required). See [`changelogs/v0.22.6_2026-06-01.md`](changelogs/v0.22.6_2026-06-01.md).

## v0.22.5 — 2026-06-01

Fix Daily IV Update batch job — all tickers returned "no-data". Two bugs: (1) `etrade-options.ts` looked for `currentPrice` in `OptionChainResponse` but E*Trade returns the underlying price as `nearPrice` — so `underlyingPrice` was always `null`, causing `captureFromEtradeChain` to bail out immediately on every ticker. Fixed by checking `nearPrice` first with `currentPrice` as fallback. (2) `OptionContract.iv` is a decimal fraction (0.285 = 28.5%) but `captureFromEtradeChain` passed it straight to `computeAtmIv` with a wrong "already a percentage" comment — stored IV values would have been 100× too small. Fixed by multiplying by 100 when mapping. See [`changelogs/v0.22.5_2026-06-01.md`](changelogs/v0.22.5_2026-06-01.md).

## v0.22.4 — 2026-06-01

Batch Jobs sequence ordering. Jobs now have a `sequence_order` field; jobs with the same schedule run in that order. `BatchView` job table gains a `#` column with ▲/▼ buttons to move jobs up or down — changes persist to the DB immediately. New migration `021_batch_sequence.sql` adds the column (existing rows numbered by insertion order). `BatchService.reorderJobs(jobIds[])` writes new positions; `batch:reorder` IPC + `window.api.batch.reorderJobs` preload bridge expose it to the renderer. See [`changelogs/v0.22.4_2026-06-01.md`](changelogs/v0.22.4_2026-06-01.md).

## v0.22.3 — 2026-06-01

Single instance lock. Clicking the shortcut while TradeAnalyzer is already running now focuses the existing window instead of launching a second copy. Uses `app.requestSingleInstanceLock()` + `second-instance` event. See [`changelogs/v0.22.3_2026-06-01.md`](changelogs/v0.22.3_2026-06-01.md).

## v0.22.2 — 2026-06-01

Analysis sidebar order + per-tab default sort + Options Income extra columns. **Sidebar:** 📊 Analysis moved above 🔬 Strategy Lab. **Default sort:** Buy → Score desc; Options Income → Premium desc; Wheel → Suitability desc; Bullish/Bearish → Max Loss desc — applied on every tab switch and after each run. **Options Income:** three new columns — Bid, Ask, OI (open interest) — pulled from the selected contract; `OptionsIncomeResult` type and analysis service updated. See [`changelogs/v0.22.2_2026-06-01.md`](changelogs/v0.22.2_2026-06-01.md).

## v0.22.1 — 2026-06-01

Batch Jobs global session toggle. New toggle switch in `BatchView` header enables/disables all automatic batch jobs (startup + scheduled) for the current session. Defaults ON on every launch — never persists. Manual "Run Now" is unaffected. Amber warning banner shown when disabled. See [`changelogs/v0.22.1_2026-06-01.md`](changelogs/v0.22.1_2026-06-01.md).

## v0.22.0 — 2026-06-01

Analysis Engine redesign — one-click runs all 5 modes in sequence. Mode selector removed; replaced with strategy tabs (📈 Buy / 💰 Options Income / 🎯 Wheel / 🐂 Bullish / 🐻 Bearish) that populate after run. Snapshots moved below results, newest first, with per-row delete and Clear All. Each run saves a single combined snapshot (`mode='all'`) containing all 5 mode outputs. New backend: `analyzeWatchlistAllModes()`, `saveAllModesSnapshot()`, `getAllModesSnapshot()` in analysis service; `analysis:run-all` and `analysis:get-all-modes-snapshot` IPC handlers; `runAll`/`getAllModesSnapshot` on `window.api.analysis`. Progress events now include `mode` field. See [`changelogs/v0.22.0_2026-06-01.md`](changelogs/v0.22.0_2026-06-01.md).

## v0.21.1 — 2026-06-01

Batch Jobs UI — moved Run History above Live Activity panel so completed run data is visible without scrolling past the (conditionally shown) live log. See [`changelogs/v0.21.1_2026-06-01.md`](changelogs/v0.21.1_2026-06-01.md).

## v0.21.0 — 2026-06-01

Automated Batch Jobs + Live Progress Log. Three daily background jobs now run automatically: **Daily Market Sync (Stocks)** — runs `screenerService.syncUniverse('both')` at startup (+60s) and 16:30 ET; **Daily Market Sync (ETFs)** — same for the ETF universe (+90s); **Daily Price Gap Fill** — detects tickers missing recent price history and backfills via Polygon (+120s). All three chain sequentially under the existing `BatchService` scheduler. `DailyIvCaptureJob` now auto-renews dormant E*Trade tokens and surfaces a "Reconnect" CTA notification when the midnight-rollover token must be re-authed manually. `BatchView` gains a **Live Activity** panel — streaming per-ticker log with spinner header, animated progress bar, live counters (✓ updated / — skipped / ✗ failed), monospace ticker log (max 300 events, auto-scroll, auto-clears 3s after job completes). App auto-launches on Windows login. Production DB path fixed for packaged exe (`app.getPath('userData')`). `npm run package` fixed: `CSC_IDENTITY_AUTO_DISCOVERY=false` + `win.forceCodeSigning: false` prevent winCodeSign symlink errors; Windows Developer Mode required (one-time). See [`changelogs/v0.21.0_2026-06-01.md`](changelogs/v0.21.0_2026-06-01.md).

## v0.20.0 — 2026-05-31

Strategy Lab — score and explore all 31 tastylive option strategies for any single ticker using entirely fresh live data (no cache). New **🔬 Strategy Lab** sidebar entry in the Strategy section, just above 📚 Knowledge. Two tabs: **Validate** (scores all 31 strategies — IV score, direction score, premium score, liquidity score → letter grade A+/A/B/C/F, sorted best first) and **Explore** (pick any strategy + ticker → build the concrete setup with legs, strikes, P&L summary). Live data path: fresh 90-day bars for direction bias (MA20/MA50), live `getOptionsExpirations` + `getOptionsChain` for the nearest 20–50 DTE expiry, and `iv_history` table for IV rank/percentile. Each strategy card shows expandable score bars, condition flags (✓/~✗), leg table, and action buttons: **→ Explore Strategy** (cross-tab navigation), **📈 View in Payoff** (fires existing `navigate-to-payoff` event), **✨ AI Rationale** (cost-conscious on-demand Claude haiku call ~$0.003–0.005/click). New service `StrategyLabService` with `validate()`, `explore()`, `getContext()`. New IPC file `ipc-strategy-lab.ts` with handlers `strategyLab:validate`, `strategyLab:explore`, `strategyLab:aiRationale`. All 31 strategy types added to `shared/types.ts`. See [`changelogs/v0.20.0_2026-05-31.md`](changelogs/v0.20.0_2026-05-31.md).

## v0.19.2 — 2026-05-31

History screen overhaul + price bulk load. "IV History" sidebar entry renamed to **"History"**. The Gap Fill run button removed from the History screen (it already existed in Data Sync section 3). **History screen** now hosts two sections: IV (key status, coverage summary with gap count, Step 1/2 initial load) and Price History (new Bulk Price Load — fetches 2Y daily OHLCV bars for S&P 500 / Russell 1000 / Both via Polygon, universe selector, progress bar, cancelable, coverage count displayed). **Data Sync** gains section 5 **Price Gap Fill** — finds all tickers already in `historical_prices` whose latest bar is >2 days old and refreshes the last month for each; stale count shown with a ↻ Check button. Three new IPC handlers: `historical:getUniverseTickers`, `historical:getStalePriceTickers`, `historical:getPriceTickerCount`. See [`changelogs/v0.19.2_2026-05-31.md`](changelogs/v0.19.2_2026-05-31.md).

## v0.19.1 — 2026-05-31

Closed positions sync from E*Trade transaction history. New **↓ Import Closed (YTD)** button on the Portfolio Closed tab. `EtradePortfolioService.syncClosedPositions()` fetches the full YTD transaction history via `/v1/accounts/{id}/transactions` (paginated, marker-based), classifies each transaction as open/close/expired/assigned using OCC symbol parsing, pairs open+close legs FIFO per symbol, and inserts matched closed positions into the local DB with dedup guard (ticker + position_type + entry_date + exit_date). New `portfolio:etrade:sync-closed` IPC handler + `window.api.portfolio.etrade.syncClosed()` preload bridge. See [`changelogs/v0.19.1_2026-05-31.md`](changelogs/v0.19.1_2026-05-31.md).

## v0.19.0 — 2026-05-31

Knowledge Base — tastylive strategy guide (TT1469) embedded as a quick-reference view. New `📚 Knowledge` sidebar entry at the bottom of the Strategy section. 31 option strategies extracted from the PDF across 6 categories (Bullish, Bearish, Omnidirectional, Neutral, Neutral-Bullish, Neutral-Bearish). Each strategy stored as a high-resolution PNG (150 DPI) and a structured JSON one-pager in `src/renderer/src/knowledge/`. `KnowledgeView` with collapsible left drawer (search + categorized strategy list with colored section labels and active-highlight), and a content panel with **🖼 Image / 📄 Text** toggle. Image mode shows the original PDF page exactly. Text mode renders structured layout: key params (Direction, IV, DTE, PoP), setup steps, risk/reward grid, Greeks row (color-coded Long/Short/Flat/Dynamic), How It Works cards (Ideal / Not Ideal / Defensive Tactics), Volatility 2-col grid, At Expiration cards, and Takeaways. Sidebar reorganized into labeled sections (Data / Analysis / Strategy / Settings / Personal). See [`changelogs/v0.19.0_2026-05-31.md`](changelogs/v0.19.0_2026-05-31.md).

## v0.18.2 — 2026-05-31

ENH-3 Portfolio Greeks Monitor. Aggregate Greeks summary bar added to `PortfolioView`, visible whenever open positions exist. Shows **Net Δ** (sum of position deltas, stock + options), **Θ/day** (daily theta income in dollars, options only), **Vega** (aggregate vega, options only), **BP Used %** (capital deployed / configured account size — hidden until account size is set), and **Expiration buckets** (count of positions expiring ≤7d / ≤14d / ≤21d, color-coded red/amber/gray). Greeks sourced from existing `PositionEtrade` E*Trade sync data — no new API calls. `accountSize` added to `AppSettings` (default 0); inline "Set account size" prompt saves via `settings.setAll`. Formula documented at `docs/formulas.md#portfolio-greeks`. See [`changelogs/v0.18.2_2026-05-31.md`](changelogs/v0.18.2_2026-05-31.md).

## v0.18.1 — 2026-05-30

**Bug fix: `atm_iv` stored as decimal fraction instead of percentage.** IVolatility API returns IV as decimal fractions (0.285 = 28.5%). The ingest path in `IvHistoryService.backfillIvHistory()` was storing them raw, and the E*Trade auto-capture path was explicitly dividing `OptionContract.iv` (already a %) by 100 before `computeAtmIv`, producing a decimal result. Both paths now store percentages: IVolatility reads are multiplied × 100 before `storeReading()`; E*Trade reads pass `c.iv` directly (no division). Migration 017 (`UPDATE iv_history SET atm_iv = atm_iv * 100`) converts all previously stored decimal rows to percentages. The `Curr IV` column in the Opportunity Dashboard now shows e.g. `30%` instead of `0.3%`. See [`changelogs/v0.18.1_2026-05-30.md`](changelogs/v0.18.1_2026-05-30.md).

## v0.18.0 — 2026-05-30

ENH-2 Opportunity Dashboard. Removed Morning Briefing screen. New `🎯 Opportunity` sidebar view with composite scoring engine: fundamentals 25% (ROE, P/E, D/E, margin, revenue growth) + IV rank 30% + technical 25% (from analysis snapshots) + premium yield 20% (estimated 1.5%/mo). Strategy mode selector (Wheel / CSP / Spreads / Bullish / Bearish) — premium-selling modes rank high IV as favorable; directional modes invert the score. Universe selector (S&P 500 / Russell 1000 / Both). All data pulled from local DB (quote cache, iv_history, screen_results, analysis_snapshots) — no additional API calls. `OpportunityService` with batch SQL queries for IV ranks (one window-function query for entire universe), quote cache lookup, latest screen fundamentals, and latest analysis snapshot scores. `ipc-opportunity.ts` + `window.api.opportunity.run()` preload bridge. `OpportunityView` with score circles, mini score bars, IV rank badges, one-click drill-in to Analysis and Options Chain views. See [`changelogs/v0.18.0_2026-05-30.md`](changelogs/v0.18.0_2026-05-30.md).

## v0.17.0 — 2026-05-30

IV History feature — true IV rank and IV percentile from 252 days of daily 30-day constant-maturity ATM IV. New `iv_history` SQLite table (migration 016). `MarketDataProvider` HTTP client for MarketData.app historical options chains. `IvHistoryService` computes ATM IV via DTE-weighted interpolation between two expirations bracketing 30 days, detects gaps, orchestrates backfill, and queries IV rank/percentile. `IvHistoryView` management screen with token config, coverage summary, Step 1/2 initial load controls, ongoing gap fill, and live progress panel. E*Trade auto-capture: silently stores today's ATM IV whenever an options chain is fetched — free, no extra API call. `window.api.ivHistory.*` preload bridge. `marketdataApiToken` added to secure encrypted storage. Formula docs added at `docs/formulas.md#iv-history`, `#atm-iv-interpolation`, `#trading-days`. See [`changelogs/v0.17.0_2026-05-30.md`](changelogs/v0.17.0_2026-05-30.md).

## v0.16.0 — 2026-05-30

Payoff Visualizer improvements + E*Trade Quote Inspector + IV History design. Payoff: fixed Anthropic API key injection (`new Anthropic({ apiKey })`), fixed `probOfProfit` tool schema type, redesigned assessment panel with structured risks/opportunities/exit guidance cards and collapsible chain drawer. E*Trade Test API: new `etrade:get-raw-quote` IPC handler calls `/v1/market/quote/{symbol}?detailFlag=ALL` and returns full raw JSON; `QuoteInspector` component in `TestApiView` auto-highlights any IV/volatility fields found in the response. Planning: `Requirements/enhancements.md` and `Requirements/iv-history-design.md` capture the full IV rank build plan. See [`changelogs/v0.16.0_2026-05-30.md`](changelogs/v0.16.0_2026-05-30.md).

## v0.15.0 — 2026-05-26

Dual-provider architecture for options data. New `OptionsProvider` interface (`options-provider.ts`) with `getOptionsExpirations`, `getOptionsChain`, `getOptionsIV`, `getOptionsIVAndPremium`. `PolygonDataProvider` implements both `DataProvider` and `OptionsProvider`. New `ETradeDataProvider` implements `OptionsProvider` using the E*Trade Market API with live OAuth tokens. Provider chosen at startup via `optionsProvider` settings key ('polygon'|'etrade'). `LeapsCspService` refactored to take separate `DataProvider` (quotes/fundamentals/bars) and `OptionsProvider` (options calls). Settings UI adds "Options Data Source" dropdown; `window.api.settings.getOptionsProvider/setOptionsProvider` bridge. Fixed 7 pre-existing TypeScript strict-mode errors. Screener filter tests updated to match Polygon-compatible defaults. See [`changelogs/v0.15.0_2026-05-26.md`](changelogs/v0.15.0_2026-05-26.md).

## v0.14.0 — 2026-05-25

LEAPS + CSP Strategy Screener. New `⚡ LEAPS+CSP` sidebar tab. Market gate (SPY trend vs 50d/200d MA, VIX level + 5d change, HYG/IEF ratio) returns PASS/CAUTION/FAIL. Universe loaded from screener cache (no redundant API calls). LEAPS candidates screened by delta 0.70–0.90, DTE 365–730, spread ≤5%, OI ≥100, extrinsic ≤15%. CSP candidates screened by delta −0.15 to −0.30, DTE 25–50, annualised return ≥12%. Cross-ticker pairing: CSP on same OR different ticker. Combined score = LEAPS sub-score × 60% + CSP sub-score × 40%. Grades A+ (≥9.0) / A / B / C / F. Results ranked table with expandable scoring breakdowns, caution flags, alternative CSPs per LEAPS, and "Mark as Opened" tracking. Migration 011. See [`changelogs/v0.14.0_2026-05-25.md`](changelogs/v0.14.0_2026-05-25.md).

## v0.13.0 — 2026-05-25

Backtesting Engine. `BacktestEngine` service with multi-strategy back-test against historical OHLCV data. IPC handlers via `ipc-backtest.ts`. `BacktestView` in renderer. `🔁 Backtest` sidebar tab.

## v0.10.0 — 2026-05-08

Phase 10: Settings Enhancements (Priority 9). Extended AppSettings with soundAlertsEnabled, autoConnectWebSocket, defaultScreenerIndex ('sp500'|'russell1000'|'both'), theme ('dark'|'light'), keyboardShortcuts config. Added Keyboard Shortcuts tab to SettingsView. Theme support via CSS variables and data-theme attribute. Conditional WebSocket auto-connect in main process based on setting. ScreenerView loads default universe from settings. See [`changelogs/v0.10.0_2026-05-08.md`](changelogs/v0.10.0_2026-05-08.md).

## v0.9.0 — 2026-05-08

Phase 9: Morning Briefing Dashboard (Priority 7) + Alerts System (Priority 8). `007_alerts.sql` migration with `alerts` table (price, position types with thresholds). `BriefingService` with market regime detection (SPY trend via 20/50 SMA, VIX classification), action items (expiring positions, delta breaches), top 15 quality setups (ROE>15%, D/E<1.0, MarketCap>$10B). `AlertsService` with price alert checking via WebSocket updates. IPC handlers: `briefing:getFull`, `briefing:refresh` and `alerts:create`, `list`, `delete`, `markTriggered`. `BriefingView` component with MarketRegimeCard (trend/vix badges), ActionItemsList (priority icons), TopSetupsTable (sortable columns). Auto-refresh every 5 minutes. See [`changelogs/v0.9.0_2026-05-08.md`](changelogs/v0.9.0_2026-05-08.md).

## v0.8.0 — 2026-05-08

Phase 8: Portfolio Tracking (Priority 6). `006_portfolio.sql` migration with `positions` table (CSP, CC, Stock types with entry/exit prices, quantities, strike/exp dates). `PortfolioService` with CRUD operations and P&L calculations. IPC handlers: `portfolio:add`, `list`, `update`, `close`, `pnlSummary`. `PortfolioView` component with add position form, Open/Closed tabs, sortable columns, P&L summary cards (total positions, unrealized/realized P&L, capital deployed, win rate). Added to sidebar navigation. See [`changelogs/v0.8.0_2026-05-08.md`](changelogs/v0.8.0_2026-05-08.md).

## v0.7.0 — 2026-05-07

Phase 7: Screener Enhancements (Priority 5). Sortable columns using `useSortable` hook on all 17+ columns (Ticker, Company, Sector, Last Price, Day %, P/E, EPS, Market Cap, Revenue Growth, EPS Growth, D/E, ROE, Margin, FCF, Current Ratio, Volume, Beta, Pass Score). Quick Actions per row: "Add to Watchlist" dropdown and "Run Analysis" button. CSV export for filtered results. Pagination (50 items per page) with page navigation. Cache status indicator in Screener header with auto-refresh warning when data >1 hour old. See [`changelogs/v0.7.0_2026-05-07.md`](changelogs/v0.7.0_2026-05-07.md).

## v0.6.0 — 2026-05-07

Phase 6: Historical Charts (Priority 4). **Database**: `005_historical_data.sql` with `historical_financials` and `historical_prices` tables, indexes, views. **Backend**: `HistoricalDataService` with `getFinancials`, `upsertFinancial`, `getPrices`, `upsertPrice`, `calculateSMA`, `getDateRangeFromTimeRange`; IPC handlers `historical:getFinancials`, `historical:getPrices`, `historical:getPricesWithSMA`, `historical:fetchFinancials`, `historical:fetchPrices`, `historical:fetchAndStore`, `historical:needsRefresh`; Polygon API integration for financials and aggregates. **Frontend**: `HistoricalFinancialChart` (Recharts Area chart with metric selector: Revenue, Net Income, EPS, EBITDA, Total Assets, Shareholders Equity, Free Cash Flow; Quarterly/Annual toggle; CSV export), `HistoricalPriceChart` (line chart with volume, timeframe selector 1M/3M/6M/1Y/2Y/5Y, 50-day SMA overlay, price change indicator; CSV export); integrated into AnalysisView with click-to-open from ticker symbols. See [`changelogs/v0.6.0_2026-05-07.md`](changelogs/v0.6.0_2026-05-07.md).

## v0.5.0 — 2026-05-07

Phase 5: Cache Management + Wheel Columns + Real-Time WebSocket. **Cache Management System**: `cache_metadata` table, `CacheManager` service, staleness tracking with 1-hour threshold, `CacheStatusIndicator` UI component (green/red with timestamp), `useCacheStatus` hook polling every 5 minutes, auto-refresh trigger. **Wheel Strategy Columns**: `WheelCalculator` service with suitability formula (ROE×30% + D/E_Quality×30% + MarketCap×20% + Stability×25%), Target Strike (Current × 0.92), Est. Premium (Strike × 1.2%), integrated into watchlist table with color coding and sortable columns via `useSortable` hook. **Real-Time WebSocket**: `WebSocketService` connecting to `wss://delayed.polygon.io/stocks`, trade/aggregate message handlers, exponential backoff reconnection (3s, 6s, 12s, 24s, 48s), `RealtimePriceTicker` component for Analysis view, live price updates in watchlist with green/red indicators, connection status in status bar. New dependencies: `ws`, `recharts`. See [`changelogs/v0.5.0_2026-05-07.md`](changelogs/v0.5.0_2026-05-07.md).

## v0.4.0 — 2026-05-02

Phase 4: Validation Dashboard Polish + Settings/Diagnostics. Chart: pattern callouts at correct price/time coordinates, entry zone band, target line (amber), stop loss, demand/supply zone labels. Section A: EPS sparkline (SVG). Full Settings panel (SettingsView): General, API & Data, Cache & Limits, Diagnostics self-check, Backup & Restore. Settings IPC (9 handlers). Diagnostics IPC. Bug fix: `detectEveningStar` guard was inverted. See [`changelogs/v0.4.0_2026-05-02.md`](changelogs/v0.4.0_2026-05-02.md).

## v0.3.0 — 2026-05-02

Phase 3: Analysis Engine + Producer/Consumer Pipeline. FR-3 fully implemented — 5 analysis modes (Buy Opportunities, Options Income, Wheel Strategy, Bullish Strategies, Bearish Strategies) over any watchlist with composite scoring, entry/stop/target, annualized returns. FR-4.4 Validate All — batch deep-dive with verdict (Strong/Acceptable/Caution/Avoid), full indicator suite. Pipeline: `TokenBucketRateLimiter` + SQLite-backed `JobQueue` for resumable batch jobs. New `analysis_snapshots` + `job_runs` + `job_progress` DB tables. Full indicator library (`computeSMA`, `computeEMA`, `computeRSI`, `computeATR`, `computeADX`, Bollinger, MACD, swing high/low) documented in `docs/formulas.md`. AnalysisView with mode cards, run/cancel, progress bar, mode-specific results, snapshot history, save-as-watchlist.

See [`changelogs/v0.3.0_2026-05-02.md`](changelogs/v0.3.0_2026-05-02.md).

## v0.2.0 — 2026-05-02

Phase 2: Index Screener. FR-2 fully implemented — S&P 500/Russell 1000 screener with 17 default filters, strict/soft-match modes, presets, run history, save-as-watchlist. Polygon DataProvider + fundamentals computer with all ratios documented in `docs/formulas.md`. Quote auto-refresh (60s) on watchlist view. Structured API + error logging (EP-3/EP-4).

See [`changelogs/v0.2.0_2026-05-02.md`](changelogs/v0.2.0_2026-05-02.md).

## v0.1.2 — 2026-05-02

Fix `rebuild:electron` so it actually swaps the better-sqlite3 binary's ABI (v0.1.1's `electron-builder install-app-deps` was a no-op when a Node binary was already in place). Replaces both rebuild scripts with a small `scripts/rebuild-better-sqlite3.mjs` helper that calls `prebuild-install --force` and derives the Electron target dynamically. `npm run dev` now opens the window cleanly and migrations run.

See [`changelogs/v0.1.2_2026-05-02.md`](changelogs/v0.1.2_2026-05-02.md).

## v0.1.1 — 2026-05-02

Swap DB driver back from `node:sqlite` to `better-sqlite3` 12.x now that VS Build Tools 2022 is installed on the dev box. Drops the `createRequire` workaround and the vitest forks-pool/`node:` externals. Adds paired `rebuild:electron` / `rebuild:node` scripts wired into `predev` / `pretest` so the native binary's ABI always matches the runtime. Tests + typecheck still green; no behavior change.

See [`changelogs/v0.1.1_2026-05-02.md`](changelogs/v0.1.1_2026-05-02.md).

## v0.1.0 — 2026-05-01

Initial scaffold. Section 7 (Engineering Practices) infrastructure in place. Phase 1 (FR-1 — watchlist management) implemented end-to-end with persistence, CSV round-trip, and tests. No market-data integration yet.

See [`changelogs/v0.1.0_2026-05-01.md`](changelogs/v0.1.0_2026-05-01.md).
