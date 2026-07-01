-- Make room at sequence 2 for the constituents-refresh job, which must run before
-- Market Sync so the evening sync sees today's index membership. The job row itself
-- is seeded by BatchService.registerJob (INSERT OR IGNORE) at startup.
UPDATE batch_jobs SET sequence_order = sequence_order + 1 WHERE sequence_order >= 2;
