-- Instrumentation for the after-close liquidity measurement artifact (NEW_FRONTIER §11).
-- The evening brief DELETEs the same-day morning brief rows (storeBrief), destroying the
-- intraday liquidity measurements needed to calibrate how much lower after-close
-- liquidityScores read vs market hours. This side table persists every Stage-4 structure
-- measurement (per ticker+slug, per run) so intraday/after-close pairs accumulate.
-- Pure instrumentation — nothing reads it on the live path. Pruned to ~120 days by the
-- brief job.
CREATE TABLE IF NOT EXISTS structure_liquidity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at TEXT NOT NULL,          -- UTC ISO timestamp of the measurement
  date_et TEXT NOT NULL,              -- ET calendar date (YYYY-MM-DD) for slot pairing
  ticker TEXT NOT NULL,
  slug TEXT NOT NULL,                 -- Strategy Lab structure slug
  liquidity_score REAL,               -- lab liquidityScore 0-15 (null if absent)
  grade TEXT,                         -- lab grade (A+..F)
  no_bid_leg INTEGER NOT NULL DEFAULT 0  -- 1 when any leg has bid <= 0
);

CREATE INDEX IF NOT EXISTS idx_sll_pair ON structure_liquidity_log (date_et, ticker, slug);
