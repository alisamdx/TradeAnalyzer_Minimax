-- v0.22.8: Daily Technical Signals — precomputed buy signal scores from historical_prices.
-- Enables ScoringService to consume buySignalScore without live API calls.
-- One row per ticker; upserted nightly by DailyTechnicalSignalsJob.

CREATE TABLE IF NOT EXISTS technical_signals (
  ticker               TEXT    NOT NULL PRIMARY KEY,
  computed_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  price                REAL,
  sma20                REAL,
  sma50                REAL,
  sma200               REAL,
  rsi                  REAL,
  macd_value           REAL,
  macd_signal_line     REAL,
  macd_bullish_cross   INTEGER NOT NULL DEFAULT 0,
  bollinger_position   REAL,
  trend_label          TEXT,
  buy_signal_score     INTEGER,
  buy_signal_strength  TEXT,
  pattern_names        TEXT    -- JSON array of recent bullish pattern names
);

CREATE INDEX IF NOT EXISTS idx_technical_signals_computed_at ON technical_signals (computed_at DESC);
