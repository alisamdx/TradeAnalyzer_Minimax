-- Brief Replay: point-in-time back-test tables.
-- Stores scored picks per historical date and their forward return outcomes.
-- see Requirements/BRIEF_REPLAY_SPEC.md

CREATE TABLE IF NOT EXISTS replay_briefs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  as_of_date     TEXT NOT NULL,
  strategy       TEXT NOT NULL,
  picks          TEXT NOT NULL DEFAULT '[]',
  config_version TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(as_of_date, strategy)
);

CREATE INDEX IF NOT EXISTS idx_replay_briefs_date     ON replay_briefs (as_of_date);
CREATE INDEX IF NOT EXISTS idx_replay_briefs_strategy ON replay_briefs (strategy, as_of_date);

CREATE TABLE IF NOT EXISTS replay_outcomes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_brief_id      INTEGER NOT NULL REFERENCES replay_briefs(id) ON DELETE CASCADE,
  ticker               TEXT    NOT NULL,
  rank                 INTEGER NOT NULL,
  composite_score      REAL    NOT NULL,
  entry_price          REAL,
  ret_5d               REAL,
  ret_10d              REAL,
  ret_21d              REAL,
  synth_strike         REAL,
  stayed_above_strike  INTEGER,
  max_drawdown_21d     REAL,
  evaluated_at         TEXT,
  UNIQUE(replay_brief_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_replay_outcomes_brief  ON replay_outcomes (replay_brief_id);
CREATE INDEX IF NOT EXISTS idx_replay_outcomes_ticker ON replay_outcomes (ticker);
