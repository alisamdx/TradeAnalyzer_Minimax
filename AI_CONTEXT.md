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
| DB | Node `node:sqlite` | built-in (Node ≥ 22.5) | Synchronous API; **zero native compilation**. Switched from better-sqlite3 because the dev box has no Visual Studio Build Tools and v12.x has no Node-24 prebuilt. Wrapped in `src/main/db/connection.ts` so we can swap back later. |
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
      index.ts             ← app lifecycle + window creation + IPC registration
      db/                  ← connection.ts, migrations.ts
      services/            ← watchlist-service.ts, csv.ts (Phase 1)
      ipc/                 ← ipc-watchlists.ts (Phase 1)
    preload/               ← context-isolated bridge: exposes window.api.*
      index.ts
    renderer/              ← React UI
      index.html
      src/
        main.tsx           ← React entry
        App.tsx            ← top-level layout (sidebar + main pane)
        api.ts             ← typed wrapper around window.api.*
        views/
          WatchlistView.tsx (Phase 1)
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

### Data flow (current — Phase 1)
```
React view ──invoke──▶ window.api.watchlists.* ──ipcRenderer.invoke──▶ main IPC handler ──▶ WatchlistService ──▶ better-sqlite3
                                                                                            │
                                                                                            └──▶ shared types
```

### Producer/consumer pipeline (deferred to Phase ≥ 3)
Per spec §4.4: Fetcher worker pulls jobs from a queue and respects token-bucket rate limiting; Persister worker writes parsed responses to SQLite; UI Coordinator publishes progress events. Resumable via the `job_runs` + `job_progress` tables. Not implemented yet — only the schema columns exist.

## Data Model

Authoritative DDL is in `migrations/001_init.sql`. Phase 1 only creates these tables:

| Table | Purpose | Persistent / Cache |
| --- | --- | --- |
| `schema_version` | Tracks applied migrations | persistent |
| `watchlists` | Named watchlists, one row per list. `name` is unique case-insensitively. | persistent |
| `watchlist_items` | Tickers belonging to a watchlist. | persistent |
| `settings` | Free-form key/value app settings. | persistent |

Tables defined in the spec but **not yet created** (will arrive with their owning phase): `screen_presets`, `screen_runs`, `screen_results`, `analysis_snapshots`, `fundamentals_cache`, `quote_cache`, `options_cache`, `job_runs`, `job_progress`.

## DataProvider Contract

Per spec §4.2.3, all market-data access goes through a `DataProvider` interface. **Not implemented in Phase 1.** Stub will land in Phase 2 (screener) or earlier if needed. Methods to implement:

- `getQuote(ticker)`
- `getFundamentals(ticker)` (returns derived ratios; computed by a separate `fundamentals-computer` module from raw `/vX/reference/financials` data)
- `getEarningsCalendar(ticker)`
- `getHistoricalBars(ticker, timeframe, lookback)`
- `getOptionsChain(ticker, expiration)`
- `getIndexConstituents(index)`

Polygon-specific implementation will sit behind this interface so v2 providers can drop in.

## Open Decisions

- **Charting library** — between `lightweight-charts` and `ApexCharts`. Decide in Phase 4 (validation dashboard) when chart needs are concrete.
- **Suitability score formula (wheel)** — TBD in Phase 3 (analysis engine). Will be documented in `docs/formulas.md`.
- **Polygon financials → derived ratios mapping** — TBD in Phase 2 with the screener. Will be documented in `docs/data-provider.md` and `docs/formulas.md`.
- **Producer/consumer technology** — leaning toward Node `worker_threads` + an in-process queue + token-bucket implementation (no external broker). Decide in Phase 3.
- **Settings storage** — currently using a `settings` table; may move some fields (API key) to OS keychain via `keytar` in Phase 2.

## Known Quirks & Gotchas

- **DB driver is `node:sqlite`, not better-sqlite3.** Wrapped behind `src/main/db/connection.ts` (`openDatabase`, `withTransaction`). The wrapper exists specifically so we can swap better-sqlite3 back in when the dev environment has Visual Studio Build Tools 2022 (or when better-sqlite3 ships a Node-24 prebuilt). API differences vs better-sqlite3: no `db.pragma()` (use `db.exec('PRAGMA ...')`), no `db.transaction(fn)()` (use the `withTransaction(db, fn)` helper), and `prepare(...).all()` returns `unknown[]` so callers cast.
- **`node:sqlite` is experimental in Node 22/23.** Pre-Node-24, it requires `--experimental-sqlite`. Node ≥ 24 enables it by default. The package.json `engines` field pins this; if you see `Unknown built-in module 'node:sqlite'`, you're on too old a Node.
- **Case-insensitive unique watchlist names.** Enforced by a unique index on `lower(name)` in SQLite, not by `COLLATE NOCASE` on the column (so `name` keeps the user's casing on read). The service also pre-checks before insert to give a clean error.
- **The 'Default' watchlist is undeletable.** Enforced in the service layer (delete throws) AND created idempotently on app startup. Renaming is allowed.
- **CSV header.** Required column: `ticker`. Optional: `notes`, `added_date`. Header row is mandatory. Tickers are uppercased and trimmed; rows with missing/empty ticker are reported as skipped (never silently dropped).

## Recent Changes

- **v0.1.0 (2026-05-01)** — Initial scaffold. Section 7 infrastructure in place. FR-1 (watchlist CRUD + CSV) implemented end-to-end with tests. Polygon integration not started. See `changelogs/v0.1.0_2026-05-01.md`.

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
