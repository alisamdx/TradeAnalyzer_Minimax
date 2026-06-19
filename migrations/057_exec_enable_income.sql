-- Migration 057: add INCOME (iron condor) + per-strategy composite floors (FR-SEY-5 validated).
--
-- Per-strategy floor: a single global min_composite_score is wrong for a multi-strategy book —
-- composites aren't comparable across strategies. Income scores on a lower scale (replay picks all
-- < 50) and composite isn't predictive for iron condors, so the inflection-calibrated 50 floor
-- would gate out EVERY income pick. `min_composite_by_strategy` (JSON {strategy: floor}) overrides
-- the global floor per strategy; absent strategies fall back to min_composite_score.
--
-- Income is traded as a budget-sized iron condor (4-leg defined-risk credit; shorts ~0.16Δ, each
-- long wing sized to the per-trade budget so max loss ≤ budget). Validated 2026-06-18
-- (scripts/fr-iron-condor-study.mjs) over 1,397 income replay picks, 30 DTE / 50% PT / 2x stop:
--   income iron condor  win 82.3%  return/max-loss 5.7%  avg max loss $403 (sizeable)
--   baseline (entry -180d) win 75.4%  return/max-loss 1.9%
-- Beats baseline by +6.9 pts win / +3.8 pts return — a real selection edge; highest win rate of any
-- strategy (two-sided, neutral). Income floor set to 0 (ship the validated set; the brief's top-N
-- selection + critic gate + the condor structure provide quality). At worst neutral per FR-SEY-5.
ALTER TABLE exec_config ADD COLUMN min_composite_by_strategy TEXT NOT NULL DEFAULT '{}';

UPDATE exec_config
SET eligible_strategies = 'inflection,wheel,income',
    min_composite_by_strategy = '{"income":0}'
WHERE eligible_strategies = 'inflection,wheel';
