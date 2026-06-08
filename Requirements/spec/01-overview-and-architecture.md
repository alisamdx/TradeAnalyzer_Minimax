# 01 — Overview & Architecture

## 1.1 Product

TradeAnalyzer is a **single-user desktop application for a retail options/swing trader**. It helps the user find, evaluate, time, and manage 1–2 month options-income and directional trades using disciplined math rather than intuition. It covers the full pipeline: scan the universe → screen for quality → score and rank candidates → produce a daily prioritized brief → model the option structure → enter and track the position → manage exits around earnings/news risk.

It is a **decision-support tool, not a trading terminal**. It does not place orders. Its E*Trade integration is strictly read-only (quotes, option chains, account positions, transaction history).

### Goals
- Surface the best 1–2 month trade setups out of a ~1,100-name universe with minimal friction.
- Enforce premium-selling discipline (IV rank gates, earnings avoidance, 50%-profit / 21-DTE management).
- Be fully local, fast, and resumable — no cloud, no multi-user, no account required.

### Non-goals (v1)
- Live order placement / broker execution.
- Real-time tick streaming (15-min delayed or EOD data is sufficient).
- Multi-user auth / cloud sync.
- Mobile native apps.

## 1.2 Target user

A single experienced retail trader running options income strategies (wheel, CSPs, covered calls) and directional swing trades. Technically literate, comfortable with finance terminology, wants dense information-rich screens — not wizards.

## 1.3 Technology stack

| Layer | Choice | Version | Rationale |
| --- | --- | --- | --- |
| Desktop shell | Electron | 32.x | Cross-platform (Windows + macOS), Node + Chromium. |
| UI | React + TypeScript | 18 / 5.x (strict) | Component ecosystem for tables/charts. |
| Build | electron-vite | 2.x | Single config for main + preload + renderer; HMR. |
| Database | better-sqlite3 | 12.x | Synchronous API, single-file local DB. Wrapped so the driver is swappable. |
| Charts | lightweight-charts + recharts | 4.1.x / 3.x | Finance candlesticks + general dashboard charts. |
| Local HTTP server | Fastify | 5.x | Local API for the external agent (127.0.0.1:7432). |
| AI | `@anthropic-ai/sdk` | current | Claude calls for brief/critic/advisor/news/payoff/strategy. |
| PDF / Email | pdfkit / nodemailer | — | Brief report PDF + email delivery. |
| Realtime | `ws` | 8.x | Optional Polygon delayed WebSocket price feed. |
| Tests | Vitest | 2.x | Jest-compatible, Vite-native. |
| Lint/format | ESLint 9 + Prettier 3 | — | Standard. |

The app must run on **Node ≥ 22.5**. The app version is a single canonical value in `package.json`, injected into the renderer at build time as `__APP_VERSION__` and shown in the status bar.

## 1.4 Process model

Standard Electron tri-process architecture:

| Process | Owns | Constraints |
| --- | --- | --- |
| **Main** (`src/main/`) | SQLite connection, all provider/network calls, rate limiter, batch scheduler, Fastify API server. The single source of truth. | Full Node/FS/network. |
| **Preload** (`src/preload/index.ts`) | A typed `window.api.*` bridge exposed via `contextBridge`. | `contextIsolation: true`, `nodeIntegration: false`. |
| **Renderer** (`src/renderer/`) | React UI only. | No Node, FS, or network — only `window.api.*`. |

The renderer never imports Node modules, never touches the filesystem, and never calls a provider directly. Everything goes through IPC.

## 1.5 Data flow

```
React view
  → window.api.<namespace>.<method>(args)        (preload bridge)
  → ipcRenderer.invoke('<channel>', ...args)
  → ipcMain.handle('<channel>') in src/main/ipc/ipc-*.ts
  → Service class in src/main/services/
  → better-sqlite3 (via withTransaction) and/or a Provider (Polygon / E*Trade / …)
  → result bubbles back as IpcResult<T>
```

**IPC response contract.** Every handler returns a uniform envelope:
```ts
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
```
The preload `invoke<T>()` wrapper unwraps it: returns `value` on success, throws an `Error` (with `.code`) on failure. The renderer therefore sees plain promises that resolve or reject.

**Cross-view navigation.** Views are selected by a single `currentView` string in `App.tsx`. Programmatic navigation between views uses browser `CustomEvent`s dispatched on `window`:
- `navigate-to-payoff` — `{ ticker, spot, expiry, legs }`
- `navigate-to-validate` — `{ ticker }`
- `navigate-to-analysis` — `{ ticker }`
- `navigate-to-options` — `{ ticker, expiry? }`

Each target view registers a `window.addEventListener` for its event and switches `currentView` + preloads the payload.

## 1.6 Database location

- **Packaged build:** `app.getPath('userData')/trade-analyzer.sqlite` → on Windows `%AppData%/trade-analyzer/trade-analyzer.sqlite`.
- **Dev build:** `<appPath>/data/trade-analyzer.sqlite`.

Migrations run automatically on startup (see §02). A single connection is opened via `openDatabase()` and shared across all services. All writes go through `withTransaction(db, fn)`.

## 1.7 Project layout

```
src/main/
  index.ts                  App lifecycle, window, provider wiring, IPC + batch job registration
  db/connection.ts          openDatabase(), withTransaction() — only DB entry points
  db/migrations.ts          Applies numbered migrations from /migrations
  api-server.ts             Fastify local API (port 7432)
  api/                      REST route modules (health, watchlists, screener, analysis,
                            validation, options, quotes, fundamentals, jobs, settings,
                            etrade, strategy-lab, critic)
  ipc/ipc-*.ts              One IPC handler module per feature area (~27)
  services/                 Service classes (~60) — business logic (see each feature section)
  services/jobs/            Batch job handlers (~9)
src/preload/index.ts        window.api.* bridge (~33 namespaces) + window.dialog.*
src/renderer/src/
  App.tsx                   Sidebar routing (8 sections, ~26 views), layout, status bar
  main.tsx                  React entry
  views/                    One component per feature view
  global.d.ts               window.api type declaration (ONLY place it is declared)
  knowledge/                Embedded tastylive strategy guide (PNG images + JSON one-pagers)
  styles.css
src/shared/types.ts         All types crossing the IPC boundary
migrations/                 Numbered .sql migrations (001_…, 002_…, …)
docs/                       architecture.md, data-provider.md, formulas.md, troubleshooting.md
Requirements/spec/          THIS specification
changelogs/                 Per-version notes
```

## 1.8 Settings

A free-form key/value `settings` table backs an `AppSettings` object. Sensitive keys (API keys, E*Trade consumer key/secret + OAuth tokens) are stored **encrypted** (Windows DPAPI via `secure-settings.ts`) or in the OS keychain — never in plaintext settings, never logged, never committed.

Representative `AppSettings` fields: Polygon API key source, `optionsProvider` (`'polygon' | 'etrade'`), `accountSize` (for buying-power %), cache TTLs, rate limit (req/min), batch size, default screener universe, theme (`dark|light`), sound alerts, auto WebSocket connect, keyboard shortcuts, Anthropic key presence, MarketData/IVolatility keys, agent DB + project paths, SMTP/email config. The full set is defined where each feature is specified.

## 1.9 Non-functional requirements

- **NFR-1 Performance.** App startup < 3s. Watchlist switch < 500ms. 1Y daily chart render < 1s. Single-stock validation < 5s warm / 10s cold. Validate All on 50 tickers < 5 min without freezing the UI.
- **NFR-2 Reliability.** All provider calls retry with backoff (3 attempts) and surface failures in the UI. No silent failures. Never display stale numbers without a freshness/partial badge.
- **NFR-3 Caching.** Fundamentals 24h, quotes 60s (configurable), options chains 5 min, constituents 7 days. See §03.
- **NFR-4 Persistence.** Watchlists, snapshots, settings, positions, and caches survive restart (SQLite).
- **NFR-5 Logging.** Structured JSON logs of every provider call and batch run. Log path shown in Settings. API keys redacted at write time.
- **NFR-6 Rate-limit handling.** On HTTP 429, auto-throttle (halve rate, exponential backoff ~5 min, ramp back) and surface in the UI.
- **NFR-7 Security.** Secrets in OS keychain / DPAPI-encrypted settings / `.env` (gitignored). Never logged, never sent anywhere except the configured provider/Anthropic.
- **NFR-8 Testability.** Providers are interfaces and mockable. Unit tests for screening logic, analysis math, indicators, formulas, CSV round-trip, and strategy builders.
- **NFR-9 Accessibility.** Keyboard-navigable controls; color is never the only signal (icons + color for buy/sell/trend badges).
- **NFR-10 Documentation.** This spec, plus README onboarding and CLAUDE operating rules, kept current.

## 1.10 Known platform gotchas (must be handled)

- **better-sqlite3 ABI** differs between Node and Electron. The build swaps the correct prebuilt binary (`rebuild:electron` for dev/build/package, `rebuild:node` for tests). A `NODE_MODULE_VERSION X vs Y` error means the wrong binary is installed.
- **`node:fetch` does not exist** in Node 24 — use the global `fetch`.
- **`window.api` is declared in exactly one place** (`renderer/src/global.d.ts`). Redeclaring per-file causes TS2717.
- The `dev` script must unset/guard **`ELECTRON_RUN_AS_NODE`** or Electron runs the bundle as plain Node and crashes with a CJS/ESM mismatch.
- **`package.json` must be UTF-8 without BOM.** A BOM (e.g. from PowerShell `Set-Content -Encoding utf8`) breaks electron-vite's JSON parse.
- **Packaging on Windows requires Developer Mode ON** (electron-builder's winCodeSign archive contains symlinks).
