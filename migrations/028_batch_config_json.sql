-- Migration 028: Add config_json column to batch_jobs for per-job settings.
-- Used by DailyIvCaptureJob to store callDelayMs (PERF-1).
-- NULL means "use built-in defaults" — all existing jobs are unaffected.

ALTER TABLE batch_jobs ADD COLUMN config_json TEXT;
