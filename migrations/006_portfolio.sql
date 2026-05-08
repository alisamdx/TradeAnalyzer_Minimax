-- 006_portfolio.sql - Portfolio tracking positions table
-- Supports Phase 6: Portfolio Tracking
-- see SPEC: Priority 6 - Portfolio Tracking

-- Positions table for tracking trades (CSP, CC, Stock)
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,

  -- Position type: CSP (Cash-Secured Put), CC (Covered Call), Stock
  position_type TEXT NOT NULL CHECK (position_type IN ('CSP', 'CC', 'Stock')),

  -- Quantity: number of contracts (options) or shares (stock)
  quantity INTEGER NOT NULL CHECK (quantity > 0),

  -- Entry details
  entry_price REAL NOT NULL,
  entry_date TEXT NOT NULL,  -- YYYY-MM-DD
  entry_notes TEXT,

  -- Exit details (NULL for open positions)
  exit_price REAL,
  exit_date TEXT,  -- YYYY-MM-DD
  exit_notes TEXT,

  -- For options only
  strike_price REAL,  -- NULL for stock positions
  expiration_date TEXT,  -- YYYY-MM-DD, NULL for stock positions
  premium_received REAL,  -- For sold options

  -- Calculated fields (updated on close or quote refresh)
  current_price REAL,  -- Last known price for unrealized P&L
  unrealized_pnl REAL,  -- (current - entry) * quantity (for open positions)
  realized_pnl REAL,  -- (exit - entry) * quantity + premium (for closed)

  -- Status
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_positions_ticker
  ON positions (ticker);

CREATE INDEX IF NOT EXISTS idx_positions_status
  ON positions (status);

CREATE INDEX IF NOT EXISTS idx_positions_type
  ON positions (position_type);

CREATE INDEX IF NOT EXISTS idx_positions_ticker_status
  ON positions (ticker, status);

-- View: Open positions with calculated metrics
CREATE VIEW IF NOT EXISTS v_open_positions AS
SELECT
  *,
  CASE
    WHEN position_type = 'Stock' THEN entry_price * quantity
    WHEN position_type IN ('CSP', 'CC') THEN strike_price * quantity * 100  -- Contract size
  END as capital_required,
  CASE
    WHEN position_type = 'Stock' AND current_price IS NOT NULL
      THEN (current_price - entry_price) * quantity
    WHEN position_type IN ('CSP', 'CC') AND current_price IS NOT NULL
      THEN premium_received  -- Simplified for options
    ELSE NULL
  END as current_unrealized_pnl,
  CASE
    WHEN position_type = 'Stock' AND entry_price > 0
      THEN ((current_price - entry_price) / entry_price) * 100
    ELSE NULL
  END as return_pct
FROM positions
WHERE status = 'open';

-- View: Closed positions with realized metrics
CREATE VIEW IF NOT EXISTS v_closed_positions AS
SELECT
  *,
  CASE
    WHEN position_type = 'Stock' THEN entry_price * quantity
    WHEN position_type IN ('CSP', 'CC') THEN strike_price * quantity * 100
  END as capital_deployed,
  CASE
    WHEN exit_price IS NOT NULL AND entry_price IS NOT NULL THEN
      CASE
        WHEN position_type = 'Stock' THEN (exit_price - entry_price) * quantity
        WHEN position_type IN ('CSP', 'CC') THEN
          (exit_price - entry_price) * quantity * 100 + COALESCE(premium_received, 0)
        ELSE 0
      END
    ELSE NULL
  END as calculated_realized_pnl,
  CASE
    WHEN exit_date IS NOT NULL AND entry_date IS NOT NULL THEN
      julianday(exit_date) - julianday(entry_date)
    ELSE NULL
  END as days_held,
  CASE
    WHEN exit_price IS NOT NULL AND entry_price IS NOT NULL AND entry_price > 0 THEN
      CASE
        WHEN position_type = 'Stock' THEN
          ((exit_price - entry_price) / entry_price) * 100
        WHEN position_type IN ('CSP', 'CC') THEN
          (((exit_price - entry_price) * 100 + COALESCE(premium_received, 0)) / (strike_price * 100)) * 100
        ELSE NULL
      END
    ELSE NULL
  END as realized_return_pct
FROM positions
WHERE status = 'closed';

-- View: Portfolio summary
CREATE VIEW IF NOT EXISTS v_portfolio_summary AS
SELECT
  position_type,
  status,
  COUNT(*) as position_count,
  SUM(CASE
    WHEN position_type = 'Stock' THEN entry_price * quantity
    WHEN position_type IN ('CSP', 'CC') THEN COALESCE(strike_price, 0) * quantity * 100
    ELSE 0
  END) as total_capital,
  SUM(unrealized_pnl) as total_unrealized_pnl,
  SUM(realized_pnl) as total_realized_pnl,
  AVG(CASE WHEN realized_pnl > 0 THEN 1.0 ELSE 0.0 END) * 100 as win_rate_pct
FROM positions
GROUP BY position_type, status;

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS trg_positions_updated_at
AFTER UPDATE ON positions
BEGIN
  UPDATE positions
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
