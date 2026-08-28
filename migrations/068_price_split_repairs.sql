-- 068: audit trail for split-adjustment repairs of historical_prices.
--
-- Polygon aggregates are requested with adjusted=true, so every fetch returns a series
-- correctly adjusted AS OF THAT FETCH. But bars are stored incrementally and never
-- revisited: price-gap-fill only re-fetches a ~3-day window. When a split later occurs,
-- the old stored bars keep their PRE-split prices while new bars arrive POST-split,
-- leaving a permanent discontinuity in the middle of the series.
--
-- Measured 2026-08-28 over Jun-Aug: CRWD -74% in one day (4:1 split), DD +203%,
-- MRNA +177%, HON +95%, KLAC +89% (reverse splits) — against SPY's largest real
-- daily move of 2.58%. Any indicator spanning such a date is wrong, which reaches
-- the scoring engine's technicals, the backtest engine, and Brief Replay — the tool
-- FR-SEY-5 relies on to validate trade-logic changes.
--
-- One row per (ticker, discontinuity_date):
--   status='repaired'      → a full re-fetch removed the jump (it was a split)
--   status='confirmed_real'→ the jump survived a re-fetch, so it is a genuine move
--                            (earnings collapse, buyout). Recorded so the detector
--                            never re-fetches it again on every subsequent run.
CREATE TABLE IF NOT EXISTS price_split_repairs (
  ticker             TEXT NOT NULL,
  discontinuity_date TEXT NOT NULL,          -- the bar whose close jumped vs the prior bar
  ratio              REAL NOT NULL,          -- close / prev_close (0.25 = 4:1 split, 3.0 = 1:3 reverse)
  status             TEXT NOT NULL CHECK (status IN ('repaired','confirmed_real')),
  bars_rewritten     INTEGER,
  detected_at        TEXT NOT NULL,
  resolved_at        TEXT,
  PRIMARY KEY (ticker, discontinuity_date)
);

CREATE INDEX IF NOT EXISTS idx_price_split_repairs_status
  ON price_split_repairs(status);
