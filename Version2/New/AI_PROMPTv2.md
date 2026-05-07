# AI_PROMPTv2 - Standing Instructions for TradeAnalyzer_Gemini

> **Read this file first** before starting any work on this codebase.

## Quick Start Checklist

1. **Read AI_CONTEXT.md** - Source of truth for current state
2. **Read TECH_CONTEXT.md** - Technical architecture and stack
3. **Read REQUIREMENT.md** - Complete functional requirements
4. **Check CHANGELOG.md** - Recent changes and version history
5. **Review git status** - Understand current work in progress

## Project Overview

**TradeAnalyzer_Gemini** is a single-user desktop application for retail options/swing traders. It provides:
- Watchlist management with real-time data
- Index screening (S&P 500 / Russell 1000) for trade candidates
- Multi-mode analysis (buy zones, options income, wheel strategy)
- Portfolio tracking with automated alerts
- Morning briefing with market regime detection
- Historical data analysis with charts
- Real-time price streaming

## Hard Rules (Non-Negotiable)

### Rate Limiting
- **Never bypass the rate limiter.** All Polygon traffic goes through the TokenBucket rate limiter
- Default: 100 req/min, configurable 10-500 req/min
- Auto-throttle on HTTP 429: halve rate, exponential backoff, gradual ramp-up

### Data Integrity
- **Never invent market data.** If a field is missing from Polygon, surface it as missing
- All financial calculations must be reproducible: log inputs, formulas, outputs
- Cache hit/miss logs in API call logs

### Security
- API keys live in OS keychain or `.env` (never committed)
- Scrub secrets from all logs at write time
- No data sent off-user's machine (local-only telemetry)

### Documentation Requirements
Every material change requires:
1. Version bump (semver: PATCH/MINOR/MAJOR)
2. CHANGELOG.md entry + changelogs/v{version}_{date}.md
3. AI_CONTEXT.md, TECH_CONTEXT.md, REQUIREMENT.md update when new changes introduced that were not in these original documents
4. Single conventional commit: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`

### Testing
- Every bug fix ships with regression test (fails before, passes after)
- Financial calculations must have unit tests
- Run `npm test` before committing

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer                              │
│  React 18 + TypeScript + Tailwind CSS + Recharts            │
│  Zustand for state management                               │
│  Custom hooks: useSortable, useCacheStatus, useAutoRefresh  │
│  Tauri IPC for Rust communication                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Tauri Bridge                           │
│  Commands: watchlist, market, portfolio, historical, etc.   │
│  Events: cache-stale (backend → frontend)                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Rust Backend                             │
│  DataProvider trait (PolygonProvider impl)                  │
│  TokenBucket RateLimiter                                    │
│  Producer/Consumer ScreenerPipeline                         │
│  CacheManager (staleness checking, auto-refresh triggers)   │
│  SQLite via rusqlite                                        │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

1. **Screener Pipeline**: Producer fetches → Queue → Consumer persists
2. **Real-time**: WebSocket → Zustand store → UI components
3. **Analysis**: Pull from cache → Compute → Display
4. **Cache Status**: Backend check → Event emit → Frontend hook → UI indicator

## Key Files Reference

| File | Purpose |
|------|---------|
| `src-tauri/src/lib.rs` | Tauri init, command registration, state setup |
| `src-tauri/src/services/polygon.rs` | Polygon API implementation |
| `src-tauri/src/services/data_provider.rs` | DataProvider trait definition |
| `src-tauri/src/services/screener_pipeline.rs` | Producer/consumer batch processing |
| `src-tauri/src/services/cache_manager.rs` | Cache staleness checking, auto-refresh |
| `src-tauri/src/commands/*.rs` | IPC command handlers |
| `src-tauri/src/db/mod.rs` | SQLite connection & migrations |
| `src/services/*.ts` | Frontend API wrappers |
| `src/store/*.ts` | Zustand state stores |
| `src/hooks/useSortable.ts` | Generic table column sorting |
| `src/hooks/useCacheStatus.ts` | Cache freshness polling |
| `src/hooks/useAutoRefresh.ts` | Auto-refresh event listener |
| `src/components/CacheStatusIndicator.tsx` | Visual cache status display |
| `migrations/*.sql` | Database schema migrations |

## Domain Glossary

- **CSP** - Cash-Secured Put
- **CC** - Covered Call
- **Wheel** - Strategy: sell CSPs until assigned, then sell CCs
- **DTE** - Days To Expiration
- **Delta** - Probability proxy and hedge ratio
- **IV Rank** - IV position in 52-week range
- **Buy Zone** - Computed entry range based on support/ATR
- **Wheel Suitability Score** - 0-100 score (ROE 30% + D/E 30% + Mkt Cap 20% + Stability 25%)
- **Target Strike** - Suggested put strike (current price × 0.92)
- **Est. Premium** - Estimated monthly premium (strike × 1.2% for 30 DTE)
- **Market Regime** - SPY/VIX-based trend/volatility classification
- **Cache Staleness** - Data age > 1 hour triggers auto-refresh indicator

## Working Agreement

### Before Coding
- Check if there's a `TODO(phase-N):` comment related to your task
- Verify current version in `package.json` and `Cargo.toml`
- Review open decisions in AI_CONTEXT.md

### While Coding
- Prefer simplest implementation that satisfies requirements
- Don't add features outside scope without flagging as "proposed extension"
- Financial formulas need `// see docs/formulas.md#anchor` comment
- Use existing patterns; don't introduce new abstractions prematurely

### Before Committing
- Run tests: `npm test` and `cargo test`
- Check TypeScript: `npx tsc --noEmit`
- Check Rust: `cargo clippy`
- Update version, CHANGELOG, AI_CONTEXT
- Single conventional commit with descriptive message

## Common Tasks

### Add New Command
1. Add to `src-tauri/src/commands/{module}.rs`
2. Export in `src-tauri/src/commands/mod.rs`
3. Register in `src-tauri/src/lib.rs` invoke_handler
4. Create frontend service in `src/services/{name}.ts`
5. Add tests

### Add Database Migration
1. Create `migrations/{NNN}_{description}.sql`
2. Run automatically on app start via `db::init()`
3. Update `AI_CONTEXT.md` data model section

### Add New Chart Component
1. Create component in `src/components/ChartName.tsx`
2. Use Recharts (existing pattern)
3. Add to relevant view
4. Add CSV/PDF export buttons (see existing charts)

### Add Sortable Table Columns
1. Import `useSortable` hook: `import { useSortable } from '../hooks/useSortable'`
2. Wrap data: `const { sortedData, sortConfig, requestSort } = useSortable(data, 'key', 'asc')`
3. Use `SortableHeader` component or similar pattern for column headers
4. Pass `requestSort` to header click handlers

### Add Cache Status Indicator
1. Import `CacheStatusIndicator` component
2. Import `useCacheStatus` hook for custom polling (optional)
3. Use pattern from ScreenerView or WatchlistView
4. Backend emits `cache-stale` event if > 1 hour on startup

## Troubleshooting

### Build Issues
- `npm run tauri dev` - Start dev server
- Check `.env` has `POLYGON_API_KEY`
- Delete `node_modules` and `npm install` if needed
- `cargo clean` in `src-tauri` if Rust issues

### Database Issues
- Check `src-tauri/calllogs/` for API call logs
- Check `src-tauri/errorlogs/` for errors
- SQLite file is in app data directory (platform-specific)

### Rate Limiting Issues
- Check Settings for rate limit config
- Review `src-tauri/calllogs/api_calls.log.*` for 429 errors
- Auto-throttle will adjust automatically

### Cache/Auto-Refresh Issues
- Check `src-tauri/errorlogs/` for CacheManager errors
- Verify `cache_metadata` table exists in database
- Manual refresh via "Refresh All Data" button if needed
- Cache status polling happens every 5 minutes via `useCacheStatus`

## External Resources

- **Polygon Docs**: https://polygon.io/docs
- **Tauri Docs**: https://tauri.app/v1/guides/
- **Recharts Docs**: https://recharts.org/en-US
- **Zustand Docs**: https://docs.pmndrs.ai/zustand

## Contact & Support

For issues or questions:
- Check AI_CONTEXT.md "Known Quirks & Gotchas"
- Review git log for similar changes
- Check CHANGELOG for recent related changes

---

**Last Updated**: 2026-05-05  
**Version**: 0.1.6  
**Phase**: All phases complete (1-6 + Phase 3 enhancements)
