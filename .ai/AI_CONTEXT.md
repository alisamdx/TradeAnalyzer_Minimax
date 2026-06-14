# AI_CONTEXT — TradeAnalyzer build state

> **Read this first.** Self-contained snapshot of *what the app is today* so a fresh AI session is productive without re-reading the whole codebase. This file describes **current state** — not history. Release history lives in `CHANGELOG.md` / `changelogs/`. Operating rules live in `/CLAUDE.md`. Full spec lives in `Requirements/`.
>
> Last verified against code: 2026-06-14 (v1.1.6). When you make a material change, update the relevant section here in the same commit.

---

## 1. What the app is

TradeAnalyzer is a **single-user Electron desktop app for a retail options/swing trader**. It screens the S&P 500 + Russell 1000 + ETF universe for sound trade candidates, runs five analysis modes, scores candidates with a configurable engine, produces a daily AI intelligence brief, models multi-leg option payoffs, tracks a portfolio synced from E*Trade, and surfaces earnings/news risk. No cloud sync, no multi-user, no broker order execution (E*Trade integration is read-only).

The app is **feature-complete against the v1 spec** (now consolidated in `Requirements/spec/` — start at `00-index.md`), including all five enhancement tracks, the News & Research module, the Agent overhaul, and the scoring engine. The remaining gate to v1.0.0 is a week of real-world usage validation. (Earlier scattered specs are archived in `Requirements/_legacy/`.)

---

## 2. Stack

| Layer | Choice | Version |
| --- | --- | --- |
| Shell | Electron | 32.x |
| UI | React + TypeScript | 18 / 5.x |
| Build | electron-vite | 2.x |
| DB | better-sqlite3 (wrapped in `src/main/db/connection.ts`) | 12.x |
| Charts | lightweight-charts + recharts | 4.1.x / 3.x |
| HTTP server | Fastify (local agent API, 127.0.0.1:7432) | 5.x |
| AI | `@anthropic-ai/sdk` | 0.x |
| PDF / email | pdfkit / nodemailer | — |
| Tests | Vitest | 2.x |
| Lint | ESLint 9 + Prettier 3 | — |

App version is injected at build time as `__APP_VERSION__` (from `package.json`) and shown in the status bar.

---

## 3. Data providers

The app no longer routes everything through Polygon. Current split:

| Provider | Used for | Interface / entry point |
| --- | --- | --- |
| **Polygon.io** (Stocks Starter) | Quotes, historical OHLCV bars, ticker details (market cap/sector/shares), dividends (TTM yield), news headlines | `DataProvider` → `polygon-provider.ts` |
| **SEC EDGAR XBRL** | Financial statements (income/balance/CF) for fundamentals — replaces plan-restricted Polygon `/vX/reference/financials`. True TTM via 10-Q roll-forward (`ttmPair`); deduped annual series for 5Y CAGR (`annualSeries`) | `sec-edgar-provider.ts` (called by `polygon-provider.getFundamentals()`) |
| **Local DB** | Beta (1Y daily vs SPY from `historical_prices` — zero API cost) | `beta-service.ts` (injected into `PolygonDataProvider`) |
| **E*Trade** (OAuth 1.0a) | Options chains, per-contract IV/Greeks, expirations, earnings date, portfolio sync | `OptionsProvider` → `etrade-data-provider.ts`, `etrade-auth.ts`, `etrade-portfolio-service.ts` |
| **MarketData.app** | IV-history backfill (historical 30-day ATM IV) | `marketdata-provider.ts` |
| **IVolatility** | Alternative IV-history source | `ivolatility-provider.ts` |
| **Anthropic Claude** | AI brief synthesis, critic, portfolio advisor, news synthesis, strategy-lab rationale, payoff assessment | `@anthropic-ai/sdk` direct in each service |
| **SEC EDGAR** | Insider transactions (Form 4) for News & Research | `news-data-fetcher.ts` |

- **Options provider is switchable** via the `optionsProvider` setting (`'polygon'` | `'etrade'`), read at startup in `index.ts`. **E*Trade is the active default** — Polygon Options Starter was cancelled.
- `DataProvider` (quotes/fundamentals/bars) is always Polygon.
- AI models in use: `claude-opus-4-7` (portfolio advisor, payoff assess), `claude-sonnet-4-6` (daily brief rationale + AI critic), `claude-haiku-4-5` (news, strategy-lab rationale, paper-trade learning). Update these in one place per service if models are rotated.

### E*Trade auth quirks
- OAuth 1.0a flow in `etrade-auth.ts`; all calls go through `etradeGet()` which signs requests — never build auth headers by hand.
- Tokens expire at **midnight ET**; after 2h inactivity they go dormant → call `renewAccessToken()`. Batch jobs auto-renew and surface a "Reconnect" notification on hard expiry.
- Credentials stored encrypted via `secure-settings.ts` (DPAPI on Windows).
- **E*Trade IV is a decimal fraction** (0.3882 = 38.82%). Multiply by 100 when ingesting into anything that stores/displays IV as a percentage. `OptionContract.iv` stays a decimal fraction in memory — Black-Scholes uses it directly as sigma.

---

## 4. Architecture

### Process model
- **Main** (`src/main/`) owns the SQLite connection, all provider calls, the rate limiter, the batch scheduler, and the Fastify API server. Exposes a typed IPC surface.
- **Preload** (`src/preload/index.ts`) uses `contextBridge` to expose `window.api.*` (33 namespaces) and `window.dialog.*`. `contextIsolation: true`, `nodeIntegration: false`.
- **Renderer** (`src/renderer/`) is React/Vite. Never touches Node/FS/network — only `window.api.*`.

### Data flow
```
React view → window.api.<ns>.<method>() → ipcRenderer.invoke(channel)
  → ipcMain.handle in src/main/ipc/ipc-*.ts → Service in src/main/services/
  → better-sqlite3 (via withTransaction) and/or DataProvider/OptionsProvider
```
IPC responses use a uniform `IpcResult<T>` = `{ ok: true, value } | { ok: false, error }`. The preload `invoke()` wrapper unwraps it and throws on `ok: false`.

### Rate limiting & batch pipeline
- `TokenBucketRateLimiter` (`rate-limiter.ts`) + SQLite-backed `JobQueue` (`job-queue.ts`) make long runs resumable/cancellable. All Polygon traffic must go through it — never ad-hoc `fetch`.
- `BatchService` (`batch-service.ts`) is the daily job scheduler. Jobs implement `BatchJobHandler` (`run(onProgress, signal, force?)`), are registered in `index.ts`, run one-at-a-time under a mutex (so same-time jobs chain), support `runOnStartup` / `startupDelaySeconds` / `dailyScheduleTime` / per-job `defaultConfig`, and stream progress to the Batch Jobs view.

### Local API server
`ApiServer` (`api-server.ts`) runs Fastify on `127.0.0.1:7432` with token auth (`~/.tradeanalyzer/agent.token`). Route modules in `src/main/api/`. Used by the external TraderAgent to read briefs, run Strategy Lab, and call the Critic.

---

## 5. Repository map

```
src/main/
  index.ts                  App lifecycle, window, provider wiring, IPC + batch job registration
  db/connection.ts          openDatabase, withTransaction (the only DB entry points)
  db/migrations.ts          Runs numbered migrations from /migrations
  api-server.ts             Fastify local API (port 7432)
  api/                       REST route modules
  ipc/ipc-*.ts              28 IPC handler modules (one per feature area)
  services/                  62 service classes (see §7)
  services/jobs/             10 batch job handlers
  execution/                 v2 execution subsystem — ExecutionBroker+mock (Ph1), risk-gate+RiskGovernor (Ph2), market-hours+reconciliation+ExecutionCore (Ph3a), control-api :7433+SSE (Ph3b), entry-policy EntryPolicy (Ph4a), order-manager OrderManager (Ph4b). DORMANT, wired to nothing yet
src/preload/index.ts        window.api.* bridge (33 namespaces)
src/renderer/src/
  App.tsx                    Sidebar routing + layout + status bar + cross-view nav events
  views/                     26 feature views (see §6)
  global.d.ts                window.api type declaration (ONLY place it's declared)
  knowledge/                 Embedded tastylive strategy guide (images + JSON)
  styles.css
src/shared/types.ts         All cross-process types
migrations/                  44 numbered SQL migrations
docs/                        architecture.md, data-provider.md, formulas.md, troubleshooting.md
Requirements/                Spec + per-feature design docs
changelogs/                  Per-version notes
```

---

## 6. Views & sidebar (27 views, 8 sections)

Routing is a `currentView` string in `App.tsx`; cross-view navigation fires CustomEvents (`navigate-to-payoff`, `navigate-to-validate`, `navigate-to-analysis`, `navigate-to-options`).

| Section | Views |
| --- | --- |
| **Data** | ⚙ Settings · ⚖ Trade Scoring (`TradeScoringView`) · 🔄 Batch Jobs (`BatchView`) |
| **Intelligence** | 📋 Daily Brief (`DailyBriefView`) · 🪞 Retrospect (`RetrospectView`) · ⏪ Replay (`BriefReplayView`) · 📅 Earnings (`EarningsCalendarView`) · 📡 News & Research (`NewsResearchView`) · 🤖 Agent (`AgentView`) |
| **Screeners** | 🔍 Screener · 🎯 Opportunity · 🎛️ Filters |
| **Analysis** | 📐 Payoff (`PayoffView`) · 🎯 Validate · 📉 Options (`OptionsChainView`) |
| **Strategy** | 📚 Knowledge · 📊 Analysis · 🔬 Strategy Lab (`StrategyLabShellView` — tabs: Strategy Lab / ⚡ LEAPS / 🛡️ Collared LEAPS) |
| **Misc** | 🔁 Backtest · 🔬 Test API · 🗄️ Data Sync (`DataView`) · 🗓️ History (`IvHistoryView`) |
| **Personal** | ⭐ My Stocks (`ConvictionView`, with buy-zone count badge) · 💼 Portfolio · 📋 Watchlists · 🔔 Alerts |

---

## 7. Services index

**Core data**: `data-provider.ts` (interface), `polygon-provider.ts`, `options-provider.ts` (interface), `etrade-data-provider.ts`, `etrade-options.ts`, `etrade-auth.ts`, `marketdata-provider.ts`, `ivolatility-provider.ts`, `fundamentals-computer.ts`, `constituents-service.ts`, `historical-service.ts`, `cache-service.ts`, `cache-manager.ts`.

**Screening & analysis**: `screener-service.ts`, `analysis-service.ts`, `opportunity-service.ts`, `filter-templates-service.ts`, `validate-all-service.ts`, `strategy-lab-service.ts`, `scoring-service.ts`, `wheel-calculator.ts`, `support-resistance.ts`, `pattern-detector.ts`.

**Options strategy**: `payoff-service.ts`, `leaps-csp-service.ts`, `collared-leaps-service.ts`.

**Portfolio**: `portfolio-service.ts`, `etrade-portfolio-service.ts`, `position-analysis-service.ts`, `ai-advisor-service.ts`.

**Intelligence**: `critic-service.ts`, `news-ai-service.ts`, `news-data-fetcher.ts`, `news-link-builder.ts`, `earnings-service.ts`, `iv-history-service.ts`, `paper-trading-service.ts`, `conviction-service.ts`, `briefing-service.ts`, `email-service.ts`, `brief-report-builder.ts`.

**Infra**: `batch-service.ts`, `rate-limiter.ts`, `job-queue.ts`, `secure-settings.ts`, `logger.ts`, `csv.ts`, `backtest-engine.ts`, `backtest-metrics.ts`, `alerts-service.ts`, `agent-db-service.ts`.

**Batch jobs** (`services/jobs/`, registered in `index.ts`): `batch-orchestrator-job` (sequence 1) · `daily-iv-capture` · `daily-market-sync-stocks`/`-etfs` (`market-sync-job.ts`) · `daily-screener-job` · `price-gap-fill-job` · `daily-technical-signals-job` · `daily-intelligence-brief-job` · `daily-options-snapshot-job` · `daily-paper-snapshot-job` · `earnings-refresh-job` · `daily-options-premium-history-job` (registered last = bottom of sequence; captures durable option-premium history).

---

## 8. Data model (~60 tables, 47 migrations)

Authoritative DDL is in `migrations/`. Tables are created lazily (`CREATE TABLE IF NOT EXISTS`) and migrations are idempotent + count-agnostic in tests.

47 migrations. `positions.position_type` CHECK now includes `'Long Put'` and `'Long Call'` (migration 036). `batch_runs` has `trigger TEXT NOT NULL DEFAULT 'manual'` and `slot_time TEXT` (migration 037). Migration 037 also shifted all `batch_jobs.sequence_order` +1 to reserve position 1 for the orchestrator. Migration 038 adds `replay_briefs` + `replay_outcomes` for Brief Replay; 039 adds `replay_outcomes.close_price`/`close_date`. Migration 040 adds `options_premium_history` (durable daily option-premium capture). Migration 041 adds breakout signals to `technical_signals` (`breakout_state`, `breakout_level`, `breakout_decisiveness`, `volume_surge`, `atr_pct`) for the Inflection strategy. Migration 042 adds `replay_outcomes.direction` (1 long / −1 short) for direction-aware win/return aggregation (needed by inflection's mixed long/short picks). Migration 043 adds `conviction_stocks.in_play` (My Stocks on/off attention flag). Migration 044 adds `backtest_trades.entry_spot`/`exit_spot` (underlying price at trade open/close). Migration 045 adds the **v2 execution subsystem** tables (`exec_config`, `exec_risk_state`, `exec_proposals`, `exec_orders`, `exec_fills`, `exec_positions`, append-only `exec_audit_log`; singleton config/risk-state rows seeded in-migration). Migration 046 adds entry-policy config columns to `exec_config` (`min_composite_score`, `max_new_entries_per_day`/`_week`, `avoid_earnings_before_expiry`, `entry_window_start`/`_end`, `reprice_tolerance_pct`). Migration 047 adds `exec_orders.position_id` (links an order to the position it opens/closes). Currently **dormant** — created and seeded, but not yet wired to any service/UI (Phase 0 of the execution build; see `Requirements/v2-execution/` and §11). Domain types in `src/shared/types.ts` (`Exec*`). Tests: `tests/exec-schema.test.ts`.

| Domain | Tables |
| --- | --- |
| Core | `schema_version`, `watchlists`, `watchlist_items`, `settings` |
| Screener | `constituents`, `constituents_meta`, `screen_presets`, `screen_runs`, `screen_results` |
| Analysis / pipeline | `analysis_snapshots` (+ `_v2` with nullable watchlist), `job_runs`, `job_progress` |
| Cache | `fundamentals_cache` (24h), `quote_cache` (60s), `options_cache` (5min), `cache_metadata` |
| Historical | `historical_financials`, `historical_prices` |
| IV | `iv_history` (one row per ticker per trading day; 30-day ATM IV) |
| Portfolio | `positions`, `position_analysis`, `advisor_sessions` |
| Options strategy | `leaps_csp_runs`/`_opportunities`/`_opened`, `collared_leaps_runs`/`_opportunities`/`_opened`, `payoff_strategies` |
| Options premium history | `options_premium_history` (one row per as_of_date+ticker+strategy; wheel/income strike+premium+IV; never pruned). Readiness surfaced in Brief Replay via `getPremiumHistoryReadiness()` / IPC `replay:premium-history-readiness` |
| Backtest | `backtest_configs`, `backtest_runs`, `backtest_trades`, `backtest_metrics` |
| Alerts | `alerts` |
| Batch | `batch_jobs` (incl. `config_json`, `sequence_order`), `batch_runs` |
| Scoring / brief | `scoring_strategy_configs`, `daily_briefs`, `technical_signals`, `brief_learning_recommendations` |
| Brief Replay | `replay_briefs` (UNIQUE as_of_date + strategy), `replay_outcomes` (forward returns, synth strike) |
| Paper trading | `paper_trades`, `paper_trade_snapshots` |
| Conviction | `conviction_stocks` (incl. `in_play` flag), `conviction_band_history`. Email via `ConvictionService.buildEmailReport()` / IPC `conviction:send-email` |
| Agent | `agent_trade_learnings` |
| News | `news_research_cache`, `macro_events` |
| Earnings | `earnings_calendar` |

---

## 9. Conventions (summary — full rules in /CLAUDE.md)

- TypeScript strict; no `any` (use `unknown` + guards). Functional React components only.
- All DB access via `withTransaction(db, fn)` — never `db.transaction(fn)()` directly.
- All market data via `DataProvider` / `OptionsProvider` — never ad-hoc `fetch` to a provider.
- Every derived financial metric carries a `// see docs/formulas.md#anchor` comment + a `docs/formulas.md` entry.
- IV stored/displayed as a percentage (38.82); E*Trade returns a decimal — `×100` on ingest.
- Monetary values USD, per share. DTE is calendar days.
- Conventional Commits. Every material change bumps version + updates `CHANGELOG.md` + `changelogs/v{version}_{date}.md` + this file, in one commit. Bug fixes ship a regression test. After committing, run `npm run package`.

---

## 10. Known quirks & gotchas

- **better-sqlite3 ABI flips** between Node and Electron. `npm run predev`/`prebuild`/`prepackage` swap the Electron binary; `pretest` swaps the Node binary. `NODE_MODULE_VERSION 128 vs 137` = wrong binary; run the matching `rebuild:*` script. Don't switch back to `electron-builder install-app-deps` — it reported success without actually swapping the ABI.
- **`package.json` must never be written by PowerShell `Set-Content -Encoding utf8`** — it writes a UTF-8 BOM that electron-vite chokes on. Use the Edit tool or Node to rewrite it. Strip a stray BOM with the Node one-liner in §10 of the old notes if needed.
- **`npm run package` needs Windows Developer Mode ON** (Settings → System → For developers). electron-builder downloads `winCodeSign` which contains macOS symlinks; non-admin symlink creation is blocked otherwise. One-time setup.
- **`window.api` is declared only in `src/renderer/src/global.d.ts`.** Never redeclare per-file (TS2717).
- **`ELECTRON_RUN_AS_NODE` guard** in the `dev` script prevents the CJS/ESM mismatch crash.
- **`node:fetch` does not exist** in Node 24 — use the global `fetch`.
- **E*Trade IV is a decimal fraction**; **E*Trade dates are UTC** → a Thursday-evening ET earnings report shows as Saturday UTC. `earnings-service.ts` shifts Saturday → Friday and marks it unconfirmed.
- **IV rank/percentile are null** from the Polygon snapshot — computed from `iv_history`, which requires the MarketData.app/IVolatility backfill to be populated first.
- **Brief scoring reads fundamentals from `fundamentals_cache`** (not `screen_results`) — decoupled from screener run scope. Sector stored as Polygon SIC descriptions (lowercase, e.g. "electronic computers"). `loadSectorMomentum` uses `sectorStringToEtf()` keyword-match fallback (covers ~58% of tickers) after checking the exact `SECTOR_ETF` GICS-name map. `leverageQuality`/`leverageRisk` fall back to `debtToEquity * 2.5` when `netDebtToEbitda` is null (~9% coverage → ~30%).
- **`breakevenDistancePct` in critic-service.ts**: `netCredit` is per-contract (×100 shares), dividing by per-share `price` already gives the % — do NOT also `* 100`. See `docs/formulas.md#breakeven-distance`.
- **Brief liquidity gate (`hasAdequateLiquidity`)**: returns `true` only when `labResult === null` (validation failed, can't gate). If the lab ran but all relevant structures have `unavailableReason`, it returns `false` (no valid structure = gated out). Previously this case returned `true`, letting F-grade picks like VRT-PMCC through.
- **Earnings penalty (Stage 3)**: `loadEarningsPenalty()` applies −20 composite points for candidates with earnings in the next 45 days, for all short-premium strategies (`EARNINGS_PENALTY_STRATEGIES` = income, wheel, bearish — naked short legs through an earnings event). Inflection is deliberately **not** penalised (defined-risk credit spread). Re-sorts each penalised list so earnings-risk picks fall below clean alternatives.
- **`annualizedReturn()` units (analysis-service.ts)**: premium and strike are both per-share — `premium / strike × (365/dte) × 100`. Do NOT divide by `strike × 100` (per-contract collateral): that understates 100× and zeroes the wheel `premiumYield` (wt 19) and income `premiumRiskRatio` (wt 22) signals, which then rank both strategies on IVR alone and float earnings-pumped names to rank 1. Fixed v0.32.67; `analysis_snapshots` values self-correct on next refresh.
- **Critic LLM rate-limit**: 25 concurrent Anthropic calls per brief hit rate limits (~50% failure). Now runs one strategy batch (≤5 picks) at a time via `for…of assembledPicks { await Promise.allSettled(picks.map(…)) }`. `low_liquidity` severity is `info` (not `warning`) so borderline picks produce `caution`, not `flag`.
- **Critic structure selection is shared**: `selectRelevantStructure()` (first strategy-relevant score with valid setup) is used by `checkLiquidity`, `getStructureExpiry`, and the LLM context builder — they must reference the SAME structure or the prompt contains contradictory numbers (observed: HAYW flag said liq 5/15, context said 3/15; the LLM called it out). `low_liquidity` threshold is `< 4` (4–6 is normal for single names). `GRADE_RANK` includes `'A+': 6` — a missing key ranks 0, below F.
- **Buy is stock-first**: buy's relevant structures are all debit and grade C/F systematically in high-IV regimes. `CriticService.shouldPresentAsStock()` (no relevant structure ≥ B) suppresses `poor_structure_grade`, adds a `presentation` note to the LLM context, and `DailyBriefView.presentAsStock()` (mirror logic) shows `📈 Buy Shares` with the structure as "Optional".
- **Critic prompt: info flags are advisory** — FLAG SEVERITIES section states a pick whose only flags are info-severity can still merit `pass`; only warning-severity flags must be addressed. Without this, any info flag (e.g. liquidity) structurally capped the verdict at `caution`.
- **Critic context must exclude `unavailableReason` structures**: `synthesizeVerdict` and `getStructureExpiry` use `s.setup != null && !s.setup.unavailableReason` — a structure with `unavailableReason` has a non-null setup object, so the naive `setup != null` check would select ghost data (no legs, no strike) instead of the actual valid structure.
- **`checkStructureGrade` rule** fires `warning` when all valid (non-unavailable) strategy-relevant structures are grade F. Uses `GRADE_RANK = { A:5, B:4, C:3, D:2, F:1 }`. Catches picks like VRT where the options chain exists but no structure is viable.
- **Critic prompt calibration**: `pass` is explicitly defined ("no material concern — use this when you cannot identify a specific, non-generic issue"). Output is 1–2 sentences (single sentence allowed for clean picks). Without this, the adversarial framing caused the LLM to give `caution` even for picks with 0 rule flags.
- **`technical_signals` now includes `adx` and `support_level`** (migration 035) — populated by `DailyTechnicalSignalsJob`. `loadTechnicalSignals()` uses these to fill `trendStrengthAdx` (income `trendNeutral` signal) and `entryZoneLow` (buy `breakoutScore`) as batch-job fallbacks.
- **Scoring engine v3 (baseline_v3)**: `trendAlignment` signal added to Buy (wt 10) and Bullish (wt 7); `notDowntrend` added to Wheel (wt 8). Derived from `trendLabel` (analysis_snapshots) or SMA50/200 stack (technical_signals). `seedBaselines()` auto-upgrades v1/v2 → v3 on startup. Bearish and Income unchanged.
- **Daily Brief auto-creates `DailyBrief-MMDD` watchlist** — at end of each brief run, all final picks (all 6 strategies, post-liquidity-gate) are upserted into a watchlist named e.g. `DailyBrief-0608`. Existing items are cleared on refresh. Notes field shows strategies per ticker (`wheel · buy`). Uses new `WatchlistService.findByName()` / `clearItems()` methods.
- **Retrospect has a "Brief Trend" tab** — drill into any brief date; table shows per-pick: brief price, Day 1–5 closing prices (first 5 trading days, ⏳ while pending), return % to latest available day, outcome, critic verdict with rationale tooltip. `getBriefPickDrilldown` queries `historical_prices` directly via `ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date)` — no `paper_trade_snapshots` dependency. `BriefPickDetail` fields: `day1–5Price`, `returnPct`, `latestVerdict`. IPC `paper:brief-dates` + `paper:brief-pick-drilldown`.
- **Daily Brief header has two data banners**: B-01 shows prior brief's Day+5 hit-rate + avg return per strategy (`paper:brief-performance-summary` → `getBriefPerformanceSummary()` in `paper-trading-service.ts`); B-02 shows critic pass-rate trend over last 7 briefs per strategy with directional arrow (`scoring:brief-health-trend` → `getBriefHealthTrend()` in `scoring-service.ts`). Both are non-fatal and silently absent when no data exists.
- **E*Trade serves stale Greeks on thin (OI=0) chains** — option prices stay live but deltas can be computed at a months-old spot (WSO 2026-06-10: delta −0.50 at $450, spot $375.66). Strategy Lab resolves the underlying via `resolveUnderlyingPrice()`: `chain.underlyingPrice` (E*Trade real-time spot) → `DataProvider.getQuote()` → chain-delta estimate. If the delta-implied ATM deviates >8% from real spot, `trustDeltas=false` and leg selection uses moneyness, never deltas. Critic rule `stale_lab_price` (warning) fires at >5% lab-vs-live price deviation.
- **Critic service has 13 deterministic rule checks** in `runRuleChecks`: `trendAlignment`, `liquidity`, `criticalSignalMissing`, `scoreConcentration`, `crossStrategyConflict`, `marketRisk` (incl. bearish-vs-SPY-uptrend mirror → `info`), `anomalousMomentum` (priceMomentumPct > 500% → `info`, catches spinoff/relisting data artifacts), `earningsInWindow` (earnings before expiry → `warning`, always-on — not just LLM context), `structureGrade`, `highVolNakedStructure` (income: `short-straddle`/`short-strangle` + priceMomentumPct > 100% → `warning` `high_vol_naked_structure`; straddles require range-bound stock), `thinBreakeven` (income/wheel: `|netCredit|/price < 2.0` → `warning` `thin_breakeven`; 2% breakeven is insufficient cushion), `counterTrendStrike` (bearish short strike at/below price + SPY bullish → `warning`), `labPriceConsistency` (lab underlyingPx vs live price >5% → `warning` `stale_lab_price`). `strikeOtmPct` in the LLM context block uses `(strike - price) / price` — defined side-aware in the prompt (positive = strike above spot = OTM for calls but ITM for puts; the naive "positive = OTM" gloss made the LLM pass a broken +31% straddle).
- **Brief Replay charts**: `BriefReplayService.getChartData()` aggregates all `replay_outcomes` server-side (regime splits, score quintiles, rank averages, per-ticker stats, monthly HR) and returns `ReplayChartData`. The renderer's `ReplayChartsModal` (5 tabs: Performance / Regime / Monthly / Score Signal / Tickers) shows this via the `replay:get-chart-data` IPC. Bearish (and inflection, both directions) HR/sort is direction-aware via `replay_outcomes.direction`; all 6 strategies render in every chart (incl. Monthly + Score Signal). `Charts` button appears in `BriefReplayView` when `summaries.length > 0`.
- **Briefing candidate SQL price floor**: `BriefingService` candidate query includes `CAST(lastPrice AS REAL) >= 5` — matches the Brief Replay job filter. Sub-$5 penny stocks (e.g. NWL) are excluded.
- **Bearish composite quality gate (≥70)**: `minCompositeForStrategy(strategy)` in `scoring-service.ts` returns `{ bearish: 70 }`, else 0. Applied at the Stage-4 pool filter (`daily-intelligence-brief-job.ts`, before E*Trade validation) and at replay pick selection (`brief-replay-service.ts`). Full-year replay shows sub-70 bearish picks lose money with ~0 SPY alpha; ≥70 picks have −3.3% alpha (real short edge). Rank-agnostic and self-suppresses bearish on weak days (~42% of dates yield zero picks). **The earlier SPY-regime gate (v0.32.90) was reverted** — the actionable entry-time version (SPY vs 50-day SMA) *inverted* on full-year data (bear-regime bearish did worse, −6.7%), so it was a 5-month artifact. `BriefReplayService.computeSpyRegimes()` survives only to feed the descriptive Regime chart tab — it drives no filter or badge.
- **Earnings & analyst data** are E*Trade-sourced (earnings) / Polygon-sourced; no Polygon public earnings endpoint exists.
- **Production DB path**: packaged → `app.getPath('userData')/trade-analyzer.sqlite` (`%AppData%/trade-analyzer/`); dev → `<appPath>/data/`.
- **Live-DB inspection needs a write-capable connection** — `readonly: true` on Windows can't attach the WAL's `-shm` index and silently reads only pre-checkpoint state (recent writes look missing for minutes). Use `new Database(path)` for ad-hoc queries while the app runs; plain SELECTs are safe in WAL mode.
- **Batch Orchestrator** (`batch-orchestrator-job.ts`, id `batch-orchestrator`) is the only job that should have a schedule. Its schedule slots live in `config_json.scheduleSlots` (string array of `'HH:MM'` ET times); `daily_schedule_time` is kept as a display fallback. The `checkSchedule()` multi-slot path fires each slot at most once per day (tracked via `batch_runs.slot_time`). All other jobs should have their individual schedules disabled. The orchestrator calls sub-jobs via `BatchService.runJobDirect()` (no mutex, no notifications). "Run All in Sequence" button excludes the orchestrator (`id !== 'batch-orchestrator'` filter). Remote trigger via `POST /api/v1/orchestrator/run` (X-Agent-Token auth) returns immediately; poll `GET /api/v1/orchestrator/status`.
- **`batch_runs.trigger`** (`'manual'|'schedule'|'startup'`) and **`batch_runs.slot_time`** are set on every run including sub-jobs called by the orchestrator (they inherit the orchestrator's trigger and slot_time).
- **Option P&L is priced at the modeled fill, not mid** (`options-fill.ts` `fillPrice`, `SLIPPAGE_FRACTION=0.5`): sells fill below mid toward the bid, buys above toward the ask, by 0.5×half-spread. Used by Strategy Lab `buildSetup` net credit/debit and wheel/income `premium` (which **replaced the old `premium = mid/2` placeholder** — wheel/income premiums are now higher/realistic, which shifted their scoring rankings and the `options_premium_history` capture). `docs/formulas.md#fill-model`.
- **Liquidity scores weigh same-day volume** (v0.32.97): Strategy Lab `liquidityScore` (0–15) = spread 8 / OI 4 / volume 3; wheel `optionLiquidityScore` (0–10) = OI 4 / spread 4 / volume 2. `SetupLeg` has a `volume` field. Brief hard gate still drops best relevant structure `<5/15`. `docs/formulas.md#liquidity-score`.
- **Fake-timer tests** use `flushTimersUntil()`, not `vi.runAllTimers()` (the rate limiter's promise chain won't drain otherwise).

---

## 11. Open decisions

- **Brief Replay (point-in-time brief backtest)**: spec'd in `Requirements/BRIEF_REPLAY_SPEC.md` (2026-06-11). Replays the brief for past dates using bars/iv_history `<= asOf` and EDGAR facts filtered by `filed <= asOf` (true point-in-time fundamentals — no history table needed); same ScoringService/configs; structures skipped or synthesized (no historical E*Trade chains); outcomes from forward bars into new `replay_briefs`/`replay_outcomes` tables. Open questions in spec §8 (iv_history depth, stage-4 option, output surface).
- ~~**Second expiration fetch for PMCC/calendar (Strategy Lab)**~~ — DONE (v0.32.96). The lab fetches a far chain (~120 DTE) via `selectFarExpiration` + `fetchFarChain`; `buildSetup` builds PMCC/PMCP/calendars across two expirations; calendar/diagonal max profit via Black-Scholes (`black-scholes.ts`, `docs/formulas.md#calendar-diagonal-pnl`). One extra E*Trade chain call per `validate()`.
- **Real income/wheel ROC view (deferred until data matures)**: `options_premium_history` (v0.32.94) accumulates real CSP/CC premium daily; the Brief Replay readiness banner (v0.32.95) flips to "ready" at ~40 matured days (≈ a quarter out). When ready, build a true income/wheel ROC analysis off `options_premium_history` joined to forward `historical_prices` (premium kept if expired OTM, else assignment P&L) — replaces the stayed-above-strike proxy. Could also feed real income/wheel ROC into Brief Replay outcomes.
- **Inflection strategy — COMPLETE (both directions)**: SHIPPED v0.32.98–v0.33.1. `inflection` is a live 6th `ScoringStrategy` (`BASELINE_INFLECTION`: breakoutDecisiveness 30 / volumeSurge 25 / breakoutIvRank 25 / breakoutAtrPct 20; gated on `hasBreakout` = `breakout_state===±1`, both directions). Signals on `technical_signals` (migration 041), read in `loadTechnicalSignals` (live) + point-in-time in `brief-replay-service`. Structure = `short-put-vertical` (up→bull put) / `short-call-vertical` (down→bear call); critic + renderer pick the higher-graded. Replay is direction-aware via `replay_outcomes.direction` (migration 042): win/HR uniform `COALESCE(direction, strategy-implied)`, inflection avg + charts direction-adjusted. Open tuning (not blocking): no inflection min-composite gate or earnings penalty yet — add after observing live behavior. Offline validation: top-quintile breakout credit spreads expire OTM ~84–90%; high-IV filter ~free.
- **Backtest integration — DONE (both phases)**: phase 1 (v0.33.7) = `navigate-to-backtest` deep-link from My Stocks + Brief wheel/income picks (pre-fills `BacktestView`). The engine prices off `iv_history` ATM IV with realized-vol fallback (v0.33.8, `docs/formulas.md#backtest-iv`). Phase 2 (v0.34.0) = `BacktestEngine.backtestReplayPicks(strategy)` simulates one CSP per historical replay pick (`simulateSingleCsp`) and pools into `AggregatePickBacktest`; surfaced via the 💰 P&L button on the Brief Replay summary rows (IPC `backtest:replay-picks`, modal with metrics + cumulative-**dollar** equity curve + $ drawdown). This is the **real option P&L** layer Replay's stock-return columns lack. Inflection (v0.34.9) runs `simulateSingleSpread` (bull put/bear call, defined-risk); `structure ∈ csp | credit-spread | stock`. Directional strategies buy/bullish/bearish (v0.34.10) have no option structure → `structure='stock'`: a fixed **$10k** position per pick (`STOCK_NOTIONAL`, long; short for bearish) marked at the replay's 21-day forward close (`ret_21d`/`close_date`), so buy-vs-bullish is dollar-comparable; carries `notionalPerTrade`. **Possible follow-ups (not blocking)**: a full portfolio model with capital constraints (current model is equal-weight, unconstrained); persist aggregate results.
- **v1.0.0 cut — DONE (2026-06-14)**: bumped 0.34.10 → 1.0.0 as the line between v1 (decision-support, read-only at broker — feature-complete) and v2 (automated execution). No behavior change in the cut itself.
- **v2: automated execution subsystem (NEW — requirements phase)**: the app moves from recommend-only to placing/closing real trades. Locked design decisions (2026-06-14): **(a) Headless execution core + Electron control panel** — execution + a continuous position-management loop run in an always-on service (sharing service code / the local Fastify API at 127.0.0.1:7432); the Electron UI is a control surface that survives the window being closed. **(b) Semi-auto (approve-each)** — the core *proposes* every order; the user *confirms* before it goes live (no autonomous entry in v2.0). **(c) Segregated IBKR account** — the bot trades a dedicated, ring-fenced IBKR balance (paper first via the same API, then real ~$10k), kept separate from E\*Trade manual positions. **(d) Risk governor lives in-app, fail-closed** — pre-trade gate (max $/trade, max daily loss + kill switch, max concurrent/per-ticker/per-strategy caps, buying-power check), an idempotent order state machine (client order IDs), and a position-reconciliation loop against actual broker fills. New `ExecutionBroker` interface mirrors the switchable `OptionsProvider` pattern (paper vs live = config). New state: `exec_*` tables (`exec_config`, `exec_risk_state`, `exec_proposals`, `exec_orders`, `exec_fills`, `exec_positions`, append-only `exec_audit_log`; migration 045 — **Phase 0 DONE/dormant**, see §8). **Requirements DONE & committed** in `Requirements/v2-execution/` (kept separate from `spec/`, which is authoritative for what *exists*; graduates into a `spec/` 40-series as each piece ships): `00-overview` (scope, invariants, IBKR logistics, master Stop=hard-stop), `01-architecture` (headless core via `ELECTRON_RUN_AS_NODE`, `ExecutionBroker` iface, IBKR/`@stoqey/ib`+IBC, 3 loops, control API `:7433`+SSE, disjoint-write-set DB coexistence + data-freshness invariant), `02-risk-governor` (locked limits **$10k / 5% per-trade / 5 concurrent / 10% daily-trip / 1-per-ticker**; fail-closed pre-trade gate; kill switch realized+unrealized halt-only + manual clear; engine state machine; idempotency; reconciliation; full `exec_*` DDL), `03-lifecycle` (entry: inflection brief picks, critic pass/caution, composite≥70, 1/day+3/week; exit: protective-auto 2×-credit stop + defensive-expiry, discretionary-propose 50% profit-target + ~day-5/midpoint planned exit), `04-ux` (Execution section: Trading Desk + Settings; PAPER/LIVE badge; semi-auto approval paper-1click vs live-type-to-confirm; guarded paper→live promotion; headless email/push notifications), plus `05-implementation-plan` (phased build order; phases 0–5 buildable+testable now against a MockExecutionBroker with no IBKR account; phases 6–7 plug in the real IBKR adapter once the paper account approves). **Launch scope: inflection-only, defined-risk-only, paper-first.** IBKR app submitted (Pro, Individual, Reg-T margin, Options Level 3, Non-Professional; ~24h approval). **Build progress: Phase 0 (schema, v1.1.0) + Phase 1 (`ExecutionBroker` iface + `MockExecutionBroker`, v1.1.1) + Phase 2 (risk governor: `risk-gate.ts` pure sizing/10-check gate + `risk-governor.ts` DB-backed engine state machine/kill switch/day-P&L trip/COID/audit, v1.1.2) + Phase 3a (`market-hours.ts` RTH gate + `reconciliation.ts` broker-truth sync/drift + `execution-core.ts` `ExecutionCore`: cold-start reconcile-before-act, management cycle w/ market gate + fail-closed disconnect + trip-on-drift + market-cycle hook for Ph4 + health watchdog + event stream, v1.1.3) + Phase 3b (`control-api.ts` `ExecutionControlApi`: Fastify :7433 token-authed, engine control + state/config/risk/positions/audit reads + `/exec/brief-ready` handoff + `/exec/events` SSE, v1.1.4) DONE — all in `src/main/execution/`, dormant. + Phase 4a (migration 046 entry config + `entry-policy.ts` `EntryPolicy`: filterPick/buildProposal price→size→gate→persist/generateEntries w/ daily-weekly caps, on a normalized `PickInput`, v1.1.5) DONE — all in `src/main/execution/`, dormant. + Phase 4b (migration 047 `exec_orders.position_id` + `order-manager.ts` `OrderManager`: approveProposal re-gates→COID order→fill callbacks open exec_positions; submitClose reverses legs; idempotent COID + fill dedup; drives order state machine + audit, v1.1.6) DONE — all in `src/main/execution/`, dormant. Next: Phase 4c = `ExitPolicy` + management loop wired into ExecutionCore's market-cycle hook, then Phase 5 = Electron Trading Desk UI. All buildable against the mock; Phases 6–7 (IBKR adapter + paper validation) need the account.**
- **Requirements/ and UserManual/ expansion**: queued after the documentation refresh (items #2 and #3 of the docs task).
- Wheel suitability formula and portfolio Greeks math are documented in `docs/formulas.md`.
