-- Migration 059: lean intraday batch (Requirements/v2-execution/08-unattended-operation.md §4, #4).
--
-- The daily brief sits at position 8 in the job sequence; everything after it (options snapshot,
-- paper snapshot, earnings refresh, options-premium history) runs AFTER the brief is committed and
-- so cannot contribute to it. The lean ~10:15 slot runs the brief's upstream closure (jobs 2–8) and
-- SKIPS this post-brief tail; the after-close ~17:00 slot runs everything. Per-job flag so a job can
-- be re-classified from the Batch view without a code change.
--
-- For existing installs the batch_jobs rows already exist, so the UPDATE below sets the tail. For a
-- fresh install the rows don't exist yet at migration time; registerJob seeds the flag via its new
-- `afterCloseOnly` option on first insert. Either path leaves user toggles (UI) intact afterward.
--
-- Validation-exempt per FR-SEY-5: the lean brief is bit-identical (same upstream job closure) — only
-- the post-brief housekeeping is deferred.

ALTER TABLE batch_jobs ADD COLUMN after_close_only INTEGER NOT NULL DEFAULT 0;

UPDATE batch_jobs SET after_close_only = 1
WHERE id IN (
  'daily-options-snapshot',
  'daily-paper-snapshot',
  'earnings-refresh',
  'daily-options-premium-history'
);
