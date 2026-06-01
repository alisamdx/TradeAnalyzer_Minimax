# AI_CONTEXT

> Read this file first. It is intentionally self-contained so a fresh AI session can become productive without re-reading the codebase. Keep it under 1,500 lines.

## Project Overview

**TradeAnalyzer** is a single-user, cross-platform desktop application for a retail options/swing trader. It manages watchlists, screens index universes (S&P 500 / Russell 1000) for fundamentally sound trade candidates, runs analysis modes (buy zones, options income, wheel, bullish/bearish strategies), and provides per-stock validation dashboards. All market data comes from Polygon.io; persistence is local SQLite. No cloud sync, no multi-user, no broker execution.

The full spec is in `Requirements/REQUIREMENTS.md`. This file summarizes the build state.

## Tech Stack

| Layer | Choice | Version | Rationale |
| --- | --- | --- | --- |
| Shell | Electron | 32.x | Spec recommends; mature cross-platform desktop runtime; rich Node + Chromium APIs |
| UI | React + TypeScript | 18 / 5.x | Spec recommends; ecosystem fit for charting libs and tables |
| Build | electron-vite | 2.x | Single config file for main + preload + renderer; fast HMR |
| DB | better-sqlite3 | 12.x | Synchronous API; well-supported on Electron via `electron-rebuild` (wired through `electron-builder install-app-deps` as `postinstall`). Wrapped in `src/main/db/connection.ts` (`openDatabase`, `withTransaction`) so the driver isn't leaked across the codebase. |
| Charts | lightweight-charts | 4.1.x | Finance-focused; high performance for OHLCV data; easier to style than ApexCharts for our needs. |
| Tests | Vitest | 2.x | Native Vite integration; fast; jest-compatible API |
| Lint/format | ESLint 9 + Prettier 3 | — | Industry standard |
| CSV | hand-rolled (Phase 1) | — | One file, RFC-4180-ish; no deps; pluggable later if needed |

Final choices and trade-offs also captured in `README.md → Design Decisions`.

## Repository Map

```
TradeAnalyzer/
  .ai/
    AI_CONTEXT.md          ← this file
    AI_PROMPT.md           ← standing instructions for AI sessions
    CLAUDE.md              ← Claude Code project instructions
  Requirements/
    REQUIREMENTS.md        ← full functional/non-functional spec
  README.md                ← human-facing onboarding + design decisions
  CHANGELOG.md             ← reverse-chronological summary of every release
  changelogs/              ← per-version markdown files (see EP-2)
  docs/                    ← architecture.md, data-provider.md, formulas.md, troubleshooting.md
  migrations/              ← numbered SQL migrations (001_init.sql, ...)
  src/
    main/                  ← Electron main process: db, services, IPC handlers
      index.ts             ← app lifecycle + window creation + Phase 1+2 IPC registration
      db/                  ← connection.ts, migrations.ts
      services/            ← watchlist-service.ts, csv.ts (Phase 1); screener-service.ts,
                             constituents-service.ts, polygon-provider.ts, cache-service.ts,
                             fundamentals-computer.ts, logger.ts (Phase 2); analysis-service.ts,
                             rate-limiter.ts, job-queue.ts, validate-all-service.ts (Phase 3);
                             agent-db-service.ts (v0.12.0 — read-only access to TraderAgent DB)
      api-server.ts        ← ApiServer class (Phase 11); token/port file management
      api/                 ← REST route modules (Phase 11): routes-health, routes-watchlists,
                             routes-screener, routes-analysis, routes-validation, routes-options,
                             routes-quotes, routes-fundamentals, routes-jobs, routes-settings, helpers
      ipc/                 ← ipc-watchlists.ts (Phase 1), ipc-screener.ts (Phase 2),
                             ipc-analysis.ts (Phase 3), ipc-agent.ts (v0.12.0)
    preload/               ← context-isolated bridge: exposes window.api.* (Phase 1–3)
      index.ts
    renderer/              ← React UI
      index.html
      src/
        main.tsx           ← React entry
        App.tsx            ← top-level layout (sidebar + main pane) + AnalysisView (Phase 3)
        api.ts             ← typed wrapper around window.api.* (deprecated — use window.api directly)
        views/
          WatchlistView.tsx (Phase 1 — merged into App)
          ScreenerView.tsx  (Phase 2)
          AnalysisView.tsx  (Phase 3)
          AgentView.tsx     (v0.12.0)
          screener-filters.ts (Phase 2)
        styles.css
    shared/                ← types shared between main and renderer
      types.ts
  tests/                   ← Vitest unit + integration tests
  logs/                    ← runtime logs (gitignored), api/ and errors/ subdirs
  backups/                 ← runtime DB backups (gitignored)
```

## Domain Glossary

- **CSP** — Cash-Secured Put. Selling a put while holding enough cash to buy 100 shares at the strike if assigned.
- **CC** — Covered Call. Selling a call against 100 owned shares.
- **Wheel** — Strategy: sell CSPs until assigned, then sell CCs against the assigned stock until called away, repeat.
- **DTE** — Days To Expiration of an option contract.
- **Delta** — First-order Greek; ≈ probability of finishing ITM, also share-equivalence for hedging.
- **IV** — Implied Volatility. **IV rank** = where today's IV sits in its 52-week range (0 = low, 100 = high). **IV percentile** = % of days in the past year IV was below today.
- **OI** — Open Interest (number of outstanding contracts).
- **OHLCV** — Open/High/Low/Close/Volume bar.
- **TTM** — Trailing Twelve Months.
- **ROE** — Return On Equity = Net Income / Shareholders' Equity.
- **D/E** — Debt-to-Equity = Total Debt / Shareholders' Equity.
- **FCF** — Free Cash Flow = Operating Cash Flow − Capital Expenditures.
- **ADX** — Average Directional Index; trend-strength oscillator.
- **Strict / Soft-match (screener)** — Strict: must pass all enabled filters. Soft-match: rank by count of filters passed.
- **Validate All** — long-running batch that runs the full validation dashboard for every ticker in a watchlist; uses producer/consumer pipeline (Phase ≥ 3).

## Architecture

### Process model
- **Main process** (`src/main/`) owns the SQLite connection, all DataProvider calls, the rate limiter, and the producer/consumer pipeline. It exposes a typed IPC surface.
- **Preload script** (`src/preload/`) uses `contextBridge` to expose `window.api` with only the safe IPC methods the renderer needs. Context isolation is on; nodeIntegration is off.
- **Renderer** (`src/renderer/`) is a stock React/Vite app. It never touches Node, the filesystem, or the network directly — only `window.api.*`.

### Data flow (Phase 3)
```
React view ──invoke──▶ window.api.* ──ipcRenderer.invoke──▶ main IPC handler ──▶ Service ──▶ better-sqlite3
                                                                                            │
                                                                                            └──▶ DataProvider (Polygon.io)
```

### Producer/consumer pipeline (§4.4)
Implemented in Phase 3: `TokenBucketRateLimiter` (configurable 10–500 rpm) + SQLite-backed `JobQueue` for resumable batch jobs (`job_runs` + `job_progress` tables). Used by both the Analysis Engine and Validate All batch processing.

## Data Model

Authoritative DDL is in `migrations/001_init.sql` + `002_screen_schema.sql`. Phase 1 creates watchlists + items + settings. Phase 2 adds:

| Table | Purpose | Persistent / Cache |
| --- | --- | --- |
| `schema_version` | Tracks applied migrations | persistent |
| `watchlists` | Named watchlists | persistent |
| `watchlist_items` | Tickers in a watchlist | persistent |
| `settings` | Free-form key/value | persistent |
| `constituents` | S&P 500 / Russell 1000 ticker list | persistent (refreshable) |
| `constituents_meta` | Last refresh timestamp + source | persistent |
| `screen_presets` | Saved filter presets (FR-2.5) | persistent |
| `screen_runs` | Past screen runs with result count | persistent |
| `screen_results` | Per-ticker filter values + pass score | persistent |
| `analysis_snapshots` | Past analysis runs | persistent |
| `job_runs` | Batch job metadata (status, type, config) | persistent |
| `job_progress` | Per-ticker job status (pending/fetched/persisted/failed) | persistent |
| `fundamentals_cache` | Derived ratios, 24h TTL | cache |
| `quote_cache` | Last price / volume / IV, 60s TTL | cache |
| `options_cache` | Options chain, 5min TTL | cache |

## DataProvider Contract

`src/main/services/data-provider.ts` defines the `DataProvider` interface. Polygon implementation at `polygon-provider.ts`. Methods:

- `getQuote(ticker)` → `QuoteSnapshot` (price, bid/ask, volume, IV rank/percentile)
- `getFundamentals(ticker)` → `DerivedRatios` (P/E, EPS, ROE, D/E, profit margin, etc.)
- `getEarningsCalendar(ticker)` → `EarningsInfo` (stub in Phase 2; Polygon has no public endpoint)
- `getHistoricalBars(ticker, timeframe, lookback)` → `HistoricalBar[]`
- `getOptionsChain(ticker, expiration)` → `OptionsChain`
- `getIndexConstituents(index)` → `ConstituentRow[]` (no-op — `ConstituentsService` handles this)
- `ping()` → health check

## Open Decisions

- **Suitability score formula (wheel)** — Documented in `docs/formulas.md`. Wheel suitability = weighted score 1–10 (IV rank, stability, liquidity, earnings proximity, ROE, FCF).
- **Settings storage** — API key currently loaded from `.env`; OS keychain via `keytar` implemented in Phase 2. OS-level "System Settings" integration deferred.

## Known Quirks & Gotchas

- **DB driver is better-sqlite3 12.x**, wrapped behind `src/main/db/connection.ts` (`openDatabase`, `withTransaction`). Service code only uses the lowest-common-denominator API (`prepare`, `run`, `get`, `all`, `exec`) so the wrapper is the swap point if we ever change drivers. Don't reach for `db.transaction(fn)()` directly — use `withTransaction(db, fn)` so test code stays driver-agnostic.
- **better-sqlite3 binary flips between Node and Electron ABIs.** Only one `better_sqlite3.node` binary lives in `node_modules` at a time. `npm run predev` / `npm run pretest` call paired rebuild scripts that swap the correct prebuild in. If you see `NODE_MODULE_VERSION 128 vs 137` errors, run the matching `rebuild:*` script.
- **Why not `electron-builder install-app-deps`.** Tried first. It reported "finished" but didn't actually replace a Node-built binary that was already sitting in `build/Release/`. `prebuild-install --force` does, deterministically. Don't rewire `rebuild:electron` to use `electron-builder install-app-deps` again without verifying it actually swaps the binary's ABI.
- **Case-insensitive unique watchlist names.** Enforced by a unique index on `lower(name)` in SQLite. The service also pre-checks before insert to give a clean error.
- **The 'Default' watchlist is undeletable.** Enforced in the service layer (delete throws) AND created idempotently on app startup. Renaming is allowed.
- **CSV header.** Required column: `ticker`. Optional: `notes`, `added_date`. Header row is mandatory. Tickers are uppercased and trimmed; rows with missing/empty ticker are reported as skipped.
- **`node:fetch` does not exist in Node 24.** Use the global `fetch` (available since Node 18). Do not `import { fetch } from 'node:fetch'` — it will fail at runtime.
- **`PolygonDataProvider.getIndexConstituents` is a no-op.** Constituents are loaded by `ConstituentsService` from bundled CSVs + SQLite cache. The DataProvider method exists only for interface completeness.
- **IV rank/percentile are null** from the Polygon snapshot endpoint. Phase 3's pipeline will compute these from 52-week IV history after fetching. The screener accepts these as null (filter is disabled by default).
- **Earnings calendar returns null** — Polygon has no public earnings calendar endpoint. Phase 3 may add a respectful web scrape or defer to a dedicated endpoint when available.
- **Migration tests are migration-count-agnostic.** Tests check that migrations apply and are idempotent without asserting a specific count (Phase 2 adds migration 002).
- **`ScreenerService` uses a `getConstituents` closure** in `main/index.ts` to avoid circular imports with `ConstituentsService`.
- **`window.api` declaration** lives in `src/renderer/src/global.d.ts` only. Never redeclare it per-file — that causes TS2717 duplicate declaration errors.
- **`ELECTRON_RUN_AS_NODE` guard in package.json.** The `dev` script starts with `env -u ELECTRON_RUN_AS_NODE` — if this env var is set in the shell it causes the electron shim (`cli.js`) to fall back to `node`, which runs the Electron app bundle as ESM and crashes with the CJS/ESM mismatch (`TypeError: Cannot read properties of undefined (reading 'exports')`). The guard prevents this silently.
- **Dual-provider split (v0.15.0)**: `OptionsProvider` (options chains/IV/expirations) is switchable between Polygon and E*Trade via the `optionsProvider` settings key. `DataProvider` (quotes, fundamentals, historical bars) is always Polygon. `LeapsCspService` and `AnalysisService` each hold references to both. E*Trade provider is read-only and requires valid OAuth tokens; it does not support getQuote/getFundamentals/getHistoricalBars.
- **Phase 3 fake timer tests** use `flushTimersUntil()` helper with polling loop (`vi.advanceTimersByTime` + `await Promise.resolve()`) since `vi.runAllTimers()` alone doesn't drain the promise chain in the rate limiter.
- **`npm run package` requires Windows Developer Mode.** electron-builder downloads `winCodeSign` (for PE resource stamping — icon, version info) even when code signing is disabled. The `winCodeSign` archive contains macOS symlinks; Windows blocks symlink creation for non-admin users unless Developer Mode is on. Fix: **Settings → System → For developers → Developer Mode → On** (no restart). One-time setup. Without it, the build fails with `Cannot create symbolic link : A required privilege is not held by the client`.

## Recent Changes

- **v0.22.0 (2026-06-01)** — Analysis Engine redesign. One click runs all 5 modes. Mode selector removed; strategy tabs (📈 Buy / 💰 Options Income / 🎯 Wheel / 🐂 Bullish / 🐻 Bearish) populate after run. Snapshots moved below results (newest first, delete per row, Clear All). Combined `mode='all'` snapshots store all 5 mode results. New: `analyzeWatchlistAllModes()`, `saveAllModesSnapshot()`, `getAllModesSnapshot()` in analysis service; `analysis:run-all` + `analysis:get-all-modes-snapshot` IPC; `runAll` + `getAllModesSnapshot` + `AnalysisProgressEvent` in preload. `AnalysisSnapshotRow.mode` widened to `AnalysisMode | 'all'`.

- **v0.21.1 (2026-06-01)** — Batch Jobs UI: moved Run History panel above Live Activity panel in `BatchView` so completed run data is always visible without scrolling past the live log.

- **v0.21.0 (2026-06-01)** — Automated Batch Jobs + Live Progress Log. Three new daily background jobs auto-registered at startup: `daily-market-sync-stocks` (`MarketSyncJob` wrapping `screenerService.syncUniverse('both')`, startup delay 60s), `daily-market-sync-etfs` (`MarketSyncJob` for `'etf'`, delay 90s), `daily-price-gap-fill` (`PriceGapFillJob` — SQL-detected stale tickers, `fetchAndStorePrices('1M')`, delay 120s). All three schedule at `16:30 ET`. `BatchService.registerJob()` extended with optional `{ dailyScheduleTime, runOnStartup, startupDelaySeconds }`. `BatchJobResult` extended with optional `notification?: AppNotification` so jobs can surface custom CTAs (auth expiry, etc.) without relying on the generic success/fail messages. `DailyIvCaptureJob` now attempts `renewToken()` on auth failures before giving up; fully expired tokens (midnight rollover) return a notification with "Reconnect → settings" CTA. `ETradeDataProvider` gained `renewToken()` method (delegates to `renewAccessToken()`). `BatchView` live activity panel: streaming per-ticker log appears between job table and run history while a job runs — spinner header, live counters (`✓ updated / — skipped / ✗ failed`), animated progress bar, scrollable monospace ticker log (max 300 events, auto-scroll, auto-clears 3s after job finishes). `app.setLoginItemSettings({ openAtLogin: true })` added for Windows auto-launch. Production DB path fixed: `app.isPackaged ? app.getPath('userData') : join(appPath, 'data')`. **Build rule**: after every session, `npm run package` is run so the exe stays current. New files: `src/main/services/jobs/market-sync-job.ts`, `src/main/services/jobs/price-gap-fill-job.ts`. See `changelogs/v0.21.0_2026-06-01.md`.

- **v0.20.0 (2026-05-31)** — Strategy Lab. New **🔬 Strategy Lab** view (Strategy section, just above Knowledge). Two tabs: **Validate** (scores all 31 tastylive strategies for a single ticker using entirely fresh live data — 90-day bars for direction bias, live options chain for nearest 20–50 DTE expiry, `iv_history` for IV rank; each strategy gets IV score 30pt + direction 30pt + premium 25pt + liquidity 15pt → grade A+/A/B/C/F, sorted best-first) and **Explore** (pick strategy + ticker → concrete setup with legs, strikes, mid prices, P&L). Action buttons: `→ Explore Strategy`, `📈 View in Payoff` (`navigate-to-payoff` event), `✨ AI Rationale` (claude-haiku-4-5, ~$0.003–0.005/click, requires Anthropic key). New `StrategyLabService`, `ipc-strategy-lab.ts`, `StrategyLabView.tsx`. Types: `StrategyLabContext`, `StrategySetup`, `StrategyScore`, `StrategyLabValidateResult`. See `changelogs/v0.20.0_2026-05-31.md`.

- **v0.19.2 (2026-05-31)** — History screen overhaul. "IV History" → "History" in sidebar. Gap fill run button removed from History screen (kept in Data Sync section 3). History screen now has two labeled sections: IV (coverage + Step 1/2 initial load) and Price History (new Bulk Price Load — 2Y OHLCV for S&P 500/Russell/Both via Polygon, ~1,100 calls, cancelable). Data Sync gains section 5 Price Gap Fill (stale ticker detection + `fetchPrices('1M')` loop). New IPC: `historical:getUniverseTickers`, `historical:getStalePriceTickers`, `historical:getPriceTickerCount`.
- **v0.19.1 (2026-05-31)** — Closed Positions Sync. `EtradePortfolioService.syncClosedPositions()` fetches YTD transaction history via `/v1/accounts/{id}/transactions` (paginated, marker-based), classifies each tx as open/close/expired/assigned by OCC symbol parsing, pairs open+close legs FIFO per symbol, inserts matched closed positions with dedup guard. New `portfolio:etrade:sync-closed` IPC + `window.api.portfolio.etrade.syncClosed()` preload bridge. **↓ Import Closed (YTD)** button on Portfolio Closed tab.
- **v0.19.0 (2026-05-31)** — Knowledge Base. Embedded tastylive Options Strategy Guide (TT1469) as an in-app quick-reference. 31 strategies across 6 categories extracted from `docs/TT1469_strategy-guide_230627.pdf` as both 150 DPI PNGs (`src/renderer/src/knowledge/images/`) and structured JSON one-pagers (`src/renderer/src/knowledge/data/`). `KnowledgeView.tsx`: collapsible left drawer with search + categorized list (color-coded by category); content panel with **Image / Text toggle** — Image mode shows original PDF page, Text mode renders structured layout (params, setup, risk/reward, Greeks, How It Works, Volatility, Expiration, Takeaways). `📚 Knowledge` added at bottom of Strategy section. Sidebar reorganized into 5 labeled sections (Data / Analysis / Strategy / Settings / Personal) using new `nav-section-label` CSS. See `changelogs/v0.19.0_2026-05-31.md`.

- **v0.18.2 (2026-05-31)** — ENH-3 Portfolio Greeks Monitor. Aggregate Greeks bar in `PortfolioView`: Net Δ, Θ/day ($), Vega, BP Used % (requires `accountSize` setting), expiration buckets (≤7d/≤14d/≤21d). Greeks sourced from existing E*Trade sync data — no new API calls or migrations. `accountSize: number` added to `AppSettings` (default 0). Formula at `docs/formulas.md#portfolio-greeks`. See `changelogs/v0.18.2_2026-05-31.md`.

- **v0.18.1 (2026-05-30)** — Bug fix: `atm_iv` stored as decimal fraction. IVolatility API returns decimals (0.285 = 28.5%); the ingest path was storing them raw. E*Trade capture was dividing `OptionContract.iv` (already a %) by 100. Both paths now multiply or preserve correctly. Migration 017 (`UPDATE iv_history SET atm_iv = atm_iv * 100`) retroactively converts existing rows. `Curr IV` column now shows `30%` not `0.3%`. See `changelogs/v0.18.1_2026-05-30.md`.

- **v0.18.0 (2026-05-30)** — ENH-2 Opportunity Dashboard. Removed Morning Briefing (`BriefingView.tsx` deleted, `registerBriefingIpc` removed from `index.ts`, `briefing` removed from preload). New `🎯 Opportunity` sidebar view. `OpportunityService` batch-queries four local DB tables (iv_history, quote_cache, screen_results, analysis_snapshots) to compute a composite Opportunity Score (fundamentals 25% + IV rank 30% + technical 25% + premium yield 20%). IV ranks computed via one SQLite window-function query for the entire universe. Strategy mode selector (Wheel/CSP/Spreads/Bullish/Bearish) flips IV rank scoring direction. `ipc-opportunity.ts`: `opportunity:run`. `window.api.opportunity.run()` preload bridge. `OpportunityView.tsx`: ranked table with score circles, mini score bars, IV rank badges (HIGH/MED/LOW), one-click drill-in to Analysis + Options Chain. `OpportunityRow`, `OpportunityRunOptions`, `StrategyMode`, `OpportunityUniverse` types added to `shared/types.ts`. See `changelogs/v0.18.0_2026-05-30.md`.

- **v0.17.0 (2026-05-30)** — IV History feature. True IV rank + IV percentile from 252 days of daily 30-day constant-maturity ATM IV. `migrations/016_iv_history.sql`: `iv_history` table with unique `(ticker, date)` index. `MarketDataProvider` (`src/main/services/marketdata-provider.ts`): HTTP client for MarketData.app historical options chains, dedicated 50 RPM rate limiter, parallel-array JSON parsing. `IvHistoryService` (`src/main/services/iv-history-service.ts`): `computeAtmIv()` DTE-weighted interpolation between expirations bracketing 30 DTE; `storeReading()` upsert; `getIvRank()` IV rank/percentile (≥21 data points required); `getCoverage()` complete/partial/none counts; `getGaps()` generates missing (ticker, date) pairs; `runBackfill()` orchestrates `initial_sp500` / `initial_russell` / `gap_fill` phases with progress events; `captureFromEtradeChain()` silently stores today's IV from any E*Trade chain fetch. `ipc-iv-history.ts`: 8 IPC channels + `iv-history:progress` events. `window.api.ivHistory.*` preload bridge. `marketdataApiToken` in `SENSITIVE_KEYS` (DPAPI encrypted). `IvHistoryView.tsx`: token config, coverage cards, Step 1/2 initial load with status badges, gap fill section, live progress bar. `📊 IV History` sidebar tab. Formula docs: `#iv-history`, `#atm-iv-interpolation`, `#trading-days`. See `changelogs/v0.17.0_2026-05-30.md`.

- **v0.16.0 (2026-05-30)** — Payoff Visualizer fixes (API key injection, `probOfProfit` schema, assessment panel redesign with structured cards + collapsible chain drawer). E*Trade Quote Inspector: `etrade:get-raw-quote` IPC handler + `QuoteInspector` component in `TestApiView` calls `/v1/market/quote/{symbol}?detailFlag=ALL` and auto-highlights IV/volatility fields — confirmed E*Trade has no IV rank in its API. Planning docs: `Requirements/enhancements.md` (ENH-1 through ENH-5) and `Requirements/iv-history-design.md` (full IV rank build spec using MarketData.app + E*Trade auto-capture). See `changelogs/v0.16.0_2026-05-30.md`.

- **v0.15.0 (2026-05-26)** — Dual-Provider Architecture (Polygon + E*Trade). Extracted `OptionsProvider` interface (`src/main/services/options-provider.ts`) covering `getOptionsExpirations`, `getOptionsChain`, `getOptionsIV`, `getOptionsIVAndPremium`. `PolygonDataProvider` now implements both `DataProvider` and `OptionsProvider` (returns `[]` for expirations — callers fall back to generated Fridays). New `ETradeDataProvider` implements `OptionsProvider` using the E*Trade Market API (OAuth tokens from `secure-settings.ts`). Settings key `optionsProvider` ('polygon' | 'etrade') read at startup in `index.ts`; selected provider injected into `ipc-options.ts`, `ipc-leaps-csp.ts`, and `AnalysisService`. `LeapsCspService` now takes `DataProvider` (for quotes/fundamentals/bars) and `OptionsProvider` (for options chain/IV) as separate constructor args. Settings UI adds "Options Data Source" dropdown (restart required). `window.api.settings.getOptionsProvider` / `setOptionsProvider` preload bridge. Seven pre-existing `noUncheckedIndexedAccess` errors fixed across `AnalysisService`, `VolumeProfile`, `BacktestView`, `LeapsCspView`, `OptionsChainView`, `ValidateView`. Screener filter tests updated to match intentionally-loosened Polygon-compatible defaults. See `changelogs/v0.15.0_2026-05-26.md`.

- **v0.14.0 (2026-05-25)** — LEAPS + CSP Strategy Screener. `011_leaps_csp.sql` migration adds `leaps_csp_runs`, `leaps_csp_opportunities`, `leaps_csp_opened` tables. `LeapsCspService` pipeline: market gate (SPY vs 50d/200d MA, VIX level + 5d change, HYG/IEF ratio → PASS/CAUTION/FAIL) → universe from screener cache → LEAPS hard-fail filters (delta 0.70–0.90, DTE 365–730, spread ≤5%, OI ≥100, extrinsic ≤15%) → CSP pool (delta −0.15 to −0.30, DTE 25–50, ann return ≥12%) → cross-ticker pairing → combined score (LEAPS×60% + CSP×40%) → grades A+/A/B/C/F. IPC: `leaps-csp:run-screen`, `get-runs`, `get-run`, `mark-opened`, `get-opened` via `ipc-leaps-csp.ts`. `LeapsCspView.tsx` with ranked table, expandable scoring breakdown, caution flags, alternatives, "Mark as Opened". New `⚡ LEAPS+CSP` sidebar tab in `App.tsx`. Rate-limited via existing `TokenBucketRateLimiter`. See `changelogs/v0.14.0_2026-05-25.md`.

- **v0.13.0 (2026-05-25)** — Backtesting Engine. `BacktestEngine` service, `ipc-backtest.ts`, `BacktestView.tsx`, `🔁 Backtest` sidebar tab.

- **v0.12.0 (2026-05-11)** — TraderAgent UI integration. New `🤖 Agent` tab in sidebar. `AgentDbService` opens TraderAgent's SQLite in read-only mode. IPC handlers (`ipc-agent.ts`): `agent:get-status`, `agent:get-trades`, `agent:get-lessons`, `agent:get-recommendations`, `agent:get-memory`, `agent:run-phase` (spawns agent CLI + streams stdout/stderr to renderer via `agent:log` events), `agent:close-trade`, `agent:open-db`. `AgentView.tsx`: Overview (stat cards + memory weight bars), Trades table (filterable open/closed/all), Lessons, Recommendations, Memory (bar charts), and Run phase panel with log stream. Settings extended with `agentDbPath` + `agentProjectPath`. `window.api.agent.*` preload bridge. See `changelogs/v0.12.0_2026-05-11.md`.

- **v0.11.0 (2026-05-11)** — Phase 11: Local HTTP API Server. Fastify server (`ApiServer`) on `127.0.0.1:7432` (configurable). Token auth via `~/.tradeanalyzer/agent.token`. Headless mode (`TRADEANALYZER_HEADLESS=1`). 10 route modules under `src/main/api/` covering all service groups. Unified `{ ok, data|error }` response contract. Port written to `~/.tradeanalyzer/api.port`. `fastify@^5.8.5` added to dependencies. See `changelogs/v0.11.0_2026-05-11.md`.

- **v0.10.0 (2026-05-08)** — Phase 10: Settings Enhancements (Priority 9). Extended AppSettings with soundAlertsEnabled, autoConnectWebSocket, defaultScreenerIndex, theme ('dark'|'light'), keyboardShortcuts config. Added Keyboard Shortcuts tab with 5 configurable shortcuts. Theme support via CSS variables (data-theme attribute). Conditional WebSocket auto-connect based on setting. ScreenerView uses default universe from settings. See `changelogs/v0.10.0_2026-05-08.md`.

- **v0.9.0 (2026-05-08)** — Phase 9: Morning Briefing Dashboard (Priority 7) + Alerts System (Priority 8). `007_alerts.sql` migration with alerts table (price, position types). `BriefingService` with market regime detection (SPY SMA trends, VIX classification), action items (expiring positions, delta breaches), top 15 quality setups with wheel metrics. `AlertsService` with WebSocket-based price monitoring. IPC handlers for briefing and alerts. `BriefingView` with MarketRegimeCard, ActionItemsList, TopSetupsTable; auto-refresh every 5 minutes. See `changelogs/v0.9.0_2026-05-08.md`.

- **v0.8.0 (2026-05-08)** — Phase 8: Portfolio Tracking (Priority 6). `006_portfolio.sql` migration with positions table (CSP, CC, Stock). `PortfolioService` with CRUD and P&L calculations. IPC handlers for position management. `PortfolioView` with add form, Open/Closed tabs, P&L summary cards (positions, unrealized/realized, capital, win rate). Added to sidebar. See `changelogs/v0.8.0_2026-05-08.md`.

- **v0.7.0 (2026-05-07)** — Phase 7: Screener Enhancements (Priority 5). Sortable columns on all 17+ fields using `useSortable`. Quick Actions per row: Add to Watchlist dropdown, Run Analysis button. CSV export for filtered results. Pagination (50 items per page). Cache status indicator with stale data warning. See `changelogs/v0.7.0_2026-05-07.md`.

- **v0.6.0 (2026-05-07)** — Phase 6: Historical Charts (Priority 4). `005_historical_data.sql` migration with `historical_financials` and `historical_prices` tables. `HistoricalDataService` with Polygon API integration, SMA calculation. IPC handlers for financials/prices fetching. `HistoricalFinancialChart` (Recharts Area chart with 9 metrics, Q/A toggle, CSV export). `HistoricalPriceChart` (timeframe selector 1M-5Y, 50-day SMA, volume, CSV export). Integrated into AnalysisView with click-to-open from ticker symbols. See `changelogs/v0.6.0_2026-05-07.md`.

- **v0.5.0 (2026-05-07)** — Phase 5: Cache Management + Wheel Columns + Real-Time WebSocket. Cache: `cache_metadata` table, `CacheManager` service, `CacheStatusIndicator` component, `useCacheStatus` hook (5min poll). Wheel: `WheelCalculator` with suitability formula (ROE×30% + D/E_Quality×30% + MarketCap×20% + Stability×25%), Target Strike, Est. Premium, `useSortable` hook. WebSocket: `WebSocketService` to Polygon delayed feed, exponential backoff (3s→48s), `RealtimePriceTicker`, live price updates. New deps: `ws`, `recharts`. See `changelogs/v0.5.0_2026-05-07.md`.
- **v0.4.0 (2026-05-02)** — Phase 4: Chart polish + Settings. Pattern callouts rendered at price/time coordinates via `ISeriesApi.priceToCoordinate()`. Entry zone band, target line (amber), demand/supply zone labels on chart. EPS sparkline in Section A. Full SettingsView (General, API & Data, Cache & Limits, Diagnostics self-check, Backup & Restore). Settings IPC (9 handlers) + Diagnostics IPC. Bug fix: `detectEveningStar` guard was inverted. Bug fix: `ELECTRON_RUN_AS_NODE` env guard added to `dev` script. See `changelogs/v0.4.0_2026-05-02.md`.
- **v0.3.0 (2026-05-02)** — Phase 3: Analysis Engine + Pipeline (FR-3 + FR-4.4). 5 analysis modes (Buy, Options Income, Wheel, Bullish, Bearish) with composite scoring, entry/stop/target. Validate All batch with verdict + full indicators. Pipeline: `TokenBucketRateLimiter` + SQLite `JobQueue` for resumable batch jobs. Full indicator library. AnalysisView UI. See `changelogs/v0.3.0_2026-05-02.md`.
- **v0.2.0 (2026-05-02)** — Phase 2: Index Screener (FR-2). Screener engine with 17 default filters, strict/soft modes, presets, run history, save-as-watchlist. Polygon DataProvider + fundamentals computer. Quote auto-refresh (60s) on watchlist. Structured API + error logging. See `changelogs/v0.2.0_2026-05-02.md`.
- **v0.1.2 (2026-05-02)** — Fix `rebuild:electron` so the better-sqlite3 binary's ABI actually changes. See `changelogs/v0.1.2_2026-05-02.md`.
- **v0.1.1 (2026-05-02)** — Swap DB driver back to better-sqlite3. See `changelogs/v0.1.1_2026-05-02.md`.
- **v0.1.0 (2026-05-01)** — Initial scaffold. Phase 1 (FR-1 watchlist CRUD + CSV) implemented end-to-end. See `changelogs/v0.1.0_2026-05-01.md`.

## How to Run

```bash
# install (runs electron-rebuild via postinstall)
npm install

# dev — launches main + preload + renderer with HMR
npm run dev

# typecheck
npm run typecheck

# lint
npm run lint

# unit + integration tests (offline)
npm test

# production build (per-platform installer)
npm run build

# package only (no installer)
npm run package
```

API key setup, troubleshooting, and design-decision rationale live in `README.md`.
