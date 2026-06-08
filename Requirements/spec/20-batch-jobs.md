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
| `daily-iv-update` | `DailyIvCaptureJob` | — | yes (~30s) | Capture today's ATM IV per ticker into `iv_history` (§11). Auto-renews dormant E*Trade tokens; surfaces a Reconnect CTA on hard expiry. |
| `daily-market-sync-stocks` | `MarketSyncJob('both')` | 16:30 | +60s | `syncUniverse('both')` → refresh `quote_cache` + `fundamentals_cache` for S&P 500 + Russell 1000. |
| `daily-market-sync-etfs` | `MarketSyncJob('etf')` | 16:30 | +90s | Same for the ETF universe (chains after stocks via the mutex). |
| `daily-screener` | `DailyScreenerJob` | 16:30 | +110s | Two passes (stocks strict, ETFs soft) → `screen_runs` rows for the Screener UI. |
| `daily-price-gap-fill` | `PriceGapFillJob` | 16:30 | +120s | Backfill stale `historical_prices`; also bootstraps SPY + 11 SPDR sector ETFs (6M bars) for scoring signals. |
| `daily-technical-signals` | `DailyTechnicalSignalsJob` | 16:30 | +150s | Compute MACD/RSI/Bollinger/SMA-stack/patterns + buy-signal score → `technical_signals` (§13). |
| `daily-intelligence-brief` | `DailyIntelligenceBriefJob` | 16:30 | manual | The 6-stage brief pipeline + critic + email/PDF + paper-trade capture (§14, §15). |
| `daily-options-snapshot` | `DailyOptionsSnapshotJob` | 06:00 | +300s, runOnStartup | Nightly Wheel `analyzeTicker(forceCache)` over the universe → keeps `optionLiquidityScore`/`atm_iv` fresh; saves global `analysis_snapshots`. |
| `daily-paper-snapshot` | `DailyPaperSnapshotJob` | 17:00 | — | EOD close snapshot per open paper trade → `paper_trade_snapshots` (§15). |
| `earnings-refresh` | `EarningsRefreshJob` | 16:00 (disabled by default) | +60s | Smart-cached earnings refresh over `constituents` (§17). `callDelayMs` default 500. |
| LEAPS+CSP screener | `leaps-csp-service` run | configurable | — | Optional scheduled LEAPS+CSP screen (§10). |

Jobs probe connectivity (e.g. `getOptionsExpirations('SPY')`) and return `status: 'skipped'` rather than hanging when the options provider is unavailable; per-ticker work is wrapped in a timeout so an expired token can't freeze a run.

## 20.4 Startup behavior

On Windows the app auto-launches at login and acquires a single-instance lock (a second launch focuses the existing window). Startup jobs fire after their delays; the 16:30 chain and the 06:00 snapshot keep all caches warm without user action.
