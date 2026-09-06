# 04 — The collector

> **Status:** draft v1, 2026-09-05. Implements the capture side of 01 (P1, P2, P5, P6, P7, P11, P14) over the tables in 02, feeding the gate in 03. Sourced from Q2, Q3, Q4, Q6, Q7, Q14, Q15, Q17, Q19 in `00-discovery-qa.md`.
> **Acceptance criteria owned here:** AC-1, AC-2, AC-4, AC-5, AC-6, AC-11, AC-14.
> **Measured inputs** (existing app's API log, 2026-09-04): E*Trade sustained ~100–230 calls/min (7,902 `optionchains` calls over 109 active minutes); Polygon peaked at ~1,800 calls/min; **2,702 of 7,902 chain calls (34 %) returned HTTP 400**; 1,383 `renew_access_token` calls in one day. These numbers set the run budget in §3 and motivate QC-412 in §10.

---

## 1. Role and hosting

The collector is the only writer of `meta_`, `ref_`, `raw_`, `ext_`, `derived_` and `legacy_` tables. It is a library in `packages/core/collector` with **no Electron, no scheduler and no network client of its own**. Everything environment-specific arrives through one interface, `CollectorHost`, so the same code runs inside the existing app today (Q4) and inside the new exe later, and under Vitest with fakes.

```ts
interface CollectorHost {
  // storage
  openGenerationDb(): Database;                 // the CURRENT generation's file, write-capable
  archiveRoot(): string;                        // gen-NNN/archive
  encryptForArchive(buf: Buffer): Buffer;       // safeStorage/DPAPI (P15); host decides mechanism
  decryptFromArchive(buf: Buffer): Buffer;

  // providers — the host's instrumented, rate-limited transports (never raw fetch)
  polygonGet(path: string, params: Record<string,string>): Promise<ProviderResponse>;
  etradeGet(path: string, params: Record<string,string>): Promise<ProviderResponse>;  // renew-and-retry on ANY failure inside
  httpGet(url: string): Promise<ProviderResponse>;                                    // EDGAR, Treasury, Finnhub, FOMC/BLS

  // environment
  nowET(): string;                              // ISO with offset
  sendEmail(msg: { subject: string; text: string; html: string }): Promise<void>;
  progress(phase: string, done: number, total: number, note?: string): void;
  signal: AbortSignal;
  hostApp: { name: string; version: string };
}
```

`ProviderResponse = { status: number | null; body: string; requestedAt; respondedAt; error?: string }`. A network fault is `status: null` with `error`, and is archived like any other response (P2).

### 1.1 Hosting in the existing app (stage 1)

- One new `BatchJobHandler`, **`data-collector`**, registered in `index.ts` with `dailyScheduleTime: '17:05'`, `afterCloseOnly: true`, `runOnStartup: false`. It constructs an `ElectronCollectorHost` that wraps the app's existing `etradeGet`, Polygon provider transport (through the rate limiter), `safeStorage`, nodemailer and the batch progress channel, then calls `runDaily(host)`.
- One more handler, **`collector-watchdog`**, at `19:30`, per 03 §7.3.
- A third handler, **`collector-oneshot`**, on a **2-minute interval**, claims at most one `queued` row from `meta_job_request` (02 §1) and executes that one-shot job (§7). The operator never launches these from the old app: **the new exe's Jobs view is the only UI** (05 §7), and it queues by inserting a row. The old app executes because it holds the provider transports and the E*Trade token (Q4); nothing else about the arrangement is load-bearing, which is why cut-over is later just "the new exe stops queueing and runs them itself".
- The existing brief job gains one call: `host.legacyHandoff(payload)` (§8). Nothing else in the existing app changes (D1).
- The collector's SQLite connection is **separate** from the app's own database connection; the two files never attach to each other except during the one-time legacy import (§7.4), which attaches the old file **write-capable but read-only in intent** — write-capable purely because a readonly connection cannot attach the live WAL index on Windows and would silently read stale data (CLAUDE.md). The import reads the old database and writes only into the generation.
- The batch mutex serialises the collector with the app's own jobs. `17:05` places it after the app's after-close chain has started; if that chain is still running, the collector waits its turn. The 19:30 watchdog catches the case where the wait swallowed the day.

### 1.2 Hosting in the new exe (later)

The new exe implements the same `CollectorHost` with its own scheduler and, when it takes over the E*Trade credentials (Q19 category 2), its own transport. Cut-over is: disable `data-collector` in the old app, enable it in the new one, same generation, same tables — the `host_app` column on `meta_run` records the switch.

---

## 2. The daily run

One run per trading day, slot `after_close`. Phases execute in order; each phase writes its own rows and checkpoints (`meta_run.phase_progress_json`) so a crash or cancellation resumes from the last completed unit, never from the start.

| # | Phase | Calls (typical) | Depends on | Writes |
|---|---|---|---|---|
| 0 | **Preflight** | 2 | — | `meta_run` (status `running`) |
| 1 | **Universe & reference** | ~10 list fetches + reference for changed/heartbeat tickers (~60/day) | 0 | `ref_universe_membership`, `raw_ticker_reference`, `ref_sic_sector` |
| 2 | **Daily bars** | 1 per active ticker (~1,580) | 1 | `raw_daily_bar` |
| 3 | **EOD snapshot** | 1 | 1 | `raw_eod_quote` |
| 4 | **Corporate actions** | 2 window sweeps + per-discontinuity | 2 | `raw_split`, `raw_dividend` |
| 5 | **Account** | 4 (portfolio, balance, orders, transactions) | 0 | `raw_account_*`, `raw_executed_order*` |
| 6 | **Chain subset & sticky sets** | 0 (computed) | 2, 5 | `ref_chain_subset_membership`, `ref_sticky_contract` |
| 7 | **Expirations & chains** | 1 per subset ticker + 1 per in-window expiration (~300 + ~2,400) | 6 | `raw_option_expiration`, `raw_option_contract_snapshot` |
| 8 | **Event & macro domains** | earnings sweep slices (~10), EDGAR (changed filers, ~20), VIX (1), yields (1), macro calendar (monthly), short interest / recommendations / insider (~300, cadence-gated) | 1 | `raw_earnings_event`, `raw_edgar_*`, `raw_index_quote`, `raw_treasury_yield`, `raw_macro_event`, `raw_short_interest`, `raw_analyst_*`, `raw_insider_transaction` |
| 9 | **Derivation** | 0 | 7 | `derived_iv30_daily` |
| 10 | **Gate & email** | 0 | all | `qa_*`, `meta_run` (status, `usable`) |

Ordering rationale: bars before the subset rule (it reads dollar volume); account before chains so today's held contracts are sticky *today*; the long chain phase after every cheap phase so a chain-phase failure never costs the cheap domains; derivation after chains; the gate last and always.

### 2.1 Preflight (phase 0)

1. `ref_trading_day` says today is a trading day, else the run records `skipped_non_trading_day` and exits (no email; the watchdog also knows the calendar).
2. The current generation is `pilot` or `production` (not `closed`).
3. E*Trade probe: one `/v1/market/quote/SPY` through the host's renew-and-retry transport. Failure does **not** abort the run — phases 5 and 7 will fail individually and the gate will say so. Polygon key presence is checked the same way.
4. `meta_run` row created; `collector_version`, `dictionary_version`, capture-rule ids in force recorded.

### 2.2 Per-response contract (all phases)

Every provider call follows one path, in this order, and there is no other path (P11):

1. **Call** through the host transport.
2. **Archive**: append one JSON line `{ id, requestedAt, respondedAt, status, params, body }` to `gen-NNN/archive/<provider>/<YYYY-MM-DD>/<endpoint-slug>.jsonl.gz` (account domain: `.jsonl.enc`, encrypted line by line after compression). Flush.
3. **Index + ingest in one transaction**: insert `meta_response` (with `sha256`, `archive_file`, `archive_offset`, `at_provider_cap`, `parse_status`), run the table's single ingestion module, insert the rows, commit.
4. On ingestion failure: the transaction still commits the `meta_response` row with `parse_status = failed` and zero data rows. The body is in the archive; QC-001 will fire; replay after a fix recovers the rows without refetching (P4).

Idempotence: `meta_response.dedup_hash = sha256(provider + endpoint + params_json + body)` carries a unique index (02 §1); re-ingesting an identical response is a no-op. This protects crash recovery and replay only — **re-running a day is not idempotent and is not meant to be**: the fresh call returns a different body, so it appends a new version with a later `observed_at` (P1, §5). An orphan archive line (crash between 2 and 3) is tolerated and reconciled by QC-953.

Non-2xx responses are archived and indexed like any other (they are evidence). A 4xx on a chain expiration that E*Trade itself listed is a finding (QC-412, §10).

### 2.3 Ingestion modules (P11, AC-11)

One module per raw table, `ingest/<table>.ts`, exporting a **pure** function `(response: MetaResponse, body: unknown, ctx: IngestContext) => Row[]`. `ctx` carries `run_id`, `as_of_date`, `capture_rule_id`, `observed_at`, the dictionary converters and the calendar; it carries **no database handle**, so a module cannot read or write anything else. Determinism is what makes replay reproducible (AC-4, §7.5); at this level it is literally byte-identical, since a fixture in gives fixed rows out. The dictionary generates a test per module asserting every produced column is declared and every declared converter is the only conversion applied (AC-7).

---

## 3. Time and call budget

Measured pace from the existing app (2026-09-04) and the resulting stage-1 budget:

| Phase | Calls | Provider | Pace used for planning | Elapsed |
|---|---|---|---|---|
| 2 bars | ~1,580 | Polygon | 600/min (⅓ of observed peak, leaves room for the old app) | ~3 min |
| 3, 4, 8 misc | ~350 | mixed | — | ~5 min |
| 5 account | 4 | E*Trade | — | < 1 min |
| 7 expirations | ~300 | E*Trade | 120/min | ~3 min |
| 7 chains | ~2,400 (300 tickers × ~8 in-window expirations) | E*Trade | 120/min | ~20 min |
| 9, 10 | 0 | — | — | ~2 min |
| **Total** | **~4,600** | | | **~35 min**, start 17:05 → done ≈ 17:40 ET |

Hard deadline: phase 10 must complete by **19:15 ET**; the 19:30 watchdog reports otherwise. If the chain subset grows to the full universe (Q15 allows widening), chains alone become ~13,000 calls ≈ 1.8 h at the same pace, still inside the deadline, but the subset rule is the lever to pull first.

Bars fetched at 17:05 are treated as final per the settlement quirk; `is_final` is set from `respondedAt ≥ 17:00 ET`, and any non-final bar is re-fetched at the end of phase 7 (R3).

---

## 4. Capture rules and sticky sets (P6)

### 4.1 Rule definitions in force at stage-1 start

| domain | version 1 definition |
|---|---|
| `universe` | `{ lists: ["sp500", "russell1000", "etf_list"], etfListSource: "config" }` |
| `bars` | `{ scope: "universe_active", adjusted: true, depthDays: 1 }` (backfill job uses `depthYears: 5`) |
| `quotes` | `{ scope: "universe_active", source: "polygon_full_snapshot" }` |
| `chain_subset` | `{ minClose: 10, minAvgDollarVolume20d: 20_000_000, sticky: "ticker" }` † |
| `chain` | `{ maxDte: 90, extraMonthlies: 2, allStrikes: true, sticky: "contract" }` |
| `account` | `{ ordersLookbackDays: 30, transactionsFallback: true }` |
| `earnings` | `{ horizonDays: 120, initialSliceDays: 14, subdivideAtCap: true }` |
| `edgar` | `{ scope: "universe_cs_with_cik", refetchOnNewFiling: true, sweepDays: 7 }` |
| `sentiment` | `{ shortInterestEveryDays: 7, recommendationsEveryDays: 7, insiderEveryDays: 1 }` |

† working thresholds; the measured admitted count is recorded in §11 before the pilot starts.

Changing any value creates a **new `meta_capture_rule` row**; runs from then on reference it; the change is an `info` exception so it appears in that day's email.

### 4.2 Chain subset evaluation (phase 6)

For every active universe ticker: `close` = latest bar; `advol20` = mean over the last 20 trading days of `close × volume`. **Admit** if `close ≥ minClose ∧ advol20 ≥ minAvgDollarVolume20d`. Admission inserts a `ref_chain_subset_membership` row with `membership_reason = rule_pass` and `rule_inputs_json = { close, advol20 }`.

**Optionability is deliberately not a condition here** (decided 2026-09-05). `raw_ticker_reference.optionable` is derived from the E*Trade expirations call, which is made only for tickers *already* in the subset — so it is null for every candidate, and a condition written as `optionable ≠ 0` would admit every one of them while reading like a gate. That is the exact shape of the conviction-band failure this project exists to prevent (P10). The rule therefore tests price and dollar volume only, and optionability is settled one step later by the expirations call: a member returning no expirations on three consecutive runs is removed by the QC-104 path below. A ticker that was never optionable costs one wasted expirations call per run until then, which is the honest price of not pretending to test something we cannot test at admission time.

**Never remove for falling below threshold** (Q15). Removal only: delisting (universe `valid_to` set), `optionable = 0` on three consecutive runs (QC-104 first), or operator action. Additional admits regardless of rule: any ticker with a current account position (`held_in_book`), any ticker in a legacy brief's candidate set today (`recommended_by_legacy`), any operator flag (`study_flag`).

### 4.3 Expiration window (phase 7)

From `raw_option_expiration` for the ticker: select every expiration with `0 < DTE ≤ maxDte` (DTE = calendar days from `as_of_date`), plus the `extraMonthlies` nearest expirations beyond `maxDte` whose `expiry_type = MONTHLY` (fallback: third-Friday test against `ref_trading_day.is_monthly_expiration`), plus every expiration that a current `ref_sticky_contract` row needs. Each selected expiration gets exactly one chain call; each returned contract is stored (Q2).

### 4.4 Sticky contracts

`ref_sticky_contract` rows are (re)derived every run from three sources, and closed (`valid_to`) only at expiration:

| source | reason | origin_ref |
|---|---|---|
| `raw_account_position_snapshot` today, `security_type = OPTN` | `held_in_book` | the position row |
| `legacy_brief_leg` for today's hand-off | `recommended_by_legacy` | the leg row |
| operator flag in the inspector | `study_flag` / `manual` | user id + note |

---

## 5. Resumability, cancellation, idempotence

- **Checkpoints** per phase and, inside phases 2, 7 and 8, per ticker: `phase_progress_json = { phase, doneKeys: [...], total }`. A restarted run (same `trading_date`, same slot) reuses the open `meta_run` row and skips done keys.
- **Cancellation** honours `host.signal`; the current response is archived and ingested before stopping; the run is `cancelled` and the gate still runs on what exists (partial days are `unusable` by QC-006, which is the correct verdict).
- **Re-running a completed day** (operator) creates a **new** run with the same `trading_date`; rows append with a later `observed_at` (P1). Nothing is deleted.
- **E*Trade token dormancy** mid-run: the host transport renews and retries on any failure (existing hardening). The collector additionally paces phase 7 so no gap between E*Trade calls exceeds 60 s, and issues a keep-alive quote if a Polygon-heavy phase would otherwise leave E*Trade idle for > 90 min (only relevant if phases reorder).

---

## 6. Archive layout and retention

```
gen-001/
  data.sqlite                      (+ -wal, -shm)
  archive/
    polygon/2026-09-05/aggs-day.jsonl.gz
    polygon/2026-09-05/snapshot-all.jsonl.gz
    etrade/2026-09-05/optionexpiredate.jsonl.gz
    etrade/2026-09-05/optionchains.jsonl.gz
    etrade/2026-09-05/account-portfolio.jsonl.enc      ← encrypted (P15)
    etrade/2026-09-05/account-balance.jsonl.enc
    etrade/2026-09-05/account-orders.jsonl.enc
    etrade/2026-09-05/account-transactions.jsonl.enc
    edgar/2026-09-05/companyfacts.jsonl.gz
    ...
  MANIFEST.json                    ← generation_no, opened_at, dictionary_version, file list + sha256 (rewritten at end of each run)
```

Retention: **forever** (the archive is the provenance layer, P2). Estimated size: chains dominate at ~10–15 MB/day compressed for the ~300-ticker subset (~4 GB/yr); everything else < 1 GB/yr. Encrypted files carry a 16-byte header `TADATA-ENC-v1` + mechanism id so a decrypt failure is diagnosable (Q20).

---

## 7. One-shot jobs (`run_kind ≠ daily`)

Queued from the new exe's Jobs view into `meta_job_request`, claimed and executed by the old app's `collector-oneshot` handler (§1.1). Each is idempotent, each produces a gate report and email like a daily run, and each writes its own report back to `meta_job_request.result_json` so the queueing app can display it without a second channel.

### 7.1 `universe_seed`
Fetches the three lists, writes initial `ref_universe_membership` (`change_reason = initial`) and `raw_ticker_reference` for every member. Must run before the first daily run.

### 7.2 `backfill_bars` (Q7)
For every universe member: one `aggs` call for `[today − 5 y, today]` (`limit=50000` covers it). Each series runs QC-202/204/205 **on arrival**; discontinuities without a same-date `raw_split` (fetched in the same job) open exceptions immediately. The job ends with an email whose blocking list is the operator's review queue — **ticker-reuse candidates (QC-205) must be resolved before the pilot's first daily run is counted toward the 20-day streak**. ~1,600 calls, ~5 min. Rows carry `fetch_kind = backfill`, `adjusted_as_of = today`.

### 7.3 `bootstrap_iv` (Q17)
Source chosen in §11 (one only). Pulls the source's 30-day constant-maturity ATM IV for the **chain subset at bootstrap time** (not the whole universe — that is what IV rank will be computed for), one year back, into `ext_iv_history`. Sets `stitch_date = first daily run's trading_date` on `meta_generation`. Runs the **overlap check**: for every subset ticker on every day both series exist (own `derived_iv30_daily` vs `ext_iv_history`), stores the paired difference distribution in the job's quality report; median absolute difference > 0.02 (2 vol points) † is a blocking exception on the bootstrap — the operator either accepts with a note or the series is not used. Raw responses archived so the subscription may lapse (Q10).

### 7.4 `legacy_import` (Q19)
Attaches the old database while the old app is running — it must be, since the old app is what executes this job. The attach is **write-capable but read-only in intent** (the WAL quirk above); the job reads the old tables and writes only into the generation. It takes the batch mutex, so no other job of the old app is mid-write while it reads. Category 1 (user-authored config) is copied through the dictionary validators; every rejected row is listed in `legacy_import_log.rejection_report_json`. Category 5 (stored decisions) is copied into `legacy_*` with `pre_collector = 1`. Categories 2–4 are **not** touched; the job has no code path for them. Re-runnable: a second run into the same generation writes nothing already present (natural keys), so a reset (P14) costs one re-run.

### 7.5 `replay` (P4, P14, AC-4)
Input: a source generation's archive directory and a target (a scratch file for QC-951, or a new generation for a real replay after a code fix). Iterates `meta_response` **from the archive files, not from the source DB** (`MANIFEST.json` + per-file line order), re-creates `meta_run`/`meta_response` rows, runs current ingestion modules, then derivations, then the gate. Output: either a diff report (rows added/removed/changed per table vs the source DB) or an opened generation. A replay never touches the source generation.

**The comparison basis (AC-4, QC-951).** Equality is over the **fact columns** a table's dictionary entries declare, with three exclusions: `row_id` (a surrogate that restarts at 1 in a fresh database), `run_id` (the replay creates its own runs), and `meta_` timestamps such as `started_at`/`finished_at`/`claimed_at` (wall-clock, not facts). Everything else must match exactly, `observed_at` included — it comes from the archived response, so a difference there is a real ingestion change. Rows are matched on the dictionary's natural key, not on insertion order, so a single-day scratch replay is comparable even though its sequences cannot align with the source. **What this trades away**: a projection cannot catch a nondeterministic *ordering* of otherwise-identical rows. That is covered instead by the ingestion-determinism tests (06 §7), which assert byte-identical output from a fixed fixture — the place where ordering is cheap to pin.

### 7.6 `reset` (P14, AC-14)
Operator-initiated from the inspector, note required. Closes the current generation (`status = closed`, `closed_at`, `reset_reason`), renames nothing (the directory stays `gen-NNN`, read-only flag set), creates `gen-(N+1)` with `predecessor_no`, **rewrites the shared data-root pointer** (`currentGeneration`, 06 §3.1) so both apps follow, and immediately runs `universe_seed` + `legacy_import` into it. Because the executing host is the old app while the requesting host is the new exe, the new exe re-reads the pointer when the request reaches `complete` and reopens on the new generation; it does not need a restart. `backfill_bars` and `bootstrap_iv` are offered but not automatic (the operator may want to re-inspect the backfill review queue).

---

## 8. Legacy hand-off contract (Q6)

The existing brief job builds this payload from data it already holds in memory at the end of a brief run and calls `collectorHost.legacyHandoff(payload)`. The call is **fire-and-forget**: it never throws into the brief, never blocks it for more than one second (writes are queued to the collector DB), and its own failure is a collector exception, not a brief failure. It must not change what the brief decides or emails (D1).

```ts
interface LegacyBriefHandoff {
  legacyAppVersion: string; briefId: number; tradingDate: string; slot: 'morning' | 'after_close';
  emailedAt: string | null;
  candidates: Array<{
    ticker: string; mode: 'wheel' | 'buy' | 'options' | 'bullish' | 'bearish';
    consideredRank: number; survived: boolean; compositeScore: number | null; finalDisposition: string;
    gates: Array<{ name: string; passed: boolean; testedValue: number | null; threshold: number | null; reason: string | null }>;
    signals: Array<{ key: string; rawValue: number | null; normalized: number | null; weight: number; enabled: boolean }>;
    legs: Array<{ osiSymbol: string; right: 'call' | 'put'; strike: number; expiration: string;
                  bid: number | null; ask: number | null; mid: number | null; iv: number | null; delta: number | null;
                  openInterest: number | null; volume: number | null; volumeReported: boolean; liquidityScore: number | null }>;
    critic?: { verdict: string; rationale: string; contextJson: string; model: string };
  }>;
  dice?: { eligibleCount: number; selectedTicker: string | null; selectionRule: string; eligibilityTraceJson: string };
}
```

Every `candidates[]` entry the brief scored is included — **the losers too** (P5). `volumeReported: false` is how the old app's `?? 0` is prevented from crossing over (the payload builder passes the raw field's presence). Units follow 02 §0.1 (IV as fraction; the builder converts from the old app's percentage representation **once**, and a hand-off test asserts it).

---

## 9. Failure semantics

| Failure | Behaviour | Verdict |
|---|---|---|
| Provider network fault | archived (`status null`), R1 once, then continue | QC per domain; usually `warning` if < 1 % of keys, `blocking` above |
| E*Trade token dead after renew | phases 5, 7 record every failed call, continue to 8–10 | chains/account `unusable`; email says "re-auth required" |
| Crash mid-phase | restart resumes from checkpoint (§5) | run continues; if no restart before 19:15 → watchdog |
| Ingestion bug | `parse_status = failed`, archive intact | QC-001 blocking; fix code → `replay` recovers without refetch |
| Disk full / archive write error | run **stops** (a row without provenance is worse than no row) | QC-006 blocking; email from watchdog if the stop prevented phase 10 |
| Non-trading day run triggered | exits at preflight | no email |
| Gate itself throws | run marked `failed`, minimal email "GATE FAILED" with the stack | everything `unusable` until re-gated |

---

## 10. Additions to 03 arising from the measured log

- **QC-412 chain 4xx rate** (`warning`; `blocking` if > 5 % †): a 4xx on an `optionchains` call for an expiration that `optionexpiredate` listed in the same run. Yesterday's 34 % rate in the existing app is unexplained and must not be inherited silently; the archived 400 bodies will say why.
- **QC-413 renew storm** (`warning`): more than 20 `renew_access_token` calls in one run (yesterday: 1,383/day). Renewing on every failure is correct; a storm means a non-auth failure is being misread as dormancy.

---

## 11. Pre-pilot checklist (must be recorded here before the first daily run)

| item | how | result |
|---|---|---|
| Chain-subset admitted count at the working thresholds | run the §4.2 rule against the existing app's `historical_prices` (read-only; measurement only) | _pending_ |
| Expected chain calls/day at that count | Σ in-window expirations from the existing `optionexpiredate` responses | _pending_ |
| E*Trade `theta` unit, `timeStamp` unit, VIX symbol, `positionId`, transactions paths (02 §16) | one manual run of each call, bodies inspected | _pending_ |
| Polygon `weighted_shares_outstanding` on the current plan | one ticker-details call | _pending_ |
| Finnhub free-tier: estimates, short interest | one call each | _pending_ |
| Treasury par-yield fetch URL and format | one fetch | _pending_ |
| IV bootstrap source chosen | compare IVolatility vs MarketData.app on method note, depth, subset coverage, price | _pending_ |
| `backfill_bars` review queue cleared | all QC-205 exceptions resolved/accepted | _pending_ |

---

## 12. Acceptance criteria mapping

| AC | Satisfied by |
|---|---|
| AC-1 | §2.2 per-response contract: no row without `source_response_id`; archive written before ingest |
| AC-2 | raw-table triggers (02 §0.2); collector has no update/delete statements; reset is the only deletion path and deletes nothing (closes a generation) |
| AC-4 | §2.3 pure ingestion modules + §7.5 replay from archive |
| AC-5 | §2.2 step 3 stores parse count on `meta_response`; QC-403 compares |
| AC-6 | §4 rules versioned; every snapshot row carries the rule id in force |
| AC-11 | §2.3 one module per table; dictionary-generated test |
| AC-14 | §7.6 reset + §7.4 re-runnable import |
