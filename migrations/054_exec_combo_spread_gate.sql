-- Migration 054: liquidity/economics gate for v2 inflection entries (default OFF).
--
-- Even when a spread is sizeable, wide-bid/ask names bleed the edge to slippage: live Phase 7
-- calibration on AMAT crossed ~$375 round-trip (~23% of a ~$1,600 credit). This gate rejects a
-- proposal when its combo relative spread (ask − bid)/|mid| exceeds the threshold, so the engine
-- avoids names where execution cost dominates. 0 = off (no liquidity gate). A sane live value is
-- ~0.20; left at 0 pending FR-SEY-5 validation alongside the budget-width change.
ALTER TABLE exec_config ADD COLUMN max_combo_spread_pct REAL NOT NULL DEFAULT 0;  -- 0 = off
