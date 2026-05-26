-- 012_leaps_csp_watchlist.sql
-- Add watchlist_id column to leaps_csp_runs to support running against a watchlist
-- instead of only a screener universe.

ALTER TABLE leaps_csp_runs ADD COLUMN watchlist_id INTEGER REFERENCES watchlists(id) ON DELETE SET NULL;