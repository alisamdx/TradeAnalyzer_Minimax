# CLAUDE.md — TradeAnalyzer project instructions

## Project

TradeAnalyzer is an Electron + React + TypeScript desktop app for a retail options/swing trader. Watchlists, screener, analysis engine (buy/options/wheel/bullish/bearish), validation dashboards, portfolio tracking, LEAPS+CSP strategy, backtesting, E*Trade integration.

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
- Read `.ai/AI_PROMPT.md` for standing instructions and hard rules
- Read `Requirements/REQUIREMENTS.md` for full spec (FR-* / NFR-* are acceptance tests)

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
- Every material change updates: version + `CHANGELOG.md` + `changelogs/v{version}_{date}.md` + `.ai/AI_CONTEXT.md`
- Bug fixes ship with a regression test

### Testing
- `npm test` runs Vitest
- Test files in `tests/` directory
- Migration tests are count-agnostic (don't assert specific migration count)
- Fake timer tests use `flushTimersUntil()` helper, not `vi.runAllTimers()`

## Key files

| File | Purpose |
|------|---------|
| `src/main/index.ts` | App lifecycle, window creation, IPC registration |
| `src/main/db/connection.ts` | DB wrapper (`openDatabase`, `withTransaction`) |
| `src/main/services/data-provider.ts` | `DataProvider` interface |
| `src/main/services/polygon-provider.ts` | Polygon implementation |
| `src/main/services/etrade-data-provider.ts` | E*Trade options provider |
| `src/main/services/etrade-auth.ts` | OAuth 1.0a flow + `etradeGet()` |
| `src/main/services/analysis-service.ts` | 5 analysis modes + indicator math |
| `src/main/services/portfolio-service.ts` | Position CRUD + P&L |
| `src/main/services/leaps-csp-service.ts` | LEAPS+CSP screener pipeline |
| `src/main/services/secure-settings.ts` | Encrypted settings (E*Trade creds) |
| `src/main/ipc/*.ts` | IPC handler modules |
| `src/renderer/src/App.tsx` | Main layout + sidebar routing |
| `src/shared/types.ts` | Shared type definitions |
| `src/preload/index.ts` | `window.api.*` bridge |

## Known quirks

- **better-sqlite3 ABI flips** between Node and Electron. Run `npm run predev` / `npm run pretest` to swap the correct binary. `NODE_MODULE_VERSION 128 vs 137` errors mean wrong binary.
- **`node:fetch` does not exist** in Node 24. Use global `fetch`.
- **`window.api` declaration** lives only in `src/renderer/src/global.d.ts`. Never redeclare per-file.
- **`ELECTRON_RUN_AS_NODE`** guard in `dev` script prevents CJS/ESM mismatch crashes.
- **IV rank/percentile** are null from Polygon snapshot — computed later in pipeline.
- **Earnings calendar** returns null — no Polygon public endpoint.
- **E*Trade IV** is a decimal fraction (0.3882 = 38.82%). Always `* 100` when ingesting.