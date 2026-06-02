-- v0.22.7: Trade Scoring Engine + Daily Intelligence Brief tables

CREATE TABLE IF NOT EXISTS scoring_strategy_configs (
  strategy    TEXT PRIMARY KEY,  -- 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy'
  signals     TEXT NOT NULL,     -- JSON: ScoringSignal[]
  version     TEXT NOT NULL DEFAULT 'baseline_v1',
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS daily_briefs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,    -- ISO timestamp
  valid_until  TEXT NOT NULL,    -- ISO timestamp (next trading day 9:30am ET)
  strategy     TEXT NOT NULL,    -- 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy'
  picks        TEXT NOT NULL,    -- JSON: BriefPick[]
  run_meta     TEXT              -- JSON: stage timing, counts, errors
);

CREATE INDEX IF NOT EXISTS idx_daily_briefs_generated_at ON daily_briefs (generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_briefs_strategy     ON daily_briefs (strategy);
