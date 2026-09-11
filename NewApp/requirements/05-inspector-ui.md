# 05 — The inspector UI (stage 1 of the new exe)

> **Status:** draft v1, 2026-09-05. Implements D5 and P13 (everything stored is visible), the operator side of P9/P12 (exception resolution), and the operator side of P14 (reset, replay, pilot exit). Reads the tables in 02 and 03; launches the jobs in 04. Sourced from D5, Q12, Q14, Q18, Q19.
> **Acceptance criteria owned here:** AC-13; shares AC-1, AC-3, AC-14 with 02/04.
> **What it is not:** there is no screener, scoring, chart analysis, recommendation or AI anywhere in this UI. Stage 1's UI exists so the operator can *look at the data and the machinery that produced it*, and so the exception workflow has a place to happen.

---

## 1. Purpose

The operator's method is to look at data and let it raise the next question. Stage 1's UI therefore has one job: **make every stored fact, its provenance, its quality verdict and its history inspectable without writing code**, and make the resolution of a finding a two-click act rather than a script.

Two design commitments follow:

1. **Generic first.** Every table renders through one schema-driven inspector that reads `meta_dictionary`. A table becomes visible the moment its dictionary entry exists (AC-13). Bespoke views are added only where shape matters, and never as the only way to see a table.
2. **Nothing hidden by formatting.** Display formatting (fraction → percent, epoch → time) is a *presentation toggle* with the raw stored value always one click away. A null is never rendered as blank: its status is shown (P3).

---

## 2. Information architecture

Sidebar, top to bottom. Each entry names the tables it reads.

| Section | Purpose | Reads |
|---|---|---|
| **Overview** | today at a glance: generation, pilot streak, last run verdict, domain table (the email, live), open-exception counts | `meta_generation`, `meta_run`, `qa_domain_day_status`, `qa_exception` |
| **Exceptions** | the resolution workbench (§5) | `qa_exception`, `qa_exception_event`, `qa_check_registry` |
| **Runs** | every collector run, phases, calls, quality report, email preview | `meta_run`, `meta_response`, `qa_quality_report`, `qa_check_result` |
| **Data** | the schema-driven inspector, grouped by prefix then domain (§3) | any table |
| **Bars** | price/volume chart with actions, discontinuities and series versions (§4.1) | `raw_daily_bar`, `raw_split`, `raw_dividend`, `qa_exception` |
| **Chains** | the option-chain grid by ticker/date/expiration (§4.2) | `raw_option_expiration`, `raw_option_contract_snapshot`, `ref_sticky_contract` |
| **Earnings** | calendar with per-ticker observation history (§4.3) | `raw_earnings_event` |
| **Account** | positions by snapshot date, executed orders, balances over time (§4.4) | `raw_account_*`, `raw_executed_order*` |
| **Universe** | membership and chain-subset timelines (§4.5) | `ref_universe_membership`, `ref_chain_subset_membership`, `raw_ticker_reference` |
| **IV** | own-computed IV30 vs external bootstrap, stitch date (§4.6) | `derived_iv30_daily`, `ext_iv_history` |
| **Archive** | provenance browser: any response by id, date, provider, endpoint (§3.4) | `meta_response` + archive files |
| **Legacy** | the segregated record of the existing app's decisions, read-only, visibly separate (§4.7) | `legacy_*` |
| **Dictionary** | every table and column with type, unit, nullability, null meaning, source; the pilot-exit checklist (§6) | `meta_dictionary`, `qa_check_registry` |
| **Jobs** | one-shot jobs: seed, backfill, bootstrap, import, replay, reset (§7) | `meta_job_request`, `meta_run` |
| **Settings** | generation paths, email recipients, capture-rule editor (creates versions), thresholds (creates registry versions) | `meta_capture_rule`, `qa_check_registry`, settings |

Cross-navigation is by **entity link**: any ticker, `osi_symbol`, `run_id`, `source_response_id`, `exception_id` or `check_id` rendered anywhere is a link to its home view with context preserved.

---

## 3. The schema-driven inspector (Data)

### 3.1 What it renders, from the dictionary alone

| Dictionary field | Rendering |
|---|---|
| `type`, `unit` | column header shows unit badge (`USD/sh`, `fraction`, `count`, `ET date`); numeric alignment; fraction columns have a header toggle **raw / %** (default %, stored value on hover) |
| `nullable`, `nullMeaning`, `statusColumn` | a null cell shows a **status glyph** and the meaning on hover: `omitted` (hollow circle), `outside_window` (dashed), `invalid` (warning triangle, raw value from archive on click), `not_applicable` (dash). Never blank |
| `description`, `sourceProvider`, `sourceField` | column header tooltip; row-detail drawer |
| enum sets | filter chips |
| `converter` | shown in the detail drawer so the operator can see "0.3882 stored ← 0.3882 E*Trade `OptionGreeks.iv`, no conversion" |

### 3.2 Controls on every table

- **Filters**: per column (typed: range for numbers, date-range for dates, chips for enums, contains for text); global quick filters for `ticker`, `as_of_date`, `run_id`; saved filter sets per table.
- **Version mode** (P1): `latest as of <date>` (default: one row per natural key, latest `observed_at ≤ date`) or `all versions` (every row, with a "superseded" marker on older ones). The natural key comes from the dictionary.
- **Quality overlay**: a column showing the domain-day status badge for the row's `(domain, as_of_date)`, and a row highlight when the row's key appears in an open exception (click → the exception).
- **Sort** on any column; **keyset pagination** (never offset on the chain table); visible **row count** for the current filter (exact, computed off the main thread for tables > 1 M rows).
- **Row detail drawer**: every column with description and unit, the raw stored value, the status columns, links: *open source response*, *open run*, *related exceptions*, *same key across dates* (mini-history).
- **Export**: current filter to CSV, in stored units (no display formatting), with a header row of units, written where the operator chooses. Account tables export only after a confirmation that names the sensitivity.

### 3.3 Grouping

Tables are grouped by prefix (`meta_ / ref_ / raw_ / ext_ / derived_ / legacy_ / qa_`) and, inside `raw_`, by domain in the order of 02. A table's row count and the date of its newest row show in the tree, so an empty or stale table is visible without opening it.

### 3.4 Provenance viewer (Archive)

Opened from any row's *open source response*, or by browsing `meta_response`. Shows: request (provider, endpoint with masked key, params), response (status, latency, size, `sha256`, `at_provider_cap`), the **body pretty-printed** with search, and *rows parsed from this response* (count + link into the inspector filtered by `source_response_id`). Account-domain bodies are **decrypted in the main process, streamed to the renderer, never written to disk** (P15); the viewer shows the encryption header status. A body that fails `sha256` or decryption is shown as such with the QC-002 exception linked.

---

## 4. Bespoke views

Each is a shape-specific rendering of tables that are also fully visible in §3.

### 4.1 Bars
Candlestick + volume for one ticker over a chosen range (lightweight-charts, already in the stack). Overlays: split markers (ratio label), dividend ex-dates (amount), earnings dates, open QC-204/205/206 exceptions as flagged bars. **Series versions**: when a ticker has more than one `adjusted_as_of`, the chart can overlay versions to show exactly where a re-fetch changed the past. Toggle `is_final` shading. No indicators — this is a data view, not analysis.

**How the domain views stay inside AC-13** (settled at B6). Chains and Account are lenses on tables the generic Data view already renders, and they need a *layout* the generic view cannot give — calls beside puts, provider estimates in their own band. What they must not become is a second, hand-written description of those tables. So the column list is chosen **in the main process**, which owns SQL and the dictionary anyway, and every label, unit and declared null meaning is read from the dictionary entry; the renderer receives `{ key, label, unit, nullMeaning, group }` and cells of `{ value, status }`, and names no column of any table. AC-13's structural test therefore still passes over the whole renderer, and adding a column to a domain view is a dictionary change plus one line of a main-process pick list.

### 4.2 Chains
Selectors: ticker, `as_of_date` (defaults to latest run), expiration (from `raw_option_expiration` with window reason badges: `within_max_dte`, `extra_monthly`, `sticky`, `outside` greyed). Grid: calls left, puts right, strikes centre; columns `bid ask last iv delta gamma theta vega oi volume` with status glyphs; ATM row highlighted from `underlying_price`; sticky contracts marked with their reason. **Compare mode**: a second `as_of_date` renders deltas per cell. **Contract history**: click a strike → the `osi_symbol` across every date it was captured, with gaps labelled by their cause (`outside_window` vs not captured because the ticker was not in the subset). Study flag: right-click a contract → *pin for study* (writes `ref_sticky_contract`, reason `study_flag`, with a note) — **deferred to B9** with the rest of the operator write path, so every button in the inspector that changes stored state lands against the same reviewed plumbing rather than one view growing its own.

### 4.3 Earnings
Month calendar of report dates for the universe (or a watch subset), each with `report_time` and source badges. Per ticker: the **observation history** — every `report_date` ever observed, by source and `observed_at`, so a date that moved is visible as a trail (QC-601 links here). Filter: "moved later > 14 d", "sources disagree".

### 4.4 Account
Positions as of a chosen snapshot date, with the diff against the previous snapshot (appeared / disappeared / quantity changed) and the executed-order legs that explain each change, or a QC-802 marker where none does. Executed orders list with legs, `order_action`, fill price, commissions. Balances chart over time. Provider gain fields shown in a visibly separate "provider estimates" column group (02 §10). No derived P&L (Q13).

### 4.5 Universe
Timeline of `ref_universe_membership` (adds/drops by list source, ticker changes with lineage) and `ref_chain_subset_membership` (admissions with `rule_inputs_json` values, sticky reasons, removals). Ticker page: reference history (sector/market-cap changes as rows), membership spans, counts of rows per raw table.

### 4.6 IV
Per ticker: `derived_iv30_daily` and `ext_iv_history` on one chart, the stitch date as a vertical line, the overlap window shaded, and the paired-difference distribution from the bootstrap's quality report. `status` values (`insufficient_expirations`, `no_atm_quotes`) shown as gaps with glyphs, never interpolated.

**An absent overlap must be as visible as a present one.** A shaded band that is simply not drawn looks identical to a clean join, which is the whole failure this view exists to prevent — so when a series has `accepted = 0` the chart states the paired-day count against the 20 it needs, labels the external series *unaccepted — not used for rank*, and draws no stitch line, because there is not one yet. Any rank or percentile computed with external rows carries that label wherever it is shown (04 §7.3).

### 4.7 Legacy
Visibly framed as *the existing app's record*: brief runs by date and slot; per run the **full candidate list** with survived/rejected, each gate's pass/fail and tested value vs threshold, signals, priced legs, dice trace, critic verdict. `pre_collector = 1` rows carry an "incomplete (pre-collector import)" banner. Read-only; no joins to `raw_` tables are offered in stage 1 (segregation, Q6).

---

## 5. Exceptions workbench

The place where 03 §5 happens.

- **List**: filters by state (default `open` + `acknowledged`), severity, domain, check, key, age, "recurrence", "escalated", "accepted expiring ≤ 7 d". Columns: severity, check, domain, key, detail, first/last seen, consecutive runs, remediation outcome, affected days.
- **Detail**: evidence (expected vs actual, with the offending rows inline via the inspector), remediation log, the event trail, affected domain-days with their current status, links to the check's registry entry (description, thresholds in force, fire history), the source response, the run.
- **Actions** (each writes `qa_exception_event` with the operator as actor and recomputes `qa_domain_day_status`):
  - **Acknowledge** (optional note).
  - **Resolve** — requires `resolution_kind` and a note; refused if the fingerprint fired on the most recent run (the data still shows the condition), with the refusal explained.
  - **Accept** — requires a note and `accepted_until` (default +30 d, max +180 d); shows which domain-days become usable.
  - **Bulk acknowledge** for a filtered set; bulk resolve/accept is deliberately **not** offered.
  - **Operator-only remediations** (03 §6) launch from here with a confirmation naming the action: confirm ticker reuse (writes the membership `valid_to` + lineage), remove from chain subset, change a threshold (opens Settings → new registry version).
- **Zero-fire list** (QC-952): a tab listing checks with `fired_total = 0`, each with keep / fix / drop and a note, recorded on the registry row (P10).

---

## 6. Dictionary and pilot-exit checklist

The Dictionary view lists every table and column as the dictionary declares them, with live row counts and null-rate per column over the last 20 runs (so a column that is *always* null is obvious — D7). It also hosts the **pilot-exit checklist** (P14): per domain a "visually inspected" checkbox with timestamp and note, the clean-day streak, the zero-fire review status, and the **Promote to production** action, enabled only when all three conditions hold.

---

## 7. Jobs

One card per one-shot job (04 §7) with its last run, duration, verdict and a **Run** button.

**This view queues; it does not execute.** In stage 1 the old app holds the provider transports and the E*Trade token (Q4), so pressing Run inserts a `meta_job_request` row and the old app's `collector-oneshot` handler claims it within ~2 minutes (04 §1.1). The card therefore has a state the operator can see and must be able to read honestly: `queued (waiting for the collector host, last seen 14s ago)` → `running` → the verdict. A request that stays `queued` for more than 10 minutes is shown as **stalled**, with the plain explanation that the collector host is not running — this is the failure mode a queue introduces, and hiding it behind a spinner would make it look like a slow job (P9 applied to the UI). Cancel is available while `queued`; once `claimed`, cancellation goes through the run's own abort signal.

**Revised at B9a (2026-09-10): nothing claims a request on its own.** The ~2-minute claim above was the `collector-oneshot` loop, removed in v1.1.206 after it re-ran one unfinishable request ~70 times and emailed a RED report each time. A queued request now waits until the operator runs *Collector one-shot jobs* from the old app's Batch view — one request per press, oldest first — and the view says exactly that, in a banner and on every waiting row, rather than "the collector host is not running". `stalled` still appears after 10 minutes, with that instruction. Three further decisions: **reset is not queued** (the new exe performs it, 04 §7.6); **a second request for a kind that already has one queued, claimed or running is refused**, so a double click cannot queue two backfills; and **cancel is the same conditional UPDATE as the claim** (`WHERE state = 'queued'`), so a cancel and a claim that race cannot both win. `replay` became queueable at B9b, with an optional run id (blank = the latest completed daily run, checked in the main process before the row is written); its report opens as the diff viewer — coverage first, because "equal over half the responses" and "equal over all of them" are different findings, then per-table stored / replayed / matched / added / removed / changed with sample rows drawn from whatever columns they carry.

Confirmations scale with consequence:

| Job | Confirmation |
|---|---|
| `universe_seed`, `backfill_bars`, `bootstrap_iv` | single confirm with call estimate and provider |
| `legacy_import` | confirm; the call-out states that it reads the old app's database live and writes nothing to it |
| `replay` (to scratch) | confirm; result opens the **diff viewer**: per table rows added / removed / changed, drill to rows |
| `replay` (to new generation) | typed confirmation of the source generation number |
| `reset` | typed confirmation `RESET gen-NNN` + mandatory reason; shows what will be kept (everything) and what a reset costs (data-days since `opened_at`) |

Job progress reaches the card by polling `meta_run.phase_progress_json` on the request's `run_id` (the two apps share only the database — 05 §8 live-updates rule), and appears in the Runs view like any other run. A `reset` that completes causes the new exe to re-read the shared data-root pointer and reopen on the new generation without a restart (04 §7.6).

---

## 8. Non-functional requirements

- **Process boundaries**: renderer never touches the database, files or network (`contextIsolation`, no `nodeIntegration`); all access through a typed `window.api` surface (§9). The main process opens the generation database **write-capable** (WAL quirk) even though stage 1's UI writes only `qa_` state, `ref_sticky_contract` (study flags), settings and job launches.
- **Responsiveness**: any query over the chain table or an aggregate over > 1 M rows runs in a **worker thread** with its own connection; the main thread never blocks > 50 ms on the database. Keyset pagination everywhere; every inspector filter maps to an index declared in **02 §0.6** or the query is refused with a message naming the column and pointing at the dictionary, rather than run unbounded. The declared set is deliberately generous — every filterable column on every table — so the refusal is a real safety net for a *new* column someone forgot to index, not a wall the operator meets daily.
- **Live updates**: the collector (in the old app) and the inspector (new exe) are different processes on the same file. The inspector polls `meta_run` every 30 s while a run is `running` and refreshes views on completion; no cross-process push in stage 1.
- **Read-your-own-generation**: the UI always shows which generation it is looking at; closed generations open read-only in a second window with a distinct frame colour.
- **Time**: all dates and times displayed in ET with the offset visible; the stored ISO string on hover.
- **Accessibility and theme**: light/dark; keyboard navigation in grids; status glyphs carry text labels for screen readers and colour-blind safety (never colour alone).
- **Security**: decrypted account bodies live only in memory; export of account tables requires confirmation; no external links that carry a session (CLAUDE.md E*Trade link quirk); the email deep link `tradeanalyzer-next://…` is registered by the new exe.

---

## 9. IPC surface (typed, `window.api.*`)

| namespace | methods (all return `IpcResult<T>`) |
|---|---|
| `generation` | `current()`, `list()`, `open(no)` |
| `dictionary` | `tables()`, `columns(table)`, `stats(table)` (row count, newest `as_of_date`, null rates) |
| `inspect` | `query(table, filter, sort, cursor, versionMode)`, `count(table, filter)`, `row(table, rowId)`, `history(table, naturalKey)`, `exportCsv(table, filter, path)` |
| `archive` | `response(id)`, `body(id)` (decrypts in-process), `rowsFrom(id)`, `search(provider, date, endpoint)` |
| `runs` | `list(range)`, `detail(runId)`, `report(runId)`, `emailPreview(runId)`, `resendEmail(runId)` |
| `exceptions` | `list(filter)`, `detail(id)`, `acknowledge(id, note?)`, `resolve(id, kind, note)`, `accept(id, until, note)`, `bulkAcknowledge(ids, note?)`, `zeroFire()`, `reviewZeroFire(checkId, decision, note)` |
| `domainStatus` | `matrix(range)` (domain × day grid), `day(domain, date)` |
| `bars` | `series(ticker, range, versions?)`, `markers(ticker, range)` |
| `chains` | `expirations(ticker, date)`, `grid(ticker, date, expiration)`, `contractHistory(osi)`, `pinForStudy(osi, note)` |
| `earnings` | `calendar(range, tickers?)`, `history(ticker)` |
| `account` | `positions(date)`, `positionDiff(date)`, `orders(range)`, `balances(range)` |
| `universe` | `memberships(range)`, `subset(range)`, `ticker(ticker)` |
| `iv` | `series(ticker)`, `bootstrapReport()` |
| `legacy` | `runs(range)`, `run(legacyRunId)` |
| `jobs` | `list()`, `queue(kind, params)`, `requests(filter)`, `cancelRequest(id)`, `progress(runId)`, `replayDiff(runId)`, `reset(reason, confirmation)`, `promoteToProduction(checklist)` — `queue` writes a `meta_job_request` row and returns its id; nothing here executes a job in stage 1 |
| `settings` | `get()`, `set(patch)`, `captureRules()`, `newCaptureRuleVersion(domain, definition, description)`, `checkRegistry()`, `newThresholds(checkId, thresholds, note)` |

Every write method records the operator as actor in the relevant audit table (`qa_exception_event`, `meta_capture_rule`, `qa_check_registry`, `meta_generation`). No method deletes.

---

## 10. Acceptance criteria mapping

| AC | Satisfied by |
|---|---|
| AC-13 | §3: the inspector renders any table from `meta_dictionary`; a test creates a throwaway dictionary entry + table and asserts it appears with sort/filter/null glyphs and no code change |
| AC-3 | §3.1 null glyphs + hover meanings; §6 Dictionary view shows every column's declaration |
| AC-1 | §3.2 *open source response* on every row → §3.4 |
| AC-14 | §7 reset with typed confirmation; previous generation opens read-only (§8) |
| P9 / AC-9 | §5: state changes only with actor + note; no bulk resolve; refusal to resolve while still firing |

## 11. Deep links, and what stays open

### 11.1 Deep-link grammar (closed 2026-09-05)

Scheme `tradeanalyzer-next://`, registered by the new exe with `app.setAsDefaultProtocolClient`. The grammar is fixed now so the status email (03 §7.2) can be written against it before the handler exists; **registration mechanics land at B9** with the exceptions workbench.

| link | opens |
|---|---|
| `tradeanalyzer-next://exceptions?run=<run_id>` | Exceptions workbench, filtered to that run (the email's link) |
| `tradeanalyzer-next://exceptions/<exception_id>` | one exception, its events and its evidence |
| `tradeanalyzer-next://runs/<run_id>` | that run's phases, responses and quality report |
| `tradeanalyzer-next://table/<table_name>?as_of=<date>` | the inspector on that table at that date |

Rules: the handler **navigates only** — a deep link may never run a job, resolve an exception or mutate anything, because a link that acts is a link an email can be made to act with. An unknown or malformed link opens Overview with a toast rather than failing silently. Windows delivers the URL as `argv` to a *second* instance, so the single-instance lock plus the `second-instance` handler is the real implementation, not `open-url` (that is macOS); in dev the scheme must be registered against the electron binary with the project path as an argument, which is why this waits for B9 rather than being wired at B2.

**Built at B9a (2026-09-10), with one change: the scheme is registered from the packaged exe only.** Registering from dev would point the per-user `tradeanalyzer-next` class at `electron.exe` and overwrite the packaged exe's registration, so every link in the status email would start opening a dev server instead of the installed app. Dev is driven by passing a link as a command-line argument. The parser lives in `packages/next/src/shared/deeplink.ts`, and its return type has **no way to express an action** — every route is a place, so a link an email can be made to carry can at most change which screen is showing. A test pins the grammar to the link `core`'s status email actually writes, since the two were built two steps apart against this section's prose.

### 11.2 Closed

- **Chain-table grid**: no grid library. ~300 rows × 20 columns is a plain `<table>`; windowing is added only where a measurement shows it is needed (the contract-history and inspector views are the candidates, not the chain). Decided at B2 so a dependency is never taken on a guess.
- **Saved "questions"** (a named filter + version mode + column set): **yes**, as leaned — cheap, and it is the honest precursor to stage-2 studies. Built at B9 alongside the workbench; stored in the generation DB as a `meta_` table so a saved question travels with the data it was asked of.

### 11.3 Still open, by design

- Nothing in this document. Remaining open items across the set are the † thresholds (03 §10) and the 04 §11 pre-pilot measurements.
