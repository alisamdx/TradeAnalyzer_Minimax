-- Breakout/continuation signals for the Inflection strategy (a directional credit
-- spread anchored at a 20-day breakout level). Computed nightly by
-- DailyTechnicalSignalsJob from price bars; consumed by the scoring engine.
--   breakout_state         -1 = fresh 20d-low breakdown (with downtrend),
--                           0 = none, 1 = fresh 20d-high breakout (with uptrend)
--   breakout_level         the 20-day high (up) / low (down) that was broken
--   breakout_decisiveness  |close - level| / ATR(14) — how far beyond the level, in ATR units
--   volume_surge           today's volume / 20-day avg volume
--   atr_pct                ATR(14) / close × 100 — move potential / expected range
-- see docs/formulas.md#breakout-signals
ALTER TABLE technical_signals ADD COLUMN breakout_state INTEGER;
ALTER TABLE technical_signals ADD COLUMN breakout_level REAL;
ALTER TABLE technical_signals ADD COLUMN breakout_decisiveness REAL;
ALTER TABLE technical_signals ADD COLUMN volume_surge REAL;
ALTER TABLE technical_signals ADD COLUMN atr_pct REAL;
