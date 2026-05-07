-- 005_historical_data.sql - Historical financials and price data storage
-- Supports historical charting in Analysis view
-- see SPEC: FR-4 Historical Charts

-- Historical financials table (quarterly/annual data from Polygon)
CREATE TABLE IF NOT EXISTS historical_financials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  filing_date TEXT NOT NULL,      -- YYYY-MM-DD
  period_type TEXT NOT NULL CHECK (period_type IN ('quarterly', 'annual')),
  period_end_date TEXT NOT NULL,  -- YYYY-MM-DD (the actual period end date)

  -- Revenue metrics
  revenues INTEGER,               -- In whole dollars
  net_income INTEGER,
  gross_profit INTEGER,
  operating_income INTEGER,

  -- Per share metrics
  earnings_per_share REAL,        -- Diluted EPS
  shares_outstanding INTEGER,

  -- Balance sheet items
  total_assets INTEGER,
  total_liabilities INTEGER,
  shareholders_equity INTEGER,
  long_term_debt INTEGER,
  current_assets INTEGER,
  current_liabilities INTEGER,

  -- Cash flow items
  operating_cash_flow INTEGER,
  free_cash_flow INTEGER,

  -- EBITDA and adjusted figures
  ebitda INTEGER,

  -- Metadata
  currency TEXT DEFAULT 'USD',
  source TEXT DEFAULT 'polygon',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE(ticker, period_end_date, period_type)
);

-- Historical prices table (daily OHLCV bars)
CREATE TABLE IF NOT EXISTS historical_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,             -- YYYY-MM-DD

  -- OHLCV data
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume INTEGER NOT NULL,

  -- Adjusted close (for total return calculations)
  adjusted_close REAL,

  -- Metadata
  source TEXT DEFAULT 'polygon',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE(ticker, date)
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_historical_financials_ticker
  ON historical_financials (ticker);
CREATE INDEX IF NOT EXISTS idx_historical_financials_period
  ON historical_financials (ticker, period_type, period_end_date DESC);
CREATE INDEX IF NOT EXISTS idx_historical_financials_filing
  ON historical_financials (ticker, filing_date DESC);

CREATE INDEX IF NOT EXISTS idx_historical_prices_ticker
  ON historical_prices (ticker);
CREATE INDEX IF NOT EXISTS idx_historical_prices_date
  ON historical_prices (ticker, date DESC);
CREATE INDEX IF NOT EXISTS idx_historical_prices_date_range
  ON historical_prices (ticker, date);

-- View: Latest financials per ticker (most recent quarterly)
CREATE VIEW IF NOT EXISTS v_latest_financials AS
SELECT *
FROM historical_financials
WHERE (ticker, filing_date) IN (
  SELECT ticker, MAX(filing_date)
  FROM historical_financials
  WHERE period_type = 'quarterly'
  GROUP BY ticker
);

-- View: Latest price per ticker
CREATE VIEW IF NOT EXISTS v_latest_price AS
SELECT ticker, date, close, volume
FROM historical_prices
WHERE (ticker, date) IN (
  SELECT ticker, MAX(date)
  FROM historical_prices
  GROUP BY ticker
);
