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
| Quantity | `INTEGER` | count | shares, contracts, volume, open interest |
| Trading day | `TEXT` | `YYYY-MM-DD`, America/New_York | `2026-09-05` |
| Timestamp | `TEXT` | ISO-8601 **with offset** | `2026-09-05T17:02:11-04:00` |
| Flag | `INTEGER` | `0` / `1` | |
| Enumeration | `TEXT` | lower-case, fixed set stated in the dictionary | `right = 'call' \| 'put'` |
| Identifier from a provider | `TEXT` | verbatim | `osi_symbol`, `order_id`, `cik` |

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

Raw tables have **no `UPDATE` or `DELETE` path**; a trigger raises on both (AC-2). Supersession is a new row with a later `observed_at`; readers resolve "current as of X" as *latest `observed_at` ≤ X* per natural key. Where a domain needs an explicit validity range (membership tables) it uses `valid_from` / `valid_to` instead.

### 0.3 The status-column pattern (P3)

A value column that could be null for more than one reason gets a companion `<col>_status TEXT` and the value column's null meaning becomes "see status". Standard status values:

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
| `raw_option_contract_snapshot` | `(as_of_date)`, `(ticker, as_of_date)`, `(osi_symbol, as_of_date)`, `(ticker, expiration_date, as_of_date)` |
| `raw_split`, `raw_dividend` | `(ticker, execution_date)` / `(ticker, ex_dividend_date)` |
| `raw_earnings_event` | `(ticker, report_date)`, `(report_date)`, `(ticker, observed_at)` |
| `raw_index_quote` | `(symbol, as_of_date)` |
| `raw_edgar_filing` | `(cik, filed_date)`, unique `(accession_no)` |
| `raw_edgar_fact` | `(cik, concept, period_end)`, `(accession_no)` |
| `raw_account_position_snapshot` | `(as_of_date)`, `(symbol, as_of_date)` |
| `raw_account_balance_snapshot` | `(as_of_date)` |
| `raw_executed_order` | unique `(order_id)`, `(executed_time)` |
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
| `dedup_hash` | TEXT | `sha256(provider + endpoint + params_json + body)` — the idempotence key of 04 §2.2. Unique index. It makes **re-ingesting an identical response** a no-op (crash recovery, replay); it does **not** make re-running a day idempotent, because a fresh call returns a different body and correctly appends a new version (P1) |
| `encrypted` | INTEGER | `1` for account-domain files (Q20) |
| `at_provider_cap` | INTEGER | `1` when the response size equals a known provider cap (P8; Finnhub 1500) |
| `parse_status` | TEXT | `ok` \| `partial` \| `failed` — a failed parse still keeps the archive row |

Archive layout: `gen-NNN/archive/<provider>/<YYYY-MM-DD>/<endpoint-slug>.jsonl.gz`, one JSON line per response `{ id, requestedAt, params, status, body }`. Account-domain files are `.jsonl.enc` (safeStorage/DPAPI, header names the mechanism).

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

Expected count: |current members| ≈ 1,587 at start.

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
| `volume` | INTEGER | no | `v` (Polygon returns float; converted with an integrality check → `invalid` if fractional) |
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
| `day_open`, `day_high`, `day_low`, `day_close`, `day_volume`, `day_vwap` | REAL/INTEGER | yes + status | `day.*` |
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
| `osi_symbol` | TEXT | no | `osiKey` — the contract's identity across days |
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
| `report_date` | TEXT | no | Finnhub `date`; E*Trade earnings date |
| `report_time` | TEXT | yes: omitted | Finnhub `hour` (`bmo`/`amc`/`dmh`) |
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
| `last`, `open`, `high`, `low`, `prev_close` | REAL | yes + status | `All.lastTrade`, `All.open`, `All.high`, `All.low`, `All.previousClose` (**verify** names beyond `lastTrade`) |
| `provider_timestamp` | TEXT | yes: omitted | |

---

## 9. Domain: fundamentals (Q5)

Stored in the honest raw form SEC publishes — **facts**, not statements. Statements (income, balance, cash flow), TTM roll-forwards and ratios are derived (stage 2), reproducible from these rows.

### `raw_edgar_filing`
Source: EDGAR `submissions/CIK##########.json`.

| column | type | notes |
|---|---|---|
| `cik`, `ticker` | TEXT | |
| `accession_no` | TEXT | unique |
| `form` | TEXT | `10-K` \| `10-Q` \| `8-K` \| `20-F` \| ... |
| `filed_date`, `report_date` | TEXT | |
| `primary_doc` | TEXT | |

### `raw_edgar_fact`
Source: EDGAR `api/xbrl/companyfacts/CIK##########.json`. Fetched when `raw_edgar_filing` shows a new 10-K/10-Q since the last fact pull (weekly sweep). Rows are appended per `(cik, taxonomy, concept, unit, period_end, fiscal_period, accession_no)`; a restated value in a later filing is a new row.

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
Source: `/v1/accounts/{key}/portfolio`. One row per position per run; a position that vanishes is detected by snapshot comparison, never by deletion.

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
Source: `/v1/accounts/{key}/orders?status=EXECUTED&fromDate&toDate` (the primary source of fills, per CLAUDE.md). Append-only keyed by `order_id`; a re-pull that returns an already-stored order writes nothing (idempotent). The first pull reaches back as far as the endpoint allows; `reach_from` is recorded on the run.

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

| column | type | notes |
|---|---|---|
| `event_key` | TEXT | e.g. `FOMC-2026-09`, `CPI-2026-08` — stable across reschedules |
| `event_type` | TEXT | `FOMC` \| `CPI` \| `PPI` \| `NFP` \| `GDP` \| `PCE` \| `OTHER` |
| `event_date`, `event_time` | TEXT | ET |
| `description`, `source_url` | TEXT | |

### `raw_treasury_yield`
Source: U.S. Treasury daily par yield curve (one fetch returns all tenors for the day). FRED `DGS3MO` as fallback (free key).

| column | type | notes |
|---|---|---|
| `curve_date` | TEXT | |
| `tenor` | TEXT | `1M` \| `2M` \| `3M` \| `6M` \| `1Y` \| `2Y` \| `5Y` \| `10Y` \| `30Y` |
| `yield` | REAL | **fraction** (`0.0525`), converted from the published percent at ingestion |
| `source` | TEXT | `treasury` \| `fred` |

Stage-1 consumer: **QC-410** (03 §3.5), the Greek-reproduction check, which uses the 3M tenor to verify E*Trade's Greeks are on the scale the dictionary claims (P4). Stage-2 consumers reuse the same tenor by default; the choice is recorded with the derivation version.

---

## 12. Domains 13–15: short interest, analyst view, insider transactions (Q21)

The operator asked whether the domains suffice to judge "is this stock worth owning at this price". Audit result:

| Facet | Covered by | Gap |
|---|---|---|
| Company financials | `raw_edgar_fact` (all statements, quarterly, multi-year) | none |
| Valuation (P/E, EV/EBITDA, P/FCF, P/S, yield, own-history percentiles) | derivable: facts + bars + `shares_outstanding` + `market_cap` + dividends | **forward** valuation (forward P/E, PEG) needs consensus estimates — not captured |
| Technical / trend | derivable from `raw_daily_bar` | none |
| Volatility regime | `raw_option_contract_snapshot` (IV, skew), bars (realized vol), `ext_iv_history` bootstrap | none after bootstrap |
| Options-implied sentiment (put/call OI and volume ratios, skew) | derivable from chain snapshots | none |
| Ownership / quality (dividend history, payout ratio, buybacks via share count trend) | dividends, facts, `raw_ticker_reference` history | none |
| **Short interest** | — | **not captured** |
| **Analyst view** (recommendation trend, target, EPS estimates and surprises) | `eps_estimate/actual` on earnings rows only | **not captured** beyond the earnings row |
| **Insider transactions** (Form 4) | — | **excluded by Q5**, but it is structured EDGAR data, not "news" |
| News sentiment | — | deliberately out: unstructured, model-dependent, cannot meet D6 |

Tables (full dictionary entries to be completed alongside the verify list in 04):

- `raw_short_interest` — `ticker, settlement_date, short_interest INTEGER, avg_daily_volume INTEGER, days_to_cover REAL, source` (FINRA publishes twice monthly; Polygon and Finnhub both expose it; **verify** plan coverage).
- `raw_analyst_recommendation` — `ticker, period_month, strong_buy, buy, hold, sell, strong_sell INTEGER, source='finnhub'` (Finnhub `/stock/recommendation`, free tier) and `raw_analyst_estimate` — `ticker, fiscal_period, eps_estimate_avg/high/low, revenue_estimate_avg, num_analysts, source` (Finnhub estimates: **verify** free-tier availability; if premium, PEG/forward-P/E stays a declared gap).
- `raw_insider_transaction` — `cik, ticker, filer_name, filer_role, transaction_date, transaction_code, shares INTEGER, price REAL, shares_owned_after INTEGER, accession_no` (EDGAR Form 4; the existing `news-data-fetcher.ts` already parses these). Captured by **one daily full-index sweep**, not per ticker: EDGAR publishes `full-index/<year>/QTR<n>/form.idx` listing every filing of the day, so a single call yields every Form 4 filed and the universe filter is applied locally. Per-ticker polling would be ~300 calls a day to learn that almost nothing was filed.

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
| `stitch_date` | stored on `meta_generation` as well; readers use ext rows only before it |

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
| `legacy_brief_leg` | `candidate_row_id, leg_index, osi_symbol, right, strike, expiration_date, bid, ask, mid, iv, delta, open_interest, volume, volume_status, liquidity_score` — as priced at decision time |
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

1. E*Trade `OptionGreeks.theta` time unit; `timeStamp` epoch unit.
2. E*Trade index symbol for VIX and the `All.*` field names beyond `lastTrade`.
3. E*Trade `Position.positionId`; transactions `brokerage.*` paths.
4. Polygon `weighted_shares_outstanding` availability on the current plan.
5. Finnhub free-tier availability of estimates and short interest; Polygon short-interest plan coverage (Q21).
6. Treasury daily par yield feed format and the exact fetch URL.
7. Measured admitted count for the working chain-subset thresholds (Q15).
