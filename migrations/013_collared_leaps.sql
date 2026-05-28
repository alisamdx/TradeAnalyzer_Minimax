-- 013_collared_leaps.sql
-- Collared LEAPS strategy screener.
-- Position = long deep-ITM LEAPS call + long OTM protective put on same underlying.
-- The put leg is insurance on the LEAPS; its parameters derive from the LEAPS chosen.

CREATE TABLE IF NOT EXISTS collared_leaps_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at            TEXT    NOT NULL,                 -- ISO-8601
  universe          TEXT    NOT NULL,                 -- 'sp500' | 'russell1000' | 'both' | 'watchlist'
  watchlist_id      INTEGER REFERENCES watchlists(id) ON DELETE SET NULL,
  market_gate       TEXT    NOT NULL,                 -- 'PASS' | 'CAUTION' | 'FAIL'
  gate_detail_json  TEXT    NOT NULL,                 -- CollaredLeapsGateDetail as JSON
  gate_effect       TEXT    NOT NULL,                 -- human-readable effect string
  candidate_count   INTEGER NOT NULL DEFAULT 0,       -- tickers that passed universe filter
  opportunity_count INTEGER NOT NULL DEFAULT 0        -- final ranked opportunities persisted
);

CREATE TABLE IF NOT EXISTS collared_leaps_opportunities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                INTEGER NOT NULL REFERENCES collared_leaps_runs(id) ON DELETE CASCADE,
  rank                  INTEGER NOT NULL,

  -- Underlying
  ticker                TEXT    NOT NULL,
  spot                  REAL    NOT NULL,             -- underlying price at screen time
  ma200d                REAL,                         -- 200-day SMA (for put floor scoring)

  -- LEAPS call leg
  leaps_strike          REAL    NOT NULL,
  leaps_expiry          TEXT    NOT NULL,             -- YYYY-MM-DD
  leaps_dte             INTEGER,
  leaps_delta           REAL,
  leaps_debit           REAL,                         -- mid × 100 (per contract)
  leaps_extrinsic_pct   REAL,
  leaps_iv_pct          REAL,
  leaps_ivr             REAL,
  leaps_oi              INTEGER,
  leaps_spread_pct      REAL,
  leaps_sub_score       REAL    NOT NULL,

  -- Protective put leg
  put_strike            REAL    NOT NULL,
  put_expiry            TEXT    NOT NULL,             -- YYYY-MM-DD
  put_dte               INTEGER,
  put_delta             REAL,                         -- negative (e.g. -0.20)
  put_debit             REAL,                         -- mid × 100 (per contract)
  put_iv_pct            REAL,
  put_ivr               REAL,
  put_oi                INTEGER,
  put_spread_pct        REAL,
  put_sub_score         REAL    NOT NULL,

  -- Structural metrics
  cost_drag_pct         REAL    NOT NULL,             -- put_debit / leaps_debit × 100
  floor_depth_pct       REAL    NOT NULL,             -- (spot - put_strike) / spot × 100
  breakeven             REAL    NOT NULL,             -- leaps_strike + total_debit / 100
  max_loss_at_put       REAL,                         -- loss if stock = put_strike at expiry
  max_loss_at_zero      REAL    NOT NULL,             -- worst case: stock → 0 (can be negative = fully hedged)
  upside_retention_pct  REAL    NOT NULL,             -- collared P&L / naked LEAPS P&L at +20% move
  hedge_efficiency_pct  REAL    NOT NULL,             -- (naked_max_loss - collared_max_loss) / naked_max_loss × 100
  rr_ratio              REAL,                         -- max_profit_est / max_loss_at_put

  -- Combined scoring
  structural_sub_score  REAL    NOT NULL,
  combined_score        REAL    NOT NULL,
  grade                 TEXT    NOT NULL,             -- 'A+' | 'A' | 'B' | 'C' | 'F'
  caution_flags         TEXT,                         -- comma-separated flag codes (nullable)
  gate_survived         INTEGER NOT NULL DEFAULT 0,   -- 1 if collar passes FAIL-gate structural test

  -- Full detail: score breakdowns + P&L grid for payoff chart
  detail_json           TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_cl_opp_run    ON collared_leaps_opportunities (run_id, rank);
CREATE INDEX IF NOT EXISTS idx_cl_opp_grade  ON collared_leaps_opportunities (run_id, grade);
CREATE INDEX IF NOT EXISTS idx_cl_opp_ticker ON collared_leaps_opportunities (run_id, ticker);

-- User-marked opened positions (for exit-rule monitoring)
CREATE TABLE IF NOT EXISTS collared_leaps_opened (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id    INTEGER NOT NULL REFERENCES collared_leaps_opportunities(id) ON DELETE CASCADE,
  opened_at         TEXT    NOT NULL,
  leaps_entry_debit REAL,                             -- actual debit paid for LEAPS leg
  put_entry_debit   REAL,                             -- actual debit paid for put leg
  notes             TEXT
);
