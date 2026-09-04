-- 076: Persist the whole Stage-4 candidate pool, not just the picks that survive it.
--
-- WHY. When a ranking's quality is in question, the LOSERS are the data you need — and this
-- pipeline discarded exactly those. `daily_briefs` stores only the top PICKS_PER_STRATEGY (5) out
-- of a STAGE4_POOL_SIZE (15) pool, so the top-5 cut itself has never been measurable. That became
-- the open question in v1.1.173/174: the wheel composite is anti-predictive at the top (mean
-- return on capital +1.91% in the 58-63 band vs -4.99% at 73+), and the cut is where that would
-- do its damage. The dice tiebreak turned out to be nearly vacuous, so this cut is the remaining
-- exposure — and it cannot be tested retroactively, only from the moment capture begins.
--
-- WHY A SEPARATE SLIM TABLE rather than keeping `daily_briefs` longer. Measured 2026-09-03:
-- daily_briefs holds 52.8 MB across 366 rows — 147.7 KB per row, because each row carries the
-- full strategyLabResult for every pick — which is ~9% of the 567 MB database and would grow
-- ~229 MB per trading year unpruned. That is why `pruneStaleBriefs(90)` hard-deletes them, and in
-- turn why every study in this project reports "one regime". This table keeps only what a study
-- needs: ~90 rows/day at ~150 bytes, about 3.4 MB per trading year, roughly 1/70th the cost. So
-- the briefs can keep their 90-day window for the UI while the evidence outlives it.
--
-- Outcomes are deliberately NOT stored. They are derived later by settling `strike`/`premium`
-- against `historical_prices` at `expiration`, exactly as the study scripts already do — storing
-- a computed outcome would freeze it against a price series that later gets split-repaired.
-- `spot` IS stored, because the split scale guard needs the underlying price as of the pick date
-- and that is the one input which cannot be recovered once a repair rewrites history.
--
-- see docs/wheel-parameters.md, scripts/fr-dice-tiebreak-study.mjs

CREATE TABLE IF NOT EXISTS brief_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date      TEXT    NOT NULL,           -- brief date, YYYY-MM-DD (ET)
  generated_at    TEXT    NOT NULL,           -- full timestamp of the run that wrote this
  strategy        TEXT    NOT NULL,
  ticker          TEXT    NOT NULL,
  composite_score REAL    NOT NULL,
  rank            INTEGER NOT NULL,           -- rank within strategy by composite, 1 = best

  -- How far the candidate got. 'picked' survived into the brief; the rest are the losers this
  -- table exists to keep.
  --   picked           — in the final top-5
  --   capped_out       — cleared the liquidity gate but was outranked by the cap
  --   failed_liquidity — rejected by hasAdequateLiquidity
  --   not_validated    — reached the queue but Stage-4 validation produced no lab result
  disposition     TEXT    NOT NULL CHECK (disposition IN
                    ('picked', 'capped_out', 'failed_liquidity', 'not_validated')),

  -- The structure the lab actually built for this strategy, when there was one. Null for
  -- not_validated rows and for candidates with no relevant constructible structure.
  structure_slug  TEXT,
  strike          REAL,
  premium         REAL,                       -- per share, the short leg's mid
  expiration      TEXT,
  dte             INTEGER,
  liquidity_score REAL,
  spot            REAL,                       -- underlying at pick time; needed by the scale guard

  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The batch runs twice a trading day and the after-close slot must overwrite the morning's
-- partial view, so a candidate is unique per (date, strategy, ticker) and re-runs REPLACE.
-- see CLAUDE.md "the batch runs twice a trading day"
CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_candidates_unique
  ON brief_candidates (as_of_date, strategy, ticker);

CREATE INDEX IF NOT EXISTS idx_brief_candidates_lookup
  ON brief_candidates (strategy, as_of_date);

-- Settling a candidate joins on ticker + expiration against historical_prices.
CREATE INDEX IF NOT EXISTS idx_brief_candidates_settle
  ON brief_candidates (ticker, expiration);
