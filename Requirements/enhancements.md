# TradeAnalyzer — Enhancement Recommendations
_Assessed: 2026-05-30 | App version: v0.15.0_

---

## Context

The goal of the app is to **make money trading options and swing trades in 1–2 month timeframes** — finding the right opportunity out of all the noise using math and science. This document captures a prioritized set of enhancements identified after reviewing the full build state.

---

## Current State Summary

The app has solid infrastructure: screener → analysis → options chain → payoff visualizer → portfolio tracker → morning briefing. The pipeline from "scan the universe" to "evaluate a specific setup" is mostly complete. Five analysis modes cover the strategy space. LEAPS+CSP screener adds a multi-leg screener layer. E*Trade dual-provider adds real options chain data.

**The core gap:** the app finds candidates well but does not help the user decide _when_ to pull the trigger or _when_ to exit. For 1–2 month premium-selling trades (wheel, CSP, spreads), the math is well understood — the hard part is discipline around entry conditions and trade management.

---

## Enhancements (Prioritized)

### ENH-1 — Fix IV Rank (Critical, Foundational)

**Problem:** IV rank and IV percentile are null from Polygon's snapshot endpoint. The screener, LEAPS+CSP screener, and wheel suitability scores all depend on IV rank — when it's null, they are working blind on the single most important variable for premium selling.

**Why it matters for P&L:** You should never sell a CSP or CC when IV rank is below ~30–40. The market is underpaying for premium. Without IV rank, you cannot enforce this rule programmatically.

**Research findings (2026-05-30):** Evaluated E*Trade (`/v1/market/quote?detailFlag=ALL`), Tradier, MarketData.app, and Seeking Alpha. No brokerage or standard market data API pre-computes IV rank — all return raw per-contract IV only. Specialized volatility providers (ORATS, iVolatility) have it pre-computed but cost $50–100/month. Decision: build it from real options data using MarketData.app as the historical source.

**Chosen solution — build from real IV data (not HV proxy):**
- Compute true IV rank from 252 days of daily 30-day constant-maturity ATM implied volatility
- Store in a new `iv_history` SQLite table (one row per ticker per trading day)
- Initial 252-day backfill: MarketData.app Trader trial (100k credits/day)
- Ongoing gap fills: MarketData.app Starter subscription ($12/month, 10k credits/day)
- Daily auto-capture: whenever the app fetches an options chain via E*Trade, silently store today's IV reading (no additional API call)
- Full design specification: `Requirements/iv-history-design.md`

**Formula:**
```
IV Rank       = (current_iv − min_iv_252d) / (max_iv_252d − min_iv_252d) × 100
IV Percentile = count(days where iv < current_iv) / total_days × 100
```

**Scope:** new `013_iv_history.sql`, new `marketdata-provider.ts`, new `iv-history-service.ts`, new `ipc-iv-history.ts`, new `IvHistoryView.tsx`, Settings (MarketData.app token), screener + analysis + validate + LEAPS+CSP views (consume iv rank/percentile)

---

### ENH-2 — "Best Setups Right Now" Opportunity Dashboard (High Impact)

**Problem:** The current workflow is: run screener → run analysis → dig into individual tickers → open chain → build payoff. Too much friction between scan and action.

**Why it matters for P&L:** Decision speed and discipline. The faster you can go from "market opens" to "here are today's top trades", the better you'll execute on setups before conditions change.

**Proposed solution:**
- New view: `OpportunityView` — a single ranked table of today's top setups
- Composite **Opportunity Score** (0–100) combining:
  - Screener fundamentals score (weight: 25%)
  - IV rank relative to strategy (weight: 30%) — high IV rank favors premium selling; low favors buying
  - Technical setup quality from analysis engine (weight: 25%)
  - Premium yield / annualized return (weight: 20%)
- Secondary flags per row: earnings within DTE window (risk flag), sector concentration, days since last screener run
- One-click drill-in to full analysis / options chain / payoff diagram
- Configurable strategy mode filter (Wheel / CSP / Spreads / Bullish swing / Bearish swing)
- Auto-refreshes on app open; manual refresh button

**Scope:** New `opportunity-service.ts`, new `OpportunityView.tsx`, sidebar tab

---

### ENH-3 — Portfolio Greeks Monitor (High Daily Utility)

**Problem:** The portfolio tracker shows individual positions and P&L but not aggregate Greeks exposure. For a premium-selling portfolio, aggregate theta and delta are the most important daily numbers.

**Why it matters for P&L:** Theta is your daily income — you need to know if you're on track to hit your target. Net delta tells you if you're accidentally directionally overexposed. Both are required for active portfolio management.

**Proposed solution:**
- Add a summary bar or card row at the top of `PortfolioView`:
  - **Total Theta / day** (sum of position thetas × 100 contracts)
  - **Net Delta** (sum of signed deltas — long stock positive, short put negative, etc.)
  - **Total Vega** (aggregate volatility exposure)
  - **BP Used** (buying power in use as % of configured account size)
  - **Expirations in next 7 / 14 / 21 days** (count of positions, color-coded urgency)
- Fetch current Greeks for open positions via options chain on portfolio load (cached, 5min TTL)
- Add account size to Settings (used for BP% calculation)

**Scope:** `portfolio-service.ts`, `PortfolioView.tsx`, `settings`

---

### ENH-4 — Earnings Calendar (Risk Management)

**Problem:** `getEarningsCalendar` returns null — Polygon has no public earnings calendar endpoint. For 1–2 month options trades, an earnings date inside the DTE window is a significant risk event that can invalidate an otherwise sound setup.

**Why it matters for P&L:** Getting surprised by earnings while short a put or holding a spread is a common source of unexpected losses. Knowing earnings dates in advance allows you to avoid or deliberately structure around them.

**Proposed solution (pragmatic):**
- Option A (preferred): Integrate a free earnings calendar source (e.g., scrape a single public page on earnings-whispers.com or use the Alpha Vantage earnings endpoint — one fetch per ticker, cached 24h)
- Option B (fallback): Manual earnings date entry per ticker in the watchlist and portfolio views — a simple date input that stores in SQLite
- Surface earnings dates in:
  - Analysis view (prominent warning if earnings within DTE window of selected expiration)
  - LEAPS+CSP screener (existing caution flag, currently unable to populate)
  - Opportunity dashboard (ENH-2 risk flag)
  - Portfolio view (flag positions where earnings fall before expiration)

**Scope:** New `earnings-service.ts`, update `DataProvider` interface, update `AnalysisView`, `LeapsCspView`, `PortfolioView`

---

### ENH-5 — Trade Management Alerts: 50% Profit & 21 DTE Rules (Closes the Loop)

**Problem:** The alerts system exists but is price-level based. Premium-selling strategies have well-defined, rules-based exit triggers that should be automated: exit at 50% max profit, manage positions at 21 DTE, roll when delta drifts beyond threshold.

**Why it matters for P&L:** The tastytrade research shows that closing at 50% max profit significantly improves risk-adjusted returns over holding to expiration. Automating these checks removes the emotional component and ensures the rules are followed consistently.

**Proposed solution:**
- Extend `AlertsService` with position-based alert types:
  - **50% Profit**: trigger when `(current premium - entry premium) / entry premium ≥ 0.50`
  - **21 DTE**: trigger when days to expiration ≤ 21 and position is still open
  - **Delta Drift**: trigger when current delta exceeds a configured threshold (e.g., short put delta > 0.40 when opened at 0.30)
  - **10x Loss**: trigger when loss exceeds 2× the original premium collected (max pain rule)
- Alerts appear in the morning briefing "Action Items" section and optionally as desktop notifications
- Each alert links directly to the position in `PortfolioView`
- Alert thresholds configurable per-position and globally in Settings

**Scope:** `alerts-service.ts`, `portfolio-service.ts`, `BriefingView`, `PortfolioView`, Settings

---

## Deferred / Lower Priority

| Idea | Reason to Defer |
|------|----------------|
| More screener filters | Existing 17 filters cover the strategy space; adding more increases noise |
| Unusual options activity screener | Hard to distinguish signal from market-maker hedging without additional context |
| Additional analysis modes | 5 existing modes cover the strategy space (buy, income, wheel, bullish, bearish) |
| Broker execution (order placement) | Out of scope for v1; E*Trade integration is read-only by design |

---

## Suggested Implementation Order

1. **ENH-1** — IV Rank computation (small, foundational, fixes broken data that other features depend on)
2. **ENH-2** — Opportunity dashboard (high visibility, directly drives daily trade decisions)
3. **ENH-3** — Portfolio Greeks monitor (small UI addition, high daily utility)
4. **ENH-4** — Earnings calendar (even manual entry is better than null)
5. **ENH-5** — Trade management alerts (closes the entry→exit loop)

---

_This document supplements `REQUIREMENTS.md`. Each enhancement should be implemented as a versioned release following the conventions in `CLAUDE.md` and `.ai/AI_PROMPT.md`._
