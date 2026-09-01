-- 069: re-open `confirmed_real` verdicts on discontinuities too large to be real moves.
--
-- v1.1.139 recorded a jump that survived a provider re-fetch as `confirmed_real` and then
-- excluded it from detection FOREVER. That is too strong: providers backfill corporate
-- actions late, so a split genuinely absent from the adjusted series on the day we check
-- can appear a week later. v1.1.140 adds a 30-day TTL to that verdict.
--
-- The TTL alone would leave the worst cases sitting corrupt until it lapses. Observed
-- 2026-09-01, all recorded `confirmed_real` and all still wrong in the stored series:
--   BNY  +1263%   SPCX +632%   MRNA +177% (stepped 62.96 -> 174.38 and STAYED)
--   KD    -55%    CORT  -50%   PRIM -50%   CAR -48%   FMC -47%
--
-- Deleting the row returns the discontinuity to detection on the next price-gap-fill run,
-- which re-fetches and either repairs it (if the provider has since published the action)
-- or records it again with a fresh TTL. Cost is a handful of API calls.
--
-- Scoped to |move| >= 45% ONLY. The 137 verdicts in the -32%..-37% band are left alone:
-- a one-third single-day fall is ordinary crash territory (SRPT, ALGN, ELF, SMCI all did
-- exactly that on news), and re-opening them would churn API calls every month for nothing.
-- Same reasoning drops 3:2 from nearestSplitRatio's candidate set in v1.1.140.
DELETE FROM price_split_repairs
 WHERE status = 'confirmed_real'
   AND (ratio <= 0.55 OR ratio >= 1.8);
