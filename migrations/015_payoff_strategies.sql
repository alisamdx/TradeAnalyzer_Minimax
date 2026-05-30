-- Migration 015: Payoff Visualizer saved strategies
-- Stores named multi-leg strategy configurations for reuse.

CREATE TABLE IF NOT EXISTS payoff_strategies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  ticker     TEXT,
  legs_json  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
