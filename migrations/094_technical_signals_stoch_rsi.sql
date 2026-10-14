-- 094: Stochastic RSI on technical_signals (v1.1.358).
--
-- Bec's only entry-timing input (docs/Bec/STRATEGY-SUMMARY.md §3, §9.3): enter when it has
-- reached the bottom and turned back up, never while it points down. DISPLAY ONLY — shown on
-- brief picks, read by no score, gate or ranking (FR-SEY-5: that would need replay evidence).
--
--   stoch_rsi_k      %K, 0–100 (14/14/3/3)
--   stoch_rsi_d      %D, 0–100
--   stoch_rsi_state  'turned_up' (crossed above %D in the last 3 bars after %K ≤ 20 within 5),
--                    'falling' (%K below %D), 'rising' (otherwise), NULL (too little history,
--                    or a flat RSI window)
--
-- see src/main/services/stoch-rsi.ts, docs/formulas.md#stoch-rsi

ALTER TABLE technical_signals ADD COLUMN stoch_rsi_k REAL;
ALTER TABLE technical_signals ADD COLUMN stoch_rsi_d REAL;
ALTER TABLE technical_signals ADD COLUMN stoch_rsi_state TEXT CHECK (stoch_rsi_state IN ('turned_up', 'rising', 'falling'));
