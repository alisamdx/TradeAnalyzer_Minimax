-- Per-pick trade direction for Brief Replay outcomes. Needed because the Inflection
-- strategy mixes long (up-breakout → bull put spread) and short (down-breakout → bear
-- call spread) picks, so a single "stock up = win" rule per strategy is wrong for it.
--   1  = long/bullish thesis (win when the stock rises)
--  -1  = short/bearish thesis (win when the stock falls)
-- NULL on legacy rows → aggregation falls back to the strategy-implied direction
-- (bearish = -1, all others = 1). Populated on the next replay run.
ALTER TABLE replay_outcomes ADD COLUMN direction INTEGER;
