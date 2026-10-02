-- 089: Brief Replay income/wheel picks settled on REAL premium (v1.1.337).
--
-- Until now an income/wheel pick's outcome was a proxy: a synthetic strike at 0.85 x entry, "kept"
-- if no low over 21 sessions touched it, no premium (`synth_strike`, `stayed_above_strike`). Measured
-- 2026-10-01 on ~58k settled puts it agreed with the real outcome only ~77% of the time and was
-- optimistic (85% "kept" vs ~73% not assigned). Where options_premium_history holds the CSP the app
-- actually recommended for that ticker on that date, the pick is now settled on it at expiry.
--
-- outcome_source: 'real'  — settled on the stored CSP (real_* columns set)
--                 'proxy' — no stored CSP for that date, or one not yet expired / not settleable;
--                           the proxy columns remain the only outcome
--                 NULL    — not an income/wheel pick, or not yet evaluated
-- The proxy columns are kept on every row so the two remain comparable.
-- see src/main/services/premium-roc.ts, docs/formulas.md#premium-roc

ALTER TABLE replay_outcomes ADD COLUMN outcome_source  TEXT CHECK (outcome_source IN ('real', 'proxy'));
ALTER TABLE replay_outcomes ADD COLUMN real_strike     REAL;
ALTER TABLE replay_outcomes ADD COLUMN real_premium    REAL;
ALTER TABLE replay_outcomes ADD COLUMN real_expiration TEXT;
ALTER TABLE replay_outcomes ADD COLUMN real_settle     REAL;
ALTER TABLE replay_outcomes ADD COLUMN real_assigned   INTEGER;
ALTER TABLE replay_outcomes ADD COLUMN real_roc_pct    REAL;
-- Why a stored CSP existed but was not settled (scale_mismatch_*, no_*_bar, not_expired); NULL otherwise.
ALTER TABLE replay_outcomes ADD COLUMN real_skip_reason TEXT;
