-- 067: run earnings-refresh BEFORE the daily intelligence brief, and drop
-- far-dated Finnhub rows poisoned by the old truncated bulk call.
--
-- The brief's -20 earnings penalty (income/wheel/bearish) reads earnings_calendar,
-- but earnings-refresh was registered AFTER the brief, so every brief scored against
-- a calendar refreshed only at the END of the previous chain — one cycle stale even
-- when the data was right.
--
-- Ordering: the 10..12 block becomes earnings-refresh, brief, paper-snapshot.
UPDATE batch_jobs SET sequence_order = 11 WHERE id = 'daily-intelligence-brief';
UPDATE batch_jobs SET sequence_order = 12 WHERE id = 'daily-paper-snapshot';
UPDATE batch_jobs SET sequence_order = 10 WHERE id = 'earnings-refresh';

-- after_close_only stays 1: earnings dates are slow-moving, so the intraday brief
-- scoring against the previous after-close refresh (<24h old) is acceptable, and the
-- adaptive sweep is too many API calls to add to the lean intraday slot (spec 08 §4).

-- Backfill: Finnhub's bulk calendar caps at 1500 entries and truncates from the FRONT,
-- so the old fixed-window call could only ever write dates from the TAIL of the range.
-- Any non-manual row far in the future is that bug's signature — one full quarter late
-- (this is how NVDA's 2026-08-26 report was stored as 2026-11-17). Deleting them makes
-- the next earnings-refresh run re-verify each one per ticker, which returns every
-- quarter and picks the nearest. Correct far dates simply get re-fetched unchanged.
DELETE FROM earnings_calendar
 WHERE source != 'manual'
   AND report_date > date('now', '+120 days');
