-- Agent trade learnings (v0.28.2)
-- Stores AI-generated learning notes for closed TraderAgent trades.
-- UNIQUE on agent_trade_id — one learning per trade, INSERT OR REPLACE to refresh.
CREATE TABLE IF NOT EXISTS agent_trade_learnings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_trade_id  INTEGER NOT NULL UNIQUE,
  ticker          TEXT    NOT NULL,
  learning_json   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
