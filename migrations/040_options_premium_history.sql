-- Migration 040: Daily options-premium history.
-- Accumulates the recommended option structure (strike, expiry, premium, delta, IV)
-- per ticker per trading day for premium-based strategies (wheel CSP, income CSP/CC).
-- Purpose: build a real, query-friendly time series of quoted option premium so that
-- a year from now we can compute TRUE return-on-capital for income/wheel (and back-test
-- Brief Replay against actual premium, not the stayed-above-strike proxy).
-- Populated nightly by DailyOptionsPremiumHistoryJob. NEVER pruned.

CREATE TABLE IF NOT EXISTS options_premium_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date        TEXT    NOT NULL,           -- ET trading date (YYYY-MM-DD)
  ticker            TEXT    NOT NULL,
  strategy          TEXT    NOT NULL,           -- 'wheel' | 'income'
  structure         TEXT,                       -- 'CSP' | 'CC'
  last_price        REAL,                       -- underlying price at capture
  strike            REAL,
  expiration        TEXT,
  dte               INTEGER,                    -- calendar days to expiry
  delta             REAL,
  bid               REAL,
  ask               REAL,
  premium           REAL,                       -- per-share credit received
  annualized_return REAL,                       -- annualized return on capital (%)
  iv                REAL,                       -- ATM implied vol (percentage; wheel only)
  iv_rank           REAL,
  open_interest     INTEGER,
  breakeven         REAL,
  captured_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(as_of_date, ticker, strategy)
);

CREATE INDEX IF NOT EXISTS idx_oph_date   ON options_premium_history (as_of_date);
CREATE INDEX IF NOT EXISTS idx_oph_ticker ON options_premium_history (ticker, strategy, as_of_date);
