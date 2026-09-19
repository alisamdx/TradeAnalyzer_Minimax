# 14 — Daily Intelligence Brief & AI Critic

The Daily Intelligence Brief is the app's flagship output: a prioritized set of scored trade picks per strategy, each with a concrete structure, AI rationale, and an adversarial AI critique. Services: `daily-intelligence-brief-job.ts` (the pipeline, a batch job), `critic-service.ts`, `email-service.ts`, `brief-report-builder.ts`. IPC: read via `window.api.scoring.*`. View: `DailyBriefView.tsx` (📋 Daily Brief). Tables: `daily_briefs` (§2.14).

## 14.1 Pipeline (six stages + critic)

Runs as a batch job (§20), post-market, manual-trigger by default:

1. **Screen** — start from the full S&P 500 + Russell 1000 + ETF universe (read from `constituents`, not a pre-filtered screen, so weak names needed for bearish picks aren't excluded).
2. **Score** — run the Scoring Engine (§13) for all six strategies (incl. inflection); rank candidates per strategy.
3. **Filter** — take the top candidates per strategy; apply a **hard liquidity gate**: drop any pick whose best relevant Strategy-Lab structure scores `liquidityScore < 5`. Short-premium strategies (**income, wheel, bearish**) additionally apply a **−20 composite earnings penalty** to any ticker with earnings in the next 45 days — high IVR driven by a known event is a trap, not an opportunity. **The penalty runs in two passes (v1.1.138).** Pass 1 applies it from the stored calendar. Then, before the Stage-4 pool is locked, the provisional top-`STAGE4_POOL_SIZE` candidates for those three strategies are **confirmed against E*Trade** — an independent source from the Finnhub-derived calendar — and pass 2 penalises anything newly revealed and re-sorts. Pass tracking is by `(strategy, ticker)` so nothing is double-penalised; outcome in `runMeta.earningsVerify` `{checked, updated, skipped, failed, newlyPenalised}`. This exists because the penalty is only as good as `earnings_calendar`, and a date wrong in the FAR direction silently disables it — the NVDA case (stored `2026-11-17`, true `2026-08-26`, ranked wheel #1 on its earnings day). `refreshTickers` trusts dates already inside the risk horizon, so this is typically ~20 calls (§17.2). A **per-strategy composite quality gate** (`minCompositeForStrategy()`) also applies: **bearish requires composite ≥70** before validation (all other strategies ungated). Full-year Brief Replay shows sub-70 bearish picks have ~0 SPY alpha and lose money, while ≥70 picks carry a real short edge (−3.3% alpha); the gate is rank-agnostic and surfaces zero bearish picks on weak days. (This replaces a short-lived SPY-regime gate that the full year disproved.)
4. **Strategy Lab** — for each surviving pick, build the concrete structure (§09): legs, strikes, expiry, credit/debit, POP, grade. Every constructible structure's liquidity measurement is also appended to `structure_liquidity_log` (migration 064, v1.1.93 — instrumentation for the after-close vs intraday liquidity artifact, NEW_FRONTIER §11; pure logging, never read on the live path, 120-day retention, failures swallowed).
5. **AI synthesis** — Claude (`claude-sonnet-4-6`, `max_tokens: 4096`) writes a 2-sentence rationale per pick from the structured signals (instructed never to invent figures). The response is parsed by `brief-rationale-parser.ts`, which salvages complete objects from a truncated array; `stop_reason: max_tokens` or a zero-parse is recorded in `runMeta.aiError` (v0.32.81). For final picks, a live Polygon quote overrides any stale EOD price, and an **earnings fill** fetches missing report dates from E*Trade for the final pick tickers (outcome in `runMeta.earningsFallback`, v0.32.82). **This is not a gate and never was** — it runs after pick selection, so it cannot remove a pick; it exists so the critic and the v2 entry gate see complete calendar data. The actual earnings gate for income/wheel/bearish is the two-pass Stage-3 verification above (v1.1.138), which runs before the pool is locked.
   - **5b. AI Critic** (see §14.3).
6. **Persist** — write one `daily_briefs` row per strategy (`picks` JSON), replacing any earlier same-ET-day run for that strategy (clean replacement, DST-safe ET date). `valid_until` = next trading day 9:30 ET.

After persist, **paper trades are auto-captured** for every post-gate pick (§15), and an **email + PDF** is sent.

## 14.2 Brief view

Per-strategy sections **ordered by the day's top composite score** (the strategy with the highest-scoring pick first; the fixed sequence wheel → bullish → bearish → income → buy → inflection breaks ties and trails strategies with no picks). Composite scores are strategy-specific, so this is a surfacing heuristic, not a cross-strategy quality ranking. The screen, HTML email, and PDF share this order. Each section is a list of pick cards showing: rank badge, ticker, color-coded score badge, the primary structure (`$240 · Jul 17 · $3.25 cr`), human-readable signal chips, italic AI rationale, the relevant Strategy-Lab grade (and best-fit if different), stock price + CSP capital requirement, the Critic verdict badge (expandable), and quick-nav buttons (📊 Payoff / ✓ Validate / 📋 Options / 🔍 Analysis / 🏦 E*Trade — the last opens `us.etrade.com/e/t/invest/quotesandresearch?content=3&sym={ticker}` in the system browser, same deep-link as the Opportunity screen, v0.32.88). A history bar shows past briefs with an accuracy chip (§15). A **⚡ Conviction Alerts** section at the top surfaces conviction-list stocks in Buy/Mid zones (§19).

The view offers **two tabs** (selection persisted to `localStorage`):

- **Grouped** — the per-strategy accordion described above.
- **Ranked Grid** — one flat, sortable row per pick across **all** strategies, for scanning the whole shortlist ranked top-to-bottom. Columns: Ticker · Price · **Conviction** · Strategy · Composite · Best Structure (links → Payoff Visualizer pre-loaded with the recommended structure's legs) · Expiry · Strike · Premium · Rating (lab grade) · Flag (critic verdict) · RSI · Actions (📊 Payoff / ✓ Validate / 📋 Options / 🔍 Analysis / 🏦 E*Trade icons — same deep-links as the card nav row). All columns sortable (nulls last); default sort is **Conviction** descending. RSI is populated only for strategies whose scoring config includes it (buy / bullish / bearish); other picks render `—`. The Best Structure cell stacks the structure link above the (compact) Defined-Risk-Alt and L2-Tradeable badges, when present, inside a `max-width`-bounded flex column (`.grid-structure-cell`, v1.1.122) so the badges wrap in place instead of overflowing into the Expiry/Strike/Premium columns.

**Conviction** is the one ranking comparable across strategies. Raw composite scores are strategy-specific (different signals/weights) and cannot be ranked head-to-head, so `Conviction = Strategy-Lab structure score (0–100, shared IV+direction+premium+liquidity rubric) − a critic penalty (pass 0 / caution 15 / flag 35 / not-vetted 25)`, floored at 0. It is a **quality / triage** ordering, **not** a backtested profit forecast (Brief-Replay found composites weak-to-anti-predictive cross-strategy; the system has no calibrated per-pick expected return), and is labelled as such in the column header. Composite remains a (non-comparable) reference column.

For **bullish** picks, both tabs also show a **defined-risk alternative** chip (`⚖ Defined-risk alt: Bull Put Spread …`) when the lab-scored `short-put-vertical` is constructible and has a strictly smaller max loss than the recommended structure (usually a Big Lizard, which the bullish bucket recommends but which carries a large tail). It links to the Payoff Visualizer pre-loaded with the spread's legs. This is **display-only** — it does not change which structure the brief recommends, the Conviction score, or what the engine trades (so it is not FR-SEY-5-gated; the engine-side grading change is held disabled behind `USE_POP_WEIGHTED_PREMIUM` pending a realized backtest — see `Requirements/v2-execution/06-seykota-risk-extensions.md`).

For **bullish** and **bearish** picks, both tabs also show a **Level-2-tradeable (debit) vertical** chip (`📈 L2-tradeable: Long Call Spread …` / `Long Put Spread …`). The recommended/credit structures (bull-put, big lizard, iron condor) require IBKR **options Level 3**; the chip surfaces a **long call spread** (bullish) or **long put spread** (bearish) that a **Level 2** account *can* place — so a small, defined-risk directional trade can be made (e.g. to build options history toward Level 3) instead of nothing. The vertical is narrowed at brief-generation time to a small max-risk budget ($750 default): the long leg is taken ATM and the short leg pulled in to the widest strike whose net debit stays within budget (`buildNarrowDebitVertical`, computed inside `StrategyLabService.validate()` from the same chain, stored on `StrategyLabValidateResult.level2DebitAlts`; accessor `level2DebitAlternative` in `src/shared/brief-ranking.ts`). The chip shows debit / max-risk / **breakeven + move-to-profit** — deliberately **not** a PoP, because the lab's short-strike `popEstimate` is credit-spread semantics and would badly overstate a debit spread's true odds. When even the narrowest spread exceeds the budget it is shown flagged (`exceededBudget`). It links to the Payoff Visualizer pre-loaded with the spread's legs. **Display-only / account-building context** — not the optimal structure at high IV (you're buying expensive premium), and it does not change what the brief recommends or the engine trades (no FR-SEY-5 impact). see `docs/formulas.md#level2-debit-vertical`.

A **Critic** segmented filter (**All / Pass + Caution / Pass only**) is honoured by **both** tabs. Pass filters exclude not-vetted picks (no critic verdict, or a degraded/rule-based fallback verdict); in the Grouped tab, strategies left with zero matching picks are hidden while a pass filter is active. Filter selection persists to `localStorage`. The shared ranking/filter logic lives in `src/shared/brief-ranking.ts`.

Exit plan per pick (in the PDF): target close at 50% credit, stop at 2× max loss, hold DTE.

## 14.3 AI Critic (Stage 5b)

`critic-service.ts` is an adversarial second opinion run after synthesis, before persist. For each pick it first runs **11 rule checks** — trend alignment, liquidity (chosen structure, score < 4), missing signals, score concentration, cross-strategy conflict, market regime (incl. bearish-vs-SPY-uptrend mirror), anomalous momentum, earnings-in-window (plus an info-severity `earnings_unknown` flag when an options pick's ticker has **no future earnings row at all** — missing calendar data is unverified risk, not safety; the LLM context carries an `earningsKnown` boolean with matching prompt guidance, v0.32.82), structure grade, counter-trend short-call strike (bearish structure whose rally-exposed **short call** sits at/below price on a bullish tape → warning; debit put verticals, whose short put correctly sits below spot, are excluded), and lab-price consistency (`stale_lab_price` warning when the lab underlying price deviates >5% from the live pick price — guards against stale chain Greeks) — then calls Claude (`claude-sonnet-4-6`) with an adversarial system prompt. All rule checks and the LLM context refer to the **same chosen structure**, resolved by the shared `pickRelevantStructure()` (`src/shared/strategy-structures.ts` — one map + one selector for the brief card, critic, email/PDF, and advocate; a divergent local selector would let the card and the critic feature different structures). It picks the best strategy-relevant valid structure with two safety/suitability preferences. **(1) Defined-risk over unbounded-risk** (`maxLoss === null` = naked short call / strangle / reverse lizard) — falling back to unbounded only when no capped-risk alternative is viable, so the brief never recommends unlimited-risk when a defined-risk option exists. **(2) For directional strategies (bullish/bearish/buy), a directional structure over a narrow-range "pin bet" butterfly** — but only when a directional alternative grades ≥ C, so a viable butterfly is kept rather than surfacing a badly-priced (D/F) directional structure. Net effect: income → iron fly/condor; bearish → put vertical / PMCP rather than reverse lizard or pin butterfly; no-op for wheel. **(3) Inflection is DIRECTION-LOCKED to the breakout side** (`relevantSlugsForPick`, v1.1.30): its two relevant verticals are direction-opposite (`short-put-vertical` = bull-put for an up breakout, `short-call-vertical` = bear-call for a down breakout) and both are always constructible, so the structure must follow the breakout direction, **never the higher grade** — the old grade rule surfaced a bearish bear-call on an up breakout (MCHP: bear-call A+ out-graded bull-put A+ by 1 pt). The breakout side is carried on `BriefPick.breakoutDirection` (from `technical_signals.breakout_state`, default `'up'` since down breakouts are off by default), so the card / critic / report / advocate all lock to the same direction-matched vertical, and the liquidity gate is direction-aware too. Matches how Brief Replay / Backtest `simulateSingleSpread` already select the spread. This shared map covers **all six strategies incl. inflection**; a strategy missing from it would make the critic silently structure-blind (the cause of a v1.1.23 inflection bug). The Stage-5 advocate is also given this structure (type, credit-vs-debit, legs) so its rationale matches the actual trade rather than one inferred from the strategy name. The critic's LLM context carries the **full leg list** (`structure.legs`, via the shared `formatStructureLegs` with leg quantities — so multi-leg structures like zebras/butterflies aren't misread from a single short strike) plus the realized-vol signal (`volatility.realizedVolPct`, the advocate's "recent volatility") labeled distinct from implied vol, so the critic doesn't flag a phantom IV discrepancy. The **expected 1-sigma move** is precomputed (`expectedOneSigmaMove` → `volatility.expectedMove1SigmaPct`/`expectedMove1SigmaUsd` = `impliedVolPct × √(dte/365)`, and × price for the dollar figure) and the prompt forbids the LLM from computing it — its manual arithmetic overstated the move 40–85% (AMD "±$149/29%" vs true ±$104/20.5%), the last numeric the prompt still asked the model to derive (v1.1.31). see `docs/formulas.md#expected-move`. Info-severity flags are advisory: the prompt instructs the LLM that a pick whose only flags are info can still merit `pass`. For **buy** picks where no relevant structure grades B or better (`shouldPresentAsStock`), the pick is presented as a plain stock purchase — the structure grade is excluded from the verdict and the view shows a `📈 Buy Shares` chip with the structure as optional. It returns a `CriticVerdict`: `pass | caution | flag` + rationale + `CriticFlag[]`.

The brief shows the verdict badge per pick and aggregate counts per strategy section; the email adds a Critic column + rationale sub-row. The same Critic is exposed to the external agent via the local API (`POST /critic/evaluate`, §22): the agent blocks entry on `flag`, warns on `caution`.

**Same-day earnings (v1.1.116).** The Stage-3 earnings penalty and the critic's `earnings-in-window` / `earningsKnown` checks used to compare `report_date` with a strict `>` against today's ET date, so a ticker reporting **today** (an `amc` after-close report, or an unknown-time row) silently read as "no earnings" — it could surface in the ~10:15 intraday brief with no `-20` penalty and no warning hours before it reported. Both now use the shared `isEarningsPending(reportDate, reportTime, todayET)` (`earnings-service.ts`): a same-day `bmo` (before-open) report has already happened and is excluded (falling back to "next earnings unverified" until the calendar refreshes); a same-day `amc` or unknown-time report is still pending and is penalized / flagged like any other in-window date.

**VIX freshness (v1.1.116).** `getMarketContext()` now ignores a `quote_cache` VIX row older than 24h (fetched-at check) rather than trusting it indefinitely — `refreshVixQuote` runs at the top of every brief (~18h between the two daily slots on a normal day), so anything older means the fetch has been failing (e.g. E*Trade auth) and the cached value no longer describes today's market. A stale VIX now reads as `null` (the pre-existing fail-safe for "never fetched"), rather than driving the wheel/income (>30) or bearish (<14) VIX rules off a days-old number.

**Wheel/buy trend-conflict key fix (v1.1.116).** `checkTrendAlignment`'s wheel and buy branches read a `trendStrength` signal key that exists only in the **bullish** config — wheel's config has `notDowntrend` and buy's has `trendAlignment` instead, so `pick.signals['trendStrength']` was always `undefined` and those two branches could never fire (silently dead since the multi-strategy signal keys diverged). Fixed to read each strategy's real trend signal (wheel → `notDowntrend`, buy → `trendAlignment`); bullish and bearish were unaffected. Income's `trendNeutral` branch remains a documented no-op — it reads `trendStrengthAdx`, which is permanently `null` while ADX is excluded from scoring (§13, validated on full-year replay); no live substitute exists without re-validating ADX.

**Score-concentration share fix (v1.1.117).** `checkScoreConcentration`'s "single-factor thesis" info flag compared an absolute points value (`topContrib`, bounded by that signal's own weight — max ~30 across every baseline config) against a raw `50`, so the comparison was structurally unreachable and this check had never fired since it was written. Fixed to compare the signal's actual **share of the composite** (`topContrib / compositeScore`) against the 50% threshold the description already implied. Info-severity, non-gating (the engine accepts both `pass` and `caution` verdicts) — no change to which trades are scored, ranked, or selected.

**What the reviewer is allowed to see (v1.1.189).** Two defects, both pointing the same way: the adversarial reviewer was handed a filtered-favourable view of the pick it was meant to attack.

1. **The signal list selected for good news.** `topSignals` sorted descending on `weight × normalized` and took 4 — a sort on CONTRIBUTION, so a signal scoring badly has a small product and is pushed out by the arithmetic. Measured over **948 stored picks**: the worst-scoring signal reached the critic on **8.3%**, and a reading below 35/100 on **2.8%** (18 of 653). **24% of wheel picks were passed clean, with no warning flag, while carrying a sub-35 reading the reviewer never saw.** On the DINO pick that surfaced this, `technicalNeutral` at 30.6/100 — the app's own "this is extended" read — was 7th of 7 by contribution and never arrived, while `notDowntrend` at 100 did. `selectCriticSignals()` now appends the pick's **weakest** reading when the contribution sort excluded it, MARKED `isWeakestReading` so the model can tell "the worst thing measured about this pick" from "one of the things that drove the score".
2. **The one measured ownership read was computed after the verdict.** `own-at-strike` runs in `roll-the-dice.ts`, downstream of the critic, so the reviewer had never seen it in any form. On **82 critic-PASSED wheel picks, 57 (70%)** had a cost basis above the ticker's own 200-day average and 37 were more than 10% above — DELL at **+97.9%**, AMD at **+79.2%**. `ownership` is now in the context (wheel only — the evidence behind it is a short-put study), carrying both axes and reading `null` as unknown, never as satisfactory.

The list remains a **sample**, deliberately: three of the signals full disclosure would surface for wheel (`technicalNeutral`, `recentVolatility`, `notDowntrend`) were measured flat, mildly inverted and anti-predictive (T6, v1.1.178), so handing over every reading would invite confident cautions built on signals already shown not to predict. One guaranteed sight of the worst reading is the smallest change that removes the bias. **The prompt says nothing new about TREND** — that is T7, still open, and `docs/wheel-parameters.md` records why a tweak there is not justified on current evidence.

**MEASURED, AND BOTH HALVES DEFAULT OFF (v1.1.190).** The verdict is a hard gate, so this changes which trades are taken (FR-SEY-5). An outcome replay is not constructible — the intersection of "verdict flipped" with "expiry has settled" across one regime is a handful of trades — so `tests/critic-context-ab.test.ts` measures the **blast radius**. On 20 wheel picks, 2026-09-04:

| | pass | caution | flag |
|---|---|---|---|
| before | **8** | 10 | 2 |
| after | **0** | 19 | 1 |

**40% stricter, and not one `pass` survives. The dice rejects anything that is not `pass`, so shipping this enabled would have produced zero picks.**

**The cause is the ownership half, and the flipped rationales say so themselves** — all 8 cite the cost basis against SMA200, none cites a weak signal, and the model cautioned on **AAPL at 4.5% above** its 200-day. The fact was true; what was missing was its **base rate**. A basis above SMA200 is the *normal* case (70% of 82 critic-passed wheel picks), and the above-SMA200-but-below-the-20-day-low cell is the **best performing of the four** (+3.46% mean / +5.49% median). FR-BRIEF-DICE-12 had just removed exactly this error from the operator-facing sentence; handing the raw fact to a model reintroduced it. **General rule, recorded in CLAUDE.md: giving a model a measured fact is not the same as giving it the fact's base rate, and without the base rate a common property reads as an alarm.**

Flags are `CRITIC_CONTEXT_SIGNALS` and `CRITIC_CONTEXT_OWNERSHIP`, **both default false**, split because the halves behave differently. The **signals half is unmeasured alone** — off not because it was shown harmful but because the only A/B available bundled it with a half that was. Re-opening it means giving the model the base rate and the four-cell outcome table rather than the bare fact, then re-running the A/B. The harness lives in `tests/` rather than `scripts/` because a `.mjs` script cannot resolve `@shared/*` path aliases and therefore cannot exercise the real prompt — it would test a reimplementation of the thing under test.

**Reviewed, no change needed (v1.1.118 audit):**
- **Unvalidated-pick gate asymmetry is intentional, not a bug.** `hasAdequateLiquidity()` returns `true` when the Strategy Lab call itself failed (`labResult === null` — "can't gate what we didn't measure") but `false` when it succeeded and found no valid structure — these look asymmetric in isolation, but the two consumers correctly diverge from there: the **human-facing brief** shows the unvalidated pick (`validated: false`) with the critic's `low_liquidity` info flag ("not validated against a live options chain"), so a person reading the brief is clearly told to check it themselves; the **v2 execution engine**'s `chosenScore()` (`brief-entry-source.ts`) returns `null` for any pick with no `strategyLabResult` at all (there is no structure to build), so `briefPickToPickInput` excludes it before the engine ever considers it — the engine never trades an unvalidated pick regardless of the gate's `hasAdequateLiquidity` value. The two layers are consistent; only the naming made them look contradictory.
- **The "double penalty" for thin-`iv_history` names is deliberately conservative, not double-counted.** A missing top-2-weight signal (e.g. wheel/income `ivRank`) both deflates the composite (its weight still counts in the denominator, contributing 0 — FR-SE-03) and raises the critic's `critical_signal_missing` **warning** flag. In the normal path (LLM available), that warning is one input among several to the LLM's qualitative verdict — the system prompt explicitly tells it not to default to `caution` — so it does not automatically reject a pick. It only forces a hard `flag` (→ engine rejection via `criticDegraded`) when the **critic itself degrades** (the LLM call fails, e.g. an Anthropic outage) — at that point the rule-only fallback verdict is `hasWarning ? 'flag' : ...`, which is the intentionally conservative choice: don't trade blind on both incomplete data AND a skipped adversarial review in the same cycle.

## 14.4 Email & PDF

After the job, `email-service.ts` sends an HTML email (trade-ready tables: ticker — hyperlinked to the ticker's E*Trade quote page, v0.32.88 — / grade / structure / strike / expiry / DTE / credit / ann. return / POP / max loss per strategy, plus the Lab Score and Critic columns) with a full PDF attachment (`brief-report-builder.ts`, pdfkit — all picks, AI rationale, signal breakdown, exit plan). Email uses the configured SMTP settings; email failure does not fail the job. `resendBriefEmail()` re-sends the latest.

## 14.5 Cross-pollination with the learning loop

- Pattern recommendations: when a gap cause recurs ≥3× for a strategy, a recommendation is written (§15) and surfaced.
- Signal-weight suggestions come from paper-trade outcome correlations (§13.5).

## Wheel Shortlist (v1.1.242)

Interim, advisory answer to "the best wheel trades today" — design `NewApp/requirements/07-opportunity-engine.md` §3; formulas `docs/formulas.md#wheel-shortlist`. **Operator profile (2026-09-12):** short put at **0.35–0.45Δ**, **14–30 DTE**; objective premium return on capital while avoiding assignment; top 5; no capital cap; after both brief runs.

- **Pool:** the latest run's `brief_candidates` for `wheel` + `income` with disposition `picked`/`capped_out`, deduped. The composite rank is ignored (top end anti-predictive, v1.1.173).
- **Exclusions:** critic `flag`; earnings unknown, stale, or on/before every in-window expiry (fail closed, as Roll the Dice); no two-sided put in the delta band. Each exclusion is reported with its reason.
- **Contract & ranking:** live E\*Trade chains for expiries before the next report; the put with the highest `mid ÷ strike × 365 ÷ DTE`; top 5 by that value.
- **Annotations:** assignment probability ≈ |Δ|, credit and bid, cash required, spread %, OI, earnings date, critic verdict, own-at-strike, and **roll room** — the operator's roll rule (ITM with ≤ 7 days left → next 14–30 DTE expiry, same/lower strike, net credit; else close) evaluated at today's prices.
- **Surfaces:** `🎯 Wheel Shortlist` button + panel on the Daily Brief (`scoring:wheel-shortlist`), `✉ Email it` (`scoring:email-wheel-shortlist`), and an email after every brief run through `sendShortlistEmail` — the same logged compute/build/send path as the dice email (`brief-emails.ts`), outcome in `logs/errors` as `shortlist-email:*`.
- **Not validated on this profile** and never an engine input. Acceptance: `tests/wheel-shortlist.test.ts`.

## Spread chain capture (v1.1.243)

The last step of every brief run, independent of email: `captureSpreadChains` records the put-side
chains a bull put spread would use into `spread_chain_capture` (§2) — entry chains for the run's
validated wheel/income/bullish candidates at 14–45 DTE, and daily re-quotes of any series entered in
the prior 21 days until expiry, plus every series a spread-mode pick opened, until it expires (v1.1.290). Data collection only; a failure is logged (`spread-capture:run`) and
never fails the brief. Acceptance: `tests/spread-chain-capture.test.ts`.

## Bull put spread mode (v1.1.244) — shadow

Design `NewApp/requirements/08-bull-put-spread-mode.md`; formulas `docs/formulas.md#bull-put-spread-mode`.
Runs immediately after spread chain capture, from that run's captured chains (no E\*Trade calls).

- **Pool:** the latest run's `brief_candidates` for `wheel` with disposition `picked`/`capped_out`.
- **Construction:** expiry 21–35 DTE nearest 30, strictly before the next report; short put two-sided,
  |Δ| 0.25–0.35 nearest 0.30; long put two-sided, strike nearest `short − 5% × spot`, width 5–7.5% of spot.
- **Costs:** legs fill by `options-fill.ts`; excluded if round-trip cost > 25% of mid credit or net credit ≤ $0.05.
- **Gates (reason stored):** critic `flag`; earnings unknown / stale / on or before every in-window expiry;
  no chain, expiry, underlying price, short or long; cost; one contract's max loss > `bullPutSpreadMaxLossPerPosition`.
- **Size and rank:** contracts = floor(budget ÷ max loss per contract); rank by net credit ÷ max loss
  (unvalidated), top 5; the rest recorded as "ranked below the top 5".
- **Switch:** `bullPutSpreadMode` = `shadow` (default: store only) | `off`. The `on` panel and email are built
  when 08 §4's enable gate passes. Stored in `spread_mode_picks` (§2); logged `spread-mode:run`; never fails the brief.
- **Shadow settlement (v1.1.290):** `GET /api/v1/diagnostics/spread-shadow` (`spread-mode-settle.ts`) settles every pick
  forward on its own captured quotes: the 50% target (decided on mid, realised with fills), or intrinsic at the
  expiry close. Picks of a ticker within 14 days of its kept entry are one position (v1.1.291). It reports
  progress against 08 §4, with each rejection reason's tickers and, for a missing leg, the cause read from the stored chain.
  `node scripts/spread-shadow-report.mjs` prints it. Chain capture tracks every picked series until expiry.
- Acceptance: `tests/spread-mode.test.ts`, `tests/spread-mode-settle.test.ts`.

## Roll the Dice (v1.1.162)

A button on the Daily Brief that reduces the brief to **one** wheel entry the operator can act on
without reading it — or to an explicit nothing. Pure filter over the stored brief: no scoring
change, no provider call, nothing written.

**FR-BRIEF-DICE-1** — Returns at most one pick, the highest `compositeScore` among those passing
every **trade-quality** gate in `docs/formulas.md#roll-the-dice`. Since v1.1.168 no gate may
consider the operator's situation — see FR-BRIEF-DICE-8.

**FR-BRIEF-DICE-2** — MUST be able to return nothing. A feature that always produces a pick would
have to lower its bar on a bad day, which is when the bar matters. "No dice today" is a
first-class result carrying the count considered and the most common rejection reason.

**FR-BRIEF-DICE-3** — Every rejection is reported with its ticker and reason, so the bar is
visible rather than claimed.

**FR-BRIEF-DICE-4** — A `degraded` critic verdict is rejected. `verdict: 'pass'` with
`degraded: true` means the LLM critic never ran and the verdict is the rule-based fallback; the
v2 entry gate already treats this fail-closed and so does this. Without it, an Anthropic outage
would widen the funnel on exactly the day nothing adversarial reviewed the pick.

**FR-BRIEF-DICE-5** — Earnings are a hard exclusion, and both an *absent* and a *past* stored
date fail closed. See the formula note.

**FR-BRIEF-DICE-6** — A brief older than one day is surfaced with a staleness warning; the pick
is shown, not suppressed (a Saturday review of Friday's brief is legitimate).

### Validation

Retrospective over 62 stored wheel briefs (2026-06-04 … 2026-09-01), 248 picks: a pick on
**23 of 62 days (37%)** at the original share-price ceiling; 26 of 62 (42%) once the gate moved to
capital committed (v1.1.164); **34 of 62 (55%)** once operator fit stopped gating at all
(v1.1.168 — see FR-BRIEF-DICE-9). Rejections under the original rules: critic verdict 172,
price ceiling 27, liquidity 24, 25 passed. The critic verdict has always rejected by far the most,
and still does — it is the only remaining lever on the hit rate, and loosening it would defeat
the premise.

**The earnings gate cannot be validated retrospectively.** `earnings_calendar` holds one row per
ticker with no history, so a replay sees today's next-report date, not the one that was live on
the brief date. The replay accordingly shows zero earnings rejections *and still selects NVDA on
2026-08-26 — its actual earnings day*. That is the failure this feature exists to prevent, and
it is invisible to the only test available. The gate is correct by construction on live data;
the replay simply cannot see it.

**FR-BRIEF-DICE-7 (v1.1.163)** — The dice is delivered by email as a single card, not a grid.

- The subject MUST carry the trade itself (ticker, strike, expiry, credit) so it is actionable
  from a notification without opening the message.
- The body MUST lead with the order to place, then credit / capital / **cost basis if assigned
  and its discount to spot**, then the downside stated in plain language with real numbers.
- The gates passed MUST be spelled out, and rejections listed.
- A no-pick day MUST still send. Silence cannot be distinguished from a failed job or a broken
  SMTP config, which defeats the purpose of not having to check.
- Sent from within `DailyIntelligenceBriefJob` after its own email — not a separate batch job.
  It is a pure filter over the brief just persisted, so inline ordering is guaranteed and no
  `sequence_order` row is added (that column is seeded only on fresh installs; see §20.5).
  Failure is caught and logged and can never fail the batch.
- The in-app **✉ Email it** button, `scoring:email-roll-the-dice`, and the nightly send MUST all
  resolve the pick through `computeRollTheDice(db)`, so they cannot disagree.

**FR-BRIEF-DICE-8 (v1.1.164, superseded by FR-BRIEF-DICE-9)** — Sizing is measured as CAPITAL
COMMITTED (`strike × 100 × qty`), not share price. Share price remains required only for the
cost-basis maths. The exception tier this requirement originally defined (conviction list AND
`strike ≤ price_high` AND composite ≥ 70 AND liquidity ≥ 11 AND capital ≤ $50,000) is **removed**
in v1.1.168; it existed solely to let good trades escape the capital gate, and that gate is gone.

**FR-BRIEF-DICE-9 (v1.1.168)** — The gates MUST judge the trade, never the operator.

- Gates are of exactly two kinds and only the first may exclude:
  - **Trade quality** — facts about the setup: critic `pass` and non-`degraded`, a constructible
    and liquid CSP, no earnings inside the hold window, a real net credit. These stay HARD.
  - **Operator fit** — facts about the operator: capital committed vs their normal size, and
    conviction-list membership. These MUST be computed and reported, and MUST NOT remove a
    candidate from consideration.
- Rationale: an operator's stated size and their conviction list are not evidence about a trade.
  Both were found miscalibrated in live use — on 2026-09-03 MPC was refused at $37,000 purely for
  being absent from a list the operator no longer actively maintains, its composite never
  evaluated. A filter that deletes a setup before the operator sees it does not inform their
  funding decision, it replaces it.
- `maxCapital` ($30,000 default, configurable) becomes a **reporting split**, not a ceiling. When
  the merit pick exceeds it the result MUST also carry `withinBudget`: the highest-scoring
  eligible candidate that does fit, so demoting the gate never leaves a day with nothing fundable.
  `withinBudget` MUST be null when the pick already fits or when nothing eligible fits.
- Every surface MUST state the size before the order when the pick is over the line, carrying the
  amount and the operator's own limit — and MUST NOT frame it as an exception granted or a
  rejection avoided. It is a fact handed over for a decision.
- Conviction MUST be reported in four distinguishable states: not listed / listed with no
  never-above band / strike inside the band / strike ABOVE the band. The last MUST be surfaced
  loudly. `price_high` is used rather than `price_low`/`price_mid` because stored rows are not
  reliably ordered (3 of 13 sat inverted before migration 075); only the never-above line is
  unambiguous.
- `criticVerdict.confidence` MUST NOT be used as a criterion — measured `high` on 40 of 41
  eligible picks, it discriminates nothing and would only simulate rigour.
- **Accepted trade-off, recorded deliberately:** nothing now enforces the operator's own
  own-at-strike rule, and the feature's promise shifts from "act unread" to "here is the best
  wheel entry, check you can fund it". The conviction sentence is the only place that question is
  still asked, and a badge is not a band.

**FR-BRIEF-DICE-10 (v1.1.169)** — Own-at-strike is answered from the stock's own price history,
not from a curated list.

- The result MUST carry `fit.ownership`: the effective cost basis (`strike − premium`) against the
  ticker's point-in-time 200-day average and 52-week range. See `docs/formulas.md#own-at-strike`.
- It MUST be reported, MUST NOT gate. The evidence is a 17.4-point per-episode separation that
  survived regime-adjustment, episode de-duplication and leave-one-out — but rests on 12 accept
  episodes inside a single ~4-week window, which under FR-SEY-5 is not enough to change which
  trades are taken.
- Missing history (< 200 sessions) MUST read as "not enough history", never as a pass.

**FR-BRIEF-DICE-12 (v1.1.188)** — The ownership read carries TWO axes, and the second one made the
first quieter.

- `fit.ownership` MUST also carry the **strike** against `swingLow20`, the lowest low of the last
  20 sessions. Note the asymmetry, which is deliberate: the long-run axis tests the **cost basis**,
  the support axis tests the **STRIKE**. Both were measured that way and the code MUST match the
  study, not be tidied into symmetry.
- The two are reported in ONE sentence whose connective states the relationship — **and** when they
  agree, **but** when they conflict — rather than as two stacked lines.
- **"An extended price…" MUST fire only when BOTH axes agree.** Before this it fired on every basis
  above SMA200: 166 of 250 stored brief picks (66%), which includes the support-only cell that
  measured **+3.46% mean / +5.49% median, the best of the four**. It now fires on 52%. The change
  is therefore a WITHDRAWAL of an existing caution from the picks the data says were fine, not a
  new warning — a line firing on two thirds of picks was already near-wallpaper. The in-app panel's
  warning styling MUST use the same condition as the sentence.
- **An unknown support axis (fewer than 20 bars) MUST fall back to the exact previous sentence,
  clause included.** An axis that could not be measured must never be the reason a caution
  disappears — same fail-closed reasoning as the absent earnings row.
- Evidence: `scripts/fr-wheel-entry-quality-study.mjs` (4,917 settled rows / 45 dates) and
  `scripts/dice-entry-annotation-replay.mjs` (250 brief picks, 186 settled; cell shares 18/16/14/52%
  — so it fires on half the picks, unlike the conviction band's 0 of 39). Both axes survive
  controlling for raw distance. **Still an annotation: it MUST NOT gate.**
- The sentence is defined ONCE, in `src/shared/own-at-strike.ts`, and imported by the email, the
  panel and the preload type. It MUST NOT be re-declared per surface — the panel carried a
  hand-copied duplicate until v1.1.188, the same trap as the strategy slug map (v1.1.23/25).
- The read MUST lead the ownership question in every surface, with the conviction band demoted to
  secondary context: the band is satisfied by construction on essentially every pick (0 breaches
  in 39 measured) and would otherwise read as an all-clear it did not earn.
- Fundamentals MUST NOT be used for this. `fundamentals_cache` keeps one row per ticker with no
  history, so any fundamental signal is unreplayable and cannot satisfy FR-SEY-5.

**FR-BRIEF-DICE-11 (v1.1.183)** — The dice email MUST link the pick to E*Trade, on both pages.

- The ticker in the order headline links to the **snapshot quote** page, and a link row beneath it
  carries **quote** and **option chain** explicitly. The alternative `withinBudget` card carries
  the same pair.
- Both are given because they answer different questions: the quote page is "what is it doing
  right now", the chain is "what is this strike actually bid". Neither substitutes for the other
  at the moment an order is entered.
- Both MUST resolve **without a logged-in session**, because an emailed link is clicked cold. That
  rules out the logged-in quote page `/etx/mkt/quotes?symbol=X#/snapshot`, whose login redirect
  double-encodes the query and lands on "We couldn't find the symbol 'NULL'" (v1.1.184). The
  public `/e/t/invest/quotesandresearch` page is used for both: no `content` param is the Snapshot
  tab, `content=3` the option chain.
- The URLs are built by `src/main/services/etrade-links.ts` and MUST NOT be re-typed at call sites
  — the options URL's `&` must be escaped inside an HTML attribute, and the logged-in-URL trap
  above is not visible from a call site pasting a string. The brief and filters-prefill reports
  build their existing chain links through the same helper.

#### Validation of the demotion (FR-SEY-5)

`scripts/dice-fit-demotion-study.mjs` replays all 62 stored wheel briefs under both rule sets with
identical trade-quality gates, so the delta is attributable solely to the demotion:

| | fit gated (old) | fit reported (new) |
|---|---|---|
| days with a pick | 26 (41.9%) | **34 (54.8%)** |
| median composite of the winner | 65.9 | 65.9 |

The median is the sanity check: removing a non-merit filter can only raise the winner's merit,
never lower it, so a drop would have meant a bug. Of the 34 pick-days, 12 exceed $30,000 and only
3 of those have a within-budget alternative to offer — on the other 9 the operator sees one
unfundable pick and nothing else, which is still strictly more than the old rules gave them.
17 picks are not on the conviction list; 0 breach a never-above band. The replay's earnings gate
remains invalid retrospectively (see FR-BRIEF-DICE-5 note) but is applied identically to both
arms, so it cancels out of the comparison.
