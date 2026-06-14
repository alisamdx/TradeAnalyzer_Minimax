# 21 — Backtesting Engine

Simulates CSP / CC / Wheel strategies over historical data to estimate performance. Services: `backtest-engine.ts`, `backtest-metrics.ts`. IPC: `window.api.backtest.*`. View: `BacktestView.tsx` (🔁 Backtest). Tables: `backtest_configs`, `backtest_runs`, `backtest_trades`, `backtest_metrics` (§2.11). Options are priced via Black-Scholes; the volatility input is **historical ATM IV** (`iv_history`, as-of the entry date), falling back to 20-day realized vol when IV history is missing — see `23-formulas.md` / `docs/formulas.md#backtest-iv`.

## 21.1 Configuration

A saved `backtest_config`: `name`, `strategy` (`CSP|CC|Wheel`), `ticker`, `start_date`, `end_date`, `starting_capital` (default 10,000), `dte_target` (30), `delta_target` (0.30), `profit_target_pct` (50), `stop_loss_pct` (200). IPC: `config.list`, `config.create(cfg)`, `config.delete(id)`.

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

Pick/create a config → run → view the equity curve, the metrics summary, and the trade-by-trade table. Past runs are listed and re-openable.

**Deep-link from recommendations** (v0.33.7): a 🔁 Backtest action on My Stocks rows and Daily Brief wheel/income pick cards fires `navigate-to-backtest` with `{ ticker, strategy }` (My Stocks → CSP; brief wheel → Wheel, income → CSP). `BacktestView` accepts `initialTicker`/`initialStrategy` and opens the New form pre-filled, so a recommendation can be backtested without manual entry. Only premium-selling strategies the engine supports surface the action.
