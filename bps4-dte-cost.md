# BPS-4 — round-trip cost at 21 DTE vs 30 DTE, on captured quotes

Captures to 2026-09-22. `reason = 'entry'` rows only. Buckets are the nearest stored expiry to **21** and **30** DTE within ±4 days, and must be different contracts.

374 ticker-runs captured → **296 paired**. Dropped: no 21-DTE expiry 56 · no 30-DTE expiry 18 · both buckets hit the same contract 0.

## Per bucket

| bucket | n | median DTE | monthly | median mid credit | credit ÷ width | median round-trip cost | **median cost share** | fails the 25% gate | median short Δ | median OI short/long |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 21 DTE | 296 | 22 | 11% | $2.17 | 26.9% | $0.75 | **36.7%** | 194 | 0.30 | 37 / 42 |
| 30 DTE | 296 | 31 | 69% | $2.42 | 28.5% | $0.44 | **23.9%** | 140 | 0.30 | 460 / 565 |

## Paired — the same name, the same moment, the same quotes

Median per-pair cost share difference (21 − 30): **13.6%** (positive = the shorter expiry costs more).
The shorter expiry is cheaper on **80 of 296** pairs (27%). A coin flip is 50%.
Median per-pair credit difference: **$-0.14**.

### Who is tradable under BPS-9's 25% gate

| | clears at 30 | fails at 30 |
|---|--:|--:|
| **clears at 21** | 78 | 24 |
| **fails at 21** | 78 | 116 |

**78** names are tradable only at 30 DTE; **24** only at 21. The off-diagonal is the finding — the diagonal says nothing, because a name that clears both or neither is not choosing between them.

## Is this DTE, or is it monthly vs weekly?

Monthly share: 21 DTE **11%** · 30 DTE **69%**.
On the **60** pairs where both buckets are the same expiry type, the median difference is **-4.9%** — if that is much smaller than the headline, the headline is about expiry type, not about DTE.

## Could not build

At 21 DTE: no two-sided put in the delta band 2 · no two-sided long put in the wing band 1
At 30 DTE: no two-sided put in the delta band 2 · no two-sided long put in the wing band 1

A bucket that fails to build more often is a finding in its own right — the pairs above exclude those runs by construction, so this list is where that evidence lives.

## Limits

Entry slip doubled, the way the mode computes a round trip — not a measured exit. Says nothing about returns or assignment, which need settled positions. One regime, a handful of capture days. FR-SEY-5: this shapes a criterion; it cannot by itself move a live rule.
