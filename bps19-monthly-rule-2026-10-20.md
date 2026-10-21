# BPS-19 — prefer the monthly inside 21–35 DTE, or keep nearest-30?

Captures to 2026-10-20. Both arms run the mode's own picker over the same captured expiry set: **A** = nearest 30 DTE (incumbent), **B** = the monthly in the window if there is one, else A.

1649 ticker-runs → **258 where the two rules DISAGREE**. Agreed 937 (of which 567 had no monthly in the window at all, so no choice existed) · no eligible expiry 451 · one side would not build 3. The earnings filter removed at least one expiry on 496 runs.

## The runs where the rules disagree

| arm | median DTE | monthly | median mid credit | median round-trip cost | **median cost share** | clears the 25% gate | median OI short/long |
|---|--:|--:|--:|--:|--:|--:|--:|
| A — nearest 30 (incumbent) | 30 | 0% | $2.25 | $0.46 | **31.1%** | 101 of 258 | 102 / 101 |
| B — prefer the monthly | 23 | 100% | $2.23 | $0.30 | **18.4%** | 166 of 258 | 212 / 223 |

**Cost share, B − A** (257 pairs): median difference **-7.6%**, negative on **206 of 257** (80%). Negative = the monthly is cheaper. These are the same name at the same moment, differing only in which expiry the rule chose.

Median DTE shift: **-7.0 days** · median credit change: **$-0.06**.

## Is the saving payable? (the half that killed the wheel's version)

| | B clears | B fails |
|---|--:|--:|
| **A clears** | 94 | 7 |
| **A fails** | 72 | 85 |

On these disagreeing runs the rule change turns **72** untradable candidates into tradable ones and **7** the other way — a net **+65** candidates.

**Cost share among candidates BOTH rules can trade, B − A** (94 pairs): median difference **-2.8%**, negative on **74 of 94** (79%). The wheel's friction gap was 19.6% vs 40.3% and became **6.9% vs 6.0%** once the entry gate was applied — the whole saving sat in structures already refused. If this row is ~0 the same thing is happening here, and the rule change buys nothing on the trades you would actually take.

## Does snapping to the monthly land on a THINNER contract?

B's short leg has **lower** open interest than A's on **107 of 258** (41%). Median OI: A **102** · B **212**.

This is the failure the wheel study found: the monthly's depth advantage is a 23–33 DTE phenomenon, so snapping away from ~30 can land on a contract thinner than the weekly it replaced. Measured here rather than assumed, in either direction.

## At book level — every run, not just the disagreements

B equals A wherever no monthly was available, so the book-level effect is exactly the disagreements diluted by how rarely they happen. That dilution is the honest size of the lever.

The rules disagree on **22%** of runs with an eligible expiry (258 of 1195).

## Limits

Entry slip doubled, the way the mode computes a round trip — not a measured exit. **Cost is not return (FR-SEY-5)**: nothing here can enable a rule change, because a cheaper entry that selects a different population is not shown to be better until the returns are measured. A real switch also interacts with the earnings gate (BPS-5), which can move either arm's pick. One regime, a handful of capture days.
