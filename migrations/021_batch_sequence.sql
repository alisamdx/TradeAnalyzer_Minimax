-- Add sequence_order to batch_jobs so jobs with the same schedule run in a user-defined order.
-- Existing rows get numbered 1..N in current insertion order (by rowid).

ALTER TABLE batch_jobs ADD COLUMN sequence_order INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY rowid) AS rn FROM batch_jobs
)
UPDATE batch_jobs SET sequence_order = (
  SELECT rn FROM ordered WHERE ordered.id = batch_jobs.id
);
