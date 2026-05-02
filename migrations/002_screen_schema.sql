-- 002_screen_schema.sql — Phase 2 schema.
-- Constituents, screen presets, cache tables, and the analysis snapshot table.
-- see SPEC: FR-2 (screener), DataProvider contract, §8 data model.

CREATE TABLE IF NOT EXISTS constituents (
  ticker TEXT NOT NULL,
  index_name TEXT NOT NULL,          -- 'sp500' or 'russell1000'
  company_name TEXT,
  sector TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ticker, index_name)
);

CREATE INDEX IF NOT EXISTS idx_constituents_index
  ON constituents (index_name);

-- Track when the user last asked to refresh a constituent list.
CREATE TABLE IF NOT EXISTS constituents_meta (
  index_name TEXT PRIMARY KEY,
  refreshed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  source TEXT NOT NULL DEFAULT 'bundled'  -- 'bundled' | 'wikipedia' | 'csv'
);

-- Saved screen presets (FR-2.5).
CREATE TABLE IF NOT EXISTS screen_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  universe TEXT NOT NULL DEFAULT 'sp500',  -- 'sp500' | 'russell1000' | 'both'
  criteria_json TEXT NOT NULL,             -- JSON blob, see ScreenCriteria
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS screen_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id INTEGER REFERENCES screen_presets(id),
  preset_name TEXT,              -- denormalised for display after preset is deleted
  criteria_json TEXT NOT NULL,
  universe TEXT NOT NULL,
  result_count INTEGER NOT NULL DEFAULT 0,
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS screen_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_run_id INTEGER NOT NULL REFERENCES screen_runs(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  company_name TEXT,
  sector TEXT,
  payload_json TEXT NOT NULL      -- JSON: all filter values + pass score
);

CREATE INDEX IF NOT EXISTS idx_screen_results_run
  ON screen_results (screen_run_id);

-- Analysis snapshots (FR-3.7).
CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL REFERENCES watchlists(id),
  mode TEXT NOT NULL,             -- 'buy' | 'options_income' | 'wheel' | 'bullish' | 'bearish'
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  result_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL      -- full analysis output, mode-specific shape
);

-- Fundamentals cache (TTL 24h per NFR-3).
CREATE TABLE IF NOT EXISTS fundamentals_cache (
  ticker TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,      -- DerivedRatios + raw financial summary
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Quote cache (TTL 60s per NFR-3).
CREATE TABLE IF NOT EXISTS quote_cache (
  ticker TEXT PRIMARY KEY,
  last REAL,
  prev_close REAL,
  bid REAL,
  ask REAL,
  volume INTEGER,
  day_high REAL,
  day_low REAL,
  iv_percentile REAL,
  iv_rank REAL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Options chain cache (TTL 5 min per NFR-3).
CREATE TABLE IF NOT EXISTS options_cache (
  ticker TEXT NOT NULL,
  expiration TEXT NOT NULL,       -- ISO date string e.g. '2026-06-20'
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ticker, expiration)
);

CREATE INDEX IF NOT EXISTS idx_options_cache_ticker
  ON options_cache (ticker);