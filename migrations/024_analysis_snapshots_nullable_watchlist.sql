-- Migration 024: Allow analysis_snapshots.watchlist_id to be NULL.
-- Batch jobs (e.g. DailyOptionsSnapshotJob) generate snapshots outside the
-- context of a user watchlist. SQLite doesn't support ALTER COLUMN, so we
-- recreate the table with the constraint relaxed.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS analysis_snapshots_v2 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id  INTEGER REFERENCES watchlists(id),   -- NULL for batch-generated snapshots
  mode          TEXT    NOT NULL,
  run_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  result_count  INTEGER NOT NULL DEFAULT 0,
  payload_json  TEXT    NOT NULL
);

INSERT INTO analysis_snapshots_v2
  SELECT id, watchlist_id, mode, run_at, result_count, payload_json
  FROM analysis_snapshots;

DROP TABLE analysis_snapshots;

ALTER TABLE analysis_snapshots_v2 RENAME TO analysis_snapshots;

PRAGMA foreign_keys = ON;
