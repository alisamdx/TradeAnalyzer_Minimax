-- Migration 027: Insert Daily Screener job at sequence position 3 and
-- shift all downstream jobs up by one so the final order is:
--   1. daily-market-sync-stocks
--   2. daily-market-sync-etfs
--   3. daily-screener          ← new
--   4. daily-price-gap-fill
--   5. daily-technical-signals
--   6. daily-iv-update
--   7. daily-options-snapshot
--   8. daily-intelligence-brief
--
-- Uses explicit SET to be idempotent — safe to re-run.

UPDATE batch_jobs SET sequence_order = 1 WHERE id = 'daily-market-sync-stocks';
UPDATE batch_jobs SET sequence_order = 2 WHERE id = 'daily-market-sync-etfs';
UPDATE batch_jobs SET sequence_order = 3 WHERE id = 'daily-screener';
UPDATE batch_jobs SET sequence_order = 4 WHERE id = 'daily-price-gap-fill';
UPDATE batch_jobs SET sequence_order = 5 WHERE id = 'daily-technical-signals';
UPDATE batch_jobs SET sequence_order = 6 WHERE id = 'daily-iv-update';
UPDATE batch_jobs SET sequence_order = 7 WHERE id = 'daily-options-snapshot';
UPDATE batch_jobs SET sequence_order = 8 WHERE id = 'daily-intelligence-brief';
