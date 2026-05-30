-- IV History: daily 30-day constant-maturity ATM implied volatility per ticker.
-- Used to compute IV Rank and IV Percentile.
-- see docs/formulas.md#iv-history

CREATE TABLE IF NOT EXISTS iv_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker          TEXT    NOT NULL,
  date            TEXT    NOT NULL,        -- YYYY-MM-DD (trading day, ET)
  atm_iv          REAL    NOT NULL,        -- 30-day constant-maturity IV, decimal (0.285 = 28.5%)
  underlying_px   REAL,                   -- stock price at time of capture
  exp_near        TEXT,                   -- nearer expiration used (YYYY-MM-DD)
  exp_far         TEXT,                   -- farther expiration used (YYYY-MM-DD)
  dte_near        INTEGER,                -- DTE of near expiration on this date
  dte_far         INTEGER,                -- DTE of far expiration on this date
  source          TEXT    NOT NULL DEFAULT 'marketdata', -- 'marketdata' | 'etrade' | 'polygon'
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_iv_history_ticker_date ON iv_history(ticker, date);
CREATE INDEX IF NOT EXISTS idx_iv_history_ticker ON iv_history(ticker);
CREATE INDEX IF NOT EXISTS idx_iv_history_date   ON iv_history(date);
