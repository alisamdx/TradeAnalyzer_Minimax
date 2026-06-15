-- Migration 049: drawdown-scaled risk (FR-SEY-2, Seykota "equity-curve money management").
-- See Requirements/v2-execution/06-seykota-risk-extensions.md.
--
-- When the closed-equity drawdown from its high-water mark reaches drawdown_throttle_pct,
-- the governor multiplies the effective per-trade risk by drawdown_throttle_factor until the
-- curve recovers. Disabled by default (drawdown_throttle_pct = 0) so behaviour is unchanged
-- until the operator opts in. equity_high_water ratchets up only; seeded to the ceiling.

ALTER TABLE exec_config ADD COLUMN drawdown_throttle_pct    REAL NOT NULL DEFAULT 0;    -- 0 = off
ALTER TABLE exec_config ADD COLUMN drawdown_throttle_factor REAL NOT NULL DEFAULT 0.5;  -- size × when throttled

ALTER TABLE exec_risk_state ADD COLUMN equity_high_water REAL NOT NULL DEFAULT 10000;
UPDATE exec_risk_state
   SET equity_high_water = (SELECT capital_ceiling FROM exec_config WHERE id = 1)
 WHERE id = 1;
