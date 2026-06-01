-- v0.21.0: Batch job scheduling infrastructure
-- Stores job definitions and run history for recurring background tasks.

CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  run_on_startup INTEGER NOT NULL DEFAULT 1,
  startup_delay_seconds INTEGER NOT NULL DEFAULT 30,
  daily_schedule_enabled INTEGER NOT NULL DEFAULT 1,
  daily_schedule_time TEXT NOT NULL DEFAULT '16:00',
  last_run_at TEXT,
  last_run_status TEXT,
  last_success_date TEXT
);

CREATE TABLE IF NOT EXISTS batch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES batch_jobs(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  tickers_attempted INTEGER NOT NULL DEFAULT 0,
  tickers_updated INTEGER NOT NULL DEFAULT 0,
  tickers_skipped INTEGER NOT NULL DEFAULT 0,
  tickers_failed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  error_message TEXT
);
