-- 074: portfolio-sync must not carry its own daily schedule.
--
-- `registerJob` defaults `dailyScheduleEnabled` to TRUE, and v1.1.159 registered portfolio-sync
-- without overriding it. Only `batch-orchestrator` is meant to hold a schedule -- every other
-- job is driven by the chain in `sequence_order`. Left enabled, this job would have run TWICE
-- a day: once on its own 17:45 timer and once inside the after-close chain.
--
-- Not merely wasteful: a second unattended run writes to the real position record, and the
-- audit log would show two sets of writes per day with no obvious cause.
--
-- Verified against the live table when this was caught -- every sub-job carries
-- daily_schedule_enabled = 0 and only batch-orchestrator has 1.
--
-- `INSERT OR IGNORE` in registerJob never re-seeds an existing row, so fixing the code alone
-- does nothing for an install that already ran v1.1.159. Same frozen-column trap as
-- config_json (v1.1.121), after_close_only (v1.1.123) and sequence_order (migration 067).
UPDATE batch_jobs
   SET daily_schedule_enabled = 0
 WHERE id = 'portfolio-sync';
