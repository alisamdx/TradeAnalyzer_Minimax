# TECH_CONTEXT - TradeAnalyzer_Gemini Technical Architecture

## Executive Summary

This document describes the technical architecture of TradeAnalyzer_Gemini. It documents current implementation choices while noting where alternatives could be considered. Future AI sessions should use this as reference, but are encouraged to propose improvements where current choices create friction.

## Current Tech Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **Shell** | Tauri | 2.x | Rust-based, secure, memory-efficient alternative to Electron |
| **Frontend** | React | 18.x | Ecosystem maturity, component reusability |
| **Language (FE)** | TypeScript | 5.x | Type safety, IDE support, maintainability |
| **Styling** | Tailwind CSS | 3.x | Utility-first, rapid UI development |
| **State** | Zustand | 4.x | Lightweight, minimal boilerplate vs Redux |
| **Charts** | Recharts | 2.x | React-native, composable, good for financial viz |
| **Build** | Vite | 5.x | Fast HMR, optimized builds |
| **Backend** | Rust | 1.7x | Performance, safety, financial calculation precision |
| **Database** | SQLite (rusqlite) | 0.32 | Native Rust bindings, single-file deployment |
| **Testing (FE)** | Vitest | 1.x | Vite-native, fast, modern API |
| **Testing (Rust)** | Cargo Test | built-in | Standard Rust testing |
| **Lint/Format** | ESLint + Prettier | 9.x / 3.x | Industry standard, consistent code style |
| **API Client** | reqwest (Rust) | 0.12 | Async HTTP, JSON handling |
| **Rate Limiting** | Custom TokenBucket | - | Tailored to Polygon's patterns |

## Architecture Patterns

### 1. Process Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Process (Rust)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │  SQLite     │  │ RateLimiter │  │  PolygonProvider    │ │
│  │  (rusqlite) │  │(TokenBucket)│  │  (DataProvider impl) │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐ │
│  │         ScreenerPipeline (Producer/Consumer)         │ │
│  │   Producer: Fetch from Polygon → Queue                │ │
│  │   Consumer: Parse → Compute → Persist to SQLite     │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ IPC (Tauri Commands)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     UI Process (React)                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Zustand Store │  │ Tauri Invoke │  │ React Components │  │
│  │ (Global State)│  │ (IPC Bridge) │  │ (Views/Charts)   │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Rationale**: Rust handles all heavy computation (financial math, rate limiting, database writes) while React focuses on presentation. This separation keeps the UI responsive (60fps) during intensive background operations.

**Alternative Considered**: Single-process Electron with Node workers. Rejected because Rust's memory safety and performance characteristics are superior for financial calculations.

### 2. Data Flow Patterns

#### A. Screener Pipeline (Producer/Consumer)
```
User clicks "Run Screener"
    │
    ▼
[Producer] ├─→ Fetch ticker from Polygon
    │      ├─→ Rate limit (TokenBucket)
    │      └─→ Place raw response on Queue
    │
    ▼
[Queue]    ├─→ Buffers responses
    │      └─→ Decouples fetch from persist
    │
    ▼
[Consumer] ├─→ Pull from Queue
    │      ├─→ Parse XBRL financials
    │      ├─→ Compute derived ratios
    │      └─→ Write to SQLite
    │
    ▼
[UI]       ├─→ Subscribe to progress events
           └─→ Update progress bar
```

**Benefits**: 
- Database writes never block API calls
- Resume capability: completed tickers tracked in job_runs table
- Progress reporting: granular fetch/persist status

#### B. Real-time Price Streaming
```
WebSocket (Polygon delayed)
    │
    ▼
polygonWebSocket.ts (singleton)
    │
    ├─→ Subscribe handlers (multiple components)
    │
    ▼
useRealtimePrices hook
    │
    ▼
RealtimePriceTicker component
```

**Benefits**: Single WebSocket connection shared across components, automatic reconnection with exponential backoff.

### 3. Database Schema

```sql
-- Core tables (persistent)
schema_version      -- Migration tracking
watchlists          -- Named watchlist containers
watchlist_items     -- Tickers in watchlists
positions           -- Portfolio positions (CSP, CC, Stock)
settings            -- App configuration

-- Cache tables (ephemeral)
market_cache        -- Screened fundamentals (24h TTL)
historical_financials -- Quarterly/annual data
historical_prices   -- OHLCV daily bars

-- Job tracking (pipeline state)
job_runs            -- Screener/analysis runs
job_progress        -- Per-ticker progress
```

**Rationale**: Single SQLite file simplifies deployment. Cache tables have aggressive TTLs to manage size. job_runs enables resume capability.

**Alternative**: PostgreSQL. Not chosen because single-user desktop app doesn't need server infrastructure.

### 4. State Management

#### Zustand Stores

| Store | Responsibility | Persistence |
|-------|---------------|-------------|
| `useAppStore` | Navigation, global UI state | No |
| `useWatchlistStore` | Watchlists, tickers, quotes | SQLite |
| `useScreenerStore` | Screen runs, results, filters | SQLite |
| `useAnalysisStore` | Analysis state, selected ticker | No |
| `usePortfolioStore` | Positions, alerts | SQLite |
| `useNotificationStore` | Toast notifications | No |

**Pattern**: Each store maps to a domain. Async operations (fetch/save) use services that invoke Rust commands.

### 5. Service Layer Pattern

```typescript
// Frontend services wrap Tauri commands
export const historicalService = {
  // Direct database query
  getFinancials: async (ticker) => 
    invoke('get_historical_financials', { ticker }),
  
  // Auto-fetch from API if not cached
  fetchAndStoreFinancials: async (ticker) => 
    invoke('fetch_and_store_historical_financials', { ticker }),
  
  // Business logic (growth calculations)
  calculateGrowthRates: (financials) => { ... }
};
```

**Benefits**: Centralized API access, business logic reusable across components, easy to mock for tests.

## Component Architecture

### View Structure
```
App.tsx
├── Sidebar (navigation)
├── WatchlistView
│   ├── WatchlistList
│   ├── WatchlistItems (table with fundamentals)
│   └── QuoteCards
├── ScreenerView
│   ├── FilterPanel
│   ├── ResultsTable
│   └── ProgressBar
├── AnalysisView
│   ├── AnalysisHeader
│   ├── ValuationCards
│   ├── StrategyCard
│   ├── HistoricalFinancialChart
│   ├── HistoricalPriceChart
│   └── RealtimePriceTicker
├── PortfolioView
│   ├── PositionsTable
│   └── AlertPanel
├── MorningBriefingView
│   ├── MarketRegimeCard
│   └── ActionItemsList
└── SettingsView
```

### Chart Components

**HistoricalFinancialChart**: Area chart showing quarterly/annual metrics
- Data source: SQLite (with auto-fetch fallback)
- Export: CSV, PDF
- Props: `ticker`, `periodType`, `metric`, `height`

**HistoricalPriceChart**: Price chart with moving averages
- Data source: SQLite (with auto-fetch fallback)
- Export: CSV, PDF
- Overlay: 50-day MA

**Pattern**: Charts use Recharts ResponsiveContainer for auto-sizing. Data fetching happens in useEffect with loading/error states.

## Key Implementation Details

### Rate Limiting (TokenBucket)

```rust
pub struct RateLimiter {
    tokens: f64,           // Available tokens
    last_update: Instant,  // Last token addition
    rate: f64,           // Tokens per second
    max_tokens: f64,     // Bucket capacity
}
```

**Auto-throttle**: On HTTP 429, rate halves, exponential backoff 5min, gradual ramp-up.

**Configuration**: Default 100 req/min, user-adjustable 10-500 in Settings.

### Financial Calculations

All derived from raw Polygon XBRL data:

| Metric | Formula | Source |
|--------|---------|--------|
| P/E | Price / EPS | income_statement.basic_earnings_per_share |
| ROE | Net Income / Equity | income_statement.net_income_loss / balance_sheet.equity |
| D/E | Total Debt / Equity | balance_sheet.liabilities / balance_sheet.equity |
| FCF Yield | FCF / Market Cap | cash_flow / (price * shares_outstanding) |

**Note**: Computed in Rust, cached in SQLite, recalculated on fresh fetch.

### WebSocket Streaming

**Endpoint**: `wss://delayed.polygon.io/stocks`

**Messages Handled**:
- `T` - Trade updates (price, size, timestamp)
- `A` - Aggregate updates (OHLCV)
- `O` - Options trades (for Options Starter subscription)
- `status` - Connection status
- `error` - Error messages

**Reconnection**: Exponential backoff (3s, 6s, 12s, 24s, 48s), max 5 attempts.

### Error Handling

**Three-Tier Logging**:
1. **API Call Logs**: `src-tauri/calllogs/api_calls.log.{date}` - JSON Lines
2. **Error Logs**: `src-tauri/errorlogs/errors.log.{date}` - Structured errors
3. **UI Toasts**: User-facing error messages

**Classification**:
- WARNING: Recoverable, run continues
- ERROR: Operation aborted, app survives
- FATAL: App must restart

## Testing Strategy

### Frontend Tests (Vitest)

| Component | Test Coverage |
|-----------|---------------|
| historicalService | store/get/fetch methods, calculations |
| HistoricalCharts | loading, error, data states |
| exportService | CSV generation, PDF export |

**Pattern**: Mock Tauri `invoke` calls, test business logic, verify UI states.

### Rust Tests (Cargo)

| Module | Test Coverage |
|--------|---------------|
| historical commands | Struct creation, mapping functions |
| rate_limiter | Token bucket math |
| polygon provider | URL construction, response parsing |

**Pattern**: Unit tests for pure functions, integration tests for data flow.

### Test Commands

```bash
# Frontend
npm test                # Run all Vitest tests
npm run test:watch      # Watch mode

# Rust
cd src-tauri && cargo test  # Run all Rust tests
cargo test historical       # Filter tests

# Type checking
npx tsc --noEmit        # TypeScript

# Linting
npm run lint            # ESLint
cargo clippy            # Rust linting
```

## Build & Deployment

### Development

```bash
npm install            # Install JS dependencies
cd src-tauri && cargo build  # Build Rust
npm run tauri dev      # Start dev server
```

### Production Build

```bash
npm run tauri build    # Build for current platform
# Output: src-tauri/target/release/bundle/
```

### Platform-Specific Notes

**Windows**:
- Requires Visual Studio Build Tools
- SQLite bundled with app

**macOS**:
- Xcode Command Line Tools
- Notarized for distribution

## Performance Considerations

### Current Optimizations
- Rate limiting prevents API throttling
- Producer/consumer pipeline maximizes throughput
- SQLite indexes on frequently queried columns
- Recharts virtualization for large datasets

### Known Bottlenecks
- Historical data fetch for 1Y of daily bars: ~1-2s per ticker
- Full Russell 1000 screen: ~90s at default rate
- WebSocket reconnection: 3-48s depending on attempt

### Monitoring
- API call latency logged to `calllogs/`
- Database size shown in Settings → Diagnostics
- Cache hit rate tracked (planned for v0.2)

## Security Architecture

### API Key Storage
1. Primary: OS keychain (via Tauri plugin)
2. Fallback: `.env` file (gitignored)
3. Runtime: Never logged, redacted in API call logs

### Data Privacy
- All data stays local (SQLite, logs)
- No telemetry sent off-device
- Export functionality user-initiated only

### Rust Memory Safety
- All financial calculations in safe Rust
- SQLite parameterized queries (no SQL injection)
- No unsafe blocks in application code

## Future Technical Considerations

### Potential Improvements

1. **Web Workers**: Move heavy frontend calculations off main thread
2. **IndexedDB**: Larger client-side cache for historical data
3. **WebAssembly**: Port financial calculations from Rust to WASM for browser version
4. **GraphQL**: If adding more data providers, unified query layer
5. **Tauri v2**: Upgrade when stable for mobile support

### Deprecated/Churn Risk
- Polygon vX API (may change)
- Recharts (consider Victory or lightweight-charts if performance issues)
- Zustand (stable, but watch for v5 breaking changes)

## External Dependencies

### Critical (Hard to Replace)
- Tauri: Core framework
- Polygon: Sole data provider
- SQLite: Database engine

### Swappable (Interface-based)
- Recharts → Any React charting library
- Zustand → Redux, Jotai, Recoil
- Tailwind → CSS Modules, Styled Components

## Documentation References

- **API Docs**: https://polygon.io/docs
- **Tauri**: https://tauri.app/v1/guides/
- **Rust Book**: https://doc.rust-lang.org/book/
- **Recharts**: https://recharts.org/en-US

---

**Last Updated**: 2026-05-05  
**Version**: 0.1.6  
**Architecture Version**: 1.0 (Stable)
