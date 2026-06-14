-- Underlying (stock) price at entry and exit for backtest trades. The engine knows the
-- spot at every simulated bar but didn't persist it; storing it makes the trade log
-- readable (where the stock sat vs. the strike at open and close).
ALTER TABLE backtest_trades ADD COLUMN entry_spot REAL;
ALTER TABLE backtest_trades ADD COLUMN exit_spot REAL;
