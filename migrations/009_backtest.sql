-- Backtest configurations (saved parameter sets)
CREATE TABLE IF NOT EXISTS backtest_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK(strategy IN ('CSP', 'CC', 'Wheel')),
  ticker TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  starting_capital REAL NOT NULL DEFAULT 10000,
  dte_target INTEGER NOT NULL DEFAULT 30,
  delta_target REAL NOT NULL DEFAULT 0.30,
  profit_target_pct REAL NOT NULL DEFAULT 50,
  stop_loss_pct REAL NOT NULL DEFAULT 200,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each execution of a config is a run
CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES backtest_configs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  started_at TEXT,
  completed_at TEXT,
  error_msg TEXT,
  total_days INTEGER,
  simulated_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Individual simulated trades within a run
CREATE TABLE IF NOT EXISTS backtest_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  strategy TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('put', 'call')),
  entry_date TEXT NOT NULL,
  expiration TEXT NOT NULL,
  strike REAL NOT NULL,
  entry_premium REAL NOT NULL,
  exit_date TEXT,
  exit_premium REAL,
  exit_reason TEXT CHECK(exit_reason IN ('profit_target', 'stop_loss', 'expiration', 'assigned')),
  pnl REAL,
  stock_shares INTEGER NOT NULL DEFAULT 0,
  stock_cost_basis REAL,
  capital_required REAL NOT NULL
);

-- Aggregate performance metrics per run (computed after simulation)
CREATE TABLE IF NOT EXISTS backtest_metrics (
  run_id INTEGER PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE,
  net_pnl REAL NOT NULL,
  total_return_pct REAL NOT NULL,
  annualized_return_pct REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  sharpe_ratio REAL NOT NULL,
  win_rate REAL NOT NULL,
  total_trades INTEGER NOT NULL,
  winning_trades INTEGER NOT NULL,
  losing_trades INTEGER NOT NULL,
  avg_trade_pnl REAL NOT NULL,
  avg_days_held REAL NOT NULL,
  equity_curve_json TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
