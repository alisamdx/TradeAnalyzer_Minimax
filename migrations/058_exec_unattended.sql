-- Migration 058: unattended paper operation (Requirements/v2-execution/08-unattended-operation.md).
--
-- Adds the automation controls for running a full unattended paper trading day:
--   • automation_mode — the arm switch: 'semi' (approve-each, current) | 'dry_run' (decide
--     everything, place nothing → exec_dry_run_log) | 'unattended' (auto-approve entries + auto
--     discretionary exits). Auto-entry is PAPER-ONLY (enforced in the engine, never in live).
--   • cycle_interval_sec — the management/entry loop tick (the loop driver was previously unwired).
--   • notify_* — per-action email + OS push, and an end-of-day digest (digest fires only when armed).
-- No CHECK constraints on the enum (SQLite ALTER ADD COLUMN limitations); the governor validates
-- automation_mode defensively, same pattern as profit_target_mode/time_exit_mode.
--
-- All validation-exempt per FR-SEY-5: nothing here changes which trades are selected or how they're
-- sized/exited — auto-entry only removes the human click on already-selected picks.

ALTER TABLE exec_config ADD COLUMN automation_mode   TEXT    NOT NULL DEFAULT 'semi';   -- semi | dry_run | unattended
ALTER TABLE exec_config ADD COLUMN cycle_interval_sec INTEGER NOT NULL DEFAULT 120;     -- management/entry loop tick
ALTER TABLE exec_config ADD COLUMN notify_per_action  INTEGER NOT NULL DEFAULT 1;       -- email + push on entry/exit/kill
ALTER TABLE exec_config ADD COLUMN notify_push        INTEGER NOT NULL DEFAULT 1;       -- desktop/OS notification surface
ALTER TABLE exec_config ADD COLUMN notify_eod_digest  INTEGER NOT NULL DEFAULT 1;       -- end-of-day digest (armed only)

-- Dry-run would-be decisions, kept separate from exec_proposals so dry-run never pollutes the real
-- proposal / position / audit streams. One row per would-be action; deduped per ET-date+kind+ticker.
CREATE TABLE IF NOT EXISTS exec_dry_run_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  et_date     TEXT    NOT NULL,                 -- ET calendar date (per-day dedupe)
  kind        TEXT    NOT NULL,                 -- 'entry' | 'exit'
  ticker      TEXT    NOT NULL,
  strategy    TEXT,
  structure   TEXT,
  legs_json   TEXT,
  net_credit  REAL,                             -- per-share at evaluation
  max_loss    REAL,                             -- per-contract $
  contracts   INTEGER,
  reason      TEXT                              -- close_reason for exits; null for entries
);

CREATE INDEX IF NOT EXISTS idx_dry_run_dedupe ON exec_dry_run_log (et_date, kind, ticker);
