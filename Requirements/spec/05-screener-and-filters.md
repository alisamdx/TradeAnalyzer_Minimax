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
- The Filters universe dropdown additionally offers **`all`** (v1.1.114) = S&P 500 + Russell 1000 + ETFs, deduplicated (`getConstituents('all')`). In an `all` scan the ETF-vs-stock calibration (ETF IV thresholds, skipped fundamentals gate, lower vetted-wheel yield floor) is applied **per ticker** from ETF-list membership — not universe-wide. `'all'` is a `Universe` member but is only offered by the Filters view.
- The service iterates tickers, fetches only the data the template needs (`bars`, `quote`, `options`, `fundamentals`), evaluates the condition, and returns matching rows with the template's metric columns. Tickers whose data fetch fails are silently skipped. Progress is streamed (`onProgress`); a run accepts an optional `AbortSignal` (used by the prefill batch job).

IPC: `listTemplates()`, `runTemplate(templateId, source?, universe?, watchlistIds?)`, `getSavedRuns()`, `onProgress`.

**Result persistence (v1.1.107, per-template v1.1.108)**: each template's last run (source/universe, results, sort) is cached per day in `localStorage` keyed by template id. Clicking a template card shows its today-cache if present (no API call) or runs fresh otherwise; on mount the most recently run template is restored. Survives navigation and same-day app restart; the whole cache auto-expires next day. The header shows the run time (`today's run HH:MM` restored vs `ran HH:MM` fresh) and a **↻ Re-run** button refreshes on demand — run each once, view all day.

**Batch prefill (v1.1.114)**: the `filters-prefill` batch job (§20.3) precomputes the configured templates over Universe = All at the end of the after-close chain and stores the latest run per template in `filter_template_runs`. By default (v1.1.115, **IV High swapped for IV High (Vetted) v1.1.121**) it runs four filters in regular use — **RSI Oversold, IV High (Vetted), Price Alert, Wheel (Vetted)** — a `config_json.enabledTemplates` allowlist — so the unused/expensive ones don't burn batch time; a filter not in the allowlist simply isn't pre-populated (no card badge) and runs live on click. Plain `iv_rank_high` is deliberately excluded from the default automatic run — it still works on-demand from the Filters view for browsing the full unscreened list, but the vetted version is the one worth precomputing and the one the summary email sources from. Storage: (shape-versioned — rows written by an older result shape are ignored, mirroring the localStorage `CACHE_VERSION`; the constant is shared: `FILTER_RESULTS_SHAPE_VERSION` in `filter-templates.ts`). The view loads these via `getSavedRuns()` on mount; each template card shows a **match-count badge**, and clicking a card shows the freshest cached data instantly — today's manual run or the batch run, whichever is newer — falling back to a live scan only when neither exists. Batch results are shown indefinitely (no day expiry) with a muted `batch ran <date time>` stamp; **↻ Re-run** always fetches live. The prefill job's summary email (§20.3) sources its IV High list from **IV High (Vetted)**, not the loose `iv_rank_high`.

### 5.B.2 Built-in templates

| ID | Label | Category | Condition | Columns |
| --- | --- | --- | --- | --- |
| `rsi_overbought` | RSI Overbought | technical | RSI > 70 | RSI |
| `rsi_oversold` | RSI Oversold | technical | RSI < 30 | RSI |
| `iv_rank_low` | IV Low | volatility | IV rank < 20 | IV Rank, IV % |
| `iv_rank_high` | IV High | volatility | IV rank > 70 | IV Rank, IV % |
| `iv_rank_high_vetted` | IV High (Vetted) | volatility | Two-stage, mirrors Wheel (Vetted): IV rank > 70 (30 ETF), then **no earnings on/before the target expiry** + **not in a confirmed downtrend** (Phase 1), then a monthly-expiry chain check on the **ATM (0.50Δ)** option — open interest ≥ 250, spread ≤ 15% of mid, **IV ≤ 80%** (Phase 2, capped to the top 40 Phase-1 survivors by IV rank) | IV Rank, IV %, OI, Spread |
| `price_alert` | Price Alert | technical | Near key SMA / golden-death cross | % vs SMA50, % vs SMA200 |
| `assignment_risk` | Assignment Risk | options | Short-option delta > 0.70 | Delta, Strike, DTE |
| `wheel_opportunity` | Wheel Opportunity | wheel | Wheel suitability ≥ 60 | Score, IV %, Target Strike |
| `wheel_vetted` | Wheel (Vetted) | wheel | Two-stage: suitability ≥ 75 + **no earnings on/before the target expiry** + **not in a confirmed downtrend** (Tier 1), then a monthly-expiry chain check on the ~0.30Δ put — open interest ≥ 250, spread ≤ 15% of mid, annualized yield ≥ 15%, **IV ≤ 80%** (Tier 2) | Score, IV %, Expiry, Put Strike, Credit, Ann %, Risk-Adj %, OI, Spread |

**Earnings**: individual names whose next earnings (from the local `earnings_calendar`) falls on/before the target monthly expiry are excluded — a short put held through an earnings report inside the window is the biggest event risk (gap + IV crush). ETFs are exempt (no earnings). Coverage is **universe-wide**: the daily **Earnings Refresh** batch job (`EarningsRefreshJob`) populates `earnings_calendar` for every S&P 500 + Russell 1000 constituent via Finnhub, so the gate applies across the full scan (given the Finnhub key is set and the job has run). The only residual gap is a company that hasn't announced its next date yet — nothing to gate until it appears (automatically) on a later refresh.

**Downtrend**: names in a **confirmed downtrend** (price < SMA50 < SMA200 → `technical_signals.trend_label = 'Bearish'`, nightly-computed) are excluded — never sell a CSP at the top of a decline (falling-knife risk); uptrend and sideways are both kept. Applies to stocks and ETFs; a name with no computed trend passes. Mirrors the Daily Brief's "not in downtrend" wheel signal.

**ETFs**: the fundamentals gate is skipped (ETFs have no P/E/ROE/D-E) — the curated ETF list is wheel-eligible by design, IV rank is shown as the proxy Score, and the Tier-2 options gate still applies but with a **lower annualized-yield floor** (`minAnnualizedReturnEtf`, default 8% vs 15% for individual names), because an ETF carries far less risk (no single-name blow-up) so less premium is acceptable. IV ceiling / OI / spread gates are unchanged.

**Wheel (Vetted)** exists because `wheel_opportunity` gates on fundamentals only (≈792 matches over S&P 500 + Russell 1000). The vetted funnel does the cheap fundamentals gate on every name first (no option call), then fetches **one monthly-expiry chain per survivor** and applies the liquidity + premium gate on the target ~0.30Δ put — turning the list into a tradeable handful. Deeper/slower scan (option calls for survivors), so it's a deliberate action, not a browse. Sorted by **risk-adjusted yield** (`annualized × (1 − |delta|)`) so raw premium alone doesn't front-load the riskiest names; with a fixed ~0.30Δ target this is a mild discount, so the **IV ceiling** is the primary vol-risk control (excludes the high-IV "vol-bombs"). Pure gate logic (`thirdFridayOnOrAfter`, `pickWheelPut`, `annualizedCspYield`, `riskAdjustedYield`, `assessWheelPut`) is unit-tested (`tests/wheel-vetted.test.ts`); thresholds live in `WHEEL_VETTED_DEFAULTS`.

**IV High (Vetted) (v1.1.120)** applies the same safety philosophy to the plain IV-High signal: a bare `IV rank > 70` threshold surfaces genuinely bad candidates (falling knives, imminent-earnings IV traps, illiquid names, vol-bombs) once it feeds anything actionable (the prefill email's top-10, §20.3) — acceptable for a browse-everything view, not for a curated shortlist. Reuses Wheel (Vetted)'s exact pure helpers (`thirdFridayOnOrAfter`, `pickWheelPut`, `assessWheelPut`) but targets the **ATM (0.50Δ)** option rather than the wheel's 0.30Δ put — this isn't picking a CSP structure, it's a general "can you actually trade this name's options" liquidity check — and has **no annualized-yield floor** (0, always passes) and **no fundamentals/suitability gate** (user decision: IV High serves CSPs, covered calls, and other premium strategies, not just wheel-style ownership). Because it lacks Wheel (Vetted)'s suitability≥75 bar to narrow the field before the live chain fetch, Phase 1 survivors are ranked by IV Rank descending and **capped to the top 40** (`IV_HIGH_VETTED_CHAIN_FETCH_CAP`) before Phase 2 spends an API call — the email only ever needs the top 10, so a generous buffer is all that's needed; this is a two-phase runner (`runIvHighVetted`) rather than the generic per-ticker `evaluateTemplate` dispatch every other template uses, since it needs the full Phase-1 pool before it can rank and cap. `tests/iv-high-vetted.test.ts` covers all gates end to end.

Each result row can drill into Analysis / Validate / Options / Payoff / Strategy Lab for that ticker.

### 5.B.3 Save results to a watchlist
- **FR-5.B.3** The results header has a **⭐ Save to Watchlist** action that bulk-saves *all* current matches to a watchlist — either a **new** list (enter a name) or an **existing** one (pick from the dropdown). Duplicate tickers already in the target list are skipped and reported. Available for every template's results. Uses `watchlists.create` + `watchlists.items.addBulk`. Lets a filter run seed a reusable watchlist for use in other functions (analysis, LEAPS+CSP, other filters).
