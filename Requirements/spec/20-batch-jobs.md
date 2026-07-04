# 20 — Batch Jobs & Scheduler

A background scheduler runs the daily data-maintenance and intelligence jobs that keep every other feature reading warm local data instead of making live calls. Service: `batch-service.ts` (+ handlers in `services/jobs/`). IPC: `window.api.batch.*`. View: `BatchView.tsx` (🔄 Batch Jobs). Tables: `batch_jobs`, `batch_runs` (§2.13).

## 20.1 Scheduler model

- Jobs are registered in `index.ts` via `registerJob(id, handler, opts?)` where `opts` ∈ `{ runOnStartup, startupDelaySeconds, dailyScheduleTime, defaultConfig }`. `defaultConfig` is seeded into `batch_jobs.config_json` on first registration and backfilled for existing rows where it's null.
- Each handler implements `BatchJobHandler.run(onProgress, signal, force?) → BatchJobResult`. `BatchJobResult` may include a custom `notification` (e.g. an auth-expiry CTA).
- **One-at-a-time mutex.** Jobs scheduled at the same time **chain** sequentially in `sequence_order` (e.g. all the 16:30 jobs run back-to-back). The scheduler cleans up stale `running` rows on startup; cancel writes `cancelled` immediately and frees the slot.
- A global in-memory **enable toggle** (`setEnabled/getEnabled`, defaults ON each launch) blocks startup + scheduled runs; manual "Run Now" still works.
- Per-job config (e.g. `callDelayMs` rate spacing) is editable in the Edit modal, which also shows a live run-time estimate.

IPC: `listJobs`, `listRuns(jobId)`, `runNow(jobId)`, `runNowSync(jobId)`, `cancel(jobId)`, `updateJob(jobId, patch)`, `reorderJobs(jobIds[])`, `setEnabled`, `getEnabled`, `onProgress`, `onNotification`.

## 20.2 Live activity panel

While a job runs, `BatchView` streams a per-ticker log between the job table and run history: spinner header, live counters (✓ updated / — skipped / ✗ failed), animated progress bar, and a scrollable monospace ticker log (max ~300 events, auto-scroll, auto-clears 3s after completion). Run History is capped (≈10 rows, internal scroll, sticky header).

## 20.3 Registered jobs

| Job id | Handler | Schedule (ET) | Startup | Purpose |
| --- | --- | --- | --- | --- |
| `daily-iv-update` | `DailyIvCaptureJob` | — | yes (~30s) | Capture today's ATM IV per ticker into `iv_history` (§11). Connectivity probe **renews-and-retries once on ANY failure** (a dormant token can die as a terminated/hung stream, not a clean 401 — v1.1.92); surfaces a Reconnect CTA only on true midnight hard expiry. |
| `constituents-refresh` | `ConstituentsRefreshJob` | 16:25 (orchestrator seq 2 — first sub-job) | — | Auto-refresh S&P 500 + Russell 1000 membership from **Vanguard fund holdings** (VOO/VONE public JSON, Wikipedia fallback), both **gated** (row-count floor 480/940; ≤25% turnover) so a broken feed can never wipe a good list; sector/company preserved for carried-over tickers. Diffs membership and **bootstraps 1Y Polygon daily bars for added tickers** with no history (quotes/fundamentals follow via Market Sync the same run; `iv_history` accumulates from daily capture — IV rank appears after 21 trading days — or manual IVolatility backfill). A source outage returns `success` + warning note (stale list is usable; a `failed` sub-job would halt the orchestrator chain). Migration 063 shifted other jobs' `sequence_order` +1. |
| `daily-market-sync-stocks` | `MarketSyncJob('both')` | 16:30 | +60s | `syncUniverse('both')` → refresh `quote_cache` + `fundamentals_cache` for S&P 500 + Russell 1000. |
| `daily-market-sync-etfs` | `MarketSyncJob('etf')` | 16:30 | +90s | Same for the ETF universe (chains after stocks via the mutex). |
| `daily-screener` | `DailyScreenerJob` | 16:30 | +110s | Two passes (stocks strict, ETFs soft) → `screen_runs` rows for the Screener UI. |
| `daily-price-gap-fill` | `PriceGapFillJob` | 16:30 | +120s | Re-fetch the recent daily-bar window for **every** ticker with history (+ bootstrap SPY + 11 SPDR sector ETFs). `historical_prices` is `INSERT OR REPLACE` on (ticker, date), so re-running **overwrites** an existing same-day bar — the after-close run replaces the morning run's partial intraday bar with the finalized close. (It does **not** gate on `MAX(date) < today`; that gate previously made the evening run skip a ticker that already had a partial morning bar — see §20.5.) |
| `daily-technical-signals` | `DailyTechnicalSignalsJob` | 16:30 | +150s | Compute MACD/RSI/Bollinger/SMA-stack/patterns + buy-signal score → `technical_signals` (§13). |
| `daily-intelligence-brief` | `DailyIntelligenceBriefJob` | 16:30 | manual | The 6-stage brief pipeline + critic + email/PDF + paper-trade capture (§14, §15). |
| `daily-options-snapshot` | `DailyOptionsSnapshotJob` | 06:00 | +300s, runOnStartup | Nightly Wheel `analyzeTicker(forceCache)` over the universe → keeps `optionLiquidityScore`/`atm_iv` fresh; saves global `analysis_snapshots`. |
| `daily-paper-snapshot` | `DailyPaperSnapshotJob` | 17:00 | — | EOD close snapshot per open paper trade → `paper_trade_snapshots` (§15). |
| `earnings-refresh` | `EarningsRefreshJob` | 16:00 (disabled by default) | +60s | Smart-cached earnings refresh over `constituents` (§17). `callDelayMs` default 500. |
| `filters-prefill` | `FiltersPrefillJob` | — (orchestrator only, `afterCloseOnly`) | — | Precompute the configured filter templates over Universe = **All** (S&P + Russell + ETFs, per-ticker ETF calibration) → `filter_template_runs` (latest run per template, shape-versioned) so the Filters view opens pre-populated (§5.B). **Which templates run is an allowlist** in `config_json.enabledTemplates`, defaulting (`DEFAULT_PREFILL_TEMPLATES`, v1.1.115; **plain IV High swapped for IV High (Vetted) v1.1.121**) to the four in regular use — **RSI Oversold, IV High (Vetted), Price Alert, Wheel (Vetted)** — skipping RSI Overbought / IV Low / Assignment Risk / Wheel Opportunity / plain IV High to save time (Wheel Vetted and IV High (Vetted) fetch live chains per survivor). Empty allowlist → `skipped`. Registered last (highest `sequence_order`) — needs fresh caches / `iv_history` / `technical_signals` / earnings, and the wheel/IV-High-Vetted legs hit live E*Trade chains. A failing template is recorded and the loop continues; an aborted scan never overwrites a stored run with partial results. Skipped in the lean intraday slot. **Summary email (v1.1.119, IV list re-sourced v1.1.120)**: when IV High (Vetted) and/or Wheel (Vetted) ran this pass and email is configured, sends one HTML email (`filters-prefill-report-builder.ts`, styled like the Daily Brief email) with the **top 10 IV High (Vetted)** picks (ranked by IV Rank descending, falling back to raw IV % — the vetted template's own gates already excluded downtrends/imminent-earnings/illiquid/vol-bomb names, so this is "best of the good ones," not "best of everything") and **every** Wheel (Vetted) pick (already a small, gated funnel — not capped), sorted by risk-adjusted return descending to match the Filters view's own default sort. Each row is tagged ETF vs Stock; the IV High section also shows OI/Spread (the new liquidity data being vetted on). Skipped (no email) when neither template ran this pass (e.g. a narrower `enabledTemplates` allowlist); email failure never fails the job. Tests: `tests/filters-prefill-report-builder.test.ts`, `tests/filters-prefill.test.ts`, `tests/iv-high-vetted.test.ts`. |
| LEAPS+CSP screener | `leaps-csp-service` run | configurable | — | Optional scheduled LEAPS+CSP screen (§10). |

Jobs probe connectivity (e.g. `getOptionsExpirations('SPY')`) and return `status: 'skipped'` rather than hanging when the options provider is unavailable; per-ticker work is wrapped in a timeout so an expired token can't freeze a run.

## 20.4 Startup behavior

On Windows the app auto-launches at login and acquires a single-instance lock (a second launch focuses the existing window). Startup jobs fire after their delays; the 16:30 chain and the 06:00 snapshot keep all caches warm without user action.

## 20.5 Two daily slots — every job must refresh + overwrite

The orchestrator runs the full chain **twice on a trading day**: an early slot (≈10:15 ET, ~45 min after the open — an intraday opportunity scan) and an after-close slot (≈16:30+ ET — the definitive end-of-day brief). The 90-minute skip window (`SKIP_WINDOW_MS`) is *only* a mid-run resume guard, so the after-close slot **re-runs every job** that the morning slot ran.

**Invariant: each job must fetch the latest data and overwrite anything it wrote in the earlier slot.** A job that instead skips work it "already did today" (e.g. on `MAX(date) = today`) leaves the morning's **partial** intraday data in place — most damagingly a partial daily price bar, on which breakout detection and `volume_surge` (§13, §scoring) are computed. Current write semantics: `historical_prices`, `options_premium_history` → `INSERT OR REPLACE`; `technical_signals`, `iv_history` → `ON CONFLICT DO UPDATE`; `paper_trade_snapshots` → past days immutable, **today** `DO UPDATE` (after-close close overwrites the morning intraday snapshot). The daily-bar window must be **final** by the after-close slot — run it late enough that the data provider has settled the day's bar (≈17:00 ET is safer than 16:30 for a fully-final bar).
