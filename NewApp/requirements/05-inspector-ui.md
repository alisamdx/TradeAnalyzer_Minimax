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
| **Jobs** | one-shot jobs: seed, backfill, bootstrap, import, replay, reset (§7) | `meta_run` |
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

### 4.2 Chains
Selectors: ticker, `as_of_date` (defaults to latest run), expiration (from `raw_option_expiration` with window reason badges: `within_max_dte`, `extra_monthly`, `sticky`, `outside` greyed). Grid: calls left, puts right, strikes centre; columns `bid ask last iv delta gamma theta vega oi volume` with status glyphs; ATM row highlighted from `underlying_price`; sticky contracts marked with their reason. **Compare mode**: a second `as_of_date` renders deltas per cell. **Contract history**: click a strike → the `osi_symbol` across every date it was captured, with gaps labelled by their cause (`outside_window` vs not captured because the ticker was not in the subset). Study flag: right-click a contract → *pin for study* (writes `ref_sticky_contract`, reason `study_flag`, with a note).

### 4.3 Earnings
Month calendar of report dates for the universe (or a watch subset), each with `report_time` and source badges. Per ticker: the **observation history** — every `report_date` ever observed, by source and `observed_at`, so a date that moved is visible as a trail (QC-601 links here). Filter: "moved later > 14 d", "sources disagree".

### 4.4 Account
Positions as of a chosen snapshot date, with the diff against the previous snapshot (appeared / disappeared / quantity changed) and the executed-order legs that explain each change, or a QC-802 marker where none does. Executed orders list with legs, `order_action`, fill price, commissions. Balances chart over time. Provider gain fields shown in a visibly separate "provider estimates" column group (02 §10). No derived P&L (Q13).

### 4.5 Universe
Timeline of `ref_universe_membership` (adds/drops by list source, ticker changes with lineage) and `ref_chain_subset_membership` (admissions with `rule_inputs_json` values, sticky reasons, removals). Ticker page: reference history (sector/market-cap changes as rows), membership spans, counts of rows per raw table.

### 4.6 IV
Per ticker: `derived_iv30_daily` and `ext_iv_history` on one chart, the stitch date as a vertical line, the overlap window shaded, and the paired-difference distribution from the bootstrap's quality report. `status` values (`insufficient_expirations`, `no_atm_quotes`) shown as gaps with glyphs, never interpolated.

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

One card per one-shot job (04 §7) with its last run, duration, verdict and a **Run** button. Confirmations scale with consequence:

| Job | Confirmation |
|---|---|
| `universe_seed`, `backfill_bars`, `bootstrap_iv` | single confirm with call estimate and provider |
| `legacy_import` | confirm; refuses with an explanation if the existing app is running |
| `replay` (to scratch) | confirm; result opens the **diff viewer**: per table rows added / removed / changed, drill to rows |
| `replay` (to new generation) | typed confirmation of the source generation number |
| `reset` | typed confirmation `RESET gen-NNN` + mandatory reason; shows what will be kept (everything) and what a reset costs (data-days since `opened_at`) |

Job progress streams to the card (phase, done/total, current key) and to the Runs view.

---

## 8. Non-functional requirements

- **Process boundaries**: renderer never touches the database, files or network (`contextIsolation`, no `nodeIntegration`); all access through a typed `window.api` surface (§9). The main process opens the generation database **write-capable** (WAL quirk) even though stage 1's UI writes only `qa_` state, `ref_sticky_contract` (study flags), settings and job launches.
- **Responsiveness**: any query over the chain table or an aggregate over > 1 M rows runs in a **worker thread** with its own connection; the main thread never blocks > 50 ms on the database. Keyset pagination everywhere; every inspector filter maps to an index declared in 02 or the query is refused with a message ("add an index in the dictionary") rather than run unbounded.
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
| `jobs` | `list()`, `run(kind, params)`, `progress(runId)`, `replayDiff(runId)`, `reset(reason, confirmation)`, `promoteToProduction(checklist)` |
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

## 11. Open items for 06 and for the build

- Which lightweight grid component for the chain table (virtualised, ~300 rows × 20 columns per expiration is small; the contract-history and inspector views are the large ones).
- Whether the inspector should support saved "questions" (a named filter + version mode + columns) as a precursor to stage-2 studies. Leaning yes, cheap, deferred to the build.
- Deep-link scheme registration on Windows for `tradeanalyzer-next://`.
