# BPS-2 — does the composite's top-15 cut earn its place as the spread's pool?

snapshot rows 80710 · usable 6344 across 58 dates · liquidity gate >= 5/10
dropped: no structure 31300 · not settled 13742 · illiquid 29311 · no signals 0 · scale guard 13

SCALE-GUARD EXCLUSIONS (printed, not dropped silently — a stored strike on a different price scale):
  2026-06-11 LCID strike 7 vs spot 5.12 (1.369×)
  2026-06-18 QS strike 10 vs spot 7.38 (1.354×)
  2026-07-02 GTM strike 6 vs spot 2.99 (2.007×)
  2026-07-09 SMMT strike 21 vs spot 15.48 (1.357×)
  2026-07-09 NWL strike 7 vs spot 5.13 (1.365×)
  2026-07-14 LBRDA strike 45 vs spot 29.95 (1.503×)
  2026-07-15 LBRDA strike 45 vs spot 30.82 (1.460×)
  2026-07-16 SMMT strike 19 vs spot 13.76 (1.381×)
  2026-07-17 LBRDK strike 45 vs spot 30.87 (1.458×)
  2026-07-17 LBRDA strike 45 vs spot 30.86 (1.458×)
  2026-08-06 ALM strike 20 vs spot 13.42 (1.490×)
  2026-08-06 DOCS strike 30 vs spot 20.66 (1.452×)
  … and 1 more

composite reconstructed from 70 of 91 ranking points — fundamentalScore (17) and
leverageQuality (4) draw on fundamentals_cache, which has no history and never can be replayed.
outcome = premium − max(0, strike − close@expiry), as % of strike; assigned = close < strike.

dates with at least 15 candidates: 55 of 58  (the rest cannot exercise a top-15 cut at all)

## Selection rules at top-15, every eligible date

  (raw = every selected ticker-day; episodes = repeats within 14 days folded into one bet)

RAW
  composite-70 (the live cut)    n=  825  mean    0.06%  median    2.10%  trimmed    0.90%  assigned   30.3%
  income-72 (BPS-1 challenger)   n=  825  mean   -0.12%  median    1.82%  trimmed    0.69%  assigned   31.2%
  premium richness (annRet)      n=  825  mean    0.62%  median    2.96%  trimmed    1.45%  assigned   30.8%
  ivRank only                    n=  825  mean   -0.47%  median    1.96%  trimmed    0.48%  assigned   30.5%
  ivRank + premiumYield (41pts)  n=  825  mean    0.27%  median    2.50%  trimmed    1.20%  assigned   29.9%
  the 29 dead points only        n=  825  mean   -0.57%  median    0.95%  trimmed    0.13%  assigned   31.9%
  INVERTED composite-70          n=  825  mean   -1.21%  median    1.20%  trimmed   -0.38%  assigned   32.2%

EPISODE-COLLAPSED  (the honest n)
  composite-70 (the live cut)    n=  383  mean    0.01%  median    2.03%  trimmed    0.91%  assigned   30.0%
  income-72 (BPS-1 challenger)   n=  372  mean   -0.40%  median    1.76%  trimmed    0.59%  assigned   32.3%
  premium richness (annRet)      n=  353  mean    0.64%  median    2.81%  trimmed    1.54%  assigned   30.0%
  ivRank only                    n=  365  mean   -0.78%  median    1.79%  trimmed    0.29%  assigned   31.0%
  ivRank + premiumYield (41pts)  n=  350  mean    0.06%  median    2.43%  trimmed    1.17%  assigned   28.9%
  the 29 dead points only        n=  387  mean   -1.16%  median    0.90%  trimmed   -0.24%  assigned   33.6%
  INVERTED composite-70          n=  380  mean   -1.33%  median    1.16%  trimmed   -0.47%  assigned   32.4%

## Baselines

  whole universe (raw)           n= 6311  mean   -0.96%  median    1.07%  trimmed   -0.07%  assigned   31.1%
  whole universe (episodes)      n= 1777  mean   -1.11%  median    1.10%  trimmed   -0.22%  assigned   32.9%
  random 15/date × 400 draws            mean   -0.82%  median    1.25%  trimmed    0.03%  assigned   31.7%
  random 5th–95th pct:  mean -1.19% … -0.46%   median 1.16% … 1.35%   trimmed -0.26% … 0.33%   assigned 29.4% … 34.2%

## Read this as

  A rule EARNS the cut only if its episode-collapsed result sits OUTSIDE the random band above.
  Inside the band means the cut is picking no better than chance — which is the BPS-2 question,
  and would make "the composite selects but does not rank" incoherent in the direction of
  dropping the composite from the pool rather than restoring it to the ranking.
  ASSIGNED RATE is the measure that matters for a bull put spread: it is the spread's own win
  condition (stayed above the short strike) and is immune to the return tails.

  Sample: 58 dates, one regime. A rule that wins here has not been shown to
  generalise — see the hold_days sweep, which was monotone on one month and inverted on six.
