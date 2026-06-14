# 21 — Backtesting Engine

Simulates CSP / CC / Wheel strategies over historical data to estimate performance. Services: `backtest-engine.ts`, `backtest-metrics.ts`. IPC: `window.api.backtest.*`. View: `BacktestView.tsx` (🔁 Backtest). Tables: `backtest_configs`, `backtest_runs`, `backtest_trades`, `backtest_metrics` (§2.11). Options are priced via Black-Scholes; the volatility input is **historical ATM IV** (`iv_history`, as-of the entry date), falling back to 20-day realized vol when IV history is missing — see `23-formulas.md` / `docs/formulas.md#backtest-iv`.

## 21.1 Configuration

A saved `backtest_config`: `name`, `strategy` (`CSP|CC|Wheel`), `ticker`, `start_date`, `end_date`, `dte_target` (30), `delta_target` (0.30), `profit_target_pct` (50), `stop_loss_pct` (200). IPC: `config.list`, `config.create(cfg)`, `config.delete(id)`. (`starting_capital` remains in the schema/type but is no longer user-facing or used since v0.34.5 — the engine auto-sizes the capital base to one contract: `max spot × 100`. Metrics are "return on the capital one contract ties up." This removed the capital gate that previously made high-priced stocks like META flat-zero.)

## 21.2 Simulation

`run.start(configId)` creates a `backtest_run` and walks the historical window day by day:
- Open a position at the target DTE/delta when none is open (estimating option premium from historical price + volatility).
- Manage it: close at `profit_target_pct` of credit, stop at `stop_loss_pct` of credit, or hold to expiration/assignment.
- For Wheel, assignment rolls into stock and switches to covered-call writing.
- Each simulated trade is written to `backtest_trades` (entry/exit dates, strike, premiums, `exit_reason` ∈ profit_target/stop_loss/expiration/assigned, pnl, capital_required, stock shares/cost basis).

Runs are cancellable and report progress (`run.onProgress`, with `simulated_days`/`total_days`). Status ∈ pending/running/completed/failed/cancelled.

## 21.3 Metrics

After simulation, `backtest-metrics.ts` computes aggregate `backtest_metrics`: `net_pnl`, `total_return_pct`, `annualized_return_pct`, `max_drawdown_pct`, `sharpe_ratio`, `win_rate`, `total_trades`, `winning/losing_trades`, `avg_trade_pnl`, `avg_days_held`, and an `equity_curve_json` for charting. Formulas in §23 (`backtest-metrics`).

IPC: `run.list(configId?)`, `run.get(runId)`, `run.start(configId)`, `run.cancel()`, `run.delete(runId)`, `run.metrics(runId)`, `run.trades(runId)`, `run.onProgress`.

## 21.4 UI

Pick/create a config → run → view the equity curve, the metrics summary, and the trade-by-trade table. Past runs are listed and re-openable. The trade log shows entry/exit dates, strike, option premiums (Entry Px / Exit Px), and underlying price at entry/exit (Stk@Entry / Stk@Exit); columns are click-sortable, defaulting to entry date descending.

**Deep-link from recommendations** (v0.33.7): a 🔁 Backtest action on My Stocks rows and Daily Brief wheel/income pick cards fires `navigate-to-backtest` with `{ ticker, strategy }` (My Stocks → CSP; brief wheel → Wheel, income → CSP). `BacktestView` accepts `initialTicker`/`initialStrategy` and **auto-runs** the backtest (after IV coverage loads, so the start date is IV-accurate) — no manual click. Manually opening the view shows the form to fill in. Only premium-selling strategies the engine supports surface the action.

**IV-accurate start guidance** (v0.34.1): the New form defaults its start date to `BacktestEngine.ivHistoryStart()` (oldest `iv_history` date; IPC `backtest:iv-coverage`) and sets the input `min` to it. Starts before IV coverage show a ⚠ "priced from realized vol" warning with a one-click fix; starts within coverage show a "✓ IV-priced" hint. (IV history is ~1 year deep, so this keeps backtests on IV-priced ground unless deliberately overridden.)

**Aggregate pick backtest** (v0.34.0): `BacktestEngine.backtestReplayPicks(strategy)` (IPC `backtest:replay-picks`) simulates one CSP per historical Brief-Replay pick for a premium strategy (`simulateSingleCsp` — IV-priced, 0.30-delta/30-DTE/+50%/200% defaults) and pools the results into `AggregatePickBacktest` (trade count, win rate, avg/median ROC, cumulative ROC, max drawdown, equity curve by exit date). Surfaced via the 💰 P&L button on the wheel/income rows of the Brief Replay summary table → a modal with metrics + equity curve. This is the real option P&L the replay's stock-return columns don't capture. Equal-weight, capital unconstrained.
