-- Migration 046: entry-policy configuration for the v2 execution engine.
-- Adds the configurable entry filters/caps (Requirements/v2-execution 03-lifecycle §3.6)
-- to the singleton exec_config row. Exit-policy columns come later (Phase 4c).
-- SQLite ADD COLUMN with a constant NOT NULL DEFAULT is safe + backfills the existing row.

ALTER TABLE exec_config ADD COLUMN min_composite_score          REAL    NOT NULL DEFAULT 70;
ALTER TABLE exec_config ADD COLUMN max_new_entries_per_day      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE exec_config ADD COLUMN max_new_entries_per_week     INTEGER NOT NULL DEFAULT 3;
ALTER TABLE exec_config ADD COLUMN avoid_earnings_before_expiry INTEGER NOT NULL DEFAULT 1;  -- 0/1
ALTER TABLE exec_config ADD COLUMN entry_window_start           TEXT    NOT NULL DEFAULT '10:00';  -- ET HH:MM
ALTER TABLE exec_config ADD COLUMN entry_window_end             TEXT    NOT NULL DEFAULT '15:00';  -- ET HH:MM
ALTER TABLE exec_config ADD COLUMN reprice_tolerance_pct        REAL    NOT NULL DEFAULT 10;        -- proposal re-price guard
