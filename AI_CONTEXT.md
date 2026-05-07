# AI_CONTEXT

> Read this file first. It is intentionally self-contained so a fresh AI session can become productive without re-reading the codebase. Keep it under 1,500 lines.

## Project Overview

**TradeAnalyzer** is a single-user, cross-platform desktop application for a retail options/swing trader. It manages watchlists, screens index universes (S&P 500 / Russell 1000) for fundamentally sound trade candidates, runs analysis modes (buy zones, options income, wheel, bullish/bearish strategies), and provides per-stock validation dashboards. All market data comes from Polygon.io; persistence is local SQLite. No cloud sync, no multi-user, no broker execution.

The full spec is in `REQUIREMENTS.md`. This file summarizes the build state.

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
  AI_CONTEXT.md            ← this file
  AI_PROMPT.md             ← standing instructions for AI sessions
  REQUIREMENTS.md          ← full functional/non-functional spec
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
                             rate-limiter.ts, job-queue.ts, validate-all-service.ts (Phase 3)
      ipc/                 ← ipc-watchlists.ts (Phase 1), ipc-screener.ts (Phase 2),
                             ipc-analysis.ts (Phase 3)
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
- **Phase 3 fake timer tests** use `flushTimersUntil()` helper with polling loop (`vi.advanceTimersByTime` + `await Promise.resolve()`) since `vi.runAllTimers()` alone doesn't drain the promise chain in the rate limiter.

## Recent Changes

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
