# TradeAnalyzer

Cross-platform desktop application for a single retail options/swing trader. Manages watchlists, screens index universes, runs analysis modes, and provides per-stock validation dashboards.

> **Status:** v0.4.0 — Phases 1-4 complete (Watchlists, Screener, Analysis Engine, Validation Dashboard, Settings). Polygon integration active.

For the full spec, see [`REQUIREMENTS.md`](REQUIREMENTS.md). For AI session bootstrapping, see [`AI_CONTEXT.md`](AI_CONTEXT.md) and [`AI_PROMPT.md`](AI_PROMPT.md). For per-version notes, see [`CHANGELOG.md`](CHANGELOG.md).

## Prerequisites

- **Node.js ≥ 22.5** (tested on 24.15)
- **npm ≥ 10**
- **Windows**: Visual Studio Build Tools 2022 with the *Desktop development with C++* workload, for `electron-rebuild` of `better-sqlite3` against Electron's Node ABI. Most fresh installs run on the prebuilt binary, but the rebuild path needs the toolchain.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).

## Install

```bash
npm install
```

> **Native module note:** the `better-sqlite3` binary has to match either Electron's Node ABI (for `dev`/`build`) or the system Node ABI (for `vitest`). Only one can live in `node_modules` at a time. The npm scripts handle the dance:
>
> - `npm run dev`, `npm run build`, `npm run package` automatically run `rebuild:electron` first (Electron ABI).
> - `npm test` automatically runs `rebuild:node` first (system Node ABI).
>
> If you ever see `NODE_MODULE_VERSION 128 vs 137`, run the matching script manually.

## Configuration (Polygon API key)

The application requires a Polygon.io API key. The key is sourced in this priority order:

1. OS keychain (via `keytar`) — preferred.
2. Environment variable `POLYGON_API_KEY` from a local `.env` (gitignored).
3. Settings UI input.

A template lives at `.env.example`. Never commit a real key.

## Running

```bash
npm run dev          # development with HMR
npm run typecheck    # TypeScript across main + preload + renderer
npm run lint         # ESLint
npm test             # offline test suite (Vitest)
npm run build        # production installer
```

## Testing

The offline suite must complete in under 90 seconds (per spec EP-6.5). Live-Polygon smoke tests are gated behind `POLYGON_LIVE_TESTS=1` and not part of the default run.

```bash
npm test                       # offline
POLYGON_LIVE_TESTS=1 npm test  # includes live-API smoke (Phase ≥ 2)
```

## Repository layout

See `AI_CONTEXT.md → Repository Map` for the authoritative layout.

## Design Decisions

This section answers the "Open Questions" in spec §10.

### Stack: Electron + React + TypeScript via electron-vite

- The spec recommends Electron + React + TypeScript explicitly. Picking the recommended option keeps the focus on product logic.
- `electron-vite` consolidates main, preload, and renderer into a single Vite-based config with HMR for both processes. Avoids hand-rolling five separate tsconfigs.
- TypeScript strict mode is on in all three contexts; types in `src/shared` cross the IPC boundary.

### SQLite: better-sqlite3 12.x

- Synchronous API maps cleanly to per-IPC-call request handlers in the main process — no need to model async DB latency in service code that already runs off the renderer thread.
- Mature ecosystem and feature surface (WAL tuning, attached DBs, JSON1/FTS5 baked in).
- Native binding rebuilt for Electron's ABI via `electron-rebuild`, wired through `electron-builder install-app-deps` as `postinstall`.
- Wrapped in `src/main/db/connection.ts` (`openDatabase`, `withTransaction`) so the driver isn't leaked across the codebase.

### Charting library: deferred

- Decide in Phase 4 (validation dashboard) when overlay/indicator needs are concrete. Candidates: `lightweight-charts` (smaller, finance-first) vs `ApexCharts` (more general). No installation cost yet.

### Producer/consumer pipeline: deferred to Phase 3

- Will use Node `worker_threads` + in-process queues + token-bucket rate limiter. No external broker (Redis/BullMQ would add deployment complexity for a single-user app).

### Suitability-score (wheel) and ratios mapping: deferred

- Spec §10 defers these to be documented in `docs/formulas.md` and `docs/data-provider.md` before code lands. Will be filled in with Phase 3 (analysis) and Phase 2 (screener) respectively.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Contributing / AI sessions

Read `AI_PROMPT.md` and `AI_CONTEXT.md` first. Every material commit must update version + changelog + AI_CONTEXT.

## License

Private — not for distribution.
