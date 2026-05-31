-- Migration 019: ETF Universe support
-- Adds 'etf' as a valid index_name in constituents / constituents_meta.
-- No schema changes required — the constituents table already allows any TEXT
-- value for index_name. This migration exists as a marker so the migration
-- runner records the version bump.
-- Actual ETF rows are seeded at startup via bootstrapFromBundled('etf'),
-- which uses INSERT OR IGNORE so it is safe to run repeatedly.
SELECT 1; -- no-op DDL placeholder
