-- Earnings calendar: upcoming earnings dates for tracked tickers.
-- Source priority: 'etrade' (confirmed) > 'polygon_est' (estimated) > 'manual' (user override).
-- cached_at drives the 24h refresh gate.

CREATE TABLE IF NOT EXISTS earnings_calendar (
  ticker        TEXT    NOT NULL,
  report_date   TEXT    NOT NULL,  -- ISO YYYY-MM-DD
  report_time   TEXT,              -- 'bmo' | 'amc' | null
  eps_estimate  REAL,
  source        TEXT    NOT NULL DEFAULT 'manual',  -- 'etrade' | 'polygon_est' | 'manual'
  confirmed     INTEGER NOT NULL DEFAULT 0,          -- 1 = exact date, 0 = estimate
  cached_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ticker)
);
