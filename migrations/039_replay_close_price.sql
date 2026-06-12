-- Add close_price and close_date to replay_outcomes.
-- close_date = the global replay "To" date (max as_of_date across all briefs in the run).
-- close_price = the ticker's closing price on that date.
-- Together they let you compare Entry (pick date) vs Close (run end date) per pick.

ALTER TABLE replay_outcomes ADD COLUMN close_price REAL;
ALTER TABLE replay_outcomes ADD COLUMN close_date  TEXT;
