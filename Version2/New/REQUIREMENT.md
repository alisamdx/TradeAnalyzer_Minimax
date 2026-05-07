# REQUIREMENT.md - TradeAnalyzer_Gemini Functional Requirements

> **Complete functional specification** covering Phases 1-6 and all enhancements.

---

## 1. Overview

### 1.1 Purpose
TradeAnalyzer_Gemini is a single-user desktop application for retail options and swing traders. It provides comprehensive analysis tools for identifying trade opportunities, managing watchlists, tracking portfolio positions, and delivering actionable market intelligence.

### 1.2 Target User
- Retail trader with options experience (CSP, CC, Wheel strategies)
- Polygon.io Options Starter + Stocks Starter subscriber
- Prefers local data storage over cloud-based platforms
- Values speed and privacy in trading tools

### 1.3 Success Criteria
- Screen S&P 500 or Russell 1000 in under 2 minutes
- Real-time price updates with <500ms latency
- Analysis calculations complete in <3 seconds
- Zero data loss on app restart (persistent state)

---

## 2. Core Features

### 2.1 Watchlist Management

#### FR-2.1.1 Watchlist CRUD
- **Create**: User can create named watchlists (max 50 chars, alphanumeric + spaces)
- **Read**: Display all watchlists in sidebar with item count badges
- **Update**: Rename watchlists in-place
- **Delete**: Remove watchlist with confirmation dialog; items cascade delete

#### FR-2.1.2 Ticker Management
- **Add**: Enter ticker symbol, validate against Polygon, store with metadata
- **Remove**: Delete ticker from watchlist
- **Reorder**: Drag-and-drop or up/down arrows to reorder
- **Duplicate Prevention**: Prevent adding same ticker twice to one watchlist

#### FR-2.1.3 Quote Display
- **Real-time Prices**: WebSocket streaming for all tickers in active watchlist
- **Fundamentals**: Display P/E, Market Cap, ROE, Debt/Equity from cached data
- **Change Indicators**: Green/red for price changes, percentage display
- **Last Updated**: Timestamp of most recent data
- **Wheel Columns**: Wheel Suitability Score, Target Strike, Estimated Premium
- **Sortable Columns**: Click any column header to sort (ascending/descending)

### 2.2 Index Screener

#### FR-2.2.1 Index Selection
- **S&P 500**: Screen all 500 constituents
- **Russell 1000**: Screen largest 1000 US companies
- **Custom**: Upload CSV of tickers (optional enhancement)

#### FR-2.2.2 Filtering Criteria
| Filter | Type | Default | Range |
|--------|------|---------|-------|
| P/E Ratio | Range | 5-25 | 0-100 |
| Market Cap | Min | 1B | 0-1000B |
| ROE | Min | 10% | -50% to 100% |
| Debt/Equity | Max | 1.0 | 0-5.0 |
| FCF Yield | Min | 5% | -20% to 50% |

#### FR-2.2.3 Wheel Strategy Columns
| Column | Description | Calculation |
|--------|-------------|-------------|
| Wheel Suitability | 0-100 score for Wheel strategy | ROE (30%) + D/E quality (30%) + Market Cap (20%) + Stability (25%) |
| Target Strike | Suggested put strike price | Current price * 0.92 (8% OTM) |
| Est. Premium | Estimated monthly premium | Strike * 1.2% (30 DTE) |

#### FR-2.2.3 Pipeline Execution
- **Producer**: Fetch ticker details from Polygon API with rate limiting
- **Queue**: Buffer raw responses between fetch and persist
- **Consumer**: Parse XBRL, compute ratios, write to SQLite
- **Progress Tracking**: Real-time progress bar with tickers processed/remaining
- **Resume Capability**: Track completed tickers in job_runs table; allow restart
- **Cancellation**: User can cancel mid-run with graceful shutdown

#### FR-2.2.4 Results Display
- **Sortable Columns**: Click header to sort by any metric (asc/desc toggle)
- **Pagination**: 50 items per page (optional: infinite scroll)
- **Export**: CSV export of filtered results
- **Quick Actions**: Add to watchlist, run analysis from results row
- **Cache Status Indicator**: Shows last update time and staleness
- **Auto-Refresh**: Automatic background refresh if data > 1 hour old

### 2.3 Multi-Mode Analysis

#### FR-2.3.1 Valuation Analysis
- **Fair Value Calculation**: Based on discounted cash flow and comparable multiples
- **Buy Zone**: Support level minus 1-2 ATR bands
- **Margin of Safety**: (Fair Value - Current Price) / Fair Value * 100
- **Rating**: BUY ZONE (price < buy zone), FAIR VALUE (in range), OVERVALUED (above)

#### FR-2.3.2 Wheel Strategy Analysis
- **Suitability Score**: 0-100 based on:
  - Liquidity (30%): Daily dollar volume
  - IV Rank (25%): Current IV vs 52-week range
  - Fundamentals (25%): P/E, D/E, ROE quality
  - Trend (20%): Price vs moving averages
- **Recommendation**: EXCELLENT (80+), GOOD (60-79), FAIR (40-59), POOR (<40)
- **Minimum Requirements**: Reject if Market Cap < 500M or Avg Volume < 1M

#### FR-2.3.3 Income Strategy (Cash-Secured Put)
- **Target Strike**: Support level or 30-45 delta put strike
- **Expiration**: 30-45 DTE (configurable)
- **Annualized Return**: (Premium / Strike) * (365 / DTE) * 100
- **Estimated Premium**: Based on current IV and strike distance
- **Delta Approximation**: Probability of assignment proxy

#### FR-2.3.4 Analysis Insights
- **AI Suggestions**: 3-5 bullet points summarizing key opportunities/risks
- **Risk Warning**: Mandatory options risk disclosure
- **Strategy Explanation**: Plain English description of recommended trade

### 2.4 Historical Data Analysis

#### FR-2.4.1 Financial Data
- **Period Types**: Quarterly, Annual
- **Metrics Available**:
  - Revenue (total_revenues)
  - Net Income (net_income_loss)
  - EPS (basic_earnings_per_share)
  - EBITDA (comprehensive_income_loss)
  - Total Assets
  - Shareholder Equity
- **Auto-Fetch**: If local cache empty, automatically fetch from Polygon
- **Storage**: SQLite with 24-hour TTL, then stale flag

#### FR-2.4.2 Price Data
- **Periods**: 1M, 3M, 6M, 1Y, 2Y, 5Y
- **OHLCV Bars**: Daily resolution
- **Moving Average**: 50-day SMA overlay (configurable)
- **Auto-Fetch**: Same pattern as financials

#### FR-2.4.3 Chart Display
- **HistoricalFinancialChart**: Area chart for financial metrics over time
- **HistoricalPriceChart**: Line/area chart with volume and MA overlay
- **Interactive**: Zoom, pan, tooltip on hover
- **Export**: CSV and PDF export buttons on each chart

### 2.5 Real-Time Streaming

#### FR-2.5.1 WebSocket Connection
- **Endpoint**: wss://delayed.polygon.io/stocks
- **Authentication**: API key from settings on connect
- **Auto-Connect**: On app start if key configured
- **Reconnection**: Exponential backoff (3s, 6s, 12s, 24s, 48s), max 5 attempts

#### FR-2.5.2 Trade Handling
- **Message Types**:
  - T (Trade): Price, size, timestamp, conditions
  - A (Aggregate): OHLCV for interval
  - O (Options): Option symbol, price, size, underlying
- **Deduplication**: Handle out-of-order messages by timestamp
- **Batching**: Update UI every 100ms max to prevent thrashing

#### FR-2.5.3 UI Updates
- **RealtimePriceTicker**: Banner showing current price, change, change %
- **Color Coding**: Green for up, red for down, neutral for unchanged
- **Watchlist Updates**: Live price column in watchlist tables

### 2.6 Portfolio Tracking

#### FR-2.6.1 Position Management
- **Position Types**: Cash-Secured Put (CSP), Covered Call (CC), Stock
- **Add Position**: Form with ticker, type, entry price, quantity, date, strike (for options)
- **Edit Position**: Update any field, recalculate P&L
- **Close Position**: Mark as closed with exit price/date, archive to history

#### FR-2.6.2 P&L Calculation
- **Unrealized P&L**: Current price vs entry for open positions
- **Realized P&L**: Actual profit/loss on closed positions
- **Annualized Return**: Time-weighted return calculation
- **Total Portfolio**: Sum across all positions

#### FR-2.6.3 Alerts
- **Price Alerts**: Notify when ticker hits target price
- **Expiration Alerts**: Warning 7 days before option expiration
- **Delta Alerts**: Notify if option delta exceeds threshold
- **Notification**: Toast messages in UI + optional sound

### 2.7 Morning Briefing

#### FR-2.7.1 Market Regime Detection
- **SPY Trend**: Price vs 20-day and 50-day MAs
  - BULLISH: Price > 20MA > 50MA
  - BEARISH: Price < 20MA < 50MA
  - NEUTRAL: Mixed signals
- **VIX Level**: Current VIX reading
  - LOW: <15 (complacency warning)
  - NORMAL: 15-25
  - HIGH: >25 (opportunity warning)
- **Regime Summary**: Text description of current market condition

#### FR-2.7.2 Action Items
- **Expiration This Week**: List positions expiring within 5 days
- **Delta Breach**: Options with delta >|0.40| (close to ATM)
- **Earnings Alert**: Tickers in portfolio with earnings in next 7 days (if available)

#### FR-2.7.3 Top Setups
- **Quality Criteria**: ROE > 15%, D/E < 1.0, Market Cap > $10B, FCF Yield > 0%
- **Result Count**: Up to 15 top quality stocks
- **Sortable**: Click headers to sort by ROE, P/E, D/E, Wheel Score, Strike, Premium
- **Wheel Columns**: Wheel Suitability Score, Target Strike, Estimated Premium
- **Source**: Cached screener data, refreshed on screener run

---

## 3. Data Management

### 3.1 Data Sources
- **Primary**: Polygon.io REST API v3
- **Streaming**: Polygon.io WebSocket (delayed for Stocks Starter)
- **Fallback**: Cached SQLite data with stale indicator

### 3.2 Rate Limiting
- **Token Bucket**: 100 req/min default, configurable 10-500
- **Auto-Throttle**: On HTTP 429, halve rate, exponential backoff
- **Ramp-Up**: Gradually restore to configured rate after cooldown
- **Queue Management**: FIFO with priority for user-facing requests

### 3.3 Caching Strategy
| Data Type | TTL | Source | Refresh |
|-----------|-----|--------|---------|
| Market Fundamentals | 1h | REST API | Auto-refresh if stale on app start |
| Historical Financials | 7d | REST API | Manual or on analysis |
| Historical Prices | 1d | REST API | Manual or on view |
| Real-time Prices | Real-time | WebSocket | Continuous |
| Job Results | Persistent | SQLite | N/A |

#### Cache Management
- **Cache Metadata Table**: Tracks last screener run timestamp
- **Auto-Refresh Trigger**: On app startup, checks if cache > 1 hour old
- **Staleness Indicator**: Visual indicator in Watchlist and Screener views
- **Manual Refresh**: "Refresh All Data" button in Watchlist view
- **Background Check**: Every 5 minutes via `useCacheStatus` hook

### 3.4 Data Export
- **CSV**: All tables exportable with headers
- **PDF**: Chart screenshots via jsPDF
- **Path**: User-selectable, defaults to Downloads

---

## 4. User Interface

### 4.1 Layout
- **Sidebar**: Navigation between views, watchlist selector
- **Main Content**: Context-aware view (Watchlist, Screener, Analysis, Portfolio, Briefing)
- **Status Bar**: Connection status, rate limit status, last update time
- **Notifications**: Toast messages for actions, errors, alerts

### 4.2 Views
| View | Purpose | Key Components |
|------|---------|----------------|
| Watchlist | Manage tickers | Lists, tables, quote cards |
| Screener | Run index screens | Filters, progress bar, results table |
| Analysis | Deep-dive on ticker | Charts, valuation cards, strategy card |
| Portfolio | Track positions | Position table, P&L cards, alerts panel |
| Briefing | Daily summary | Market regime card, action items |
| Settings | Configuration | API key, rate limits, preferences |

### 4.3 Design System
- **Framework**: Tailwind CSS 3.x
- **Color Palette**:
  - Background: slate-950 (dark mode only)
  - Cards: slate-900 with slate-800 borders
  - Primary: blue-500/600
  - Success: emerald-400/500
  - Warning: amber-400/500
  - Danger: rose-400/500
- **Typography**: Sans-serif, uppercase tracking-widest for labels
- **Spacing**: Consistent 4px grid (4, 8, 12, 16, 24, 32, 48, 64)

---

## 5. Configuration

### 5.1 Settings
| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| polygon_api_key | SecureString | "" | API key from Polygon.io |
| rate_limit_requests | Number | 100 | Requests per minute |
| theme | Enum | "dark" | UI theme (dark/light) |
| notifications_enabled | Boolean | true | Toast notifications |
| sound_alerts | Boolean | false | Audio on alerts |
| auto_connect_websocket | Boolean | true | Connect on startup |
| default_index | Enum | "sp500" | Screener default index |
| cache_ttl_hours | Number | 24 | Cache expiration |

### 5.2 Environment Variables
```
POLYGON_API_KEY=your_key_here  # Fallback if not in keychain
VITE_POLYGON_API_KEY=your_key  # Dev build only
```

---

## 6. Security Requirements

### 6.1 API Key Storage
- **Primary**: OS keychain via Tauri secure storage plugin
- **Fallback**: .env file (gitignored, never committed)
- **Runtime**: Never logged, redacted in error messages

### 6.2 Data Privacy
- **Local Only**: All data stored in local SQLite
- **No Telemetry**: No usage data sent off-device
- **Export Control**: User-initiated exports only

### 6.3 Input Validation
- **SQL Injection**: Parameterized queries throughout
- **XSS Prevention**: React escaping by default
- **Path Traversal**: Validate all file paths before write

---

## 7. Performance Requirements

### 7.1 Response Times
| Operation | Target | Maximum |
|-----------|--------|---------|
| UI Interaction | 16ms | 50ms |
| Analysis Calculation | 1s | 3s |
| Chart Render | 500ms | 2s |
| Screener (100 tickers) | 60s | 120s |
| WebSocket Message | 100ms | 500ms |

### 7.2 Resource Limits
- **Memory**: <500MB RAM typical usage
- **Storage**: <1GB for 1 year of cached data
- **CPU**: Background tasks yield to UI (60fps target)

---

## 8. Error Handling

### 8.1 Error Classification
- **WARNING**: Recoverable, operation continues (e.g., single ticker fetch failed)
- **ERROR**: Operation aborted, app continues (e.g., database write failed)
- **FATAL**: App must restart (e.g., SQLite corruption)

### 8.2 User Communication
- **Toast Messages**: Brief, actionable error descriptions
- **Retry Options**: Automatic retry with backoff for API calls
- **Fallback Data**: Show stale data with visual indicator
- **Log Access**: Settings → Diagnostics to view recent errors

---

## 9. Acceptance Criteria

### 9.1 Phase 1 (Screener Pipeline)
- [ ] Can create and delete watchlists
- [ ] Can add/remove tickers from watchlist
- [ ] Can run S&P 500 screen with progress tracking
- [ ] Can cancel screener mid-run
- [ ] Can resume screener after app restart
- [ ] Results display with sortable columns

### 9.2 Phase 2 (Multi-Mode Analysis)
- [ ] Can select ticker and run full analysis
- [ ] Fair value and buy zone calculate correctly
- [ ] Wheel suitability score 0-100 displayed
- [ ] Income strategy card shows strike, return, premium
- [ ] Analysis insights provide actionable suggestions

### 9.3 Phase 3 (Historical Data)
- [ ] Historical financial chart displays quarterly data
- [ ] Historical price chart shows 1Y with 50-day MA
- [ ] Charts auto-fetch from API if cache empty
- [ ] Can export chart data to CSV
- [ ] Can export chart to PDF

### 9.4 Phase 4 (Real-Time Streaming)
- [ ] WebSocket connects on app start
- [ ] Real-time prices update in watchlist
- [ ] RealtimePriceTicker displays in Analysis view
- [ ] Reconnects automatically after disconnect
- [ ] Resubscribes to tickers on reconnect

### 9.5 Phase 5 (Portfolio & Alerts)
- [ ] Can add CSP, CC, and Stock positions
- [ ] P&L calculates correctly for open positions
- [ ] Price alerts trigger at target
- [ ] Expiration alerts show 7 days before

### 9.6 Phase 6 (Morning Briefing)
- [ ] Market regime detects trend and volatility
- [ ] Action items list expiring positions
- [ ] Opportunities from recent screens displayed
- [ ] Briefing updates on each app open

---

## 10. Future Enhancements (Out of Scope)

### 10.1 Potential Additions
- Options chain viewer with Greeks
- Paper trading integration
- Backtesting engine for strategies
- Multi-monitor support
- Mobile companion app
- Additional data providers (IEX, Alpha Vantage)

### 10.2 Nice-to-Have
- Dark/light theme toggle
- Custom chart indicators
- Watchlist sharing
- CSV import for positions
- Earnings calendar integration

---

## 11. Glossary

| Term | Definition |
|------|------------|
| **CSP** | Cash-Secured Put - selling a put option with cash reserved to buy shares if assigned |
| **CC** | Covered Call - selling a call option against owned shares |
| **Wheel** | Strategy of selling CSPs until assigned, then selling CCs on the assigned shares |
| **DTE** | Days To Expiration - time remaining until option expiration |
| **Delta** | Greek measuring price sensitivity and probability proxy |
| **IV Rank** | Implied Volatility rank within 52-week range (0-100) |
| **Buy Zone** | Computed entry range based on support and ATR |
| **ATR** | Average True Range - volatility measure |
| **XBRL** | eXtensible Business Reporting Language - financial data format |

---

**Version**: 0.1.6  
**Last Updated**: 2026-05-05  
**Requirements Status**: Complete (Phases 1-6 implemented)
