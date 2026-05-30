-- 014_ai_portfolio_advisor.sql
-- Phase 1: E*Trade sync columns on positions
-- Phase 2: per-position analysis table
-- Phase 3: AI advisor sessions table

-- ─── Phase 1: Extend positions table with E*Trade fields ──────────────────────

ALTER TABLE positions ADD COLUMN etrade_position_id INTEGER;
ALTER TABLE positions ADD COLUMN etrade_account_id TEXT;
ALTER TABLE positions ADD COLUMN market_value REAL;
ALTER TABLE positions ADD COLUMN total_gain_pct REAL;
ALTER TABLE positions ADD COLUMN days_gain REAL;
ALTER TABLE positions ADD COLUMN days_gain_pct REAL;
ALTER TABLE positions ADD COLUMN cost_per_share REAL;
ALTER TABLE positions ADD COLUMN pct_of_portfolio REAL;
ALTER TABLE positions ADD COLUMN delta REAL;
ALTER TABLE positions ADD COLUMN gamma REAL;
ALTER TABLE positions ADD COLUMN theta REAL;
ALTER TABLE positions ADD COLUMN vega REAL;
ALTER TABLE positions ADD COLUMN iv REAL;           -- percentage (e.g. 35.5)
ALTER TABLE positions ADD COLUMN beta REAL;
ALTER TABLE positions ADD COLUMN last_synced_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_etrade_id
  ON positions (etrade_position_id)
  WHERE etrade_position_id IS NOT NULL;

-- ─── Phase 2: Per-position analysis ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS position_analysis (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id         INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  analyzed_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  -- Technical signals
  trend               TEXT,               -- 'bullish' | 'bearish' | 'sideways'
  rsi                 REAL,
  sma20               REAL,
  sma50               REAL,
  sma200              REAL,
  support_level       REAL,
  resistance_level    REAL,
  composite_score     REAL,               -- 0–10 from analysis engine

  -- Position metrics
  days_in_position    INTEGER,
  current_return_pct  REAL,
  annualized_return   REAL,

  -- Options-specific (CSP/CC)
  current_delta       REAL,
  theta_decay         REAL,               -- daily theta
  iv_rank             REAL,
  assignment_risk     TEXT,               -- 'low' | 'medium' | 'high'
  roll_opportunity    TEXT,               -- JSON RollOpportunity or NULL

  -- Recommendation
  action              TEXT NOT NULL,      -- 'hold' | 'close' | 'roll' | 'hedge' | 'take_profits'
  conviction          INTEGER NOT NULL,   -- 1=low 2=medium 3=high
  explanation         TEXT NOT NULL,

  UNIQUE(position_id)                     -- one active analysis per position (upsert)
);

CREATE INDEX IF NOT EXISTS idx_position_analysis_position
  ON position_analysis (position_id);

-- ─── Phase 3: AI advisor sessions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advisor_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  positions_json      TEXT NOT NULL,      -- snapshot of positions sent to LLM
  advice_text         TEXT NOT NULL,      -- raw LLM response
  action_items_json   TEXT,               -- JSON array of AdvisorActionItem
  position_advice_json TEXT,              -- JSON map positionId → advice string
  observations_json   TEXT,              -- JSON array of portfolio-level observations
  model               TEXT NOT NULL,
  input_tokens        INTEGER,
  output_tokens       INTEGER
);
