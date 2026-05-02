# Architecture

> Companion to `AI_CONTEXT.md → Architecture`. This document goes deeper for humans onboarding to the codebase.

## Process model

TradeAnalyzer is a standard Electron tri-process app:

| Process | Role | What runs here |
| --- | --- | --- |
| **Main** (`src/main/`) | Owns SQLite, the rate limiter (Phase ≥ 3), and all DataProvider calls. Single source of truth. | Node.js (Electron's bundled runtime). Full filesystem + network. |
| **Preload** (`src/preload/`) | Bridge that exposes a typed `window.api.*` surface to the renderer via `contextBridge`. | Sandboxed Node context with `contextIsolation: true`, `nodeIntegration: false`. |
| **Renderer** (`src/renderer/`) | React UI. No direct Node, FS, or network access. | Chromium with strict CSP. |

All cross-process communication goes through `ipcMain.handle` / `ipcRenderer.invoke` channels registered in `src/main/ipc/*` and consumed by `src/preload/index.ts`. The renderer uses the typed wrapper in `src/renderer/src/api.ts`.

## Phase-1 data flow

```
React view
   │
   ▼  window.api.watchlists.create('Tech')
preload.ts (contextBridge)
   │
   ▼  ipcRenderer.invoke('watchlists:create', name)
ipc/ipc-watchlists.ts (ipcMain.handle)
   │
   ▼  watchlistService.create(name)
services/watchlist-service.ts (better-sqlite3 prepared statements)
   │
   ▼  INSERT INTO watchlists ...
SQLite (userData/trade-analyzer.sqlite)
```

## Producer/consumer pipeline (Phase ≥ 3, not yet implemented)

Per spec §4.4:

```
       Job queue                     Result queue
[t1, t2, ..., tn] ─▶ Fetcher worker ─▶ [resp1, resp2, ...] ─▶ Persister worker ─▶ SQLite
                       │ ▲                                       │
                       │ │   token-bucket (default 100/min)      │
                       │ └─ HTTP 429 → halve rate, backoff, ramp │
                       └────── progress events ─────────────────▶│
                                                                  ▼
                                                              UI Coordinator
```

Job state lives in `job_runs` and `job_progress` (schema in `migrations/` once Phase 3 lands). Stop is graceful (in-flight requests complete and persist; queue drains). Resume reads `job_progress` and skips already-completed tickers.

## Persistence layout

- **DB file**: `${app.getPath('userData')}/trade-analyzer.sqlite`. In tests we point this at a temp file or `:memory:` via `WatchlistService` constructor injection.
- **Migrations**: `/migrations/NNN_*.sql`. Applied on app launch (and in tests via the same runner). `schema_version` table tracks the head.
- **Backups**: `/backups/db_pre_v{N}_{ts}.sqlite`, last 5 retained. Created automatically before each migration (Phase ≥ 2 — currently no auto-backup since only `001_init` exists).

## IPC channel naming

`{namespace}:{verb}` where namespace mirrors the FR cluster. Phase 1 channels:

- `watchlists:list`
- `watchlists:get`
- `watchlists:create`
- `watchlists:rename`
- `watchlists:delete`
- `watchlists:items:list`
- `watchlists:items:add`
- `watchlists:items:add-bulk`
- `watchlists:items:remove`
- `watchlists:csv:export`
- `watchlists:csv:import`

Each handler validates inputs, calls the service, returns either the result or `{ error: { code, message } }`. The renderer wrapper in `api.ts` throws on error so views can use try/catch.
