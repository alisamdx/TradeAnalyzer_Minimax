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
  httpGet(url: string, headers?: Record<string,string>): Promise<ProviderResponse>;   // EDGAR, Treasury, Finnhub, FOMC/BLS
  // As built (v1.1.223): the HOST authenticates — core's URLs never carry a key. Finnhub's key
  // goes in the X-Finnhub-Token header (never the query string); no key configured → refused,
  // not sent. Every call is logged to logs/api/ (error-body preview on failure only). Finnhub is
  // paced by the host app's ONE shared Finnhub limiter (55/min) — per KEY, so the existing app's
  // EarningsRefreshJob and this collector spend one allowance, as with Polygon (v1.1.224).

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
| 2 | **Daily bars** | 1 per active ticker (~1,089) | 1 | `raw_daily_bar` |
| 3 | **EOD snapshot** | 1 | 1 | `raw_eod_quote` |
| 4 | **Corporate actions** | 2 window sweeps + per-discontinuity | 2 | `raw_split`, `raw_dividend` |
| 5 | **Account** | 4 (portfolio, balance, orders, transactions) | 0 | `raw_account_*`, `raw_executed_order*` |
| 6 | **Chain subset & sticky sets** | 0 (computed) | 2, 5 | `ref_chain_subset_membership`, `ref_sticky_contract` |
| 7 | **Expirations & chains** | 1 per subset ticker + 1 per in-window expiration (~500 + ~4,000–6,500) | 6 | `raw_option_expiration`, `raw_option_contract_snapshot` |
| 8 | **Event & macro domains** | earnings sweep slices (~10, subdividing on the cap), EDGAR (rolling filer slice, ~20 + facts, ~10), VIX (1), yields (1), macro calendar (4, monthly), short interest (1, weekly) / recommendations (~500, weekly), insider **1 + one Form 4 per universe filing** | 1 | `raw_earnings_event`, `raw_analyst_estimate`, `raw_edgar_*`, `raw_index_quote`, `raw_treasury_yield`, `raw_macro_event`, `raw_short_interest`, `raw_analyst_recommendation`, `raw_insider_transaction` |
| 9 | **Derivation** | 0 | 7 | `derived_iv30_daily` |
| 10 | **Gate & email** | 0 | all | `qa_*`, `meta_run` (status, `gate_verdict`) |

Ordering rationale: bars before the subset rule (it reads dollar volume); account before chains so today's held contracts are sticky *today*; the long chain phase after every cheap phase so a chain-phase failure never costs the cheap domains; derivation after chains; the gate last and always.

**Phase 8 is the only phase whose sub-phases run on different cadences** — daily for the curve and the quotes, weekly for recommendations and short interest, monthly for the macro calendar, and *filing-triggered* for the XBRL facts. **The cadence gate reads `meta_response`, not the domain table.** Asking "when did we last write a recommendation row" cannot separate a call that was never made from one that was made and returned nothing, and those two want opposite responses; asking when the call was last *made* separates them. Each sub-phase also isolates its own failure, so a dead domain arrives at the gate as a count of zero rather than costing the other eight.

### 2.1 Preflight (phase 0)

0. **The trading calendar seeds itself** (`ensureTradingCalendar`, built 2026-09-07) — five years back, two forward, generated from NYSE rules and upserted, before it is read. It lives here rather than in a one-shot precisely because step 1 fails open: an unseeded calendar does not stop the run, it makes every weekend and holiday look like a session. See 02 §2.
1. `ref_trading_day` says today is a trading day, else the run records `skipped_non_trading_day` and exits (no email; the watchdog also knows the calendar).
2. The current generation is `pilot` or `production` (not `closed`).
3. E*Trade probe: one `/v1/market/quote/SPY` through the host's renew-and-retry transport. Failure does **not** abort the run — phases 5 and 7 will fail individually and the gate will say so. Polygon key presence is checked the same way.
4. `meta_run` row created; `collector_version`, `dictionary_version`, capture-rule ids in force recorded.

### 2.2 Per-response contract (all phases)

Every provider call follows one path, in this order, and there is no other path (P11):

1. **Call** through the host transport. A **list** endpoint is swept to the end of its cursor (`sweepPolygonPages`): a `limit` is a page size, not a total, so `next_url` is followed until absent and **each page is captured separately** through steps 2–3 — `meta_response` holds exactly what the provider sent and a replay re-ingests each page through the same recipe. Only the path and query of a `next_url` are used (the origin is discarded; a response body is data, never a destination). Stopping early — page budget spent, cursor not advancing, cursor pointing off-provider — sets `at_provider_cap` on the last page instead of passing in silence.
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
| 2 bars | ~1,089 | Polygon | **500/min** (the limiter's maximum — see below) | ~1.2–2.2 min † |
| 3, 4, 8 misc | ~350 | mixed | — | ~5 min |
| 5 account | 5 (list, portfolio, balance, orders, transactions) | E*Trade | — | < 1 min |
| 7 expirations | ~500 | E*Trade | 120/min | ~4 min |
| 7 chains | **~4,000–6,500** (500 tickers × 8–13 in-window expirations) | E*Trade | 120/min | ~33–54 min |
| 9, 10 | 0 | — | — | ~2 min |
| **Total** | **~6,000–8,500** | | | **~46–68 min**, start 17:05 → done ≈ 17:50–18:15 ET |

**The Polygon pace was drafted at 600/min and is 500** — another drafted number meeting a measured constraint. `TokenBucketRateLimiter` clamps to 500 in both its constructor and `setRate`, so 600 was never expressible: it would have been silently reduced, and the budget above would have been planning against a rate the code cannot produce. Two further facts settled the number rather than the draft's "⅓ of observed peak" reasoning. First, **the collector was not going through the limiter at all** until v1.1.212 — `polygonGet` called `fetch` directly, against 06 §5 change #3 — so every elapsed figure measured before then (a `universe_seed` at ~1,900 rpm, 1,092 calls in 34 s) describes an unthrottled run and is not a pace this budget may assume. Second, **nothing applied the stored rate at startup**: `setRate` was only ever called from the settings save handler, so the app booted at 100 rpm whatever Settings displayed. Both are fixed in v1.1.212; the limiter is now seeded from the setting, the default is 500, and migration 081 moves a stored `100` (the old default, so no evidence of intent) to 500 while leaving every deliberately chosen value alone.

† **The bucket's burst is a one-time credit and the elapsed figures are meaningless without it.** `burstSize` defaults to `requestsPerMinute`, so the limiter starts with **500 tokens in hand**: the first 500 calls of a run are granted instantly and only the remainder is paced. A phase of *n* Polygon calls therefore takes `max(0, n − tokensInHand) ÷ 8.33/s`, which is why the bars row carries a range — 1.2 min from a full bucket, 2.2 min if an earlier phase has already drained it.

**Measured 2026-09-09, and it is the arithmetic that validates the limiter rather than the other way round.** A `universe_seed` of 1,092 Polygon calls: 500 from the burst, 592 paced ⇒ 71.0 s predicted, **70 s observed** (host handle held 20:58:29–20:59:40), zero 429s. The same run discriminates the alternatives — unthrottled would be ~34 s, and the double-token-spend fixed in v1.1.213 would be ~3.4 min. The whole daily Polygon load (~1,440 calls) is ~1.9 min on the same basis, against ~14 min at 100/min: the deadline holds either way, but the headroom this section relies on does not.

The chain call count carries a real range because the **expirations-per-ticker figure is still unmeasured** (§11). The old app's ~7.3 chain calls per symbol is not evidence: it was requesting a guessed list of 8 Fridays, not each ticker's actual expirations (§10). A liquid name at this cut plausibly lists ~8 weeklies inside 90 DTE plus ~3 monthlies plus the 2 extra, so **13 is the honest upper end** and 8 the optimistic one. This is the single largest uncertainty in the run budget and it is one `optionexpiredate` sweep away from being known.

Hard deadline: phase 10 must complete by **19:15 ET**; the 19:30 watchdog reports otherwise. At the measured subset (~500) the run finishes ≈ 18:15 ET at worst, leaving ~1 h of headroom. Because membership is **sticky and therefore only grows**, that headroom is consumed over time and is worth watching: at the full universe (~1,089, which the drafted `$20M` threshold would have selected on day one) chains alone are ~8,700–14,000 calls ≈ 1.2–1.9 h, ending 18:30–19:10 ET — inside the deadline but with no margin for a retry storm. The subset rule is the lever to pull first.

Bars fetched at 17:05 are treated as final per the settlement quirk; `is_final` is set from `respondedAt ≥ 17:00 ET`, and any non-final bar is re-fetched at the end of phase 7 (R3).

---

## 4. Capture rules and sticky sets (P6)

### 4.1 Rule definitions in force at stage-1 start

| domain | version 1 definition |
|---|---|
| `universe` | `{ lists: ["sp500", "russell1000", "etf_list"], etfListSource: "config" }` |
| `bars` | `{ scope: "universe_active", adjusted: true, depthDays: 1 }` (backfill job uses `depthYears: 5`) |
| `quotes` | `{ scope: "universe_active", source: "polygon_full_snapshot" }` |
| `chain_subset` | `{ minClose: 10, minAvgDollarVolume20d: 233_000_000, sticky: "ticker" }` ‡ |
| `chain` | `{ maxDte: 90, extraMonthlies: 2, allStrikes: true, sticky: "contract" }` |
| `account` | `{ ordersLookbackDays: 30, transactionsFallback: true }` |
| `earnings` | `{ horizonDays: 120, initialSliceDays: 14, subdivideAtCap: true }` ※ |
| `edgar` | `{ scope: "universe_cs_with_cik", refetchOnNewFiling: true, sweepDays: 7 }` |
| `sentiment` | `{ shortInterestEveryDays: 7, recommendationsEveryDays: 7, insiderDailyIndexSweep: true }` |

※ **`initialSliceDays: 14` is known to be too wide in peak season and that is deliberate.** Measured 2026-09-06: a 15-day window over 2026-10-22..11-05 came back with **exactly 1,500 rows** — the cap — while the three earlier 15-day windows returned 190, 172 and 553. So the first slice of the October/November sweep will *always* trip `at_provider_cap` and subdivide, and that is the intended behaviour: the collector discovers the season rather than carrying a hard-coded narrow slice through the ten months it is not needed. What must never happen is trusting a capped payload, which is the bug this rule exists to prevent (P8).

‡ **measured 2026-09-05, not drafted** — see §11. The originally drafted `$20M` admitted **1,104 of 1,136 tickers (97.2 %)**: it sat at the **1st percentile** of 20-day dollar volume (median $190M) and could not select. `$233M` cuts just above the median and admits ~500. Changing any value creates a new `meta_capture_rule` row.

Changing any value creates a **new `meta_capture_rule` row**; runs from then on reference it; the change is an `info` exception so it appears in that day's email.

### 4.1a The account (phase 5)

The account keys are **discovered, not configured**: `/v1/accounts/list` is called first and every account whose `accountStatus` is not `CLOSED` is collected. Capturing only the first would silently drop a second book, and a configured key would drift the day an account is opened or closed.

That list response is archived (encrypted, like every account line) and **never ingested** — it is the one place the raw `accountIdKey` appears, and there is no raw table that should hold it. Everywhere else the key is masked to `{accountKey}` before the endpoint reaches `meta_response`, and the rows carry only `account_key_hash` (P15).

Phase 5 also derives the `held_in_book` sticky contracts (§4.4) from the positions it just wrote, which is why it runs before phases 6 and 7 rather than after them.

### 4.2 Chain subset evaluation (phase 6)

For every active universe ticker: `close` = latest bar; `advol20` = mean over the last 20 trading days of `close × volume`, taking the **latest observation per trade date** rather than the latest 20 rows — bars are append-only, so a re-fetch leaves two rows for one day, and reading rows would make the window ten days of two readings each and blend a superseded value into the admission decision (found at B6 by a test that asserted the ticker it had just pushed below the floor was in fact below it). **Admit** if `close ≥ minClose ∧ advol20 ≥ minAvgDollarVolume20d`. Admission inserts a `ref_chain_subset_membership` row with `membership_reason = rule_pass` and `rule_inputs_json = { close, advol20 }`.

**Optionability is deliberately not a condition here** (decided 2026-09-05). `raw_ticker_reference.optionable` is derived from the E*Trade expirations call, which is made only for tickers *already* in the subset — so it is null for every candidate, and a condition written as `optionable ≠ 0` would admit every one of them while reading like a gate. That is the exact shape of the conviction-band failure this project exists to prevent (P10). The rule therefore tests price and dollar volume only, and optionability is settled one step later by the expirations call: a member returning no expirations on three consecutive runs is removed by the QC-104 path below. A ticker that was never optionable costs one wasted expirations call per run until then, which is the honest price of not pretending to test something we cannot test at admission time.

**Never remove for falling below threshold** (Q15). Removal only: delisting (universe `valid_to` set), `optionable = 0` on three consecutive runs (QC-104 first), or operator action. Additional admits regardless of rule: any ticker with a current account position (`held_in_book`), any ticker in a legacy brief's candidate set today (`recommended_by_legacy`), any operator flag (`study_flag`).

A ticker with **no stored bar at all** is not admitted and not recorded: nothing was measured, so nothing is claimed. It is a QC-201 finding on the bars side, not a subset decision.

### 4.3 Expiration window (phase 7)

From `raw_option_expiration` for the ticker: select every expiration with `0 < DTE ≤ maxDte` (DTE = calendar days from `as_of_date`), plus the `extraMonthlies` nearest expirations beyond `maxDte` whose `expiry_type = MONTHLY` (fallback: third-Friday test against `ref_trading_day.is_monthly_expiration`), plus every expiration that a current `ref_sticky_contract` row needs. Each selected expiration gets exactly one chain call; each returned contract is stored (Q2).

### 4.4 Sticky contracts

`ref_sticky_contract` rows are (re)derived every run from three sources, and closed (`valid_to`) only at expiration:

| source | reason | origin_ref | written by |
|---|---|---|---|
| `raw_account_position_snapshot` today, `security_type = OPTN` | `held_in_book` | the position row | phase 6 |
| `legacy_brief_leg` for a hand-off | `recommended_by_legacy` | the leg row | **`legacyHandoff()` itself** (§8) |
| operator flag in the inspector | `study_flag` / `manual` | user id + note | the inspector |

**Why the hand-off writes its own sticky rows.** The collector runs at 17:05; the old app's after-close brief runs inside its own chain, whose order is frozen in `sequence_order` (CLAUDE.md). If the brief lands *after* the collector, a phase 6 that derived stickiness from "today's hand-off" would not see it, and the recommended legs would first be captured on the following day — at the following day's prices, which is precisely what P5 exists to prevent. So `legacyHandoff()` inserts the `ref_sticky_contract` rows as the payload lands, and stickiness begins the moment a contract is recommended, in either job order. Phase 6 still re-derives from hand-offs as a **backstop** (idempotent: an existing `(osi_symbol, reason)` row with an open `valid_to` is left alone), which covers a hand-off that arrived while no generation was open.

Note the ordering limit this does *not* fix: a contract recommended by the evening brief is sticky from that moment, but its *first* chain snapshot is still tomorrow's run — the collector has already passed phase 7. Capturing the leg as priced at decision time is the hand-off payload's job (`legacy_brief_leg`, §8), not the chain snapshot's.

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

Retention: **forever** (the archive is the provenance layer, P2). Estimated size: chains dominate at ~17–25 MB/day compressed for the measured ~500-ticker subset (**~6 GB/yr**); everything else < 1 GB/yr. Sticky growth raises this over time; at the full universe it is ~13 GB/yr. Encrypted files carry a 16-byte header `TADATA-ENC-v1` + mechanism id so a decrypt failure is diagnosable (Q20).

---

## 7. One-shot jobs (`run_kind ≠ daily`)

Queued from the new exe's Jobs view into `meta_job_request`, claimed and executed by the old app's `collector-oneshot` handler (§1.1). Each is idempotent, each produces a gate report and email like a daily run, and each writes its own report back to `meta_job_request.result_json` so the queueing app can display it without a second channel.

### 7.1 `universe_seed`
Fetches the three lists, writes initial `ref_universe_membership` (`change_reason = initial`) and `raw_ticker_reference` for every member. Must run before the first daily run.

**The lists come from the host application's own `constituents` table** (503 sp500, 1,024 russell1000, 60 etf — **1,089 distinct across 1,587 rows**), not from a provider query. Corrected 2026-09-07 after the first live run: the sources had been Polygon queries for `market=stocks&type=CS` and `type=ETF` with `limit=1000`, which have **no index filter and no paging**, and produced **2,000 tickers in alphabetical order A–DBND with MSFT, NVDA, TSLA and SPY absent** — every call HTTP 200, the job reporting success. Polygon has no index-membership endpoint on this plan, so no query could have been right; the lists were never remote. `UniverseListSource` therefore supplies its **own response** (a remote source calls the host's transport, a local one serialises what the host holds) and both go through the same capture contract, so membership rows still point at archived bytes under the new `host_app` provider.

### 7.2 `backfill_bars` (Q7)
For every universe member: one `aggs` call for `[today − 5 y, today]` (`limit=50000` covers it). Each series runs QC-202/204/205 **on arrival**; discontinuities without a same-date `raw_split` (fetched in the same job) open exceptions immediately. The job ends with an email whose blocking list is the operator's review queue — **ticker-reuse candidates (QC-205) must be resolved before the pilot's first daily run is counted toward the 20-day streak**. ~1,600 calls, ~5 min. Rows carry `fetch_kind = backfill`, `adjusted_as_of = today`.

*Revised 2026-09-12 (`core` 0.6.6).* (1) QC-205 measures the 20 sessions of volume on **each side of every discontinuity** larger than QC-204's threshold, on the latest observation of each day — as 03 §3.3 always said; the first implementation compared the last 40 rows of each ticker, and against gen-001's zero volumes evaluated nothing on three backfills. A step with fewer than 20 sessions after it is **not yet measured** (it is measured on the run that completes the window), never estimated. (2) "today" for a one-shot job is the **session on or before** the ET calendar date: a backfill started on a weekend or after midnight is dated to the last session, not to a day with none. (3) The job's closing count is the generation's whole blocking review queue, and says so.

### 7.3 `bootstrap_iv` (Q17)

**Source: IVolatility** (decided 2026-09-07, §11). `GET /equities/eod/ivx?symbol=&from=&to=&apiKey=` returns a whole date range per symbol, so the year-long pull for the chain subset is roughly **one call per ticker** (~500), and `iv30` is expected to arrive as a **decimal fraction** — which is what 02 §0.1 stores, so there is **no ×100 here**. The existing app multiplies by 100 because it stores percentages; carrying that habit across would inflate every bootstrap row a hundredfold.

**The unit is corroborated, NOT measured, and the loader is built accordingly (B7b).** Every other phase-8 parser in this project was written after reading a live response; this one could not be, because the subscription is a spend decision that has not been taken. The evidence is: `iv-history-service.ts:484` stores `row.iv30 * 100` into a percentage column, so the existing app treats the value as a fraction, and ~262k rows loaded that way over a year produced IV ranks nobody reported as absurd. But the parser feeding it — `ivolatility-provider.ts` — states in its own comment *"We don't know the exact field names until we test the API"*, tries nine candidate keys per field, and normalises string values with **`n > 2 ? n / 100 : n`**. So the fraction reading rests partly on a magnitude guess.

**That heuristic is deliberately not carried across, and the reason generalises: a magnitude-based unit guess is untestable and fails silently in the one case that matters.** 200%+ implied volatility is ordinary for a biotech binary or a squeezed meme name, so `n > 2 → n / 100` corrupts precisely the highest-vol tickers — the ones a premium seller cares most about — and leaves a plausible number behind. The loader instead **stores the value exactly as sent** and reports `outOfBand`, the count of values outside the fraction band `(0, 5)`, beside the row count. Nothing is rescaled and nothing is dropped: dropping would make a systematic unit error look like sparse coverage, correcting it would make the error invisible. **If IVolatility turns out to send percentages, the whole first load falls outside the band at once and the job's own summary line says so** — which is the loud failure this trades the silent one for. `outOfBand == rowsStored` means the unit is wrong, not the data. The first live response must be read and `packages/core/test/bootstrap-iv.test.ts`'s fixtures corrected against it.

**IVX is IVolatility's own constant-maturity computation, not ours**, and `derived_iv30_daily` interpolates in variance time between bracketing expirations from our own chain snapshots. The overlap window is therefore measuring two genuinely different *methods* on the same days, not merely two vendors — which is what makes QC-908's threshold a quantity to **measure over the first 20 paired days rather than to trust**: a 2-vol-point median difference between two different methods may well be ordinary. Set it from the observed distribution, the same way every other † is set. Pulls the source's 30-day constant-maturity ATM IV for the **chain subset at bootstrap time** (not the whole universe — that is what IV rank will be computed for), one year back, into `ext_iv_history`. Raw responses archived so the subscription may lapse (Q10).

#### The purchase must include an overlap window

**`MIN_OVERLAP_DAYS = 20`.** The pull's coverage must not stop at the day own-computation begins; it must run to at least `stitch_date + 20 trading days`, so there are 20 days on which *both* series measured the same tickers. This is a **constraint on what is bought**, not only on what is checked — and it is the one requirement here that cannot be added retroactively. If the subscription lapses on the day the collector starts computing its own IV, no later work can recover the comparison.

Twenty days is the smallest window that gives a per-ticker paired difference more than a handful of observations while staying inside a single month's subscription; it is a working value, to be replaced by whatever the first bootstrap's own distribution says was needed.

**Why this is a requirement and not an assumption.** The existing app's `iv_history` is spliced from IVolatility (2025-05-29 → 2026-05-29) to E*Trade-computed values (2026-06-01 → now) with **zero overlapping ticker-days** — measured 2026-09-07. Everything one would want to know about that splice is therefore unanswerable. On equal 67-day windows the E*Trade era shows 1.30× the IV range and 1.24× the day-to-day noise of the IVolatility era, which would matter a great deal for IV rank — but the two windows are different calendar quarters, so **source character and market regime cannot be separated**, and no amount of analysis on the stored data will separate them. An overlap is the only thing that would have. (The seam's level step is *not* evidence of anything: +2.9 % across the join, against +1.0 %, +3.4 % and +5.2 % on comparable weekends inside the IVolatility era.)

#### Load and acceptance are separate steps

The pull may run at any time; the series is **not readable until it is accepted**, and acceptance requires the overlap to exist:

1. **Load.** Rows land in `ext_iv_history` with `accepted = 0`. Nothing reads them — rank and percentile compute from `derived_iv30_daily` alone and report their declared gap, exactly as they would if no bootstrap had been bought.
2. **Overlap check**, re-run at the end of every daily run while any unaccepted series exists. For every subset ticker on every day both series have a value, it stores the paired difference distribution in the job's quality report.
3. **Acceptance**, once `paired_days ≥ MIN_OVERLAP_DAYS`: median absolute difference > 0.02 (2 vol points) † is a blocking exception — the operator either accepts with a note or the series stays unread. `stitch_date` is set on `meta_generation` at this point, and only then do rank computations read ext rows for dates before it.

**A zero-overlap check FAILS; it does not pass.** The check as first drafted read "for every day both series exist" — which on zero such days evaluates nothing, reports nothing, and is indistinguishable from a clean result. That is the shape this project has now hit three times (the conviction band that could never fire, the liquidity gate that always did, and the vacuous source scans), and it is why the count of paired days is itself a stored, thresholded quantity rather than an implicit precondition. `paired_days` is reported on every evaluation, fired or not (P10).

### 7.4 `legacy_import` (Q19)
The job reads the old tables and writes only into the generation. It takes the batch mutex, so no other job of the old app is mid-write while it reads. Category 1 (user-authored config) is copied through validators; every rejected row is listed in `legacy_import_log.rejection_report_json`. Category 5 (stored decisions) is copied into `legacy_*` with `pre_collector = 1`. Categories 2–4 are **not** touched; the job has **no code path** for them — a category that cannot be copied by accident beats one guarded by a flag somebody flips.

**It does not ATTACH, and the draft that said it should was solving a problem it did not have (B8).** The job executes *inside* the old app, which already holds a write-capable connection to that file, so the handle is passed in. Attaching a second connection to a file this process has open would add one for no gain and re-introduce the very Windows WAL problem the "write-capable but read-only in intent" note was working around.

**Re-running it is safe, but not by the mechanism this section claimed.** "A second run writes nothing already present (natural keys)" is false as written: `naturalKey` in the dictionary is **metadata only** — the DDL generator emits no unique index from it — so an `INSERT OR IGNORE` has nothing to conflict on and dedups nothing. It would have read as protection while providing none. The two halves want different behaviour and both are now explicit:

- **Configuration is versioned per import.** `import_run_id` is part of its declared natural key, so each import is a distinct event, and recording it again is the append-only behaviour rather than a duplicate. It answers something a deduplicated table could not: what the configuration looked like at each import.
- **Decisions are deduplicated**, by checking the declared natural key (`legacy_run_id, ticker, mode`) before inserting. Their key carries no import id, so without that check a second import would duplicate the entire brief history.

**`import_run_id` is the import's own `meta_run.run_id`**, an INTEGER foreign key — not a composite string. Assuming otherwise cost one round of foreign-key failures; the import is identified by its run like everything else.

**What was read is archived** as a `host_app` response per source table (`legacy/import/<table>`). `legacy_config_import.source_response_id` is NOT NULL and for a moment that looked like the `derived_iv30_daily` problem, where nothing honest could be named — it is the opposite case: the rows read out of the old database *are* the source, so archiving them makes the claim true rather than convenient, and it preserves the rejected rows, which is the only way a disputed rejection can be re-examined.

### 7.5 `replay` (P4, P14, AC-4)
Input: a source generation's archive directory and a target (a scratch file for QC-951, or a new generation for a real replay after a code fix). Iterates `meta_response` **from the archive files, not from the source DB** (`MANIFEST.json` + per-file line order), re-creates `meta_run`/`meta_response` rows, runs current ingestion modules, then derivations, then the gate. Output: either a diff report (rows added/removed/changed per table vs the source DB) or an opened generation. A replay never touches the source generation.

**The comparison basis (AC-4, QC-951).** Equality is over the **fact columns** a table's dictionary entries declare, with three exclusions: `row_id` (a surrogate that restarts at 1 in a fresh database), `run_id` (the replay creates its own runs), and `meta_` timestamps such as `started_at`/`finished_at`/`claimed_at` (wall-clock, not facts). Everything else must match exactly, `observed_at` included — it comes from the archived response, so a difference there is a real ingestion change. Rows are matched on the dictionary's natural key, not on insertion order, so a single-day scratch replay is comparable even though its sequences cannot align with the source. **What this trades away**: a projection cannot catch a nondeterministic *ordering* of otherwise-identical rows. That is covered instead by the ingestion-determinism tests (06 §7), which assert byte-identical output from a fixed fixture — the place where ordering is cheap to pin.

**What the archive does not hold (found at B9a, 2026-09-10).** Two things this section assumes are not true of the code. No `MANIFEST.json` is written anywhere; the index is `meta_response` alone. And an archive line holds a response's bytes and request params but **not the arguments its ingest module was built with**: `makeExpirationIngest` needs the rule's expiration `selection`, `makeChainIngest` the sticky set, `makeOrderIngest` / `makeTransactionIngest` the fingerprints and ids already stored (database state), `makeEarningsIngest` its ticker filter, and the account factories the raw account key — which the archive deliberately records only masked (P15). A replay of today's archive would have to reconstruct all of that, and a reconstructed replay reporting "equal" is a check that cannot fail on the case it exists for. **Decided 2026-09-10:** B9b adds a nullable `ingest_args_json` to `meta_response`, written on every capture, and replay covers only responses that carry it; older ones are reported as not replayable, never guessed. **Open for B9b:** the account key is the one ingest argument the archive must not hold in clear, so account responses need a different answer (the key hash, or the host re-supplying the key at replay time).

**Built at B9b (2026-09-10, `core` 0.4.0, dictionary v11).** The account-key question answered itself on reading the code: the four account parsers **only ever hashed the key**, so the recipe carries the digest the rows already store and the raw key is never persisted. As built:

- **Recipes are content-addressed** in `meta_ingest_recipe` (02 §1), pointed at by `meta_response.ingest_recipe_id`, so the Form 4 CIK map and the earnings universe list are stored once rather than per response. `captureResponse` takes the recipe and **builds the parser from it** — what is recorded is by construction what ran. `meta_response.capture_rule_id` was added beside it: replay needs the rule each call ran under, and it had lived only on the rows.
- **Replay executes in the old app** (queued like the other one-shots) because account archive lines are encrypted with its safeStorage key. It reads the archive index (`meta_response`) and the archive bytes — never the source's raw rows except as the thing compared against — verifies each body's `sha256`, and runs the SAME `indexAndIngest` capture uses into a scratch file under `gen-NNN/replay/`. The scratch file is **deleted when equal, kept as evidence when different**.
- **The comparison** is per replayed response: the rows that response produced, over every column except the primary key and reference columns (the surrogates that necessarily differ in a fresh database), plus `observed_at` **on the derived layer only** — re-deriving a day deliberately appends a later version, so there it is the derivation's clock, not a fact. Multiset, so a duplicated insert is not "equal"; `changed` counts removed/added pairs sharing a natural key.
- **Rows written by code other than a parser** — universe reconciliation, legacy import, sticky pins — are outside the comparison by construction: their responses carry no recipe (the legacy import's `ingest: () => []` was removed so it would not claim to be a parse that writes nothing).
- **Coverage is reported, and zero is not a pass**: `replayed`, `noIngest`, `beforeRecipes`, `unreadable`, `digestMismatch`, `badRecipe`. Verdicts are `equal`, `equal_on_replayed` (something could not be replayed), `different`, and `nothing_replayable` — the last never reads as equal. Derived rows are compared only for runs where every parsed response replayed.
- **Every generation captured before v11 is `nothing_replayable`**, gen-001 included — correctly. The first replayable run is the first daily run after `core` 0.4.0 is installed in the old app.
- **Replay into a new generation is DEFERRED until needed** (decided 2026-09-10, B9c). It is far larger than this section's one clause suggests: only parser output is replayable, and a generation also holds everything computed along the way — universe membership reconciliation, the chain subset per day, the sticky set, every run's gate and exceptions, the legacy imports — all of which would have to be re-executed in historical order, plus a create-fill-switch handshake between the apps (the new exe owns creation, the old app holds the decryption key). And gen-001 predates recipes, so a replay of it today yields a nearly empty generation. Scratch replay carries AC-4 and reset carries "start clean"; build this when a generation captured entirely under recipes needs a parser fix carried forward. QC-951, the weekly sampled replay, is B10.

### 7.6 `reset` (P14, AC-14)
Operator-initiated from the inspector's Jobs view, reason required, typed confirmation `RESET gen-NNN`. **Executed by the new exe itself, not queued** (revised at B9a, below). Refused while a run or a claimed request could still be in flight — within `IN_FLIGHT_HOURS = 6` of its start or claim; older `running` rows are listed as *presumed dead* and do not block, because a host that dies mid-run leaves its row `running` forever and the operator has no way to edit `meta_run`. Then, in this order: creates `gen-(N+1)` with `predecessor_no` and `reset_reason` on its own `meta_generation` row; queues `universe_seed` + `legacy_import` into it; **rewrites the shared data-root pointer** (`currentGeneration`, 06 §3.1) — the commit point, before which neither application sees any change; closes the old generation (`status = closed`, `closed_at`) and withdraws its still-queued requests, which nothing would ever claim once the pointer moves. Renames nothing, deletes nothing. The new exe reopens on the successor without a restart; the old app follows on its next job because it resolves the pointer per job. A successor directory that already exists is **refused**, not reused — it holds whatever an earlier failed attempt wrote. `backfill_bars` and `bootstrap_iv` are offered but not automatic (the operator may want to re-inspect the backfill review queue).

**Why the new exe, when this section first said the old app (revised 2026-09-10, B9a).** Q4 routes one-shot jobs through the old app because it holds the provider transports and the E*Trade token; reset calls no provider, so that reason does not reach it. And since 2026-09-07 **generation creation belongs to the new exe alone** — `ElectronCollectorHost` refuses to create a database, because the one time it did it manufactured a generation with no `meta_generation` row. A reset executed by the old app would have had to undo that refusal. The drafted "read-only flag" is `meta_generation.status = closed` and nothing more: a filesystem read-only attribute on `data.sqlite` would stop it opening write-capable, and on Windows a readonly connection silently reads stale data (CLAUDE.md). Crash order is in `packages/core/src/collector/reset.ts`: before the pointer moves nothing has changed for either app; after it, a crash leaves the old generation still reading `pilot` while nothing writes to it — untidy and visible, never a closed generation still being written.

---

## 8. Legacy hand-off contract (Q6)

The existing brief job builds this payload from data it already holds in memory at the end of a brief run and calls `collectorHost.legacyHandoff(payload)`. The handler writes the `legacy_*` rows **and** the `ref_sticky_contract` rows for every leg (§4.4) in one transaction, so a recommended contract is sticky regardless of whether the brief ran before or after the collector. The call is **fire-and-forget**: it never throws into the brief, never blocks it for more than one second (writes are queued to the collector DB), and its own failure is a collector exception, not a brief failure. It must not change what the brief decides or emails (D1).

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

- **QC-412 chain 4xx rate** (`warning` on any; `blocking` if > 0.5 % † of the run's chain calls): a 4xx on an `optionchains` call for an expiration that `optionexpiredate` listed in the same run. The archived 400 bodies will say why.

  **DIAGNOSED 2026-09-05 — the 34 % is *ours*, and this design does not inherit it.** Read from the existing app's `logs/api/api_2026-09-0{2,3,4}.jsonl`:

  | finding | evidence |
  |---|---|
  | Effectively all of it is one error | **97 %** of the 400s are E*Trade code **10031 "There are no options for the given month"** (2,618 of 2,702 on 09-04). The remainder: 60 × code 10032 "no options for this symbol", 24 × 10033 "invalid symbol" |
  | It is concentrated on **one requested date** | **2,654 of 2,702** 400s are for `2026-10-09` — the *second* Friday of October, a **weekly**. The third Friday `2026-10-16` (a monthly) succeeded 3,523 times and failed only 48 |
  | It is deterministic, not transient | the failing `(symbol, date)` set is **identical on 09-03 and 09-04**: the same 688 pairs both days |
  | The 48 monthly failures are real non-optionables | 12 symbols never got a single 200 all day — `DDS`, `NVR`, `SEB`, `LEN.B`, `LBRDA/K`, `AVB`, `EQR`, `EA`, `UI`, `WBS`, `WTM` |

  **Mechanism**: the existing app requests a **globally guessed list of Fridays** for every ticker rather than each ticker's own expirations — the `nextFridays` shape CLAUDE.md already flags. Roughly 60 % of optionable names have no listed expiration on a non-monthly Friday five weeks out, so they 400, every ticker, every day, forever.

  **Consequence for this design: none, by construction.** §4.3 selects expirations from that ticker's own `raw_option_expiration` rows, written from its own `optionexpiredate` response in the same run. A 400 then means E*Trade **contradicted itself inside one run**, which is genuinely anomalous — so the working threshold is not 5 %: **any occurrence is a `warning`, and > 0.5 % of chain calls in a run is `blocking`**. The 34 % was never a baseline to inherit; it is the signature of the bug this phase avoids. It also validates the §3 budget: the ~2,400 chain calls planned are the ~5,200 the old app actually completed, minus the ~2,700 it wasted.
- **QC-413 renew storm** (`warning`): more than 20 `renew_access_token` calls in one run (yesterday: 1,383/day). Renewing on every failure is correct; a storm means a non-auth failure is being misread as dormancy.

---

## 11. Pre-pilot checklist (must be recorded here before the first daily run)

Two kinds of item: **provider facts** the dictionary cannot be frozen without, and **threshold measurements** that turn a † into a real value before the pilot rather than after it (03 §10.2). Only the IV source is a decision rather than a measurement, and only the `backfill_bars` queue depends on a build step.

| item | how | result |
|---|---|---|
| Chain-subset admitted count at the working thresholds | ran the §4.2 rule against the existing app's `historical_prices`, as-of 2026-09-04, 1,136 tickers with 20 full days | **DONE 2026-09-05.** Drafted `$10 / $20M` admitted **1,104 (97.2 %)** — decorative; `$20M` is the **1st percentile** of 20-day dollar volume (p10 $50M, **p50 $190M**, p90 $1,026M). Threshold curve: 300→$396M, 400→$307M, 500→**$233M**, 700→$136M, 900→$78M. **Rule changed to `$233M`** (~500 tickers), operator decision 2026-09-05 |
| Universe size | `SELECT COUNT(DISTINCT ticker) FROM constituents` | **DONE 2026-09-05: 1,089**, not 1,587. The discovery figure was a *row* count (503 sp500 + 1,024 russell1000 + 60 etf = 1,587 rows), and the lists overlap almost entirely. All 1,089 have price history |
| QC-201 bar-completeness baseline | daily distinct-ticker count over the last 25 trading days | **DONE 2026-09-05.** Steady state **1,083 of 1,089 — a persistent 0.55 % miss**, the same six tickers daily, not transient. The 1 % blocking line is ~2× the floor, i.e. about **five tickers of headroom**. Non-zero baseline recorded so a future session does not read 0.55 % as a fault |
| QC-302 close disagreement | existing bars vs quotes, same day | **NOT MEASURABLE HERE.** `quote_cache` holds one row per ticker with only `fetched_at` — no as-of date, no history to compare. Needs the collector's own `raw_eod_quote`; the † value stands until the pilot |
| Expected chain calls/day at that count | one `optionexpiredate` sweep over the ~500 admitted tickers, counting expirations inside the §4.3 window | _pending_ — **the largest remaining uncertainty in the run budget** (§3). Cannot be recovered from the existing logs: E*Trade success bodies are never logged (P15) |
| E*Trade `theta` unit, `timeStamp` unit, VIX symbol, `positionId`, transactions paths (02 §16) | one manual run of each call, bodies inspected | **DONE 2026-09-07**, after the operator re-authorised. `theta` **per day**, `timeStamp` **epoch seconds**, IV a **decimal fraction**, VIX symbol **`VIX`** with all five `All.*` names present, `positionId` present and numeric, `brokerage.quantity`/`price` present and `brokerage.product` empty on cash transactions. Two things not on the list came with it: `inTheMoney` is the **string** `"y"`/`"n"` (a plain cast makes every contract in-the-money), and `expiryType` has a fourth value `MONTHEND` |
| Polygon `weighted_shares_outstanding` on the current plan | one ticker-details call | **PARTIAL 2026-09-06 — the *fallback* is proven live, the primary is not.** No key was needed: the old app's `eps` is computed *only* as `netIncome / share_class_shares_outstanding` with **no fallback** (`fundamentals-computer.ts:242-244`, and `parseFinancials` leaves `shareCount` null), so a non-null cached `eps` is proof the field came back. **1,024 of 1,069 cached tickers (95.8 %)** have one — a **lower bound**, since a null can equally mean a missing `netIncome`. So `raw_ticker_reference`'s designed fallback (02 §2) — `weighted_shares_outstanding`, else `share_class_shares_outstanding`, with the choice recorded in `shares_source` — is guaranteed to populate the column for ~96 % of the universe on day one. `weighted_shares_outstanding` itself is still unproven and needs the one live call |
| Finnhub free-tier: estimates, short interest | one call each | **DONE 2026-09-06.** Seven endpoints probed with the stored key. **Free (200):** `/stock/recommendation` (drafted fields exactly), `/stock/insider-transactions` (12 fields, richer than drafted), `/calendar/earnings`. **Premium (403):** `/stock/eps-estimate`, `/stock/revenue-estimate`, `/stock/price-target`, `/stock/short-interest`. Three consequences, all written into 02 §12: (a) **estimates survive** — the free earnings calendar carries `epsEstimate`/`revenueEstimate` per scheduled report, covering **517/520 (99.4 %)** of universe reports in the next 60 days at **no extra call**, so forward P/E is recoverable one quarter ahead and only estimate *dispersion* is lost; (b) **short interest has no confirmed free source** and now rests on Polygon or FINRA — the only unresolved source in §12; (c) `hour` is `''` on **47 %** of universe rows and `dmh` never appears, so `report_time` needs an explicit empty-string -> `omitted` conversion. Measuring coverage on the *raw* calendar rather than the universe would have read 45 % instead of 99 % — the difference is entirely micro-caps |
| Treasury par-yield fetch URL and format | one fetch | **DONE 2026-09-05, re-confirmed with the exact header line 2026-09-07 (B7a).** URL and CSV format verified, no key. **14 tenors**, not the 9 drafted (adds 1.5M, 4M, 3Y, 7Y, 20Y) — 02 §11 and QC-902 corrected. One fetch returns the **whole year**, so the daily pull is idempotent and doubles as the backfill. Published as percent, `/100` at ingestion. 3M on 2026-09-04 = 3.91 %. The header names are now recorded verbatim in 02 §11 and the parser maps by **name**: `1.5 Month` spells the word out where every other tenor abbreviates, which is the standing proof that column order is not part of the contract |
| **Macro-calendar sources (FOMC, BLS) — the only phase-8 sources that are HTML pages** | one fetch each, markup read before writing a parser | **DONE 2026-09-07 (B7a).** FOMC calendar 200, structured `fomc-meeting__month` / `fomc-meeting__date` classes in per-year panels, 2027 already published so QC-903 has forward data. BLS `cpi`/`ppi`/`empsit` all 200, 13 usable rows each through Dec 2026. **Three FOMC traps found by reading rather than assuming**, each silent: a month-straddling meeting names both months and belongs to the second; `August 22 (notation vote)` is not a range; the year panels are not in chronological order. Full write-up in 02 §11. A fourth non-finding worth recording: `federalreserve.gov/json/ne-calendar.json` returns **HTTP 404 with a full HTML body** — a response body is not evidence of success, and a parser that only checks for content would have happily parsed the 404 page |
| **EDGAR `User-Agent` contact address** | set the host's agent string; one EDGAR call with it | _pending, operator decision_ — EDGAR's fair-access policy asks for a contact address in the agent, and sustained automated access without one risks a block. The host already sends `TradeAnalyzer/<version> (collector)` on every `httpGet`, which is descriptive but carries no contact. **The address belongs in host configuration, never in `core`**: a checked-in library has no business knowing who is running it, and an address hard-coded there travels with the code to whoever builds it next |
| IV bootstrap source chosen | compare IVolatility vs MarketData.app on method note, depth, subset coverage, price — **a spend decision, not a measurement**; not needed until B7. **The purchase must cover `stitch_date + 20 trading days`** so the overlap check has something to measure (§7.3); a source that only sells history up to the purchase date cannot be accepted, whatever it costs | **DECIDED 2026-09-07: IVolatility.** The choice was already made once, in the existing app, and the evidence sits in the provider code rather than in a changelog. `ivolatility-provider.ts` reads `/equities/eod/ivx`, which returns **pre-computed constant-maturity ATM IV as true as-of-date snapshots** and is annotated "the primary source for IV history backfill". `marketdata-provider.ts` carries the disqualifying note: MarketData.app returns **null IV — "common for historical chains"** — and the provider falls back to a Black-Scholes solve from the bid/ask midpoint, recording which it used in `ivSource: 'api' | 'bs'`. Its `date` parameter is also an **expiration filter, not an as-of date**, so a historical snapshot needs a two-call bracket per day. The stored row counts corroborate it: IVolatility **262k** rows over a year, MarketData.app **1k** rows over two days. **The changelog alone would have given the wrong reason.** v0.23.7 reverted MarketData.app with "hit rate limits in practice" — but that revert was of the **daily capture** job, a different role from a one-time historical pull, and rate limits on an unattended nightly job say nothing about a one-shot backfill. Had that been the only record, MarketData.app would still look viable. The reason it is not is the null-IV gap on historical chains, which is recorded only in a source comment. **Still to confirm before the pull: that the subscription can be held live through `stitch_date + 20 trading days`.** |
| **Diagnose the 34 % chain 4xx rate** (§10, QC-412) | read the archived 400 bodies in the existing app's `logs/api/api_*.jsonl` | **DONE 2026-09-05 — ours.** 97 % are code 10031 on a globally-guessed weekly date the ticker does not list; deterministic across days. Per-ticker expirations (§4.3) eliminate the class; QC-412 threshold tightened 5 % → 0.5 %. Full write-up in §10 |
| QC-410 Greek reproduction: delta tolerance, and with it the `theta` time unit, `timeStamp` epoch unit and IV scale | one live chain call reproduced through Black-Scholes; settles three verify-list items at once | **DONE 2026-09-07.** Tolerance **0.05**, from a measured 0.018–0.029 systematic gap that is a *model* difference (American vs European) rather than an error — see 03 §3. The three unit questions it was bundled with are all settled |
| QC-301 quote completeness (1 %) | coverage rate over the existing app's stored quote history | **NOT MEASURABLE HERE 2026-09-06** — the same structural reason as QC-302: `quote_cache` is `PRIMARY KEY (ticker)` with only `fetched_at`, so it holds the *latest* quote per ticker and no per-run history at all. A daily coverage rate cannot be reconstructed from it. Needs the collector's own `raw_eod_quote`; the † stands. (QC-201, the **bar** half of the drafted pair, is measured above — the two were listed together but only one is answerable) |
| QC-407 underlying disagreement (1 %) | E*Trade `nearPrice` vs Polygon last on one live chain call | **UNBLOCKED 2026-09-07** — E*Trade `nearPrice` read 770.19 for SPY on a live chain. The comparison itself lands with phase 7 at B6, when both sides are captured in the same run |
| QC-702 shares-outstanding drift (25 %) | EDGAR facts vs Polygon reference for the CS universe | **NOT MEASURABLE HERE 2026-09-06 — neither side of the comparison exists in the old schema.** `historical_financials.shares_outstanding` is the *only* share-count column anywhere in that 67-table schema and it is empty in practice (**1 ticker, 20 rows, 0 non-null**, latest period 2026-03-31); `fundamentals_cache` stores a `DerivedRatios` payload that carries `marketCap` but **no `shareCount`** (0 of 1,069 rows), even though `polygon-provider.ts:231` parses `share_class_shares_outstanding` — the field is read and then dropped before caching. There is **no `cik` column** in the schema either, so the EDGAR side was never wired. Backing shares out of `marketCap / price` would compare Polygon against itself. The † stands until the pilot |
| QC-101 universe drift (5 %) | index membership change history | **PARTIAL 2026-09-05.** The old schema tracks additions only (`constituents.added_at`; no removal history), so this is a lower bound: **60 additions on 2026-07-22 = 5.5 %**, plus 25 on 07-27 — the Russell reconstitution. The 5 % line therefore *will* fire annually by design, which is now noted on the check. A true drift distribution needs the new `ref_universe_membership`, so the † stands |
| `backfill_bars` review queue cleared | all QC-205 exceptions resolved/accepted | **MECHANISM BUILT 2026-09-06 (B5); the queue itself waits on a real backfill.** `backfillQueueClear()` reports it, and `recordTickerReuse()` is the ruling — it closes the membership range at the boundary and opens a new one with a `predecessor_ticker` lineage, deleting nothing. The splice date defaults to the QC-204 finding's own date, because getting it wrong by a day silently leaves one bar of the new entity in the old range |

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
