# TradeAnalyzer Functional Improvements Todo

> Keeping current Electron + better-sqlite3 + lightweight-charts stack. Based on latest REQUIREMENT.md from Version2/New.

---

## Priority 1: Cache Management System (Foundation) ✅ COMPLETE

**Database Migration:**
- [x] Create `004_cache_management.sql` with `cache_metadata` table

**Backend (Main Process):**
- [x] Create `CacheManager` service to track cache staleness
- [x] Add cache status check on app startup (emit `cache-stale` if > 1 hour)
- [x] Create IPC handlers: `cache:getStatus`, `cache:refresh`, `cache:updateLastRun`

**Frontend:**
- [x] Build `CacheStatusIndicator` component (Green=Fresh, Red=Stale, with timestamp)
- [x] Create `useCacheStatus` hook (polls every 5 minutes)
- [x] Add cache indicator to WatchlistView and ScreenerView headers
- [x] Add "Refresh All Data" button in Watchlist view
- [x] Implement auto-refresh trigger when stale data detected

---

## Priority 2: Watchlist Wheel Columns (High Value) ✅ COMPLETE

**Backend:**
- [x] Update quote fetching to include Wheel Suitability Score calculation
- [x] Formula: `Score = ROE*30% + D/E_Quality*30% + MarketCap*20% + Stability*25%`
- [x] Calculate Target Strike: `Current Price × 0.92` (8% OTM)
- [x] Calculate Est. Premium: `Strike × 1.2%` (30 DTE approximation)
- [x] Update `Quote` type and cache to include new fields

**Frontend:**
- [x] Add columns to Watchlist table:
  - Wheel Suitability (0-100 score with color coding)
  - Target Strike
  - Est. Premium
- [x] Make all watchlist columns sortable using `useSortable` hook
- [x] Add column headers with sort indicators (asc/desc arrows)

---

## Priority 3: Real-Time Price Streaming (Critical) ✅ COMPLETE

**Backend:**
- [x] Add WebSocket service in main process to connect to `wss://delayed.polygon.io/stocks`
- [x] Implement message handlers: `T` (Trade), `A` (Aggregate)
- [x] Implement reconnection logic (exponential backoff: 3s, 6s, 12s, 24s, 48s)
- [x] Create IPC handlers: `websocket:subscribe`, `websocket:unsubscribe`
- [x] Auto-subscribe to tickers when watchlist becomes active

**Frontend:**
- [x] Build `RealtimePriceTicker` banner component for Analysis view
- [x] Update watchlist table with live price updates (green/red color coding)
- [x] Add connection status indicator in status bar

---

## Priority 4: Historical Charts (High Value) ✅ COMPLETE

**Database Migration:**
- [x] Create `005_historical_data.sql` with:
  - `historical_financials` table (quarterly/annual metrics)
  - `historical_prices` table (OHLCV daily bars)

**Backend:**
- [x] Add IPC handlers:
  - `historical:getFinancials` - Get quarterly/annual data
  - `historical:getPrices` - Get OHLCV bars
  - `historical:fetchAndStore` - Auto-fetch if cache empty
- [x] Implement Polygon aggregates API fetching

**Frontend:**
- [x] Install Recharts: `npm install recharts`
- [x] Build `HistoricalFinancialChart` component:
  - Area chart for financial metrics
  - Metrics: Revenue, Net Income, EPS, EBITDA, Total Assets, Shareholder Equity
  - Period type selector (Quarterly/Annual)
  - CSV export button
- [x] Build `HistoricalPriceChart` component:
  - Line/candlestick chart with volume
  - Timeframe selector: 1M, 3M, 6M, 1Y, 2Y, 5Y
  - 50-day SMA overlay
  - CSV export button
- [x] Integrate into Analysis view

---

## Priority 5: Screener Enhancements (High Value) ✅ COMPLETE

**Frontend:**
- [x] Add sortable columns to Screener results table (all columns, asc/desc toggle)
- [x] Add `useSortable` hook implementation
- [x] Add "Quick Actions" in results row:
  - Add to watchlist button
  - Run analysis button
- [x] Add CSV export of filtered results
- [x] Add pagination (50 items per page)
- [x] Add cache status indicator to Screener header
- [x] Add auto-refresh if data > 1 hour old

---

## Priority 6: Portfolio Tracking (Critical) ✅ COMPLETE

**Database Migration:**
- [x] Create `006_portfolio.sql` with `positions` table:
  - Position types: CSP, CC, Stock
  - Entry/exit price, quantity, dates
  - Strike, expiration for options

**Backend:**
- [x] Build position management IPC handlers:
  - `portfolio:add` - Add new position
  - `portfolio:list` - List all positions
  - `portfolio:update` - Edit position
  - `portfolio:close` - Mark as closed
  - `portfolio:pnl` - Get P&L calculations

**Frontend:**
- [x] Add `PortfolioView` to sidebar navigation
- [x] Create add position form (ticker, type, entry price, quantity, date, strike/expiration)
- [x] Build positions table with tabs: Open / Closed
- [x] Implement P&L calculations:
  - Unrealized P&L: `(currentPrice - entryPrice) × quantity`
  - Realized P&L: `(exitPrice - entryPrice) × quantity + premium`
  - Annualized Return: `((realizedPnl / capital) × (365 / daysHeld)) × 100`
- [x] P&L summary cards (total unrealized, total realized, win rate %)

---

## Priority 7: Morning Briefing Dashboard (High Value) ✅ COMPLETE

**Backend:**
- [x] Implement market regime detection:
  - Fetch SPY data, calculate 20-day and 50-day SMA
  - Determine trend: Bullish (Price > 20MA > 50MA), Bearish, Neutral
  - Fetch VIX, classify: Low (<15), Normal (15-25), High (>25)
- [x] Generate action items:
  - Query positions expiring within 5 days
  - Query positions with delta > |0.40|
  - Earnings in next 7 days (if data available)
- [x] Query top setups (15 quality stocks):
  - Criteria: ROE > 15%, D/E < 1.0, Market Cap > $10B, FCF Yield > 0%
  - Include Wheel columns: Suitability Score, Target Strike, Est. Premium

**Frontend:**
- [x] Add `BriefingView` to sidebar navigation
- [x] Build `MarketRegimeCard`:
  - SPY Trend Badge (Bullish/Bearish/Neutral)
  - VIX Level Badge (Low/Normal/High)
  - Regime summary text
- [x] Build `ActionItemsList`:
  - Expiring This Week
  - Delta Breach Alerts
  - Earnings Alerts
- [x] Build `TopSetupsTable` (15 rows with sortable columns):
  - Ticker, ROE, P/E, D/E, Wheel Score, Target Strike, Est. Premium
- [x] Auto-refresh briefing on app open

---

## Priority 8: Alerts System (Medium Value) ✅ COMPLETE

**Database Migration:**
- [x] Create `007_alerts.sql` with `alerts` table:
  - Alert types: price, expiration, delta
  - Threshold values
  - Triggered status

**Backend:**
- [x] Add alert checking via WebSocket price updates
- [x] Create IPC handlers:
  - `alerts:create` - Create new alert
  - `alerts:list` - List active alerts
  - `alerts:delete` - Remove alert
  - `alerts:markTriggered` - Mark alert as triggered

**Frontend:**
- [x] Alert types supported:
  - Price alerts (target price hit above/below)
  - Position alerts (expiration warnings, delta breaches)
- [x] Toast notification system for triggered alerts (deferred to Settings phase)

---

## Priority 9: Settings Enhancements (Nice to Have)

- [ ] Add sound alerts on/off setting
- [ ] Add auto-connect WebSocket on startup setting
- [ ] Add default screener index preference
- [ ] Add theme setting (dark/light toggle)
- [ ] Add keyboard shortcut configuration

---

## Implementation Roadmap

| Phase | Features | Est. Time | Priority |
|-------|----------|-----------|----------|
| **1** | Cache Management System | 2-3 days | Foundation |
| **2** | Watchlist Wheel Columns | 2-3 days | High |
| **3** | Real-time WebSocket | 3-4 days | Critical |
| **4** | Historical Charts | 4-5 days | High |
| **5** | Screener Enhancements | 2-3 days | High |
| **6** | Portfolio Tracking | 5-6 days | Critical |
| **7** | Morning Briefing | 3-4 days | High |
| **8** | Alerts System | 2-3 days | Medium |
| **9** | Settings Polish | 1-2 days | Low |

**Total: ~4-5 weeks for full feature parity**

---

## Key New Features (vs Previous Analysis)

1. **Cache Management** - Staleness tracking, auto-refresh, visual indicators
2. **Wheel Columns** - Suitability Score, Target Strike, Est. Premium in watchlist
3. **Top Setups** - 15 quality stocks in Morning Briefing with wheel metrics
4. **Chart Export** - CSV/PDF export for historical charts
5. **Sortable Columns** - All tables (watchlist, screener, top setups)
6. **Custom Hooks** - `useSortable`, `useCacheStatus`
7. **Recharts** - For historical financial/price charts

---

*Last updated: 2026-05-05*
