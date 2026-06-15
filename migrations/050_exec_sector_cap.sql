-- Migration 050: sector-concentration cap (FR-SEY-1, Seykota diversification).
-- See Requirements/v2-execution/06-seykota-risk-extensions.md.
--
-- Caps concurrent open positions sharing a correlation bucket (v1 bucket = SPDR sector ETF,
-- derived from fundamentals_cache via sectorStringToEtf). NULL = off (default), so behaviour
-- is unchanged until the operator opts in.

ALTER TABLE exec_config ADD COLUMN max_positions_per_sector INTEGER;  -- NULL = off
