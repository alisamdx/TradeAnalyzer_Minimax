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
- **Every check records how often it fired**, evaluated-count and fired-count per run, so a check that has never fired over the pilot is identifiable at exit (P10, AC-10).

---

## 2. Severity and the usability verdict

| Severity | Effect on the domain-day | Email placement | Typical cause |
|---|---|---|---|
| `blocking` | `unusable` until every blocking exception on that domain-day is `resolved` or `accepted` | first section, always | missing data, wrong data, a provider cap hit, a discontinuity with no explaining action |
| `warning` | `usable_with_warnings`; flagged in the inspector | second section | cross-source drift inside tolerance bands, a fallback source used, late filer |
| `info` | no effect | count only | a sticky contract expired and left the set, a capture-rule version changed |

`qa_domain_day_status.status ∈ { usable, usable_with_warnings, unusable, not_run }`. `not_run` is set for every (domain, trading day) the calendar expected but no run covered, and is itself surfaced by the watchdog (§7.3). `meta_run.usable` is `1` only when **every** domain-day the run wrote is not `unusable`.

Severity is a property of the **check**, with two adjustments: escalation (§5.4) can raise it one level; a check definition may declare a **threshold that promotes** it (e.g. a cross-source drift is `warning` per ticker but `blocking` when it affects > 2 % of tickers on the day).

---

## 3. Check catalogue

Each check: id, severity, condition that fires it, and the remediation it is allowed to request (from the §6 list) or `none`. Thresholds marked † are working values to be measured on the pilot (P10) and are stored on the check registry row, not hard-coded.

### 3.1 Cross-cutting checks (run on every table the run wrote)

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-001 provenance | blocking | any raw row has null `source_response_id`, or its `meta_response` row is missing / `parse_status = failed` | none |
| QC-002 archive integrity | blocking | sampled archive lines (≥ 50 per run + every account-domain line) fail `sha256` match or fail to decompress/decrypt | none |
| QC-003 dictionary conformance | blocking | a column exists in the DB that is not in `meta_dictionary`, or vice versa; a column's declared type/enum set is violated | none |
| QC-004 null discipline | blocking | a non-nullable column is null; a nullable column is null with a status column that is not one of the standard values; a value column is non-null while its status ≠ `ok` | none |
| QC-005 mutation guard | blocking | the raw-table `UPDATE`/`DELETE` triggers logged any attempt this run (AC-2) | none |
| QC-006 run completeness | blocking | the run did not reach every domain its capture rules scheduled (e.g. crashed after bars, before chains) | R1 retry the missing domains |
| QC-007 capture-rule reference | blocking | a snapshot row references a `capture_rule_id` not in force on `as_of_date` (P6) | none |
| QC-008 provider cap | blocking | any `meta_response.at_provider_cap = 1` that was **not** followed by a subdivided sweep covering the same window | R4 subdivide |
| QC-009 duplicate natural key within a run | warning | the same natural key stored twice in one run (idempotence bug) | none |

### 3.2 Universe, reference, calendar

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-101 universe drift | warning → blocking if > 5 % † | current membership changed by more than N tickers since yesterday without an `index_add/drop` reason | none (operator confirms rebalance) |
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
| QC-203 non-final bar | warning | a bar fetched before the settlement window (`is_final = 0`) was **not** re-fetched by run end | R3 re-fetch final |
| QC-204 discontinuity | blocking | \|close/prev_close − 1\| > 40 % † with no `raw_split`/`raw_dividend` (special) on the boundary | R5 whole-range re-fetch + re-check; if still present → stays open for operator (ticker reuse vs genuine move, per the volume test below) |
| QC-205 volume regime shift | blocking | 20-day median volume after a discontinuity ≥ 15× † or ≤ 1/15 the 20-day median before it (ticker-reuse signature) | none — operator decides (truncate-before-splice is an operator action, §6) |
| QC-206 series consistency after re-fetch | blocking | a re-fetched series disagrees with the stored series by > 0.5 % † on any date **without** an intervening corporate action (the adjustment basis changed) | none — new rows are already appended (P1); the exception documents the basis change |
| QC-207 gap in trading days | warning | a ticker active on both sides has no bar for a trading day in between | R2 re-fetch range |
| QC-208 zero-volume trading day | warning | `volume = 0` on a trading day for an active ticker | none |

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
| QC-404 bid/ask sanity | warning | `bid > ask`, or `ask > 3 × underlying_price` | none (mark `invalid`) |
| QC-405 IV range | warning | `iv` outside (0, 5] stored as `invalid`; blocking if > 10 % of contracts in a run | none |
| QC-406 ladder integrity | warning | strikes for an (expiration, right) not strictly increasing, or a strike appears once as call and not as put | none |
| QC-407 underlying disagreement | warning | \|`underlying_price` − `raw_eod_quote.last`\| / last > 1 % † | none |
| QC-408 zero-volume default | blocking | any `volume = 0` with `volume_status = ok` **and** `open_interest = 0` **and** bid = ask = 0 — the fingerprint of a defaulted field, not a quiet contract | none (bug) |
| QC-409 sticky-set honoured | blocking | a `ref_sticky_contract` with `valid_to ≥ today` has no snapshot row this run | R1 retry |
| QC-410 Greek reproduction | warning | Black-Scholes delta from (`underlying_price`, `strike`, DTE, `iv`, 3M yield) differs from `delta` by > 0.05 on > 5 % of ATM contracts † (checks E*Trade's Greeks are on the scale we think; P4) | none |
| QC-411 weekend expiration | blocking | an `expiration_date` that is not a trading day and not the day after a holiday-shifted Friday (the Saturday bug) | none |

### 3.6 Corporate actions, earnings, fundamentals

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-501 unexplained discontinuity | blocking | (alias of QC-204 seen from this domain) a bar discontinuity with no action within ±1 trading day | R6 per-ticker action re-fetch |
| QC-502 action without effect | info | a `raw_split` whose ratio is not visible in the bar series on `execution_date` (already adjusted; expected) | none |
| QC-601 earnings date slips later | blocking | for a ticker, the newest observed `report_date` is > 14 days † later than the previous observation from the same source | R4 subdivide sweep around the earlier date; stays open until the earlier date is confirmed absent from a non-capped response |
| QC-602 earnings source disagreement | warning | Finnhub vs E*Trade `report_date` differ by > 1 day for the same fiscal quarter | none |
| QC-603 earnings freshness | warning | a CS ticker has no future `report_date` observed within the last 7 runs | R2 re-fetch ticker |
| QC-604 earnings weekend date | warning | `report_date` on a non-trading day (the UTC-Saturday artefact) — stored as observed, flagged | none |
| QC-701 filing freshness | warning at 120 d, blocking at 180 d | a CS ticker with `cik` has no fact with `period_end` within N days | R2 re-fetch submissions |
| QC-702 fact sanity | warning | `Assets < 0`, `Revenues < 0`, or `SharesOutstanding` differs from `raw_ticker_reference.shares_outstanding` by > 25 % † | none |

### 3.7 Account

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-801 balance snapshot | blocking | no balance row this run, or `total_account_value` status ≠ `ok` | R1 retry (with renew) |
| QC-802 position/order reconciliation | warning | a position appeared or disappeared between snapshots with no executed order leg explaining the quantity change within the interval (assignment/expiry/exercise show up as orders or transactions) | R7 transactions fallback pull |
| QC-803 order idempotence | blocking | an `order_id` already stored arrives with different leg data | none |
| QC-804 fills without price | blocking | `filled_quantity > 0` with `average_execution_price` null/0 | none |
| QC-805 transactions unavailable | warning | the fallback endpoint failed this run (known intermittent) | R1 retry once |
| QC-806 encryption | blocking | any account-domain archive file lacks the encryption header (P15) | none — the run is failed |

### 3.8 Macro, rates, sentiment-side domains

| id | sev | fires when | remediation |
|---|---|---|---|
| QC-901 VIX range | blocking | `last` outside [5, 150] or missing | R1 retry |
| QC-902 yield curve | warning | fewer than 9 tenors, or any yield outside [−0.01, 0.25] | R1 retry / fallback source |
| QC-903 macro calendar gap | warning | no FOMC event in the next 90 days, or no CPI in the next 45 | none |
| QC-904 short interest freshness | warning | newest `settlement_date` older than 21 days | R1 retry |
| QC-905 recommendation freshness | warning | no recommendation row for a CS subset ticker within 45 days | R2 re-fetch |
| QC-906 insider parse | warning | a Form 4 filing indexed but no transaction rows parsed | none |

### 3.9 Periodic checks (not every run)

| id | sev | cadence | fires when |
|---|---|---|---|
| QC-951 replay equivalence | blocking | weekly, on a sampled trading day | replaying that day's archive into a scratch DB yields raw/derived rows that differ from stored (AC-4) |
| QC-952 fire-count review | info | at pilot exit and monthly | lists every check with `fired_total = 0` for operator review (P10) |
| QC-953 archive/DB drift | blocking | weekly | a `meta_response` row's archive line is missing, or an archive line has no `meta_response` row |
| QC-954 exception aging | warning | daily | an `open` exception older than 5 runs with no acknowledgement |

---

## 4. Tables

### `qa_check_registry`
Generated from code at startup; the fire statistics are updated by the gate.

| column | notes |
|---|---|
| `check_id` | `QC-nnn` |
| `domain`, `default_severity`, `description`, `reads_tables_json` | |
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

### `qa_exception`
One per distinct finding, persistent across runs.

| column | notes |
|---|---|
| `exception_id` | |
| `fingerprint` | `sha1(check_id + domain + key)` — the identity that makes tomorrow's recurrence the same exception |
| `check_id`, `domain`, `key` | key = ticker / osi_symbol / order_id / date as appropriate |
| `severity` | current, after escalation |
| `base_severity` | the check's default at creation |
| `state` | `open` \| `acknowledged` \| `resolved` \| `accepted` |
| `detail` | one line, human |
| `evidence_json` | offending values, expected vs actual |
| `first_seen_run_id`, `last_seen_run_id`, `consecutive_runs` | |
| `remediations_json` | list of `{ code, at, outcome }` (§6) |
| `resolved_at`, `resolution_note`, `resolution_kind` | `data_corrected` \| `provider_fixed` \| `rule_changed` \| `false_positive` |
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
            └──── accept ─────┴──▶ accepted ──expiry──▶ open (re-examined)
```

| Transition | Actor | Rule |
|---|---|---|
| create → `open` | gate | first run where the fingerprint fires |
| `open` → `acknowledged` | operator | note optional; stops QC-954 aging |
| `open`/`acknowledged` → `resolved` | operator, **or** gate | gate may resolve only when the *same fingerprint* evaluates clean **and** a remediation in `remediations_json` succeeded — never merely because it stopped firing (P9) |
| `open`/`acknowledged` → `accepted` | operator only | note **required**, `accepted_until` required (default +30 d); domain-day becomes usable |
| `accepted` → `open` | gate | on `accepted_until` passing while the fingerprint still fires |
| `resolved` → `open` | gate | fingerprint fires again; `consecutive_runs` resets; email calls it out as a *recurrence* |

An exception whose fingerprint stops firing without a remediation stays `open` and is listed as "no longer observed, unresolved" — because "it went away" is exactly how the earnings-date bug hid.

### 5.2 Effect on usability

Recompute `qa_domain_day_status` for every date in `affects_trading_dates_json` on any state change. `unusable` iff any blocking exception on that domain-day is `open` or `acknowledged`.

### 5.3 Fingerprint keys by domain

bars / quotes / reference: `ticker` (+ `trade_date` for QC-204/205/206); chains: `ticker` for coverage checks, `osi_symbol` for contract checks; earnings: `ticker` + fiscal quarter; account: `order_id` / `symbol`; cross-cutting: `table` + `run`.

### 5.4 Escalation

If the same fingerprint fires on **3 consecutive runs** † while `open`, severity is promoted one level (`info → warning → blocking`) and the email names it under "Repeat offenders". Escalation is recorded in `qa_exception_event` with actor `escalation`. Severity never drops automatically.

---

## 6. Permitted automatic remediations (P12)

The gate may request only these, each additive and idempotent. Every attempt is appended to `remediations_json` with its outcome. Anything not listed is an operator action performed through the inspector, which records the actor.

| code | action | allowed for |
|---|---|---|
| R1 | retry the same call once (after E*Trade renew if applicable) | any transient failure |
| R2 | re-fetch a single ticker's data for the domain | missing/stale ticker |
| R3 | re-fetch today's bar after the settlement window | non-final bar |
| R4 | subdivide a swept window and re-fetch the halves | provider cap |
| R5 | re-fetch a ticker's **whole** bar range and re-run QC-204/205/206 on the new rows | discontinuity |
| R6 | re-fetch a ticker's splits + dividends | unexplained discontinuity |
| R7 | pull the transactions fallback for the interval | position/order mismatch |

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
  bars                        1,581    1,581   usable
  quotes                      1,581    1,579   usable_with_warnings
  chains (312 tickers)        2,406 calls  2,406   usable
  earnings                    event    +41     unusable (QC-601 until resolved)
  account                      1 bal / 14 pos / 3 orders   usable
  …

OPEN EXCEPTIONS  12 open · 4 acknowledged · 2 accepted (expiring: QC-205 MRNA in 6d) · 3 resolved today
Zero-fire checks this pilot: 9 of 63   (list at pilot exit)

→ Exceptions view: tradeanalyzer-next://exceptions?run=412
```

Rules: blocking first; one line per exception with key, evidence, remediation outcome and age; counts only for warnings; the domain table always present; the open-exception totals always present (P9: nothing ages out silently); plain-text body with an HTML twin; no links that require a session (the deep link opens the new exe).

### 7.3 Watchdog — the email that reports no email

A dead scheduler produces no run and therefore no gate and no email. A separate, tiny job in the hosting app (`collector-watchdog`, scheduled 19:30 ET on trading days) checks `meta_run` for a completed run with today's `trading_date`; if none, it sends `[TA-Data] 2026-09-05 — NO RUN` and writes `not_run` into `qa_domain_day_status` for every domain. The watchdog's own failure is the residual risk; it is intentionally the simplest code in the system.

---

## 8. Pilot exit (P14, P10)

The gate computes and the email shows a **clean-day streak**: consecutive trading days on which every domain-day is `usable` or `usable_with_warnings` with **zero open or acknowledged blocking exceptions** at end of run. When the streak reaches 20 †:

1. QC-952 produces the **zero-fire list** — every check with `fired_total = 0`. The operator reviews each: keep (plausibly rare), fix (the condition can never be true as written), or drop. Decisions recorded on the registry row.
2. The **fired distribution** per check is stored (how often, which tickers) so thresholds marked † are set from data, not defaults.
3. The operator confirms every domain has been visually inspected (D5) — a checkbox per domain in the inspector, recorded with a timestamp.
4. `meta_generation.status` → `production`, `pilot_exit_at` set. Downstream stages may now read.

A reset (P14) restarts the streak at 0 in the new generation.

---

## 9. Acceptance criteria mapping

| AC | Satisfied by |
|---|---|
| AC-8 | `qa_quality_report` per run; `qa_domain_day_status` as the sole usability API; QC-001…009 cannot be disabled |
| AC-9 | §7.1 email on every run incl. green; open-exception totals in every email; QC-954 aging; §5.1 no auto-resolve without remediation |
| AC-10 | `qa_check_registry.fired_total`; QC-952 zero-fire list at pilot exit |
| AC-12 | §6 enumerated list; `remediations_json` on every exception; no check or remediation has a delete/update path |

## 10. Open items

### 10.1 Closed 2026-09-05

- **Deep link from the email into the exceptions view** — grammar fixed in 05 §11.1; the email's link is `tradeanalyzer-next://exceptions?run=<run_id>`. Navigation only: a deep link never resolves an exception or runs a job.
- **Whether the watchdog also verifies that the *existing* app's brief ran** — **no.** The watchdog is "the email that reports no email" for the collector (P9) and nothing else. Making it alarm on a second, independent system means a red watchdog no longer has one meaning, and the new app would own an alarm for behaviour it does not control. The existing app already emails its own brief; that mail's absence is the operator's signal, and `legacy_brief_run` records the fact for later study either way.

### 10.2 Still open, by design

- Every threshold marked † — set from the distribution observed over the first 20 pilot runs (§8), not guessed beforehand. Each carries its draft value until then; the severity declared in §3 applies from the first run, so a draft threshold on a `blocking` check can halt a pilot run. That is intended during the pilot — the generation is not `production` — but it is the reason pilot exit requires 20 *clean* days rather than 20 days.
