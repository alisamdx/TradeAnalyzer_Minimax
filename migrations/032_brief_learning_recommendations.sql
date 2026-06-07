-- Brief learning recommendations (v0.29.0)
-- Generated when the same gap cause recurs ≥3 times across paper trades,
-- mirroring the Agent's generate_recommendations() pattern.
-- UNIQUE(strategy, gap_cause) — one recommendation per strategy+cause pair, replaced on re-trigger.
CREATE TABLE IF NOT EXISTS brief_learning_recommendations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy         TEXT    NOT NULL,  -- ScoringStrategy or 'all'
  gap_cause        TEXT    NOT NULL,  -- gap cause code (see TradeLearning.gapCause)
  occurrence_count INTEGER NOT NULL,
  description      TEXT    NOT NULL,  -- plain-English explanation
  proposed_tweak   TEXT    NOT NULL,  -- specific action to consider
  status           TEXT    NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged'
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(strategy, gap_cause)
);
