# Pending work — numbered

The one list to work from. **Numbers are permanent**: an item keeps its number when done
(struck through with the date and what closed it) and new items are added at the end, so
"do #13" means the same thing next week as today. Created 2026-09-12 after the pre-pilot
audit. State at creation: existing app **v1.1.239**, `core` **0.6.8**, TradeAnalyzer 2
**0.4.8**, dictionary **v15**, generation **gen-002** (reset 2026-09-12 16:50).

---

## A. Monday 2026-09-14 — pilot day 1

1. **Install the new build and keep TradeAnalyzer running** through 17:05 (daily run) and
   19:30 (watchdog). Open it from `release\win-unpacked\TradeAnalyzer.exe`; status bar
   **v1.1.239**. TradeAnalyzer 2 from `packages\next\release\win-unpacked\TradeAnalyzer2.exe`
   (footer **v0.4.8 · core 0.6.8**).
2. **E\*Trade token valid before 17:05.** A dormant token renews itself; one that expired at
   midnight needs a manual re-login. Settings → Test Connection.
3. **After the ~10:15 brief: confirm the legacy hand-off worked** — its first production
   success since the fix (v1.1.232). TA2 → Data → `legacy_brief_candidate`, filter
   `as_of_date = 2026-09-14`: rows present. `meta_response.parse_status` for it is `ok`.
4. **After the daily run: bring the gate email and the run's checks table** (TA2 → Runs →
   the daily run). Especially QC-205, QC-209 (did the three early SOLS QC-205 findings stop
   firing, and does SOLS 2025-10-30 appear under QC-209?) and QC-904.
5. **Measure the chain phase**: call count, failures, duration (Runs → domains). First
   measurement of 04 §11's pending "expected chain calls/day"; confirms the 120/min E\*Trade
   pace (v1.1.239) holds with no throttling failures and finishes well before 19:15.
6. ~~**Short interest came back?** `raw_short_interest` row count and newest
   `settlement_date`. Rows → do #8. Refusal → do #9.~~ **Done 2026-09-14:** 67,386 rows,
   newest settlement 2026-09-14.
7. **19:30 watchdog stays quiet** (no NO-RUN email).

## B. Short code follow-ups

8. ~~**Short interest verified** (after #6 returns rows): remove `verify` from
   `raw_short_interest.short_interest` (clears that pilot-exit blocker); remove the pointless
   `skipped('chain subset is empty')` in `runShortInterest` (the sweep is whole-market); fix
   the stale "plan coverage unverified" comments in `ingest/events.ts` and the dictionary.
   Package.~~ **Done v1.1.245 (core 0.6.9).**
9. ~~**Short interest refused** (after #6): read the actual response. A plan refusal → build the
   FINRA fallback (decided 2026-09-12, 02 §12).~~ Not needed — Polygon returned rows.
10. **Host timestamps in ET**: `ElectronCollectorHost` stamps `requestedAt`/`respondedAt` —
    and therefore raw `observed_at` — with `toISOString()` (UTC). Switch to `etTimestamp()`.
    Consistent within a table today, so nothing orders wrongly; best done early in the pilot.
11. **`legacy_brief_candidate.composite_score` unit**: declared a fraction ("0–100 stored as a
    fraction"), but both the importer and the live hand-off write the raw 0–100 value.
    Decide: divide by 100 at both writers, or re-declare the column. Both paths together.
12. **Write the measured chain budget into 04 §3/§11** from #5 (calls/day,
    expirations/ticker, duration) and revisit the 120/min pace if it is far from the limit.

## C. Pilot exit — before promotion (20 clean days; earliest ~2026-10-09)

13. **Rule on the backfill findings** (QC-204 / QC-205 / QC-209) after Monday's run
    re-evaluates them. Start with likely ticker reuse: SPCX 2026-06-12, BNY 2026-05-21,
    FIG 2025-07-31, NIQ 2025-07-23, HHH 2023-08-14, SOLS 2025-10-30. Then genuine moves: GME,
    WAL, SMMT, APLD, BMNR. (Draft classification from 2026-09-12 — verify each before ruling.)
14. **Close calls needing a filing check**: QXO 2024-07-24/30 (SilverSun → QXO recap: same
    entity, different business) and JAN 2022-05-31 / 06-07 (unknown).
15. **Weekly replay**: TA2 → Jobs → queue `replay`; TradeAnalyzer → Batch → Collector one-shot.
    First by ~2026-09-18 (QC-956 warns after 7 sessions, ~9/21). Then weekly.
16. **Never-fired checks — rule on each** (TA2 → Pilot exit).
17. **Working thresholds — rule on each**, including QC-209's new `minGapSessions = 20`.
18. **Every gate domain inspected by a person** (TA2 → Pilot exit → inspections).
19. **18 checks specified in 03 but not built** — build or formally de-scope each in 03:
    QC-002 archive integrity, QC-003 dictionary conformance, QC-005 mutation guard,
    QC-006 run completeness, QC-007 capture-rule reference, QC-101 universe drift,
    QC-102 reference staleness, QC-103 sector mapping gap, QC-104 optionability
    contradiction, QC-105 calendar coverage, QC-106 unexpected market status,
    QC-206 series consistency after re-fetch, QC-208 zero-volume day, QC-304 stale snapshot,
    QC-952 fire-count review, QC-953 archive/DB drift, QC-954 exception aging,
    QC-955 threshold distance. Highest value for trusting a "clean day": QC-006, QC-105,
    QC-106, QC-002, QC-005. (Check first whether B10a's Pilot-exit reviews already cover
    QC-952/955 in substance.)
20. **Watch generation integrity** through the pilot — the corruption investigation is
    downgraded, not closed. Run `diagnose-generation.mjs` from an ordinary (non-Claude,
    non-redirected) terminal with both apps closed, e.g. weekly.

## D. Later

21. **IV bootstrap purchase** (IVolatility), ~4 weeks after phase 9 first ran in production —
    i.e. around early October. Ask the vendor first whether history is sold from the signup
    date, which would invert the timing.
22. **Set QC-205 / QC-209 thresholds from the pilot's own distributions.**
23. **FINRA as a cross-source check for short interest** (optional, after #8).
24. **Stage 2** — derived layer and the new app taking over daily use — after promotion.

## E. Existing app (TradeAnalyzer) backlog

Inventoried 2026-09-12 from `.ai/AI_CONTEXT.md` §11 (Open decisions), the scheduled tasks and
project notes. Anything that changes which trades are taken or how they size/exit is
**FR-SEY-5-gated**: replay/backtest evidence first, or ship default-off.

25. **Validate `WHEEL_MONTHLY_FIRST_EXPIRY`** — default-off since v1.1.128; signal-level A/B done,
    realized validation not. **Scheduled:** task `wheel-monthly-first-ab-sep30` runs the harness
    **2026-09-30 12:30 ET** (a day the two policies actually differ; the app must be running).
    Then decide on realized outcomes, not the signal alone.
26. **Bec's strategy — Tier 1, additive, gates nothing** (`docs/Bec/STRATEGY-SUMMARY.md`):
    ~~(a) rollability score — how far one week's credit moves a strike and weeks back to break-even~~
    **done 2026-09-12, v1.1.240** (🧗 Rollability panel on the Roll Analyzer);
    (b) stochastic RSI as a displayed indicator; (c) cumulative premium vs cost basis per position.
27. **Scheduled task `option-liquidity-weight-sweep-rerun` (2026-09-28) — cancel or rewrite.**
    Superseded: the same sweep was re-run 2026-09-03 on 18,219 settled CSPs (v1.1.170) and closed.
    **And unsafe as written:** its prompt opens the production SQLite directly from a Claude session,
    which is MSIX-redirected (CLAUDE.md quirk — reads a shadow copy, can move WAL state). Needs an
    operator decision before 9/28.
28. **Morning-vs-evening liquidity score** — the two §11 entries on this are one question. Capture
    of both slots exists since v1.1.185 (2026-09-04); run `scripts/slot-liquidity-drift-study.mjs`
    now that ~6 trading days pair up. **Do not touch `MIN_TRADABLE_LIQUIDITY_SCORE = 8` without a
    replay** (37% of stored wheel picks flip to passing on the volume component alone).
29. **Real income/wheel return-on-capital view** — waits on `options_premium_history` maturity
    (`getPremiumHistoryReadiness()`: 40 dates older than 45 days), expected to flip ≈ 2026-09-25.
    Check readiness, then build the true ROC analysis replacing the stayed-above-strike proxy.
30. **Book Greeks monitor, Tier 1** (read-only, ~1 day; `Requirements/v2-execution/09-book-greeks-monitor.md`):
    beta-weighted net delta / theta / vega over the open book, headline `deltaPctOfNetLiq`.
    Mandatory 4-row sign test (CSP / CC / long call / long put). Tier 2 guardrail is FR-SEY-5-gated.
31. **Critic's treatment of trend for short premium** — OPEN since 2026-09-03, **do not act yet**.
    Becomes testable ~a quarter after capture (≈ early Dec): critic verdict × `notDowntrend` band ×
    settled outcome from `brief_candidates` + `daily_briefs`.
32. **v2 execution — Tradier** (blocked on the operator): account + Level-3 spreads + tokens →
    move tokens to secure settings + UI, calibrate every `// VERIFY` endpoint in the sandbox, wire
    chain discovery for the spread-permission probe, 1-contract live canary. **Status of the Tradier
    application unknown — ask.**
33. **v2 multi-strategy book — small remaining ops:** Execution Settings UI for
    `min_composite_by_strategy` (migration-set today); decide the `max_combo_spread_pct` liquidity
    gate (~0.20 suggested, cannot be backtested).
34. **Requirements/ and UserManual/ expansion** — queued docs work (items #2 and #3 of the docs task).
## F. Opportunity engine — the purpose of the rebuild (`NewApp/requirements/07-opportunity-engine.md`)

Decisions 2026-09-12: premium ROC avoiding assignment; 0.35–0.45Δ at 14–30 DTE; roll when ITM with
≤ 7 days left to the next 14–30 DTE expiry at same/lower strike for a credit, else close; top 5, no
capital cap; after both briefs; TA2 view + email.

36. ~~**Write the design**~~ **done 2026-09-12** — `07-opportunity-engine.md` v1.
37. ~~**Interim Wheel Shortlist in the existing app**~~ **built 2026-09-12, v1.1.242** — 🎯 button + panel on
    the Daily Brief, email after both brief runs. First live run: Monday 2026-09-14 ~10:15. (07 §3): pool from wheel+income Stage-4 candidates,
    live 0.35–0.45Δ / 14–30 DTE contract, gates (earnings, critic flag), rank by premium ROC, roll-room
    and own-at-strike annotations; logged email after both briefs + Daily Brief panel. Advisory only.
38. **Sanity backtest**: `backtestReplayPicks` wheel at 0.40Δ / 21 DTE vs 0.30Δ / 30 DTE (theoretical
    pricing, no rolls) — a rough read, not proof.
39. **Answer 07 §8 open questions** (roll choice, roll-day timing, entry price convention, pool width).
40. **TA2 answer key** (07 §4): derived table of every D2 contract with the D3 roll simulated on stored
    quotes; first labels ≈ early October.
41. **TA2 Opportunity view + email + self-grading scorecard** (07 §7), once ~40 entry dates have settled
    (≈ mid-November).

## G. Bull put spread — second strategy after wheel

Decisions 2026-09-12: bull put **credit** spread (premium, not direction); 5–15 day hold; risk as
fixed dollars or % of the trade; a new brief mode alongside wheel. Draft criteria: 21–35 DTE,
short 0.20–0.30Δ, credit ≥ 30% of width, IVR ≥ ~30; exit 50% profit / 15 days / 2× credit loss.

42. ~~**Capture both legs' quotes**~~ **built 2026-09-12, v1.1.243** — `spread_chain_capture`, after
    every brief: entry chains (wheel/income/bullish pools, 14–45 DTE) + 21-day tracked series.
43. **Study** — *harness written 2026-09-12, awaiting a run from a normal terminal*:
    `scripts/fr-bull-put-spread-study.mjs` (self-test 10/10). Extends v1.1.54's
    `fr-wheel-spread-study.mjs` (wheel as put spread already validated: 79.8% win / 8.2% ret on max
    loss vs baseline 74.3% / 3.7%; wheel is an eligible v2-engine strategy) with what it lacked: paired
    naked-CSP comparison, capital efficiency per capital-day, time stop + exit grid, skew sensitivity,
    DTE × delta grid, IVR / SMA50 / credit-vs-width splits, episode collapse, discontinuity guard.
    **First run 2026-09-12 — INCONCLUSIVE, sample too small:** replay held only 225 wheel picks
    (entries 2026-06-02…08-04, **77 episodes, one up-trending regime**) because `runRange` wipes the
    replay before every run. Directional reads that held across neighbouring rows: spread beats CSP on
    return per capital-day in every row; 50% target + 10–15 day time stop beats hold-to-expiry per day
    (~1.0–1.2 %/day vs 0.27); 21 DTE beat 30/35 at all three deltas; skew 0→6 cuts spread mean return
    12.5→8.5% without flipping it. Found: at 0.25Δ / 5%-of-spot wing only **3 of 77** credits reach 30%
    of width (the draft gate would reject ~96%); IV rank ≥30 on **all 77** (iv_history splice artefact —
    untestable); the dollar-weighted cap-eff metric swung on single names (Q2 391 vs Q3 19 %/yr at equal
    mean returns) — replaced by equal-weighted ret%/day, plus `--out` for UTF-8 output.
    **Second run 2026-09-13 — the real sample:** replay 2025-06-01…2026-08-10 → 1,495 picks, **471
    episodes, six quarters** (BS-priced, skew 3, no slippage). Draft profile (30d Δ0.25, 50% target,
    2× stop, 15-day time stop): spread 79.4% win / +6.26% mean on max loss / ~10 days vs CSP 84.9% /
    +0.72% / ~9 days; spread p5 −42% vs CSP −3.1%. Held on both return-per-day measures: **the 50%
    profit target is the dominant lever** (monotonic across every stop/time cell; no target is worst);
    **1× loss stop hurts, 2× ≈ none** (defined risk already caps loss — size by max loss instead);
    time stop 10/15/none ≈ flat per day; **21 DTE beats 30/35 at every delta** (stops 8% vs 5%);
    spread positive in **all six quarters** (weakest 2025-Q3 +2.0%, 2026-Q1 +2.7%); skew 0→6 cuts
    mean 7.5→5.2% without flipping. Credit/width at 0.25Δ/5% wing: p10 16 · median 20 · p90 24 — the
    30% draft gate is unreachable. **Close BELOW SMA50 did better** (+9.4% vs +5.7%, n=67) — consistent
    with notDowntrend being anti-predictive; do NOT add a trend-intact gate. IV rank still the splice
    artefact (232/281 ≥80, 190 unknown). **Open:** slippage (two legs × two fills vs a ~20%-of-width
    credit) unmeasured — run `--slip`; the >35% step guard excluded genuine moves (ORCL +36%, SNPS −36%
    on 2025-09-10, CGNX) rather than splits, which drops real tail losses — tighten it; portfolio sim.
    **Slippage runs 2026-09-13 ($/share per leg per fill):** draft-profile spread mean return **+6.26% →
    +3.26% ($0.03) → +1.54% ($0.05)**; win 79 → 73 → 71%; negative quarters 0 → 1 → 2 (2025-Q3 −4.6%,
    2026-Q1 −0.4% at $0.05). CSP barely moves (+0.72 → +0.63%, positive every quarter). Spread still
    ~2× CSP per capital-day at $0.05 (was ~9×) with p5 −44% vs −3%. **Friction reverses the exit
    finding:** at $0.05 the 5–15 day draft (0.14 %/day by ratio of means) loses to fewer paid closes —
    50% target with no stop/time stop 0.26, 75% target no stop 0.28, hold to expiry 0.25; every 1× stop
    row is negative. **Friction favours bigger credits:** 0.20Δ rows go to ~0 at $0.05 while 0.30Δ
    holds (21d Δ0.3 +2.55%). Untested lever: a wider wing (fixed $ slippage over a larger credit).
    Deciding input now = the real fill cost per leg, which nothing has measured for spreads.
    **Script v3 (2026-09-13, self-test 20/20):** wing × delta grid (5/7.5/10% × 0.25/0.30/0.35); the
    >35% step is classified (split = split ratio + normal step-day dollar volume; reuse = 15× dollar-
    volume regime shift) and genuine moves like SNPS −36% are now KEPT; `--slip-model quoted` prices each
    ticker at 0.5 × its median quoted half-spread (options_premium_history + spread_chain_capture);
    §7 fixed-pot portfolio sim (spread by `--risk` max loss, CSP by `--csp-alloc`, one position per
    ticker, capital reserved to exit) — the capital-efficiency answer. Re-run once ~2 weeks of chains exist.
    **v3 quoted run 2026-09-13 — mostly a lesson about the inputs:** priced from `options_premium_history`
    quotes (median **$0.275/leg, p90 $0.95**), the draft spread went to **−14.4%/trade, 30% win, 45%
    stop-outs**; CSP +0.2%. Portfolio ($25k, $500 risk, ≤10 open): spread best **+8.2%** (Δ0.30, 10% wing)
    at **6% utilisation**, CSP **+14–20%** (ann. 11–16%) at 44–70% utilisation, drawdown ~1.5%. Three
    input faults found, fixed in the script: (1) that table is written by an **afterCloseOnly** job, so
    every quote was an evening quote — quoted slippage now uses intraday `brief_candidates` /
    `spread_chain_capture` only (`--quote-slot any` to allow evening); (2) exits were decided on a mark
    that already included the exit cost, stopping out high-cost trades on day one — now decided on mid,
    realised with slippage; (3) $500 risk × 10 positions capped deployment at ~12% and skipped ~900 of
    1,363 picks for size — new "on deployed %" column separates structure from sizing. Also added the
    round-trip-cost ≤ 25%-of-credit liquidity gate (§4c, §5, §7). Classifier kept CGNX/ORCL/SNPS as
    genuine moves (0 split/reuse exclusions). Wider wings helped under cost (10% wing ≈ break-even per
    trade). **Re-run with intraday quotes; intraday coverage grows daily from the 2026-09-14 brief.**
    **v4 runs 2026-09-13 (fixed exits; $25k pot, $1,000 max loss/spread, ≤10 open; flat $0.03 and
    quoted-intraday with $0.03 fallback):** intraday quotes cover only **32 tickers / 55 of 1,475
    entries**, and they are expensive (median **$0.50/leg**, p10 $0.125) — those 24 draft trades lost
    −11.5% each, so $0.03 is optimistic for many names. **Portfolio, flat $0.03:** Δ0.30 / 5% wing /
    50% target / no stop / no time stop **+75.1% (56% ann.)**, drawdown 9.0%, util 26%, vs CSP **+25.8%
    (20% ann.)**, drawdown 1.4%, util 48%; 75% target +79.9%; hold to expiry +62.6%; 21 DTE +61.3%;
    the draft (2× stop, 15-day time stop) only **+29.9%** — the stop and time stop halve the result.
    **Same with quoted costs:** +51.8% ungated, but **+60.8% with the ≤25%-of-credit cost gate vs
    +61.7% flat — the gate makes the result insensitive to the cost model**, the most useful single
    finding. Neighbouring settings (Δ0.25–0.35, 50–75% target, no stop) all +48–80% vs CSP +18–26%.
    Spread return/drawdown ≈ 8 vs CSP ≈ 18: ~3× the return for ~6× the realised drawdown. Holding
    averages ~14–18 days, not 5–15. Still negative in 2025-Q3 per trade; below-SMA50 better again;
    skew 6 cuts per-trade return by a third. **Candidate criteria for #44:** 30 DTE (21 ok), short
    ~0.30Δ, wing 5–7.5% of spot, round-trip cost ≤ 25% of mid credit, 50–75% profit target, no loss
    or time stop, size by fixed max loss with a position cap, no SMA50 or IV-rank gate. Model-priced,
    one replay — confirm on captured chains before enabling (FR-SEY-5).
44. **`bull_put_spread` brief mode** — *design approved 2026-09-13 (all defaults); built in SHADOW, v1.1.244*
    (`spread-mode.ts`, `spread_mode_picks`; `on` panel/email built when 08 §4 passes). Design:
    `NewApp/requirements/08-bull-put-spread-mode.md`. Wheel pool; built from the same run's
    `spread_chain_capture` rows (no extra E*Trade calls); 21–35 DTE, 0.30Δ short, 5–7.5% wing; fills
    via `options-fill.ts`; round-trip cost ≤ 25% of credit; 50% target, no stop/time stop; sized by
    max loss; ranked by credit ÷ max loss (unvalidated); `off|shadow|on` switch, ships `shadow`;
    `spread_mode_picks` table. Enable per §4 (captured-cost re-run + 30 settled shadow picks).
    **Enable check (08 §4), earliest ~early October:** re-run `fr-bull-put-spread-study.mjs --slip-model
    quoted` after ≥ 15 intraday capture days, and settle ≥ 30 shadow picks. Real account numbers still
    to set (defaults $1,000 / 10).
45. **Revisit the v2 engine's 2× stop on wheel put spreads.** The engine trades wheel as a put spread with
    a 50% target and a 2× stop, validated in June with no costs; #43 found the stop + time stop halved a
    portfolio's result and a 1× stop was negative once costs exist. Needs an FR-SEY-5 replay on the
    engine's own exit path before any change.

---

35. **Tidy `.ai/AI_CONTEXT.md` §11** — e.g. "ETF-aware wheel scoring … needs validation before
    enabling (v1.1.118)" is stale (validated and shipped enabled in v1.1.172); the B1 slot-bias
    entry duplicates #28.

---

## H. Making the bug class findable — added 2026-09-15

Both come out of the 2026-09-15 session, where three separate faults turned out to be one
shape: **code encodes an assumption about an external system, and nothing ever compares
that assumption to what the system actually sent.** The evidence for the right answer was
sitting in `meta_response` the whole time in every case.

46. **QC family: validate our encoded assumptions against captured provider bytes.**
    The archive already holds every response, so each of these is a query rather than a new
    data source. Candidates, each with the fault that motivates it:
    - **A constructed identifier must equal a received one.** `osiSymbol()` built
      `AIZ   261016C00280000` while E*Trade sends `ACGL--260918C00095000` — every one of 415
      pins unmatchable, QC-409 growing daily and never resolving, for two weeks (v1.1.248).
      Check: for each `ref_sticky_contract.osi_symbol`, does a contract with that exact
      spelling exist anywhere in `raw_option_contract_snapshot`?
    - **An enum we branch on must be a subset of what has been observed.** `expiryType` had
      an undocumented fourth value (`MONTHEND`) found only by reading a live response.
    - **A field we treat as numeric must actually be numeric in stored data.** Polygon's
      daily `v` is fractional routinely; the parser asserted integrality and wrote `0` on
      most bars (v1.1.236), and QC-205 reported `Evaluated 0` for three backfills.
    - **A field we treat as boolean must not be a string.** `inTheMoney` is `"y"`/`"n"`, and
      `Boolean("n") === true`.
    Design note: these are *blocking* only where a mismatch means data is being silently
    discarded; the identifier check is the clear case. Start with that one — it is a single
    query and it would have caught the OSI bug on day one.

47. **Source scan: a fixture for a provider-shaped field must come from a captured response.**
    The rule is already written in `CLAUDE.md` ("test a reader against the schema it reads,
    never a fixture written from the reader") and has been broken four times: the legacy
    importer's fake tables written from the importer's own assumptions (v1.1.237), every bar
    fixture using a whole-number volume (v1.1.236), all four OSI fixtures spelling `osiKey`
    the way the builder did (v1.1.248), and both dedup tests pinning `asOfDate` to one
    constant (v1.1.248). **Prose in `CLAUDE.md` demonstrably does not hold** — the rule was
    written before two of the four breaches.
    Make it executable: a test that fails when a fixture for a provider field is a literal
    nobody sourced, with the anchor naming the table and date it was copied from (as
    `osi.test.ts` now does). Follow the existing source-scan discipline — strip comments and
    JSX text first, and give the rule `fires` and `clean` fixtures both ways so the stripping
    cannot quietly make it vacuous.
    **This is the meta-item of the two**: it targets the mechanism by which the assumptions in
    #46 get baked in and confirmed, rather than any single assumption.
