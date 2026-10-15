# 02 — Raw domains and data dictionary

> **Status:** draft v1, 2026-09-05. Derived from `00-discovery-qa.md` (Q1–Q21) and governed by `01-purpose-and-principles.md` (P1–P15). Provider field names in the "source" columns are the ones the existing app's parsers already read (`etrade-options.ts`, `etrade-portfolio-service.ts`, `polygon-provider.ts`, `earnings-refresh`); fields marked **verify** have not been observed in a live response yet and must be confirmed during 04 before the dictionary entry is frozen.
> **Q21 closed 2026-09-05:** the three sentiment-side domains in §12 (short interest, analyst view, insider transactions) are **in scope**. Stage 1 has fifteen raw domains.

---

## 0. Conventions that apply to every table

These implement P1, P3, P6, P7. They are stated once here and not repeated per table.

### 0.1 Storage types and units

| Kind of value | SQLite type | Unit / form | Examples |
|---|---|---|---|
| Ratio, rate, yield, return, IV, Greek | `REAL` | decimal fraction | `0.3882` (not 38.82), `0.0525`, delta `-0.23` |
| Money per share / per unit | `REAL` | USD, per share (never per contract) | `187.25`, option bid `2.15` |
| Money, account level | `REAL` | USD | `cash_available` |
| Quantity | `INTEGER` | count | contracts, open interest, trade sizes |
| Share quantity that can be fractional | `REAL` | `share_quantity` | equity volume (Polygon counts fractional-share trades) — never rounded, never asserted whole |
| Trading day | `TEXT` | `YYYY-MM-DD`, America/New_York | `2026-09-05` |
| Timestamp | `TEXT` | ISO-8601 **with offset** | `2026-09-05T17:02:11-04:00` |
| Flag | `INTEGER` | `0` / `1` | |
| Enumeration | `TEXT` | lower-case, fixed set stated in the dictionary | `right = 'call' \| 'put'` |
| Identifier from a provider | `TEXT` | verbatim | `osi_symbol`, `order_id`, `cik` |
| **Ratio, not bounded to 0..1** | `REAL` | dimensionless | a split of `1` to `4`. **Added at B2**, distinct from `fraction` because rendering it as a percentage is nonsense, and REAL because providers send fractional split ratios |
| **Unit varies per row** | `REAL` | named by a sibling column | `raw_edgar_fact.value`, whose unit is in `raw_edgar_fact.unit` — one column legitimately holds USD, shares, USD/shares and pure numbers. **Added at B2**; the dictionary entry must name the unit column (`unitColumn`), and one that does not is refused, because a per-row unit recorded nowhere is a number nobody can interpret later |

The contract multiplier (100) is **never** applied in a raw table. Provider values are converted once, at ingestion, by the converter named in the dictionary entry (P7). Two dictionary-driven tests exist per converted field: one asserting the conversion, one asserting no other module performs it (AC-7).

### 0.2 Columns on every raw and snapshot table

| Column | Type | Meaning |
|---|---|---|
| `row_id` | `INTEGER PK` | surrogate key, never reused |
| `run_id` | `INTEGER FK → meta_run` | the collector run that wrote the row |
| `as_of_date` | `TEXT` | the trading day the fact is *about* |
| `observed_at` | `TEXT` | when the provider was asked (P1) |
| `capture_rule_id` | `INTEGER FK → meta_capture_rule` | which rule caused this row to exist (P6); null only on tables the dictionary marks "not rule-driven" (reference, calendar) |
| `source_response_id` | `INTEGER FK → meta_response` | the archived provider response the row was parsed from (P2, AC-1) |

**A `derived_` table cannot carry `source_response_id`, and that was found by trying to write one (B7b).** The heading says *raw and snapshot* and the column is defined as "the response the row was parsed from" — but B2 declared `derived_iv30_daily` with the standard columns anyway, so the column was NOT NULL with a foreign key and **phase 9 could not have written a single row**. A derived row is a function of many stored rows (iv30 reads a whole chain across two expirations); naming one contributor would be a provenance claim that is false, and naming none was impossible. On the `derived` layer the column is therefore **nullable with an explicit `nullMeaning`**, and `capture_rule_id`'s null meaning says the row was derived rather than captured. AC-1 is untouched: it is scoped to raw tables, and a derived row's reproducibility guarantee is a different one — `derivation_version` plus the stored inputs (P4). Pinned by a test that also asserts the relaxation does **not** reach the raw layer. Dictionary **v8 → v9**; the table is empty in every generation, so the B7a empty-table rebuild applies it in place.

Raw tables have **no `UPDATE` or `DELETE` path**; a trigger raises on both (AC-2). Supersession is a new row with a later `observed_at`; readers resolve "current as of X" as *latest `observed_at` ≤ X* per natural key. Where a domain needs an explicit validity range (membership tables) it uses `valid_from` / `valid_to` instead.

**Built at B3, and it needed a distinction the draft did not make.** A validity-range table still has to be protected, just not by the same trigger: closing `valid_to` is legitimate and editing the row is not. So a table declaring `validRangeColumn` gets a **narrower** pair of triggers — one refusing any UPDATE that changes a column other than the range and its reason, and one refusing to reopen a range already closed — plus the same DELETE refusal as every other fact table. Turning the guard off for these four tables (`ref_universe_membership`, `ref_chain_subset_membership`, `ref_sticky_contract`, `ref_sic_sector`) would have been the one-line fix and the wrong one: "this membership ended" and "what this membership said" have to stay two different acts, or the range buys nothing over an overwrite.

### 0.3 The status-column pattern (P3)

A value column that could be null for more than one reason gets a companion `<col>_status TEXT` and the value column's null meaning becomes "see status". **Built at B2 as a single call** (`withStatus`) that returns *both* columns, so a status column cannot be forgotten — the pattern is one call, not two entries kept in step by hand — and the generated DDL carries a CHECK that the value is null **exactly when** its status is not `ok`. Without that constraint the pair drifts into a null value with `ok` status (a silent gap) or a present value with `omitted` (a lie), and neither would ever raise. Standard status values:

| Status | Meaning |
|---|---|
| `ok` | value observed |
| `omitted` | provider response did not include the field |
| `outside_window` | not requested because the capture rule excluded it |
| `invalid` | provider sent a value that failed a range/type check; raw kept in archive, value column null |
| `not_applicable` | field has no meaning for this row (e.g. `strike` on a stock position) |

A column with a single possible null meaning states it directly in the dictionary and has no status column.

### 0.4 Naming

Prefixes are load-bearing; the inspector groups by them.

| Prefix | Layer | Writer |
|---|---|---|
| `meta_` | generation, runs, capture rules, response archive index, the data dictionary itself | collector core |
| `ref_` | slowly-changing reference and membership (universe, chain subset, calendar) | collector |
| `raw_` | provider-sourced facts, one domain each | collector ingestion, one module per table (P11, AC-11) |
| `ext_` | one-time external historical series (Q10/Q17 pattern) | one-shot load jobs |
| `derived_` | pure functions of raw (P4); stage 1 has exactly one | derivation module |
| `legacy_` | the existing app's decisions and pre-collector imports (Q6/Q19) | legacy hand-off + import |
| `qa_` | quality reports and exceptions (detailed in 03) | quality gate |

### 0.5 The data dictionary is code

The dictionary is a checked-in TypeScript module in `packages/core` (`dictionary/*.ts`): one entry per column with `table, column, type, unit, nullable, nullMeaning, statusColumn?, converter?, sourceProvider, sourceField, description`, plus one entry **per table** carrying `naturalKey` (the columns that identify a fact across versions — used by version mode and by the replay comparison, 04 §7.5) and `indexes` (§0.6). From it are generated: the DDL, the `meta_dictionary` table the inspector reads, the ingestion converters' type signatures, and the AC-3/AC-7 tests. **A column that is not in the dictionary cannot exist** — DDL generation is the only way a table is created (AC-3, AC-13).

### 0.5a How a generation's schema may change

Within a generation the dictionary may grow by **nullable columns, new tables and new indexes**. A type change, a rename or a unit change would silently reinterpret rows already written, so it is a replay into a new generation (04 §7.5) and `applyDictionary` refuses it.

**Two corrections made 2026-09-07, after the rule as first implemented made the new exe unable to start.**

1. **The rule protects written rows, so an *empty* table is a different case.** Nothing can be reinterpreted that was never recorded, so a reshape of a table holding **zero rows** is applied by rebuilding it from the dictionary (`ApplyResult.tablesRebuilt`), with its indexes and append-only triggers recreated. A table holding even one row keeps the strict refusal, and the error names the row count so the operator can see which it is. B7a's `raw_index_quote` status split was refused against a generation containing **no collected facts at all** — correct by the letter of the rule and pointless in substance.
2. **The check only ever looked one way.** It compared columns the dictionary had *gained* and never ones it had **lost**, so a dropped column stayed in the table — still NOT NULL, still carrying its CHECK — leaving a table that accepts **no inserts at all**. That surfaces much later as a constraint error inside an ingestion transaction, where it reads as a parser fault rather than as schema drift. **A reshape is an add and a remove; catching one of them is not catching the reshape.**

**A third gap, closed 2026-09-07: constraint drift.** `enumOf` bakes its values into a CHECK at CREATE TABLE time, so adding an enum member changes no column name and the column comparison saw nothing — the change would surface as a constraint failure inside an unrelated transaction much later. `applyDictionary` now also compares the whole stored DDL against the generated one. Because that comparison is textual it may only ever **rebuild an empty table**, never refuse a populated one: a normalisation false positive then costs one harmless recreate rather than making the application unopenable. Drift on a populated table is **reported** as `driftBlocked` and not thrown — the rows remain valid under the constraint they were written with, and adopting the new one is a replay into a new generation (04 §7.5).

### 0.6 Declared indexes

The inspector refuses any filter or sort that would scan unbounded (05 §8), so **every column the operator can reasonably filter on must be indexed, and the index must be declared in the dictionary** — the DDL generator emits exactly these and nothing else. Declaring them here rather than per table keeps the set visible as one list, which is how you notice the one you forgot.

| table | indexes (beyond the PK) |
|---|---|
| `meta_response` | `(run_id)`, `(provider, requested_at)`, `(archive_file)`, unique `(dedup_hash)` |
| `meta_run` | `(trading_date, slot)`, `(run_kind, started_at)` |
| `meta_job_request` | `(state, requested_at)` |
| `ref_universe_membership` | `(ticker, valid_from)`, `(valid_to)` — partial `WHERE valid_to IS NULL` for "current members" |
| `ref_chain_subset_membership` | `(ticker, valid_from)`, partial `(valid_to) WHERE valid_to IS NULL` |
| `ref_sticky_contract` | `(osi_symbol)`, partial `(valid_to) WHERE valid_to IS NULL` |
| `ref_trading_day` | PK on `date` suffices |
| `raw_ticker_reference` | `(ticker, observed_at)` |
| `raw_daily_bar` | `(ticker, trade_date)`, `(trade_date)`, `(ticker, observed_at)` |
| `raw_eod_quote` | `(ticker, as_of_date)`, `(as_of_date)` |
| `raw_option_expiration` | `(ticker, as_of_date)`, `(ticker, expiration_date)` |
| `raw_option_contract_snapshot` | `(as_of_date)`, `(ticker, as_of_date)`, `(osi_symbol, as_of_date)`, `(ticker, expiration_date, as_of_date)`, `(source_response_id)` — the last added v1.1.252: QC-403 counts contracts per chain response ~4,900 times a run, each a full table scan without it, and the 2026-09-16 gate held the main thread 27 minutes |
| `raw_split`, `raw_dividend` | `(ticker, execution_date)` / `(ticker, ex_dividend_date)` |
| `raw_earnings_event` | `(ticker, report_date)`, `(report_date)`, `(ticker, observed_at)` |
| `raw_index_quote` | `(symbol, as_of_date)` |
| `raw_edgar_filing` | `(cik, filed_date)`, unique `(accession_no)` — **wrong, and must become `(accession_no, observed_at)` at the next generation (v1.1.308).** The table is append-only and every other supersession in the schema keys on `(natural_key, observed_at)`; worse, the transaction is the whole response, so one already-stored filing aborts the insert of every filing beside it and reports `UNIQUE constraint failed`, which reads as a parser fault. The filers’ slice is keyed on the trading date, so any day with two collector runs asks the identical twenty and hits it — HSY on 2026-09-22, stored at 17:05 and re-asked at 20:47. Mitigated in-generation by `knownAccessions` in the ingest recipe, which never offers the constraint a duplicate; dropping a unique index is not additive, so the key itself cannot change inside a generation |
| `raw_edgar_fact` | `(cik, concept, period_end)`, `(accession_no)` |
| `raw_account_position_snapshot` | `(as_of_date)`, `(symbol, as_of_date)` |
| `raw_account_balance_snapshot` | `(as_of_date)` |
| `raw_executed_order` | `(order_id)`, `(executed_time)` — **not** unique on `order_id`, see §10.3 |
| `raw_executed_order_leg` | `(order_row_id)`, `(osi_symbol)`, `(symbol)` |
| `raw_account_transaction` | unique `(transaction_id)`, `(transaction_date)` |
| `raw_macro_event` | `(event_date)`, `(event_key, observed_at)` |
| `raw_treasury_yield` | `(curve_date, tenor)` |
| `raw_short_interest` | `(ticker, settlement_date)` |
| `raw_analyst_recommendation`, `raw_analyst_estimate` | `(ticker, period_month)` / `(ticker, fiscal_period)` |
| `raw_insider_transaction` | `(ticker, transaction_date)`, `(cik, transaction_date)`, `(accession_no)` |
| `ext_iv_history`, `derived_iv30_daily` | `(ticker, date)` / `(ticker, as_of_date)` |
| `legacy_brief_run` | `(trading_date, slot)` |
| `legacy_brief_candidate` | `(legacy_run_id)`, `(ticker, mode)` |
| `legacy_brief_candidate_gate/_signal/_leg` | `(candidate_row_id)` |
| `qa_exception` | unique `(fingerprint)`, `(state, severity)`, `(check_id)`, `(domain, last_seen_run_id)` |
| `qa_check_result` | `(run_id, check_id)` |
| `qa_domain_day_status` | `(domain, trading_date)` |

Every raw and snapshot table additionally carries `(run_id)` and `(source_response_id)`, because "show me every row this run wrote" and "show me every row from this response" (AC-1) are the two navigations the inspector offers on every table.

**Cost.** Indexes roughly double the write volume on `raw_option_contract_snapshot`, the one table where it matters (~700k rows/day at the planned subset). That is accepted: the archive is the provenance layer and the database is the *query* layer, and a query layer that cannot be filtered has failed at its one job (P13). If write time becomes the binding constraint on the 19:15 deadline, the lever is the chain subset (04 §3), not the indexes.

---

## 1. Infrastructure tables (`meta_`)

### `meta_generation`
One row per generation (P14). Lives in every generation's own file describing itself; the newest generation also records its predecessor.

| column | type | notes |
|---|---|---|
| `generation_no` | INTEGER PK | `1` is the pilot |
| `opened_at`, `closed_at` | TEXT | closed_at null while current |
| `status` | TEXT | `pilot` \| `production` \| `closed` |
| `db_path`, `archive_path` | TEXT | |
| `predecessor_no` | INTEGER | null for gen 1 |
| `reset_reason` | TEXT | why the predecessor was closed |
| `pilot_exit_at` | TEXT | when the 20-clean-day criterion was met |
| `pilot_exit_evidence_json` | TEXT, nullable | the whole pilot-exit checklist at the moment of promotion — streak, rulings, inspections, replay record (03 §8, dictionary v13). The status says it was promoted; this says on what evidence |

### `meta_open_handle` — which application opened this file

One row per application, **replaced on each open**. Not a fact about the market and read by nothing downstream: it exists so that *"are the two applications actually looking at the same file?"* is an answerable question.

| column | type | notes |
|---|---|---|
| `app_name` | TEXT PK | `TradeAnalyzer` (collector host) \| `TradeAnalyzer 2` (inspector) |
| `app_version` | TEXT | so a stale row names the build that wrote it |
| `opened_at` | TEXT | ET timestamp |
| `process_id` | INTEGER | |
| `db_path` | TEXT | the path **that application** resolved |
| `dictionary_version` | INTEGER | what that build was compiled against |

Both exes write here on open. A reader that finds only one row, or two rows disagreeing about `db_path`, is looking at a **split file set** — the shape that destroyed gen-001 on 2026-09-07, when a containerised launch put one application on a private copy of `data.sqlite` while the write-ahead log stayed shared. That question was answered by inference several times that day and wrongly every time, because a redirected process reads every path back exactly as it wrote it. `assertNotRedirected` (06 §3.1) prevents the split that is understood; this table makes any other one visible. Replaced rather than appended because the question is who has it open *now* — the history that matters is already in `meta_run`.

### `meta_run`
One row per collector run (a run = one slot on one day, or a one-shot job).

| column | type | notes |
|---|---|---|
| `run_id` | INTEGER PK | |
| `run_kind` | TEXT | `daily` \| `backfill_bars` \| `bootstrap_iv` \| `legacy_import` \| `replay` \| `manual` |
| `slot` | TEXT | `after_close` (stage 1's only value); future `morning` |
| `trading_date` | TEXT | the `as_of_date` the run captures |
| `started_at`, `finished_at` | TEXT | |
| `status` | TEXT | `running` \| `complete` \| `failed` \| `cancelled` |
| `host_app`, `host_version` | TEXT | which exe hosted the collector (Q4) and its version |
| `collector_version`, `dictionary_version` | TEXT | for replay equivalence (AC-4) |
| `gate_verdict` | TEXT | `green` \| `amber` \| `red` — **the verdict at the moment the run finished**, never updated afterwards. It is a historical fact about the run, not a live usability flag. Usability is `qa_domain_day_status` and only that (03 §4); a stored `usable` column would go stale the first time an exception was resolved the next day |

### `meta_run_phase` — how each phase of a daily run ended (dictionary v24, v1.1.361)
One row per phase of a daily run (`bars`, `quotes`, `corporate_actions`, `account`, `chain_subset`, `chains`, `events`, `derive`) and per phase-8 sub-phase (`events/<name>`, e.g. `events/edgar-facts`), written as each ends. QC-006 reads it.

| column | type | notes |
|---|---|---|
| `phase_row_id` | INTEGER PK | |
| `run_id` | INTEGER | → `meta_run` |
| `phase` | TEXT | unique with `run_id` |
| `status` | TEXT | `ok` (returned normally, whatever it stored) \| `failed` (threw) \| `cancelled` (running when the run was cancelled) \| `not_reached` (scheduled, never started) |
| `started_at`, `finished_at` | TEXT | null when `not_reached` |
| `error` | TEXT | what the phase threw, verbatim; null when it did not throw |

Before it existed, `runDaily` caught a phase that threw so the rest could run, and then only appended the message to an array it returned. Nothing stored it, so a crashed phase left its domain looking like a quiet day to every check, the email and every rehearsal. Phases a cancellation never reached are written `not_reached` once the run stops, so "did not run" is a row, never an absence. A backfill, a one-shot or a run before v1.1.361 writes no rows.

### `meta_capture_rule`
Versioned definitions (P6). A change creates a new row; runs reference the row in force.

| column | type | notes |
|---|---|---|
| `capture_rule_id` | INTEGER PK | |
| `domain` | TEXT | `chain` \| `bars` \| `quotes` \| ... |
| `version` | INTEGER | per domain |
| `definition_json` | TEXT | the rule, machine-readable (e.g. `{ "maxDte": 90, "extraMonthlies": 2, "allStrikes": true }`) |
| `description` | TEXT | human sentence |
| `valid_from`, `valid_to` | TEXT | |

### `meta_response` — the raw archive index (P2)
One row per provider call. The body lives in the archive file; this row says where.

| column | type | notes |
|---|---|---|
| `source_response_id` | INTEGER PK | |
| `run_id` | INTEGER FK | |
| `provider` | TEXT | `polygon` \| `etrade` \| `edgar` \| `finnhub` \| `treasury` \| `ivolatility` \| ... |
| `endpoint` | TEXT | path with account key masked (P15) |
| `params_json` | TEXT | query parameters, secrets removed |
| `requested_at`, `responded_at` | TEXT | |
| `http_status` | INTEGER | null on network fault |
| `byte_length` | INTEGER | |
| `archive_file` | TEXT | relative path, e.g. `archive/etrade/2026-09-05/optionchains.jsonl.gz` |
| `archive_offset` | INTEGER | line number within the file |
| `sha256` | TEXT | of the uncompressed body |
| `dedup_hash` | TEXT | `sha256(provider + endpoint + params_json + as_of_date + body)` — the idempotence key of 04 §2.2. Unique index. It makes **re-ingesting an identical response for the same trading date** a no-op (crash recovery, replay), and nothing more. `as_of_date` is in the key because a stable body is the NORMAL case for a reference list: without it (to v1.1.247) an expiration list unchanged since the previous day deduped against that day and wrote no row for the current one, which QC-401 reported as 92 % of the chain subset failing to answer (2026-09-15) |
| `encrypted` | INTEGER | `1` for account-domain files (Q20) |
| `at_provider_cap` | INTEGER | `1` when the response is known to be **incomplete** (P8): a size equal to a known provider cap (Finnhub 1500, EDGAR 1000), or a paged sweep stopped before its cursor ran out (04 §2.2). Polygon's list endpoints page, so reaching a `limit` there is **not** a cap — an unfollowed `next_url` is. Measured 2026-09-11: the five-year split sweep returned exactly 1,000 rows, which was the parameter rather than a count, and nothing flagged it because no call site passed this column |
| `parse_status` | TEXT | `ok` \| `partial` \| `failed` — a failed parse still keeps the archive row |
| `parsed_row_count` | INTEGER | rows ingestion produced, children included (AC-5) |
| `ingest_recipe_id` | INTEGER, nullable | **dictionary v11 (B9b).** The `meta_ingest_recipe` row that turned this response into rows. Null = no parser ran (routing document, a list read whole, an archive-only import) **or** captured before v11 — the run's `dictionary_version` says which. Deliberately no `REFERENCES` clause: `applyDictionary` adds columns with a bare `ALTER TABLE … ADD COLUMN`, so a declared FK would leave the table reported as drifted on every open |
| `capture_rule_id` | INTEGER, nullable | **dictionary v11.** The capture rule in force for the call. Until v11 it lived only on the rows a response produced, so a response that produced none could not say which rule asked for it — and a replay could not rebuild the rows it did produce without guessing |

Archive layout: `gen-NNN/archive/<provider>/<YYYY-MM-DD>/<endpoint-slug>.jsonl.gz`, one JSON line per response `{ id, requestedAt, params, status, body }`. Account-domain files are `.jsonl.enc` (safeStorage/DPAPI, header names the mechanism). The `<YYYY-MM-DD>` directory is the capture's `as_of_date`, which is how a replay recovers it.

### `meta_ingest_recipe` — how a response was parsed (B9b, 04 §7.5)

The archive kept every response's bytes but, until dictionary v11, not the arguments its parser was built with — the rule's expiration selection, the sticky set, the order fingerprints and transaction ids already stored, the earnings universe filter, the CIK map. Several of those are database state at the moment of capture, so a replay would have had to reconstruct them, and **a reconstructed replay that reports "equal" cannot fail on the case it exists for.**

| column | type | notes |
|---|---|---|
| `recipe_id` | INTEGER PK | referenced by `meta_response.ingest_recipe_id` |
| `recipe_sha256` | TEXT, unique | sha256 of the module name + the canonical (key-sorted) JSON of its arguments |
| `module` | TEXT | the parser's name in `core`'s recipe registry — `etrade_chain`, `polygon_bars`, `edgar_form4`, … |
| `args_json` | TEXT | the arguments, canonical JSON; maps and sets as sorted arrays |
| `first_seen_at` | TEXT | when a capture first used it |

**Content-addressed, not per response.** The Form 4 parser carries the whole CIK-to-ticker map (~1,089 entries) and each earnings slice the universe list; stored per response those would be the same kilobytes hundreds of times a day. **The account key never appears** — the account parsers only ever hashed it, so the recipe carries the digest the rows already store (P15). Append-only.

**What is recorded is what ran.** `captureResponse` takes a recipe and builds the parser from it through `buildIngest`; there is no path in which a caller hands over a function and separately describes it.

### `meta_saved_question` — a question asked of one table (05 §11.2, dictionary v12)

| column | type | notes |
|---|---|---|
| `question_id` | INTEGER PK | |
| `name` | TEXT | unique among questions still in use |
| `table_name` | TEXT | the table it is asked of |
| `definition_json` | TEXT | filters, sort, version mode, as-of date, visible columns — validated at save by the rules the Data view runs (`core`'s `inspector/filters.ts`) |
| `note` | TEXT, nullable | what it is for |
| `created_at`, `created_by` | TEXT | |
| `retired_at` | TEXT, nullable | the only edit the table permits; saving under a name in use retires the old row, so what a name meant last week stays readable |

Append-only. Stored in the generation so a question travels with the data it was asked of.

**Study pins** (`ref_sticky_contract.reason = 'study_flag'`, 05 §4.2) keep the standard columns' provenance: the operator's request is archived as a `host_app` response (`operator/study-pin`) under a `manual` run, and the row's `source_response_id` and `origin_ref` point at it. Ending a pin closes `valid_to` and archives the reason the same way.

### `meta_domain_inspection` — a person looked at a domain (D5, 03 §8, dictionary v13)

| column | type | notes |
|---|---|---|
| `inspection_id` | INTEGER PK | |
| `domain` | TEXT | a gate domain — the vocabulary of `qa_domain_day_status.domain` |
| `inspected_at`, `inspected_by` | TEXT | when, and from which application and version |
| `note` | TEXT, nullable | what was looked at |

Append-only: inspecting again adds a row. Promotion needs at least one row per gate domain. The pilot-exit rulings on checks live in `qa_check_ruling` (03 §8).

### `meta_job_request` — the one-shot job queue (04 §1.1)

In stage 1 the operator drives one-shot jobs from the new exe but the **old app executes them**, because it holds the provider transports and the E*Trade token (Q4). The new exe writes a request row here; the old app's `collector-oneshot` handler claims and runs it. The table is the entire interface between the two apps — there is no IPC, no socket and no shared process.

| column | type | notes |
|---|---|---|
| `request_id` | INTEGER PK | |
| `requested_at`, `requested_by` | TEXT | ISO ET; `requested_by` is the app + version that queued it |
| `run_kind` | TEXT | `universe_seed` \| `backfill_bars` \| `bootstrap_iv` \| `legacy_import` \| `replay` \| `reset` |
| `params_json` | TEXT | e.g. `{ "sourceGeneration": 1, "target": "scratch" }` |
| `state` | TEXT | `queued` \| `claimed` \| `running` \| `complete` \| `failed` \| `cancelled` |
| `claimed_at`, `claimed_by_host` | TEXT | which exe took it, and when |
| `run_id` | INTEGER FK → `meta_run` | set when execution starts; null while queued |
| `finished_at` | TEXT | |
| `result_json` | TEXT | the job's own report — the replay diff, the import rejection summary, the bootstrap overlap distribution |
| `error` | TEXT | null unless `state = failed` |

**Claiming is a single conditional UPDATE** (`SET state='claimed' … WHERE request_id=? AND state='queued'`); a claim that changes zero rows means someone else took it. One request is claimed per tick, so two hosts can never run the same job, and the existing batch mutex keeps it serialised against the old app's other jobs.

This table is the one exception to "raw tables are append-only": it is a `meta_` control table, not a fact, and its state column is *meant* to move. Its history is preserved in the `meta_run` row each execution creates, which is append-only as usual.

---

### `meta_dictionary`
Generated from the dictionary module at startup; read-only for the inspector. Columns mirror the dictionary entry fields in §0.5 plus `dictionary_version`.

---

## 2. Reference and membership (`ref_`)

### Domain: universe and ticker reference (Q1, Q16.1)

#### `ref_universe_membership`
Which tickers are in the universe and why, as validity ranges. Never overwritten; a departure closes `valid_to`.

| column | type | null | notes / source |
|---|---|---|---|
| `ticker` | TEXT | no | |
| `list_source` | TEXT | no | `sp500` \| `russell1000` \| `etf_list` \| `manual` |
| `valid_from`, `valid_to` | TEXT | `valid_to` null = current | |
| `change_reason` | TEXT | no | `initial` \| `index_add` \| `index_drop` \| `ticker_change` \| `delisted` \| `manual` |
| `predecessor_ticker` | TEXT | yes: "no rename involved" | ticker-change lineage |

Expected count: |current members| ≈ **1,089** at start — measured 2026-09-05 as the *union* of sp500 (503), russell1000 (1,024) and etf (60). The three lists overlap heavily: their sum is 1,587, which is the number discovery recorded and every section inherited until it was measured.

#### `raw_ticker_reference`
Point-in-time reference facts; a row is appended when any field differs from the latest stored row for the ticker (or at least every 30 days as a heartbeat), so "as known on day X" is well defined.

| column | type | null | source (Polygon `/v3/reference/tickers/{t}`) |
|---|---|---|---|
| `ticker` | TEXT | no | `ticker` |
| `name` | TEXT | no | `name` |
| `security_type` | TEXT | no | `type` (`CS`, `ETF`, `ADRC`, ...) stored verbatim |
| `primary_exchange` | TEXT | yes: omitted | `primary_exchange` |
| `sic_code`, `sic_description` | TEXT | yes: omitted (ETFs have none) | `sic_code`, `sic_description` |
| `sector` | TEXT | yes: "no mapping for this SIC" | derived at ingestion from `sic_code` via a **versioned** mapping table `ref_sic_sector` (the mapping is data, not code) |
| `market_cap` | REAL | yes + `market_cap_status` | `market_cap` (USD) |
| `shares_outstanding` | INTEGER | yes + status | `weighted_shares_outstanding`, fallback `share_class_shares_outstanding` — which one used is recorded in `shares_source` |
| `cik` | TEXT | yes: "not an SEC filer" | `cik`, zero-padded to 10 |
| `composite_figi` | TEXT | yes: omitted | |
| `list_date` | TEXT | yes: omitted | |
| `active` | INTEGER | no | `active` |
| `optionable` | INTEGER | yes + `optionable_status` | **derived at ingestion** from the E*Trade expirations call returning ≥1 expiration; `optionable_status = omitted` when the call was not made (outside chain subset) |

### Domain: chain subset membership (Q15)

#### `ref_chain_subset_membership`

| column | type | notes |
|---|---|---|
| `ticker` | TEXT | |
| `valid_from`, `valid_to` | TEXT | |
| `membership_reason` | TEXT | `rule_pass` \| `sticky_ticker` \| `held_in_book` \| `recommended_by_legacy` \| `study_flag` \| `manual` |
| `rule_capture_rule_id` | INTEGER FK | the subset rule version that admitted it |
| `rule_inputs_json` | TEXT | the measured values at admission (price, avg dollar volume) so the decision is auditable |
| `removal_reason` | TEXT | `delisted` \| `not_optionable` \| `manual` — **never** `fell_below_threshold` (sticky) |

Working thresholds for the spec (to be measured before freezing, Q15): `close ≥ 10 USD` and `20-day average dollar volume ≥ 20 M USD`, evaluated on bars; the measured admitted count is recorded in 04.

### Domain: trading calendar (Q16.2)

#### `ref_trading_day`

**Seeded from exchange rules, and seeded by preflight (built 2026-09-07).** `source = 'nyse_rules'` was always the intent; the generator implements it — weekday, the ten scheduled NYSE closures with their observance rules, 13:00 early closes, and the monthly expiration as the third Friday **or the preceding session when that Friday is a holiday**. A hardcoded date list works until the year it runs out, and it runs out *silently*.

**Why preflight rather than a one-shot.** Preflight and the watchdog both treat an unknown date as a trading day, which is the right default — a needless run costs calls while a skipped one costs a day that cannot be recovered — but it is dangerous in exactly one direction: an unseeded calendar makes **every weekend and holiday look like a session**. The collector would write weekend-dated snapshots of Friday's data and the watchdog would email "no daily run" every Saturday and Sunday until nobody read it. A calendar that exists only if somebody remembered to seed it is one that will be missing on the day it matters, so it seeds itself, idempotently, before it is read.

**Rules cannot produce every closure, and the row says which kind it is.** 2025-01-09 (National Day of Mourning, Jimmy Carter) is a decision nobody can derive; those are listed explicitly and carry `source = 'manual'`, which the rule generator never overwrites. `polygon_marketstatus` remains the intended yearly refresh for the ones not yet announced.

**Validated against an independent list.** The generator is tested against the existing app's separately maintained 2023–2027 holiday table, in **both directions** — nothing missing, nothing extra. Two sources built from different information agreeing on fifty dates is far better evidence than either alone, and the one disagreement (2025-01-09) is exactly the unscheduled-closure case, which is why it is asserted rather than papered over.


| column | type | notes |
|---|---|---|
| `date` | TEXT PK | every calendar day, years −5 … +2 |
| `is_trading_day` | INTEGER | |
| `early_close_time` | TEXT | `13:00` ET or null = normal |
| `holiday_name` | TEXT | null = not a holiday |
| `is_monthly_expiration` | INTEGER | third Friday (or preceding Thursday when Friday is a holiday) |
| `source` | TEXT | `nyse_rules` \| `polygon_marketstatus` \| `manual` |
| `observed_at` | TEXT | |

Seeded from exchange rules; refreshed yearly from Polygon `/v1/marketstatus/upcoming` for unscheduled closures. Used by the expected-count model in 03 (no bars expected on a non-trading day).

---

## 3. Domain: daily bars (Q5, Q7)

### `raw_daily_bar`
Source: Polygon `/v2/aggs/ticker/{t}/range/1/day/{from}/{to}?adjusted=true`. One-time backfill at full plan depth (5 y), then daily. Re-fetches append (P1); the split check compares the newest series to the stored one.

| column | type | null | source / notes |
|---|---|---|---|
| `ticker` | TEXT | no | |
| `trade_date` | TEXT | no | from `t` (ms epoch → ET date) |
| `open`, `high`, `low`, `close` | REAL | no | `o h l c` USD/share |
| `volume` | REAL (shares) | yes: omitted | `v` exactly as sent — **fractional, routinely**. Revised 2026-09-12 (dictionary v15): this row said INTEGER "with an integrality check → `invalid` if fractional", and the parser built to it wrote `0` for every fractional bar with no status to mark it, so QC-205 evaluated nothing and the chain subset measured $0 dollar volume for every ticker. Absent → null, never 0 (D7) |
| `vwap` | REAL | yes: omitted | `vw` |
| `transactions` | INTEGER | yes: omitted | `n` |
| `adjusted_as_of` | TEXT | no | the date the fetch was made; the whole series is adjusted on this basis |
| `fetch_kind` | TEXT | no | `backfill` \| `daily` \| `refetch_discontinuity` \| `refetch_manual` |
| `is_final` | INTEGER | no | `0` if fetched before Polygon's settlement window closed for that date (before ~17:00 ET); the evening run re-fetches non-final bars |

Natural key `(ticker, trade_date, observed_at)`. Expected count per trading day: |universe active|. Checks (03): OHLC ordering, close within ±40 % of prior close unless a split/dividend row explains it, volume-regime shift ≥ 15× (ticker-reuse signature), gap in trading days.

---

## 4. Domain: end-of-day quotes (Q5)

### `raw_eod_quote`
Source: Polygon full-market snapshot `/v2/snapshot/locale/us/markets/stocks/tickers` (one call for the whole universe) — it is the cross-source check on the bar close and carries bid/ask. E*Trade `/v1/market/quote` is used only for VIX (§8) and as a second source on a rotating 5 % sample for disagreement measurement.

| column | type | null | source |
|---|---|---|---|
| `ticker` | TEXT | no | `ticker` |
| `last`, `last_size` | REAL, INTEGER | yes + status | `lastTrade.p`, `lastTrade.s` |
| `bid`, `bid_size`, `ask`, `ask_size` | REAL, INTEGER | yes + status | `lastQuote.p/s`, `lastQuote.P/S` — after hours these can be stale; `quote_time` says when |
| `day_open`, `day_high`, `day_low`, `day_close`, `day_volume`, `day_vwap` | REAL (`day_volume` in shares, fractional) | yes + status | `day.*` |
| `prev_close` | REAL | yes + status | `prevDay.c` |
| `quote_time`, `trade_time` | TEXT | yes: omitted | `lastQuote.t`, `lastTrade.t` |
| `snapshot_updated` | TEXT | no | `updated` |

Expected count: |universe active|. Check: `day_close` vs `raw_daily_bar.close` same day (blocking if > 0.5 % on > 2 % of tickers).

---

## 5. Domain: option chains (Q2, Q15)

### `raw_option_expiration`
Source: E*Trade `/v1/market/optionexpiredate?symbol=`. One call per ticker in the chain subset per run.

| column | type | notes |
|---|---|---|
| `ticker` | TEXT | |
| `expiration_date` | TEXT | from `year/month/day` |
| `expiry_type` | TEXT | `expiryType` verbatim (`WEEKLY`, `MONTHLY`, `QUARTERLY`, ...) |
| `in_capture_window` | INTEGER | `1` if the run's rule selected it for a chain call |
| `window_reason` | TEXT | `within_max_dte` \| `extra_monthly` \| `sticky_contract` \| `outside` |

### `raw_option_contract_snapshot` — the large table
Source: E*Trade `/v1/market/optionchains?symbol&expiryYear&expiryMonth&expiryDay&chainType=CALLPUT&priceType=ALL&includeGreeks=true` (existing call). One row per contract per run. **Every strike returned is stored** (Q2).

| column | type | null | source (`OptionPair.Call` / `.Put`) / notes |
|---|---|---|---|
| `ticker` | TEXT | no | |
| `osi_symbol` | TEXT | no | `osiKey` — the contract's identity across days. E*Trade pads a short root to six characters with **dashes** (`ACGL--260918C00095000`), not the spaces the OCC specification uses, and drops a class-share dot (`BRKB--…` for BRK.B, measured 2026-09-18); anything built to join against this column must match those bytes — build it with `osiSymbol()` (see 04 §4.4) |
| `expiration_date` | TEXT | no | from the request |
| `strike` | REAL | no | `strikePrice` USD |
| `right` | TEXT | no | `call` \| `put` |
| `display_symbol` | TEXT | yes: omitted | `displaySymbol` |
| `bid`, `ask`, `last` | REAL | yes + one shared `price_status` | `bid`, `ask`, `lastPrice` USD/share; `last` may be `0` from E*Trade when no trade — stored as null + `last_status = 'omitted'`, never `0` |
| `bid_size`, `ask_size` | INTEGER | yes + status | `bidSize`, `askSize` |
| `volume` | INTEGER | yes + `volume_status` | `volume`; absent → `omitted`, **never 0** (D7) |
| `open_interest` | INTEGER | yes + `oi_status` | `openInterest` |
| `iv` | REAL | yes + `iv_status` | `OptionGreeks.iv` **fraction as sent** (E*Trade sends 0.3882) — converter asserts `0 < iv < 5` else `invalid` |
| `delta`, `gamma`, `theta`, `vega`, `rho` | REAL | yes + shared `greeks_status` | `OptionGreeks.*` as sent; theta per day as E*Trade reports (**verify** the time unit against a Black-Scholes reproduction during 04 — P4 requires we can reproduce it) |
| `in_the_money` | INTEGER | yes: omitted | `inTheMoney` |
| `underlying_price` | REAL | no | `OptionChainResponse.nearPrice` at the time of the call |
| `provider_timestamp` | TEXT | yes: omitted | `timeStamp` (**verify** epoch unit) |
| `sticky_reason` | TEXT | yes: "captured by the rule, not sticky" | `held_in_book` \| `recommended_by_legacy` \| `study_flag` |

Indexes: per §0.6. Expected count per run: Σ over subset tickers of contracts returned — checked against `meta_response` parse counts (AC-5), not against a model. Checks: bid ≤ ask; iv range; strike ladder monotone; `underlying_price` within 1 % of `raw_eod_quote.last`.

### `ref_sticky_contract`
Contracts pinned into capture regardless of rule (Q2.3).

| column | notes |
|---|---|
| `osi_symbol`, `ticker`, `expiration_date` | |
| `reason` | `held_in_book` \| `recommended_by_legacy` \| `study_flag` \| `manual` |
| `valid_from`, `valid_to` | `valid_to` = expiration date at the latest |
| `origin_ref` | e.g. `legacy_brief_leg.row_id` or `raw_account_position_snapshot.row_id` |

---

## 6. Domain: corporate actions (Q5, Q10)

### `raw_split`
Source: Polygon `/v3/reference/splits?ticker=` (daily sweep by `execution_date` window, plus per-ticker on discontinuity).

| column | type | notes |
|---|---|---|
| `ticker` | TEXT | |
| `execution_date` | TEXT | `execution_date` |
| `split_from`, `split_to` | REAL | `split_from`, `split_to` (e.g. 1 → 4) |
| `provider_id` | TEXT | Polygon `id` for idempotent re-pull |

### `raw_dividend`
Source: Polygon `/v3/reference/dividends?ticker=`.

| column | type | null | notes |
|---|---|---|---|
| `ticker` | TEXT | no | |
| `ex_dividend_date` | TEXT | no | |
| `record_date`, `pay_date`, `declaration_date` | TEXT | yes: omitted | |
| `cash_amount` | REAL | no | USD/share |
| `currency` | TEXT | no | |
| `frequency` | INTEGER | yes: omitted | per year (0 one-time, 1, 2, 4, 12) |
| `dividend_type` | TEXT | no | `CD` \| `SC` \| `LT` \| `ST` verbatim |
| `provider_id` | TEXT | no | |

Expected count: not modelled (event data); check = every `raw_daily_bar` discontinuity has a matching action, else exception.

---

## 7. Domain: earnings dates (Q5)

### `raw_earnings_event`
Every observation of an earnings date is a row (P1); "the current best date" is a reader-side resolution, never an update. Two sources captured for cross-checking; Finnhub swept in windows narrow enough to stay under its 1,500 cap (`at_provider_cap` on the response row triggers subdivision).

| column | type | null | source |
|---|---|---|---|
| `ticker` | TEXT | no | `symbol` |
| `report_date` | TEXT | no | Finnhub `date`; E*Trade `All.nextEarningDate` (`MM/DD/YYYY` → ISO, stored as observed with no Saturday shift — QC-604 flags that; empty = no row; any other format fails the parse). **E\*Trade rows exist from v1.1.270**: one quote per subset stock the Finnhub sweep did not date, plus a rotating overlap sample, keyed on the ticker asked; `sweep_from`/`sweep_to` null |
| `report_time` | TEXT | yes: omitted | Finnhub `hour`. **Measured 2026-09-06 over 520 universe reports: `bmo` 132, `amc` 144, and `''` (empty string, not absent) on 244 — 47 %.** `dmh` was never observed. The converter must map `''` -> null with `report_time_status = 'omitted'`; treating empty string as a value would put a fourth member in the enum and silently defeat any `report_time IS NULL` filter |
| `fiscal_year`, `fiscal_quarter` | INTEGER | yes: omitted | `year`, `quarter` |
| `eps_estimate`, `eps_actual` | REAL | yes + status | `epsEstimate`, `epsActual` USD |
| `revenue_estimate`, `revenue_actual` | REAL | yes + status | `revenueEstimate`, `revenueActual` USD |
| `source` | TEXT | no | `finnhub` \| `etrade` |
| `sweep_from`, `sweep_to` | TEXT | yes: not a sweep | the window requested |
| `is_confirmed` | INTEGER | yes: omitted | provider's confirmation flag where offered |

Checks: an observed date moving **later** by > 14 days vs the previous observation is an exception (the truncation signature); Finnhub vs E*Trade disagreement > 1 day is a warning.

---

## 8. Domain: VIX and macro series (Q5)

### `raw_index_quote`
Source: E*Trade `/v1/market/quote/{symbol}` (Polygon's stock snapshot cannot serve indices). Symbols are a configured list in `ref_macro_series` (`VIX` first; `VIX3M`, `VVIX` as later additions). The E*Trade symbol for VIX is **verify** (CLAUDE.md flags it unconfirmed); the ingestion check `5 ≤ last ≤ 150` stays.

| column | type | null | source |
|---|---|---|---|
| `symbol` | TEXT | no | |
| `last` | REAL | yes + **its own** `last_status` | `All.lastTrade` |
| `open`, `high`, `low`, `prev_close` | REAL | yes + **shared** `session_status` | `All.open`, `All.high`, `All.low`, `All.previousClose` — all five names confirmed live 2026-09-07 |
| `provider_timestamp` | TEXT | yes: omitted | `dateTimeUTC`, epoch **seconds** |

**`last` does not share a status with the session fields, and that is a correction made at B7a.** They were drafted under one shared status, which the generated CHECK constraint then reads as strictly all-or-nothing: a response missing only `open` would have to null `last` too. QC-901 treats an absent `last` as **blocking**, so a single missing context field would have taken out the market-regime read — and the alternative, writing the row anyway, throws inside the capture transaction and surfaces as a generic parse failure rather than as the missing field it is. `last` is what QC-901, the critic and the dashboard all consume; open/high/low/prev_close are context, and losing them together is one honest fact worth one status column. **General shape: a shared status column is an assertion that those fields arrive together, and it has to be earned per group rather than applied to whatever a table happens to hold.**

---

## 9. Domain: fundamentals (Q5)

Stored in the honest raw form SEC publishes — **facts**, not statements. Statements (income, balance, cash flow), TTM roll-forwards and ratios are derived (stage 2), reproducible from these rows.

### `raw_sec_ticker_map`
Source: SEC `www.sec.gov/files/company_tickers.json`, weekly (v1.1.331), filtered to the universe at ingestion. The body is an **object keyed "0", "1", …** whose values are `{ cik_str, ticker, title }`. `cik_str` is a **number** despite its name, so it is zero-padded to 10 like every other CIK, and SEC spells a class share with a dash (`BRK-B`), converted to our dot. Columns: `ticker`, `cik`, `registrant` (SEC's `title`; the name `title` collides with page copy in the inspector's AC-13 scan). **It is the CIK every EDGAR lookup prefers** (`effectiveCikSql`: the latest capture's CIK, else Polygon's). Polygon gave FWONA, LLYVA and LLYVK the stale 0000869614, so their filings, facts and insider mapping were asked of the wrong filer. Only the latest capture is read, so a ticker SEC stops listing falls back to Polygon, not to an old SEC row. The disagreement is QC-703.

### `raw_edgar_filing`
Sources: the EDGAR daily form index `form.YYYYMMDD.idx` (primary since v1.1.325) and `submissions/CIK##########.json` (a least-recently-asked backstop).

**The daily index is the primary source (v1.1.325, recipe `edgar_form_index_filings`).** The insider sweep already fetches it, and it lists every filing of the session, so each universe filer's new report filing is stored a session after filing, with no extra call. The index carries **no period and no primary document**, so `report_date` and `primary_doc` are null on those rows; the submissions sweep later sees the same accession and skips it as known. Nothing reads either column. One accession can appear under several CIKs (co-registrants) or on repeated lines, and `accession_no` is unique while the transaction is the whole index, so the parser stores each accession once — a repeat would fail the index and the day's insider sweep with it.

**`filings.recent` is capped at 1,000 entries**, with the remainder in a `filings.files` overflow list — measured 2026-09-07 on CIK 0000320193, exactly 1,000 in every parallel array. It is the same truncation shape as Finnhub's 1,500-row calendar and it is flagged the same way (`at_provider_cap`), even though this one truncates from the *older* end and so happens to be harmless for a phase that only wants new filings. **"Harmless in the current usage" is not a reason to leave a cap undetected** — the Finnhub one was harmless too, until a window grew.

The payload is **parallel arrays**, not an array of objects, so zipping by index is the only way to read it and a short companion array is a silent misalignment rather than an error. The row count therefore comes from `accessionNumber`, the natural key, which cannot be blank; a filing whose companion fields are missing is stored with nulls and never shifted into alignment. An empty `reportDate` maps to **null**, because an empty date string sorts before every real date and would quietly win any `MIN()`.

| column | type | notes |
|---|---|---|
| `cik`, `ticker` | TEXT | |
| `accession_no` | TEXT | unique |
| `form` | TEXT | `10-K` \| `10-Q` \| `8-K` \| `20-F` \| ... |
| `filed_date`, `report_date` | TEXT | |
| `primary_doc` | TEXT | |

### `raw_edgar_fact`

**Natural key includes `period_start` (dictionary v17).** A 10-Q reports one concept for the quarter AND the year to date: same `period_end`, same `accession_no`, same `fiscal_period`, differing only in start. Without it QC-009 read every such pair as a duplicate (1,641 in one run, 2026-09-16).
Source: EDGAR `api/xbrl/companyfacts/CIK##########.json`. Fetched when `raw_edgar_filing` shows a new 10-K/10-Q since the last fact pull (weekly sweep). Rows are appended per `(cik, taxonomy, concept, unit, period_end, fiscal_period, accession_no)`; a restated value in a later filing is a new row.

**Second source, v1.1.360: the filing's own XBRL instance.** When companyfacts has omitted a report filing (no fact from it, companyfacts read ≥ 14 days after filing), the collector reads `Archives/edgar/data/{cik}/{accession}/{primary}_htm.xml`, found through that directory's `index.json`. It writes the same rows companyfacts would: facts in a context with no dimension, in a standard taxonomy (identified by namespace URI), numeric and non-nil, with the filing's `dei:DocumentFiscalYearFocus`/`…PeriodFocus` as `fiscal_year`/`fiscal_period`, and `form`/`filed_date` from the filing row. **`frame` is null on these rows**, because SEC's cross-filing frame exists only in the aggregate. Which source wrote a row is `meta_response.endpoint` via `source_response_id`: `/api/xbrl/companyfacts/CIK{cik}.json` or `/Archives/edgar/data/{cik}/{accession}/{instance}`. Verified against companyfacts on three filings it does include, matching row for row and value for value: AVTR 10-Q 244/244, AEP 10-Q 348/348 (multi-registrant, subsidiaries' `dei:LegalEntityAxis` facts excluded), Citi 10-K 923/923.

| column | type | null | source |
|---|---|---|---|
| `cik` | TEXT | no | |
| `taxonomy` | TEXT | no | `us-gaap` \| `dei` \| `ifrs-full` |
| `concept` | TEXT | no | e.g. `Revenues`, `NetIncomeLoss`, `Assets` — verbatim |
| `unit` | TEXT | no | `USD` \| `shares` \| `USD/shares` \| `pure` verbatim |
| `value` | REAL | no | |
| `period_start` | TEXT | yes: "instant (balance-sheet) fact" | |
| `period_end` | TEXT | no | |
| `fiscal_year`, `fiscal_period` | INTEGER, TEXT | no | `fy`, `fp` (`FY`, `Q1`…) |
| `form` | TEXT | no | |
| `filed_date` | TEXT | no | |
| `accession_no` | TEXT | no | |
| `frame` | TEXT | yes: omitted | SEC's deduplicated calendar frame |

Expected count: not modelled; check = every CS ticker with a `cik` has facts with `period_end` within the last 120 days, else warning (late filer) → blocking after 180.

---

## 10. Domain: the operator's account (Q13, Q20)

All four tables are written from E*Trade account endpoints through the existing masked-key transport; their archive files are encrypted (P15). No derived P&L in stage 1.

### `raw_account_position_snapshot`
Source: `/v1/accounts/{key}/portfolio`. One row per position per run; a position that vanishes is detected by snapshot comparison, never by deletion. **Natural key `(account_key_hash, symbol, osi_symbol, as_of_date, observed_at)` since dictionary v23 (v1.1.353).** `symbol` is the underlying for an option, so two legs on one name share it. Until v23 the key omitted `osi_symbol`, and the AMD 520P/540P put spread of 2026-09-24..29 read to QC-009 as one position stored twice. `osi_symbol` is null for a stock row, so stock positions key exactly as before.

| column | type | null | source (`Position`) |
|---|---|---|---|
| `account_key_hash` | TEXT | no | SHA-256 of `accountIdKey` (never the key) |
| `symbol` | TEXT | no | `Product.symbol` |
| `security_type` | TEXT | no | `Product.securityType` (`EQ` \| `OPTN` \| ...) |
| `osi_symbol` | TEXT | yes: not_applicable | built from `Product` for options |
| `right` | TEXT | yes: not_applicable | `Product.callPut` → `call`/`put` |
| `strike` | REAL | yes: not_applicable | `Product.strikePrice` |
| `expiration_date` | TEXT | yes: not_applicable | `Product.expiryYear/Month/Day` |
| `quantity` | INTEGER | no | `quantity`, **signed** (short = negative; `positionType` used to sign) |
| `position_type` | TEXT | no | `positionType` verbatim (`LONG`/`SHORT`) |
| `price_paid` | REAL | yes + status | `pricePaid` USD/share |
| `total_cost` | REAL | yes + status | `totalCost` USD |
| `market_value` | REAL | yes + status | `marketValue` USD |
| `last_price` | REAL | yes + status | `Quick.lastTrade` |
| `days_gain`, `total_gain` | REAL | yes + status | `daysGain`, `totalGain` — **provider-computed**, stored as such (dictionary marks them "provider estimate", never used as realised P&L) |
| `date_acquired` | TEXT | yes: omitted | `dateAcquired` |
| `provider_position_id` | TEXT | yes: omitted | `positionId` **verify** |

### `raw_account_balance_snapshot`
Source: `/v1/accounts/{key}/balance?instType=BROKERAGE&realTimeNAV=true`. One row per run.

| column | type | null | source (`BalanceResponse`) |
|---|---|---|---|
| `account_key_hash` | TEXT | no | |
| `cash_available_for_investment` | REAL | yes + status | `Computed.cashAvailableForInvestment` |
| `cash_buying_power` | REAL | yes + status | `Computed.cashBuyingPower` |
| `net_cash` | REAL | yes + status | `Computed.netCash` |
| `margin_buying_power` | REAL | yes + status | `Computed.marginBuyingPower` |
| `total_account_value` | REAL | yes + status | `Computed.RealTimeValues.totalAccountValue` |
| `account_type` | TEXT | yes: omitted | `accountType` |

### `raw_executed_order` and `raw_executed_order_leg`
Source: `/v1/accounts/{key}/orders?status=EXECUTED&fromDate&toDate` (the primary source of fills, per CLAUDE.md). Append-only, keyed by `(order_id, observed_at)`. A re-pull that returns an already-stored order **unchanged** writes nothing; one that returns it with different leg data **appends a second observation**, and that pair is exactly what QC-803 reads. The first pull reaches back as far as the endpoint allows; `reach_from` is recorded on the run.

**Why `order_id` is deliberately not unique** (settled at B6). An executed order is immutable, so a second version of one is a *finding*, not an error — and a unique index would turn that finding into an insert failure indistinguishable from a parse fault, landing it in QC-001 with no way to see what actually differed. The idempotence that matters is achieved a level up: the phase reads the stored `order_fingerprint` per order and the ingestion module skips an order whose fingerprint matches, so the normal daily re-pull of a 30-day window writes nothing at all. Every other supersession in this schema works the same way (a restated EDGAR fact, a rescheduled macro event, a re-fetched bar); making this one table the exception would have been the odd case, not the safe one.

`raw_executed_order`:

| column | type | null | source (`Order` / `OrderDetail`) |
|---|---|---|---|
| `account_key_hash` | TEXT | no | |
| `order_id` | TEXT | no | `orderId` |
| `order_type` | TEXT | no | `orderType` (`EQ` \| `OPTN` \| `SPREADS` \| ...) |
| `placed_time`, `executed_time` | TEXT | no / yes + status | `placedTime`, `executedTime` (ms epoch → ISO ET) |
| `order_term` | TEXT | yes: omitted | `orderTerm` |
| `price_type` | TEXT | yes: omitted | `priceType` |
| `limit_price` | REAL | yes: not_applicable | `limitPrice` |
| `status` | TEXT | no | `status` (`EXECUTED`) |
| `order_fingerprint` | TEXT | no | digest over executed time, status and every leg tuple — what makes an unchanged re-pull a no-op and a changed one visible |

`raw_executed_order_leg` (one per `Instrument`):

| column | type | null | source (`Instrument`) |
|---|---|---|---|
| `order_row_id` | INTEGER FK | no | |
| `leg_index` | INTEGER | no | position within the order |
| `symbol`, `security_type`, `osi_symbol`, `right`, `strike`, `expiration_date` | as positions | | from `Product` |
| `order_action` | TEXT | no | `orderAction` verbatim (`BUY_OPEN`, `SELL_OPEN`, `BUY_CLOSE`, `SELL_CLOSE`, `BUY`, `SELL`) — **the** open/close signal |
| `quantity_ordered`, `filled_quantity` | INTEGER | no | `quantityOrdered`, `filledQuantity` |
| `average_execution_price` | REAL | no | `averageExecutionPrice` USD/share — the realised fill |
| `estimated_commission`, `estimated_fees` | REAL | yes + status | `estimatedCommission`, `estimatedFees` |

### `raw_account_transaction` (fallback source, Q13)
Source: `/v1/accounts/{key}/transactions.json?sortOrder=DESC&...` — kept only for what orders miss (dividends, fees, interest, assignments/exercises shown as transactions). Known to be intermittently unresponsive (~120 s, masked as `oauth_problem=nonce_used`): a failure here is a `warning`, never blocking.

| column | type | null | source |
|---|---|---|---|
| `account_key_hash` | TEXT | no | |
| `transaction_id` | TEXT | no | `transactionId` |
| `transaction_date` | TEXT | no | `transactionDate` |
| `transaction_type` | TEXT | no | `transactionType` verbatim |
| `description` | TEXT | yes: omitted | `description` |
| `symbol` | TEXT | yes: not_applicable | `brokerage.product.symbol` **verify** path |
| `amount` | REAL | no | `amount` USD, signed |
| `quantity` | INTEGER | yes: not_applicable | `brokerage.quantity` **verify** |
| `price` | REAL | yes: not_applicable | `brokerage.price` **verify** |

---

## 11. Domain: macro calendar and risk-free rate (Q16.3, Q16.4)

### `raw_macro_event`
Sources: FOMC schedule (federalreserve.gov, yearly), BLS release schedules (CPI, PPI, employment). Fetched monthly; a rescheduled event is a new row with the same `event_key` and later `observed_at`.

**Both are HTML pages, and both were read live 2026-09-07 before a parser was written.** They are the only phase-8 sources that are not data feeds, so what they actually contain is recorded here rather than left to a scraper's assumptions:

- **FOMC** — `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm`. Meetings carry `fomc-meeting__month` and `fomc-meeting__date` classes inside per-year panels. Three properties that a plausible parser gets wrong **silently**: (1) a meeting straddling a month boundary names **both** months (`Apr/May 30-1`, `Jan/Feb 31-1`, `Oct/Nov 31-1`) and the decision day belongs to the **second** — reading the first yields 2024-04-01 for `Apr/May 30-1`, a real date wrong by a month; (2) not every entry is a range, since 2025 carries `August 22 (notation vote)`, which a regex demanding `d-d` drops without a word; (3) the **panels are not in chronological order** — 2026 first, descending to 2021, then 2027 appended — so a flat sweep attaches every meeting to whichever year parsed last. The event is dated on the range's **last** day, which is when the statement lands. The page publishes **no time**, so `event_time` is null rather than the 14:00 ET everyone knows: a value we believe is not a value the source published.
- **BLS** — `https://www.bls.gov/schedule/news_release/<release>.htm`, one page per release (`cpi`, `ppi`, `empsit`; 13 usable rows each, running through Dec 2026). The table is `Reference Month | Release Date | Release Time`, with dates as `Dec. 18, 2025` — the abbreviation's period is optional, `Nov 04, 2026` also occurs. The page **serialises its own navigation into a `<tr>`**, so rows are selected by a *positive* shape test (exactly three cells, middle one date-shaped) and never by skipping the first row, which would break the day that markup changes. `event_key` uses the **reference** month (`CPI-2026-08`), so a rescheduled release is a new observation of the same event rather than a new event.

GDP and PCE are BEA, not BLS, and are **not** captured in stage 1: QC-903 reads only FOMC and CPI, and a source with no consumer is a source with no way to notice it has broken.

| column | type | notes |
|---|---|---|
| `event_key` | TEXT | e.g. `FOMC-2026-09`, `CPI-2026-08` — stable across reschedules |
| `event_type` | TEXT | `FOMC` \| `CPI` \| `PPI` \| `NFP` \| `GDP` \| `PCE` \| `OTHER` |
| `event_date`, `event_time` | TEXT | ET |
| `description`, `source_url` | TEXT | |

### `raw_treasury_yield`
Source: U.S. Treasury daily par yield curve. **Verified 2026-09-05**, no key required:

`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/<YEAR>/all?type=daily_treasury_yield_curve&field_tdr_date_value=<YEAR>&page&_format=csv`

CSV, newest first, `Date` as `MM/DD/YYYY`. **One fetch returns every trading day of the year**, not just today — so the daily pull is naturally idempotent and a backfill is the same call. Values are published as **percent** (`3.91`), converted to fraction at ingestion (`/100`, per §0.1). FRED `DGS3MO` stays the fallback (free key).

**The header line, read live 2026-09-07**, mapped by **name** and never by position:

```
Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"
```

Note `1.5 Month` spells the word out where every other tenor abbreviates. That one inconsistency is the standing argument against positional reading: a positional parser survives a renamed or reordered header and **silently shifts an entire curve one column**, while a name-mapped one drops the column it cannot recognise and QC-902 reports fewer than 14 tenors. The rule generalises — a CSV's column *order* is not part of its contract unless the publisher says it is, and this one does not.

| column | type | notes |
|---|---|---|
| `curve_date` | TEXT | |
| `tenor` | TEXT | **14 tenors as published** (measured 2026-09-05, not the 9 first drafted): `1M` \| `1.5M` \| `2M` \| `3M` \| `4M` \| `6M` \| `1Y` \| `2Y` \| `3Y` \| `5Y` \| `7Y` \| `10Y` \| `20Y` \| `30Y` |
| `yield` | REAL | **fraction** (`0.0525`), converted from the published percent at ingestion |
| `source` | TEXT | `treasury` \| `fred` |

Stage-1 consumer: **QC-410** (03 §3.5), the Greek-reproduction check, which uses the 3M tenor to verify E*Trade's Greeks are on the scale the dictionary claims (P4). Stage-2 consumers reuse the same tenor by default; the choice is recorded with the derivation version.

---

## 12. Domains 13–15: short interest, analyst view, insider transactions (Q21)

The operator asked whether the domains suffice to judge "is this stock worth owning at this price". Audit result:

| Facet | Covered by | Gap |
|---|---|---|
| Company financials | `raw_edgar_fact` (all statements, quarterly, multi-year) | none |
| Valuation (P/E, EV/EBITDA, P/FCF, P/S, yield, own-history percentiles) | derivable: facts + bars + `shares_outstanding` + `market_cap` + dividends | **forward** valuation (forward P/E, PEG) — **partially closed 2026-09-06**: the free earnings calendar carries next-report `epsEstimate`/`revenueEstimate` for 99 % of the universe (§12), so one-quarter-ahead forward P/E is derivable. A full multi-year estimate curve still is not |
| Technical / trend | derivable from `raw_daily_bar` | none |
| Volatility regime | `raw_option_contract_snapshot` (IV, skew), bars (realized vol), `ext_iv_history` bootstrap | none after bootstrap |
| Options-implied sentiment (put/call OI and volume ratios, skew) | derivable from chain snapshots | none |
| Ownership / quality (dividend history, payout ratio, buybacks via share count trend) | dividends, facts, `raw_ticker_reference` history | none |
| **Short interest** | — | **captured; source DECIDED 2026-09-12: Polygon first, FINRA fallback** — Finnhub's endpoint is premium (403, 2026-09-06); Polygon's is documented in every Stocks plan; verify marker stays until the first live 200 |
| **Analyst view** (recommendation trend, target, EPS estimates and surprises) | `eps_estimate/actual` on earnings rows only | recommendation trend and forward EPS/revenue estimates **captured** (free, measured 2026-09-06); price target and estimate dispersion are premium and stay **not captured** |
| **Insider transactions** (Form 4) | — | **excluded by Q5**, but it is structured EDGAR data, not "news" |
| News sentiment | — | deliberately out: unstructured, model-dependent, cannot meet D6 |

Tables (full dictionary entries to be completed alongside the verify list in 04):

- `raw_short_interest` — `ticker, settlement_date, short_interest INTEGER, avg_daily_volume INTEGER, days_to_cover REAL, source` (FINRA publishes twice monthly). **Measured 2026-09-06: Finnhub `/stock/short-interest` is 403 on our free tier** — this domain therefore rests on Polygon's `/stocks/v1/short-interest` or a direct FINRA file. **Corrected 2026-09-11 (v1.1.226):** the collector had been calling `/stocks/**vX**/short-interest` — the documentation's placeholder, unreplaced — and Polygon's 18-byte `404 page not found` was read as a plan gap, which is how this became "the one §12 domain with no confirmed free source". Polygon documents the endpoint as included in every Stocks plan, with fields matching this table exactly. The **verify** marker stays until a live 200 returns rows: a document is not a response, and mistaking one for the other is the error being corrected.

  **Source decided 2026-09-12 (operator): Polygon first, FINRA as the fallback. Not dropped.** Checked against the provider pages that day:
  - **Polygon** (`massive.com` docs; `polygon.io` redirects there): `GET /stocks/v1/short-interest`, "Included in all Stocks plans"; filters `ticker`, `ticker.any_of`, `settlement_date` with `.gt/.gte/.lt/.lte`; `limit` max 50,000; fields `ticker, settlement_date, short_interest, days_to_cover, avg_daily_volume` — this table's columns exactly; updated every 2 weeks; history 2 years on Basic, back to 2017-12-29 on Starter and above (this install's 5-year bar backfill implies above Basic). Zero new code.
  - **FINRA** (the underlying publisher, Rule 4560, exchange-listed and OTC): free but behind a portal login / Developer Center API, one rolling year online plus archived pipe-delimited files. Same data at the source, with a new fetcher, a new parser and a credential to hold — so it is the fallback, and a later candidate as a cross-source check.
  - **Dropping the domain** was rejected: the existing app has never had short interest (`news-data-fetcher.ts` hard-codes `shortInterest: null`, so its short-squeeze term has always scored 0), which makes it a real gap rather than a duplicate.

  **Why it was still open on 2026-09-12:** `runShortInterest` returns `skipped('chain subset is empty')` before calling — and the subset was empty until v1.1.236 because bar volume was stored as 0. So the corrected path had most likely never been called. The sweep is whole-market and does not use the subset's tickers, so that skip is a gate on nothing; to be removed together with the verify marker.

  **Exit:** the first daily run with a populated subset makes the call (cadence reads `meta_response`, which has no short-interest row in gen-002). Rows returned → remove `verify` from `short_interest` (clears that promotion blocker). A refusal → read the actual response; a plan refusal moves this to FINRA.

  **Verified 2026-09-14 (closed v1.1.245, core 0.6.9):** the daily run stored **67,386 rows**, newest `settlement_date` 2026-09-14. `verify` removed; the empty-subset skip removed. FINRA stays the documented fallback.
- `raw_analyst_recommendation` — `ticker, period_month, strong_buy, buy, hold, sell, strong_sell INTEGER, provider_symbol, source='finnhub'`. **`ticker` is the ticker ASKED (dictionary v18)**; Finnhub's `symbol` goes to `provider_symbol`. Until v18 the row was keyed on Finnhub's symbol, and Finnhub resolves some tickers to another listing (GOOG→GOOGL, BRK.B→BRK.A, GFL→GFL.TO, LLYVA→FWONA — the last a different company), so rows landed on tickers nobody asked about. Rows stored before v18 keep the old keying (append-only). **Confirmed free 2026-09-06**: `/stock/recommendation` returns 200 with exactly the drafted fields (`symbol, period, strongBuy, buy, hold, sell, strongSell`), four monthly periods per call.
- `raw_analyst_estimate` — **resolved 2026-09-06, and not where the draft looked.** The dedicated endpoints are **premium**: `/stock/eps-estimate`, `/stock/revenue-estimate` and `/stock/price-target` all return **403**. But `/calendar/earnings` — already being called for `raw_earnings_event` — carries `epsEstimate` and `revenueEstimate` **per scheduled report**, on the free tier, for future dates. Coverage on *our* universe is near-total: over the next 60 days, **520 scheduled reports, 517 with an EPS estimate (99.4 %) and 515 with a revenue estimate (99.0 %)**. (The all-market figure is only ~45 % — the gap is micro-caps, so measuring this on the raw calendar rather than on the universe would have understated it by half.) So the table becomes `ticker, fiscal_period, eps_estimate_avg, revenue_estimate_avg, source='finnhub'` sourced from the calendar row, and **it costs no extra call**. What stays unavailable is estimate *dispersion* — `high`/`low`/`num_analysts` are premium-only and are dropped from the table; PEG and forward P/E are recoverable **one report ahead**, not as a full estimate curve.
- `raw_insider_transaction` — `cik, ticker, filer_name, filer_role, transaction_date, transaction_code, shares INTEGER, price REAL, shares_owned_after INTEGER, accession_no, line_no INTEGER, security_class TEXT` (EDGAR Form 4; **natural key `(accession_no, line_no)` since dictionary v19, v1.1.284.** `line_no` is the transaction's 1-based position within the filing, counted before any line is skipped, so it is the filing's own line number; non-derivative transactions are numbered first and derivative ones continue the sequence, which leaves every pre-v20 row's number unchanged. The previous key `(accession_no, transaction_date, filer_name, transaction_code)` could not tell apart the lots a filer routinely sells on one day at different prices: Japan Post sold AFL 9,545 @ 116.62 and 4,055 @ 117.02 on 2026-09-14, and QC-009 read 39 such pairs as duplicates. Content columns do not identify a line either, since two identical conversion lines exist in the same run. `line_no` is null on rows ingested before v19; the existing `news-data-fetcher.ts` already parses these). **Both classes since dictionary v20 (v1.1.305), separated by `security_class` (`non_derivative` / `derivative`).** B7a stored non-derivative transactions only, because without a column to tell them apart an option grant's notional share count would sit in the same `shares` column as an open-market purchase and corrupt every insider-buying signal computed from it, undetectably. That is still true, so **`security_class` must be read before `shares` is summed — the two are not the same quantity and must never be pooled.** What forced the decision was QC-906: it reads "a fetched Form 4 yielded no rows" as the signature of a schema change, and with derivative-only filings dropped the dominant cause of zero rows was an ordinary option grant. It fired on 2 of the 2 runs that ever had data (19.1 % and 11.7 % against a 10 % threshold) and had **never once passed**; all 11 filings it named on 2026-09-21 were correct Form 4s carrying only derivative transactions (AMCR, AUGO, BILL, CTAS). **The widening is carried in the RECIPE, not read from config** (`recipes.form4({ derivatives: true })`), and the key is omitted when false: a parser that produced more rows than are already stored would break replay equality (AC-4/QC-951) for every response captured before it, while a pre-v20 response's stored recipe has no `derivatives` key, rebuilds this parser without it, and replays to exactly the rows it produced then. `security_class` is null on those rows, so a null means non-derivative — but an absence of derivative rows beside it says nothing. A Form 4 reporting only *holdings* still parses to no rows, which is rare and is a finding worth having. The column is a plain `TEXT` and not an `enumOf`: `applyDictionary` grows a populated table with a bare `ALTER TABLE … ADD COLUMN <type>`, so a declared CHECK would live in the generated DDL and never in the stored one and this table would read as drifted on every open. `transaction_code` is stored **verbatim** for the same reason: an `F` (shares withheld for tax) is not a sale, and a two-way buy/sell mapping manufactures insider selling out of payroll. Every field is wrapped in a `<value>` element that may sit beside a `<footnoteId/>`, and a genuinely absent price (awards, gifts) arrives as an **empty** element rather than a missing one — so a price is read from inside the wrapper and stored null, never zero, which would read as a free purchase. Captured by **one daily full-index sweep**, not per ticker: EDGAR publishes `full-index/<year>/QTR<n>/form.idx` listing every filing of the day, so a single call yields every Form 4 filed and the universe filter is applied locally. Per-ticker polling would be ~300 calls a day to learn that almost nothing was filed. **The sweep walks every session after the last index that parsed (v1.1.268), up to five back, oldest first** — today's index is not published until late evening and answers 404, 403 or 503 depending on the night, so it is skipped uncaptured; a past session answering 404/403 has no index (a federal holiday the NYSE trades through) and is stepped over; any other failure on a past session is captured and stops the walk, so that session is asked for again next run. A missed day is therefore a late day, not a lost one (QC-910).

- `ref_provider_symbol_ruling` — `provider, asked_ticker, answered_symbol, decision, note, ruled_at, ruled_by` (unique on the first three; **dictionary v21, v1.1.306**). The operator's standing answer to "the provider answered for a different symbol than we asked — is that the same issuer?". Finnhub resolves GOOG to GOOGL, BRK.B to BRK.A, NWS to NWSA, GFL to GFL.TO and JHX to JHX.AX, all one company each, and **LLYVA and LLYVK to FWONA, which is not** — Liberty Live Group carrying Liberty Media Formula One's counts, identical numbers under two tickers that are not it. Which it is cannot be decided from the symbols (see QC-909), so the ruling is data rather than a guess in a parser. **Seeded in preflight, before it is read**, for the reason `ref_trading_day` and `ref_macro_series` are; the seed never overwrites a row that exists, so an operator who rules differently in the workbench keeps that. **The fail-open direction is the OPPOSITE of the calendar's and that is deliberate:** an *unruled* mismatch is still STORED and still reported by QC-909, because dropping a row on no evidence would hide a feed gap behind silence — only an explicit `different_issuer` ruling stops a write, and the asked ticker then reads as having no coverage, which is true and which QC-905 reports as the gap it is. **The refusal rides in the ingest RECIPE** (`refusedSymbols`, omitted when empty so an unruled ticker keeps its digest): a parser that stores FEWER rows breaks replay equality (AC-4/QC-951) exactly as one storing more does, and a ruling made today must not retroactively change what last week's response parsed to. Rows written before a ruling **stay** — they are the evidence of what the provider answered and they carry `provider_symbol`, the same call `repairStickyOsiPadding` made when it closed mispadded ranges rather than rewriting them.

**Q21 decision:** all three added. Each is a few calls per day, structured, provenance-clean. News sentiment stays out.

---

## 13. External series (`ext_`) and stage-1 derived (`derived_`)

### `ext_iv_history` (Q17)
| column | notes |
|---|---|
| `ticker`, `date` | |
| `iv30` | fraction; the source's 30-day constant-maturity ATM IV |
| `source` | one value for the whole table (chosen in 04) |
| `method_note` | the source's published method, verbatim |
| `load_run_id` | the one-shot run |
| `stitch_date` | stored on `meta_generation` as well; readers use ext rows only before it. **Null until the series is accepted** — an unaccepted series has no stitch date because nothing reads it |
| `accepted` | `0` on load, `1` only after the overlap check has run on at least `MIN_OVERLAP_DAYS` paired days and the operator has ruled (04 §7.3). **Nothing reads a row with `accepted = 0`**: a bought series that has not yet earned a comparison is exactly as usable as no series at all, and rank reports its declared gap either way |

**Loading is not accepting.** The two are separate columns because they are separate facts, and conflating them is how a series with no overlap at all would come to be read as if it had been checked. The purchase itself must cover `stitch_date + MIN_OVERLAP_DAYS` for acceptance to be reachable — see 04 §7.3, where the requirement and its measured justification live.

### `derived_iv30_daily` (Q7)
The one derived table in stage 1, so IV rank has a clean own-computed history from day one.

| column | notes |
|---|---|
| `ticker`, `as_of_date` | |
| `iv30` | fraction; variance-time interpolation between the two expirations bracketing 30 calendar days, ATM = strikes bracketing `underlying_price`, mid-IV of call and put |
| `near_expiration`, `far_expiration`, `near_iv`, `far_iv` | inputs kept for reproducibility |
| `derivation_version` | P4 |
| `status` | `ok` \| `insufficient_expirations` \| `no_atm_quotes` — a declared gap, never a guess |

---

## 14. Legacy record (`legacy_`) — the existing app's decisions (Q6, Q19)

Populated by the hand-off contract in 04 (forward, from the day the collector starts) and by the one-time import (backward, marked `pre_collector = 1`). Segregated: no foreign keys into `raw_` tables; joins happen only in explicit studies.

| table | key columns |
|---|---|
| `legacy_brief_run` | `legacy_run_id, trading_date, slot, legacy_app_version, brief_id, emailed_at, pre_collector` |
| `legacy_brief_candidate` | `legacy_run_id, ticker, mode (wheel/buy/...), considered_rank, survived INTEGER, composite_score, final_disposition` — **every** ticker considered |
| `legacy_brief_candidate_gate` | `candidate_row_id, gate_name, passed INTEGER, tested_value REAL, threshold REAL, reason TEXT` |
| `legacy_brief_candidate_signal` | `candidate_row_id, signal_key, raw_value, normalized_value, weight, enabled` |
| `legacy_brief_leg` | `candidate_row_id, leg_index, osi_symbol, right, strike, expiration_date, bid, ask, mid, iv, delta, open_interest, volume, volume_status, liquidity_score` — as priced at decision time. **Two unit/identity faults before v1.1.347, both in the existing app's builder:** (1) `iv` holds a **percentage** on every row written before it (measured 2026-10-11: 2,238 rows since 10-01, 5.0–118.5, mean 50.1) although the column is declared a fraction — the lab keeps IV ×100 and the builder passed it through; divide pre-v1.1.347 rows by 100. (2) every leg carried the **setup's** expiration, so a calendar/PMCC far leg got the near expiry: its `osi_symbol`, `expiration_date` and the pin built from it name a contract that may not exist (CRWD `CRWD--261030C00237500`, 2026-09-29) |
| `legacy_dice_selection` | `legacy_run_id, eligible_count, selected_candidate_row_id, selection_rule, eligibility_trace_json` |
| `legacy_critic_verdict` | `candidate_row_id, verdict, rationale, context_json (the exact context object), model` |
| `legacy_import_log` | `import_run_id, source_table, rows_read, rows_written, rows_rejected, rejection_report_json` (Q19) |
| `legacy_config_import_*` | one per Q19 category-1 source (watchlists, conviction stocks + bands, ETF list, scoring configs, screen presets, payoff strategies), each row stamped `origin='legacy_import'` and validated against the dictionary |

---

## 15. Expected-count model summary (input to 03)

| Table | Expected rows per daily run | Basis |
|---|---|---|
| `raw_daily_bar` | \|universe active\| | `ref_universe_membership` current ∧ `ref_trading_day.is_trading_day` |
| `raw_eod_quote` | \|universe active\| | same |
| `raw_option_expiration` | ≥ 1 per chain-subset ticker | `ref_chain_subset_membership` current |
| `raw_option_contract_snapshot` | = Σ contracts parsed from responses | `meta_response.parse_status` (AC-5), not a model |
| `raw_index_quote` | \|`ref_macro_series`\| | |
| `raw_account_position_snapshot`, `raw_account_balance_snapshot` | ≥ 0 / exactly 1 | |
| `raw_split`, `raw_dividend`, `raw_earnings_event`, `raw_edgar_*`, `raw_macro_event`, `raw_treasury_yield` | event-driven; checked by freshness and consistency rules, not counts | |

---

## 16. Verify list (must be closed in 04 before the dictionary is frozen)

1. ~~E*Trade `OptionGreeks.theta` time unit; `timeStamp` epoch unit.~~ **CLOSED 2026-09-07**, one live SPY chain call. `theta` is **per day**: E*Trade -0.18651 against a Black-Scholes -0.2285 per day and -83.39 per year — three orders of magnitude between the candidates, so this was never going to be a close call once asked. `timeStamp` is **epoch seconds**: 1788552898 reads as 2026-09-04T20:14:58Z as seconds and as January 1970 as milliseconds. IV confirmed a **decimal fraction** (0.11554).
2. ~~E*Trade index symbol for VIX and the `All.*` field names beyond `lastTrade`.~~ **CLOSED 2026-09-07.** The symbol is plain **`VIX`** (HTTP 200, 14.53, inside the [5,150] band); `VIX.X` is rejected as invalid. **All five drafted `All.*` names exist** — `lastTrade`, `open`, `high`, `low`, `previousClose` — plus `totalVolume`, `bid` and `ask`.
3. ~~E*Trade `Position.positionId`; transactions `brokerage.*` paths.~~ **CLOSED 2026-09-07.** `positionId` is present and **numeric**. `brokerage.quantity` and `brokerage.price` are present on every sampled transaction; `brokerage.product` comes back as an **empty object** on cash transactions (`Transfer`) and populated on instrument ones (`Sold Short`, `Bought To Cover`) — so the drafted null meaning turned out to be the observed behaviour rather than an assumption.
4. Polygon `weighted_shares_outstanding` availability on the current plan. **The fallback is already proven** (04 §11, 2026-09-06): `share_class_shares_outstanding` comes back for >= 95.8 % of the universe on this plan, so `shares_outstanding` will populate regardless of how the primary resolves — what one live call still settles is which value `shares_source` records.
5. ~~Finnhub free-tier availability of estimates and short interest~~ — **settled 2026-09-06** (04 §11): recommendations, insider transactions and calendar-borne estimates are free; dedicated estimate/target endpoints and short interest are 403. **Polygon short-interest plan coverage remains open** (Q21) and is now the only unresolved source in §12.
6. Treasury daily par yield feed format and the exact fetch URL.
7. Measured admitted count for the working chain-subset thresholds (Q15).

**Two findings from the same session that were not on this list, and are the reason it exists:**

- **`inTheMoney` is the string `"y"` / `"n"`, not a boolean.** The dictionary declares `in_the_money` a flag, so a plain cast was the
  obvious implementation — and it would have been wrong in the worst available way, because `Boolean("n")` is `true` and **every
  contract would have read as in-the-money**. Nothing would have thrown, no check would have fired, and a moneyness filter would have
  quietly selected the whole chain. Now converted explicitly by `etradeYesNoToFlag`.
- **`expiryType` has a fourth value, `MONTHEND`**, alongside `WEEKLY`, `MONTHLY` and `QUARTERLY`. Harmless precisely because the column
  is stored verbatim rather than mapped into an enum of our own — which is the general argument for storing provider vocabularies raw,
  made concrete on the first live call.
- **`volume` really does come back as `0`** (60 of 171 SPY calls), distinct from absent. So the D7 rule is a **presence** test, never a
  truthiness one: "did not trade" and "not reported" are different facts and only one of them is data.
