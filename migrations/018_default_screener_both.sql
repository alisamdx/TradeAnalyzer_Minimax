-- Migration 018: Change default screener universe from 'sp500' to 'both'.
-- Only updates rows where the value is still the old default ('sp500' stored
-- as a plain string). Users who explicitly chose sp500 in Settings keep their
-- choice — we only reset the factory default value.
UPDATE settings SET value = 'both' WHERE key = 'defaultScreenerIndex' AND value = 'sp500';
