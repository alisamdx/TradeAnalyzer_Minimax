-- Migration 055: ENABLE risk-budget spread width by default (FR-SEY-5 validated).
--
-- Validated 2026-06-18 with a faithful simulateSingleSpread replica over 1,386 inflection replay
-- picks (scripts/fr-budget-width-study.mjs), comparing the current 0.15Δ wing vs the budget-sized
-- wing on the SAME short strike (0.30Δ) and SAME picks. At the operative $500 budget (5% of $10k):
--   return/max-loss  current 5.6%  →  budget 6.1%   (Δ +0.5 pts — mildly better)
--   win rate         current 75.0% →  budget 75.1%  (unchanged)
--   sizeable at $500 current 58%   →  budget 100%   (rescues high-priced names like AMAT)
-- Narrower spreads carry a higher credit/max-loss ratio on wins, so return-on-capital is neutral-
-- to-better while every pick becomes sizeable. At worst neutral per FR-SEY-5 → ship enabled.
--
-- Only rows still at the shipped default (0) are flipped, preserving a user override.
UPDATE exec_config SET budget_width_enabled = 1 WHERE budget_width_enabled = 0;

-- The liquidity gate (max_combo_spread_pct, migration 054) stays OFF: it can't be backtested
-- (no historical bid/ask to compute a combo spread), so per FR-SEY-5 it ships disabled with the
-- finding recorded. Live evidence (AMAT round-trip ~23% of credit) is the rationale to enable it
-- manually (~0.20) in Execution Settings.
