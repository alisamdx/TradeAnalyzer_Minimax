-- 004_cache_management.sql - Cache metadata and staleness tracking
-- Tracks last screener run time for auto-refresh functionality
-- see SPEC: §3.3 Caching Strategy, FR-2.2.4 Cache Status Indicator

-- Cache metadata table - single row (id=1) tracks global cache state
CREATE TABLE IF NOT EXISTS cache_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_screener_run INTEGER,  -- Unix timestamp (milliseconds)
  record_count INTEGER,     -- Number of tickers in cache
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Initialize with default values if empty
INSERT OR IGNORE INTO cache_metadata (id, last_screener_run, record_count)
VALUES (1, NULL, 0);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_cache_metadata_updated
  ON cache_metadata (updated_at);
