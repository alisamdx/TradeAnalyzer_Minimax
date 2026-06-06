# Changelog

Reverse-chronological. Per spec EP-2.3, this is the index; per-version detail lives in `changelogs/`.

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
