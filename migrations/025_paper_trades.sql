-- Paper Trading / Retrospect (v0.23.0)
-- Tracks daily-brief picks as paper trades for scoring-engine validation.
-- Unique key: (ticker, brief_strategy, brief_date) — same-day re-runs update, not duplicate.
CREATE TABLE IF NOT EXISTS paper_trades (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_id          INTEGER REFERENCES daily_briefs(id) ON DELETE SET NULL,
  brief_strategy    TEXT NOT NULL,   -- 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy'
  brief_score       REAL,            -- compositeScore at time of brief
  brief_rank        INTEGER,         -- pick rank within the strategy list
  ticker            TEXT NOT NULL,
  brief_date        TEXT NOT NULL,   -- YYYY-MM-DD ET (date brief was generated)
  strategy_name     TEXT,            -- e.g. 'Cash-Secured Put' from StrategyLab
  legs_json         TEXT NOT NULL DEFAULT '[]',
  entry_date        TEXT NOT NULL,   -- YYYY-MM-DD
  entry_price       REAL,            -- stock price at entry
  entry_premium     REAL,            -- net credit (positive) or debit (negative) per share
  expiry_date       TEXT,            -- YYYY-MM-DD from primary StrategyLab leg (null if no expiry)
  status            TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' | 'expired'
  exit_date         TEXT,
  exit_price        REAL,
  exit_notes        TEXT,
  stock_return_pct  REAL,            -- (exit_price - entry_price) / entry_price * 100
  outcome           TEXT,            -- 'win' | 'loss' | 'breakeven' (set at close/expire)
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(ticker, brief_strategy, brief_date)
);

CREATE INDEX IF NOT EXISTS idx_paper_trades_ticker   ON paper_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status   ON paper_trades(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy ON paper_trades(brief_strategy);
CREATE INDEX IF NOT EXISTS idx_paper_trades_date     ON paper_trades(brief_date DESC);
