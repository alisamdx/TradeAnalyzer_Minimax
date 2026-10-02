# BPS-19 — prefer the monthly inside 21–35 DTE, or keep nearest-30?

Captures to 2026-10-01. Both arms run the mode's own picker over the same captured expiry set: **A** = nearest 30 DTE (incumbent), **B** = the monthly in the window if there is one, else A.

793 ticker-runs → **236 where the two rules DISAGREE**. Agreed 502 (of which 198 had no monthly in the window at all, so no choice existed) · no eligible expiry 50 · one side would not build 5. The earnings filter removed at least one expiry on 109 runs.

## The runs where the rules disagree

| arm | median DTE | monthly | median mid credit | median round-trip cost | **median cost share** | clears the 25% gate | median OI short/long |
|---|--:|--:|--:|--:|--:|--:|--:|
| A — nearest 30 (incumbent) | 30 | 0% | $2.41 | $0.52 | **30.4%** | 93 of 236 | 101 / 102 |
| B — prefer the monthly | 23 | 100% | $2.40 | $0.32 | **18.2%** | 153 of 236 | 179 / 142 |

**Cost share, B − A** (236 pairs): median difference **-8.2%**, negative on **192 of 236** (81%). Negative = the monthly is cheaper. These are the same name at the same moment, differing only in which expiry the rule chose.

Median DTE shift: **-7.0 days** · median credit change: **$-0.07**.

## Is the saving payable? (the half that killed the wheel's version)

| | B clears | B fails |
|---|--:|--:|
| **A clears** | 86 | 7 |
| **A fails** | 67 | 76 |

On these disagreeing runs the rule change turns **67** untradable candidates into tradable ones and **7** the other way — a net **+60** candidates.

**Cost share among candidates BOTH rules can trade, B − A** (86 pairs): median difference **-2.9%**, negative on **70 of 86** (81%). The wheel's friction gap was 19.6% vs 40.3% and became **6.9% vs 6.0%** once the entry gate was applied — the whole saving sat in structures already refused. If this row is ~0 the same thing is happening here, and the rule change buys nothing on the trades you would actually take.

## Does snapping to the monthly land on a THINNER contract?

B's short leg has **lower** open interest than A's on **104 of 236** (44%). Median OI: A **101** · B **179**.

This is the failure the wheel study found: the monthly's depth advantage is a 23–33 DTE phenomenon, so snapping away from ~30 can land on a contract thinner than the weekly it replaced. Measured here rather than assumed, in either direction.

## At book level — every run, not just the disagreements

B equals A wherever no monthly was available, so the book-level effect is exactly the disagreements diluted by how rarely they happen. That dilution is the honest size of the lever.

The rules disagree on **32%** of runs with an eligible expiry (236 of 738).

## Limits

Entry slip doubled, the way the mode computes a round trip — not a measured exit. **Cost is not return (FR-SEY-5)**: nothing here can enable a rule change, because a cheaper entry that selects a different population is not shown to be better until the returns are measured. A real switch also interacts with the earnings gate (BPS-5), which can move either arm's pick. One regime, a handful of capture days.
