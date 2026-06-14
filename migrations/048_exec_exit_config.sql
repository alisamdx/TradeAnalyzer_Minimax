-- Migration 048: exit-policy configuration + exit-proposal linkage (Phase 4c).
-- Adds the configurable exit rules (03-lifecycle §3.3/§3.6) to exec_config, and the
-- columns an exit proposal needs (which position it closes + why). Discretionary rules
-- (profit target / time exit) carry a propose|auto mode; protective rules have no mode
-- (always automatic — §0.3 invariant, enforced in code).

ALTER TABLE exec_config ADD COLUMN stop_multiple       REAL    NOT NULL DEFAULT 2;   -- × credit
ALTER TABLE exec_config ADD COLUMN defensive_dte       INTEGER NOT NULL DEFAULT 2;
ALTER TABLE exec_config ADD COLUMN profit_target_pct   REAL    NOT NULL DEFAULT 50;  -- % of credit
ALTER TABLE exec_config ADD COLUMN hold_days           INTEGER NOT NULL DEFAULT 5;
ALTER TABLE exec_config ADD COLUMN time_exit_dte       INTEGER NOT NULL DEFAULT 0;   -- 0 = off (use hold_days)
ALTER TABLE exec_config ADD COLUMN profit_target_mode  TEXT    NOT NULL DEFAULT 'propose';  -- propose|auto
ALTER TABLE exec_config ADD COLUMN time_exit_mode      TEXT    NOT NULL DEFAULT 'propose';  -- propose|auto

ALTER TABLE exec_proposals ADD COLUMN position_id  INTEGER;  -- the position an exit proposal closes
ALTER TABLE exec_proposals ADD COLUMN close_reason TEXT;     -- the exit reason for an exit proposal
