-- Daily paper-trade price snapshots (v0.27.5)
-- One row per (paper_trade, calendar_date) — captures EOD close for every trading day
-- after entry so we can compute accuracy at fixed horizons (Day+1, Day+5, etc.).
-- UNIQUE constraint makes every write idempotent — safe to run the job multiple times per day.
CREATE TABLE IF NOT EXISTS paper_trade_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_trade_id   INTEGER NOT NULL REFERENCES paper_trades(id) ON DELETE CASCADE,
  snapshot_date    TEXT    NOT NULL,   -- YYYY-MM-DD (EOD price date)
  days_held        INTEGER NOT NULL,   -- calendar days since entry_date (≥ 1)
  price            REAL,              -- historical_prices.close on snapshot_date
  return_pct       REAL,              -- (price - entry_price) / entry_price * 100
  verdict          TEXT,              -- 'positive' | 'negative' | 'neutral' (strategy-aware)
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(paper_trade_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_pt_snapshots_trade_id ON paper_trade_snapshots(paper_trade_id);
CREATE INDEX IF NOT EXISTS idx_pt_snapshots_date     ON paper_trade_snapshots(snapshot_date DESC);
