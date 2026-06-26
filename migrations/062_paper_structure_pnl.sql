-- Paper-tracking layer: score brief picks on actual structure P&L, not just stock direction.
-- structure_pnl/return are Black-Scholes-marked from the trade's legs (see structure-mark.ts).

ALTER TABLE paper_trade_snapshots ADD COLUMN structure_pnl REAL;
ALTER TABLE paper_trade_snapshots ADD COLUMN structure_return_pct REAL;

-- Realized structure P&L at close (outcome is now derived from this, not stock_return_pct).
ALTER TABLE paper_trades ADD COLUMN structure_pnl REAL;
