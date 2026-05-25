-- 011_leaps_csp.sql
-- LEAPS + CSP strategy module (Phase 1).
-- Stores screening runs, ranked opportunities, and user-marked open positions.

CREATE TABLE IF NOT EXISTS leaps_csp_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at              TEXT    NOT NULL,               -- ISO-8601
  universe            TEXT    NOT NULL,               -- 'sp500' | 'russell1000' | 'both'
  market_gate         TEXT    NOT NULL,               -- 'PASS' | 'CAUTION' | 'FAIL'
  gate_detail_json    TEXT    NOT NULL,               -- { spx, spx50d, spx200d, vix, vix5dChange, hygIefRatio, hygIefTrend }
  gate_effect         TEXT    NOT NULL,               -- human-readable effect string
  candidate_count     INTEGER NOT NULL DEFAULT 0,
  opportunity_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leaps_csp_opportunities (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              INTEGER NOT NULL REFERENCES leaps_csp_runs(id) ON DELETE CASCADE,
  rank                INTEGER NOT NULL,
  pairing_mode        TEXT    NOT NULL,               -- 'same_ticker' | 'different_ticker' | 'leaps_only'

  -- Leg A: LEAPS call
  leaps_ticker        TEXT    NOT NULL,
  leaps_current_price REAL,
  leaps_strike        REAL    NOT NULL,
  leaps_expiry        TEXT    NOT NULL,               -- YYYY-MM-DD
  leaps_dte           INTEGER,
  leaps_delta         REAL,
  leaps_premium       REAL,                           -- mid price × 100 per contract
  leaps_extrinsic_pct REAL,                           -- (premium - intrinsic) / premium %
  leaps_iv_pct        REAL,                           -- contract IV as %
  leaps_ivr           REAL,                           -- IV rank 0-100
  leaps_oi            INTEGER,
  leaps_sub_score     REAL    NOT NULL,

  -- Leg B: CSP short put
  csp_ticker          TEXT,
  csp_current_price   REAL,
  csp_strike          REAL,
  csp_expiry          TEXT,
  csp_dte             INTEGER,
  csp_delta           REAL,
  csp_premium         REAL,                           -- per-share credit
  csp_collateral      REAL,                           -- strike × 100
  csp_ann_return_pct  REAL,
  csp_iv_pct          REAL,
  csp_ivr             REAL,
  csp_oi              INTEGER,
  csp_sub_score       REAL,

  -- Combined
  combined_score      REAL    NOT NULL,
  grade               TEXT    NOT NULL,               -- 'A+' | 'A' | 'B' | 'C' | 'F'
  caution_flags       TEXT,                           -- comma-separated flag codes
  total_cash_to_deploy REAL,

  -- Full scoring breakdown for detail panel (Phase 2)
  detail_json         TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_leaps_csp_opp_run  ON leaps_csp_opportunities (run_id, rank);
CREATE INDEX IF NOT EXISTS idx_leaps_csp_opp_grade ON leaps_csp_opportunities (run_id, grade);

-- Tracks opportunities the user has marked as opened (for exit-rule monitoring in Phase 2)
CREATE TABLE IF NOT EXISTS leaps_csp_opened (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id   INTEGER NOT NULL REFERENCES leaps_csp_opportunities(id) ON DELETE CASCADE,
  opened_at        TEXT    NOT NULL,
  leaps_entry_debit REAL,                             -- actual debit paid per contract
  csp_entry_credit  REAL,                             -- actual credit received per contract
  notes            TEXT
);
