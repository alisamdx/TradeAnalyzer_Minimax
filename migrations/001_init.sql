-- 001_init.sql — Phase 1 schema.
-- Only the tables needed for FR-1 (watchlist management) plus the migrations bookkeeping
-- table. Cache and job tables (per spec §8) arrive in their owning phases.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Case-insensitive uniqueness on name without changing column collation
-- (so display preserves the user's chosen casing).
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlists_lower_name
  ON watchlists (lower(name));

CREATE TABLE IF NOT EXISTS watchlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  notes TEXT,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A ticker can appear at most once per watchlist (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_items_unique
  ON watchlist_items (watchlist_id, upper(ticker));

CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist
  ON watchlist_items (watchlist_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
