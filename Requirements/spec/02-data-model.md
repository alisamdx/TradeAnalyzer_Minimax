# 02 — Data Model

All persistence is a single local SQLite database (better-sqlite3), opened once via `openDatabase()` and shared. All writes go through `withTransaction(db, fn)`.

## 2.1 Migration discipline

- Migrations are **numbered SQL files** in `migrations/` (`001_init.sql`, `002_…`, …), applied in order on startup by `db/migrations.ts`.
- The `schema_version` table records applied versions; each migration runs once.
- All `CREATE` statements use `IF NOT EXISTS`; column additions use `ALTER TABLE … ADD COLUMN`. Migrations are **idempotent**, and tests are **count-agnostic** (never assert a specific migration count).
- SQLite validates column names at `prepare()` time even inside `WHERE 0` — never leave dead SQL referencing non-existent columns.
- Timestamps are ISO-8601 text: `strftime('%Y-%m-%dT%H:%M:%fZ','now')`. Dates are `YYYY-MM-DD` text.

## 2.2 Conventions

- Money: USD, REAL, per-share (not per-contract) unless a column name says otherwise.
- IV: stored as a **percentage** (e.g. 35.5) in `positions`, `iv_history.atm_iv` is the exception — it is a **decimal fraction** (0.285 = 28.5%); see §11.
- Booleans are INTEGER 0/1.
- JSON blobs are TEXT columns named `*_json` or `payload_json`.

---

## 2.3 Core (migration 001)

**`schema_version`** — `version INTEGER PK`, `applied_at`.

**`watchlists`** — `id PK`, `name`, `is_default` (the undeletable Default list = 1), `created_at`, `updated_at`. Unique index on `lower(name)` (case-insensitive uniqueness, display casing preserved).

**`watchlist_items`** — `id PK`, `watchlist_id → watchlists (CASCADE)`, `ticker`, `notes`, `added_at`. Unique index on `(watchlist_id, upper(ticker))` (a ticker appears at most once per list).

**`settings`** — `key PK`, `value`. Free-form key/value backing `AppSettings`. Sensitive values are DPAPI-encrypted before storage.

## 2.4 Screener & universe (migrations 002, 010, 018, 019)

**`constituents`** — `(ticker, index_name) PK`, `company_name`, `sector`, `added_at`. `index_name ∈ {sp500, russell1000, etf}`. Defines the scannable universe.

**`constituents_meta`** — `index_name PK`, `refreshed_at`, `source` (`bundled|wikipedia|csv`). Drives the 7-day refresh display.

**`screen_presets`** — `id PK`, `name`, `universe`, `criteria_json` (a `ScreenCriteria`), `is_default`, `created_at`. (018 sets the default preset's universe to `both`.)

**`screen_runs`** — `id PK`, `preset_id`, `preset_name` (denormalized), `criteria_json`, `universe`, `result_count`, `run_at`, `watchlist_id` (added in 010 — links a run to a watchlist source).

**`screen_results`** — `id PK`, `screen_run_id → screen_runs (CASCADE)`, `ticker`, `company_name`, `sector`, `payload_json` (all filter values + pass score).

## 2.5 Analysis pipeline (migrations 002/003, 024)

**`analysis_snapshots`** — `id PK`, `watchlist_id → watchlists`, `mode` (`buy|options_income|wheel|bullish|bearish|all`), `run_at`, `result_count`, `payload_json`. Migration 024 introduces an `analysis_snapshots_v2` variant with a **nullable** `watchlist_id` so global (universe-wide) snapshots can be saved.

**`job_runs`** — `id PK`, `type` (`validate_all|screen_run|analysis_run`), `watchlist_id`, `status` (`pending|running|paused|stopped|completed|failed`), `started_at`, `ended_at`, `total_count`, `succeeded_count`, `failed_count`, `config_json`. Backs the resumable producer/consumer pipeline (§03, §07).

**`job_progress`** — `id PK`, `job_run_id → job_runs (CASCADE)`, `ticker`, `status` (`pending|fetched|persisted|failed`), `error_msg`, `processed_at`. One row per ticker; the resume point.

## 2.6 Caches (migrations 002, 004, 008)

**`fundamentals_cache`** — `ticker PK`, `payload_json` (DerivedRatios + raw summary), `fetched_at`. TTL 24h.

**`quote_cache`** — `ticker PK`, `last`, `prev_close`, `bid`, `ask`, `volume`, `day_high`, `day_low`, `iv_percentile`, `iv_rank`, `current_iv` (added 008), `fetched_at`. TTL 60s.

**`options_cache`** — `(ticker, expiration) PK`, `payload_json`, `fetched_at`. TTL 5 min.

**`cache_metadata`** — single row (`id=1`), `last_screener_run` (unix ms), `record_count`, `updated_at`. Drives the screener staleness indicator.

## 2.7 Historical data (migration 005)

**`historical_financials`** — `id PK`, `ticker`, `filing_date`, `period_type` (`quarterly|annual`), `period_end_date`, and raw statement fields: `revenues`, `net_income`, `gross_profit`, `operating_income`, `earnings_per_share`, `shares_outstanding`, `total_assets`, `total_liabilities`, `shareholders_equity`, `long_term_debt`, `current_assets`, `current_liabilities`, `operating_cash_flow`, `free_cash_flow`, `ebitda`, `currency`, `source`, `fetched_at`. Unique `(ticker, period_end_date, period_type)`. View `v_latest_financials` = most recent quarterly per ticker.

**`historical_prices`** — `id PK`, `ticker`, `date`, `open/high/low/close/volume`, `adjusted_close`, `source`, `fetched_at`. Unique `(ticker, date)`. View `v_latest_price`. This table is the backbone for indicators, scoring signals, paper-trade snapshots, and backtesting. **Bars must be self-consistent and split-adjusted** — Polygon is fetched with `adjusted=true`, but bars are stored incrementally and old ones are never revisited, so a later split leaves a permanent step in the series (measured 2026-08-28: 153 discontinuities across 126 tickers; CRWD −74% in a day on a 4:1 split). `daily-price-gap-fill` runs a repair pass over this table — see `docs/formulas.md#split-adjustment`.

**`price_split_repairs`** (migration 068) — `ticker`, `discontinuity_date` (composite PK), `ratio`, `status` (`repaired` | `confirmed_real`), `bars_rewritten`, `detected_at`, `resolved_at`. Audit trail for the split repair above. `ticker_reuse` (v1.1.141) marks a symbol reassigned to a different company — detected by a >=15x sustained volume-regime shift, unfixable by re-fetching, and handled by **truncating** `historical_prices` + `iv_history` before the splice so consumers see only the current entity. `confirmed_real` marks a jump that survived a provider re-fetch — **the verdict expires after 30 days** and the discontinuity is then re-verified (v1.1.140), because providers backfill corporate actions late and a permanent verdict would hide a late-published split forever.

## 2.8 IV history (migrations 016, 017)

**`iv_history`** — `id PK`, `ticker`, `date`, `atm_iv` (**decimal fraction**), `underlying_px`, `exp_near`, `exp_far`, `dte_near`, `dte_far`, `source` (`marketdata|etrade|polygon`), `created_at`. Unique `(ticker, date)`. One row per ticker per trading day; 30-day constant-maturity ATM IV. (017 was a one-time data fix multiplying legacy values by 100.) See §11 for the math.

## 2.9 Portfolio (migrations 006, 014)

**`positions`** — `id PK`, `ticker`, `position_type` (`CSP|CC|Stock`), `quantity` (>0), `entry_price`, `entry_date`, `entry_notes`, `exit_price`, `exit_date`, `exit_notes`, `strike_price`, `expiration_date`, `premium_received`, `current_price`, `unrealized_pnl`, `realized_pnl`, `status` (`open|closed`), `created_at`, `updated_at`.
E*Trade sync columns (014): `etrade_position_id` (unique when non-null), `etrade_account_id`, `market_value`, `total_gain_pct`, `days_gain`, `days_gain_pct`, `cost_per_share`, `pct_of_portfolio`, `delta`, `gamma`, `theta`, `vega`, `iv` (percentage), `beta`, `last_synced_at`.
Views `v_open_positions`, `v_closed_positions`, `v_portfolio_summary` provide capital-required / P&L / days-held / return math; an `AFTER UPDATE` trigger maintains `updated_at`.

**`position_analysis`** (014) — `id PK`, `position_id → positions (CASCADE, UNIQUE)`, `analyzed_at`, technicals (`trend`, `rsi`, `sma20/50/200`, `support_level`, `resistance_level`, `composite_score`), position metrics (`days_in_position`, `current_return_pct`, `annualized_return`), options fields (`current_delta`, `theta_decay`, `iv_rank`, `assignment_risk`, `roll_opportunity`), and recommendation (`action` = `hold|close|roll|hedge|take_profits`, `conviction` 1–3, `explanation`). One row per position (upsert).

**`advisor_sessions`** (014) — `id PK`, `requested_at`, `positions_json`, `advice_text`, `action_items_json`, `position_advice_json`, `observations_json`, `model`, `input_tokens`, `output_tokens`. One row per AI advisor run.

## 2.10 Options-strategy screeners (migrations 011, 012, 013, 015)

**`leaps_csp_runs`** — `id PK`, `run_at`, `universe`, `market_gate` (`PASS|CAUTION|FAIL`), `gate_detail_json`, `gate_effect`, `candidate_count`, `opportunity_count`, `watchlist_id` (012).

**`leaps_csp_opportunities`** — `id PK`, `run_id (CASCADE)`, `rank`, `pairing_mode` (`same_ticker|different_ticker|leaps_only`); LEAPS leg fields (`leaps_ticker`, `leaps_strike`, `leaps_expiry`, `leaps_dte`, `leaps_delta`, `leaps_premium`, `leaps_extrinsic_pct`, `leaps_iv_pct`, `leaps_ivr`, `leaps_oi`, `leaps_sub_score`); CSP leg fields (`csp_ticker`, `csp_strike`, `csp_expiry`, `csp_dte`, `csp_delta`, `csp_premium`, `csp_collateral`, `csp_ann_return_pct`, `csp_iv_pct`, `csp_ivr`, `csp_oi`, `csp_sub_score`); combined (`combined_score`, `grade`, `caution_flags`, `total_cash_to_deploy`, `detail_json`).

**`leaps_csp_opened`** — `id PK`, `opportunity_id (CASCADE)`, `opened_at`, `leaps_entry_debit`, `csp_entry_credit`, `notes`.

**`collared_leaps_runs`** — like `leaps_csp_runs` plus `watchlist_id`. Strategy = long deep-ITM LEAPS call + long OTM protective put on the same underlying.

**`collared_leaps_opportunities`** — `id PK`, `run_id (CASCADE)`, `rank`, `ticker`, `spot`, `ma200d`; LEAPS leg (`leaps_strike/expiry/dte/delta/debit/extrinsic_pct/iv_pct/ivr/oi/spread_pct/sub_score`); put leg (`put_strike/expiry/dte/delta/debit/iv_pct/ivr/oi/spread_pct/sub_score`); structural metrics (`cost_drag_pct`, `floor_depth_pct`, `breakeven`, `max_loss_at_put`, `max_loss_at_zero`, `upside_retention_pct`, `hedge_efficiency_pct`, `rr_ratio`); scoring (`structural_sub_score`, `combined_score`, `grade`, `caution_flags`, `gate_survived`, `detail_json`).

**`collared_leaps_opened`** — `id PK`, `opportunity_id (CASCADE)`, `opened_at`, `leaps_entry_debit`, `put_entry_debit`, `notes`.

**`payoff_strategies`** (015) — `id PK`, `name`, `ticker`, `legs_json` (`PayoffLeg[]`), `created_at`. Saved multi-leg payoff configurations.

## 2.11 Backtest (migration 009)

**`backtest_configs`** — `id PK`, `name`, `strategy` (`CSP|CC|Wheel`), `ticker`, `start_date`, `end_date`, `starting_capital`, `dte_target`, `delta_target`, `profit_target_pct`, `stop_loss_pct`, `created_at`.

**`backtest_runs`** — `id PK`, `config_id (CASCADE)`, `status` (`pending|running|completed|failed|cancelled`), `started_at`, `completed_at`, `error_msg`, `total_days`, `simulated_days`, `created_at`.

**`backtest_trades`** — `id PK`, `run_id (CASCADE)`, `ticker`, `strategy`, `side` (`put|call`), `entry_date`, `expiration`, `strike`, `entry_premium`, `exit_date`, `exit_premium`, `exit_reason` (`profit_target|stop_loss|expiration|assigned`), `pnl`, `stock_shares`, `stock_cost_basis`, `capital_required`, `entry_spot`/`exit_spot` (044 — underlying price at open/close).

**`backtest_metrics`** — `run_id PK (CASCADE)`, `net_pnl`, `total_return_pct`, `annualized_return_pct`, `max_drawdown_pct`, `sharpe_ratio`, `win_rate`, `total_trades`, `winning_trades`, `losing_trades`, `avg_trade_pnl`, `avg_days_held`, `equity_curve_json`, `computed_at`.

## 2.12 Alerts (migration 007)

**`alerts`** — `id PK`, `ticker`, `alert_type` (`price|expiration|delta`), `price_threshold`, `price_condition` (`above|below`), `days_before_expiration`, `delta_threshold`, `delta_direction` (`above|below`), `is_active`, `is_triggered`, `triggered_at`, `play_sound`, `created_at`, `updated_at`. Views `v_active_alerts` (with rendered description), `v_triggered_alerts`; `updated_at` trigger.

## 2.13 Batch scheduler (migrations 020, 021, 027, 028)

**`batch_jobs`** — `id TEXT PK` (e.g. `daily-iv-update`), `name`, `description`, `enabled`, `run_on_startup`, `startup_delay_seconds`, `daily_schedule_enabled`, `daily_schedule_time` (HH:MM ET), `last_run_at`, `last_run_status`, `last_success_date`, `sequence_order` (021/027 — ordering for same-time jobs), `config_json` (028 — per-job config such as `callDelayMs`).

**`batch_runs`** — `id PK`, `job_id → batch_jobs`, `started_at`, `completed_at`, `status`, `tickers_attempted`, `tickers_updated`, `tickers_skipped`, `tickers_failed`, `notes`, `error_message`.

**`options_premium_history`** (migration 040, `volume` added in 066) — `id PK`, `as_of_date`, `ticker`, `strategy` (`wheel|income`), `structure` (`CSP|CC`), `last_price`, `strike`, `expiration`, `dte`, `delta`, `bid`, `ask`, `premium` (per-share credit), `annualized_return`, `iv`, `iv_rank`, `open_interest`, `volume`, `breakeven`, `captured_at`; `UNIQUE(as_of_date, ticker, strategy)`. Durable daily capture of the recommended option structure for premium-based strategies, populated by the `daily-options-premium-history` batch job (wheel reused from the same-day snapshot; income fetched live). Never pruned — exists to enable true return-on-capital analysis over time.

> **Historical gap (fixed v1.1.132).** `bid`, `ask` and `open_interest` are **NULL on every wheel row written before v1.1.132** — 21,127 rows spanning 2026-06-15 → 2026-08-05 — because `WheelResult` did not carry them: `analyzeWheel` computed the liquidity inputs, scored them into `optionLiquidityScore`, and discarded them, so `wheelResultToRow` had nothing to write and hardcoded null. Income rows were always complete (22,302/22,302). `volume` is NULL on **all** rows before 066, since no result type carried it. The gap is not backfillable — the quotes were never stored anywhere — and it is why a retrospective A/B of the liquidity scoring is possible on income rows but not wheel ones. Nothing coerces these to 0: a 0 asserts "measured and terrible", which is a different claim (same discipline as `optionLiquidityScore`, §13).

## 2.14 Scoring & daily brief (migrations 022, 023, 030, 032)

**`scoring_strategy_configs`** — `strategy PK` (`wheel|bullish|bearish|income|buy`), `signals` (JSON `ScoringSignal[]`), `version` (e.g. `baseline_v2`), `updated_at`.

**`daily_briefs`** — `id PK`, `generated_at`, `valid_until` (next trading day 9:30 ET), `strategy`, `picks` (JSON `BriefPick[]`), `run_meta` (stage timing/counts/errors).

**`technical_signals`** — `ticker PK`, `computed_at`, `price`, `sma20/50/200`, `rsi`, `macd_value`, `macd_signal_line`, `macd_bullish_cross`, `bollinger_position`, `trend_label`, `buy_signal_score` (0–100), `buy_signal_strength`, `pattern_names` (JSON). Upserted nightly; lets scoring read a precomputed buy score with no live calls.

**`brief_learning_recommendations`** (032) — `id PK`, `strategy`, `gap_cause`, `occurrence_count`, `description`, `proposed_tweak`, `status` (`open|acknowledged`), `created_at`. Unique `(strategy, gap_cause)`. Generated when a gap cause recurs ≥3×.

**`structure_liquidity_log`** (064, v1.1.93) — `id PK`, `captured_at` (UTC), `date_et`, `ticker`, `slug`, `liquidity_score`, `grade`, `no_bid_leg`. Appended by the brief job's Stage 4 for every constructible structure; index `(date_et, ticker, slug)`. Pure instrumentation for the intraday vs after-close liquidity artifact (NEW_FRONTIER §11) — nothing on the live path reads it; pruned at 120 days.

## 2.15 Paper trading / retrospect (migrations 025, 029, 030)

**`paper_trades`** — `id PK`, `brief_id → daily_briefs (SET NULL)`, `brief_strategy`, `brief_score`, `brief_rank`, `ticker`, `brief_date`, `strategy_name`, `legs_json`, `entry_date`, `entry_price`, `entry_premium` (net credit + / debit −), `expiry_date`, `status` (`open|closed|expired`), `exit_date`, `exit_price`, `exit_notes`, `stock_return_pct`, `outcome` (`win|loss|breakeven`), `learning_json` (030 — AI learning note), `created_at`. Unique `(ticker, brief_strategy, brief_date)` (same-day re-runs update, not duplicate).

**`paper_trade_snapshots`** (029) — `id PK`, `paper_trade_id (CASCADE)`, `snapshot_date`, `days_held`, `price`, `return_pct`, `verdict` (`positive|negative|neutral`, strategy-aware), `created_at`. Unique `(paper_trade_id, snapshot_date)`. EOD close per trading day after entry → fixed-horizon accuracy (Day+1, Day+5…).

## 2.16 Conviction list (migration 026)

**`conviction_stocks`** — `ticker PK`, `price_low` (comfortable entry), `price_mid` (experimental), `price_high` (never enter above), `note`, `in_play` (043 — on/off attention flag), `added_at`, `updated_at`. A single permanent list (not multi-list). **Three CHECK constraints (075) enforce strictly increasing bands** — `conviction_bands_low_lt_mid` / `_mid_lt_high` / `_low_lt_high`, each a no-op when either side is NULL, so partial bands stay legal (§19.5). Migration 075 rebuilt the table to add them: because `conviction_band_history` has an FK here with `ON DELETE CASCADE` and `PRAGMA foreign_keys=OFF` is a no-op inside the transaction migrations run in, the child table is copied aside and dropped **before** the parent is replaced, then recreated and refilled with its original ids. Pre-existing violating rows are snapshotted to history and normalised (values sorted into slots; a duplicate band dropped) rather than failing the migration — a failed migration means the app will not boot.

**`conviction_band_history`** — `id PK`, `ticker → conviction_stocks (CASCADE)`, `price_low/mid/high`, `note`, `changed_at`. Audit trail on every band change. **Deliberately carries no band-ordering CHECK** — it records what was actually stored, inverted rows included.

## 2.17 Agent learnings (migration 031)

**`agent_trade_learnings`** — `id PK`, `agent_trade_id` (UNIQUE), `ticker`, `learning_json`, `created_at`. AI learning notes for closed external-TraderAgent trades.

## 2.18 News & research (migration 033)

**`news_research_cache`** — `id PK`, `ticker`, `cache_date` (local trading date), `raw_data` (JSON `RawSignals`), `ai_summary` (JSON `{keyFactors, summary, portfolioNote}`), `impact_score` (denormalized for sort), `bias` (`bull|bear|mixed`), `ai_model`, `created_at`, `updated_at`. Unique `(ticker, cache_date)`.

**`macro_events`** — `id PK`, `event_date`, `event_type` (`FOMC|CPI|PPI|JOBS|OTHER`), `description`, `source`, `created_at`. Seeded with 2026 FOMC/CPI/Jobs dates; extend yearly.

## 2.19 Earnings (migration 034)

**`earnings_calendar`** — `ticker PK`, `report_date` (YYYY-MM-DD), `report_time` (`bmo|amc|null`), `eps_estimate`, `source` (`etrade|polygon_est|manual`), `confirmed` (1=exact, 0=estimate), `cached_at` (drives 24h refresh gate). See §17 for the Saturday→Friday UTC correction.

## 2.20 Filter prefill (migration 065)

**`filter_template_runs`** — `template_id PK`, `ran_at`, `universe`, `result_count`, `results_json` (`FilterTemplateResult[]`), `shape_version`. Latest batch-precomputed run per filter template (no history — each `filters-prefill` run overwrites). Rows whose `shape_version` ≠ the build's `FILTER_RESULTS_SHAPE_VERSION` are ignored on read, so a stale result shape is never rendered (§5.B.1).
