-- Migration 051: inflection-direction guard for the execution engine (FR-SEY-3 follow-up).
-- See Requirements/v2-execution/06-seykota-risk-extensions.md.
--
-- Authoritative spread-P&L showed down-breakout/bear-call inflection is a net loser while
-- up-breakout/bull-put is profitable, so the engine entry policy only proposes allowed
-- directions. Mirrors the app-level `inflectionDirection` setting; defaults to 'up'.

ALTER TABLE exec_config ADD COLUMN inflection_direction TEXT NOT NULL DEFAULT 'up'
  CHECK (inflection_direction IN ('both', 'up', 'down'));
