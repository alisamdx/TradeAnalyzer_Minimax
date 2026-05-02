**Stock Screening & Analysis Application**
Software Requirements Specification
Version 1.0
Prepared for: AI Coding Model
Date: May 2026

# 1. Document Purpose & How to Use This Spec
This document specifies the functional and technical requirements for a Stock Screening & Analysis desktop/web application aimed at an individual retail trader. It is written to be consumed directly by an AI coding model (e.g., Claude Code, Cursor) that will scaffold and implement the system.

### Instructions to the implementing AI
- Treat every numbered requirement (FR-x, NFR-x) as a discrete acceptance test. Each must be demonstrable in the running app.
- Where a choice is left to you, prefer the simplest stack that satisfies all requirements; document the choice in a README.
- Do not invent features outside this spec without flagging them as 'proposed extensions'.
- All financial calculations must be reproducible: log inputs, formulas, and outputs. Never silently fabricate market data.
- If a market data API call fails, surface the error in the UI rather than hiding it or returning stale numbers without a warning.

# 2. Scope

## 2.1 In Scope
- Watchlist management (CRUD, CSV import/export)
- S&P 500 fundamental screener for trading opportunities
- Multi-mode analysis engine (buy, options income, options strategies, trend-based strategies)
- Per-stock validation: fundamentals, market opinion, trend, candlestick chart, technical indicators
- Local persistence of watchlists, screen results, and analysis snapshots

## 2.2 Out of Scope (v1)
- Live order placement / broker execution
- Real-time tick-level streaming (use 15-min delayed or end-of-day data unless paid plan supports real-time)
- Multi-user authentication / cloud sync
- Mobile native apps
- Backtesting engine (may be added in v2)

# 3. Target User
Single primary user: an experienced retail trader running options income strategies (wheel, cash-secured puts, covered calls) and directional swing trades. The user is technically literate, comfortable with finance terminology, and expects fast, dense, information-rich screens — not hand-holding wizards.

# 4. Technical Architecture

## 4.1 Stack (AI's choice, but must satisfy these constraints)
- Cross-platform: must run on macOS and Windows.
- Recommended: Electron + React + TypeScript front-end with a local Python or Node backend for data fetching and analytics. Alternative: a Python + FastAPI backend with a React/Tauri front-end.
- Charting library must support candlesticks, volume bars, and overlay indicators (recommend lightweight-charts or ApexCharts).
- Local persistence: SQLite (recommended) for watchlists, snapshots, and cached market data. Single-file deployment.

## 4.2 Market Data Provider
The implementation MUST use Polygon.io (now branded 'Massive') as the market data provider. The user has a paid Options Starter subscription ($29/month) which provides unlimited API calls and 15-minute delayed data. Despite 'unlimited' calls being advertised, the implementation must still implement disciplined rate limiting and queuing — see Section 4.4.

### 4.2.1 Polygon endpoints to integrate
- Tickers: /v3/reference/tickers (resolve company names, sectors)
- Aggregates (OHLCV bars): /v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}
- Snapshot (last price + day stats): /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}
- Options chain snapshot: /v3/snapshot/options/{underlying} (returns strikes, bid/ask, IV, Greeks, OI, volume)
- Ticker fundamentals: /vX/reference/financials (financial statements; map to P/E, EPS, ROE, margins, etc.)
- Ticker details: /v3/reference/tickers/{ticker} (market cap, share count, sector)
- Dividends: /v3/reference/dividends
- Splits: /v3/reference/splits
- Technical indicators (SMA, EMA, RSI, MACD): /v1/indicators/{indicator}/{ticker}
- WebSocket (delayed): wss://delayed.polygon.io for live snapshot updates
Note: P/E, profit margin, ROE, debt/equity, revenue growth, EPS growth must be computed by the app from the raw financial statements returned by /vX/reference/financials. The implementation must include a unit-tested 'fundamentals computer' module that derives these ratios from the raw data and caches the results.

### 4.2.2 Index constituents (S&P 500, Russell 1000)
Polygon does not provide index constituents directly. The implementation must support these sources, in priority order:
- Maintained constituent list bundled with the app, refreshed manually by the user via a 'Refresh constituents' button.
- Optional: scrape Wikipedia's S&P 500 and Russell 1000 articles as a backup (the AI must implement this respectfully — single fetch per refresh, cached 7 days).
- Allow the user to override the constituent list by importing a CSV.

### 4.2.3 DataProvider interface (still pluggable)
Even though only Polygon is implemented in v1, all data access must go through a DataProvider interface so a future provider swap is a single-class change.
- getQuote(ticker) → last price, bid, ask, volume, day range
- getFundamentals(ticker) → derived ratios (P/E, EPS, market cap, debt/equity, ROE, profit margin, revenue growth, EPS growth, FCF, current ratio, dividend yield, sector, industry, beta)
- getEarningsCalendar(ticker) → next earnings date, time of day, EPS estimate, EPS actual (last 4 quarters)
- getHistoricalBars(ticker, timeframe, lookback) → OHLCV
- getOptionsChain(ticker, expiration) → strikes, bid/ask, IV, delta, gamma, theta, vega, OI, volume
- getIndexConstituents(index) → ticker list for 'sp500' or 'russell1000'. Refreshable; cached locally.

## 4.3 Configuration
- Polygon API key must be stored in OS keychain (preferred) or a local .env file outside the repo. Never committed. Never logged.
- All cache TTLs, rate limits, and batch sizes (Section 4.4) must be configurable from a Settings screen.

## 4.4 Rate limiting, batching, and the producer/consumer pipeline
Despite Polygon's Options Starter offering 'unlimited' API calls, the application must implement conservative client-side rate limiting and a producer/consumer architecture. Reasons: (1) protect against future provider rate-limit changes, (2) avoid being throttled on sustained bursts, (3) make 'Validate All' on a 1,000-name Russell 1000 universe resumable and cancellable without losing work.

### 4.4.1 Architecture
All long-running data builds (Validate All, Screen Run, Analysis Run) must use a two-process producer/consumer pipeline:
- Producer (Fetcher): runs in its own async task / worker thread. Pulls jobs (one ticker each) from a job queue, calls Polygon, places the raw response on a result queue. Respects the configured rate limit. Does not write to the database.
- Consumer (Persister): runs in a separate async task / worker thread. Pulls raw responses from the result queue, parses them, computes derived fields, writes to SQLite. Independent of the fetch loop, so DB writes never block API calls.
- UI Coordinator: subscribes to progress events from both processes (jobs queued, jobs fetched, jobs persisted, jobs failed) and updates the progress UI. Sends 'cancel' / 'pause' / 'resume' commands to the Fetcher.
This decoupling means: while the Fetcher is waiting on Polygon, the Persister is writing the previous batch to disk; while the Persister is writing, the Fetcher is already pulling the next batch. End-to-end throughput is bounded by the slower of the two, not the sum.

### 4.4.2 Rate limit configuration
- Default: 100 requests per minute (well below Polygon's actual limits, leaves headroom for ad-hoc clicks while a long job is running).
- Implemented via a token-bucket rate limiter — not a fixed per-second sleep.
- User-configurable in Settings between 10 and 500 req/min. Document the rationale for each preset (Conservative / Default / Aggressive).
- If Polygon ever returns HTTP 429 (rate limit exceeded), the Fetcher must auto-throttle: halve the rate, exponential backoff for 5 minutes, then gradually ramp back up. Surface this in the UI status bar.

### 4.4.3 Batch sizing
- Tickers are processed in batches (default: 25 per batch). The whole batch's API calls are queued, fetched, and confirmed persisted before moving to the next batch. This makes progress reporting clean and resume points natural.
- Batch size is user-configurable (5 to 100).

### 4.4.4 Resumability
- Every successfully persisted ticker is marked complete in a 'job_runs' table with a timestamp.
- If the user clicks Stop (or closes the app, or it crashes), the job is paused. On next launch, the user is shown 'Resume previous Validate All run? 247 of 1,000 complete.' with options to Resume, Discard, or Start Fresh.
- Even after Stop, all data fetched up to that point is fully usable in the UI — analyses, screens, and validations work on the partial result set without warnings other than a 'partial data' badge.

### 4.4.5 UI progress reporting
- Progress bar shows: total jobs, jobs fetched, jobs persisted, jobs failed, jobs remaining.
- Time estimates: elapsed, ETA at current rate, current rate (req/min).
- Live log stream (collapsible): last 20 lines of fetch/persist activity, with the ticker, endpoint, latency, and status.
- Big visible Stop button. Stop is graceful: in-flight requests complete and are persisted; no new requests are launched.
- Optional: a Pause button (different from Stop) — pauses the fetcher but keeps the queue intact, so Resume picks up exactly where it left off.

### 4.4.6 Failure handling
- Per-ticker failures are logged with the error and skipped — they do not abort the batch.
- After the run, a summary dialog reports: succeeded count, failed count, list of failed tickers with error reasons, and a 'Retry failed only' button.
- Network outage detection: if 5 consecutive requests fail with connection errors, pause the run automatically and prompt the user.

### 4.4.7 Acceptance criteria
- 'Validate All' on a 100-ticker watchlist completes within 2 minutes at the default rate.
- Pressing Stop mid-run leaves the database consistent — no half-written rows; all data fetched before Stop is queryable.
- Resuming a stopped run skips already-completed tickers; processes only the remainder.
- Forcing a 429 response (via test mock) triggers the auto-throttle and surfaces the slowdown in the UI.
- UI remains responsive (chart switches, watchlist navigation work) while a long job runs in the background.

# 5. Functional Requirements

## 5.1 FR-1: Watchlist Management

### 5.1.1 Create / Rename / Delete
- FR-1.1: User can create an unlimited number of named watchlists. Names must be unique (case-insensitive).
- FR-1.2: User can rename and delete any watchlist. Deleting prompts a confirmation.
- FR-1.3: A 'Default' watchlist exists on first run and cannot be deleted (only renamed).

### 5.1.2 Add / Remove Tickers
- FR-1.4: User can add tickers individually (text input with autocomplete from S&P 500 + fallback to provider's universe).
- FR-1.5: Adding an invalid or unknown ticker shows an inline error and does not corrupt the list.
- FR-1.6: User can multi-select tickers and remove them in one action.
- FR-1.7: Each ticker row in a watchlist shows: symbol, last price, day % change, volume, sector. Prices auto-refresh on a configurable interval (default 60s).

### 5.1.3 CSV Import / Export
- FR-1.8: Export the active watchlist to a CSV with columns: ticker, added_date, notes.
- FR-1.9: Import a CSV into a new or existing watchlist. Required column: 'ticker'. Optional: 'notes'. Header row required.
- FR-1.10: On import, invalid tickers are reported in a summary dialog (e.g., '47 imported, 3 skipped: XYZ, ABC, DEF') and skipped — never silently dropped.

### 5.1.4 Acceptance criteria
- Creating, renaming, and deleting watchlists persists across app restarts.
- Round-trip CSV export → import produces an identical watchlist.

# 5.2 FR-2: Search Trading Opportunities (Index Screener)
This module screens a chosen index universe for fundamentally sound trading candidates — stocks 'that can't go wrong'. The user picks the universe, runs a screen, reviews results, and optionally saves the result set as a new watchlist.

### 5.2.1 Universe selection
- FR-2.0a: User can choose the screening universe from: S&P 500, Russell 1000, or 'Both (deduplicated union)'.
- FR-2.0b: The constituent list for each index must be refreshable and cached for 7 days. Show last-refreshed timestamp.
- FR-2.0c: When 'Both' is selected, the union is deduplicated by ticker. Approximate sizes: S&P 500 ≈ 500 names, Russell 1000 ≈ 1,000 names, union ≈ 1,000 (S&P 500 is largely a subset of Russell 1000).

### 5.2.2 Recommended default screening criteria
These defaults are tuned for a retail trader running options income and directional swing trades — they aim to surface large-cap, profitable, growing companies with healthy balance sheets and enough liquidity to support tight option spreads. The user can toggle any filter off and adjust any threshold in the UI.

| **Filter** | **Default** | **Rationale** |
| --- | --- | --- |
| **Market cap** | **≥ $10B** | **Large-cap only; smaller names have wider option spreads and gap risk** |
| **P/E ratio (TTM)** | **5 – 30** | **Profitable but not stretched; excludes meme valuations and likely value traps** |
| **EPS (TTM)** | **> 0** | **Profitable today, not on a promise** |
| **Revenue growth (YoY)** | **≥ 5%** | **Top line is actually growing, not stagnant** |
| **EPS growth (YoY)** | **≥ 5%** | **Earnings growing in line with or ahead of revenue** |
| **Debt-to-equity** | **< 1.5** | **Manageable leverage for non-financials; finance sector exempted by default** |
| **Return on equity** | **≥ 15%** | **Capital efficiency — separates real businesses from asset-heavy laggards** |
| **Profit margin (net)** | **≥ 8%** | **Pricing power and operational discipline** |
| **Free cash flow** | **Positive (TTM)** | **Real cash, not just accounting earnings** |
| **Current ratio** | **≥ 1.0** | **Can cover short-term obligations** |
| **Avg daily volume (30d)** | **≥ 1M shares** | **Liquidity floor for both stock and options** |
| **Avg option volume (30d)** | **≥ 1,000 contracts** | **Ensures options are tradeable** |
| **Price** | **≥ $20** | **Avoids penny-stock-style behavior; below $20 the wheel/CSP math gets thin** |
| **Distance from 52-wk high** | **Within 25%** | **Healthy uptrend; excludes broken charts** |
| **Distance from 52-wk low** | **≥ 15%** | **Not at the bottom of a freefall** |
| **Beta (vs S&P 500)** | **0.7 – 1.6** | **Excludes both flatliners and meme-volatility names** |
| **Sector exclude list** | **User-configurable, empty by default** | **Lets the user blacklist sectors they distrust** |
| **Earnings within N days** | **Exclude if ≤ 7 days (toggle)** | **Avoids surfacing stocks with imminent binary risk** |

### 5.2.3 Soft-match mode
- FR-2.0d: User can switch between 'Strict' (must pass all filters) and 'Soft-match' (rank by number of filters passed; show top N).
- FR-2.0e: In soft-match mode, each row shows a 'pass score' (e.g., '14 / 17 criteria passed') and which filters failed.

### 5.2.4 Functional requirements
- FR-2.1: Run-screen button executes all enabled filters against the chosen universe.
- FR-2.2: Results table shows ticker, company name, sector, all filter values, and the pass score.
- FR-2.3: User can sort and re-sort results by any column.
- FR-2.4: User can multi-select results and click 'Save as Watchlist' → prompts for watchlist name → creates and switches to it.
- FR-2.5: User can save filter presets (named, including the universe choice) and recall them later. At least one preset named 'Default' ships out of the box.
- FR-2.6: A 'Last run' timestamp is displayed; underlying fundamentals data shows its own freshness timestamp from the provider.
- FR-2.7: Universe size and number of names passed are shown above the results (e.g., 'Russell 1000: 1,003 scanned, 87 passed').

### 5.2.5 Acceptance criteria
- Running the default screen on S&P 500 completes in under 30 seconds (cached fundamentals).
- Running the default screen on Russell 1000 completes in under 90 seconds (cached fundamentals).
- Saving 20 results as a new watchlist creates a watchlist with exactly those 20 tickers.
- Switching universe from S&P 500 to Russell 1000 and re-running produces a result set that is a strict superset (or close to one) of the S&P 500 result set under identical filters.

# 5.3 FR-3: Analysis Engine
The Analysis screen has two parts: (A) select the watchlist to analyze, and (B) select the analysis type. Output is a ranked, filterable result set that can be saved as a new watchlist.

### 5.3.1 Part A — Watchlist selection
- FR-3.1: Dropdown of all existing watchlists.
- FR-3.2: Show count of tickers in the selected list.
- FR-3.3: 'Select all' / 'Select subset' checkbox UI to limit analysis to a subset of the list.

### 5.3.2 Part B — Analysis types
The user picks one of the following analysis modes. Each mode produces a results table with mode-specific columns.
**Mode 1 — Buy Opportunities:**
  - Identifies stocks currently in a 'buy zone' based on a composite score combining: trend (price > 50-day SMA > 200-day SMA), momentum (RSI 40–65), pullback depth (within 5–10% of recent swing low), and fundamentals pass (FR-2 criteria).
  - Output columns: ticker, last price, suggested entry zone, stop-loss, target, risk/reward, composite score.
**Mode 2 — Options Income (Calls & Puts):**
  - For each ticker, evaluates cash-secured put and covered call candidates 30–45 DTE, delta 0.20–0.35.
  - Output columns: ticker, strategy (CSP/CC), strike, expiration, DTE, delta, premium, annualized return, IV rank, breakeven, capital required.
**Mode 3 — Wheel Strategy Opportunities:**
  - Screens for stocks suitable for the wheel strategy: stable uptrend or sideways, IV rank ≥ 30, no earnings within the DTE window, sufficient option liquidity (open interest ≥ 500, bid-ask spread ≤ 5% of mid), and acceptable assignment risk (price not at 52-week extremes).
  - For each candidate, recommend a cash-secured put 30–45 DTE at delta 0.20–0.30.
  - Output columns: ticker, recommended CSP strike, expiration, DTE, delta, premium, annualized return on capital, IV rank, days to earnings, option liquidity score, overall suitability score (1–10).
  - The suitability score is a transparent weighted formula combining trend stability, IV rank, liquidity, distance to earnings, and assignment-comfort (would the user be okay owning this stock at the strike?). The formula must be documented in the README.
**Mode 4 — Bullish Trend Strategies:**
  - Identifies bullish-trending stocks and proposes the appropriate options strategy: long call, bull call spread, or short put, with strikes and expirations.
  - Output columns: ticker, trend strength, suggested strategy, structure (legs/strikes/expirations), max profit, max loss, breakeven, probability of profit.
**Mode 5 — Bearish Trend Strategies:**
  - Identifies bearish-trending stocks and proposes: long put, bear put spread, or short call, with strikes and expirations.
  - Output columns: same shape as Mode 4.

### 5.3.3 Result handling
- FR-3.4: Each analysis run shows progress (e.g., 'Analyzing 47 of 120…') and is cancellable.
- FR-3.5: Results are sortable, filterable, and exportable to CSV.
- FR-3.6: 'Save as Watchlist' creates a new watchlist from selected result rows.
- FR-3.7: Each analysis run is timestamped and stored as a snapshot the user can re-open later.

# 5.4 FR-4: Validate All Stocks in a Watchlist
This module is the deep-dive screen. The user selects a watchlist and then drills into a single stock. A 'Pull Market Data' button refreshes the validation in real time — target completion under 5 seconds per stock.

### 5.4.1 Workflow
- FR-4.1: User picks a watchlist; a list of its tickers appears in a left-hand panel.
- FR-4.2: User clicks a ticker; the right pane loads the validation dashboard. A spinner indicates loading; partial sections render as data arrives.
- FR-4.3: A 'Refresh' button re-pulls all data for the active stock and timestamps the result.
- FR-4.4: A 'Validate All' button iterates through every ticker in the watchlist sequentially, caches the results, and shows a status grid (green = pass, yellow = caution, red = fail) the user can sort.

### 5.4.2 Validation dashboard sections
**A. Executive Summary (fundamental verdict):**
  - Plain-language verdict: 'Strong', 'Acceptable', 'Caution', or 'Avoid', with a 2–4 sentence explanation.
  - Show: P/E, EPS (TTM), revenue growth, profit margin, debt/equity, ROE.
  - Show: next earnings date, days until earnings, last 4 quarters EPS estimate vs actual (table or sparkline).
  - Highlight earnings within 14 days as a warning banner.
**B. Market Opinion (Buy / Hold / Sell):**
  - Aggregate analyst rating (provider-supplied) — number of buys/holds/sells, average price target, % upside vs current price.
  - Display as a clear badge: BUY (green), HOLD (gray), SELL (red).
**C. Trend (Bullish / Bearish / Sideways):**
  - Determined by the relationship of price to 20/50/200-day SMAs and ADX strength.
  - Bullish = price > 50 SMA > 200 SMA, ADX > 20. Bearish = price < 50 SMA < 200 SMA, ADX > 20. Otherwise sideways.
  - Show trend label, ADX value, and the SMA stack as small numeric chips.
**D. Candlestick Chart with Entry/Exit Zones:**
  - Daily candlestick chart, default 6-month window, user-toggleable to 1M / 3M / 1Y / 5Y.
  - Overlays: 20/50/200 SMA, volume sub-pane, recent support/resistance lines (auto-detected swing highs/lows).
  - Mark a 'suggested entry zone' (shaded band) and 'suggested exit / stop' line, computed from recent support, ATR, and the trend mode. The math used must be shown in a tooltip or 'how was this calculated?' panel.
  - Pattern callouts: highlight any of doji, engulfing, hammer, shooting star, morning/evening star detected in the last 5 candles.
**E. Other Indicators:**
  - RSI (14), MACD (12/26/9), Bollinger Bands (20, 2σ).
  - Volume profile: 30-day average volume vs today's volume, percentage anomaly.
  - Supply/demand zones: identify and shade the most recent demand zone (last meaningful base before an up-move) and supply zone (last meaningful base before a down-move).
  - Implied volatility: current IV, 52-week IV range, IV rank, IV percentile.
  - Short interest % of float (if provider supplies it).

### 5.4.3 Performance
- FR-4.5: Single-stock validation must complete and render within 5 seconds (warm cache) or 10 seconds (cold).
- FR-4.6: 'Validate All' for a 50-ticker watchlist must complete within 5 minutes and must not freeze the UI.

# 6. Non-Functional Requirements
- NFR-1 Performance: App startup < 3 seconds. Watchlist switching < 500ms. Chart render < 1s for 1Y of daily data.
- NFR-2 Reliability: All API calls must have retry-with-backoff (3 attempts) and surface failures to the UI. No silent failures.
- NFR-3 Caching: Fundamentals cached 24h, quotes 60s (configurable), options chains 5 min, S&P 500 constituent list 7 days.
- NFR-4 Persistence: Watchlists, snapshots, settings, and cached data survive app restart. SQLite recommended.
- NFR-5 Logging: Structured logs (JSON) of all data fetches, screen runs, and analysis runs. User-accessible log viewer or log file path shown in Settings.
- NFR-6 Error handling: API rate-limit errors must be caught, the UI must show a clear message, and the app must auto-throttle subsequent calls.
- NFR-7 Security: API keys stored in OS keychain or a .env file outside the repo. Never logged. Never sent anywhere except to the configured provider.
- NFR-8 Testability: DataProvider interface must be mockable. Unit tests for screening logic, analysis math, and indicator calculations are required.
- NFR-9 Accessibility: All controls keyboard-navigable. Color is never the only signal (use icons + color for buy/sell badges, trend, etc.).
- NFR-10 Documentation: README must cover: install, API key setup, running, building, architecture overview, and how to add a new analysis mode or DataProvider.

# 7. Engineering Practices & Project Hygiene
This section is mandatory. The implementing AI must set up all of the following on first build and maintain them on every subsequent change. These practices exist so the codebase remains debuggable, regression-safe, and AI-resumable across sessions.

## 7.1 Application Versioning
- EP-1.1: The application must carry a semantic version (MAJOR.MINOR.PATCH) stored in a single canonical file (e.g., package.json or pyproject.toml). Initial version: 0.1.0.
- EP-1.2: The version is displayed in the app's About dialog AND in the bottom status bar.
- EP-1.3: Every PR / material commit must bump the version per semver: PATCH for fixes, MINOR for new features, MAJOR for breaking changes.
- EP-1.4: Logged events, error reports, and snapshots must include the app version that produced them.

## 7.2 Changelog Folder
- EP-2.1: Maintain a /changelogs directory at the repo root. Each material change creates a new file: changelogs/v{version}_{YYYY-MM-DD}.md.
- EP-2.2: Each changelog file must include: version, date, summary, list of features added, list of bugs fixed, list of breaking changes, and 'AI session notes' (free-form context the AI thought future sessions would need to know).
- EP-2.3: Maintain a top-level CHANGELOG.md that is the concatenation/index of all per-version files, newest first.
- EP-2.4: Trivial commits (typos, formatting) do not require a changelog entry. Anything that changes behavior, schema, public API, dependencies, or rate-limit defaults does.

## 7.3 API Call Log Folder
- EP-3.1: Maintain a /logs/api directory. Every outbound API call to Polygon (or any future DataProvider) must be logged.
- EP-3.2: Log fields per call: timestamp (ISO 8601 with ms), provider, endpoint, HTTP method, request params (with API key redacted), response status, response latency in ms, response size in bytes, retry count, job_run_id (if part of a batch run).
- EP-3.3: Log files rotate daily (one file per day, e.g., api_2026-05-01.jsonl) and are kept for 30 days by default. Older files are auto-deleted; retention is configurable in Settings.
- EP-3.4: Log format: JSON Lines (one JSON object per line) for easy grep/jq inspection.
- EP-3.5: A 'View API Logs' button in Settings opens the directory or pipes the latest file into a viewer.
- EP-3.6: Personally identifiable data and API keys must NEVER appear in these logs. The logger must scrub them at write time.

## 7.4 Error Handling & Error Log Folder
- EP-4.1: Maintain a /logs/errors directory. Every uncaught exception, every API failure after retries are exhausted, and every job-level failure must produce an error log entry.
- EP-4.2: Error log fields: timestamp, app version, error class, message, stack trace, the operation that triggered it (e.g., 'validate_all', 'screen_run'), the relevant ticker (if any), and a correlation_id that links to the api log entries that led up to the error.
- EP-4.3: Errors are written as JSON Lines, rotated daily, kept for 90 days.
- EP-4.4: Errors must be classified at three levels: WARNING (recoverable, run continued), ERROR (operation aborted but app survives), FATAL (app must restart). The UI surfaces ERROR/FATAL via a toast notification with a 'View details' link.
- EP-4.5: A user-friendly error report dialog is available from Settings: shows last 50 errors, allows filtering by level, allows export of a sanitized error bundle for sharing with a developer/support.
- EP-4.6: No error path may swallow exceptions silently. Every except/catch block either handles the error meaningfully OR logs it and re-raises.

## 7.5 AI Context Memory File
This is critical for working with an AI coding model across sessions. The AI must create and maintain a structured memory file that lets a fresh AI session pick up the project without re-reading the entire codebase.
- EP-5.1: On first build, the AI creates /AI_CONTEXT.md at the repo root.
- EP-5.2: On every subsequent material change, the AI updates the relevant sections of /AI_CONTEXT.md as part of the same commit.
- EP-5.3: Required sections in AI_CONTEXT.md:
  - Project Overview — 1-paragraph elevator pitch of what the app does and who it is for.
  - Tech Stack — exact framework, language, key libraries, and versions, with rationale for each choice.
  - Repository Map — top-level folder structure and what lives where, with one-line descriptions.
  - Domain Glossary — definitions of trading terms used in the code (CSP, wheel, IV rank, delta, DTE, etc.) so a future AI doesn't misinterpret variable names.
  - Architecture — diagram or prose describing the producer/consumer pipeline, data flow, and process boundaries.
  - Data Model — current SQLite schema, with notes on which tables are caches vs persistent state.
  - DataProvider Contract — the interface every provider must implement; how Polygon currently implements it.
  - Open Decisions — design questions that are still unresolved, with current best thinking.
  - Known Quirks & Gotchas — non-obvious things future-AI must know (e.g., 'Polygon's financials endpoint returns nulls for fiscal_period during pre-IPO years; we filter these out in the fundamentals computer').
  - Recent Changes — last 5 changelog summaries, newest first.
  - How to Run — install, run dev, run tests, build production, all in copy-pasteable commands.
- EP-5.4: AI_CONTEXT.md must stay under 1,500 lines. When it grows beyond that, the AI must compact older 'Recent Changes' into the changelog folder and prune.
- EP-5.5: A short /AI_PROMPT.md sibling file contains the standing instructions for any AI session ('Read AI_CONTEXT.md first. Follow the practices in the Requirements doc. Never bypass rate limiter. Always update CHANGELOG and AI_CONTEXT for material changes.').

## 7.6 Automated Testing & Regression Suite
- EP-6.1: All non-trivial logic must have unit tests: fundamentals computer, indicator calculations (RSI, MACD, ADX, etc.), screening filter logic, suitability score formula, rate limiter, queue/batch sizing math, CSV import/export round-trip, options strategy structure builders.
- EP-6.2: Integration tests cover: DataProvider against a mocked Polygon (recorded responses), the full producer/consumer pipeline including pause/resume/stop, watchlist CRUD and CSV round-trip, screen run end-to-end, validate-all end-to-end.
- EP-6.3: A small smoke-test suite runs against the live Polygon API with a single ticker (e.g., AAPL) — opt-in via env var POLYGON_LIVE_TESTS=1 — to catch provider API breakages.
- EP-6.4: Test coverage target: ≥ 70% lines, ≥ 80% on financial calculations and rate-limit/queue code (these are the highest-risk areas).
- EP-6.5: All tests must run via a single command (e.g., `npm test` or `pytest`) and complete in under 90 seconds for the offline suite.
- EP-6.6: A pre-commit git hook runs the offline test suite and blocks commits on failure.
- EP-6.7: Every bug fix must include a regression test that fails before the fix and passes after.

## 7.7 Git Workflow
- EP-7.1: Initialize a git repo on first build. .gitignore must exclude .env, /logs, build artifacts, node_modules, __pycache__, .venv, the SQLite database file.
- EP-7.2: API keys, secrets, or any local user data must never be committed. Provide an .env.example with placeholders.
- EP-7.3: Commit messages follow Conventional Commits: feat:, fix:, docs:, refactor:, test:, chore:, perf:, with a clear short summary.
- EP-7.4: Each material change is a single commit (or a small, logically-grouped set) — not 'WIP' or 'misc fixes' dumps. The commit message should make sense to someone reading the log a year later.
- EP-7.5: A commit that bumps version must update both the version file AND the changelog AND AI_CONTEXT.md in the same commit. The pre-commit hook should warn if version was bumped without a corresponding changelog entry.
- EP-7.6: A README.md at the repo root covers: what the app is, prerequisites, install, configuration (.env setup), how to run, how to test, how to build, troubleshooting, and links to AI_CONTEXT.md and CHANGELOG.md.

## 7.8 Code Quality
- EP-8.1: Linter and formatter configured and enforced via pre-commit hook (e.g., ESLint + Prettier for JS/TS, ruff + black for Python).
- EP-8.2: Type checking enforced (TypeScript strict mode, or mypy/pyright for Python).
- EP-8.3: No commented-out code in committed files. Dead code goes away; if it might come back, it lives in a branch.
- EP-8.4: Magic numbers go in a /config or /constants module with named exports. Especially: rate limit defaults, screening thresholds, cache TTLs, batch sizes.

## 7.9 Database Migrations
- EP-9.1: Schema changes use a numbered migration system (e.g., /migrations/001_init.sql, /migrations/002_add_job_runs.sql).
- EP-9.2: On app launch, any pending migrations run automatically. The current schema version is stored in a `schema_version` table.
- EP-9.3: Migrations are forward-only by default; rollback scripts are optional but recommended for risky migrations.
- EP-9.4: Before every migration runs, the SQLite file is auto-backed-up to /backups/db_pre_v{schema_version}_{timestamp}.sqlite. Last 5 backups retained.

## 7.10 Telemetry & Observability (local only)
- EP-10.1: A simple in-app diagnostics panel (Settings → Diagnostics) shows: app version, schema version, DB file size, log directory sizes, cache hit rates over last 24h, average API latency, last 10 errors, and a 'Run self-check' button that pings Polygon, queries each cache table, and reports green/red on each subsystem.
- EP-10.2: NO data is ever sent off the user's machine. All telemetry is local.

## 7.11 Backup & Export
- EP-11.1: A 'Backup Everything' button in Settings creates a single zip containing: SQLite file, watchlist CSVs, screen presets JSON, recent logs, and AI_CONTEXT.md.
- EP-11.2: A 'Restore from Backup' button accepts the same zip and restores all of it, with a confirmation dialog.
- EP-11.3: A scheduled auto-backup (default: weekly) writes to /backups, keeping the last 4 backups.

## 7.12 Documentation Folder
- EP-12.1: /docs at repo root contains: architecture.md (deeper dive than AI_CONTEXT), data-provider.md (Polygon endpoint mappings), formulas.md (every financial formula used in the app, with citation/source), troubleshooting.md (common errors and fixes).
- EP-12.2: Every formula in code that derives a financial metric must reference the corresponding entry in formulas.md via a comment (e.g., `// see docs/formulas.md#price-to-earnings`).

## 7.13 Acceptance Criteria for Engineering Practices
- On a fresh clone of the repo, a developer (or AI) can read AI_CONTEXT.md + README.md and become productive without reading any other files.
- Running the test suite from a fresh clone passes all tests.
- Pre-commit hook prevents committing if tests fail, lint fails, or version was bumped without changelog.
- Logs, changelogs, and error reports are easy to find and human-readable.
- Restoring from a backup zip on a fresh install yields a fully working app with all original data.

# 8. Suggested Data Model
The implementing AI may adjust this schema, but the resulting data model must support all functional requirements above.

| **Table** | **Key columns** |
| --- | --- |
| **watchlists** | **id, name (unique), created_at, updated_at** |
| **watchlist_items** | **id, watchlist_id (FK), ticker, notes, added_at** |
| **screen_presets** | **id, name, criteria_json, created_at** |
| **screen_runs** | **id, preset_id (nullable), criteria_json, run_at, result_count** |
| **screen_results** | **id, screen_run_id (FK), ticker, payload_json (per-row data)** |
| **analysis_snapshots** | **id, watchlist_id, mode, run_at, payload_json** |
| **fundamentals_cache** | **ticker (PK), payload_json, fetched_at** |
| **quote_cache** | **ticker (PK), last, bid, ask, volume, fetched_at** |
| **options_cache** | **ticker, expiration, payload_json, fetched_at** |
| **job_runs** | **id, type (validate_all/screen/analysis), watchlist_id, status (running/paused/stopped/completed/failed), started_at, ended_at, total_count, succeeded_count, failed_count, config_json** |
| **job_progress** | **id, job_run_id (FK), ticker, status (pending/fetched/persisted/failed), error_msg, processed_at** |
| **settings** | **key (PK), value** |

# 9. UI Layout (high-level)
- Left sidebar: Watchlists (list, with active highlight), Screener, Analysis, Validate, Settings.
- Top bar: provider status indicator (green/red), market open/closed badge, time, refresh button.
- Main pane: contextual to the selected sidebar section.
- Bottom status bar: last data fetch timestamp, cache freshness, app version.
- All tables support: sort, multi-select, copy-to-clipboard, export CSV.
- Visual style: dense, dark-mode-first (light mode toggle), monospace for numbers.

# 10. Open Questions for Implementer
The following are explicitly left to the implementing AI to propose answers for in a 'Design Decisions' section of the README, before writing code:
- Final choice of stack (Electron vs Tauri vs FastAPI+React, etc.) and justification.
- Final choice of charting library.
- How options Greeks are sourced — Polygon's options chain snapshot includes Greeks and IV, but if any field is missing for a contract, propose a fallback (e.g., compute via Black-Scholes from the contract's IV and current rates).
- How 'suitability score' for the wheel-strategy mode is normalized (recommend a transparent 1–10 weighted formula, documented in README).
- Mapping from Polygon's /vX/reference/financials response shape to the derived ratios (P/E, ROE, debt/equity, profit margin, revenue growth, EPS growth, FCF, current ratio). Document the formulas used and any field-mapping assumptions.
- Technology choice for the producer/consumer pipeline (asyncio + aiohttp + queues, BullMQ, Celery, etc.) — pick the simplest that fits the chosen stack.

# 11. Acceptance Demo Script
The following end-to-end flow must run without errors on a fresh install:
1. Install app, configure provider API key, launch.
1. Create a new watchlist 'Demo'. Add tickers AAPL, MSFT, NVDA. Export to CSV. Delete the watchlist. Re-import the CSV into a new watchlist 'Demo2'.
1. Run screener with default filters on S&P 500 universe. Save top 10 results as 'Top10'.
1. Switch universe to Russell 1000, re-run, confirm result set is larger. Save filter as preset 'My Defaults'.
1. Analyze 'Top10' in 'Wheel Strategy Opportunities' mode. Save 5 best as 'WheelCandidates'.
1. Validate all stocks in 'WheelCandidates'. Drill into one stock; verify all 5 dashboard sections (A–E) render with real data within 10 seconds.
1. Trigger 'Validate All' on a 100-ticker watchlist. Watch the progress bar advance. Press Stop after ~30 tickers. Confirm: data for completed tickers is queryable, the run shows 'stopped' status, and the UI was responsive throughout.
1. Restart the app; confirm the prompt to resume the stopped run. Resume; confirm only the remaining tickers are fetched and the run completes.
1. Restart the app again; confirm all watchlists, the screen preset, and the analysis snapshot persist.
1. Open Settings → Diagnostics. Click 'Run self-check'. Confirm all subsystems report green. Click 'View API Logs' and confirm today's log file shows the calls just made.
1. Click 'Backup Everything'. Confirm a zip is created. Delete the SQLite file. Click 'Restore from Backup' and select the zip. Confirm all watchlists and snapshots return.
1. Confirm /AI_CONTEXT.md, /CHANGELOG.md, /changelogs/, /logs/api/, /logs/errors/, /docs/, /migrations/, /backups/ all exist and have current content.
