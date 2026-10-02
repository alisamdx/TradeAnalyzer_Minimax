# BPS-2 — does the composite's top-15 cut earn its place as the spread's pool?

snapshot rows 72518 · usable 6221 across 54 dates · liquidity gate >= 5/10
dropped: no structure 25721 · not settled 12556 · illiquid 28007 · no signals 0 · scale guard 13

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

dates with at least 15 candidates: 51 of 54  (the rest cannot exercise a top-15 cut at all)

## Selection rules at top-15, every eligible date

  (raw = every selected ticker-day; episodes = repeats within 14 days folded into one bet)

RAW
  composite-70 (the live cut)    n=  765  mean   -0.07%  median    2.09%  trimmed    0.78%  assigned   31.0%
  income-72 (BPS-1 challenger)   n=  765  mean   -0.24%  median    1.79%  trimmed    0.58%  assigned   31.6%
  premium richness (annRet)      n=  765  mean    0.48%  median    2.98%  trimmed    1.31%  assigned   32.2%
  ivRank only                    n=  765  mean   -0.64%  median    1.96%  trimmed    0.33%  assigned   31.4%
  ivRank + premiumYield (41pts)  n=  765  mean    0.08%  median    2.47%  trimmed    1.02%  assigned   31.5%
  the 29 dead points only        n=  765  mean   -0.66%  median    0.93%  trimmed    0.06%  assigned   32.3%
  INVERTED composite-70          n=  765  mean   -1.27%  median    1.19%  trimmed   -0.46%  assigned   32.5%

EPISODE-COLLAPSED  (the honest n)
  composite-70 (the live cut)    n=  353  mean   -0.12%  median    2.02%  trimmed    0.79%  assigned   30.3%
  income-72 (BPS-1 challenger)   n=  339  mean   -0.56%  median    1.67%  trimmed    0.46%  assigned   32.7%
  premium richness (annRet)      n=  323  mean    0.54%  median    2.86%  trimmed    1.48%  assigned   31.0%
  ivRank only                    n=  332  mean   -1.01%  median    1.79%  trimmed    0.06%  assigned   31.6%
  ivRank + premiumYield (41pts)  n=  320  mean   -0.17%  median    2.40%  trimmed    0.99%  assigned   30.6%
  the 29 dead points only        n=  358  mean   -1.32%  median    0.86%  trimmed   -0.39%  assigned   34.4%
  INVERTED composite-70          n=  356  mean   -1.50%  median    1.14%  trimmed   -0.66%  assigned   33.4%

## Baselines

  whole universe (raw)           n= 6188  mean   -0.99%  median    1.07%  trimmed   -0.09%  assigned   31.2%
  whole universe (episodes)      n= 1758  mean   -1.13%  median    1.09%  trimmed   -0.24%  assigned   33.0%
  random 15/date × 400 draws            mean   -0.89%  median    1.24%  trimmed   -0.03%  assigned   31.9%
  random 5th–95th pct:  mean -1.29% … -0.52%   median 1.14% … 1.34%   trimmed -0.34% … 0.30%   assigned 29.3% … 34.7%

## Read this as

  A rule EARNS the cut only if its episode-collapsed result sits OUTSIDE the random band above.
  Inside the band means the cut is picking no better than chance — which is the BPS-2 question,
  and would make "the composite selects but does not rank" incoherent in the direction of
  dropping the composite from the pool rather than restoring it to the ranking.
  ASSIGNED RATE is the measure that matters for a bull put spread: it is the spread's own win
  condition (stayed above the short strike) and is immune to the return tails.

  Sample: 54 dates, one regime. A rule that wins here has not been shown to
  generalise — see the hold_days sweep, which was monotone on one month and inverted on six.
