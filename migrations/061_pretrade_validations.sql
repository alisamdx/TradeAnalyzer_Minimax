-- Pre-Trade Validator (Payoff view) — persists each validation for later review.
-- Decision-support only; see Requirements/PRE_TRADE_VALIDATOR_SPEC.md.

CREATE TABLE IF NOT EXISTS pretrade_validations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker          TEXT,
  strategy_name   TEXT,
  spot            REAL,
  legs_json       TEXT NOT NULL,            -- PayoffLeg[]
  intent_json     TEXT NOT NULL,            -- PretradeIntent
  verdict         TEXT NOT NULL,            -- 'good' | 'caution' | 'bad'
  checks_json     TEXT NOT NULL,            -- PretradeCheck[]
  suggestion_json TEXT,                     -- PretradeSuggestion | null
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pretrade_validations_created
  ON pretrade_validations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pretrade_validations_ticker
  ON pretrade_validations (ticker);
