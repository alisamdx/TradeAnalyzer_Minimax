-- "In play" flag for My Stocks (Conviction List). A transient on/off marker the user
-- toggles to say "this stock is in play — I may act on it" (e.g. tomorrow). Not a price
-- band, so it is NOT written to conviction_band_history.
ALTER TABLE conviction_stocks ADD COLUMN in_play INTEGER NOT NULL DEFAULT 0;
