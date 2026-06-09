-- Add ADX (trend strength) and support_level (20-day low) to technical_signals.
-- ADX feeds the trendNeutral signal for income strategy scoring.
-- support_level feeds the breakoutScore entryZoneLow component for buy strategy scoring.
ALTER TABLE technical_signals ADD COLUMN adx REAL;
ALTER TABLE technical_signals ADD COLUMN support_level REAL;
