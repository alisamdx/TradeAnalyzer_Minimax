# CLAUDE.md — TradeAnalyzer project instructions

> **Start every session here, then read `.ai/AI_CONTEXT.md`** for current build state (stack, schema, services, views, quirks). If anything below conflicts with `.ai/AI_CONTEXT.md`, prefer `.ai/AI_CONTEXT.md` — it is verified against the code. `Requirements/spec/` is the authoritative, rebuild-from-scratch specification (start at `Requirements/spec/00-index.md`); treat `FR-*` / `NFR-*` as acceptance tests. Older scattered specs are archived in `Requirements/_legacy/`.
>
> This file is the **operating manual** (rules, conventions, key files). `.ai/AI_CONTEXT.md` is the **state snapshot**. `README.md` is **human onboarding**. `.ai/AI_PROMPT.md` is a **thin session-kickoff pointer** (it points here for the rules — it must never restate them).

## Project

TradeAnalyzer is an Electron + React + TypeScript desktop app for a retail options/swing trader. Watchlists, screener, five-mode analysis engine (buy/options/wheel/bullish/bearish), configurable scoring engine, daily AI intelligence brief, validation dashboards, multi-leg payoff modeling, portfolio tracking synced from E*Trade, LEAPS+CSP and collared-LEAPS screeners, earnings calendar, News & Research, backtesting. The app is feature-complete against the v1 spec; the gate to v1.0.0 is real-world usage validation.

## Stack

- **Shell**: Electron 32.x
- **UI**: React 18 + TypeScript 5.x
- **Build**: electron-vite 2.x
- **DB**: better-sqlite3 12.x (wrapped in `src/main/db/connection.ts`)
- **Charts**: lightweight-charts 4.1.x
- **Tests**: Vitest 2.x
- **Lint**: ESLint 9 + Prettier 3

## Commands

```bash
npm run dev          # dev with HMR
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # production build
npm run package      # package without installer
```

## Architecture

```
src/main/            ← Electron main process: db, services, IPC, API server
src/preload/         ← context-isolated bridge (window.api.*)
src/renderer/        ← React UI (views, components, hooks)
src/shared/types.ts  ← shared TypeScript types
migrations/          ← numbered SQL migrations
docs/formulas.md     ← every financial metric formula
```

**Data flow**: React view → `window.api.*` → `ipcRenderer.invoke` → main IPC handler → Service → better-sqlite3 / DataProvider (Polygon.io)

## Rules

### Before coding
- Read `.ai/AI_CONTEXT.md` for current build state, schema, and known quirks
- Standing instructions live in this file (see "Standing instructions for AI sessions" below)
- Read `Requirements/spec/` for the full spec (start at `00-index.md`; FR-* / NFR-* are acceptance tests)

### Code style
- TypeScript strict mode. No `any` unless unavoidable.
- Functional React components with hooks. No class components.
- Service classes in `src/main/services/`. IPC handlers in `src/main/ipc/`.
- DB access goes through `withTransaction(db, fn)` — never raw `db.transaction()`.
- All market data flows through `DataProvider` / `OptionsProvider` interfaces — never ad-hoc `fetch` to Polygon.
- Formula comments must reference `docs/formulas.md#anchor`.

### Never
- Bypass the rate limiter for Polygon API calls
- Invent or synthesize market data — surface missing fields as null
- Log secrets — API keys live in OS keychain or `.env`
- Commit `.env`, credentials, or `backups/`
- Use `any` type — prefer `unknown` with type guards
- Reach for `db.transaction(fn)()` directly — use `withTransaction(db, fn)`

### Financial data conventions
- IV is stored and displayed as a **percentage** (38.82, not 0.3882). E*Trade returns IV as a decimal fraction (0.3882) — always multiply by 100 when ingesting.
- All monetary values in USD. Prices per share, not per contract.
- DTE is calendar days (not trading days).
- `// see docs/formulas.md#anchor` comment on every derived metric.

### E*Trade integration
- OAuth 1.0a flow implemented in `src/main/services/etrade-auth.ts`
- Tokens expire at midnight ET. After 2h inactivity they go dormant — call `renewAccessToken()`. The nightly jobs **and** the on-demand `ETradeDataProvider.getOptionsChain`/`getOptionsExpirations` (via `withRenew`, v1.1.48) auto-renew-and-retry on a dormant-token 401; a token expired past midnight still needs a manual re-auth. A dormant token used to silently yield an empty chain on evening agent/lab runs.
- E*Trade credentials stored encrypted in settings via `secure-settings.ts`
- All E*Trade API calls go through `etradeGet()` which handles signing — never construct auth headers manually.

### Git conventions
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- Every material change updates, in the same commit: version + `CHANGELOG.md` + `changelogs/v{version}_{date}.md` + `.ai/AI_CONTEXT.md` + the affected `Requirements/spec/` section (+ `docs/formulas.md` if a formula changed)
- Bug fixes ship with a regression test

### Documentation maintenance (keep these in sync)
Update only what the change touches — don't regenerate everything:

| You changed… | Update |
|---|---|
| Any behavior/feature | `CHANGELOG.md` + `changelogs/v{version}_{date}.md`, and the matching `Requirements/spec/NN-*.md` section |
| Schema (a migration) | `Requirements/spec/02-data-model.md` + `.ai/AI_CONTEXT.md §8` |
| A financial formula | `docs/formulas.md` + `Requirements/spec/23-formulas.md` |
| Services/views/IPC/providers | `.ai/AI_CONTEXT.md` (state map) + the relevant `spec/` section |
| A non-obvious gotcha | `CLAUDE.md` Known quirks + `.ai/AI_CONTEXT.md §10` |
| Install/run/config | `README.md` |
| A user-facing workflow/screen | `UserManual/USER_GUIDE.md`, then regenerate the PDF (`python UserManual/build_pdf.py`) |

`Requirements/spec/` is authoritative and per-section — patch the one affected section, not the whole set. A full spec regeneration is a deliberate, occasional task, not a per-commit one. `Requirements/_legacy/` is frozen — never edit it.

### Testing
- `npm test` runs Vitest
- Test files in `tests/` directory
- Migration tests are count-agnostic (don't assert specific migration count)
- Fake timer tests use `flushTimersUntil()` helper, not `vi.runAllTimers()`

## Key files

| File | Purpose |
|------|---------|
| `src/main/index.ts` | App lifecycle, window creation, provider wiring, IPC + batch job registration |
| `src/main/db/connection.ts` | DB wrapper (`openDatabase`, `withTransaction`) — the only DB entry points |
| `src/main/db/migrations.ts` | Runs numbered migrations from `migrations/` |
| `src/main/api-server.ts` | Fastify local API on 127.0.0.1:7432 (TraderAgent integration) |
| `src/main/services/data-provider.ts` | `DataProvider` interface (quotes/fundamentals/bars) |
| `src/main/services/polygon-provider.ts` | Polygon implementation of `DataProvider` |
| `src/main/services/options-provider.ts` | `OptionsProvider` interface (chains/IV/expirations) |
| `src/main/services/etrade-data-provider.ts` | E*Trade `OptionsProvider` (active default) |
| `src/main/services/etrade-auth.ts` | OAuth 1.0a flow + `etradeGet()` |
| `src/main/services/analysis-service.ts` | 5 analysis modes + indicator math |
| `src/main/services/scoring-service.ts` | Configurable 5-strategy scoring engine |
| `src/main/services/strategy-lab-service.ts` | Scores/explores all 31 tastylive strategies |
| `src/main/services/payoff-service.ts` | Multi-leg payoff modeling + AI assessment |
| `src/main/services/portfolio-service.ts` | Position CRUD + P&L + Greeks |
| `src/main/services/earnings-service.ts` | Earnings calendar (E*Trade), Saturday→Friday shift |
| `src/main/services/batch-service.ts` | Daily job scheduler (`BatchJobHandler`, mutex, schedules) |
| `src/main/services/secure-settings.ts` | Encrypted settings (E*Trade creds) |
| `src/main/services/jobs/*.ts` | 9 batch job handlers |
| `src/main/ipc/*.ts` | 27 IPC handler modules |
| `src/renderer/src/App.tsx` | Layout + sidebar routing (9 sections, 29 views) + status bar |
| `src/renderer/src/views/*.tsx` | 29 feature views |
| `src/renderer/src/global.d.ts` | `window.api` type declaration (only place) |
| `src/shared/types.ts` | All cross-process types |
| `src/preload/index.ts` | `window.api.*` bridge (34 namespaces) |

## Known quirks

- **better-sqlite3 ABI flips** between Node and Electron. `predev`/`prebuild`/`prepackage` swap the Electron binary; `pretest` swaps the Node binary. `NODE_MODULE_VERSION 128 vs 137` = wrong binary; run the matching `rebuild:*` script. Don't revert to `electron-builder install-app-deps` (reports success without swapping the ABI).
- **`package.json` must never be written by PowerShell `Set-Content -Encoding utf8`** — writes a UTF-8 BOM electron-vite rejects. Use the Edit tool or Node.
- **`npm run package` needs Windows Developer Mode ON** — winCodeSign archive has macOS symlinks; non-admin symlink creation is otherwise blocked. One-time setup.
- **`node:fetch` does not exist** in Node 24. Use global `fetch`.
- **`window.api` declaration** lives only in `src/renderer/src/global.d.ts`. Never redeclare per-file (TS2717).
- **`ELECTRON_RUN_AS_NODE`** guard in `dev` script prevents CJS/ESM mismatch crashes.
- **Options provider is switchable** (`optionsProvider` setting), read at startup; **E*Trade is the active default** (Polygon Options Starter cancelled). `DataProvider` is always Polygon.
- **IV rank/percentile** are null from Polygon snapshot — computed from `iv_history`, which needs the MarketData.app/IVolatility backfill populated.
- **Earnings** come from E*Trade (no Polygon public endpoint). **E*Trade dates are UTC** → Thursday-evening ET reports show as Saturday UTC; `earnings-service.ts` shifts Saturday→Friday, marks unconfirmed.
- **E*Trade IV** is a decimal fraction (0.3882 = 38.82%). `* 100` when ingesting into percentage storage; pass directly to Black-Scholes as sigma.
- **VIX comes from E*Trade, not Polygon** — Polygon's *stocks* snapshot can't serve VIX (it's an index, `I:VIX`). The brief job's `refreshVixQuote()` fetches it via E*Trade `/v1/market/quote/VIX`, sane-range-validates (`[5,150]`), and upserts into `quote_cache` for the critic. **The E*Trade index symbol `'VIX'` is unverified** — check `runMeta.vix` against the real VIX after a brief run; if wrong, the value is ignored (fail-safe) and the symbol needs fixing. Both the critic (`getMarketContext`) and the Morning Briefing dashboard (`BriefingService.getMarketRegime`) read this one cached value.
- **Critic LLM gets only the data in its context** — it has no live feed. It was told to compute a "1-sigma move (annualized vol …)" with **no** vol field provided, so it fabricated IV numbers. Anything the critic should reason about numerically (IV, realized vol, …) must be in the context object; the prompt now forbids citing vol figures not present in `volatility`.
- **Fake-timer tests** use `flushTimersUntil()`, not `vi.runAllTimers()`.
- **The batch runs twice a trading day** (≈10:15 ET intraday scan + ≈16:30+ ET after close) and the after-close slot re-runs every job. **Every job must refresh + overwrite what the morning slot wrote** — the morning run stores a *partial* same-day daily bar (first ~50 min of volume, intraday close), and breakout/`volume_surge` scoring reads it. Don't gate a job on `MAX(date) < date('now')` (that made the evening price refresh skip a ticker that already had a partial morning bar — fixed v1.1.49; price-gap-fill now always re-fetches + `INSERT OR REPLACE`s the recent window). The after-close daily bar must be **final** when fetched — Polygon keeps settling it past 16:00 ET, so ≈17:00 ET is safer than 16:30. See spec §20.5.
- **Weekly-expiration date math must stay in one time base.** Helpers that guess upcoming **Friday** expirations (e.g. `routes-options.ts` `nextFridays`) must compute the weekday *and* serialize in the **same** time base — all UTC (`getUTCDay`/`Date.UTC`/`setUTCDate`/`toISOString`) or all local. Mixing local weekday math with `toISOString()` shifts every date to **Saturday** on evening runs (local clock past UTC midnight), and E\*Trade lists Fridays only → the chain lookup silently returns an empty array. This starved the TraderAgent of option contracts for ~10 days (fixed v1.1.47). The canonical UTC pattern lives in `analysis-service.ts` / `filter-templates-service.ts`.
- **IBKR (TWS API via `@stoqey/ib`) gotchas** (v2 execution, validated live on paper 2026-06-18): (1) **No market data for BAG combos** — `reqMktData` on a smart-routed combo returns nothing even with an options subscription; single-leg option data works, so `IbkrExecutionBroker.priceCombo` prices **from the individual legs** (`comboQuoteFromLegs`), never the BAG. (2) **Orders need `eTradeOnly:false, firmQuoteOnly:false`** or newer TWS silently drops them (no status, no error). The engine's own placement path was missing these until v1.1.62 — the armed paper engine logged `order_submitted` but no fill ever came back and nothing reached the account (the diagnostic scripts always had the flags, so the gotcha was known but the production `IbkrExecutionBroker` path was never exercised end-to-end). Both the live order and the whatIf preflight now build through the shared `buildComboOrder()` which always sets them. (3) **Options pricing needs an OPRA market-data subscription**; order placement/fills do **not** (execution ≠ data). (4) **Paper account permissions** can't be toggled independently in Client Portal (the UI mirrors live) but IBKR still provisions paper with options (incl. Level 3) enabled — verify empirically, not from the UI. (5) A **combo is one BAG order with N legs** (TWS "show legs" expands it), filled as a package — never N independent leg orders. Diagnostics: `scripts/ibkr-*.mjs`.
- **Inspecting the production DB while the app is running**: open it with a **write-capable** better-sqlite3 connection (`new Database(path)`), never `readonly: true`. On Windows a readonly connection can't attach the live WAL index (needs write access to `-shm`) and silently reads only up to the last checkpoint — writes from minutes ago (e.g. a just-finished brief) appear missing. Write-capable read-only queries are safe in WAL mode.

## Standing instructions for AI sessions

- **No phased delivery anymore** — the app is feature-complete. Implement the requested change end-to-end: tests green, changelog + `.ai/AI_CONTEXT.md` + affected `Requirements/spec/` section updated, single Conventional Commit, then `npm run package`.
- Prefer the simplest implementation that satisfies the request. Don't add features outside scope; if one seems needed, surface it and add to `Open decisions` in `.ai/AI_CONTEXT.md`.
- Keep `.ai/AI_CONTEXT.md` accurate and lean (target < 1,500 lines). It describes current state, not history — history goes in `changelogs/`.
- When you hit a non-obvious gotcha, add it to `Known quirks` here and/or `.ai/AI_CONTEXT.md §10`.
- Announce when `npm run package` starts and finishes.
- **Validate-before-ship for trade-logic changes (FR-SEY-5).** Any change to a scoring weight/signal, an entry/exit policy parameter, or a risk-gate rule that affects *which trades the engine takes or how it sizes/exits them* must be backed by a **Brief Replay and/or Backtest delta** showing it is at worst neutral on the historical sample before it ships on the live path. A rule that can't be shown to help on the data doesn't ship enabled — it may ship **disabled** (configurable, default off) with the null/negative finding recorded. Precedent: the SPY-regime gate and overbought guard were both tested and rejected on full-year replay. See `Requirements/v2-execution/06-seykota-risk-extensions.md`.