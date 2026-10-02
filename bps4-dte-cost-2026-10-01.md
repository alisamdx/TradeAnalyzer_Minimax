# BPS-4 — round-trip cost at 21 DTE vs 30 DTE, on captured quotes

Captures to 2026-10-01. `reason = 'entry'` rows only. Buckets are the nearest stored expiry to **21** and **30** DTE within ±4 days, and must be different contracts.

793 ticker-runs captured → **665 paired**. Dropped: no 21-DTE expiry 67 · no 30-DTE expiry 43 · both buckets hit the same contract 0.

## Per bucket

| bucket | n | median DTE | monthly | median mid credit | credit ÷ width | median round-trip cost | **median cost share** | fails the 25% gate | median short Δ | median OI short/long |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 21 DTE | 665 | 22 | 30% | $2.22 | 27.3% | $0.52 | **26.8%** | 358 | 0.30 | 100 / 106 |
| 30 DTE | 665 | 30 | 31% | $2.41 | 29.3% | $0.47 | **26.5%** | 350 | 0.30 | 235 / 235 |

## Paired — the same name, the same moment, the same quotes

Median per-pair cost share difference (21 − 30): **0.3%** (positive = the shorter expiry costs more).
The shorter expiry is cheaper on **326 of 664** pairs (49%). A coin flip is 50%.
Median per-pair credit difference: **$-0.10**.

### Who is tradable under BPS-9's 25% gate

| | clears at 30 | fails at 30 |
|---|--:|--:|
| **clears at 21** | 214 | 93 |
| **fails at 21** | 101 | 257 |

**101** names are tradable only at 30 DTE; **93** only at 21. The off-diagonal is the finding — the diagonal says nothing, because a name that clears both or neither is not choosing between them.

## Is this DTE, or is it monthly vs weekly?

Monthly share: 21 DTE **30%** · 30 DTE **31%**.

| | 30 DTE weekly | 30 DTE monthly |
|---|--:|--:|
| **21 DTE weekly** | 264 | 204 |
| **21 DTE monthly** | 197 | 0 |

The both-monthly cell is **structurally empty**: consecutive third Fridays are 28–35 days apart and these buckets can be at most 17 days apart. So the same-type comparison below is weekly-vs-weekly, and there is no monthly-vs-monthly evidence here at any n.

**Same expiry type** (263 pairs): median difference **-1.7%**, the shorter expiry cheaper on **161 of 263** (61%). If this is much smaller than the headline — or points the other way — the headline is about expiry type, not about DTE.

### The discordant cells — where the expiry types are swapped

**21 DTE monthly vs 30 DTE weekly** (197 pairs): median difference **-7.1%**, the shorter expiry cheaper on **155 of 197** (79%). The falsification test: if expiry type is the explanation, the sign must REVERSE here.
**21 DTE weekly vs 30 DTE monthly** (204 pairs): median difference **23.5%**, the shorter expiry cheaper on **10 of 204** (5%). The majority case, and the one the headline is made of.

In those 197 runs the nearest-30 rule takes a **weekly** while a monthly sits inside the DTE window. Clearing the 25% gate there: the monthly at 21 DTE **126**, the weekly at 30 DTE **80**. That difference is what a prefer-the-monthly rule would be worth — on cost alone, which is not the same as being worth it (FR-SEY-5 needs returns).

### Conditional on being tradable — does the gap survive BPS-9's 25% gate?

**Both buckets clear the gate** (214 pairs): median difference **-0.1%**, the shorter expiry cheaper on **111 of 214** (52%). This is the population the mode would actually trade either way. The wheel's expiry lever was rejected here: a real friction gap that sat entirely in structures the gate already refused.

Median cost share among those: 21 DTE **12.8%** · 30 DTE **12.3%**.

#### …and same expiry type at the same time — the only cell with both controls on

**Same type AND both clear** (86 pairs): median difference **-0.8%**, the shorter expiry cheaper on **52 of 86** (60%). Controls expiry type and tradability together. Anything above controls one of them.

## As traded — the book each target would actually produce

Not paired, deliberately: a DTE target changes which names clear the gate, so these are different populations. That difference IS the decision. (It is not evidence about tenor — a target that lands on monthlies gets the monthlies' liquidity, which is a fact about the rule, not about DTE.)

| target | candidates clearing the 25% gate | median cost share | median mid credit | monthly |
|---|--:|--:|--:|--:|
| 21 DTE | 307 of 665 | 14.9% | $2.45 | 41% |
| 30 DTE | 315 of 665 | 12.9% | $2.49 | 40% |

Moving the target from 30 to 21 DTE changes the tradable pool by **−3%**. Read that against BPS-10: the eligible set is what the top-5 cut chooses between, and it is already thin.

## Could not build

At 21 DTE: no two-sided put in the delta band 8 · no two-sided long put in the wing band 7
At 30 DTE: no two-sided long put in the wing band 10 · no two-sided put in the delta band 4

A bucket that fails to build more often is a finding in its own right — the pairs above exclude those runs by construction, so this list is where that evidence lives.

## Limits

Entry slip doubled, the way the mode computes a round trip — not a measured exit. Says nothing about returns or assignment, which need settled positions. One regime, a handful of capture days. FR-SEY-5: this shapes a criterion; it cannot by itself move a live rule.
