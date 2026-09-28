# 03 — Quality gate and exception workflow

> **Status:** draft v1, 2026-09-05. Implements P8 (gate before use), P9 (silence is not a signal), P10 (a check is unverified until shown able to fire), P12 (deterministic, additive remediation only) from `01-purpose-and-principles.md`; sourced from Q9 and Q18 in `00-discovery-qa.md`. Tables use the `qa_` prefix defined in 02 §0.4 and follow 02 §0 conventions.
> **Acceptance criteria owned here:** AC-8, AC-9, AC-10, AC-12.

---

## 1. What the gate is

The gate is the part of the collector that decides, after every run, **whether what was just stored may be trusted**. It is not a report someone reads later. It runs inside the collector, on the same run, before the run is marked complete, and its verdict is the only way a day's data becomes usable to anything downstream.

Three outputs per run:

1. A **quality report** (`qa_quality_report`): one row per run, with per-check results.
2. Zero or more **exceptions** (`qa_exception`): one per distinct finding, carrying a severity and a resolution state.
3. A **usability verdict per domain per trading day** (`qa_domain_day_status`), derived from the open exceptions. Downstream readers consult this table and nothing else.

Then it sends the **status email** (§7), whether or not anything was found.

### 1.1 Design rules

- **Checks are code with identity.** Every check is a registered object with a stable id (`QC-…`), a domain, a default severity, a human description, and the tables it reads. The registry is generated into `qa_check_registry` at startup so the inspector can list every check, its fire history and its last change (P10).
- **A check may only read.** Checks never write to `raw_`/`ref_` tables. Remediation is a separate, enumerated step (§6).
- **A finding is a fact about the data, not about the run.** If the same condition is still true tomorrow, it is the *same* exception (same fingerprint), not a new one. This is what lets an exception persist across runs and be escalated (§5.4).
- **A failing check never deletes.** The worst a check can do is mark a domain-day unusable (P8, P12).
- **Every check records the distribution of what it measured, not merely whether it fired.** Evaluated-count and fired-count identify a check that never fires (P10, AC-10), but they cannot tell you whether its threshold is in the right place: a check that fires zero times looks identical whether the boundary sits in an empty gap or a mile past every real value. So each check that compares a magnitude also stores that magnitude's distribution over every evaluation (`qa_check_result.distribution_json`), and the keys carrying the largest values, fired or not. **This is P10 taken literally** — "the distribution of the tested quantity relative to the threshold is measured on real data and recorded" — and it is what makes §8's threshold-setting possible. Recording only fires would reproduce the conviction-band failure at the level of the gate itself: a boundary nobody can see the distance to.

---

## 2. Severity and the usability verdict

| Severity | Effect on the domain-day | Email placement | Typical cause |
|---|---|---|---|
| `blocking` | `unusable` until every blocking exception on that domain-day is `resolved` or `accepted` | first section, always | missing data, wrong data, a provider cap hit, a discontinuity with no explaining action |
| `warning` | `usable_with_warnings`; flagged in the inspector | second section | cross-source drift inside tolerance bands, a fallback source used, late filer |
| `info` | no effect | count only | a sticky contract expired and left the set, a capture-rule version changed |

`qa_domain_day_status.status ∈ { usable, usable_with_warnings, unusable, not_run }`. `not_run` is set for every (domain, trading day) the calendar expected but no run covered, and is itself surfaced by the watchdog (§7.3).

**There is no stored per-run usability flag.** `meta_run.gate_verdict` records what the gate concluded *when the run finished* and is never rewritten — it is history. Usability is a live property of the data, recomputed on every exception state change, and lives in `qa_domain_day_status` alone. A duplicated `meta_run.usable` would be correct for exactly one day and then drift silently every time an exception was resolved, which is the same denormalisation trap that let a stale earnings date suppress its own corrections.

Severity is a property of the **check**, with two adjustments: escalation (§5.4) can raise it one level; a check definition may declare a **threshold that promotes** it (e.g. a cross-source drift is `warning` per ticker but `blocking` when it affects > 2 % of tickers on the day).

---

## 3. Check catalogue

Each check: id, severity, condition that fires it, and the remediation it is allowed to request (from the §6 list) or `none`. All thresholds are stored on the check registry row, never hard-coded. Two marks distinguish where a value came from:

- **†** — a **working value**, not yet measured. Set from the pilot's recorded distributions (§8, QC-955).
- **Built at B4, a third basis the draft did not have: `structural`.** Four checks measure a magnitude against a threshold of **zero by definition** — "any crossed quote at all is a finding", "any non-final bar at run end is a finding". That is not a number anyone chose, so marking it † would park it in the pilot's threshold-review queue forever, and marking it ‡ would claim evidence that does not exist. The check registry now records `measured | working | structural | not_applicable`, and a magnitude check that fails to say which is a build failure.
- **‡** — **already measured**, on the existing application's data. These are not guesses and re-opening them needs new evidence, not a fresh opinion:

| threshold | measured on | separation observed |
|---|---|---|
| QC-204 · 40 % daily move | 153 discontinuities across 126 tickers (2026-08-28) | unadjusted splits at −74 % (CRWD 4:1), +203 % (DD), +177 % (MRNA) against SPY's largest genuine daily move of 2.58 % — 40 % sits in a wide empty gap |
| QC-205 · 15× volume regime | the same episode set | ticker reuse at 76× (BNY) and 53,592× (SPCX) against genuine violent moves at ≤ 5× (MRNA 5.0×) — two orders of magnitude apart |
| QC-205 · **measured again on gen-002, 2026-09-17** | 109 evaluations, the pilot's own population | the two-order gap does **not** reproduce: values run 1.1, 1.9, 6.8, 7.0, 8.3, 15.3, 15.3, 15.3, 19.6, 37, 52, 96, 104, 125, 332, 404, 468 — a continuum with the threshold sitting on exactly **p90**, so it fires on the top decile by construction rather than on a gap. Of its 12 firings only 2 (JAN) are reuse by the listing evidence; the rest are transformative events on continuing listings (GME's May 2024 squeeze at 15.3× on 4.9M shares/day, SMMT 52×, BMNR 571×). A prior-liquidity floor was tested as a fix and REJECTED: at 10k it suppresses both true positives, at 100k it removes only 4 of the 10 false ones. Threshold left in force pending the pilot's distribution review (§10) |
| QC-210 · 0 bars before `list_date` | structural, with a base rate | 11 of 1,082 tickers with a `list_date` (1.0 %) hold bars before it, and **every gap exceeds 365 days** — none in the 1-5 or 6-90 day bands, so there is no borderline population a grace period would protect. The error is one-directional: a `list_date` that is too EARLY causes a miss, and only one too late could indict good history |
| QC-601 · 14-day later-slip | the NVDA earnings-date incident (v1.1.136) | a provider coverage gap moved the date ~90 days; an issuer refining its own date moves it by a few. 14 days separates them with room on both sides |
| QC-901 · VIX ∈ [5, 150] | the existing brief job's sane-range guard | VIX has never closed outside this band. The symbol is now **confirmed** (`VIX`, 2026-09-07), so the check's job changes from covering an unknown to catching a *future* symbol change — which it still does, by turning it into an `invalid` rather than a plausible wrong number |
| QC-410 · spot disagreement **1 %** (v1.1.252) | `qc410-study.mjs`, 2026-09-15 and 2026-09-16, ~500 tickers each | Per ticker, the share of contracts whose delta missed Black-Scholes by > 0.05, by \|delta-implied spot − close\|: < 0.1 % 0.9–1.5 %, 0.1–0.25 % 1.3–2.8 %, 0.25–0.5 % 3.5–4.9 %, 0.5–1 % 11.7–19.7 %, 1–3 % 39–48 %, > 3 % 86–94 %. Parity spot vs close: median −0.03 % / −0.07 %. The 0.05 contract tolerance below stays the model-difference bound it was measured as |
| QC-410 · delta tolerance **0.05** | one live SPY chain, 2026-09-07, 12 strikes within $40 of spot | E*Trade's delta sits **0.018–0.029 below** a European Black-Scholes across the sample, monotonically in moneyness — largest at the money, near zero deep in. Adding SPY's ~1.15 % dividend yield halves the gap (worst 0.0287 → 0.0179) but does not close it, and the residual's shape says *model*, not error: SPY options are American and E*Trade does not publish its pricer. **So the tolerance is 0.05** — far above a model difference, far below anything a unit or scale fault could produce, since those are off by 100× or sign-flipped. **What QC-410 verifies is that the Greeks are on the scale the dictionary claims, not that they match our model**; trying to reproduce a vendor's American pricer to three decimals is a different and much harder goal, and not what P4 asks for |

A ‡ value still gets its distribution recorded like any other (§4) — measured once is not measured forever, and the pilot's own data either confirms it or is the new evidence.

### 3.1 Cross-cutting checks (run on every table the run wrote)

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-001 provenance | blocking | any raw row has null `source_response_id`, or its `meta_response` row is missing / `parse_status = failed`. **Parsed layers only** (`raw`, `ext`, `legacy`): a `derived_` row's `source_response_id` is null by definition (02 §0.2), and reading it fired QC-001 on every day the derive phase wrote (fixed core 0.6.1) | none |
| QC-002 archive integrity | blocking | sampled archive lines (≥ 50 per run + every account-domain line) fail `sha256` match or fail to decompress/decrypt | none |
| QC-003 dictionary conformance | blocking | a column exists in the DB that is not in `meta_dictionary`, or vice versa; a column's declared type/enum set is violated | none |
| QC-004 null discipline | blocking | a non-nullable column is null; a nullable column is null with a status column that is not one of the standard values; a value column is non-null while its status ≠ `ok` | none |
| QC-005 mutation guard | blocking | the raw-table `UPDATE`/`DELETE` triggers logged any attempt this run (AC-2) | none |
| QC-006 run completeness | blocking | the run did not reach every domain its capture rules scheduled (e.g. crashed after bars, before chains) | R1 retry the missing domains |
| QC-007 capture-rule reference | blocking | a snapshot row references a `capture_rule_id` not in force on `as_of_date` (P6) | none |
| QC-008 provider cap | blocking | any `meta_response.at_provider_cap = 1` that was **not** followed by a subdivided sweep covering the same window — for a `from`/`to` window, uncapped responses to the same endpoint in the same run that cover every day of it (implemented v1.1.252; before that every capped parent fired, 3 blocking findings on 2026-09-16 for a sweep that had subdivided correctly). The flag means *truncated for the window being stored*: EDGAR submissions drop the OLDEST filings, so a full `recent` list is flagged only when its oldest kept filing is on or after the phase's `since` (core 0.6.1 — flagging every full list fired on 16 of 20 filers daily). **v1.1.275:** EDGAR's `recent` holds *at least one year* of filings (JPM: 26,192), and the filings sweep's `since` was the 400-day facts lookback — so every filer with 1,000+ filings a year read as capped for the 35 days past EDGAR's year (iShares Trust, JEF, JPM). The sweep now asks for 360 days (`FILINGS_LOOKBACK_DAYS`), skips funds (no 10-K/10-Q) and fetches each CIK once; all three archived responses then read complete, and a genuinely short `recent` still fires. **v1.1.283:** open findings from earlier runs are re-judged with what the database holds. A capped window its own run re-covered day by day closes `rule_changed`, and so does a submissions response for a ticker whose reference is a fund. A stock's submissions finding stayed open, because completeness depends on the oldest date in the archived body, which a check cannot read. **v1.1.333: it closes `rule_changed` once the same CIK has been asked again later and that answer was not at the cap.** The pipeline stores only `FILINGS_LOOKBACK_DAYS` of filings, and an uncapped later answer holds all of them. JEF and JPM were capped on 2026-09-15 under the old 400-day window and re-asked uncapped on 09-24 under the 360-day one, with nothing new to store. Both were open and blocking until then, and both closed on rehearsal. A stock never asked again stays open | R4 subdivide |
| QC-009 duplicate natural key within a response | warning | the same natural key stored twice from one `source_response_id` (idempotence bug), keys read from the **current** dictionary version only. Two different responses in one run returning a key is not a bug: a capped Finnhub window and its halves store the same rows by design (330 + 322 on 2026-09-16). Until v1.1.253 it grouped per run and read every stored dictionary version, so a fixed key kept firing on its superseded definition. **v1.1.284:** an open finding on a table evaluated clean today is re-judged. If the table's natural key at the dictionary version of the run that last fired it (`meta_run.dictionary_version`, `meta_dictionary`) is not today's key, it closes `rule_changed`, naming both keys. Otherwise today's per-response rule is re-counted over the runs it was seen in: none → `rule_changed`; any → it stays (a provider sending one period twice in one response is what the check is for) | none |

### 3.2 Universe, reference, calendar

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-101 universe drift | warning → blocking if > 5 % † | current membership changed by more than N tickers since yesterday without an `index_add/drop` reason | none (operator confirms rebalance) — **note: this is expected to fire annually.** The existing app's `constituents.added_at` shows a 60-ticker addition on 2026-07-22 (**5.5 % of 1,089**) and 25 more on 07-27, i.e. the Russell reconstitution period. Removals are not tracked in the old schema, so true drift then is likely higher still. A pilot run spanning late June–July will meet this legitimately; the operator confirms and it resolves |
| QC-102 reference staleness | warning | a current member has no `raw_ticker_reference` row within 45 days | R2 re-fetch ticker |
| QC-103 sector mapping gap | warning | a CS ticker has `sic_code` but `sector` null (mapping table incomplete) | none |
| QC-104 optionability contradiction | warning | `optionable = 1` yet the expirations call returned none for 3 runs, or the reverse | none |
| QC-105 calendar coverage | blocking | `ref_trading_day` lacks any date in [today − 5 y, today + 90 d] | none |
| QC-106 unexpected market status | blocking | the run executed on a day the calendar says is not a trading day, or Polygon market status disagrees with the calendar | none (operator) |

### 3.3 Daily bars

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-201 bar completeness | blocking if missing > 1 % †, else warning | count of tickers with a bar for `trading_date` < expected (current active members) | R2 re-fetch missing tickers |
| QC-202 OHLC order | blocking | `low ≤ min(open, close)`, `max(open, close) ≤ high` violated, or any price ≤ 0 | none (mark `invalid`) |
| QC-203 non-final bar | warning | a bar fetched before the settlement window (`is_final = 0`) was **not** re-fetched by run end. **v1.1.287:** fired on every run until the collector honoured `respondedAt ≥ 17:00 ET` (04). An open finding for an earlier date closes `rule_changed` when every bar response for that date, in the runs that raised it, arrived after 17:00 ET. One fetched before then keeps it open. v1.1.288: counts the LATEST observation per ticker in the run, so a bar R3 re-fetched final is not outstanding | R3 re-fetch final |
| QC-204 discontinuity | blocking | \|close/prev_close − 1\| > 40 % ‡ with no `raw_split`/`raw_dividend` (special) on the boundary | R5 whole-range re-fetch + re-check; if still present → stays open for operator (ticker reuse vs genuine move, per the volume test below). **v1.1.277 — verified genuine move:** the step stops firing and its open finding closes as `false_positive` (actor `gate`, via `Evaluation.closesAs`, never `data_corrected`) when all three hold: R6 re-fetched the ticker's splits and dividends successfully and found none on the boundary; both bars come from one split-adjusted fetch whose `adjusted_as_of` is after the step; and the step is more than 90 days before the trading date (`VERIFIED_MOVE_MIN_AGE_DAYS`, the window in which providers backfill a late action). Reuse evidence blocks it — an open or acknowledged QC-205/QC-209 on the key or QC-210 on the ticker leaves the step for the operator. |
| QC-205 volume regime shift | blocking | 20-day median volume after a discontinuity ≥ 15× ‡ or ≤ 1/15 the 20-day median before it (ticker-reuse signature). *Revised 2026-09-12:* "20-day" means 20 **exchange sessions**, not 20 stored bars, and a window is measured only when it holds ≥ 15 bars — on a sparse series a bar-count window crossed the SOLS splice. **v1.1.276 — the "not reuse" ruling:** a finding the operator resolves as `false_positive` makes QC-205 evaluate that exact step (`TICKER date`) as not fired from then on, still measured for the distribution, with the note in `evidence.ruledNotReuse`. It is the counterpart of the reuse ruling and permanent for that step, because a historic step's volume regime cannot change; a new step on the ticker is a new key and fires. Needed because all ten findings on 2026-09-18 were genuine events on continuing listings (APLD's OTC→Nasdaq uplisting, BMNR ×3, GME ×2, QXO ×2, SMMT, WAL) and none could be closed: acceptances expire, and a plain resolution was reopened by the next run. **Premise refuted for the pilot threshold review (2026-09-18):** those ten genuine events shifted volume 15–468×, so volume does not separate reuse (≥ 15×) from genuine moves (the assumed ≤ 5×). `raw_ticker_reference.list_date` does not separate them either, because it follows the company across ticker changes (BNY 1969, META 2012). The candidate discriminator is a point-in-time identity (CIK/FIGI as of the day before the step), which has not been built or verified | none — operator decides (truncate-before-splice, or rule "not reuse" by resolving `false_positive`) |
| QC-206 series consistency after re-fetch | blocking | a re-fetched series disagrees with the stored series by > 0.5 % † on any date **without** an intervening corporate action (the adjustment basis changed) | none — new rows are already appended (P1); the exception documents the basis change |
| QC-207 gap in trading days | warning | a ticker active on both sides has no bar for a trading day in between | R2 re-fetch range |
| QC-208 zero-volume trading day | warning | `volume = 0` on a trading day for an active ticker | none |
| QC-209 dormant series resumes | blocking | a discontinuity (QC-204's threshold) preceded by ≥ 20 † exchange sessions with no bar, **and** followed by bars on ≥ 15 of the next 20 sessions — a dormant symbol resuming as an active one. Added 2026-09-12: the dormant-shell form of ticker reuse (SOLS, a $0.0001 shell until Solstice Advanced Materials listed on 2025-10-30), which QC-205 cannot measure because there is no 20-session volume window before the step. The second condition keeps the shell's own sparse sub-penny steps from firing. **v1.1.279:** a `false_positive` ("not reuse") ruling on this finding *or* its QC-205 twin holds for both checks. The ruling is about the step, which both key `TICKER yyyy-mm-dd`, so the step is measured but never fires again. It is the same durable ruling QC-205 got in v1.1.276; until now QC-209 ignored it and the next run reopened the finding | none — operator decides, as QC-205 |
| QC-210 bars predate listing | blocking | a stored bar dated before the ticker's current `raw_ticker_reference.list_date`. The same fault QC-205 and QC-209 look for, tested on IDENTITY rather than behaviour: they ask whether the volume regime or the trading gap *looks* like a splice, this asks the reference data where the listing began — so it catches a reuse whose two occupants happen to trade at similar volume, which the volume test cannot. Added v1.1.260 | none — operator decides, as QC-205; a relisting or redomicile (ASND, JHX, COLB, SAIL on this sample) may be continuous history that must NOT be truncated. **v1.1.280:** resolving the finding `false_positive` rules the listing a new share line of the same issuer. The check then measures the ticker without firing **for the `list_date` recorded in the finding's evidence**. A later `list_date` is a new question and fires again. Polygon's `list_date` can also sit a few days before the real splice: BAM reads 2022-12-01, the when-issued start, while the new company began regular trading on 2022-12-12. So a reuse ruling opened from QC-210 needs its splice date entered by hand |

**A ruled ticker reuse is read by the bar checks (v1.1.261).** `recordTickerReuse` closes one membership range and opens another *"so a reader intersecting bars with membership sees one entity at a time"* — and until v1.1.261 there was no such reader, so a ruled reuse fired again on the next run (the gate reopens a resolved exception whose fingerprint fires again, as a recurrence) and the ruling lasted one run. `entityStartDates()` now returns the `valid_from` of the open range whose `change_reason` is `ticker_change`; QC-204 skips comparisons whose earlier bar precedes it, QC-205/QC-209 drop pre-splice bars from their windows, and QC-210 drops the ticker from its population. **The reading is deliberately narrow**: an ordinary `valid_from` is when the ticker joined the universe LIST, not when the listing began, so intersecting with membership in general would discard every bar before the seed and gut all four checks while looking like a tightening. Note also that `inferSpliceDate` breaks ties arbitrarily (`ORDER BY last_seen_run_id DESC LIMIT 1`) and on a reuse ticker every finding shares a run — for JAN six of seven are 2022-2024 dates inside the previous occupant's history — so **a `reuse` ruling must pass the splice date explicitly**.

### 3.4 End-of-day quotes

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-301 quote completeness | blocking if missing > 1 % † | tickers with no snapshot row < expected | R1 retry snapshot |
| QC-302 close disagreement | warning per ticker; blocking if > 2 % of tickers † | \|`day_close` − `raw_daily_bar.close`\| / close > 0.5 % † same day | none |
| QC-303 crossed market | warning | `bid > ask` with both `ok` | none (mark `invalid`) |
| QC-304 stale snapshot | warning | `snapshot_updated` earlier than the session close for > 5 % of tickers | R1 retry |

### 3.5 Option chains

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-401 chain-subset coverage | blocking if missing > 2 % † | subset tickers with no expirations row this run | R2 re-fetch ticker |
| QC-402 expiration coverage | blocking | an expiration inside the capture window has no chain call, or a chain call returned zero contracts for an expiration E*Trade lists | R1 retry expiration |
| QC-403 parse-count equality | blocking | stored contracts for a response ≠ contracts parsed from it (AC-5) | none |
| QC-404 bid/ask sanity | warning | `bid > ask`, or `ask > 3 ×` the contract's maximum value — `underlying_price` for a call, `strike` for a put (a deep ITM put on a collapsed underlying legitimately asks many times the share price; the underlying-only bound fired on 476 correct quotes, v1.1.251). **v1.1.281:** open findings are re-judged on their own recorded quote under the current rule, reading `right` and `strike` from the symbol because older evidence lacks them. The gate closes those the current rule would not fire on as `rule_changed` (519 on gen-002). A finding the current rule still fires on stays open, whatever today's quote says | none (mark `invalid`) |
| QC-405 IV range | warning | `iv` outside (0, 5] stored as `invalid`; blocking if > 10 % of contracts in a run | none |
| QC-406 ladder integrity | warning | strikes for an (expiration, right) not strictly increasing, or a strike appears once as call and not as put | none |
| QC-407 underlying disagreement | warning | \|`underlying_price` − `raw_eod_quote.day_close`\| / close > 1 % †. **Was `last` until v1.1.252**: Polygon sends no `lastTrade` on this plan, every stored `last` was null, and the check evaluated zero tickers on every run with no finding. When both sides are captured and nothing is comparable it now fires a `coverage:<date>` finding instead of evaluating nothing | none |
| QC-408 zero-volume default | warning | any `volume = 0` with `volume_status = ok` **and** `open_interest = 0` **and** bid = ask = 0. This *may* be a defaulted field, but a genuinely untraded far-OTM strike on a fresh expiration has the same shape, so it cannot be blocking — see the note below | none |
| QC-409 sticky-set honoured | blocking | a `ref_sticky_contract` with `valid_to ≥ today` has no snapshot row this run. Phase 7 therefore fetches every pinned ticker, member or not — a non-member at its pinned expirations only, the rest recorded `outside` (core 0.6.1; it walked members alone, so a pin outside the subset could never be honoured). **The join is byte equality on `osi_symbol`, so the pin must be built with E*Trade's dash padding** — to v1.1.247 it was space-padded per the OCC spelling and matched nothing under a six-character root, so all 415 pins were unhonoured and the count only grew (core 0.6.10 corrects the builder and re-pads existing rows by closing and re-opening the range). **v1.1.281:** declares `keyShape` as E\*Trade's 21-character, dash-padded, dotless-root symbol. The 415 findings keyed on space-padded symbols and the 2 on `BRK.B-…` belong to pins the repairs closed, so the gate retires them as `rule_changed` (v1.1.273's mechanism). **v1.1.329: a finding closes itself as `data_corrected` once the pin is captured tonight AND the trading dates of its first and last firing run now hold a snapshot**, meaning the missed day was re-collected. On 2026-09-22 run 28 collected nothing from E\*Trade and raised 1,004 findings. Run 30 re-collected the date and captured every pin, but the only close path was R1, which never ran, so all 1,004 stayed open and blocking. The rehearsal on 09-25 closed all 1,004. A pin that works again after a day nobody re-collected has left a real hole in a held contract's price history, so that finding stays open for the operator | R1 retry |
| QC-410 Greek consistency | warning | **Per ticker (v1.1.252).** The median spot at which Black-Scholes reproduces the provider delta (ATM, invertible contracts, latest observation per contract) differs by > 1 % from **both** the chain `underlying_price` and the put-call-parity spot of the quoted mids, **or** ≥ 5 near-the-money deltas are pinned at 0/±1 where the model at the chain price reads 0.2–0.8. Both readings, because a dividend before expiry separates them and a provider's Greeks may follow either: parity alone (v1.1.252) flagged EIX, CMCSA and CLX (Greeks 54.72 on a 54.81 chain, parity 53.00); the chain alone (v1.1.253) flagged BBY, AJG, AYI, DY, EXPE, FPS and IQV (BBY Greeks 90.97, parity 91.17, chain 92.45). A broken Greek engine is far from both (AIZ 12.2 % / 12.0 %). The chain price is itself checked by QC-407 (549/549 agreeing on 2026-09-16). Measured 2026-09-15/16: parity recovered the close to a median −0.03 %, while 50–70 tickers a day carried Greeks computed off another price (PCTY 113.6 on a 147.3 close on both days). Until v1.1.252 the condition was "delta differs by > 0.05 on > 5 % of ALL ATM contracts", which turned the domain RED on a handful of broken tickers without naming them. The scale question moved to QC-414. **This is the stage-1 consumer of `raw_treasury_yield`** (02 §11); if the yield row is missing for the date the check is skipped, not failed — a missing rate is QC-902's finding, not this one **v1.1.318:** consistency is a claim about today's chain, re-fetched every run, so a clean evaluation closes an open finding `provider_fixed`. On 2026-09-23 132 findings were open against 69 firing; 96 closed on rehearsal and the 69 still firing were untouched. `scripts/wheel-delta-selection-study.mjs` measures what the flagged tickers WOULD cost an unguarded wheel rule (TradeAnalyzer has nulled a stale chain's Greeks at `ETradeDataProvider.getOptionsChain` since v1.1.255): on 228 flagged ticker-days (2026-09-14..23) the provider-delta rule chose a different contract from a Black-Scholes delta at the chain price 113 times, and a contract outside 0.20–0.30 by that model 67 times (AMG 2026-09-14: the $390 put, 11 % ITM, true delta −0.83, chosen as "−0.29"). **v1.1.328: exempt from the consecutive-runs escalation (§5.4, `escalatesOnRepeat: false`).** It is a persistent provider property already handled per ticker by both consumers, so it stays a warning. On the 2026-09-25 rehearsal all 63 open findings read warning (60 firing) | none |
| QC-414 Greek scale | blocking | fewer than 50 % of ATM contracts (DTE ≥ 1) have a provider delta reachable by Black-Scholes: outside [−1, 0] for a put or [0, 1] for a call is unreachable, a pinned in-range delta counts as reachable, the rest must invert to a spot within 0.5–1.5× the chain underlying; skipped below 100 contracts † (P4 — split from QC-410 so a unit fault, which no per-ticker comparison can measure, still fires). IV stored as a percentage is rejected earlier, by the chain converter's 0 < iv < 5 assertion | none |
| QC-411 weekend expiration | blocking | an `expiration_date` that is not a trading day and is not a holiday-shifted expiration (when the third Friday is a holiday, expiration moves to the **preceding Thursday** — 02 §2 `is_monthly_expiration`). Catches the UTC/local weekday bug, whose signature is a Saturday date | none |

**Two promotion rules, and why there are two.** A warning becomes blocking either when *enough of them fired* (`promoteToBlockingAtFiredFraction` — a cross-source drift on one ticker is noise, on 2 % of them the feed moved) or when *the value it measured is large enough* (`promoteToBlockingAtValue`). The second was added at B6 and is not a convenience: QC-405 and QC-412 aggregate to a **single** evaluation whose value already *is* the rate, so "how many evaluations fired" is always one and carries no information — the fraction rule can only promote everything or nothing. Both read "warning on any, blocking above N", which is what §3.5 asks of them, and neither can be expressed by the other.

**On QC-408.** The condition it looks for — a `0` written where the provider sent nothing — is a *code* fault that P11's single-writer rule and the ingestion tests are supposed to make impossible; the real defence is `core/test/ingest/option-contract.test.ts` asserting that an absent `volume` produces `null` + `omitted`, never `0`. As a runtime check on production data it cannot distinguish that bug from a legitimately dead contract, so it is a `warning` that says "look at this", not a gate that blocks a chain domain-day on the shape of an illiquid strike. It is kept because a sudden *jump* in its fire count is a good smoke signal that an ingestion change went wrong (P10 instrumentation makes that visible), which a unit test alone would not give.

### 3.6 Corporate actions, earnings, fundamentals

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-501 unexplained discontinuity | blocking | (alias of QC-204 seen from this domain) a bar discontinuity with no action within ±1 trading day. v1.1.277: a QC-204 step verified as a genuine move (same test, `verifiedGenuineSteps`) closes here too, as `false_positive`, in the same run **v1.1.324:** an ACCEPTED QC-204 step closes this finding too (`false_positive`, naming the acceptance and its expiry) — it mirrored only a resolved QC-204, so accepting a genuine move left the alias open and blocking for ever. A QC-204 in `expired_review` counts as open again, so when the acceptance lapses the alias fires and reopens as a recurrence | R6 per-ticker action re-fetch |
| QC-502 action without effect | info | a `raw_split` whose ratio is not visible in the bar series on `execution_date` (already adjusted; expected) | none |
| QC-601 earnings date slips later | blocking | for a ticker and source, the **nearest future** `report_date` of the newest sweep is > 14 days ‡ later than the nearest future date of the previous sweep, **unless the previous nearest has already passed** (an issuer that has reported rolls to the next quarter, which is the calendar working). v1.1.258: comparing the newest ROW to the row before it read two windows of one subdivided sweep as successive observations — MU's real 2026-09-30 and 2026-12-15 reports, written 409 ms apart, reported as a 76-day slip. 7 of the 8 findings on 2026-09-17 were that artefact, and because the last row written is always a ticker's farthest date, a truncation moving the NEAREST one was masked by the same confusion. **v1.1.283:** an open finding is re-judged under this rule over every sweep pair in the runs it was seen in. If no pair slips, the finding came from the first rule and closes `rule_changed`. If any pair does, it stays open, whatever the latest sweep says. **v1.1.307:** the "already reported" excusal was STRICT (`prev < as_of`), so a nearest date landing exactly on the run’s own date was not excused — and a ticker reporting *today* is the case where the roll is most certainly legitimate. FERG’s FY2026 Q4 (2026-09-22) and Q3 (2026-12-07) were both stored from run 8; on the day it reported, the Q4 row dropped and the check called the remaining Q3 date a **76-day slip** — the truncation signature, and the largest of 121 slips measured in the generation, from entirely correct data. Now `<=`, in one shared `rolledAfterReport()` because the comparison existed in two copies (the live reading and the re-judge). Nothing is given up: the collector runs after the close, so a report dated today has happened. Measured distribution: median 3 d, p90 8 d, 4 of 121 over the 14-day threshold, **nothing at all between 23 and 45 days**. The threshold was NOT moved — with FERG reclassified the dataset holds zero confirmed truncations, and raising a bar calibrated only on negatives is how a check becomes unable to fire | R4 subdivide sweep around the earlier date; stays open until the earlier date is confirmed absent from a non-capped response |
| QC-602 earnings source disagreement | warning | Finnhub vs E*Trade `report_date` differ by > **3** days (v1.1.317; was 1) for the same fiscal quarter. **A missing second source is itself the finding**, reported with a 9999-day sentinel rather than evaluating nothing: with one source every ticker passes unexamined, which is indistinguishable from agreement. v1.1.258: the collector fetches only Finnhub, so this evaluated 0 on every daily run of gen-002 and could not have fired. That was known (TODO #52); what was missing is that the gate's OWN OUTPUT rendered it identically to a clean check — including on 2026-09-17, when it was the only corroboration available for eight QC-601 findings **v1.1.270:** the collector now fetches E*Trade earnings (see QC-603), and the check also fires when both sources are present but **no ticker is dated by both** — E*Trade is asked mainly for tickers Finnhub did not date, so disjoint coverage is the default and a join over it evaluates nothing. A rotating 10-ticker overlap sample gives it pairs to compare. **v1.1.304:** it compared the LAST ROW WRITTEN per ticker and source, not the nearest future date — QC-601's artefact in the sibling that reads the same table, whose v1.1.283 fix changed only QC-601's query. 2026-09-21 was the first run with any ticker dated by both, and it read ACN as `finnhub 2026-12-16 vs etrade 2026-09-27 (80 days apart)`: both Finnhub rows are correct and come from two windows of ONE sweep written 204 ms apart, and the last row written is always a ticker's farthest date. The real gap is 4 days. Now `MIN(report_date)` per `(ticker, source, run_id)`, ranked by run. Every test inserted one row per ticker per source, so the production shape had no fixture. **v1.1.317:** E*Trade is compared **only in the run that fetched it**. The overlap sample asks each covered ticker about once in eleven weeks, and the check re-compared that one row nightly, so the consecutive-runs escalation made AAPL, ABT, ACN and ABBV blocking on a single observation each; a ticker not re-asked is now not evaluated, and its finding stays open without escalating. Threshold measured on all 11 same-run pairs to 2026-09-23 — |gap| 1 (1), 2 (7), 4, 7, 11: two estimates of an unannounced date differ by ~2 days by construction, and the two ANNOUNCED dates in the sample (ACN 10-01, ABBV 10-23) were E*Trade errors of 4 and 7 days, so 3 separates them (1 fired 10 of 11; 5 would miss ACN). Open findings are re-judged on their own evidence: closed `rule_changed` when the recorded gap is inside the threshold, when the severity was escalated under the old rule, or when both dates have passed; a clean re-observation closes `data_corrected` only if the dates moved. Rehearsed on 2026-09-23: 10/11 → 0/10, AEP (11 days) left open **v1.1.323:** the `sources` key ("no cross-source comparison is possible") was only ever produced firing, so the finding raised 2026-09-18 — before E*Trade earnings were collected — could never close. A run that compares at least one ticker now closes it `data_corrected`, naming the count; it is emitted only while such a finding is open, so a normal run's evaluated count is unchanged | none |
| QC-603 earnings freshness | warning | a subset ticker that is not a fund (latest `raw_ticker_reference.security_type` not in ETF/ETV/ETN/ETS/FUND) has no future `report_date` observed within 7 days, **unless it reported within the last 21 days** (the next date is then about a quarter out and can fall past the 90-day sweep). v1.1.257: 47 of 68 findings on 2026-09-16 were ETFs, and GIS and FPS had reported the day before. **v1.1.270:** all 17 findings on 2026-09-18 were Finnhub coverage gaps (other share classes GOOG/NWS/BRK.B/LLYVA, new listings, and SWKS/IOT/ROIV/JHX), not truncation — the sweep was complete. The collector now asks E*Trade (`/v1/market/quote/{t}?detailFlag=ALL&requireEarningsDate=true`) for every subset stock the Finnhub sweep did not date, and an E*Trade date satisfies this check. **v1.1.274:** a ticker never dated by either source whose `list_date` is within **135 days** does not fire — its first full quarter (≤ 90 days) plus a non-accelerated filer's 45-day 10-Q deadline, so its first report is not yet due. On 2026-09-18 that excused CBRS, HONA and SPCX; SUNB (198 days), JAN and MDLN keep firing, as does a ticker with no `list_date`. **v1.1.282:** freshness is a claim about now, so a clean reading settles an open finding, and the check says why. A grace (just reported, new listing) closes it `rule_changed`; a newly observed future date closes it `data_corrected`; an open finding on a ticker whose reference now says fund closes `rule_changed`. **v1.1.285:** a ticker that left the subset closes `rule_changed` from the RECORDED exit: a closed `ref_chain_subset_membership` range and no open one, with the universe's reason in the note (EQR: `index_drop` 2026-09-15, out of the subset 09-17). A ticker with no membership row at all stays open, because absence is not a record **v1.1.321:** a share class the operator has ruled `same_issuer` in `ref_provider_symbol_ruling` (the QC-909 rulings, either direction) supplies the date; the finding names it (`via`) and closes `rule_changed`. A `different_issuer` ruling never does (LLYVA/LLYVK→FWONA). On 2026-09-23 that closed GOOG (via GOOGL, 10-27) and NWS (via NWSA, 11-04); BRK.B keeps firing because BRK.A is undated too. **v1.1.330: a third exemption, a report filing.** When nothing is dated and the stock's last 10-K/10-Q/20-F/40-F in `raw_edgar_filing` (joined on its latest CIK) was filed within **60 days** (working), the next date is not yet announced. It evaluates 0 and closes `rule_changed`, naming the filing. The just-reported grace can only see a report the calendar once listed as future, so a company that reported before gen-002 began, or that Finnhub never covers, looked like one that had dropped out: IOT (10-Q 09-08), JHX (08-06) and JAN (08-05) on 2026-09-27, all three closed on rehearsal. Past 60 days it fires again, which is when a missing date starts to matter | R2 re-fetch ticker |
| QC-604 earnings weekend date | warning | `report_date` on a non-trading day (the UTC-Saturday artefact) — stored as observed, flagged | none |
| QC-701 filing freshness | warning at 120 d, blocking at 180 d | a CS ticker with `cik` has no fact with `period_end` within N days. **v1.1.271: each finding names its cause** in `evidence.cause` — `no_newer_filing_seen` (a late filer), `awaiting_fetch` (our queue), or `sec_companyfacts_missing` (companyfacts fetched after the filing still lacks it). Both findings on 2026-09-18 were the last: IQV's and JCI's July 10-Qs were filed with inline XBRL and SEC's companyfacts still omitted them weeks later, so "past 180 days it is our pipeline" was not true of them. **v1.1.322:** a `sec_companyfacts_missing` finding says when the filer will really be asked again — `next retry due <date>`, or `retry due since <date>, k of n waiting retries` — read from the same queue the collector fetches from. It promised "retried every 7 days" while every retry sat behind 34 never-fetched filers. Verified on 2026-09-23 from the archived bytes: the companyfacts responses for IQV, JCI and LNT hold no fact from their July 10-Qs (newest accession in each is May's), so the cause is SEC's aggregate, not the parser | R2 re-fetch submissions |
| QC-702 fact sanity | warning | `Assets < 0`, `Revenues < 0`, or `SharesOutstanding` differs from `raw_ticker_reference.shares_outstanding` by > 25 % †. **v1.1.309: the two sides are observed on DIFFERENT DATES, so a split between them puts them on different scales and the check measures the corporate action rather than the data.** IESC read 50.0 % on 2026-09-22 — EDGAR 19,924,356 stated 2026-07-27, Polygon 39,848,712 observed 2026-09-11, `raw_split` holding `1:2` on 2026-08-24 between them; both numbers exactly right. The EDGAR figure is now carried across any split strictly after the fact’s `period_end` and on or before the reference’s `as_of_date` (a split on or before `period_end` is already in the EDGAR figure; one after the reference observation is in neither). The adjustment is NAMED in the finding and the evidence keeps both the as-filed and the carried value, because a figure that has been moved must stay checkable against its filing. An incomplete `raw_split` under-adjusts and therefore FIRES — the right failure direction, so a missing corporate action is loud rather than silently corrected | none |
| QC-703 CIK source disagreement | warning | a universe ticker in the latest `raw_sec_ticker_map` capture has a Polygon `raw_ticker_reference.cik` that differs from SEC's (or none). **v1.1.331.** Every EDGAR lookup already uses SEC's CIK where the two differ (`collector/cik.ts`, `effectiveCikSql`), so this is a report, not a gate, and it is exempt from repeat escalation (§5.4). Measured 2026-09-27 over the universe: 1,027 agreed, and FWONA, LLYVA and LLYVK carried 0000869614 (the old Liberty Media Corporation, no 10-Q or 10-K) against SEC's 1560385 and 2078416. On SEC's real file it fired on exactly those 3 of 1,030. Closes `provider_fixed` when Polygon agrees. A ticker SEC does not list (every ETF) is not evaluated | none |
| QC-704 companyfacts omission | warning | a stored report filing (10-K/10-Q/20-F/40-F) is absent from `raw_edgar_fact` although companyfacts for its CIK was read at least **14 days** (working) after it was filed. Keyed per accession. **v1.1.332.** SEC's companyfacts dropped most 10-Qs filed 2026-07-28 and 07-29 (5 of 6 and 8 of 12 read afterwards), while all 15 filed 07-21..24 and 52 of 53 filed 08-03..11 were present. KO's was still missing live two months later, though it carries inline XBRL and its April 10-Q, filed through the same agent, is present. QC-701 sees only chain-subset stocks over 120 days stale, so it named 7 of these; on rehearsal QC-704 named 17, including IDA's April 10-Q, 145 days out. Exempt from repeat escalation (§5.4); closes `provider_fixed` when the filing appears. A filing whose CIK was never read, or read too soon after, is not evaluated | the weekly companyfacts retry |

### 3.7 Account

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-801 balance snapshot | blocking | no balance row this run, or `total_account_value` status ≠ `ok` | R1 retry (with renew) |
| QC-802 position/order reconciliation | warning | a position appeared or disappeared between snapshots with no executed order leg explaining the quantity change within the interval (assignment/expiry/exercise show up as orders or transactions) | R7 transactions fallback pull |
| QC-803 order idempotence | blocking | an `order_id` is stored with more than one `order_fingerprint` — i.e. it arrived again with different leg data. Built at B6 on a **non-unique** `order_id` for exactly this reason: a unique index would turn the finding into an insert failure indistinguishable from a parse fault (02 §10.3) | none |
| QC-804 fills without price | blocking | `filled_quantity > 0` with `average_execution_price` null/0 | none |
| QC-805 transactions unavailable | warning | the fallback endpoint failed this run (known intermittent) | R1 retry once |
| QC-806 encryption | blocking | any account-domain archive file lacks the encryption header (P15) | none — the run is failed |

### 3.8 Macro, rates, sentiment-side domains

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-901 VIX range | blocking | `last` outside [5, 150] ‡ or missing | R1 retry |
| QC-902 yield curve | warning | fewer than **14** tenors ‡ (the published set, measured 2026-09-05), or any yield outside [−0.01, 0.25] | R1 retry / fallback source |
| QC-903 macro calendar gap | warning | no FOMC event in the next 90 days, or no CPI in the next 45 | none |
| QC-904 short interest freshness | warning | newest `settlement_date` older than **38 days** = 18 (widest gap between FINRA settlements) + 12 (publication after the close on the 7th business day, one holiday) + 8 (weekly fetch, one holiday-skipped Monday). **v1.1.316:** the drafted 21 days counted from settlement as though publication were instant, so the 2026-08-31 settlement read 22–25 days old on 2026-09-22..25 while its successor (2026-09-15) was neither published (FINRA: 2026-09-24) nor due to be fetched (2026-09-28) — and escalated to blocking on a domain exactly on schedule. A year-long sweep of the settlement/publication/fetch schedule pins it. A clean reading past 21 days closes an open finding `rule_changed` | R1 retry |
| QC-905 recommendation freshness | warning | for a non-fund subset ticker, more than 45 days since the latest of: a stored recommendation row, a successful `/stock/recommendation` request for it, or its admission to the subset. It guards the SWEEP, so a ticker asked recently that Finnhub does not cover is current. v1.1.257: of 82 findings on 2026-09-16, 47 were ETFs and most of the rest were admitted after the last weekly sweep. **v1.1.282:** a clean reading closes an open finding with its reason, as QC-603 does. A stored row closes it `data_corrected`. Asked-and-empty, a recent admission, or a ticker that is now a fund closes it `rule_changed`. **v1.1.285:** so does a recorded exit from the subset, as for QC-603 | R2 re-fetch |
| QC-909 recommendation symbol mismatch | warning | the latest recommendation row for a ticker carries a `provider_symbol` different from the ticker asked. Measured 2026-09-14: GOOG→GOOGL, BRK.B→BRK.A, GFL→GFL.TO (same issuers) and LLYVA→FWONA (a different company); not decidable from symbols, so every mismatch is a ruling. **v1.1.306:** it fired for the first time on 2026-09-21, seven times, adding NWS→NWSA, JHX→JHX.AX and a second Liberty Live class LLYVK→FWONA. A pairing the operator has RULED in `ref_provider_symbol_ruling` (02 §12) no longer fires and closes `rule_changed` naming the ruling — a standing answer is not an open question, and leaving seven settled rows in the report would make an unruled eighth harder to see, which is the whole point of the check. A `different_issuer` ruling also stops the ingest storing the answer, so that pairing stops appearing on its own once the next weekly sweep runs, and the asked ticker reads as having no coverage — true, and QC-905 reports it as the gap it is. Rows written before a ruling stay as evidence of what the provider answered | none |
| QC-906 insider parse | warning | a Form 4 filing indexed but no transaction rows parsed. **v1.1.305:** until dictionary v20 the parser dropped derivative transactions, so an ordinary option-grant filing parsed to nothing and the benign case dominated the measurement — it fired on 2 of the 2 runs that ever had data (19.1 % and 11.7 %) and had **never once passed**, and all 11 filings it named on 2026-09-21 were correct Form 4s with only derivative transactions. Both classes are now stored (02 §12, `security_class`), so zero rows again means what the check says: a readable filing that yielded nothing. A Form 4 reporting only *holdings* still parses to none, which is rare and worth the finding | none |
| QC-910 insider index coverage | warning | more than **1** session before the trading date has no parsed EDGAR daily form index (today excluded — it publishes late evening), or a sweep ran and no index has ever parsed. Added v1.1.268: on 2026-09-18 the index answered 503, `events_insider` stored 0 against 299 the night before, and QC-906 — which only sees Form 4s that were fetched — could not notice. One session behind is tolerated because the sweep catches up from the last parsed index on the next run | none (the next run's catch-up is the remediation) |

### 3.8a Derived IV and the external bootstrap (Q17)

Registered only once a `bootstrap_iv` load exists — an unbought bootstrap has no series to check, and a check registered against it would evaluate nothing every run and sit in the zero-fire list looking exactly like one that is silently broken.

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-907 bootstrap overlap sufficiency | blocking on the bootstrap (never on the daily domains) | an `ext_iv_history` series has `accepted = 0` and `paired_days < 20` ‡ — i.e. the two series have not yet been compared on enough common days for the comparison to mean anything. **Zero paired days is the maximum firing of this check, not a pass**: the tested quantity is the count of paired days itself, reported on every evaluation whether it fired or not, so "we never had an overlap" and "the overlap was clean" can never look alike | none — the series stays unread until the days accumulate, or the operator accepts with a note |
| QC-908 bootstrap disagreement | blocking on the bootstrap | median absolute difference between `derived_iv30_daily` and `ext_iv_history` over the paired days > 0.02 (2 vol points) † | none — accept with a note, or the series is not used |

**Why QC-907 exists as a check rather than as a precondition.** The overlap check was first drafted as "for every day both series exist, store the paired difference" — which on zero such days evaluates nothing, stores nothing, and reads as a clean result. The existing app's own `iv_history` is spliced across two sources with **zero overlapping ticker-days** (measured 2026-09-07), so this is not a hypothetical shape: it is what actually happened the last time this was done, and nothing in the stored data can now say whether that splice distorted IV rank or not. Making the day count a *thresholded quantity in its own right* is the difference between a check that cannot fire and one that fires hardest precisely when there is nothing to compare.

### 3.9 Periodic checks (not every run)

| id | sev | cadence | fires when |
|---|---|---|---|
| QC-951 replay equivalence | blocking | weekly, on a sampled trading day | replaying that day's archive into a scratch DB yields raw/derived rows that differ from stored **over the fact columns** — the comparison excludes `row_id`, `run_id` and `meta_` timestamps, which necessarily differ in a fresh database and are not facts (AC-4, 04 §7.5) |
| QC-952 fire-count review | info | at pilot exit and monthly | lists every check with `fired_total = 0` for operator review (P10) |
| QC-955 threshold distance | info | at pilot exit and monthly | for every check declaring a `tested_quantity`, reports the pooled distribution against its threshold and flags two shapes: a threshold **no observation ever approached** (p99 below half the boundary — decorative, the DINO shape) and one **the bulk of observations sit against** (p50 within ±25 % — firing on ordinary data, the liquidity-score shape) |
| QC-953 archive/DB drift | blocking | weekly | a `meta_response` row's archive line is missing, or an archive line has no `meta_response` row |
| QC-954 exception aging | warning | daily | an `open` exception older than 5 runs with no acknowledgement |
| QC-956 replay overdue | warning | every run | more than 7 † trading sessions since the last replay that came back `equal` or `equal_on_replayed` (counted from the first daily run until one has) — added at B10a |

**As built (B10a): the gate does not run a replay, it reads the ones the operator ran.** Replay is a one-shot job queued from the Jobs view and executed by hand in the host app (nothing claims a request on its own since v1.1.206), so QC-951 evaluates every run over `meta_job_request.result_json`: for each replayed trading day, the **latest** replay's verdict — `different` fires, blocking, and makes that day unusable. Latest rather than every, so a day re-replayed `equal` after a fix stops firing and can be resolved; with no replay at all it evaluates nothing, since that is QC-956's finding. QC-956 is the reminder that makes a skipped week visible: a warning, so it never breaks the streak, but promotion also requires it clear (§8).

---

## 4. Tables

### `qa_check_registry`
Generated from code at startup; the fire statistics are updated by the gate. **Built at B4**: the table is append-only with a validity range, and `mutableColumns` names the four counters (`evaluated_total`, `fired_total`, `first_fired_at`, `last_fired_at`) that may accumulate. The check's *definition* stays frozen — a threshold change opens a new version, so a past `qa_check_result` can still be read against the boundary actually in force — while its *instrumentation* moves. Everything not named still refuses an edit.

| column | notes |
|---|---|
| `check_id` | `QC-nnn` |
| `domain`, `default_severity`, `description`, `reads_tables_json` | |
| `tested_quantity` | the name of the magnitude this check compares against its threshold, e.g. `abs_close_change_pct`, `volume_regime_ratio`, `missing_ticker_fraction`. **Null means the check tests a predicate, not a magnitude** (QC-001…005 are true/false: a row either has provenance or it does not) — the one declared null meaning, per P3 |
| `tested_unit` | the unit of that quantity, from the same vocabulary as the dictionary (`fraction`, `ratio`, `days`, `count`) |
| `thresholds_json` | the † values in force; changing one is a new registry version row |
| `registry_version`, `valid_from`, `valid_to` | |
| `evaluated_total`, `fired_total`, `first_fired_at`, `last_fired_at` | P10 instrumentation |

### `qa_quality_report`
One per run.

| column | notes |
|---|---|
| `report_id`, `run_id` | |
| `generated_at` | |
| `overall` | `green` \| `amber` \| `red` (no findings / warnings only / any blocking) |
| `domains_json` | per domain: expected, stored, status |
| `checks_json` | per check: evaluated, fired, duration_ms |
| `email_sent_at`, `email_status` | `sent` \| `failed` \| `suppressed` (never suppressed in stage 1) |

### `qa_check_result`
One per (run, check) — the row behind `checks_json`, queryable.

| column | notes |
|---|---|
| `run_id`, `check_id`, `registry_version` | |
| `evaluated_count`, `fired_count`, `duration_ms` | |
| `sample_keys_json` | up to 20 offending keys for the inspector |
| `distribution_json` | **the whole point of P10** — summary statistics of `tested_quantity` over *every* evaluation this run, fired or not: `{ n, min, p50, p90, p99, max, threshold, nearBoundary }`, where `nearBoundary` counts evaluations within ±25 % of the threshold. Null iff the registry declares `tested_quantity` null |
| `extreme_keys_json` | up to 20 keys with the **largest** tested values, whether or not any fired — the rows nearest the boundary are the evidence a threshold review needs, and they are exactly the ones a fired-only record discards |

### `qa_exception`
One per distinct finding, persistent across runs.

| column | notes |
|---|---|
| `exception_id` | |
| `fingerprint` | `sha1(check_id + domain + key)` — the identity that makes tomorrow's recurrence the same exception |
| `check_id`, `domain`, `key` | key = ticker / osi_symbol / order_id / date as appropriate |
| `severity` | current, after escalation |
| `base_severity` | the check's default at creation |
| `state` | `open` \| `acknowledged` \| `resolved` \| `accepted` \| `expired_review` |
| `detail` | one line, human |
| `evidence_json` | offending values, expected vs actual |
| `first_seen_run_id`, `last_seen_run_id`, `consecutive_runs` | |
| `remediations_json` | list of `{ code, at, outcome }` (§6) |
| `resolved_at`, `resolution_note`, `resolution_kind` | `data_corrected` \| `provider_fixed` \| `rule_changed` \| `false_positive`. **`rule_changed` means the check's rule no longer applies to this key (v1.1.285).** That covers a rule that has itself changed (a new bound, a new key, a new exemption), and also a key that has left the rule's scope, such as a ticker that left the chain subset (EQR, 2026-09-17). The note always says which. A dedicated `out_of_scope` kind would be more precise, but this column's CHECK is baked into a populated table, so it waits for the next generation |
| `accepted_at`, `accepted_note`, `accepted_until` | acceptance **must** carry an expiry (default 30 days) |
| `affects_trading_dates_json` | the domain-days this exception makes unusable |

### `qa_exception_event`
Append-only audit trail of every state or severity change: `exception_id, at, actor (gate | operator | escalation), from_state, to_state, from_severity, to_severity, note`.

### `qa_domain_day_status`
| column | notes |
|---|---|
| `domain`, `trading_date` | |
| `status` | `usable` \| `usable_with_warnings` \| `unusable` \| `not_run` |
| `blocking_open`, `warning_open` | counts |
| `computed_at`, `by_run_id` | |

Recomputed whenever an exception changes state. **This is the only table a downstream consumer may read to decide whether to use a day's data.**

---

## 5. Exception lifecycle

### 5.1 States

```
            ┌──────────── recurrence after resolve ────────────┐
            ▼                                                   │
 (gate) → open ──ack──▶ acknowledged ──▶ resolved ──────────────┘
            │                 │
            └──── accept ─────┴──▶ accepted ──expiry──▶ expired_review
                                       ▲                    │
                                       └── re-accept ───────┴──▶ open (operator opens it)
```

| Transition | Actor | Rule |
|---|---|---|
| create → `open` | gate | first run where the fingerprint fires |
| `open` → `acknowledged` | operator | note optional; stops QC-954 aging |
| `open`/`acknowledged` → `resolved` | operator, **or** gate | gate may resolve only when the *same fingerprint* evaluates clean **and** a remediation in `remediations_json` succeeded — never merely because it stopped firing (P9). "Evaluates clean" means the check returned an evaluation for that key **this run** and it did not fire; a key absent from the evaluations (not collected this run, a deduplicated fetch that stored nothing, the check threw) is unobserved and stays open with `still_firing = 0` (v1.1.278 — until then absence read as clean). QC-501, which reads only open QC-204 findings, closes its own finding with the kind and note QC-204's was resolved with |
| `open`/`acknowledged` → `accepted` | operator only | note **required**, `accepted_until` required (default +30 d); domain-day becomes usable |
| `accepted` → `expired_review` | gate | on `accepted_until` passing while the fingerprint still fires |
| `expired_review` → `accepted` / `open` / `resolved` | operator only | re-accept with a fresh expiry, or open it for real work |
| `resolved` → `open` | gate | fingerprint fires again; `consecutive_runs` resets; email calls it out as a *recurrence* |

An exception whose fingerprint stops firing without a remediation stays `open` and is listed as "no longer observed, unresolved" — because "it went away" is exactly how the earnings-date bug hid.

**One other case the gate closes itself (v1.1.273): a key its check can no longer produce.** A check whose keying changed declares `keyShape` — the pattern every key it produces now matches. A finding of that check which has stopped firing and whose key does not match can never fire again, and no remediation exists for a key that no longer exists, so the gate resolves it as `rule_changed` with actor `gate` and one event per finding, naming the old key. This is a fact about the check, which the gate knows, not a claim about the data, so it does not breach the operator-only rule above or 05 §5's "no bulk resolve". Two guards: a check that throws, or produces a key outside its own declaration, retires nothing that run (the stray key is raised as a `key_shape_violation` finding, since the declaration is now wrong); and a finding still firing is never retired. First use: QC-410, keyed per contract until v1.1.252 and per ticker since — 11,444 contract-keyed findings open on gen-002 with nothing able to close them, retired on the first run of v1.1.273 (rehearsed on the 2026-09-18 snapshot: open queue 12,963 → 1,496).

**And a check that has stopped throwing (v1.1.289).** A check that throws is recorded as one `check_error` finding. No clean evaluation of the key `check_error` can ever exist, so under the rules above it stayed open and blocking for good — QC-604's "no such column: trade_date" from before v1.1.251 was still in the email's blocking backlog on 2026-09-18, though the check had run cleanly on every run since. Whether a check threw is something the gate observes itself, so it is the same kind of fact as a retired key shape: when a check completes without throwing, the gate resolves its open `check_error` finding as `rule_changed`, actor `gate`, noting that the error no longer occurs. This holds even if the recovered check evaluates nothing — not throwing is the evidence; an empty evaluation is reported separately as "evaluated nothing".

### 5.2 Effect on usability

Recompute `qa_domain_day_status` for every date in `affects_trading_dates_json` on any state change. `unusable` iff any blocking exception on that domain-day is `open` or `acknowledged`.

**`expired_review` does not make a domain-day unusable, and does not break the clean-day streak** (decided 2026-09-05). An acceptance expiring is a prompt to re-examine a *known* fact, not the discovery of a new one — the data has not changed. Letting expiry flip a day back to unusable would mean an acceptance taken on pilot day 1 resets the streak around day 21, every time, so the 20-day criterion would be defeated by its own escape valve. Instead an `expired_review` exception gets its own section in every status email until the operator rules on it, and **pilot exit (§8) additionally requires that nothing is sitting in `expired_review`** — so it cannot be ignored, it just cannot silently undo three weeks of clean running. The 30-day default keeps doing its real job: forcing periodic re-examination of everything accepted.

### 5.3 Fingerprint keys by domain

bars / quotes / reference: `ticker` (+ `trade_date` for QC-204/205/206); chains: `ticker` for coverage checks, `osi_symbol` for contract checks; earnings: `ticker` + fiscal quarter; account: `order_id` / `symbol`; cross-cutting: `table` + `run`.

### 5.4 Escalation

If the same fingerprint fires on **3 consecutive runs** † while `open`, severity is promoted one level (`info → warning → blocking`) and the email names it under "Repeat offenders". Escalation is recorded in `qa_exception_event` with actor `escalation`. Severity never drops automatically, with two exceptions (v1.1.328):

- **A recurrence starts again from that run's own severity**, which is the check's base or whatever its value or fraction rule promotes it to. It then re-earns the escalation by firing 3 runs in a row. Until v1.1.328 a reopened finding kept its escalated severity while its counter reset to 1. So on 2026-09-25, 10 QC-410 findings reopened as blocking, citing "fired on 3 consecutive runs" after firing once.
- **A check may declare `escalatesOnRepeat: false`.** Its findings take each run's own severity and never escalate on repetition. Already-escalated ones return to base, whether they fire or not, with one event each. This is for a persistent **provider** property that is handled per key where it is consumed and that no action here can repair. For such a check, firing again is the expected state, not new evidence. First and only use: **QC-410**. About 25 E*Trade tickers a night had escalated, which held the chains domain `unusable` for good. That was the gate-wide RED v1.1.252 removed, back again one ticker at a time. Value and fraction promotion still apply.

---

## 6. Permitted automatic remediations (P12)

The gate may request only these, each additive and idempotent. Every attempt is appended to `remediations_json` with its outcome. Anything not listed is an operator action performed through the inspector, which records the actor.

| code | action | allowed for |
|---|---|---|
| R1 | retry the same call once (after E*Trade renew if applicable) | any transient failure |
| R2 | re-fetch a single ticker's data for the domain | missing/stale ticker |
| R3 | re-fetch today's bar after the settlement window | non-final bar. **Built v1.1.288** (`runR3FinalBarRefetch`): runs after the last collection phase, before the gate, for the tickers whose latest same-day bar in the run is provisional. If the run's clock is past 17:00 ET it re-fetches the one day; the rows are new observations, stored final. If not, it re-fetches nothing and the email says the window was still open |
| R4 | subdivide a swept window and re-fetch the halves | provider cap |
| R5 | re-fetch a ticker's **whole** bar range and re-run QC-204/205/206 on the new rows | discontinuity |
| R6 | re-fetch a ticker's splits + dividends | unexplained discontinuity |
| R7 | pull the transactions fallback for the interval | position/order mismatch |

**Status (v1.1.266): R6 is the only one implemented.** Until then none of them existed — all 12,970 exceptions on gen-002 carried `remediations_json = '[]'` and nothing in the repo wrote one, so every `remediation:` field was a declaration of intent. That left §5's auto-resolve dead: the gate may resolve a stopped-firing finding only when *a remediation succeeded and the fingerprint now evaluates clean*, and it read a field nothing wrote. `runR6ActionRefetch` runs after the gate and before the email, fetches a ticker's splits and dividends **once per ticker** over its first-to-last step ±7 days, records the attempt, and resolves nothing itself — the next run's QC-204 decides whether the step is now explained. One attempt per finding (the cap), 60 tickers per run, and a failure never fails the run. Measured on run 19: 61 tickers, 122 calls, 123 findings, against the ~845 pages a five-year market-wide dividend sweep would have cost. **v1.1.286:** the cap takes tickers **oldest finding first** (lowest `first_seen_run_id`, then `exception_id`, ticker only as a tie-break), not alphabetically. On R6's first live run (2026-09-18) alphabetical order deferred WULF, whose findings were among the oldest open. The gate email carries a `REMEDIATION` line giving tickers attempted, ok and failed, findings marked, and how many were deferred to a later run. It also says so when R6 did not run.

**Operator-only actions** (recorded on the exception, never automatic): truncate-before-splice for confirmed ticker reuse (implemented as a `valid_to` on `ref_universe_membership` and a `predecessor_ticker` lineage row — the old rows stay, P1); accepting a genuine violent move; changing a threshold (new registry version); removing a ticker from the chain subset.

---

## 7. The status email (P9)

### 7.1 When

After **every** run that reaches the gate, including one-shot jobs, including green days. Sent through the existing app's nodemailer configuration (Q4: the collector runs there in stage 1).

### 7.2 Content — one screen

```
Subject: [TA-Data] 2026-09-05 after_close — GREEN | AMBER (3 warnings) | RED (2 blocking)

Run #412  gen-001 (pilot, clean-day streak 7/20)  17:04–18:51 ET  collector 0.3.1

BLOCKING (2)                                          ← omitted when none
  QC-204 bars  CRWD  close 78.12 vs prev 312.40 (−75%) no split found · R5 attempted: still present · open 1 run
  QC-601 earnings  NVDA  report_date 2026-11-17 was 2026-08-26 (+83d) · R4 subdivided: earlier date confirmed → resolved by gate

REPEAT OFFENDERS (1)
  QC-302 quotes  BRK.B  close disagreement 0.7% · 3 consecutive runs → promoted to blocking

WARNINGS (3)  QC-302 ×2, QC-805 ×1

DOMAINS                    expected   stored   status
  bars                        1,086    1,086   usable
  quotes                      1,086    1,084   usable_with_warnings
  chains (503 tickers)        4,118 calls  4,118   usable
  earnings                    event    +41     unusable (QC-601 until resolved)
  account                      1 bal / 14 pos / 3 orders   usable
  …

EXPIRED ACCEPTANCES (1)               ← needs a ruling; blocks promotion, not the day
  QC-205 bars  MRNA  accepted 2026-08-06 "genuine repricing, not reuse" · expired 2d · still firing

EVALUATED NOTHING (4)                       ← could not fire; not the same as clean
  QC-303, QC-502, QC-909, QC-951

OPEN EXCEPTIONS  12 open · 4 acknowledged · 2 accepted (expiring: QC-205 MRNA in 6d) · 1 expired_review · 3 resolved today
Zero-fire checks this pilot: 9 of 63   (list at pilot exit)

→ Exceptions view: tradeanalyzer-next://exceptions?run=412
```

Rules: blocking first; one line per exception with key, evidence, remediation outcome and age; counts only for warnings; the domain table always present; the open-exception totals always present (P9: nothing ages out silently); plain-text body with an HTML twin; no links that require a session (the deep link opens the new exe).

### 7.2b A check that evaluated nothing is NAMED (added 2026-09-17)

`EVALUATED NOTHING` lists, by id, every check whose `evaluated_count` was zero on
this run. The aggregate line above it — `Zero-fire checks: N of M` — cannot
distinguish a check that **found nothing wrong** from one that **could not
look**, and those are opposite pieces of news.

The gate already computed `checksVacuous` and the daily result already carried
it; nothing rendered it, so the only trace of a dead check was a zero in a table
nobody reads. QC-602 sat that way for the whole of gen-002, joining on a source
the collector does not fetch, and was still dead on the night it was the only
corroboration available for eight QC-601 findings.

A check is expected to be vacuous only when the phase that writes its tables has
not shipped (§1). Any other name on this list is a defect — read it before
reading the findings.

### 7.2a One screen is a REQUIREMENT, not a description (added 2026-09-15)

The heading above says "one screen" and the implementation listed every finding,
one line per row. On 2026-09-15 that was **773 blocking rows** — past the ~102 KB
at which Gmail clips a body, and unreadable long before that, with 415 identical
QC-409 lines burying the eight other checks that each needed a different
decision. Two RED emails went unread in that state.

So each section — `BLOCKING`, `REPEAT OFFENDERS`, `NO LONGER OBSERVED`,
`EXPIRED ACCEPTANCES` — collapses to **one line per check**: the check id, its
domain, `×N`, its age, then at most **three** real rows, then `… and N more`.
The total count is never dropped or rounded: it is the number that says how bad
the day is. `WARNINGS` was already counted rather than listed.

**An alert that cannot be read has already failed, whatever the delivery log
says.** The rendered HTML must stay under 102 KB; this is asserted by a test that
fires a single check 500 times, not left as a consequence to hope about.

### 7.2b The send outcome is evidence, not an assumption (added 2026-09-15)

`nodemailer.sendMail` rejects only when **every** recipient is refused, so a
partial rejection resolves and reads as success. Logging "sent" on that basis
cannot distinguish a relay failure, a partial rejection, a spam-folder landing
and a clipped body — all four were indistinguishable when the 2026-09-14 and
2026-09-15 gate emails did not arrive.

Every send therefore records the relay's own verdict: `accepted` count,
`rejected` addresses, the SMTP `response` string, the `messageId`, the HTML byte
size, and whether that size crosses the clip threshold. A partial rejection is
logged at ERROR (`collector-email:partial`), not INFO.

### 7.2c The delta — what this run CHANGED (added 2026-09-15)

The sections above report **state**. State has been RED on every daily run of
gen-002, so the verdict said the same thing on the night QC-401 first fired at
92 % as on a night when nothing moved. A signal that is always on carries no
information, and the practical consequence was that the operator stopped reading
the email and asked for a manual review instead.

So the email opens with a **delta against the previous gate run** — not the
previous calendar day, so a re-run of the same day compares against the run
before it. Per check:

| Outcome | Meaning |
|---|---|
| `new` | the check had nothing open at the baseline and fires now |
| `growing` | more findings firing than at the baseline |
| `shrinking` | fewer |
| `churned` | the same count, different findings — a swapped ticker is not "unchanged" |
| `gone` | fired at the baseline, silent now, **still open** (not resolved) |
| `resolved` | closed by the gate because a remediation succeeded, because its check can no longer produce its key (`rule_changed`, v1.1.273), or because a check that threw has since run without throwing (`rule_changed`, v1.1.289) |

Anything not in that list is counted (`unchanged: N checks, M findings`), never
listed. Ordering is blocking first, then by size of move. Each changed check
carries one concrete row, preferring a newly added one — a count alone is not
actionable.

It is computed from `qa_exception.first_seen_run_id`, `last_seen_run_id` and
`still_firing`. **Nothing is stored for it**: a snapshot table would be a second
source of truth to keep honest.

**The subject line carries the headline** (`RED (572 blocking) · 1 NEW, 2
growing` against `RED (572 blocking) · no change`), because the subject is what
is read on a phone and what decides whether the email is opened at all.

**A missing baseline is reported as a missing baseline.** On a generation's first
run the headline is `first run, no baseline` and the body says so. "No baseline"
and "no change" are different facts, and rendering the first as the second would
repeat the failure this whole document exists to prevent — the same shape as
QC-907 passing on zero paired days and `cleanDayStreak` walking only the dates
that have rows.

**Limitation, inherited from the gate:** `still_firing` stays 1 for a check that
did not run at all, so `unchanged` means "not contradicted this run", not
"re-verified this run".

### 7.3 Watchdog — the email that reports no email

A dead scheduler produces no run and therefore no gate and no email. A separate, tiny job in the hosting app (`collector-watchdog`, scheduled 19:30 ET on trading days) checks `meta_run` for a completed run with today's `trading_date`; if none, it sends `[TA-Data] 2026-09-05 — NO RUN` and writes `not_run` into `qa_domain_day_status` for every domain. The watchdog's own failure is the residual risk; it is intentionally the simplest code in the system.

---

## 8. Pilot exit (P14, P10)

The gate computes and the email shows a **clean-day streak**: consecutive trading days on which every domain-day is `usable` or `usable_with_warnings` with **zero open or acknowledged blocking exceptions** at end of run. An exception in `expired_review` does not break the streak (§5.2) but does block promotion at step 4. When the streak reaches 20 †:

1. QC-952 produces the **zero-fire list** — every check with `fired_total = 0`. The operator reviews each: keep (plausibly rare), fix (the condition can never be true as written), or drop. Decisions recorded on the registry row.
2. The **distribution review**: for every check declaring a `tested_quantity`, the pooled distribution over the pilot's runs is presented against the threshold in force — percentiles, max, the near-boundary count, and the extreme keys. Each † value is then either confirmed, moved, or recorded as *unmeasurable on this sample* (the honest verdict for a check whose event simply did not occur; QC-205 ticker reuse is expected to be one). A threshold is never left at its draft value silently: the outcome is written to the registry row with the distribution that justified it.
3. The operator confirms every domain has been visually inspected (D5) — a checkbox per domain in the inspector, recorded with a timestamp.
4. **Nothing is in `expired_review`** — every expired acceptance has been ruled on (§5.2). Then `meta_generation.status` → `production`, `pilot_exit_at` set. Downstream stages may now read.

A reset (P14) restarts the streak at 0 in the new generation.

### 8.1 As built (B10a, dictionary v13)

- **The streak walks the exchange calendar**, not the dates that have status rows. The first `cleanDayStreak` iterated `DISTINCT trading_date`, so a session on which the host app never ran — no 17:05 run *and* no 19:30 watchdog, the one day nothing can write `not_run` — was absent from the walk and the streak counted straight across it. A trading day with no rows now breaks the streak.
- **Rulings are their own append-only table, `qa_check_ruling`**, not columns on the registry row as step 1 says: that row's definition is frozen (a threshold change is a new version), so it cannot take a ruling. Each ruling is keyed to the `registry_version` it judged, carries a required note and the evidence shown when it was made; the latest per check, version and review is the one in force. A ruling covers one version — a check fixed or moved in code comes back as a new version to rule on again. `move` records the proposed value; applying it is a code change.
- **Pooled quantiles are reported as bounds.** Each run stores a summary, not every value, and a pooled quantile cannot be recovered from per-run quantiles — but the pooled distribution is a mixture, so its q-quantile lies between the smallest and largest per-run q-quantile. The two QC-955 shapes are answered `yes` only when the whole bound satisfies the rule, `no` when none of it does, `maybe` otherwise. Only runs under the version in force are pooled. Only `working` (†) thresholds need a ruling; `measured` and `structural` ones are shown.
- **Promotion conditions, all enforced in `core`** (`promoteToProduction` recomputes them and refuses, naming each unmet one): generation in `pilot`; streak ≥ 20; every never-fired check ruled; every working threshold ruled; every gate domain inspected (`meta_domain_inspection`); nothing in `expired_review`; **no column carrying a verify note** (02 §16 — the dictionary already said so; `raw_short_interest.short_interest` is the one left); and **replay current** — a replay passed within 7 sessions and no day's latest replay differs. Typed confirmation `promote gen-NNN`. The checklist as it stood is stored in `meta_generation.pilot_exit_evidence_json`.

---

## 9. Acceptance criteria mapping

| AC | Satisfied by |
|---|---|
| AC-8 | `qa_quality_report` per run; `qa_domain_day_status` as the sole usability API; QC-001…009 cannot be disabled |
| AC-9 | §7.1 email on every run incl. green; open-exception totals in every email; QC-954 aging; §5.1 no auto-resolve without remediation |
| AC-10 | `qa_check_registry.fired_total`; `qa_check_result.distribution_json` + `extreme_keys_json` on every evaluation; QC-952 zero-fire list and QC-955 threshold-distance report at pilot exit |
| AC-12 | §6 enumerated list; `remediations_json` on every exception; no check or remediation has a delete/update path |

## 10. Open items

### 10.1 Closed 2026-09-05

- **Deep link from the email into the exceptions view** — grammar fixed in 05 §11.1; the email's link is `tradeanalyzer-next://exceptions?run=<run_id>`. Navigation only: a deep link never resolves an exception or runs a job.
- **Whether the watchdog also verifies that the *existing* app's brief ran** — **no.** The watchdog is "the email that reports no email" for the collector (P9) and nothing else. Making it alarm on a second, independent system means a red watchdog no longer has one meaning, and the new app would own an alarm for behaviour it does not control. The existing app already emails its own brief; that mail's absence is the operator's signal, and `legacy_brief_run` records the fact for later study either way.

### 10.2 Still open, by design

- Every threshold marked **†** — set from the distribution observed over the first 20 pilot runs (§8, QC-955), not guessed beforehand. Each carries its draft value until then; the severity declared in §3 applies from the first run, so a draft threshold on a `blocking` check can halt a pilot run. That is intended during the pilot — the generation is not `production` — but it is the reason pilot exit requires 20 *clean* days rather than 20 days. Values marked **‡** are already measured (§3) and are not part of this list.
- **Of the seven † values drafted as "measurable before the pilot", only four are** — corrected 2026-09-06 after working the list. Measurable and now measured: the chain-subset admitted count (rule changed to `$233M`), QC-201 bar completeness (0.55 % steady-state floor), QC-101 universe drift (partial, additions only). Measurable but **blocked on an E*Trade re-auth**: QC-407 underlying disagreement and QC-410 Greek reproduction. **Not measurable against the old data at all** — QC-301 quote completeness and QC-302 close disagreement (`quote_cache` is keyed on ticker and keeps no history) and QC-702 shares-outstanding drift (no share-count and no `cik` column is populated anywhere in that schema). Those three † values now belong to the pilot's first-20-run distribution like the rest, and the pilot is the *first* time the quantity exists. Full evidence per item in 04 §11.
  - The shape of that error is worth keeping: **the list was drawn up by asking which checks compare quantities the old app also computes, not by confirming the old app ever stored them.** Three of seven compared against a column that is present in the schema and empty in practice, or absent entirely — a distinction no amount of reading the DDL would have surfaced.
