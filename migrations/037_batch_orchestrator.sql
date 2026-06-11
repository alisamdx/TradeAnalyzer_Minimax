-- Shift all existing batch jobs to make room for orchestrator at position 1.
UPDATE batch_jobs SET sequence_order = sequence_order + 1;

-- Add run context columns so each batch_run records how it was triggered
-- and which scheduler slot fired it (null = manual / startup / API trigger).
ALTER TABLE batch_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE batch_runs ADD COLUMN slot_time TEXT;
