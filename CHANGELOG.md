# Changelog

Reverse-chronological. Per spec EP-2.3, this is the index; per-version detail lives in `changelogs/`.

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
