-- 010_screen_runs_watchlist.sql
-- Add watchlist_id to screen_runs so WatchlistService can cascade-delete runs
-- when a watchlist is deleted.  Column is nullable (screen runs may pre-date
-- watchlist association, and foreign-key enforcement is OFF by default in SQLite).
ALTER TABLE screen_runs ADD COLUMN watchlist_id INTEGER REFERENCES watchlists(id);

CREATE INDEX IF NOT EXISTS idx_screen_runs_watchlist
  ON screen_runs (watchlist_id);
