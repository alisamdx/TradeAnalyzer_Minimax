-- 086: the bull put spread runs over TWO candidate pools, and a pick records which one produced it.
--
-- WHY. Every number in the #43 study was measured on WHEEL-selected names, so "+75% at Δ0.30" is a fact
-- about bull put spreads on stocks the wheel screen liked, not about bull put spreads. The wheel composite
-- puts 21% of its weight on fundamentals + leverage quality, which exists for one reason: an assigned CSP
-- means you own the stock. A spread never owns anything — max loss is the width, known at entry — so that
-- weight is inert here, and `notDowntrend` (weight 8) was measured BACKWARDS for this trade (closes below
-- SMA50 did better, +9.4% vs +5.7%). Roughly 29 of 100 weight is irrelevant or inverted.
--
-- `income` is structurally much closer: zero ownership weight, IV rank 30, premium/risk 22 (near enough
-- the quantity the mode already ranks on), recent volatility 20, liquidity 13. Its `trendNeutral` (15) is
-- always missing because USE_ADX_IN_SCORING is false, so it runs four live signals on 85 weight.
--
-- Operator decision 2026-09-20 (08 S11): run BOTH pools in shadow and decide on the data, rather than
-- switching. Switching would forfeit the comparison permanently — the same lesson as the `iv_history`
-- splice, where two sources were joined with zero overlapping days and no later analysis could separate
-- them. A paired same-day sample is cheap now and impossible afterwards.
--
-- COSTS NOTHING TO COLLECT: `spread_chain_capture` already captures income chains
-- (SPREAD_CAPTURE.strategies = wheel, income, bullish), and `brief_candidates` already stores every
-- strategy's top 15, so the second arm makes no additional E*Trade calls.
--
-- The default is 'wheel' and that is a fact, not a guess: every row written before this migration came
-- from the wheel pool, which was the only one that existed.
--
-- see src/main/services/spread-mode.ts, NewApp/requirements/08-bull-put-spread-mode.md §3.1

ALTER TABLE spread_mode_picks
  ADD COLUMN pool TEXT NOT NULL DEFAULT 'wheel' CHECK (pool IN ('wheel', 'income'));

-- A ticker can be picked by BOTH pools on the same date and slot — that is the paired observation the
-- comparison is made of — so the pool joins the uniqueness key. Without this the second arm would
-- silently overwrite the first's row for any ticker both screens liked, which is exactly the population
-- the comparison most needs.
DROP INDEX IF EXISTS idx_spread_mode_picks_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_spread_mode_picks_unique
  ON spread_mode_picks (as_of_date, slot, pool, ticker);
