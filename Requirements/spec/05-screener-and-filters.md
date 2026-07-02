# 05 — Index Screener & Filter Templates

Two related features: the **Index Screener** (run a full fundamental filter set across a universe) and **Filter Templates** (one-click pre-built scans for common signals). Both write nothing to portfolios — they surface candidates.

---

## Part A — Index Screener

Screens a chosen universe for fundamentally sound candidates ("stocks that can't go wrong"). Service: `screener-service.ts`. Backed by `constituents`, `screen_presets`, `screen_runs`, `screen_results`, the caches (§2.4, §2.6). IPC: `window.api.screen.*`. View: `ScreenerView.tsx` (🔍 Screener).

### 5.A.1 Universe selection
- **FR-2.0a** Universe ∈ `sp500`, `russell1000`, `both` (deduplicated union), `etf`.
- **FR-2.0b** Constituent lists auto-refresh daily (batch job `constituents-refresh`, §20.3 — v1.1.91) and remain manually refreshable; show last-refreshed timestamp. Source priority (automated job and the manual "Refresh" button share one gated path): **Vanguard fund holdings** (VOO → S&P 500, VONE → Russell 1000; free public paginated JSON, no key) → **Wikipedia scrape fallback**. Both are gated — row-count floor (480 / 940) and ≤25% turnover vs the stored list — so a broken feed never overwrites a good list; sector/company are preserved for carried-over tickers (Vanguard carries no sector). User CSV import remains the manual override; the bundled CSV seeds first-run only.
- **FR-2.0c** `both` dedupes by ticker (S&P 500 ⊂ Russell 1000 mostly → union ≈ 1,000). ETF universe is a separate list.

IPC: `getConstituents(index)`, `getMeta(index)`, `getConstituentsWithMeta(index)` (rows + `added_at`, for the viewer), `refreshConstituents(index)`, `importConstituents(filePath, index)`, `syncUniverse(universe)` (+ `syncCancel`, `onSyncProgress`).

`constituents.added_at` is a **stable first-seen date**: `applyRefresh` preserves it for carried-over tickers and stamps only genuinely new members (v1.1.95) — so it reflects when a ticker joined the index, not the last refresh. Surfaced in the **Index Constituents viewer** (Misc → 📇, `ConstituentsView.tsx`): two tabs (S&P 500 / Russell 1000), sortable grid (Ticker · Company · Sector · Added, default newest-added first), filter box, and a NEW badge on members added within 7 days — so the daily refresh job's additions are visible.

### 5.A.2 Default filter set (17 filters)

The default preset. Each filter can be toggled off and its threshold adjusted. Financial sector is exempt from D/E by default.

| Filter | Default | Rationale |
| --- | --- | --- |
| Market cap | ≥ $10B | Large-cap only; tighter option spreads |
| P/E (TTM) | 5 – 30 | Profitable, not stretched |
| EPS (TTM) | > 0 | Profitable today |
| Revenue growth (YoY) | ≥ 5% | Top line growing |
| EPS growth (YoY) | ≥ 5% | Earnings growing |
| Debt-to-equity | < 1.5 | Manageable leverage (financials exempt) |
| Return on equity | ≥ 15% | Capital efficiency |
| Profit margin (net) | ≥ 8% | Pricing power |
| Free cash flow | Positive (TTM) | Real cash |
| Current ratio | ≥ 1.0 | Covers short-term obligations |
| Avg daily volume (30d) | ≥ 1M shares | Liquidity floor |
| Avg option volume (30d) | ≥ 1,000 contracts | Tradeable options (null from Polygon → filter off by default) |
| Price | ≥ $20 | Avoids penny-stock behavior |
| Distance from 52-wk high | within 25% | Healthy uptrend |
| Distance from 52-wk low | ≥ 15% | Not in freefall |
| Beta (vs S&P 500) | 0.7 – 1.6 | Excludes flatliners and meme-vol |
| Sector exclude list | empty | User blacklist |
| Earnings within N days | exclude if ≤ 7 (toggle) | Avoid binary risk |

The authoritative filter specs (`DEFAULT_FILTER_SPECS`) live in `src/shared/screener-filters.ts` (id, label, type, default threshold, enabled). Polygon-incompatible filters (option volume) default off. All fundamentals come from the §3.3 computer (cached 24h).

### 5.A.3 Strict vs soft-match
- **FR-2.0d** Strict = must pass all enabled filters. Soft = rank by count of filters passed, show top N.
- **FR-2.0e** In soft mode each row shows a pass score ("14 / 17 criteria passed") and which filters failed.

### 5.A.4 Functional requirements
- **FR-2.1** Run-screen executes all enabled filters against the chosen universe.
- **FR-2.2** Results table shows ticker, company name, sector, all filter values, pass score.
- **FR-2.3** Sort/re-sort by any column.
- **FR-2.4** Multi-select results → "Save as Watchlist" → name prompt → creates and switches to it.
- **FR-2.5** Save named filter presets (including universe); recall later. A `Default` preset ships out of the box.
- **FR-2.6** "Last run" timestamp shown; fundamentals show their own freshness timestamp.
- **FR-2.7** Universe size and pass count shown ("Russell 1000: 1,003 scanned, 87 passed").
- A cache-status indicator warns when fundamentals are stale.

IPC: `run(criteria)`, `getRuns`, `getResults(runId)`, `saveAsWatchlist(runId, resultIds, name)`, `listPresets`, `savePreset`, `deletePreset`, `getDbCounts`, `cancel`, `onProgress`.

### 5.A.5 Acceptance criteria
- Default screen on S&P 500 < 30s (cached fundamentals); Russell 1000 < 90s.
- Saving 20 results creates a watchlist with exactly those 20 tickers.
- Switching S&P 500 → Russell 1000 under identical filters yields a near-superset.

---

## Part B — Filter Templates

One-click pre-built scans over a watchlist or universe. Service: `filter-templates-service.ts` (definitions in `src/shared/filter-templates.ts`). IPC: `window.api.filters.*`. View: `FiltersView.tsx` (🎛️ Filters).

### 5.B.1 Behavior
- User picks a template, a source (`watchlist` or `universe`), and the universe or watchlist IDs.
- The service iterates tickers, fetches only the data the template needs (`bars`, `quote`, `options`, `fundamentals`), evaluates the condition, and returns matching rows with the template's metric columns. Tickers whose data fetch fails are silently skipped. Progress is streamed (`onProgress`).

IPC: `listTemplates()`, `runTemplate(templateId, source?, universe?, watchlistIds?)`, `onProgress`.

### 5.B.2 Built-in templates

| ID | Label | Category | Condition | Columns |
| --- | --- | --- | --- | --- |
| `rsi_overbought` | RSI Overbought | technical | RSI > 70 | RSI |
| `rsi_oversold` | RSI Oversold | technical | RSI < 30 | RSI |
| `iv_rank_low` | IV Low | volatility | IV rank < 20 | IV Rank, IV % |
| `iv_rank_high` | IV High | volatility | IV rank > 70 | IV Rank, IV % |
| `price_alert` | Price Alert | technical | Near key SMA / golden-death cross | % vs SMA50, % vs SMA200 |
| `assignment_risk` | Assignment Risk | options | Short-option delta > 0.70 | Delta, Strike, DTE |
| `wheel_opportunity` | Wheel Opportunity | wheel | Wheel suitability ≥ 60 | Score, IV %, Target Strike |

Each result row can drill into Analysis / Validate / Options / Payoff / Strategy Lab for that ticker.

### 5.B.3 Save results to a watchlist
- **FR-5.B.3** The results header has a **⭐ Save to Watchlist** action that bulk-saves *all* current matches to a watchlist — either a **new** list (enter a name) or an **existing** one (pick from the dropdown). Duplicate tickers already in the target list are skipped and reported. Available for every template's results. Uses `watchlists.create` + `watchlists.items.addBulk`. Lets a filter run seed a reusable watchlist for use in other functions (analysis, LEAPS+CSP, other filters).
