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
- Tokens expire at midnight ET. After 2h inactivity they go dormant — call `renewAccessToken()`.
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
| `src/renderer/src/App.tsx` | Layout + sidebar routing (8 sections, 26 views) + status bar |
| `src/renderer/src/views/*.tsx` | 26 feature views |
| `src/renderer/src/global.d.ts` | `window.api` type declaration (only place) |
| `src/shared/types.ts` | All cross-process types |
| `src/preload/index.ts` | `window.api.*` bridge (33 namespaces) |

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
- **Fake-timer tests** use `flushTimersUntil()`, not `vi.runAllTimers()`.
- **Inspecting the production DB while the app is running**: open it with a **write-capable** better-sqlite3 connection (`new Database(path)`), never `readonly: true`. On Windows a readonly connection can't attach the live WAL index (needs write access to `-shm`) and silently reads only up to the last checkpoint — writes from minutes ago (e.g. a just-finished brief) appear missing. Write-capable read-only queries are safe in WAL mode.

## Standing instructions for AI sessions

- **No phased delivery anymore** — the app is feature-complete. Implement the requested change end-to-end: tests green, changelog + `.ai/AI_CONTEXT.md` + affected `Requirements/spec/` section updated, single Conventional Commit, then `npm run package`.
- Prefer the simplest implementation that satisfies the request. Don't add features outside scope; if one seems needed, surface it and add to `Open decisions` in `.ai/AI_CONTEXT.md`.
- Keep `.ai/AI_CONTEXT.md` accurate and lean (target < 1,500 lines). It describes current state, not history — history goes in `changelogs/`.
- When you hit a non-obvious gotcha, add it to `Known quirks` here and/or `.ai/AI_CONTEXT.md §10`.
- Announce when `npm run package` starts and finishes.