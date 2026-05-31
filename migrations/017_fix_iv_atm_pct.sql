-- Migration 017: Convert atm_iv from decimal fraction to percentage.
-- All values were incorrectly stored as decimals (0.285 = 28.5%) because
-- IVolatility returns decimal fractions and the E*Trade capture path also
-- produced decimals. The project convention (see CLAUDE.md) is to store
-- IV as a percentage (28.5, not 0.285). Multiply all existing rows by 100.
UPDATE iv_history SET atm_iv = atm_iv * 100;
