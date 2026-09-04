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
-- turn why every study in this project reports "one regime". These rows cost ~20 MB per trading
-- year, so the briefs can keep their 90-day window for the UI while the evidence outlives it.
--
-- WHY IT CAPTURES MORE THAN THE CUT ITSELF NEEDS. Three separate studies in this project have
-- been blocked not by analysis but by CAPTURE: the liquidity A/B had to run on income because
-- wheel rows lacked bid/ask/open_interest until v1.1.132 (and wheel is still untestable until
-- those settle); the ETF-deflation gate was unsatisfiable because no ETF outcome had ever been
-- generated; and this cut, whose losers were thrown away. Every study also ended on the same
-- follow-up — WHICH SIGNAL caused it — which `signals_json` answers directly instead of leaving
-- it to be inferred from weights. Capture is one-directional: what is not written today cannot be
-- recovered, so the marginal columns are taken now while they are free.
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

  -- Per-signal {raw, normalized, weight, missing} as scored, same shape daily_briefs keeps for
  -- picks. ~689 bytes. This is what turns "the composite selected badly" into "THIS SIGNAL
  -- selected badly" — the question every prior study ended on and had to infer.
  signals_json    TEXT,

  -- The structure the lab actually built for this strategy, when there was one. Null for
  -- not_validated rows and for candidates with no relevant constructible structure.
  structure_slug  TEXT,
  grade           TEXT,
  strike          REAL,
  premium         REAL,                       -- per share, the short leg's mid
  expiration      TEXT,
  dte             INTEGER,
  liquidity_score REAL,
  spot            REAL,                       -- underlying at pick time; needed by the scale guard

  -- Option economics of the short leg. `delta` because v1.1.171 showed it drives outcomes
  -- materially (+0.65pp per matched-pair episode), so a selection study must control for it.
  -- bid/ask/open_interest because their absence on wheel rows is precisely what forced the
  -- v1.1.170 liquidity A/B onto income as a proxy — not repeating that.
  delta           REAL,
  leg_iv          REAL,
  bid             REAL,
  ask             REAL,
  open_interest   INTEGER,

  -- Trade economics as the lab computed them, for free at capture time.
  net_credit      REAL,
  max_loss        REAL,
  annualized_return REAL,
  pop_estimate    REAL,
  atm_iv          REAL,

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
