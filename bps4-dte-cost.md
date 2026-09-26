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

| | 30 DTE weekly | 30 DTE monthly |
|---|--:|--:|
| **21 DTE weekly** | 60 | 204 |
| **21 DTE monthly** | 32 | 0 |

The both-monthly cell is **structurally empty**: consecutive third Fridays are 28–35 days apart and these buckets can be at most 17 days apart. So the same-type comparison below is weekly-vs-weekly, and there is no monthly-vs-monthly evidence here at any n.

**Same expiry type** (60 pairs): median difference **-4.9%**, the shorter expiry cheaper on **45 of 60** (75%). If this is much smaller than the headline — or points the other way — the headline is about expiry type, not about DTE.

### Conditional on being tradable — does the gap survive BPS-9's 25% gate?

**Both buckets clear the gate** (78 pairs): median difference **3.5%**, the shorter expiry cheaper on **23 of 78** (29%). This is the population the mode would actually trade either way. The wheel's expiry lever was rejected here: a real friction gap that sat entirely in structures the gate already refused.

Median cost share among those: 21 DTE **17.9%** · 30 DTE **11.5%**.

#### …and same expiry type at the same time — the only cell with both controls on

**Same type AND both clear** (15 pairs): median difference **-0.9%**, the shorter expiry cheaper on **11 of 15** (73%). Controls expiry type and tradability together. Anything above controls one of them.

## As traded — the book each target would actually produce

Not paired, deliberately: a DTE target changes which names clear the gate, so these are different populations. That difference IS the decision. (It is not evidence about tenor — a target that lands on monthlies gets the monthlies' liquidity, which is a fact about the rule, not about DTE.)

| target | candidates clearing the 25% gate | median cost share | median mid credit | monthly |
|---|--:|--:|--:|--:|
| 21 DTE | 102 of 296 | 18.4% | $2.90 | 17% |
| 30 DTE | 156 of 296 | 12.6% | $2.74 | 81% |

Moving the target from 30 to 21 DTE changes the tradable pool by **−35%**. Read that against BPS-10: the eligible set is what the top-5 cut chooses between, and it is already thin.

## Could not build

At 21 DTE: no two-sided put in the delta band 2 · no two-sided long put in the wing band 1
At 30 DTE: no two-sided put in the delta band 2 · no two-sided long put in the wing band 1

A bucket that fails to build more often is a finding in its own right — the pairs above exclude those runs by construction, so this list is where that evidence lives.

## Limits

Entry slip doubled, the way the mode computes a round trip — not a measured exit. Says nothing about returns or assignment, which need settled positions. One regime, a handful of capture days. FR-SEY-5: this shapes a criterion; it cannot by itself move a live rule.
