# News & Research — Feature Requirements
**TradeAnalyzer — Module: News & Research**  
Version 1.0 | June 2026

---

## 1. Overview

The News & Research module gives the trader a structured, daily-refreshed intelligence dossier for every ticker on their watchlists. Unlike a raw news feed, this module filters for *price-moving signals only*, classifies each signal as Bullish / Bearish / Neutral, and uses an AI synthesis layer to produce a concise "what matters today" summary per ticker.

A batch-run function analyzes an entire watchlist in one pass and re-sorts the ticker list by **Impact Score** — so the most actionable stocks float to the top automatically.

---

## 2. Navigation & Layout

### FR-NR-01 — Sidebar placement
The "News & Research" entry appears in the left sidebar immediately below "Screener". Clicking it navigates to the News & Research view.

### FR-NR-02 — Two-panel layout
The view is split into two panels:

```
┌──────────────────────────┐  ┌──────────────────────────────────────────────┐
│  [Watchlist ▼]           │  │  TSLA — Research Dossier                     │
│  [▶ Run Watchlist]       │  │  Last updated: today 9:15 AM  [🔄 Refresh]   │
│  Last run: today 9:15 AM │  │                                              │
│  ─────────────────────── │  │  ⚡ AI Summary  📅 Events  📰 News           │
│                          │  │                                              │
│  #  Ticker  Bias  Score  │  │  [tab content]                               │
│  1  TSLA  🔴 Bear  8.4   │  │                                              │
│  2  NVDA  🟢 Bull  7.1   │  │                                              │
│  3  AAPL  🟡 Mix   4.2   │  │                                              │
│  4  META  🟢 Bull  3.8   │  │                                              │
└──────────────────────────┘  └──────────────────────────────────────────────┘
```

- **Left panel** — watchlist selector, batch run button, ranked ticker list.
- **Right panel** — full research dossier for the selected ticker, with tabs.

### FR-NR-03 — Watchlist selector
A `<select>` dropdown at the top of the left panel lists all saved watchlists (same source as the Watchlists view). Changing the selection reloads the ticker list for the chosen watchlist.

### FR-NR-04 — Ticker list
Each row in the left panel shows:
- Rank position (after a batch run; blank if not yet ranked)
- Ticker symbol
- Bias badge: 🟢 Bull / 🔴 Bear / 🟡 Mixed (from last cached analysis)
- Impact Score (numeric, 0–10)

Clicking a row loads the ticker's dossier in the right panel.

### FR-NR-05 — Empty / unanalyzed state
Tickers with no cached analysis for today show a "–" bias and "–" score. Clicking them triggers a single-ticker fetch + synthesis on demand.

---

## 3. Caching & Refresh

### FR-NR-06 — Daily cache
Research results are persisted to SQLite in a `news_research_cache` table with a composite key of `(ticker, date)` where `date` is the local trading date (YYYY-MM-DD). Results cached on a prior date are considered stale.

### FR-NR-07 — Cache-first load
When a ticker is selected or the batch run encounters a ticker:
1. Check DB: does a valid cache row exist for today?
2. **Yes** → display cached result immediately. Show "Last updated HH:MM AM/PM" in the dossier header.
3. **No** → fetch fresh data, run AI synthesis, persist to DB, then display.

### FR-NR-08 — Manual refresh
A **🔄 Refresh** button in the dossier header forces re-fetch and re-synthesis for the selected ticker regardless of cache state. The cache row is overwritten. The "Last updated" timestamp is updated.

### FR-NR-09 — Stale indicator
If the cached result is from a prior calendar date (stale), the dossier header shows a yellow "⚠ Data from yesterday — click Refresh" banner instead of the normal timestamp.

---

## 4. Batch Run

### FR-NR-10 — Run Watchlist button
A **▶ Run Watchlist** button in the left panel header triggers a batch analysis of all tickers in the currently selected watchlist.

### FR-NR-11 — Batch fetch strategy
1. Fetch raw data for all tickers in **parallel** (subject to rate limiting — max 5 concurrent data requests).
2. Bundle all fetched data into a **single AI call** with all tickers in one prompt. This enables cross-ticker relative ranking and reduces API round-trips.
3. Persist each ticker's result to the daily cache.
4. Re-sort the left panel by Impact Score descending.
5. Auto-select the top-ranked ticker and load its dossier in the right panel.

### FR-NR-12 — Batch progress indicator
While the batch is running, show a progress indicator in the left panel header: "Analyzing 4 / 12…". Each ticker's row updates in-place as its result arrives (parallel display as results complete).

### FR-NR-13 — Batch skip cached
During a batch run, tickers that already have a valid today-cache are **skipped** (not re-fetched, not re-analyzed). Their cached score and bias are used directly for ranking. A user can override this by clicking 🔄 Refresh on any individual ticker.

### FR-NR-14 — Batch re-run
If the user clicks **▶ Run Watchlist** again after a batch has already run today, a confirmation prompt reads: "All tickers already analyzed today. Re-run and refresh all?" Confirming forces re-fetch + re-synthesis for the entire watchlist.

---

## 5. Impact Score & Ranking

### FR-NR-15 — Impact Score definition
Each ticker receives an **Impact Score** in the range 0–10, computed as a weighted sum of signal urgency:

| Signal component | Max weight | Notes |
|---|---|---|
| Earnings proximity | 3.0 | Scales 3.0→0 as DTE goes 0→30; zero weight beyond 30 days |
| Analyst rating change | 1.5 | Upgrade or downgrade within the last 7 days |
| Price target change magnitude | 1.0 | Proportional to % change from prior PT |
| Insider transaction | 1.0 | Executive buy/sell within 14 days; weighted by $ size |
| Macro event proximity | 1.0 | FOMC, CPI, PPI within 7 days |
| Regulatory / legal event | 1.5 | FDA decision, FTC review, patent ruling pending |
| Short squeeze risk | 0.5 | Short % of float > 20% |
| AI urgency override | 0.5 | Claude flags an unusual or compound risk |

The AI synthesis prompt instructs Claude to output a score in this range. The score is stored in the cache and used for sorting.

### FR-NR-16 — Bias classification
Each ticker is classified as one of three bias values based on the net balance of bullish vs bearish signals:
- **🟢 Bull** — net positive signal count (≥2 more bullish than bearish)
- **🔴 Bear** — net negative signal count (≥2 more bearish than bullish)
- **🟡 Mixed** — signals are balanced or inconclusive

The AI synthesis determines the final bias classification.

### FR-NR-17 — Sort order
After a batch run, the left panel ticker list is sorted by Impact Score descending. Within equal scores, Bearish bias sorts above Bullish (actionable risk first). Tickers with no score sort to the bottom.

---

## 6. Data Sources

### FR-NR-18 — Earnings data
Fetch upcoming earnings date and consensus EPS/revenue estimates. Source: a publicly available earnings calendar API (e.g., Polygon.io `/vX/reference/financials` + earnings events, or Yahoo Finance earnings calendar endpoint).

Fields required: `earningsDate`, `epsEstimate`, `revenueEstimate`, `priorEps`, `beatMissHistory` (last 4 quarters).

### FR-NR-19 — Analyst ratings
Fetch analyst upgrades/downgrades and price target changes from the last 30 days.  
Source: Polygon.io `/vX/reference/analysts` or equivalent.

Fields required: `firm`, `action` (upgrade/downgrade/initiate), `ratingFrom`, `ratingTo`, `priceTargetFrom`, `priceTargetTo`, `date`.

### FR-NR-20 — Insider transactions
Fetch SEC Form 4 insider transactions (buys and sells) for the last 30 days.  
Source: SEC EDGAR public API (`https://efts.sec.gov/LATEST/search-index?q=...`) or Polygon.io insider trades endpoint.

Fields required: `filerName`, `filerTitle`, `transactionType` (buy/sell), `shares`, `pricePerShare`, `totalValue`, `filingDate`.

### FR-NR-21 — News headlines
Fetch recent news headlines from the last 7 days relevant to the ticker.  
Source: Polygon.io `/v2/reference/news?ticker={ticker}`.

Fields required: `headline`, `publishedUtc`, `source`, `articleUrl`, `sentiment` (if available).

### FR-NR-22 — Macro events calendar
Maintain a static + updatable list of upcoming macro events: FOMC meeting dates, CPI/PPI release dates, jobs report dates.  
Source: Federal Reserve published calendar (static JSON, updated quarterly) or a free economic calendar API.

### FR-NR-23 — Short interest
Fetch short interest data: short % of float, days-to-cover.  
Source: Polygon.io `/v2/reference/short-interest/{ticker}` or FINRA short sale data.

### FR-NR-24 — Regulatory / corporate events (best-effort)
Where available, surface: FDA PDUFA dates (pharma tickers), FTC/DOJ reviews, major product launches, M&A announcements.  
Source: news headline NLP extraction by the AI synthesis layer. No dedicated API required — Claude extracts these from the news batch.

### FR-NR-25 — Graceful degradation
If any individual data source is unavailable or returns an error, the module continues with the data that is available. The dossier clearly marks unavailable sections as "Data unavailable" rather than silently omitting them. Missing data does not block the AI synthesis call — Claude is instructed to note missing inputs in its output.

---

## 7. AI Synthesis Layer

### FR-NR-26 — Single batch prompt per watchlist run
For a batch run, all tickers' raw data is bundled into **one Claude API call**. The prompt instructs Claude to:
1. Analyze each ticker independently.
2. Rank all tickers by overall Impact Score (0–10) relative to each other.
3. For each ticker output: `impactScore`, `bias`, `keyFactors[]` (max 5 bullets), `summary` (2 sentences max).

### FR-NR-27 — Key Factors format
Each key factor bullet must include:
- Signal tag: one of `EARNINGS`, `ANALYST`, `INSIDER`, `MACRO`, `REGULATORY`, `SHORT_SQUEEZE`, `NEWS`, `SEASONALITY`
- Directional icon: 🟢 (bullish) / 🔴 (bearish) / 🟡 (neutral)
- Concise description: max 15 words

Example:
```
🔴 EARNINGS — Q2 report in 4 days; consensus EPS down 12% vs prior quarter
🟢 INSIDER — CEO bought $2.1M on June 1; largest insider buy in 18 months
🟡 MACRO — FOMC rate decision June 18; rate hold expected, minimal impact
```

### FR-NR-28 — Single-ticker on-demand prompt
When a single ticker is analyzed on demand (no batch), a standalone prompt is used with the same output schema as FR-NR-26 but for one ticker only.

### FR-NR-29 — Portfolio context injection
If the selected ticker is also present in the user's open portfolio positions, the AI prompt includes the position details (entry price, strategy, DTE, unrealized P&L). Claude is instructed to add a "Position relevance" note: how the signals specifically affect the open trade.

### FR-NR-30 — Model selection
Use **Claude Haiku 3.5** by default (cost-effective, sufficient for summarization tasks). The model is configurable via app settings. Falls back to rule-only summary (no AI) if no API key is configured — raw signals are still displayed without the synthesized narrative.

### FR-NR-31 — No fabricated data
The AI prompt explicitly instructs Claude: "Do not invent or estimate financial figures. If a data field is null or missing, state it is unavailable. Only reference figures provided in this prompt."

---

## 8. Dossier UI (Right Panel)

### FR-NR-32 — Dossier header
Shows: ticker symbol, company name, current price (from quote cache), bias badge, impact score, and "Last updated HH:MM AM/PM" timestamp with a 🔄 Refresh button.

### FR-NR-33 — Tabs
Three tabs in the right panel:

| Tab | Content |
|---|---|
| **⚡ AI Summary** | Impact score gauge, bias badge, Key Factors list (FR-NR-27), 2-sentence narrative, Portfolio relevance note if applicable |
| **📅 Events** | Timeline of upcoming events: earnings date, FOMC, CPI, ex-dividend date, any regulatory events. Sorted by date ascending. Color-coded by proximity (red <7 days, yellow 7–21, gray >21). |
| **📰 News** | Last 7 days of news headlines with source, timestamp, and sentiment tag. Sorted newest first. Headlines are links (open in default browser). |

### FR-NR-34 — No ticker selected state
When no ticker has been clicked yet, the right panel shows: "Select a ticker from the list, or click ▶ Run Watchlist to analyze all."

---

## 9. Database Schema

### FR-NR-35 — news_research_cache table
```sql
CREATE TABLE news_research_cache (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker           TEXT NOT NULL,
  cache_date       TEXT NOT NULL,          -- YYYY-MM-DD local trading date
  raw_data         TEXT NOT NULL,          -- JSON blob of all fetched signals
  ai_summary       TEXT,                   -- JSON blob: { impactScore, bias, keyFactors, summary, portfolioNote }
  impact_score     REAL,                   -- denormalized for fast sort
  bias             TEXT,                   -- 'bull' | 'bear' | 'mixed'
  ai_model         TEXT,                   -- model used, e.g. 'claude-haiku-3-5'
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ticker, cache_date)
);
```

### FR-NR-36 — macro_events table
```sql
CREATE TABLE macro_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date   TEXT NOT NULL,   -- YYYY-MM-DD
  event_type   TEXT NOT NULL,   -- 'FOMC' | 'CPI' | 'PPI' | 'JOBS' | 'OTHER'
  description  TEXT NOT NULL,
  source       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 10. IPC / API Surface

### FR-NR-37 — IPC handlers (main process)
| Channel | Args | Returns |
|---|---|---|
| `news:fetch-ticker` | `ticker: string` | `NewsResearchResult` (cache-first) |
| `news:refresh-ticker` | `ticker: string` | `NewsResearchResult` (force re-fetch) |
| `news:fetch-watchlist` | `watchlistId: number` | `NewsResearchResult[]` sorted by impactScore |
| `news:get-cached` | `ticker: string` | `NewsResearchResult \| null` |
| `news:get-macro-events` | `daysAhead?: number` | `MacroEvent[]` |

### FR-NR-38 — Shared types
```typescript
interface NewsResearchResult {
  ticker: string;
  cacheDate: string;
  impactScore: number | null;
  bias: 'bull' | 'bear' | 'mixed' | null;
  keyFactors: KeyFactor[];
  summary: string | null;
  portfolioNote: string | null;
  events: ResearchEvent[];
  news: NewsHeadline[];
  rawSignals: RawSignals;
  aiModel: string | null;
  updatedAt: string;
}

interface KeyFactor {
  tag: 'EARNINGS' | 'ANALYST' | 'INSIDER' | 'MACRO' | 'REGULATORY' | 'SHORT_SQUEEZE' | 'NEWS' | 'SEASONALITY';
  direction: 'bull' | 'bear' | 'neutral';
  description: string;
}

interface ResearchEvent {
  date: string;
  type: string;
  description: string;
  daysUntil: number;
}

interface NewsHeadline {
  headline: string;
  source: string;
  publishedUtc: string;
  url: string;
  sentiment: 'positive' | 'negative' | 'neutral' | null;
}

interface RawSignals {
  earnings: EarningsSignal | null;
  analystRatings: AnalystRating[];
  insiderTransactions: InsiderTransaction[];
  shortInterest: ShortInterestSignal | null;
  macroEvents: MacroEvent[];
  newsHeadlines: NewsHeadline[];
}
```

---

## 11. Non-Functional Requirements

### NFR-NR-01 — Single-ticker load time
A single-ticker on-demand fetch + AI synthesis must complete within **10 seconds** under normal network conditions.

### NFR-NR-02 — Batch run time
A batch run for a 20-ticker watchlist must complete within **45 seconds** (data fetches parallelized; single AI call with all tickers bundled).

### NFR-NR-03 — Rate limiting
All data source HTTP calls go through the existing `TokenBucketRateLimiter`. Batch fetches are capped at 5 concurrent requests. Polygon.io calls must respect the existing rate limiter — no bypass.

### NFR-NR-04 — Offline / API failure
If network is unavailable, display stale cached data with a red "⚠ Offline — showing last cached data from {date}" banner. If no cache exists, show "No data available — connect to the internet and click Refresh."

### NFR-NR-05 — No API key configured
If no Claude API key is configured, the AI Summary tab shows raw signals only (Key Factors derived from rule-based heuristics, no narrative text). The 🔄 Refresh and ▶ Run Watchlist functions still work — they just skip the AI synthesis step.

### NFR-NR-06 — Cost guardrail
The batch run confirms before executing if the watchlist has more than 30 tickers: "This will analyze {n} tickers in one AI call (~{estimated_tokens} tokens, ~${estimated_cost}). Continue?" Token and cost estimates are computed client-side from the bundled prompt size.

### NFR-NR-07 — Data privacy
No ticker symbols, position data, or research results are sent to any third party except: (a) the configured market data provider (Polygon.io) and (b) the Anthropic Claude API. SEC EDGAR calls are unauthenticated public requests.

---

## 12. Phased Implementation Plan

### Phase 1 — Data + Cache + UI (no AI)
1. DB migration: `news_research_cache`, `macro_events` tables.
2. Data fetcher services: `NewsDataFetcher` aggregates earnings, analyst, insider, news, short interest, macro events.
3. IPC handlers: `news:fetch-ticker`, `news:get-cached`, `news:fetch-watchlist`.
4. UI: two-panel layout, watchlist selector, ticker list (unsorted), right panel with Events and News tabs.
5. Caching logic: cache-first reads, manual refresh.

### Phase 2 — AI Synthesis + Ranking
1. `NewsAIService`: builds batch prompt, calls Claude Haiku 3.5, parses structured response.
2. Impact Score computed + persisted.
3. Left panel sorts by score after batch run.
4. AI Summary tab with Key Factors and narrative.
5. Portfolio context injection (FR-NR-29).
6. Batch run button with progress indicator and skip-cached logic.

### Phase 3 — Polish & Extensions (future)
- Seasonality signals: historical monthly return data for ticker.
- Unusual options activity signal (large sweep detection from chain data already fetched).
- Push notification: "🔴 TSLA high-impact event detected" on app focus if a new result scores ≥8.
- Export dossier to PDF (same pipeline as Daily Brief PDF export).

---

## 13. Out of Scope (v1)

- Real-time news streaming (WebSocket feeds)
- Social sentiment (Reddit, X/Twitter) — deferred to Phase 3
- Custom alert rules ("notify me when TSLA scores ≥ 7")
- Historical research dossier archive beyond 30 days (cache purge after 30 days)
- Automated scheduled batch run (user triggers manually)
