# TradeAnalyzer

Cross-platform desktop application for a single retail options/swing trader. Manages watchlists, screens index universes, runs analysis modes, and provides per-stock validation dashboards.

> **Status:** v0.1.0 — Phase 1 (watchlist CRUD) complete. Polygon integration not yet wired.

For the full spec, see [`REQUIREMENTS.md`](REQUIREMENTS.md). For AI session bootstrapping, see [`AI_CONTEXT.md`](AI_CONTEXT.md) and [`AI_PROMPT.md`](AI_PROMPT.md). For per-version notes, see [`CHANGELOG.md`](CHANGELOG.md).

## Prerequisites

- **Node.js ≥ 22.5** (tested on 24.15). Required for the built-in `node:sqlite` module.
- **npm ≥ 10**
- No native compilation toolchain needed in Phase 1 (we use `node:sqlite`, not `better-sqlite3`).

## Install

```bash
npm install
```

## Configuration (Polygon API key)

Phase 1 does not call Polygon. Configuration arrives in Phase 2 (screener).

When it does, the API key will be sourced in this priority order:

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

### SQLite: Node 24's built-in `node:sqlite`

- Synchronous API like better-sqlite3, with zero native compilation step. The dev box does not have Visual Studio Build Tools, and better-sqlite3 12.x lacks Node-24 prebuilds; pivoting to `node:sqlite` removed an entire failure mode for fresh clones.
- The driver is wrapped in `src/main/db/connection.ts` (`openDatabase`, `withTransaction`) so swapping to better-sqlite3 later is a single-file change — useful if/when we want WAL checkpointing tunables, named bind parameters, or other better-sqlite3-only features.

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
