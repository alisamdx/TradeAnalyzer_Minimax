# Future Feature Ideas

## Top 3

### 1. Multi-leg Strategy Builder

**Problem:** Analysis modes only evaluate single-leg strategies (one CSP, one CC, one directional option). No way to model spreads, iron condors, collars, or other multi-leg positions.

**Features:**
- Add legs to a strategy: Buy call @ strike X, sell call @ strike Y, same or different expiry
- Combined P&L payoff diagram showing max profit, max loss, breakeven points
- Probability of profit based on delta and IV
- Greeks aggregation across all legs (net delta, net theta, net vega)
- Pre-built templates: iron condor, bull call spread, bear put spread, collar, jade lizard, etc.
- Compare multiple strategies on the same underlying side-by-side
- Save strategy templates for reuse

**Why it matters:** Options income traders who graduate from single-leg CSP/CC need multi-leg tools to manage risk and optimize returns. The options chain data and Greeks are already being fetched — just need the composition and visualization layer.

**Leverages:** Existing `OptionsProvider`, `ETradeDataProvider`, options chain data, Greeks calculations

---

### 2. Pre-built Alert Templates

**Problem:** The alerts system exists but requires manual configuration per ticker per condition. Most traders want the same categories of alerts across all their positions/watchlist tickers — currently too tedious to set up.

**Features:**
- One-click alert templates:
  - "RSI overbought" — RSI crosses above 70 on any watchlist ticker
  - "RSI oversold" — RSI crosses below 30
  - "IV rank low" — IV rank drops below 20 (good CSP entry)
  - "IV rank high" — IV rank above 70 (good CC entry or close CSP)
  - "Earnings approaching" — earnings within 14 days on any open position or watchlist ticker
  - "Price alert" — stock crosses above/below a level (support, resistance, SMA)
  - "Assignment risk" — short option delta above 0.70 (assignment likely)
  - "Wheel opportunity" — high suitability score appears on screener
- Template applies to all watchlist tickers or selected subset
- Auto-refreshes when tickers are added/removed from watchlists
- Each template is a pre-configured set of conditions wired into the existing alert system

**Why it matters:** The analysis engine already computes RSI, IV, earnings proximity, delta, suitability scores — these just need to be wired to the alert system with sensible defaults instead of manual per-ticker setup.

**Leverages:** Existing `AnalysisService` calculations, existing `AlertsService`, existing `WatchlistService`

---

### 3. Earnings Calendar View

**Problem:** Earnings dates are fetched per-ticker during analysis but buried in individual results. No way to see all upcoming earnings across your portfolio and watchlist in one place, or plan position management around them.

**Features:**
- Calendar view (week/month) showing upcoming earnings for all watchlist and portfolio tickers
- For each earnings date, show:
  - Historical average post-earnings move (if data available)
  - IV expansion timeline (when IV typically ramps before this stock's earnings)
  - Whether you have an open position in this ticker
  - Recommended action: close/roll CSP before earnings, or sell premium into IV expansion
- Filter: show only tickers with open positions, or all watchlist tickers
- Highlight earnings that fall within DTE of any open option position
- Drag-and-drop: click an earnings date to jump to analysis or options chain for that ticker
- "Earnings avoidance" mode: flag positions that should be closed/rolled before earnings

**Why it matters:** Earnings is the #1 event that blows up CSP/CC positions. Having a centralized calendar with position overlap is critical for options income traders. The data is already being fetched — it just needs a dedicated view.

**Leverages:** Existing earnings data from `DataProvider.getEarningsCalendar()`, existing portfolio positions, existing watchlists

---

## Other Ideas

### 4. Wheel Cycle Tracker

Link individual CSP and CC positions into complete wheel cycles. Show total premium collected across the cycle, days in cycle, true annualized return. Visual cycle progress: CSP → assigned → CC → called away → restart. Measure and compare wheel performance across underlyings.

---

### 5. Income Dashboard (Monthly Premium Tracker)

Aggregate view of options premium income by week/month. Calendar heatmap of premium collected. Which underlyings are your best income producers. Average monthly premium trend. Projections based on open positions. Think "rent roll for options traders" — am I on track to beat last month?

---

### 6. Trade Journal with Post-Mortem

Record your thesis when entering a position — why you chose this ticker, this strike, this DTE. Rate conviction level. On exit, score how it went vs. thesis. Over time, surface patterns: "you lose money on earnings-week trades", "your best returns come from IV rank > 50". Searchable archive of past decisions.

---

### 7. Risk Dashboard (Concentration & Exposure)

Portfolio-level risk view: sector concentration pie chart, beta-weighted exposure, correlation matrix of top holdings, max drawdown scenario (what if everything drops 5%). Pairs naturally with E*Trade sync since you'd have real position sizes and allocations.

---

### 8. Paper Trading Mode

Test analysis recommendations and strategies without real capital. Simulated positions that track real prices. Compare paper portfolio performance vs. real portfolio. Useful for validating new strategies before committing capital.

---

### 9. Dividend Tracker

Track dividend income across positions. Show yield on cost, ex-div dates, payment dates. Total dividend income by month/year. Useful for wheel traders since assigned stock positions generate dividends as a second income stream.

---

### 10. Performance Attribution

Break down P&L by strategy type (CSP vs CC vs stock), by underlying, by sector, by DTE range at entry, by IV rank at entry. Surface which dimensions of your trading are actually profitable. "Your 30-DTE CSPs on tech stocks have 78% win rate but your 14-DTE CSPs on financials are net negative."