# 16 — News & Research

A structured, daily-refreshed intelligence dossier per ticker that filters for **price-moving signals only**, classifies each as bullish/bearish/neutral, and uses Claude to produce a "what matters today" summary. A batch run analyzes a whole watchlist in one AI call and re-sorts tickers by **Impact Score**. Services: `news-data-fetcher.ts`, `news-ai-service.ts`, `news-link-builder.ts`. IPC: `window.api.news.*`. View: `NewsResearchView.tsx` (📡 News & Research). Tables: `news_research_cache`, `macro_events` (§2.18).

## 16.1 Layout

Two panels. **Left**: watchlist selector, ▶ Run Watchlist button, last-run time, and a ranked ticker list (rank, ticker, bias badge 🟢 Bull / 🔴 Bear / 🟡 Mixed, Impact Score 0–10). **Right**: the dossier for the selected ticker with three tabs — **⚡ AI Summary**, **📅 Events**, **📰 News** — plus a header (ticker, name, price, bias, score, last-updated, 🔄 Refresh).

## 16.2 Caching & refresh

- Daily cache keyed `(ticker, cache_date)` (local trading date). Same-date rows are fresh; prior-date rows are stale.
- Cache-first load: a fresh today-row displays immediately; otherwise fetch → synthesize → persist → display.
- 🔄 Refresh forces re-fetch + re-synthesis and overwrites the row. A stale row shows a "⚠ Data from yesterday — click Refresh" banner.

## 16.3 Batch run

▶ Run Watchlist: fetch raw data for all tickers in parallel (≤ 5 concurrent, rate-limited), bundle **all tickers into one Claude call** (enables cross-ticker relative ranking), persist each, re-sort left panel by Impact Score desc, auto-select the top ticker. Progress shows "Analyzing 4 / 12…", rows update in place. Tickers already cached today are skipped (override with per-row Refresh). Re-running after a complete run prompts to refresh all. A cost guardrail confirms before running > 30 tickers.

## 16.4 Data sources (graceful degradation)

| Signal | Source |
| --- | --- |
| Earnings date + estimates | E*Trade / earnings service (§17) |
| Analyst ratings & price-target changes (30d) | Polygon |
| Insider transactions (Form 4, 30d) | SEC EDGAR full-text search |
| News headlines (7d, with sentiment if available) | Polygon `/v2/reference/news` |
| Macro events (FOMC/CPI/PPI/Jobs) | `macro_events` table (seeded yearly) |
| Short interest % of float | Polygon / FINRA (best-effort) |
| Regulatory/corporate events | Extracted by the AI from the news batch |

If any source errors, the dossier marks that section "Data unavailable" and continues — missing data never blocks synthesis.

## 16.5 Impact Score & bias

Impact Score (0–10) is a weighted sum of signal urgency: earnings proximity (≤3.0, scales 3→0 over 0–30 DTE), analyst rating change (≤1.5), price-target change magnitude (≤1.0), insider transaction (≤1.0), macro proximity (≤1.0), regulatory/legal (≤1.5), short-squeeze risk (≤0.5), AI urgency override (≤0.5). The AI emits the final score and the bias (**Bull** ≥2 net bullish, **Bear** ≥2 net bearish, else **Mixed**). Sort: Impact desc, then Bearish above Bullish on ties, unscored last.

## 16.6 AI synthesis

Claude **Haiku** (configurable; `claude-haiku-4-5`) per FR-NR-30. One batch call per run; per ticker returns `impactScore`, `bias`, `keyFactors[]` (≤5 bullets, each tagged `EARNINGS|ANALYST|INSIDER|MACRO|REGULATORY|SHORT_SQUEEZE|NEWS|SEASONALITY` + 🟢/🔴/🟡 + ≤15 words), and a ≤2-sentence summary. If the ticker is in the open portfolio, position details are injected and Claude adds a "Position relevance" note. Without an API key, the AI Summary tab shows rule-only key factors (no narrative); fetch/run still work. Claude is instructed to never fabricate figures.

## 16.7 Dossier tabs

- **AI Summary**: impact gauge, bias badge, Key Factors, narrative, portfolio note.
- **Events**: upcoming earnings, FOMC/CPI, ex-div, regulatory — sorted ascending, color-coded by proximity (red <7d, yellow 7–21, gray >21).
- **News**: last 7 days, source + timestamp + sentiment, newest first, headlines link out to the browser.

IPC: `fetchTicker(ticker)`, `refreshTicker(ticker)`, `fetchWatchlist(tickers[], forceRefresh?)`, `getCached(ticker)`, `getMacroEvents(daysAhead?)`, `onBatchProgress`.

## 16.8 Performance & privacy
Single-ticker fetch+synthesis ≤ 10s; 20-ticker batch ≤ 45s. All HTTP via the rate limiter (≤5 concurrent). Offline → stale cache with an offline banner. Data leaves the machine only to Polygon, Anthropic, and (unauthenticated) SEC EDGAR. Cache purges after 30 days.
