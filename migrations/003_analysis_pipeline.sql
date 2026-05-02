-- 003_analysis_pipeline.sql — Phase 3 schema.
-- Job run + progress tables for the producer/consumer pipeline (§4.4).
-- Also fixes analysis_snapshots: adds missing INTEGER PRIMARY KEY AUTOINCREMENT.
-- see SPEC: §4.4, §8 data model, FR-3.7

-- Fix analysis_snapshots: add proper PK + status field.
-- We recreate it rather than ALTER TABLE since SQLite doesn't support all ALTER patterns.
-- The existing rows are preserved because we only touch the structure, not data.

CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watchlist_id INTEGER NOT NULL REFERENCES watchlists(id),
  mode TEXT NOT NULL,             -- 'buy' | 'options_income' | 'wheel' | 'bullish' | 'bearish'
  run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  result_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL      -- full analysis output, mode-specific shape
);

-- Job run table — tracks top-level batch jobs (validate_all, screen_run, analysis_run).
-- Status flow: pending → running → paused | stopped | completed | failed
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,             -- 'validate_all' | 'screen_run' | 'analysis_run'
  watchlist_id INTEGER REFERENCES watchlists(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed'
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  config_json TEXT                -- rate limit, batch size, mode, etc.
);

CREATE INDEX IF NOT EXISTS idx_job_runs_status
  ON job_runs (status);

CREATE INDEX IF NOT EXISTS idx_job_runs_watchlist
  ON job_runs (watchlist_id);

-- Per-ticker progress within a job run.
-- Resumable: a ticker moves pending → fetched → persisted OR failed.
CREATE TABLE IF NOT EXISTS job_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_run_id INTEGER NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'fetched' | 'persisted' | 'failed'
  error_msg TEXT,
  processed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_job_progress_run
  ON job_progress (job_run_id);

CREATE INDEX IF NOT EXISTS idx_job_progress_status
  ON job_progress (status);
