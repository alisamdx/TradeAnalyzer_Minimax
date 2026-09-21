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

## Status — 2026-09-20

Mode is `shadow`: picks are computed after every brief and stored, with no panel, no email, and nothing
reaching the v2 engine. The 08 §4 enable gate is **time-blocked, not work-blocked**:

| §4 condition | State |
|---|---|
| ≥ 15 intraday capture days, then re-run the study `--slip-model quoted --capital 25000 --risk 2500` | **5 / 15** — earliest ~2026-10-02 |
| ≥ 30 settled positions, mean return on max loss > 0 | **0 / 30** — all 10 open, expiring 2026-10-16 |

First week's funnel (2026-09-14 → 09-18, 10 runs): 94 ticker-runs → 75 rejected → 19 picks → 10 positions.
**36 of those 75 rejections no longer occur** (25 leg-rule, fixed v1.1.292 and confirmed 25/25 by the
v1.1.299 dry run; 11 budget, which stopped gating in v1.1.300).

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

- **BPS-3. Price cap $750 and the liquidity gate at 5 of 15.** *Inherited.* `hasAdequateLiquidity`
  **fails open** when Strategy Lab never ran. Unsettled: 5/15 was set for a one-leg CSP, while a spread
  crosses **two** spreads on entry and two on exit; the v2 engine's tradability bar is 8/15 and the dice
  inherited 8. A bar set for one fill is probably wrong for four. Caution before raising it: liquidity is
  a **risk proxy**, confirmed twice — a gate, never a ranking signal.
- **BPS-4. Expiry — 21–35 DTE, nearest 30, strictly before earnings.** *Measured, and the evidence
  disagrees with itself.* Per-trade, **21 DTE beat 30 and 35 at every delta**; in the v4 portfolio sim
  30 DTE returned **+75.1%** against 21 DTE's **+61.3%**. The mode targets 30. Unsettled: which
  measurement governs, and why they differ (turnover vs per-trade edge).
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
  #43.* With it the portfolio returned +61.7% on flat costs and +60.8% on quoted — **the gate makes the
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
- **BPS-17. Revisit the v2 engine's 2× stop on wheel put spreads.** The engine trades wheel as a put
  spread with a 50% target and a 2× stop, validated in June with no costs; #43 found the stop plus time
  stop halved a portfolio's result and a 1× stop is negative once costs exist. Needs an FR-SEY-5 replay
  on the engine's own exit path before any change. **Note the engine is itself blocked on Tradier**, so
  this changes no live trading yet. (Was #45.)
