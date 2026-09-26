# Bull put spread — the strategy's own work list

The one list for **this strategy**. Kept apart from `NewApp/TODO.md` (pilot, collector, gate and
existing-app backlog) so a review of the trade is not interleaved with infrastructure work.

**Numbers are `BPS-n` and permanent** — an item keeps its number when done (struck through with the date
and what closed it), new items are added at the end, never renumbered. The prefix is deliberate: `BPS-5`
can never be confused with `#5` in the main list.

- **Design (authoritative):** `NewApp/requirements/08-bull-put-spread-mode.md`
- **Evidence ledger:** `NewApp/TODO.md` #43 (the #43 study's numbers, left there because notes and memory
  cite "TODO #43"); design §2 summarises it
- **Live state:** `node scripts/spread-shadow-report.mjs` with the app running, or 🪜 Spread Shadow in
  the app. **Read this first whenever the spread comes up.**
- **Code:** `src/main/services/spread-mode.ts`, `spread-mode-settle.ts`, `spread-chain-capture.ts`,
  `spread-capture-quality.ts`, `src/shared/spread-mode.ts`

---

## Status — 2026-09-22

Mode is `shadow`: picks are computed after every brief and stored, with no panel, no email, and nothing
reaching the v2 engine. The 08 §4 enable gate is **time-blocked, not work-blocked**:

| §4 condition | State |
|---|---|
| ≥ 15 intraday capture days, then re-run the study `--slip-model quoted --capital 25000 --risk 2500` | **6 / 15** — earliest ~2026-10-02 |
| ≥ 30 settled positions, mean return on max loss > 0 | **0 / 30** — 13 open; the first entries expire 2026-10-16 |

First week's funnel (2026-09-14 → 09-18, 10 runs): 94 ticker-runs → 75 rejected → 19 picks → 10 positions.
**36 of those 75 rejections no longer occur** (25 leg-rule, fixed v1.1.292 and confirmed 25/25 by the
v1.1.299 dry run; 11 budget, which stopped gating in v1.1.300).

**Three arms live since 2026-09-21** (`wheel` 3 positions · `income` 0 · `premium` 9, `overlap` 0).
The book is now 22 positions, and **the dominant rejection is cost — 47 of 139**, ahead of the leg rules
(31) and the critic (17). Capture quality is clean: 73 marks, 0 gaps.

---

## A. Step-by-step review of the selection rules — added 2026-09-20

One item per decision point, in the order `spread-mode.ts` applies them. Each says what it does today,
where the rule came from, and what is actually unsettled — so a review starts from evidence rather than
re-deriving it.

Provenance: **measured** (a #43 study result) · **inherited** (a wheel-screen rule adopted untested) ·
**drafted** (written into the design, never tested) · **fixed** (a bug fix, not a choice).

- **BPS-1. ~~Pool source — the wheel screen's output.~~ DECIDED 2026-09-20 (08 S11, v1.1.301):**
  **both pools run side by side in shadow** — `wheel` (incumbent, the pool §4 judges) and `income`
  (challenger) — rather than switching, because every #43 number was measured on wheel-selected names and
  a switch would forfeit the comparison permanently. Also decided: **a defined-risk trade may go into
  names the wheel would refuse on quality.** Costs no extra E*Trade calls. The comparison is reported over
  the **paired window only**, with `pairedDays` beside it so a wheel-only stretch cannot read as a win.
  **Still open, and now measurable:** whether income actually selects differently — read `overlap` in the
  report; if most of the book is picked by both, the two screens agree and BPS-1 answers itself.
  **First read 2026-09-22: `overlap` is 0 across all three arms — and `income` has picked NOTHING.** Three
  runs, 0 picks, 7 rejections each, the same count every time. The arms do select differently; the live
  question is now whether income selects *anything*, because an arm that never produces a position
  contributes no evidence to the comparison it was added for. `rejectionReasons[].pools` (v1.1.310) is
  what splits its 7 out of the merged tally — **read it next run** before concluding anything about why.

- **BPS-2. The composite selects but does not rank.** *Measured, half-applied.* The pool is the
  composite's top 15, then §3.1 discards its rank (v1.1.173: top end anti-predictive). **Evidence already
  in hand (docs/wheel-parameters.md):** F7 a composite FLOOR is harmful (every threshold made the book
  monotonically worse); T5 ranking the universe on premium richness BEATS no selection (+1.03 mean /
  +2.67 median) and lowest-premium is the worst rule — so selection is not the problem, this composite
  dilutes the signal that carries it; T6 the three price-derived signals (29 pts) add +0.14 mean /
  −0.18 median and INVERTING them beats that. Of 91 ranking points: 19 positively predictive, 22 weakly,
  29 ≈ zero or inverted, **21 permanently unverifiable** (`fundamentals_cache` has no history).
  **Cheap surprise:** `DailyOptionsSnapshotJob` already runs a live chain for the full ~1,100-ticker
  universe nightly, so annualized premium and liquidity are stored for everything — a premium-ranked
  pool would need no new API budget, only a different choice of which ~15 get chains captured.
  **Decision 2026-09-20: run the study first; add a third shadow arm only if it is inconclusive.**
  Harness written: `scripts/fr-spread-pool-selection-study.mjs` (self-test 14/14,
  `scripts/selftest-spread-pool-selection.mjs`). It ranks the WHOLE universe by composite-70 vs premium
  richness vs a random draw of the same size, on both return on capital and **assigned rate** — the
  spread's own win condition. Episode-collapsed, scale-guarded, with a random band as the null.
  **Run it from a normal terminal** (`npm run rebuild:node` first if you have just packaged).
  **RUN 2026-09-20 (6,221 rows, 54 dates, top-15, episode-collapsed) — docs/wheel-parameters.md T7:**
  the cut EARNS something and is DOMINATED. composite-70 clears the random null (mean −0.12% vs band
  −1.29…−0.52) but premium richness beats it (+0.54%, median 2.86 vs 2.02). **ivRank — the composite's
  largest weight, 22 — is INSIDE the band**, and adding it to premiumYield made the pair worse than
  premiumYield alone. **And no rule moves the assigned rate: every one sits inside 29.3–34.7%.** For a
  spread that is the finding — selection changes how much credit you collect, not how often you are
  breached, so premium richness argues for the EXISTING ranking metric (BPS-10), not a pool change.
  **CLOSED 2026-09-20 (v1.1.302, 08 S12): the composite's cut STAYS, and a third arm was added on the
  rule that won.** The re-run put `income-72` at mean −0.56 (back INSIDE the random band), median 1.67,
  assigned 32.7% — **worse than the incumbent on all four**. BPS-1's structural argument was right about
  the weights and wrong about the outcome. Premium richness (+0.54 / 2.86) was the best rule tested, so a
  `premium` pool now runs as a third shadow arm: the whole universe from `analysis_snapshots`, which is
  already filled nightly, so the pool costs no new market data. **The cut itself is not changed** — it
  clears the null and beats both challengers retrospectively; what the arm tests is whether richer credit
  at unchanged breach risk survives into real spread economics, which the CSP proxy cannot say.

- **BPS-3. Price cap $750 and the liquidity gate at 5 of 15.** *Inherited.* **Reframed 2026-09-20: it is
  not the threshold that is wrong, it is the STRUCTURE being scored.** `STRATEGY_RELEVANT_SLUGS.wheel` is
  `[short-naked-put, covered-call]` — a ONE-leg structure, and the Lab sums its components **per leg and
  divides by n**. So the bar is a statement about one near-the-money short put and says nothing about the
  long wing, which is further OTM, thinner, lower-OI, and the leg most likely to be illiquid.
  `hasAdequateLiquidity` also **fails open** when the Lab never ran. Two things reinforce it: the Lab
  ALREADY computes a both-leg score for `short-put-vertical` (it is in `inflection`'s slugs), and the
  spread already has a direct measurement — the round-trip cost share of the two real contracts (BPS-9).
  **Raising to 8 is measurably wrong:** the 8 bar sits in the densest part of the distribution (mode is
  exactly 7), 31% have a tradable <=15% spread and are rejected anyway, 37% flip on the VOLUME component
  which is cumulative intraday (so the bar means different things at the two slots), and liquidity is a
  risk proxy — the liquid subset underperforms.
  **Decision 2026-09-20: measure first (v1.1.303).** The report now shows `liquidityVsCost` — Spearman
  plus bands, over picks and over cost rejections (whose number is parsed back out of the reason
  sentence, so the expensive half of the distribution is not excluded from a check about expense).
  **Censored by construction** and it says so: everything in the pool already cleared the bar, so no score
  below it is observable. **Flat -> the gate measures the wrong structure and no threshold fixes it; the
  options are the vertical's own score (already computed) or dropping the upstream bar for the cost gate.
  Tracks -> the bar earns its place and the threshold becomes a fair question.** n triples from Monday.
  **~~CLOSED 2026-09-22 (08 S13): it TRACKS, and the structural argument above was wrong.~~** 52 paired
  rows, Spearman **−0.51**; median cost share **44% / 41% / 20% / 16.5%** across 0–6 / 7–8 / 9–10 / 11–15,
  over the 25% gate 11/16, 11/15, 3/10, 2/11. A one-leg score that cannot see the long wing predicts the
  cost of trading both anyway — it proxies the whole chain. **The break is between 8 and 9**, not at 5 or
  8, so this item's founding proposal (5→8) would have moved the bar inside a flat stretch; the bottom two
  bands are one population and the top two another. **No threshold changed, and not out of caution:** the
  BPS-9 cost gate measures the same quantity *directly* on the two contracts actually traded, so a
  liquidity bar at 9 gates one quantity twice — once by a proxy that carries a known risk tilt (the liquid
  subset underperforms on two independent samples). The one honest argument for raising it is **call
  budget** (a liquidity refusal is free; a cost refusal costs a chain fetch) — worth revisiting if capture
  budget ever binds, not worth moving a gate on 52 rows. Still censored: the 0–6 band is mostly 5s and 6s.
  The price cap ($750) is untouched and unexamined — it gates the `premium` pool only.

- **BPS-4. Expiry — 21–35 DTE, nearest 30, strictly before earnings.** *Measured, and the evidence
  disagrees with itself.* Per-trade, **21 DTE beat 30 and 35 at every delta**; in the v4 portfolio sim
  30 DTE returned **+75.1%** against 21 DTE's **+61.3%**. The mode targets 30. Unsettled: which
  measurement governs, and why they differ (turnover vs per-trade edge).
  **REFRAMED 2026-09-22: the disagreement is not real — one side is measured under a rule the study
  threw away.** §4's DTE sweep runs on `BASE` = the DRAFT exits (`pt 0.5 sl 2 ts 15`), and BPS-13 found
  the stop plus time stop **halved** the portfolio return, so they were dropped. A fixed 15-day time
  stop is not DTE-neutral: it cuts at **71%** of a 21-DTE trade's life and **43%** of a 35-DTE one, and
  the study's own table shows time-stop exits at **18% / 36% / 42%** for 21 / 30 / 35 DTE (Δ0.30). §4
  measures how much of each trade's life the time stop lets you keep, not DTE. **The confound is 2.4×
  the effect:** at Δ0.25 the 21-over-30 gap is **0.85 pts** of mean return, while removing the time stop
  adds **2.08 pts** to the 30-DTE arm alone (§4 1.72 → §4b 3.80) — and under the adopted exits 30 DTE's
  mean already beats 21 DTE's draft-exit mean. **The sweep was never re-run:** §4b and §4c switch to
  `LEAN` and hold DTE at 30, so there is no per-trade 21-vs-30 comparison under the shipped rule
  anywhere in #43.
  **The portfolio side is one pair, one path, and the figure above is from the wrong run.** `+75.1 /
  +61.3` is `bull-put-spread-v4-flat.md` — the **flat $0.03/leg** costs. On quoted costs it is
  **51.8% vs 47.7%**, so the gap goes **13.8 → 4.1 points** and the 30-DTE arm loses 23 points to
  realistic costs against the 21-DTE arm's 14. 21 DTE also carried the lower drawdown (9.6% vs 10.2%)
  on 337 trades against 263. `portfolioConfigs` has **one** 21-DTE row and **no 35-DTE row at all**.
  **Shadow cannot answer this** — the mode targets 30, so stored DTEs run 24–32 and cluster at 32; it
  generates no 21-DTE observation by construction. **But the data is already paid for:**
  `SPREAD_CAPTURE` fetches every expiry in a **14–45 day** window for each entry ticker every run, at
  real bid/ask — wider than the mode's own 21–35.
  **Decision 2026-09-22: measure the cost half on real quotes first (v1.1.311).**
  `scripts/fr-spread-dte-cost-study.mjs` (self-test 15/15, `scripts/selftest-spread-dte-cost.mjs`)
  builds the mode's spread at 21 and at 30 DTE from the **same** stored chain, paired on
  ticker+date+slot, and reports credit, round-trip cost, cost share and who clears BPS-9's 25% gate.
  **Run it from a normal terminal.** Three things it gets right on purpose: **paired only** (a pooled
  weekly-vs-monthly friction comparison INVERTS in this codebase — the 2026-08-04 expiry-selection
  finding); **the cost gate is an outcome, never a filter**, or the expensive half of the distribution
  under study disappears; and the **monthly share of each bucket is reported**, because a ~30 DTE
  bucket lands on a third-Friday monthly far more often than a ~21 one and the answer could be about
  expiry type rather than DTE. Deliberately silent on returns — nothing is settled yet.
  **RUN 2026-09-22 (296 paired ticker-runs) — and it INVERTED its own headline.** Pooled: 21 DTE
  round-trips at **36.7%** of credit against 30 DTE's **23.9%**, paired difference **+13.6%**, the
  shorter expiry cheaper on only 27% of pairs — decisive for 30, read alone. **But monthly share is
  11% vs 69%, and on the 60 same-expiry-type pairs the median difference is −4.9% — the sign flips.**
  OI is **37/42 vs 460/565** (12× the depth) while credit barely moves ($2.17 vs $2.42; 26.9% vs 28.5%
  of width), so the gap is **quote width, not tenor**. "Nearest 30" lands on a monthly two times in
  three; "nearest 21" on a weekly nine times in ten. **This is the 2026-08-04 expiry-selection trap on
  a different instrument**, and the magnitudes corroborate it independently (that study: monthly vs
  weekly friction 19.6% vs 40.3% of credit; this one: 23.9% vs 36.7% on real spread quotes).
  **So BPS-4 is not really a DTE question — the nearest-30 rule has been doing liquidity selection
  nobody credited it with.** Note what cannot be learned here at any n: both buckets landing on a
  monthly is **structurally impossible** (consecutive third Fridays are 28–35 days apart, these
  buckets span at most 17), so there is no monthly-vs-monthly evidence and the same-type number is
  weekly-vs-weekly only.
  **ANSWERED 2026-09-22 (v1.1.313): with expiry type AND tradability both held fixed, tenor is worth
  about nothing.** The two single controls pointed opposite ways — type-matched **−4.9%** (21 cheaper
  on 45 of 60) against gate-conditional **+3.5%** (cheaper on 23 of 78) — because conditioning on
  gate-clearance *selects for the liquid leg, which is the monthly*, so that row was still an
  expiry-type comparison measured after the gate. The intersection, the only cell with both controls
  on: **15 pairs, median −0.9%, the shorter expiry cheaper on 11 of 15.** A difference of one point of
  cost share against a 25% gate is noise-scale, and 11 of 15 is not significant on its own
  (binomial p ≈ 0.06). **The whole 13.6% headline is expiry type.**
  **And the decision is settled separately, by the as-traded book:** at 30 DTE **156 of 296**
  candidates clear the cost gate at a **12.6%** median share; at 21 DTE **102** clear at **18.4%**.
  Moving the target costs **−35% of the tradable pool** — read against BPS-10, where the eligible set
  is already thin. **So keep 30 DTE, and record the real reason: the rule lands on a monthly two
  times in three and inherits its liquidity (OI 460/565 vs 37/42, a 12× depth difference).** The
  justification on file was per-trade edge, which was a time-stop artifact; the justification that
  survives is liquidity selection nobody credited the rule with. **Both statements are true and must
  be kept apart — operationally 30 wins, mechanistically tenor is not why.**
  **Still open after that:** returns and %/day under the adopted exits, which needs §4's grid
  re-run on `LEAN` plus 21/35 rows in §7 — worth doing only if the cost measurement leaves 21 DTE
  viable, and read knowing the study's wing is Black-Scholes plus a flat skew whose error is itself
  DTE-dependent (§3 moves the 30-DTE answer 0.277 → 0.081 %/day across skew 0→6).
- **BPS-5. Earnings gate — fail closed, ETFs exempt.** *Drafted* (copied from Roll the Dice). Cost
  **16 of 75** first-week rejections: 10 stale (NTAP, INTU — no provider had announced yet) and 6 unknown.
  Unsettled: "no provider has announced the next date" is a different fact from "this reports before
  expiry", and today they produce the same refusal.
- **BPS-6. Short leg — |Δ| 0.20–0.40, nearest 0.30.** *Measured at the centre, widened by fix.* 0.30
  holds under cost while 0.20 goes to ~zero, so the **target** is evidenced; the **band** was widened in
  v1.1.292 to fit real strike grids, not because 0.40Δ was tested. Unsettled: the 0.40 end ships
  unmeasured, and a 0.40Δ short is a materially different trade from a 0.30Δ one.
- **BPS-7. Long leg — 3–10% of spot below the short, target 5%.** *Measured, and the target contradicts
  the measurement.* Under quoted costs a **7.5–10% wing beat 5% per trade** (a fixed per-leg cost spread
  over a larger credit), yet the best v4 *portfolio* row used a 5% wing. Same shape as BPS-4. Unsettled:
  the wing target is doing two jobs — cost absorption and capital efficiency — and they point opposite
  ways.
- **BPS-8. Fill model — mid ∓ half the half-spread, per leg.** *Inherited* (`options-fill.ts`, the app's
  one fill convention). Unsettled: a spread is submitted as **one combo order** and a combo routinely
  fills better than legging in, so four independent half-spread haircuts may overstate cost — which
  matters because BPS-9 is computed from it.
- **BPS-9. Cost gate — round-trip cost ≤ 25% of mid credit.** *Measured, and the best single finding in
  #43.* **New 2026-09-22 (BPS-4's run, 296 paired candidates): the gate cuts the distribution almost
  exactly in half.** Median cost share at 30 DTE is **23.9%** against a 25% bar, with **140 of 296**
  failing. That is the liquidity-bar-at-8-with-a-mode-of-7 shape — a threshold sitting in the densest
  part of what it measures, where one point of movement changes the population a great deal. Not a
  reason to move it (this gate is the best-evidenced rule here and the one that makes the #43 result
  insensitive to the cost model), but it means **25% was never swept and the sweep is now cheap**: the
  harness already computes the share for every candidate, so the population at 20/25/30/35% is one
  pass away. With it the portfolio returned +61.7% on flat costs and +60.8% on quoted — **the gate makes the
  result insensitive to how costs are modelled**. It is also the most active gate: **20 of 75**
  rejections, HUM alone 9. Unsettled: 25% was chosen, not swept; and it is a share of *credit*, so it
  tightens exactly where credit is thin — which may be the intent, or may be a second liquidity gate
  wearing a costume.
- **BPS-10. Ranking — net credit ÷ max loss, top 5. UNVALIDATED, and about to start binding.** *Drafted.*
  The only related evidence is that premium richness ranked positively for CSPs (v1.1.176). It has been
  nearly inert: **"ranked below the top 5" fired once in ten runs**, because the pool was starved — the
  same shape as the wheel tiebreak that faces a choice on 7 of 62 days. With the 36 rejections now gone
  the pool goes from ~1.9 to ~5.5 survivors per run and the cut starts deciding most days. **Cheap thing
  first: an eligible-set-size histogram per run.** If it stays at 1–2 the ranking needs no work; if it is
  5+, the §4 sample is being selected by an untested rule. **The only item with a deadline** — it needs
  Monday's data either way.
  **Instrumented 2026-09-22 (v1.1.310):** `runs[].eligible` and `eligibility` per pool — binding runs,
  names dropped, median, max, size histogram. Counted from the cut's own rejection reason, not from
  `rejected` (every other refusal happened upstream) and not from the rejection tally (grouped by kind
  across runs, so it cannot be split back per run). **`eligible == topN` is not binding** — every
  candidate was picked and the cut decided nothing.
  **First read (3 pool-runs on 09-21/22):** the cut has fired **8 times** against once in ten runs before,
  so it is live — but it is dropping **one name at a time**, not five. `premium` fills all 5 slots on
  every run; `wheel` runs 1–3 picks; `income` fills none. **So the answer is "binding, barely":** the §4
  sample is not being shaped much by the untested rule *yet*, and the number to watch is `droppedTotal`
  per run rather than whether the pool looks full. **Still open:** the arms diverge sharply on the ranking
  metric itself — `premium` picks return-on-risk **0.37–0.48** against `wheel`'s **0.19–0.37** — so the
  cut behaves differently per arm, and a rule validated on one may not transfer. Re-read once `premium`
  has ~10 runs.
  **Re-read 2026-09-26: it now binds on 7 of 8 `premium` runs, 23 names dropped (up to 7 in one run),**
  so the untested rule is choosing most of that arm's sample. `wheel` binds 1/18 and `income` 0/8.
  **The data to test it was being thrown away.** Every cut name was stored as a bare reason with no legs,
  so none of the 23 can ever be settled (the CLAUDE.md shape: "when a ranking's quality is in question,
  the losers are the data you need").
  **Test built 2026-09-26 (v1.1.327), two halves:**
  - **Real quotes:** cut names now keep their legs and would-be rank, capture tracks them to expiry, and
    the report settles them as a counterfactual beside the same binding runs' picks (`rankingTest`, in
    the script and the 🪜 view; never in §4).
    **Read it once ≥ 15 cut positions have settled on each side, earliest late October.**
  - **History now:** §8 of `fr-bull-put-spread-study.mjs` — the within-day top-5 lift against a random-5
    null, for return on risk, its inverse, brief rank and ATM IV (self-test covers rich-wins, inverted and
    unrelated worlds). **Run from a normal terminal:**
    `node scripts/fr-bull-put-spread-study.mjs --slip-model quoted --capital 25000 --risk 2500 --out bps10-ranking.md`.
    It uses a Black-Scholes wing with a flat skew, so it answers "does ranking by IV pick better", not the
    real metric.
- **BPS-11. Sizing — floor(budget ÷ per-contract max loss), no longer a gate.** *Fixed.* $2,500 default,
  $250 stored (S10); shadow records an unaffordable pick at `contracts = 0` (v1.1.300). Unsettled:
  `maxOpenPositions` has never been given a real number (10 placeholder), and nothing tracks open
  positions, so the cap is guidance.
- **BPS-12. Sector cap — 3 per sector, simulated only.** *Operator decision (S9).* Shadow picks are
  uncapped so the evidence is not shaped by the cap. Unsettled: enforcement at `on`, and the known GICS
  coarseness — CF counts as Materials but trades with natural gas, so the first week's "4 energy
  positions" was really 5.
- **BPS-13. Exit — 50% of net credit, no loss stop, no time stop.** *Measured, and the strongest result
  in #43* — the profit target is the dominant lever, monotonic across every stop/time cell; the stop plus
  time stop **halved** the portfolio return. Unsettled: nothing tracks an open spread or fires an alert
  (§5, out of scope for v1), so the rule with the best evidence behind it is the one the system does not
  execute.

## B. Carried over from the main list

- **BPS-14. Re-run the §4 study on captured costs** once ≥ 15 intraday capture days exist:
  `fr-bull-put-spread-study.mjs --slip-model quoted --capital 25000 --risk 2500`, with the v1.1.292 leg
  rules. Must beat the CSP on total return at ≥ 20% annualised, with quoted-cost coverage ≥ 50% of
  entries so the answer does not rest on the $0.03 fallback. (Was #44's enable check.)
- **BPS-15. Build the `on` surfaces** — Daily Brief panel and email — only once §4 passes. `on` is
  deliberately not a member of `SpreadModeSwitch`; adding it **fails the build** at `budgetGates()` in
  `spread-mode.ts`, which is where the BPS-11 decision must be made. (Was part of #44.)
- **BPS-16. Move spread chain capture into the collector** after TradeAnalyzer 2 is promoted, so it
  inherits the quality gate and the duplicate E\*Trade chain fetching (TA1 capture + TA2 chain subset)
  ends. `spread-capture-quality.ts` (SC-1…SC-4) is the interim cover. (Was #44's "Open".)
- **BPS-19. Prefer the MONTHLY inside 21–35 DTE, instead of getting it by accident.** *Opened
  2026-09-22 out of BPS-4, untested.* If the expiry advantage is type rather than tenor — and the
  intersection cell says it is — then "nearest 30" is a proxy for "usually the monthly", and it misses
  on the **31%** of runs where the 30-DTE pick is a weekly. The data already holds the natural
  experiment: **32 pairs where the 21-DTE bucket is the monthly and the 30-DTE bucket is a weekly.**
  If type is the explanation the sign must reverse there — v1.1.314 reports that cell, plus how many
  clear the cost gate on each side, which is what the lever would be worth on cost. **Check the
  precedent before building anything:** the wheel's version of exactly this rule was tested on
  realized P&L and **REJECTED** on 2026-08-04 (memory `expiry-selection-followup`) — the friction
  saving was never paid once the liquidity gate was applied, and snapping away from ~30 DTE landed on
  a contract *thinner than the weekly it replaced*. That was a one-leg CSP behind a `liquidityScore ≥ 8`
  gate; this is a four-fill spread behind a cost gate that refuses 47% of candidates, so it is a
  genuinely different question — but the same trap is available, and the same answer is a live
  possibility. **FR-SEY-5: cost is not return.** A cheaper entry that systematically picks a different
  population is not shown to be better until the returns are measured.
  **Harness committed 2026-09-26 (v1.1.326, written 09-22):** `scripts/fr-spread-monthly-rule-study.mjs`
  runs the two PICKERS over the same captured expiry set — A nearest-30, B the monthly in 21–35 else A —
  and reports cost, gate clearance, open interest of both picks (the wheel's failure mode) and the
  dilution. Self-test 19/19 (`scripts/selftest-spread-monthly-rule.mjs`). **Not yet run** — from a
  normal terminal: `node scripts/fr-spread-monthly-rule-study.mjs --out bps19-monthly-rule.md`.

- **BPS-18. The `premium` arm and the budget interact, and nobody chose that.** *Observed 2026-09-22,
  untested.* 7 of 22 shadow positions are unaffordable at the stored $250, and they are overwhelmingly
  premium's: BE $1,055, AMD $2,129, MRVL $1,094, MSTR $540, INTC $422 per contract. Premium ranks the
  universe on annualized return with a **$750 price cap** and no width rule, so it selects high-priced
  names whose strike grids are wide — and a wide grid is a large per-contract max loss. **The budget is
  size-only in shadow (BPS-11, v1.1.300), so this shapes nothing today.** At `on` it would, and in a way
  nobody decided: the arm T7 measured as best is the arm the budget would empty hardest, so the enable
  decision could silently be made by an account size rather than by the evidence. Two things to settle
  before `on`: whether the budget filters premium picks or sizes them at one contract, and whether the
  pool needs a width or per-contract-risk rule of its own. Related: BPS-11, S10, 08 §3.5.

- **BPS-17. Revisit the v2 engine's 2× stop on wheel put spreads.** The engine trades wheel as a put
  spread with a 50% target and a 2× stop, validated in June with no costs; #43 found the stop plus time
  stop halved a portfolio's result and a 1× stop is negative once costs exist. Needs an FR-SEY-5 replay
  on the engine's own exit path before any change. **Note the engine is itself blocked on Tradier**, so
  this changes no live trading yet. (Was #45.)
