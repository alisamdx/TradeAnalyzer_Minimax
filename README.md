# TradeAnalyzer

A cross-platform desktop application for a single retail **options / swing trader**. It screens the S&P 500 + Russell 1000 + ETF universe for sound trade candidates, scores and ranks them, produces a daily AI intelligence brief, models multi-leg option payoffs, tracks a live portfolio synced from E*Trade, and flags earnings and news risk — all locally, with no cloud sync and no broker order execution.

> **Status:** approaching **v1.0.0**. All v1 spec requirements, the five enhancement tracks, the News & Research module, the scoring engine, and the Agent integration are implemented. The remaining gate is a week of real-world usage validation.

For AI session bootstrapping, read [`CLAUDE.md`](CLAUDE.md) (operating rules) then [`.ai/AI_CONTEXT.md`](.ai/AI_CONTEXT.md) (build-state snapshot). For the full spec, see [`Requirements/spec/`](Requirements/spec/00-index.md) (the authoritative, rebuild-from-scratch specification). For release history, see [`CHANGELOG.md`](CHANGELOG.md).

---

## What it does

| Area | Capabilities |
| --- | --- |
| **Screening** | Index screener (17 default filters, strict/soft modes, presets), Opportunity dashboard (composite score), Filters templates, News & Research dossiers with AI impact scoring |
| **Analysis** | Five modes (Buy, Options Income, Wheel, Bullish, Bearish), per-stock Validation dashboard (fundamentals, trend, candlesticks, indicators, IV rank), Strategy Lab (scores all 31 tastylive strategies) |
| **Options** | Live options chain (E*Trade), multi-leg Payoff visualizer with risk matrix + AI assessment, LEAPS+CSP and Collared-LEAPS screeners |
| **Intelligence** | Daily AI Intelligence Brief (scored picks per strategy + rationale + email/PDF), AI Critic second-opinion, Trade Scoring engine (configurable weights), Retrospect paper-trade tracking |
| **Portfolio** | Positions synced from E*Trade, P&L, aggregate Greeks, trade-management alerts, AI Portfolio Advisor |
| **Risk** | Earnings calendar (list + grid), earnings/news annotations across Validate/Payoff/Portfolio, price/expiration/delta alerts |
| **Data** | IV-history backfill (true IV rank), historical price/financials, batch job scheduler, backtesting engine |
| **Personal** | My Stocks conviction list with price bands and buy-zone alerts |

The app exposes a local HTTP API (Fastify, `127.0.0.1:7432`) consumed by an external TraderAgent.

---

## Prerequisites

- **Node.js ≥ 22.5** (tested on 24.x)
- **npm ≥ 10**
- **Windows**: Visual Studio Build Tools 2022 (*Desktop development with C++*) for the `better-sqlite3` Electron rebuild path. **Developer Mode must be ON** (Settings → System → For developers) for `npm run package` — electron-builder's winCodeSign archive contains macOS symlinks that non-admin users can't create otherwise.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).

## Install

```bash
npm install
```

> **Native module note:** the `better-sqlite3` binary must match either Electron's Node ABI (for `dev`/`build`/`package`) or the system Node ABI (for `vitest`). Only one can live in `node_modules` at a time, so the npm scripts swap it automatically:
> - `npm run dev` / `build` / `package` run `rebuild:electron` first.
> - `npm test` runs `rebuild:node` first.
>
> If you see `NODE_MODULE_VERSION 128 vs 137`, run the matching `rebuild:*` script manually.

## Configuration

The app integrates several providers. Keys are stored in the OS keychain or encrypted settings (Windows DPAPI) — never committed, never logged.

| Provider | Used for | Required? |
| --- | --- | --- |
| **Polygon.io** (Stocks Starter) | Quotes, fundamentals, historical bars, news | Yes |
| **E*Trade** (OAuth 1.0a) | Options chains, IV/Greeks, earnings, portfolio sync | Yes (active options + portfolio source) |
| **Anthropic Claude** | Daily brief, critic, advisor, news synthesis, payoff/strategy AI | Optional (AI features degrade gracefully without a key) |
| **MarketData.app / IVolatility** | IV-history backfill (true IV rank) | Optional |

Polygon key sourcing priority: OS keychain → `POLYGON_API_KEY` in a local `.env` (gitignored, template at `.env.example`) → Settings UI. E*Trade credentials and other keys are entered in the Settings screen.

> **E*Trade tokens expire at midnight ET** and go dormant after ~2h idle. Batch jobs auto-renew where possible; otherwise reconnect from Settings.

## Running

```bash
npm run dev          # development with HMR
npm run typecheck    # TypeScript across main + preload + renderer
npm run lint         # ESLint
npm test             # offline test suite (Vitest)
npm run build        # production build + installer
npm run package      # build without installer (--dir)
```

### Running the v2 execution engine against IBKR (paper)

The execution engine defaults to the deterministic **mock broker**; IBKR (TWS/Gateway) is opt-in via
the `TA_EXEC_BROKER=ibkr` environment variable. Because the app is single-instance, any running mock
instance must be closed first. The `run-ibkr.ps1` launcher does both — it stops a running instance,
sets the env var, and starts the packaged exe:

```powershell
.\run-ibkr.ps1                 # stop mock, TA_EXEC_BROKER=ibkr, launch → expect [execution] broker=ibkr mode=paper @ 127.0.0.1:7497
.\run-ibkr.ps1 -Gateway        # IB Gateway ports (4002 paper) instead of TWS
.\run-ibkr.ps1 -Port 7497      # explicit socket-port override
```

Paper vs live comes from `exec_config.executionMode` (not the script). Requires TWS/Gateway logged
in to the paper account with the API enabled (Global Config → API → Settings → *Enable ActiveX and
Socket Clients*, port open, `127.0.0.1` trusted). Confirm the `broker=ibkr` log line; `broker=mock`
means the env var didn't reach the process.

## Architecture (at a glance)

Standard Electron tri-process app:

```
React view  →  window.api.<ns>.<method>()        (src/renderer)
            →  contextBridge / ipcRenderer.invoke (src/preload)
            →  ipcMain.handle in ipc-*.ts          (src/main/ipc)
            →  Service                              (src/main/services)
            →  better-sqlite3 (withTransaction) + DataProvider/OptionsProvider
```

- **Main** owns SQLite, the rate limiter, all provider calls, the batch scheduler, and the Fastify API server.
- **Preload** exposes a typed, sandboxed `window.api.*` surface (33 namespaces).
- **Renderer** is pure React — no Node, FS, or network access.
- Long-running jobs use a token-bucket rate limiter + a SQLite-backed resumable queue.

Full detail: [`docs/architecture.md`](docs/architecture.md) and [`.ai/AI_CONTEXT.md`](.ai/AI_CONTEXT.md). Data-provider contract: [`docs/data-provider.md`](docs/data-provider.md). Every financial formula: [`docs/formulas.md`](docs/formulas.md).

## Design decisions

- **Electron + React + TypeScript via electron-vite** — the spec's recommended stack; electron-vite unifies main/preload/renderer in one Vite config with HMR. TypeScript strict everywhere; shared types in `src/shared` cross the IPC boundary.
- **better-sqlite3 12.x** — synchronous API maps cleanly to per-IPC handlers in the main process. Wrapped in `src/main/db/connection.ts` (`openDatabase`, `withTransaction`) so the driver isn't leaked across the codebase.
- **Pluggable providers** — `DataProvider` (Polygon) and `OptionsProvider` (E*Trade, switchable) are interfaces, so a provider swap is a single-class change.
- **lightweight-charts + recharts** — finance-first candlesticks plus general charting for dashboards.
- **Local-only** — single SQLite file under `app.getPath('userData')`; no multi-user, no cloud, no order execution.

## Repository layout

See [`.ai/AI_CONTEXT.md → Repository map`](.ai/AI_CONTEXT.md) for the authoritative, current layout.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Contributing / AI sessions

Read [`CLAUDE.md`](CLAUDE.md) then [`.ai/AI_CONTEXT.md`](.ai/AI_CONTEXT.md) first. Every material commit bumps the version and updates `CHANGELOG.md`, the per-version `changelogs/` file, and `.ai/AI_CONTEXT.md` in the same commit; bug fixes ship a regression test.

## License

Private — not for distribution.
