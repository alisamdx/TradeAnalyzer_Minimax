-- 036_position_type_long_options.sql
-- Expand positions.position_type CHECK to include 'Long Put' and 'Long Call'
-- so that multi-leg strategies (jade lizard, big lizard, etc.) are fully tracked.
-- SQLite does not support ALTER TABLE MODIFY COLUMN, so we recreate the table.

PRAGMA foreign_keys = OFF;

-- Drop views and trigger that reference positions
DROP VIEW IF EXISTS v_open_positions;
DROP VIEW IF EXISTS v_closed_positions;
DROP VIEW IF EXISTS v_portfolio_summary;
DROP TRIGGER IF EXISTS trg_positions_updated_at;

-- Recreate with expanded constraint (all columns from 006 + 014 ADD COLUMNs)
CREATE TABLE IF NOT EXISTS positions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  position_type TEXT NOT NULL CHECK (position_type IN ('CSP', 'CC', 'Stock', 'Long Put', 'Long Call')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  entry_price REAL NOT NULL,
  entry_date TEXT NOT NULL,
  entry_notes TEXT,
  exit_price REAL,
  exit_date TEXT,
  exit_notes TEXT,
  strike_price REAL,
  expiration_date TEXT,
  premium_received REAL,
  current_price REAL,
  unrealized_pnl REAL,
  realized_pnl REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  etrade_position_id INTEGER,
  etrade_account_id TEXT,
  market_value REAL,
  total_gain_pct REAL,
  days_gain REAL,
  days_gain_pct REAL,
  cost_per_share REAL,
  pct_of_portfolio REAL,
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  iv REAL,
  beta REAL,
  last_synced_at TEXT
);

INSERT INTO positions_new SELECT * FROM positions;

DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_positions_ticker          ON positions (ticker);
CREATE INDEX IF NOT EXISTS idx_positions_status          ON positions (status);
CREATE INDEX IF NOT EXISTS idx_positions_type            ON positions (position_type);
CREATE INDEX IF NOT EXISTS idx_positions_ticker_status   ON positions (ticker, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_etrade_id
  ON positions (etrade_position_id)
  WHERE etrade_position_id IS NOT NULL;

-- v_open_positions
CREATE VIEW IF NOT EXISTS v_open_positions AS
SELECT
  *,
  CASE
    WHEN position_type = 'Stock'                          THEN entry_price * quantity
    WHEN position_type IN ('CSP', 'CC')                   THEN strike_price * quantity * 100
    WHEN position_type IN ('Long Put', 'Long Call')        THEN entry_price * quantity * 100
  END as capital_required,
  CASE
    WHEN position_type = 'Stock' AND current_price IS NOT NULL
      THEN (current_price - entry_price) * quantity
    WHEN position_type IN ('CSP', 'CC') AND current_price IS NOT NULL
      THEN premium_received
    WHEN position_type IN ('Long Put', 'Long Call') AND current_price IS NOT NULL
      THEN (current_price - entry_price) * quantity * 100
    ELSE NULL
  END as current_unrealized_pnl,
  CASE
    WHEN position_type IN ('Stock', 'Long Put', 'Long Call') AND current_price IS NOT NULL AND entry_price > 0
      THEN ((current_price - entry_price) / entry_price) * 100
    ELSE NULL
  END as return_pct
FROM positions
WHERE status = 'open';

-- v_closed_positions
CREATE VIEW IF NOT EXISTS v_closed_positions AS
SELECT
  *,
  CASE
    WHEN position_type = 'Stock'                          THEN entry_price * quantity
    WHEN position_type IN ('CSP', 'CC')                   THEN strike_price * quantity * 100
    WHEN position_type IN ('Long Put', 'Long Call')        THEN entry_price * quantity * 100
  END as capital_deployed,
  CASE
    WHEN exit_price IS NOT NULL AND entry_price IS NOT NULL THEN
      CASE
        WHEN position_type = 'Stock'
          THEN (exit_price - entry_price) * quantity
        WHEN position_type IN ('CSP', 'CC')
          THEN (exit_price - entry_price) * quantity * 100 + COALESCE(premium_received, 0)
        WHEN position_type IN ('Long Put', 'Long Call')
          THEN (exit_price - entry_price) * quantity * 100
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
        WHEN position_type = 'Stock'
          THEN ((exit_price - entry_price) / entry_price) * 100
        WHEN position_type IN ('CSP', 'CC')
          THEN (((exit_price - entry_price) * 100 + COALESCE(premium_received, 0)) / (strike_price * 100)) * 100
        WHEN position_type IN ('Long Put', 'Long Call')
          THEN ((exit_price - entry_price) / entry_price) * 100
        ELSE NULL
      END
    ELSE NULL
  END as realized_return_pct
FROM positions
WHERE status = 'closed';

-- v_portfolio_summary
CREATE VIEW IF NOT EXISTS v_portfolio_summary AS
SELECT
  position_type,
  status,
  COUNT(*) as position_count,
  SUM(CASE
    WHEN position_type = 'Stock'                          THEN entry_price * quantity
    WHEN position_type IN ('CSP', 'CC')                   THEN COALESCE(strike_price, 0) * quantity * 100
    WHEN position_type IN ('Long Put', 'Long Call')        THEN entry_price * quantity * 100
    ELSE 0
  END) as total_capital,
  SUM(unrealized_pnl) as total_unrealized_pnl,
  SUM(realized_pnl) as total_realized_pnl,
  AVG(CASE WHEN realized_pnl > 0 THEN 1.0 ELSE 0.0 END) * 100 as win_rate_pct
FROM positions
GROUP BY position_type, status;

-- Trigger
CREATE TRIGGER IF NOT EXISTS trg_positions_updated_at
AFTER UPDATE ON positions
BEGIN
  UPDATE positions
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;

PRAGMA foreign_keys = ON;
