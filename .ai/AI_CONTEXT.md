# AI_CONTEXT — TradeAnalyzer build state

> **Read this first.** Self-contained snapshot of *what the app is today* so a fresh AI session is productive without re-reading the whole codebase. This file describes **current state** — not history. Release history lives in `CHANGELOG.md` / `changelogs/`. Operating rules live in `/CLAUDE.md`. Full spec lives in `Requirements/`.
>
> Last verified against code: 2026-06-11 (v0.32.77). When you make a material change, update the relevant section here in the same commit.

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
| **Polygon.io** (Stocks Starter) | Quotes, fundamentals, historical OHLCV bars, financials, news headlines | `DataProvider` → `polygon-provider.ts` |
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
  ipc/ipc-*.ts              27 IPC handler modules (one per feature area)
  services/                  60 service classes (see §7)
  services/jobs/             9 batch job handlers
src/preload/index.ts        window.api.* bridge (33 namespaces)
src/renderer/src/
  App.tsx                    Sidebar routing + layout + status bar + cross-view nav events
  views/                     26 feature views (see §6)
  global.d.ts                window.api type declaration (ONLY place it's declared)
  knowledge/                 Embedded tastylive strategy guide (images + JSON)
  styles.css
src/shared/types.ts         All cross-process types
migrations/                  34 numbered SQL migrations
docs/                        architecture.md, data-provider.md, formulas.md, troubleshooting.md
Requirements/                Spec + per-feature design docs
changelogs/                  Per-version notes
```

---

## 6. Views & sidebar (26 views, 8 sections)

Routing is a `currentView` string in `App.tsx`; cross-view navigation fires CustomEvents (`navigate-to-payoff`, `navigate-to-validate`, `navigate-to-analysis`, `navigate-to-options`).

| Section | Views |
| --- | --- |
| **Data** | ⚙ Settings · ⚖ Trade Scoring (`TradeScoringView`) · 🔄 Batch Jobs (`BatchView`) |
| **Intelligence** | 📋 Daily Brief (`DailyBriefView`) · 🪞 Retrospect (`RetrospectView`) · 📅 Earnings (`EarningsCalendarView`) · 📡 News & Research (`NewsResearchView`) · 🤖 Agent (`AgentView`) |
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

**Batch jobs** (`services/jobs/`, registered in `index.ts`): `batch-orchestrator-job` (sequence 1) · `daily-iv-capture` · `daily-market-sync-stocks`/`-etfs` (`market-sync-job.ts`) · `daily-screener-job` · `price-gap-fill-job` · `daily-technical-signals-job` · `daily-intelligence-brief-job` · `daily-options-snapshot-job` · `daily-paper-snapshot-job` · `earnings-refresh-job`.

---

## 8. Data model (~50 tables, 34 migrations)

Authoritative DDL is in `migrations/`. Tables are created lazily (`CREATE TABLE IF NOT EXISTS`) and migrations are idempotent + count-agnostic in tests.

37 migrations. `positions.position_type` CHECK now includes `'Long Put'` and `'Long Call'` (migration 036). `batch_runs` has `trigger TEXT NOT NULL DEFAULT 'manual'` and `slot_time TEXT` (migration 037). Migration 037 also shifted all `batch_jobs.sequence_order` +1 to reserve position 1 for the orchestrator — all multi-leg strategy legs are tracked.

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
| Backtest | `backtest_configs`, `backtest_runs`, `backtest_trades`, `backtest_metrics` |
| Alerts | `alerts` |
| Batch | `batch_jobs` (incl. `config_json`, `sequence_order`), `batch_runs` |
| Scoring / brief | `scoring_strategy_configs`, `daily_briefs`, `technical_signals`, `brief_learning_recommendations` |
| Paper trading | `paper_trades`, `paper_trade_snapshots` |
| Conviction | `conviction_stocks`, `conviction_band_history` |
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
- **Earnings penalty (Stage 3)**: `loadEarningsPenalty()` applies −20 composite points for candidates with earnings in the next 45 days, for all short-premium strategies (`EARNINGS_PENALTY_STRATEGIES` = income, wheel, bearish — naked short legs through an earnings event). Re-sorts each penalised list so earnings-risk picks fall below clean alternatives.
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
- **Daily Brief auto-creates `DailyBrief-MMDD` watchlist** — at end of each brief run, all final picks (all 5 strategies, post-liquidity-gate) are upserted into a watchlist named e.g. `DailyBrief-0608`. Existing items are cleared on refresh. Notes field shows strategies per ticker (`wheel · buy`). Uses new `WatchlistService.findByName()` / `clearItems()` methods.
- **Retrospect has a "Brief Trend" tab** — drill into any brief date; table shows per-pick: brief price, Day 1–5 closing prices (first 5 trading days, ⏳ while pending), return % to latest available day, outcome, critic verdict with rationale tooltip. `getBriefPickDrilldown` queries `historical_prices` directly via `ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date)` — no `paper_trade_snapshots` dependency. `BriefPickDetail` fields: `day1–5Price`, `returnPct`, `latestVerdict`. IPC `paper:brief-dates` + `paper:brief-pick-drilldown`.
- **Daily Brief header has two data banners**: B-01 shows prior brief's Day+5 hit-rate + avg return per strategy (`paper:brief-performance-summary` → `getBriefPerformanceSummary()` in `paper-trading-service.ts`); B-02 shows critic pass-rate trend over last 7 briefs per strategy with directional arrow (`scoring:brief-health-trend` → `getBriefHealthTrend()` in `scoring-service.ts`). Both are non-fatal and silently absent when no data exists.
- **E*Trade serves stale Greeks on thin (OI=0) chains** — option prices stay live but deltas can be computed at a months-old spot (WSO 2026-06-10: delta −0.50 at $450, spot $375.66). Strategy Lab resolves the underlying via `resolveUnderlyingPrice()`: `chain.underlyingPrice` (E*Trade real-time spot) → `DataProvider.getQuote()` → chain-delta estimate. If the delta-implied ATM deviates >8% from real spot, `trustDeltas=false` and leg selection uses moneyness, never deltas. Critic rule `stale_lab_price` (warning) fires at >5% lab-vs-live price deviation.
- **Critic service has 11 deterministic rule checks** in `runRuleChecks`: `trendAlignment`, `liquidity`, `criticalSignalMissing`, `scoreConcentration`, `crossStrategyConflict`, `marketRisk` (incl. bearish-vs-SPY-uptrend mirror → `info`), `anomalousMomentum` (priceMomentumPct > 500% → `info`, catches spinoff/relisting data artifacts), `earningsInWindow` (earnings before expiry → `warning`, always-on — not just LLM context), `structureGrade`, `counterTrendStrike` (bearish short strike at/below price + SPY bullish → `warning`), `labPriceConsistency` (lab underlyingPx vs live price >5% → `warning` `stale_lab_price`). `strikeOtmPct` in the LLM context block uses `(strike - price) / price` — defined side-aware in the prompt (positive = strike above spot = OTM for calls but ITM for puts; the naive "positive = OTM" gloss made the LLM pass a broken +31% straddle).
- **Earnings & analyst data** are E*Trade-sourced (earnings) / Polygon-sourced; no Polygon public earnings endpoint exists.
- **Production DB path**: packaged → `app.getPath('userData')/trade-analyzer.sqlite` (`%AppData%/trade-analyzer/`); dev → `<appPath>/data/`.
- **Live-DB inspection needs a write-capable connection** — `readonly: true` on Windows can't attach the WAL's `-shm` index and silently reads only pre-checkpoint state (recent writes look missing for minutes). Use `new Database(path)` for ad-hoc queries while the app runs; plain SELECTs are safe in WAL mode.
- **Batch Orchestrator** (`batch-orchestrator-job.ts`, id `batch-orchestrator`) is the only job that should have a schedule. Its schedule slots live in `config_json.scheduleSlots` (string array of `'HH:MM'` ET times); `daily_schedule_time` is kept as a display fallback. The `checkSchedule()` multi-slot path fires each slot at most once per day (tracked via `batch_runs.slot_time`). All other jobs should have their individual schedules disabled. The orchestrator calls sub-jobs via `BatchService.runJobDirect()` (no mutex, no notifications). "Run All in Sequence" button excludes the orchestrator (`id !== 'batch-orchestrator'` filter). Remote trigger via `POST /api/v1/orchestrator/run` (X-Agent-Token auth) returns immediately; poll `GET /api/v1/orchestrator/status`.
- **`batch_runs.trigger`** (`'manual'|'schedule'|'startup'`) and **`batch_runs.slot_time`** are set on every run including sub-jobs called by the orchestrator (they inherit the orchestrator's trigger and slot_time).
- **Fake-timer tests** use `flushTimersUntil()`, not `vi.runAllTimers()` (the rate limiter's promise chain won't drain otherwise).

---

## 11. Open decisions

- **Second expiration fetch for PMCC/calendar (Strategy Lab)**: the lab fetches one chain (25–45 DTE); two-expiration structures (PMCC, calendars) are stubbed with `unavailableReason`. Making them real requires construction logic in `strategy-lab-service.ts` + one extra E*Trade chain call per ticker (~50/night). Would give buy/bullish strategies a B-grade-capable structure in high-IV regimes. Deferred from the v0.32.67 brief-audit pass.
- **v1.0.0 cut**: pending one week of real usage validation, then bump 0.32.6 → 1.0.0.
- **Requirements/ and UserManual/ expansion**: queued after the documentation refresh (items #2 and #3 of the docs task).
- Wheel suitability formula and portfolio Greeks math are documented in `docs/formulas.md`.
