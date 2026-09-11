# Changelog

## [1.1.219] - 2026-09-10

`@tradeanalyzer/core` 0.4.0 (dictionary v11), `@tradeanalyzer/next` 0.2.1. **NewApp B9b.**

### Every collector capture now records how it was parsed

- `core` 0.4.0 changes what the daily collector writes: each response gets a **recipe** — which parser, built with which arguments — in the new `meta_ingest_recipe` table, plus the capture rule it ran under on `meta_response`. Content-addressed, so the Form 4 CIK map and the earnings universe list are stored once, not per response. The account key is never recorded; the parsers only ever hashed it, so the recipe carries that digest.
- The generation upgrades itself on open (two nullable columns and a new table — plain growth, asserted by a test on a populated v10 table).

### `collector-oneshot` executes `replay`

- The fifth implemented one-shot. Re-runs today's parsers over one daily run's archived responses into a scratch database under `gen-NNN/replay/` and compares the result with what is stored. It runs **here** because account archive lines are encrypted with this app's safeStorage key.
- `ElectronCollectorHost.openScratchDb` creates that file. It can never become a generation: no `meta_generation` row, no pointer, refuses a name that exists, same redirect guard. The file is deleted when the replay is equal and kept as evidence when it is not.
- A `different` verdict is a `success` batch result — the diff is the deliverable, the same rule as a red gate. `reset` is still refused here; TradeAnalyzer 2 performs it.
- Runs captured before this version have no recipes and report **nothing replayable**, never equal.
- `1,261` tests here, `420` in `core`, `48` in `next`.

## [1.1.218] - 2026-09-09

`@tradeanalyzer/core` 0.3.8, `@tradeanalyzer/next` 0.1.4. **NewApp B8 complete.**

### `collector-oneshot` executes `legacy_import`

- The fourth implemented one-shot. Copies Q19 categories 1 (config) and 5 (decisions, marked `pre_collector = 1`); categories 2, 3 and 4 have **no code path** — a category that cannot be copied by accident beats one guarded by a flag.
- **No ATTACH**: the job runs inside the app that already holds a write-capable handle to the old file, so it is passed in and the Windows WAL problem the attach note worked around does not arise.
- **An inverted conviction band is rejected, not carried** — the case Q19 names by hand. It never throws, it just computes the wrong zone, and it fed wrong Buy-zone alerts for three weeks. Every rejected row is listed with its reason, not counted.
- **04 §7.4's re-run guarantee was never there**: `naturalKey` is metadata only and generates no unique index, so `INSERT OR IGNORE` had nothing to conflict on and would have read as protection while providing none. Config is now versioned per import (its key includes `import_run_id`, so each import is an event) and decisions are deduplicated by an explicit check — without it a second import would duplicate the whole brief history. `import_run_id` is an INTEGER FK to `meta_run`, not a composite string.
- What was read is **archived** as a `host_app` response per source table, so an imported row traces back to a verbatim copy of what the importer saw — including the rows it rejected.

### The Legacy view

- Rows handed over live carry every candidate; rows imported backwards are survivors-only, and **the split is the first thing on the screen**. A zero in the rejected column on an imported run reads "not recorded" rather than "it rejected nothing" — opposite facts.
- AC-13 caught three more real collisions (`slot`, `mode`, `survived`) and none was exempted; the DTO fields are `phase`, `strategy`, `picked`. Five renames across two views today, zero exemptions.
- `1,256` tests here, `381` in `core`, `29` in `next`.

## [1.1.217] - 2026-09-09

`@tradeanalyzer/core` 0.3.7.

### The brief hands its whole candidate set to the collector (NewApp 04 §8)

- At the end of a run the brief calls `writeLegacyHandoff` with **every candidate it scored**, the rejected ones included, each with the gate that stopped it and how far off it was. `daily_briefs` keeps only survivors, so the cut from 15 to 5 has never been measurable.
- **D1 shapes the design**: the dependency is optional and defaults to null (so every existing test and any install without a generation behaves exactly as before), it runs after every decision is persisted, it is wrapped in try/catch, it is never awaited, and nothing downstream reads its result. All four are pinned by a test — "we were careful" is not a guarantee.
- The wiring resolves the shared pointer itself, returns silently with no generation, and closes the host in a `finally`: this path opens the generation outside any collector run, and a handle left open would be a second writer nobody tracks.
- **The leg's `right` is read, never inferred.** The payload is built inside the loop that already extracts the short leg, the only place a real `SetupLeg` with `side` is in scope. A leg whose side or expiration is missing is **skipped**, not filled in — the OSI symbol is constructed (`osiSymbol` in `core`, 7 tests against the format a live E*Trade chain returned), and a wrong one does not throw: it pins a contract the chain phase never matches, so the sticky set looks populated and captures nothing.
- `volume` crosses as a presence test, not `?? 0` — the distinction that cost 23 of 250 stored legs a false liquidity rejection.
- `1,256` tests here, `368` in `core`.

## [1.1.216] - 2026-09-09

Migration **082**. No `core` change.

### The two scheduled collector jobs go back on; the one-shot stays manual

- `data-collector` (17:05) and `collector-watchdog` (19:30) are enabled again. All three were switched off in v1.1.206 after 70 RED gate emails in a day; both causes are gone — the 2-minute claim loop that emitted them was deleted in that same version, and the generation has since survived **four consecutive clean seeds**.
- **Necessary rather than merely safe**: the pilot's 20-clean-day exit criterion and the IV bootstrap's 20-paired-day overlap advance only on days the collector actually runs, and twenty *consecutive* days is precisely what intermittent attention cannot produce. Keeping the freeze would have quietly meant the pilot could never finish.
- `collector-oneshot` stays off — it carried the retry loop, and a one-shot has nothing to do on a schedule. Its Run button is unaffected; `runJob` has never consulted `enabled`.
- The two scheduled jobs move **together**: the watchdog emails when no daily run happened, so with the run off it alarms nightly about a run nobody scheduled, and with it on it is what notices a swallowed day.
- **Migration 082** moves the live rows, because `registerJob` uses `INSERT OR IGNORE` and only seeds a fresh install. A test reads that SQL and asserts the one-shot is not in it, checking executable statements rather than the whole file (the migration names it in a comment explaining the omission).
- A red gate now emails once a day, which is the interface working. The failure being avoided was never "an email" — it was seventy arriving faster than one could be acted on.

### fix - a source-scanning test that went vacuous on line endings

- `tests/collector-host.test.ts` slices `index.ts` on a literal `"registerJob(\n    'data-collector'"`. With `core.autocrlf` on, a fresh clone checks that file out as **CRLF**, the pattern matches nothing, and every assertion in the block runs against an empty string and passes. Newlines are now normalised in `stripComments` before any pattern touches the source. Found because an edit rewrote the file as CRLF and the test went red — the lucky version; the unlucky one is a clean checkout elsewhere reporting green over a guard examining nothing.
- `1,254` tests.

## [1.1.215] - 2026-09-09

`@tradeanalyzer/core` 0.3.6, dictionary **v10**.

### Hosts the rest of NewApp B7b except the IV view

- **`collector-oneshot` executes `bootstrap_iv`** — the third implemented one-shot. It cannot run until an IVolatility subscription exists (a spend decision, not a build one), but job, parser and wiring are complete and fixture-tested, so the pull is a Run Now when that is taken.
- The operator line reports **`outOfBand`**, the count of values outside the fraction band `(0, 5)`, beside the row count: if the two are equal the **unit** is wrong rather than the data, and the line says so in words. The existing app's own IVolatility parser guesses the unit by magnitude (`n > 2 ? n / 100 : n`), which silently corrupts 200%+ IV — ordinary for a biotech binary or a squeezed meme name. That heuristic is deliberately not carried across.
- Dictionary **v9 -> v10**: `accepted` / `accepted_at` / `accepted_note` on `ext_iv_history` as `mutableColumns` — the IV value stays frozen, only the acceptance decision may be recorded later. Applies in place via the empty-table rebuild; no reset.
- The gate runs `checksFor(db)` rather than static `ALL_CHECKS`, so QC-907/908 register only once a series exists to compare against — a check that cannot fire would otherwise sit in the zero-fire review looking like one that is broken.
- `1,253` tests here, `351` in `core`.

## [1.1.214] - 2026-09-09

`@tradeanalyzer/core` 0.3.5, dictionary **v9**.

### Hosts NewApp phase 9 — the IV30 derivation

- `runDaily` gains a `derive` phase after `events`: no provider call, reads what the chain phase stored, writes `derived_iv30_daily` one row per ticker **including the ones it could not compute** (storing only successes would make "could not price" indistinguishable from "never looked"). A day with no chain is a no-op, not an error.
- **Shipped ahead of the rest of B7b on purpose**: the 20-day overlap clock for accepting a purchased IV bootstrap starts when phase 9 first runs in production, and our series is at zero. Waiting would have started it ~4 weeks later for no gain.
- Dictionary **v8 -> v9**: `source_response_id` and `capture_rule_id` are nullable on the `derived` layer. A derived row is a function of many stored rows, not a parse of one response — as declared at B2 the table could not have been written at all. AC-1 untouched (scoped to raw), pinned by a test. Applies in place via the B7a empty-table rebuild; no reset.
- `COLLECTOR_VERSION` caught up to `0.3.5` — left behind when the package was bumped in v1.1.212, and it lands in `meta_run.collector_version`, so runs were labelling themselves with the wrong collector. Found by the purity test that pins the two together.
- `1,253` tests here, `324` in `core`.

## [1.1.213] - 2026-09-09

`@tradeanalyzer/core` 0.3.5, dictionary version **8** (unchanged).

### fix - every `acquire()` spent TWO tokens, so the limiter ran at half its setting

- `processNextInQueue()` shifted the queue's **head** to wake the next waiter - but the callback that just succeeded is still at the head, so it shifted **itself**, re-ran via `setImmediate`, and took a second token. Measured: a burst of **10** granted exactly **5**.
- **True for as long as the class has existed.** Every Polygon path - screener, analysis, validate-all, briefing, LEAPS, news - ran at half its configured rate, and Settings displayed a number the app never used. A configured 100 was really 50; the new 500 default would have been 250.
- Fixed: the succeeding callback splices *itself* out before waking anyone, and `processNextInQueue` **peeks** rather than shifts. Peeking matters - a waiter that still cannot get tokens re-arms on a timer, and a shifted one would be re-armed while out of the queue, losing its FIFO place and becoming invisible to `drain()`.
- **Why twelve existing tests missed it**: every assertion was "did it resolve" with slack in the budget, never "how many tokens did that cost"; and the re-entry **does not happen under fake timers at all**, since `setImmediate` is faked and the deferred callback never fires. My first regression test passed *before* the fix for that exact reason - worthless, because it could not distinguish the two behaviours it existed to distinguish. The real one uses real timers, yields after each acquire, and **counts grants** so a failure reports `expected 5 to be 10` rather than hanging.
- **Net effect with v1.1.212**: effective Polygon rate goes from **50 rpm** (100 configured, halved, and the stored setting never applied at startup) to **500**. Still ~1/4 of the ~1,900 rpm measured unthrottled without a 429, so the headroom argument for 500 holds - it was made against the real peak, not the halved figure.
- **Confirmed on a live seed by arithmetic**: 1,092 Polygon calls = 500 granted instantly from the full burst + 592 paced at 8.33/s = **71.0s predicted, 70s observed**, zero 429s, `integrity_check: ok` (a fourth clean seed). The measurement separates all three hypotheses rather than merely fitting the preferred one - unthrottled would be ~34s and a surviving double-spend ~3.4 min.
- **The burst is why the prediction going in was wrong** (~2.2 min): `burstSize` defaults to `requestsPerMinute`, so a run starts with 500 tokens in hand and only the remainder is paced. Spec 04 §3's elapsed figures now carry the burst term - `max(0, n − tokensInHand) ÷ 8.33/s`, a range rather than a number, since it depends on what ran before.
- `1,253` tests.

## [1.1.212] - 2026-09-09

`@tradeanalyzer/core` 0.3.5, dictionary version **8** (unchanged). Migration **081**.

### fix - `polygonGet` bypassed the rate limiter

- `ElectronCollectorHost.polygonGet` made every Polygon call with a bare `fetch`, against spec 06 §5 change #3 and CLAUDE.md's standing rule. Deferred deliberately since v1.1.196 because the limiter changes the collector's write pace and pace was an experimental variable in the corruption investigation; three clean seeds later it is safe to move.
- It now takes a token from **the application's own limiter instance** - the instance, not a copy. Polygon rate-limits per API key and the collector shares this app's key, so two buckets would be two budgets spending one allowance; avoiding that is *why* Q4 hosted the collector in this process. `acquire(1)` runs **before** the latency clock, so a queue wait is never reported as Polygon being slow.

### fix - the stored rate limit never survived a restart

- `rateLimiter.setRate()` was called from exactly one place, the settings *save* handler, and **nothing read `rateLimitRpm` at startup**. A configured rate applied until the next restart and then silently reverted to the default - the app ran at a rate its own Settings screen did not show, with no symptom. Harmless while every caller was a person clicking; not harmless once a nightly collection budgets itself against a pace.
- The limiter is now constructed from the stored value, falling back when the row is missing or unparseable - never throwing, since it sits on the path of every provider call.

### change - default Polygon rate 100 -> 500 rpm

- `universe_seed` ~1,092 calls: ~11 min at 100, ~2.2 min at 500. Daily Polygon phases ~1,440 calls: ~14 min vs ~3 min. Both fit the 19:15 ET deadline; only one leaves the headroom NewApp 04 §3 relies on. 500 is the limiter's maximum and ~1/4 of the ~1,900 rpm the collector was measured sustaining unthrottled without a 429.
- **Migration 081** moves a stored `rateLimitRpm` of `100` to `500`, safe *because 100 was the old default* so a stored 100 carries no evidence of intent; 50, 250 and any typed value are left alone. Settings gains a 500 preset.
- **NewApp 04 §3's planned "600/min" was never expressible** - the limiter clamps to 500 in both the constructor and `setRate`, so it would have been silently reduced and the budget was planning against a rate the code cannot produce. Its "observed peak" was also measured on the *unthrottled* collector. §3 now says 500 and records why.
- `1,251` tests.

## [1.1.211] - 2026-09-09

`@tradeanalyzer/core` 0.3.5, dictionary version **8** (unchanged).

### The seed ran clean twice - and the expected fix is measurably not the reason

- Two consecutive `universe_seed` runs on fresh generations came back `integrity_check: ok`, after **five** consecutive corruptions. Same work both times - 1,092 responses / 1,083 references / 1,587 memberships / 6 failures, identical to every corrupt run - so it is not clean because it did less.
- **The baseline that had been missing every previous round**: before the first seed, 52 tables, `integrity_check: ok`, all row counts zero, `meta_generation = 1` (TA2 created it, not the collector recreating one). "Was it clean before the seed" is answerable for the first time.
- **`closed_at` earned itself on its first outing**: TA2 held the file 19:40:24-19:40:28 and TradeAnalyzer 19:51:04-19:51:38 - disjoint, by reading rather than by asking what the operator remembered having open.
- **The checkpoint is struck off.** Both clean runs logged `walBytes≈4.15MB busy=0 log=0 checkpointed=0` - a multi-megabyte WAL *file* with **zero pending frames**, because `wal_autocheckpoint` had already flushed everything long before `close()`. The explicit checkpoint moved no frames on either run, so it cannot be what stopped the corruption. It stays as a correct durability fix for the case where a WAL does hold frames at close. **One version earlier both runs would have printed nothing, and this would have shipped as the presumed fix.**
- **Still open, downgraded.** Candidates now: the build, dictionary v7->v8, the new `recordCloseHandle` write, and **concurrency** - which sits in the eliminated-suspect table on recollection alone, and could not have been recorded at dictionary v7 even if asked. Two clean runs move this from *reproduces every time* to *does not reproduce under a protocol where both applications are verified closed*.

### fix - three instruments, each wrong in the way it was being trusted

- **`applied` folded an empty WAL into a successful checkpoint** - `log === checkpointed` is also true of `0 === 0`, so "flushed four megabytes" and "there was nothing to flush" read alike. The verdict is now five-way: returned nothing / busy / short / **nothing to do** / applied. The ambiguity removed at one level had been reintroduced at the next.
- **`diagnose-generation.mjs` suggested a rename that already existed** - the stamp is a date, so a second corruption in one day collides and the operator gets `Cannot create a file when that file already exists` from the tool whose job is to stop them guessing. It now picks a free name with a time suffix, and `alreadyRetired` was widened to match the longer names it generates.
- **That stamp came from `toISOString()`** - any diagnosis after 20:00 ET would have filed a generation under **tomorrow's** date, permanently, in the directory name that *is* the evidence. Now `etDate()`. `queue-job.mjs` had the same bug writing `meta_job_request.requested_at` in UTC into a column the applications stamp in ET.
- **`queue-job.mjs` told the operator to wait for a loop removed in v1.1.206** ("claims one every ~2 minutes; it must be running"). It now says nothing will pick the job up, and gives the Batch-view steps. **A script's closing instructions are documentation and go stale like the rest of it.**
- `1,248` tests in the existing app, `303` in `core`.

## [1.1.210] - 2026-09-09

`@tradeanalyzer/core` 0.3.4, dictionary version **8** (unchanged).

### fix - a checkpoint that worked and a checkpoint that never ran looked identical

- v1.1.209 gave `ElectronCollectorHost.close()` an explicit `wal_checkpoint(TRUNCATE)` but logged a WARNING **only when it did not fully apply**. Silence then means either "it applied cleanly" or "`close()` was never reached" - opposite readings of the very seed this investigation is waiting on. A clean generation with no checkpoint line would be no evidence at all about the checkpoint.
- Every close now writes a line: `INFO` when it fully applied, `WARNING` when it did not, and a separate `WARNING` when it threw (a third outcome that silence collapsed into the other two). Each carries **`walBytes`** - the WAL size that preceded the checkpoint, `-1` when there is no `-wal` to stat, because a fully applied checkpoint over an empty WAL is not the same evidence as one over four megabytes.
- Look in `logs/errors/errors_<date>.jsonl` for `"errorClass":"CollectorCheckpoint"`.
- `packages/next` has logged every checkpoint unconditionally since it was written; this is the host catching up. **A rule pinned in one implementation does not constrain the second one** - the fourth instance of that shape here.
- Regression test in `tests/collector-host.test.ts`; spec 06 §3.5 now states the rule for every writer of a generation. `1,248` tests.

## [1.1.209] - 2026-09-09

`@tradeanalyzer/core` 0.3.4, dictionary version **8**.

### docs - the collector path is exonerated

- A screening arm closed every remaining difference between the replay and the live seed at once: Electron, in the generation's own directory, at the live pace, through the real job-queue wrapper, with varying bodies and injected failures. It matched the live run on runtime, directory, **1,083 references / 6 failures** and file shape (588 pages vs 570) - and came back `integrity_check: ok`.
- Three things had never been exercised: **failure responses** (the corrupting seed had 6, every replay had 0, so the row shape a failure writes had never been produced), **body size** (every canned response was byte-identical, so the btree packed in a way no real run does), and **the job wrapper** (`collector-oneshot` claims a `meta_job_request` row and writes the report back as JSON on completion - writes that land at the very END of the sequence, which is exactly where all three corrupt files have their damage). Plus the untested cell of the earlier 2x2: Electron *in that directory*.
- **Everything reproducible outside the app is now clean.** What remains is the real application around the collector.

### fix - `meta_open_handle` recorded opens and not closes

- The table exists so "are two applications holding this file at once" is answerable by **reading**, and it could not answer it: two open timestamps are consistent with any amount of overlap or none. So at the exact point where concurrency was the live hypothesis, the question had to be put to the operator and taken on recollection.
- Dictionary **v7 -> v8** adds a nullable `closed_at` (additive growth, so it applies inside an existing generation). Both applications stamp it before closing; `recordOpenHandle` clears a stale value on re-open; `recordCloseHandle` never throws, because turning "could not record the close" into "the application could not shut down" would be strictly worse.
- `diagnose-generation.mjs` prints each interval and **states an overlap outright** when two applications' recorded intervals intersect. Where a close is missing it says overlap *cannot be ruled out* - which is not the same as ruling it in.

### fix - the collector host never checkpointed

- `close()` was `this.db?.close()`, leaving a multi-megabyte WAL to close-time behaviour. The new exe was fixed for this after a measured **918,792-byte WAL was discarded with the base file byte-for-byte unchanged**; the collector host, which writes far more, still trusted close. It now checkpoints `TRUNCATE` explicitly and logs a WARNING when the checkpoint does not fully apply.

### Known defect, deliberately not fixed here

- `ElectronCollectorHost.polygonGet` calls `fetch` directly and **bypasses the rate limiter**, contrary to spec 06 §5 and CLAUDE.md's standing rule. Left alone on purpose: routing it through the limiter changes the collector's write pace, and that pace is an experimental variable in an open corruption investigation. Deferred, not forgotten.
- `303` tests in `core`, `1,247` in the existing app.

## [1.1.208] - 2026-09-09

`@tradeanalyzer/core` 0.3.3, dictionary version **7**.

### docs - the corruption has a signature, read from two generations at once

- Both corrupt generations were examined for the first time and they **agree**: damaged in `meta_response` AND `raw_ticker_reference`, and only those two, both times (Tree 5/12 under dictionary v5, Tree 7/14 under v6 - the same two tables, renumbered by the schema bump).
- **It does not track write volume.** `raw_daily_bar` holds 227,352 rows in the 413 MB file and is undamaged; `raw_ticker_reference` holds 1,083 and is wrecked. Those two tables are exactly what `universe_seed`'s per-ticker loop writes together in one transaction.
- The damaged pages are **418-432 of 100,848** in the large file - inside the first ~570 pages, the region its first seed allocated. The 2.3 MB file holds exactly one seed and is damaged at 453-469, the same region.
- **Inference, recorded as one**: the damage is inflicted during a `universe_seed` and nothing afterwards extends it, so today's corruption most likely dates from that generation's own first seed rather than from anything since. The 69 consecutive QC failures are consequences, not 69 events. It does **not** explain why the offline replay writes this exact pattern, at the real pace, in both Node and Electron, and stays clean.

### fix - `meta_open_handle` could not answer the question it exists for

- Keyed on `app_name` alone, so the upsert held only each application's **latest** open - an earlier redirected open is overwritten by the next healthy one and the split becomes unaskable. Measured on the real corrupt generation: both apps reported the same `db_path`, which was true of their last opens and evidence of nothing, and was read at first as "no split".
- Now keyed on **`(app_name, db_path)`**, so a path an application ever resolved survives every later open and a second row is permanent evidence of a split file set. Implemented as a UNIQUE INDEX, not a composite PRIMARY KEY - the DDL generator emits `PRIMARY KEY` inline per column, so marking two produces `table "meta_open_handle" has more than one primary key`.
- Dictionary **v6 -> v7**. Populated tables are reported as drift rather than rebuilt, by design; a fresh generation gets it outright.

### fix - the new exe stamped `openedAt` in UTC

- `packages/next` used `new Date().toISOString()` while the collector host built ET from parts. In the corruption's own forensic record the two sat side by side: `TradeAnalyzer 2 2026-09-08T03:02:53.252Z` (really **2026-09-07 23:02 ET**) beside `TradeAnalyzer 2026-09-08T23:54:19-04:00`. One of the two rows being compared was a day out.
- **`tests/collector-host.test.ts` has pinned the host against exactly this since it was written, and the new exe had the bug anyway** - the rule lived in a test attached to one implementation instead of in a function both applications call. `etTimestamp()` now lives in `core` and both call it; `packages/core/test/time.test.ts` covers the evening rollover, both DST offsets, the round trip, the ICU hour-`24` case, and that no `Z` is ever emitted.

### fix - the diagnostic advised renaming an already-retired generation

- Pointed at `gen-001-corrupt-20260907` it suggested renaming to `gen-001-corrupt-20260907-corrupt-20260909`. The recovery text was written for one case and printed in every case. A retired generation is now told it is evidence and needs nothing done - corruption there is expected, which is why it was set aside.
- `300` tests in `core`, `1,247` in the existing app.

## [1.1.207] - 2026-09-09

### fix - the generation diagnostic was describing the wrong file

- `diagnose-generation.mjs` probed for the `%APPDATA%` redirect, printed it, and then printed the pointer contents, the derived database path, its size, its modification time, its sidecars and the list of generations - **every one of those read through the redirected `%APPDATA%`, and therefore every one a fact about the container's shadow copy.** It refused only later, just before opening.
- Measured 2026-09-09: it reported `data.sqlite` at 1,789,952 bytes modified 2026-09-07 23:05 with no `-wal` and no `-shm`. The container's own copy is byte-for-byte that size and timestamp, while the collector had run against the real file the following evening. Every number was true and every one answered a different question.
- It now refuses **at the probe**, before a single line about the generation, and names the two commands that produce a real answer. It then prints the container's own copy under a heading saying that is what it is - honest, and evidence in its own right.
- **"We refuse before opening" sounded sufficient and was not**: the reading was already wrong long before the open. A diagnostic that cannot see its subject must say so and stop; what it must never do is describe something else in the same format and leave the reader to notice. Second time this tool has handed out a confident wrong answer, and the first is already recorded in CLAUDE.md.

### fix - the ABI-swap lock guard could never fire

- `rebuild-better-sqlite3.mjs` has carried a friendly EBUSY message since a running app first broke `npm test`, and it has **never been reachable**: it matched the errno against `err.message`, but the call uses `stdio: 'inherit'`, so `prebuild-install`'s output goes to the console and `err.message` is only ever `Command failed: npx prebuild-install --runtime node --force`. The word EBUSY was on the screen and never in the string being tested. Found by hitting exactly the case it was written for - a background replay harness held the binary loaded and `pretest` produced a raw `execSync` stack.
- It now asks the **file** (`openSync(binary, 'r+')` - Windows maps a loaded `.node` as an executable image and refuses write access), and asks *before* `prebuild-install` downloads anything. The message names the culprit that actually bit: a harness left running in the background, not only the apps or `npm run dev`. **A guard whose input cannot contain what it looks for is not a guard.**

### fix - the seed replay's paced arm did not pace, it stalled

- The inter-write delay used `Atomics.wait` on the grounds that a synchronous block keeps the test honest. Wrong twice: the live collector waits on a real HTTP response, so **yielding the loop is the faithful model**; and parking the *Electron main thread* in `Atomics.wait` stops libuv running its callbacks, so the seed's async continuations never resume - **1.9 seconds of CPU in 17 minutes and no output at all.** The comment guarded against "runs at full speed while reporting a pace"; the real failure was worse and in the other direction.
- With `await new Promise(r => setTimeout(r, ms))` the arm runs: **1,089 responses at 250 ms = 285.5 s, integrity ok**, identical counts and WAL size to the unpaced run. That closes the last removable difference between the replay and a live seed - the collector path, the Electron runtime, real `safeStorage`, the real pace and the environment are now all clean.

### fix - the diagnostic died on the input it exists to describe

- Run against a genuinely damaged file it threw a raw `better-sqlite3` stack from the `sqlite_master` read, **before any of its report existed** - which reads as "the script broke", not "the database is damaged". Its own header warns about that failure and the query sat outside the guard anyway. Reproduced 2026-09-09 on a deliberately corrupted copy.
- Now nothing is unguarded and integrity comes first. An unreadable schema is reported as `UNREADABLE`, never as zero tables: the empty-schema branch ends in `Remove-Item -Recurse -Force`, so collapsing the two would have advised **deleting a damaged database that is the only record of how it broke**. Same shape as `decrypt()` returning `''` for "could not decrypt" (v1.1.200) - a catch that returns the same value as "absent" destroys the distinction that names the fault.
- **Recovery advice is now `Rename-Item`, not `Remove-Item`.** A generation is cheap to rebuild by re-running the jobs; the evidence is not reproducible at all. The rename keeps the directory's own name rather than hardcoding `gen-001`.
- **`Tree N` is resolved to an object name** by looking up `sqlite_master.rootpage` in the file being examined. A tree number is only meaningful against the schema version that produced it - `Tree 5` and `Tree 7` were the same table across a dictionary bump, and reading them as two tables kept the 2026-09-07 diagnosis pointing the wrong way for an evening.
- **`meta_open_handle` and the row counts are now read even when the file is corrupt**, each guarded separately. They were skipped in exactly the case they exist for. If more than one `db_path` appears, the report says so explicitly - that is a split file set, the one mechanism known to corrupt this database.
- **Takes an explicit generation path**, so a *retired* corrupt generation can be examined at all. The whole point of renaming one aside was to keep it, and the only tool that can read it could only ever open the one the pointer named.
- The redirect probe now measures **the directory being examined**, not `%APPDATA%` globally - the redirect is per file, and an explicit target under `C:	emp` is not redirected by anything. Same correction already made in `lib/generation-access.mjs`.

### docs - the redirect is back on the corruption suspect list

- **A copy-on-write shadow of `gen-001/data.sqlite` exists in the tooling container** - 1,789,952 bytes, created 2026-09-06 17:47 ET, modified 2026-09-07 23:05 ET. Windows creates that copy at the moment a redirected process first *writes* to the path, so those timestamps bound a ~30-hour window of redirected writing that spans every corruption event and continues **after** the redirect guard shipped in both applications.
- That removes the basis for eliminating the redirect, which rested entirely on "the corruption recurred on a shell verified clean". The shell was never probed and is not clean.
- **It does not establish a cause.** Which process wrote the copy is unknown - `exception.mjs` (unguarded until 2026-09-08), the earlier unguarded scripts, or either application launched from inside the container, both of which have full Electron profiles there. Recorded as evidence, not as a verdict; promoting a corroborating detail to a premise is how the last two diagnoses went wrong. Full write-up in `NewApp/CHANGELOG.md`.

## [1.1.206] - 2026-09-09

### fix - the collector jobs are manual-only, and `enabled` now means something

- **The emails stop.** `gen-001` is malformed, so `finishJob` cannot write a terminal state for a claimed `meta_job_request`; the row stays `queued`, the **2-minute claim loop** re-claims it, the run fails identically, and the quality gate emails RED - every two minutes, run #70 and climbing. Nothing bounded it: no attempt cap, no backoff, no "this already failed" check. **A retry loop over work that cannot record its own outcome does not converge**, and it announces that once per iteration to the operator's inbox. The loop is removed; a queued job is now picked up by running `collector-oneshot` from the Batch view. The claim *path* is unchanged - the trigger was wrong, not the handler.
- **`batch_jobs.enabled` was ignored by the only trigger that matters.** `runStartupJobs` filtered `enabled && run_on_startup` and the daily tick filtered `enabled && daily_schedule_enabled`, but the **orchestrator chain** - which runs jobs twice a trading day - did not look at the column at all. So switching a job off in the Batch view did not stop it, and there was no single control that did. `getSubJobs` now filters on it. **This applies to every job**: any row already sitting at `enabled = 0` will now stop running in the chain, which is what the column has always claimed to mean.
- A job **absent** from the orchestrator's `config_json.jobs` still defaults to *enabled* - pinned in a test rather than changed. It is why three newly registered collector jobs joined the after-close chain with nobody opting them in.
- **`enabled = 0` means "does not run on its own", never "cannot be run."** `runJob` has never consulted the column, so the Batch view's Run button still works on all three - which is the operator's actual request, and is asserted so a later tidy-up cannot turn "off" into "unavailable".
- Both halves were needed: `registerJob` seeds with `INSERT OR IGNORE`, so the new `enabled: false` in `index.ts` only applies to a **fresh install**. **Migration 080** switches the three live rows (`enabled`, `daily_schedule_enabled`, `run_on_startup` all 0) - the same frozen-column trap as `sequence_order`, `config_json` and `after_close_only` (v1.1.121, v1.1.123, migration 067).
- The watchdog is off deliberately: it exists to email when no daily run happened, so with the daily run off it would send a `NO RUN` alarm every night for a run nobody scheduled.
- Tests: `tests/collector-jobs-manual-only.test.ts` (7, both arms throughout, migration executed **from the file** rather than from a copy of its SQL) and the claim-loop assertions in `tests/collector-host.test.ts` rewritten to pin its absence - keyed on `runJob('collector-oneshot'` rather than on `setInterval`, because boot has a legitimate one (the ~90-minute E*Trade keep-alive) and banning the mechanism instead of the effect would fire on it. `1,247` tests pass.

## [1.1.205] - 2026-09-08

### fix - a third dev script opened the generation with none of the guards

- `@tradeanalyzer/core` 0.3.2. `packages/core/scripts/` holds three scripts that open a generation, and the four refusals were spread across the **callers** rather than the function they share: the redirect check was a copy in `queue-job.mjs` and a second copy in `diagnose-generation.mjs`, the `-shm` in-use check was in the helper, and the refusal to create a missing file was in `queue-job.mjs` alone.
- **`exception.mjs` had none of them.** Written later for B5's ticker-reuse rulings, it resolved the pointer itself - from `homedir()`, a third spelling of a path the other two each spelled differently - called `new Database(dbPath)` on the live generation, ran `applyDictionary` against it, and closed with `db.close()`. So it would open the generation from a containerised shell, while both apps had it open, creating the file if it were missing, and could discard its own writes on exit. All four failures have each already cost this project a day, and each was already prevented **somewhere else in the same directory**.
- **The shape, for the fourth time: a capability that must apply to every caller belongs in the function they all call.** The v1.1.204 write-up says exactly this, *about these scripts*, naming the applications as the gap - so the scripts it was describing were themselves an instance of it. A copy in each caller is not a safeguard; it is a list of the callers somebody remembered, and the next script is written after the list.
- Now: `resolveGenerationPointer()` probes the pointer's directory and refuses to invent it; `openGenerationExclusively(dbPath, who)` probes the generation's directory, refuses while a `-shm` exists, refuses to create, and opens with the applications' own SQLite. Both delegate to `core`'s `assertNotRedirected` so the operator reads the same words the apps print. **Directories are the argument, never `%APPDATA%` globally** - the redirect is per file, `dataRoot` is configurable and the pointer is not.
- **The invariant is asserted rather than remembered**: a scan in `packages/core/test/generation-access.test.ts` fails any script under `scripts/` that resolves the shared pointer without the helper, or that constructs a `Database` itself. It keys on the pointer (not on `new Database`) so the replay arms stay legal, strips comments and **keeps strings** (the module path and the pointer filename are string literals), and ships three fixtures - one that must fire, one that must not, and one of pure prose that must not fire either.
- `293` tests in `core`, `1,239` in the existing app.

### chore - the Electron arm of the seed replay, and the tenth suspect falls

- `packages/core/scripts/replay-seed-in-electron.cjs` runs the `universe_seed` replay inside a real Electron main process against the Electron-ABI binary. Both arms now share `scripts/lib/seed-replay.mjs`, so the **runtime is the only difference** - two copies would drift and a divergence would be indistinguishable from the finding.
- **Clean.** Electron 32.3.3 main, node 20.18.1, ABI 128, byte-identical counts and WAL size to the Node control; clean again with real `safeStorage` for the archive. That eliminates the last suspect on the open corruption bug's list (`NewApp/CHANGELOG.md`).
- **Electron 32 will not run a `.mjs` entry point and says nothing** - no output, no error, no exit, a headless main process that has to be killed. The byte-identical `.cjs` runs normally. A silent hang is indistinguishable from the bug the harness exists to investigate.
- The replay now prints the WAL's size **before** the checkpoint (4,157,112 bytes clean). `checkpoint {busy:0, log:0, checkpointed:0}` was once read as "the WAL was empty" and carried into a wrong diagnosis; it is what a successful `TRUNCATE` looks like.

### docs - the tooling shell is the redirected one

- Verified this session: **Claude Code's shell in the desktop app is MSIX-containerised.** `detectRedirect(process.env.APPDATA)` reports `%APPDATA%` served from `AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming`, and full Electron profiles for **both** applications sit under it - `trade-analyzer-next` with its own `data\gen-001\data.sqlite` and two archive files from the 2026-09-07 seed. A directory listing through `%APPDATA%` from such a session is a *merge* of two views, and "the shell was verified clean" needs the probe rather than an impression.

## [1.1.204] - 2026-09-07

### fix - the dev scripts were corrupting the generation they inspected

- **This supersedes the root cause given at v1.1.202.** The MSIX redirect was real and the guard was worth shipping, but it was **not** what corrupted `meta_response` - the second corruption happened *after* that guard shipped, on a verified-clean shell, with both apps on the fixed builds.
- `queue-job.mjs` and `diagnose-generation.mjs` used **`node:sqlite`** (SQLite **3.51.3**) while both applications use **`better-sqlite3`** (**3.53.1**). The wal-index (`-shm`) format carries no cross-version compatibility guarantee, so running a script against a generation the collector was writing put two SQLite libraries on one wal-index. It surfaced as corruption in the table being written, and as **silently lost writes** - `queue-job` reported `request 1` on two successive runs because the first insert never reached the file.
- `node:sqlite` was chosen on the grounds that "a built-in has no ABI to be wrong". True, and reasoning about the wrong risk.
- **The identification that settled it: `sqlite_master.rootpage` on a freshly built schema.** The two events reported `Tree 5` and `Tree 7`, which read as different objects and are the same table - adding `meta_open_handle` shifted every later root page by two. **A tree number is only meaningful against the schema version that produced it**, and reading them as different tables kept the earlier diagnosis pointing the wrong way.
- `packages/core/scripts/lib/generation-access.mjs` is now the only way a script opens a generation: refuses while a `-shm` exists, opens with `better-sqlite3` only (naming `npm run rebuild:node`, **never falling back**), and checkpoints `TRUNCATE` before closing. The require and the `new Database(...)` sit in one `try`, because the binding loads lazily and the construction is what throws on an ABI mismatch.
- Tests in `packages/core/test/generation-access.test.ts` (4, in a child process since both refusals are `process.exit`), asserting **both** directions - a guard that refuses everything is an outage that looks identical in a suite testing only the refusal.
- **A diagnostic that damages what it inspects is worse than no diagnostic**, and this one was the instrument being used to decide whether the damage was happening.

## [1.1.203] - 2026-09-07

### fix - the collector could create a generation, and did

- Found while verifying v1.1.202 on the live machine, which is the only place it could have been found. After the corrupt `gen-001` was deleted, the collector's 2-minute claim tick **recreated it** - 52 tables, `integrity_check: ok`, every row count zero, and `meta_open_handle` naming only `TradeAnalyzer`. It looks healthy from every angle except the one that says whose it is.
- **Generation creation belongs to the new exe alone** (NewApp 06 §3); this app writes *into* a generation and has no business making one. `readSharedPointer` already refuses to invent a pointer for that reason, but the guard **stopped one level short** - `new Database(path)` creates the file when it is missing, so the pointer was protected and the database was not.
- The tell is **`meta_generation` = 0**, since only the new exe writes that row. Worth noting against the v1.1.201 corruption report, which filed `meta_generation` reading 0 as evidence of the corruption: it is *also* the signature of a generation the wrong application created, and once two causes share a symptom neither can be read from it alone.
- `openGenerationDb()` now throws **before** the `mkdirSync` that would create the directory and before the open that would create the file. `generationExists(pointer)` is exported and all four callers check it first - `collector-oneshot`, both `collector-daily` handlers and the claim loop in `index.ts` - so the operator sees `skipped` with a reason rather than a stack trace every two minutes. The choke point makes it safe; the call sites make it legible.
- Recovery needs no reset: such a generation is structurally correct and empty, and the new exe writes the missing `meta_generation` row on open.
- Regression tests in `tests/collector-host.test.ts` - one pins the refusal's position ahead of both `mkdirSync` and `new Database`, the other that every one of the four callers checks.

## [1.1.202] - 2026-09-07

### fix - the NewApp generation corrupted because an app was launched from a container

- The open bug recorded at v1.1.201 is resolved, and **none of the three hypotheses filed with it was right** - `applyDictionary` running every tick, the rebuild paths' FK behaviour and the archive/transaction ordering were all innocent.
- **Both applications had been launched from a containerised (MSIX) shell**, which redirects `%APPDATA%` into that package's `LocalCache\Roaming` with copy-on-write and announces nothing. A full Electron profile for each app sits under `AppData\Local\Packages\<pkg>\LocalCache\Roaming\`, the existing app's `Preferences` written **2026-09-07 17:16**, inside the corruption window. Listing the generation directory through `%APPDATA%` shows `gen-001` **and** `gen-001-corrupt-20260907`; listing the container path shows `gen-001` only - a redirected listing merges both views, so there are two `data.sqlite` files behind one logical path.
- **The redirect is per file, and that is what corrupts.** `data.sqlite` had been copy-on-written into the container while `-wal` and `-shm` still fell through to the real ones, so the two processes coordinated through **one lock and one write-ahead log while writing two different base files**.
- Every symptom follows. **`Tree 5` is `meta_response`** - confirmed by building a fresh generation from the dictionary and reading `sqlite_master.rootpage` - which is the table `universe_seed` writes hardest, and which retires the note that "the damage reaches an early table". The identical 2,318,336 bytes on two runs is a deterministic *interleaving*, not a deterministic code path.
- **`assertNotRedirected` now runs in both exes** before any SQLite handle exists - `ElectronCollectorHost.openGenerationDb()` here, `openGeneration()` in the new exe - checking the shared pointer's directory as well as the generation's. It measures the redirect by writing a marker and looking for it, because `%APPDATA%`, `process.execPath`, `cwd()` and `import.meta.url` all read as the real thing from inside a container. An inconclusive probe reports `undetermined`, never `redirected`.
- The guard had existed **only** in `queue-job.mjs` and `diagnose-generation.mjs` - the two places that could not destroy anything - while the applications that could had none. Both scripts now import the one implementation.
- **`meta_open_handle`** (dictionary version 6) records which application opened the generation and the `db_path` it resolved, so "are the two apps looking at the same file" is answered by reading rather than inferring. `diagnose-generation.mjs` prints it and flags a disagreeing path or a lone row.
- Tests: `packages/core/test/appdata-redirect.test.ts` (12) and `test/open-handle.test.ts` (4). The redirect suite builds a real fake container - a junction whose `LocalCache\Roaming` *is* the probed directory - so the guard is asserted to **fire**, not only to stay quiet.

## [1.1.201] - 2026-09-07

### fix - the NewApp collector's universe came from the wrong place

- The first live `universe_seed` succeeded mechanically - 2,096 Polygon calls, every one a 200 - and captured **the wrong 2,000 tickers**. `NEW_APP_UNIVERSE_SOURCES` asked Polygon for `market=stocks&type=CS` and `type=ETF` with `limit=1000` under the list names `sp500` and `etf_list`: **no index filter** (Polygon has no index-membership endpoint on this plan, so the names were aspirational) and **no paging** (`limit=1000` returns one page; `next_url` pages the rest). Result: 2,000 tickers alphabetically A-DBND, with MSFT, NVDA, TSLA, SPY, GOOGL, META, JPM, XOM and WMT all absent.
- **The correct lists were never remote.** They are in this application's own `constituents` table - 503 sp500, 1,024 russell1000, 60 etf, **1,089 distinct across 1,587 rows**, exactly the figure NewApp 04 §4.1 records - maintained by the existing `constituents-refresh` job. `newAppUniverseSources(db)` reads them and serialises each list as its own archived response under the new `host_app` provider, so membership rows still point at real bytes and `@tradeanalyzer/core` stays ignorant of this app's schema.
- A single empty list is refused rather than returned: membership reconciliation would read it as "every member of this list has left".
- Recovery needs no reset - `reconcileMembership` closes members absent from an incoming list, so a corrected seed closes the wrong memberships and opens the right ones.

## [1.1.200] - 2026-09-07

### fix - a boot that cannot read its credentials now says so

- **`secure-settings.decrypt()` swallowed a `safeStorage` failure and returned `''`**, so a start where the OS credential store was not ready came up with **every** secret silently blank - Polygon, E*Trade, Anthropic - and the app ran credential-less, failing every provider call as unauthorised. It looks exactly like a revoked key or a provider outage.
- **Measured 2026-09-07: 32 keyless Polygon 401s in one afternoon**, against 38 successes from healthy starts of the same binary with the same stored key. The API log tells them apart only in hindsight - a good call logs `"apiKey": "[REDACTED]"` in `requestParams`, a failing one logs `requestParams: {}`. The operator already knew the workaround (close the app, start it again) without knowing the cause.
- **An absent setting and an unreadable one are different facts**, and collapsing them destroyed the only evidence that would have named this in minutes. `undecryptableKeys()` now records them; startup reports them in a dialog and in `logs/errors/`. The read still returns `''`, so no call site changes behaviour.
- Regression test `tests/secure-settings-undecryptable.test.ts` - 7 cases, including the two that must **not** record: a genuinely unset key, and a legacy plain-text value.

### fix - startup failures are no longer silent

- `app.whenReady().then(...)` had **no `.catch()`**, the same shape fixed in the new exe earlier today. A throw anywhere in startup became an unhandled-rejection warning on a stderr nobody reads, and everything registered after it simply did not exist - no error, and a window that looked fine. It now logs and shows a dialog.
- The NewApp collector block is additionally wrapped in its own try/catch, because it is registered **last** by design (`sequence_order` is frozen from registration order), which makes it the first casualty of any earlier throw - and its absence is indistinguishable from it never having been written.

### chore - the collector claim loop reports what it sees

- A queued `meta_job_request` row sat unclaimed through a dozen two-minute ticks while the handler reported `No queued jobs.`, with no way to tell whether it was reading the wrong database, holding a stale snapshot, or genuinely seeing an empty table. Those want three different fixes and the note distinguished none of them.
- Every tick now writes an `INFO` line to `logs/errors/` with the resolved `dataRoot`, generation number and the total/queued/max-id of `meta_job_request`; the `batch_runs` note carries the same counts, so the batch history alone is diagnostic.
- The interval body is wrapped: `readSharedPointer()` **throws** on a malformed pointer, and an uncaught throw there produced no `batch_runs` row at all - a loop that looks stopped rather than failing, every two minutes, silently.
- `ErrorLevel` gains `INFO`, so the log can record that something **did** happen. A file that only holds problems cannot answer "did the collector start?" - absence there means both "fine" and "never ran".

## [1.1.199] - 2026-09-07

### feat - the account, the chain subset and the chains (NewApp B6)

- **The hosted collector now runs phases 0-7.** Phases 5 (account), 6 (chain subset) and 7 (expirations and chains) land inside `@tradeanalyzer/core`'s `runDaily`, which this app's `data-collector` handler already calls - so no handler, view, IPC module, service or existing table changes here. Still change #4 of the seven in `NewApp/requirements/06 §5`.
- Thirteen chain checks and six account checks are registered with them; `@tradeanalyzer/core` is at 184 tests, `@tradeanalyzer/next` at 21.

### chore - the root lint run stops reporting the workspace packages

- `eslint .` reached into `packages/**` with this app's config and reported every `console` in the packages' dev CLIs and every `JSX` in the new app's renderer as an undefined variable - 29 findings on files that lint cleanly under their own configs. The root config now ignores `packages/**`; each package still lints itself. **This does not make the root run clean**: 186 pre-existing findings remain in this app's own `src/` and one-off `scripts/`, untouched here and not caused by the packages.
- Everything else is in `@tradeanalyzer/core` and `@tradeanalyzer/next` - see `NewApp/CHANGELOG.md`.

## [1.1.198] - 2026-09-06

### feat - `backfill_bars` and the exception review queue (NewApp B5)

- **`collector-oneshot` implements `backfill_bars`** alongside `universe_seed`, and expires stale acceptances before any job reports — otherwise the email and the review queue describe what was outstanding yesterday rather than now.
- **A red verdict from the backfill is a `success`.** The review queue it opens *is* the deliverable: the operator has to rule on ticker-reuse candidates before the pilot's first clean day counts (04 §7.2). A failed job would say the collector broke.
- Everything else is in `@tradeanalyzer/core` - see `NewApp/CHANGELOG.md`.

## [1.1.197] - 2026-09-06

### feat - the collector's daily run and quality gate (NewApp B4)

- **The hosted collector now runs phases 0-4** (preflight, bars, end-of-day snapshot, corporate actions), evaluates the quality gate and sends the status email; the watchdog writes `not_run` per domain and sends the NO RUN email. Still change #4 of the seven in `NewApp/requirements/06 §5` - no view, IPC handler, service, scoring rule, existing job or existing table is touched, and the collector writes only into the new generation.
- **A red gate verdict is reported as a `success`, not a failed job.** The gate finding problems is the gate working; a failed job means the collector could not complete. Conflating the two would leave the batch history unable to answer either question. A test pins it.
- Everything else is in `@tradeanalyzer/core` - see `NewApp/CHANGELOG.md`.

## [1.1.196] - 2026-09-06

### feat - this app now hosts the rebuild's collector (NewApp B3)

- **Changes #3 and #4 of the seven** the existing app receives for stage 1 (`NewApp/requirements/06 §5`). No view, IPC handler, service, scoring rule, existing job or existing table is touched, and the collector writes **only** into the new generation.
- **Three handlers, registered LAST**: `data-collector` (17:05, after-close only), `collector-watchdog` (19:30), `collector-oneshot` (claims one queued job per 2-minute tick from the new app). Registration order is what seeds `sequence_order` before it freezes in the DB, so a job inserted in the middle would renumber nothing here and everything on a fresh install — a test asserts they come after every existing job.
- **`ElectronCollectorHost`** hands `@tradeanalyzer/core` this app's hardened transports, `safeStorage` and the progress channel. It owns no collection logic; nothing about the arrangement is load-bearing beyond the E*Trade token, which is why cut-over later is just "the new exe runs them itself".
- **`etradeGetRaw()`** — same signing, same instrumented transport, same single nonce retry as `etradeGet`, differing only in returning the **response bytes as received** (the archive hashes those bytes for provenance) and returning a non-2xx rather than throwing (a failed call is evidence, and is archived).
- **Renew-and-retry on ANY E*Trade failure**, never on an auth-shaped message — a dormant token can kill the stream rather than answer 401, and that heuristic already bit two paths here. A test asserts the retry decision contains no message sniffing.
- **Write-capable generation handle**, never readonly: on Windows a readonly connection cannot attach the live WAL index and would read a stale generation while reporting it as current.
- **Account data is refused rather than written unencrypted** if `safeStorage` is unavailable. The archive is permanent; a file written in the clear today stays that way with no way to tell later which files those were.
- **The shared pointer is never invented** — if it is missing the new exe has not been run, and creating a path would make a second empty generation look like the real one having lost its data. **The watchdog reports rather than re-running**, because a silent re-run turns "did not run" into "ran late".
- **New quirk in `CLAUDE.md`**, having cost time three separate times today: a source-scanning test must strip comments (and, for identifier rules, string contents) or it fires on its own documentation — teaching people to delete the comment or work around the guard.

## [1.1.195] - 2026-09-06

### chore - the build guard follows the new exe's rename

- **`scripts/check-not-running.mjs` watches for `TradeAnalyzer2`**, not `TradeAnalyzer 2`. The new application's executable was renamed to drop the space (its *display* name stays "TradeAnalyzer 2"); the guard matches the **process** name, which follows the executable filename rather than `productName`, so it had to move with it. Left stale it would have silently stopped seeing the new app and let a build run over a locked file — a failure that looks like a corrupt bundle rather than a running process.
- **The two are now pinned by a test**: `packages/next/test/app-identity.test.ts` reads `executableName` out of that package's `package.json` and asserts this guard watches for exactly it. Verified live — the guard refuses while the renamed exe runs and clears when it closes.
- No behaviour of the existing app changed.

## [1.1.194] - 2026-09-06

### chore - the ABI-swap script says why it failed

- **`scripts/rebuild-better-sqlite3.mjs` now catches a file-lock failure and prints what to do**, instead of a bare `EBUSY` and a stack trace. Windows locks a loaded `.node` file, so any running app makes the swap fail; `pretest` runs this script and `check-not-running.mjs` guards `package` but not `test`, so a running exe turned `npm test` into an unexplained crash a hundred lines from the cause. Found while building NewApp B2 with the new exe open. The message now names both executables and `npm run dev`; a non-lock failure still throws as before. No behaviour of the existing app changed.

## [1.1.193] - 2026-09-06

### fix - the transactions range walk emitted a wasted one-day query on twelve dates a year

- **`syncClosedPositions` walks Jan 1 to today in 30-day windows with a 31-day stride**, so when the range length is an exact multiple of 31 the walk lands on `cur === endMs` and emits a final window covering **a single day on its own** - one extra round trip to `/transactions`, an endpoint already documented as intermittently unresponsive for ~120 s answering `nonce_used`.
- **It is a calendar trigger, not an odd input.** From a Jan 1 start it lands on about twelve dates a year - in 2026: Feb 1, Mar 4, Apr 4, May 5, Jun 5, Jul 6, Aug 6, Sep 6, Oct 7, Nov 7, Dec 8, then Jan 8 of 2027. Found on one of them: 2026-09-06 is day 248 = 8 x 31.
- **Why it survived is the transferable half.** `tests/etrade-transactions-slicing.test.ts` asserted exactly the right thing (`span > 0` on every window) but drove the real `syncClosedPositions`, which builds its range from **today** - so a run only ever exercised one calendar configuration. The suite could see the fault on ~12 days a year and was green on the other ~353, and on those twelve it went red for reasons unrelated to whatever had just changed. That is how a test teaches people to ignore it.
- **Fix:** `buildDateSlices(startDate, endDate, maxSpanDays = 30)` is now an **exported function** rather than an inline block - that extraction is most of the fix, because inline it was only ever reachable through the clock. A degenerate tail is **folded into its predecessor** (30 days becomes 31, still inside the stall-free width) rather than dropped, which would leave a one-day hole. A genuine one-day range is still one window. An inverted or unparseable range returns `[]`.
- **Regression test** `tests/etrade-date-slices.test.ts` sweeps **every start-date offset in a full year** and asserts no multi-window result contains a zero-width window - plus contiguity, no gaps, no window over 31 days, the folded-tail case, the one-day range, the inverted range and a narrower `maxSpanDays`. Milliseconds, and it never consults the clock.

## [1.1.192] - 2026-09-06

### chore - npm workspaces for the rebuild (NewApp build step B1)

- **The existing app becomes the workspace root** for the ground-up rebuild (`NewApp/requirements/06` §4, §5). Change #1 of the seven this app receives for stage 1, and deliberately the smallest: no view, no IPC handler, no service, no job, no table and no schedule is touched.
- `package.json` gains `"workspaces": ["packages/*"]` and three **additive** aggregate scripts - `typecheck:all`, `test:all`, `lint:all`. **The existing `npm test` / `npm run typecheck` / `npm run lint` keep their current meaning - this app only.**
- `scripts/check-not-running.mjs` now refuses a build while **either** exe is running, and names which one. Both are checked from either build because in stage 1 they share a generation directory: this app hosts the collector (writer), the new exe holds the same DB open (reader).
- `eslint.config.js` ignores `packages/*/{out,dist,release}` - flat-config ignores are relative to the config file, so a root `eslint .` would otherwise lint the new packages' build output. **No rule changed.**
- **Hoisting verified**: exactly one `electron` and one `better-sqlite3` at the root, packages symlinked, no nested `node_modules`. `rebuild-better-sqlite3.mjs` is untouched and still swaps that single copy - a second copy would be rebuilt for the wrong runtime silently, the exact failure CLAUDE.md warns about.
- **Pre-existing failure, not caused by this change:** `tests/etrade-transactions-slicing.test.ts` fails on a calendar trigger. `syncClosedPositions` walks Jan 1 to today in 31-day strides, so when the elapsed day count is an exact multiple of 31 the walk emits a final zero-width slice (`from == to`) and the test's `span > 0` assertion fails. 2026-09-06 is day 248 = 8 x 31. It fires on about twelve dates a year (2026: Feb 1, Mar 4, Apr 4, May 5, Jun 5, Jul 6, Aug 6, Sep 6, Oct 7, Nov 7, Dec 8) and passes on the rest. Left unfixed here because the existing app's stage-1 edit list is frozen (06 §5); raised for a decision.

## [1.1.191] - 2026-09-04

### docs - the signals half of the critic change fails too, and for the same reason

- **Isolated and measured** (`AB_ARM=signals`, 20 wheel picks): **pass 6 -> 3**, 20% stricter, 5% looser. Half the dice-eligible picks gone. Both halves of v1.1.189 now stay off on their own evidence rather than by association.
- **Every stricter flip cites `premiumYield` as "the weakest reading"** (normalized 20.7-34.3) - the same missing base rate that sank the ownership half, in a different costume.
- **Plus a normalization artefact that makes the whole idea unsound as built.** Across 250 wheel picks, `recentVolatility` is the weakest reading on **60%** of them, because its `lower_better` normalization against a normMax of 60 maps ordinary realized vol of 30-50% into single digits - **median normalized 9.6/100**. So "the pick's weakest reading" is a property of the **normalization curves**, not of the pick, and marking it invites the model to report a near-constant as a finding. T6 separately measured that signal mildly inverted, so it does not even point the right way.
- **New finding F10 in `docs/wheel-parameters.md`, about the composite rather than the critic:** at weight 10-11 with a median normalized of 9.6, `recentVolatility` removes ~9-10 composite points from essentially every wheel pick, nearly uniformly. That is a constant, not a signal. **Deliberately not acted on** - re-scaling it changes every wheel composite and which picks the brief keeps, which is FR-SEY-5. Recorded because it silently defeated a different change and will defeat the next one that assumes "weakest signal" means something about the pick.
- **Transferable check, now in CLAUDE.md:** before using "the worst signal" as if it were information, count how often each signal IS the worst. If one dominates, you are reading the normalization curves, not the picks.
- **Harness fix:** the A/B still drove the retired `CRITIC_CONTEXT_V2` variable after v1.1.190 split it. Left alone it would have set nothing, compared two identical arms, reported zero flips and looked like a clean bill of health - a broken thermometer reporting no fever. It now takes `AB_ARM=signals|ownership|both`, prints the flags each arm sets, and asserts the enabled set is non-empty before spending a single call.

## [1.1.190] - 2026-09-04

### fix - the critic context change is DEFAULTED OFF: measured, it would have emptied the dice

- **v1.1.189 shipped enabled. The A/B says that was wrong, so both halves now default off.** `tests/critic-context-ab.test.ts`, 20 wheel picks, both arms the same code path on the same picks and the same rule flags:

  | | pass | caution | flag |
  |---|---|---|---|
  | before | **8** | 10 | 2 |
  | after | **0** | 19 | 1 |

  **40% stricter, and not one `pass` survives.** The dice rejects anything that is not `pass`, so this would have produced **zero picks**.
- **The cause is the ownership half, and the flipped rationales say so themselves:** all 8 cite the cost basis against SMA200, none cites a weak signal, and the model cautioned on **AAPL at 4.5% above** its 200-day average.
- **The fact was true; its BASE RATE was missing.** A basis above SMA200 is the *normal* case — 70% of 82 critic-passed wheel picks — and the above-SMA200-but-below-the-20-day-low cell is the **best performing of the four** (+3.46% mean / +5.49% median). v1.1.188 had just removed precisely this error from the operator-facing sentence; handing the raw fact to a model reintroduced it. **This is the conviction band inverted** — that threshold could never fire, this one always fires, and neither is visible without measuring the distribution of the tested quantity.
- **Flags split** into `CRITIC_CONTEXT_SIGNALS` and `CRITIC_CONTEXT_OWNERSHIP` (both default false), because the halves behave differently and must be testable apart. The **signals half is unmeasured alone** — off not because it was shown harmful, but because the only A/B available bundled it with a half that was, and FR-SEY-5 does not accept "probably fine".
- **The A/B harness moved from `scripts/*.mjs` to `tests/`.** A plain node script cannot resolve the `@shared/*` path aliases the service imports, so it could not exercise the real prompt at all — it would have tested a reimplementation of the thing under test. It is skipped unless `RUN_CRITIC_AB=1` and reads the key from `settings.anthropicApiKey`.
- **Lesson recorded in CLAUDE.md:** giving a model a measured fact is not the same as giving it the fact's base rate; without the base rate, a common property reads as an alarm. Always A/B a context change to an LLM gate before shipping it.

## [1.1.189] - 2026-09-04

### fix - the critic's context was filtered-favourable by construction

- **Two defects, both pointing the same way:** the adversarial reviewer was handed a filtered view of the pick it was meant to attack.
- **(1) The signal list selected for good news.** `topSignals` sorted descending on `weight x normalized` and took 4 - a sort on CONTRIBUTION, so a signal scoring badly has a small product and is pushed out by the arithmetic. Measured over **948 stored picks**: the worst-scoring signal reached the critic on **8.3%**, a reading below 35/100 on **2.8%** (18 of 653), and **59 of 250 wheel picks (24%) were passed clean with no warning flag while carrying a sub-35 reading the reviewer never saw**. On the DINO pick that surfaced this, `technicalNeutral` at 30.6/100 - the app's own "this is extended" read - ranked 7th of 7 by contribution and never arrived, while `notDowntrend` at 100 did.
- **(2) The one measured ownership read was computed after the verdict.** `own-at-strike` runs in `roll-the-dice.ts`, downstream of the critic, so the reviewer had never seen it in any form. On **82 critic-PASSED wheel picks, 57 (70%)** had a cost basis above the ticker's own 200-day average and 37 were more than 10% above - DELL **+97.9%**, AMD **+79.2%**.
- **Fixed:** `selectCriticSignals()` (exported, pure, tested) appends the pick's **weakest** reading when the contribution sort excluded it, marked `isWeakestReading` so the model can distinguish "the worst thing measured about this pick" from "one of the things that drove the score". `readOwnership()` puts the two-axis own-at-strike read in the context for **wheel** picks, never throwing, with `null` read as unknown rather than satisfactory.
- **Still a sample, deliberately.** Three of the signals full disclosure would surface for wheel - `technicalNeutral`, `recentVolatility`, `notDowntrend` - were measured flat, mildly inverted and anti-predictive (T6, v1.1.178), so handing over every reading would invite confident cautions built on signals already shown not to predict. One guaranteed sight of the worst reading is the smallest change that removes the bias.
- **The prompt says nothing new about TREND.** That is T7, still open; `docs/wheel-parameters.md` records why a tweak there is not justified on current evidence.
- **Not validated on outcomes, and the reason is structural rather than effort.** The verdict is a hard gate, so this changes which trades are taken (FR-SEY-5) - but the intersection of "verdict flipped" with "expiry has settled" across one regime is a handful of trades, and a return figure from that would have no power behind it. `scripts/critic-context-ab.mjs` measures the **blast radius** instead: how many verdicts move and in which direction, two API calls per pick, `--limit` defaulting small so an accidental run is cheap. **Not yet run.**
- **`CRITIC_CONTEXT_V2=0` reverts both changes on a live run, no rebuild.**

## [1.1.188] - 2026-09-04

### feat — the ownership read carries two axes in one sentence, and a caution comes OUT

- The dice's own-at-strike line now merges the long-run read (cost basis vs SMA200, plus its 52-week percentile) with a **support** read: the **strike** against `swingLow20`, the lowest low of the last 20 sessions. One sentence, with the connective carrying the relationship — **and** when the two agree, **but** when they conflict.
- **The behaviour change is a REMOVAL, not an addition.** *"That is an extended price, not a discount"* used to fire on every basis above SMA200 — **166 of 250 stored brief picks (66%)** — which includes the support-only cell that measured **+3.46% mean / +5.49% median, the best of the four**. It now fires only when **both** axes agree (**52%**), reworded as *"An extended price with no recent floor under it."* Nothing new fires at 50%; an existing line fires less, and stops being wrong about the cell most worth taking.
- The in-app panel's warning colour used the same over-firing condition and now follows the sentence exactly (`ownershipWarns` in `DailyBriefView`).
- **An unknown support axis (fewer than 20 bars) falls back to the exact previous sentence, clause included.** An axis that could not be measured must never be the reason a caution disappears — the same fail-closed reasoning as an absent earnings row.
- **The asymmetry is deliberate:** the long-run half tests the **cost basis**, the support half tests the **STRIKE**. That is what T8 and its replay measured, so the code matches the study rather than being tidied into symmetry.
- **`own-at-strike.ts` moved to `src/shared/`.** The panel carried a hand-copied duplicate of the sentence and the preload a hand-mirrored copy of the type — the same trap as the strategy slug map (v1.1.23/25), where four copies drifted until the card, email and critic disagreed about one pick. One definition now, imported by main, preload and renderer. `readOwnAtStrike` takes `(strike, costBasis, window)`.
- **Still an annotation. Nothing gates on it** — evidence is one regime (T8: 4,917 settled rows / 45 dates; replay: 250 brief picks, 186 settled).
- Tests: the four cells pinned by real numbers from scored picks (VKTX / GLW / SNOW / MPC), the withdrawal of the clause from the support-only cell, the unknown-axis fallback, and that support reads the strike rather than the basis.

## [1.1.187] - 2026-09-04

### docs — T8 follow-up: the own-at-strike x support annotation, replayed on the dice's own picks

- **No behaviour change.** `scripts/dice-entry-annotation-replay.mjs` replays the 2x2 against stored wheel briefs with the dice's trade-quality gates mirrored from `roll-the-dice.ts`, because "it separates on the scanned universe" is not the same claim as "it separates on the picks the dice actually produces".
- **It fires.** Cell D (basis above SMA200 **and** strike above the 20-day low) is **50% of the 34 dice picks and 52% of the 250 brief picks** — the opposite of the conviction band, which fired on 0 of 39 and was therefore indistinguishable from a rule nothing violated.
- **The dice's gates do not already handle it.** D holds the same ~52% share before and after critic-pass + liquidity + earnings + credit, so those gates select on entirely different axes.
- **It is right, on 186 settled brief picks:** A both +2.17% (8% assigned), B own-at-strike only +2.97% (4%), C support only **+3.46% / +5.49% median** (26%), D NEITHER **−2.10%** (**44%**). Same shape as the universe study's −3.06% / 48.4% for D.
- **The new information is the SUPPORT axis, not own-at-strike — which the email already states.** Among the 166 brief picks whose basis sits above SMA200, the swing low splits them **+3.46% vs −2.10%**. C is the *best* of the four cells while today's single sentence lumps it in with the worst.
- **Live:** 10 of the last 12 dice picks are cell D — including DINO on 2026-09-03 (basis 95.85 vs SMA200 65.38, 20-day low 80.50), the pick that prompted the enquiry, and seven AAPL picks. All still open, so the recent cluster is unscored.
- **Caution recorded before anything ships:** a sentence that fires half the time becomes wallpaper. D's *median* is +2.15% and a settled AAPL D pick returned +1.48% — the cell is worse on average and on assignment, not a prediction of loss. It should read as a two-state read like own-at-strike, never as an alarm.

## [1.1.186] - 2026-09-04

### docs — T8: can the Validate view's entry machinery judge a CSP strike?

- **No behaviour change.** New study `scripts/fr-wheel-entry-quality-study.mjs`, answering the operator's question: *"I can't wheel something I'm not comfortable owning, and to own it the strike needs to be a reasonable price."* **4,917 settled liquidity-gated rows across 45 dates**, collapsed to **1,585 episodes** (one ticker+expiry = one observation), split scale guard applied and counted, SPY printed beside every band as a regime tell rather than subtracted (a CSP's payoff is capped at the premium, so an excess-of-index figure would be meaningless).
- **The principle holds, strongly, and two measures carry it — complementary, not redundant.** `basis <= SMA200`: **+0.55% vs −2.19%** mean, assignment **17.0% vs 42.1%**. `strike below the 20-bar swing low`: **+1.22% vs −1.66%**, assignment **13.2% vs 35.7%**. Crossed 2x2, neither collapses: best cell +1.26% / 11.3% assigned (699 eps), worst −3.06% / 48.4% (562 eps).
- **Both survive the confound that would have killed them.** Below-swing strikes sit 2.6x further OTM (8.46% vs 3.28%), so the result looked like raw distance renamed. Held inside ATR-cushion quartiles it persists in **all four**, and is largest in the thinnest-cushion quartile: **+1.48% at 19.5% assignment vs −4.55% at 60.8%**.
- **The entry zone itself adds nothing.** Its split (858 episodes) is within noise of the swing-low split (869) because `entryZoneLow = min(swingLow, SMA50)` and the swing low is nearly always the min — it is the swing low renamed. "IN ENTRY ZONE" is the mediocre middle (+0.50%, 20.6% assigned). Both bounds are **recency anchors**, so the zone re-anchors as price rises and can never say "too expensive" — the construction that made the conviction band fire on 0 of 39 picks. Live: AMD on 2026-09-04 reads "IN ENTRY ZONE" with a zone of $440.50–$499.18 against an SMA200 of $340.97.
- **Own-at-strike is now replicated at ~100x its original sample.** v1.1.169 rested on 12 accept episodes inside one ~4-week window, which is why it annotates and does not gate. It is now the **best selection rule tested** — top 5/date by lowest basis-vs-SMA200 returns **+2.44% mean / +2.83% median / 11.6% assigned** against a −0.29% / 1.13% / 25.3% universe — on a different base (whole scanned universe, not brief survivors).
- **Correction recorded:** the prediction going in was that ATR-normalised cushion would beat raw % OTM. **It does not on returns** (widest raw-OTM quartile +1.10% vs widest ATR +0.49%; as a selection rule ATR is *worse* than no selection at −0.46%). ATR wins only on assignment monotonicity. A mechanism read off a formula, declined by the data — the same shape as the v1.1.176 correction.
- **Harness check passed:** RSI(14) reproduces its published v1.1.178 null (0.9-point spread across bands vs 4.3 for the 2x2), so the panel measures what the earlier study measured.
- **Nothing gated.** One regime, and measured on the scanned universe rather than the brief's picks; a gate needs a brief-replay delta under FR-SEY-5. Follow-up queued in `docs/wheel-parameters.md` T8: the 2x2 as a dice *annotation*, replayed.

## [1.1.185] - 2026-09-04

### feat - keep both of the day's batch runs in the candidate pool

- **No behaviour change to any recommendation** - this changes only what is recorded.
- **What prompted it:** DINO was yesterday's dice pick and today's `illiquid (6/15)` rejection, on a series that scored **9/15** the evening before. `OI 112->2.5, vol 27->1.5, spread 7.2%->5 = 9` against `OI 77->0.5, vol 0->0, spread 9.2%->5 = 5.5->6`. **The spread - 8 of the 15 points, and the only component that sets fill cost - did not move a point.** The -3 was two step-function counters crossing boundaries, on a strike the delta walk had also changed (spot 106.15->104.59).
- **Same-day volume is a cumulative counter**: ~1 hour of tape at the 10:15 ET slot, a full session at 17:00. Monotonic within a day, so the morning run scores systematically lower on up to 3 of 15 points on an identical contract.
- **Why nobody could see it:** the brief runs on schedule at both slots and the dice emails **both**, but only the after-close run survived - `saveBrief` deletes the same-ET-day rows and `brief_candidates` was keyed without a slot. **248 of 250 stored wheel picks are evening readings**, so the morning pick the operator acts on came from data destroyed hours later. "The after-close slot overwrites the morning" is right for a data refresh and wrong for instrumentation about a job that is acted on at both slots.
- **Why it bites:** `MIN_TRADABLE_LIQUIDITY_SCORE = 8` sits in the densest part of the distribution - across 250 picks the mode is **exactly 7**, **93 (37%) would flip to passing on the volume component alone**, and **78 (31%) have a tradable <=15% spread yet are rejected as illiquid**. The component shipped in v0.32.97 against the brief's **5**/15 gate expecting to "rescue or penalize at the margin"; the dice inherited 8/15 from the v2 engine.
- **Migration 079** adds `slot` (`intraday`/`after_close`, part of the unique index - a phase, not a clock time, so a same-phase re-run still replaces) and `volume` (nullable on purpose: the score reads `leg.volume ?? 0`, so "not reported" must stay distinguishable from "did not trade"). `resolveSlot()` prefers the scheduler's `slotTime`, falling back to the ET clock at a 14:00 boundary. Storage ~20 -> ~40 MB per trading year.
- **`scripts/slot-liquidity-drift-study.mjs`** pairs the phases and reports score/volume/OI/spread deltas and gate crossings; forward-only, first pairs from the next full trading day.
- **Deliberately unchanged:** `daily_briefs` (every replay script assumes one row per day), the gate and thresholds, and the `?? 0` null-volume conflation - all three change which trades are taken, which is FR-SEY-5 territory and needs the replay this release makes possible.

## [1.1.184] — 2026-09-04

### fix — the emailed quote link resolved to "We couldn't find the symbol 'NULL'"

- v1.1.183's quote link used `https://us.etrade.com/etx/mkt/quotes?symbol=X#/snapshot` — the URL a signed-in session shows in its address bar. The ticker interpolated fine; the URL was wrong.
- **That page needs a session, and its login redirect double-encodes the destination**: `TARGET=...%2Fetx%2Fmkt%2Fquotes%253Fsymbol%253DMKC`. `%253F` decodes to a literal `?` in the path rather than a query separator, so no symbol is parsed and the page renders "We couldn't find the symbol 'NULL'". The `#/snapshot` fragment survives untouched, which makes the link look intact. An emailed link is opened cold from a phone as often as not — the failing case is the normal one.
- **Fixed by using E*Trade's public quotes page for both links**, where `content` picks the tab: `?sym=mkc` is Snapshot, `?content=3&sym=mkc` the option chain. Both resolve with no session; verified cold on MKC and TSLA. The chain link is unchanged — it was always on the public page, which is why it worked.
- **CLAUDE.md quirk added**: a URL copied from a logged-in address bar is a session artefact, not a shareable link. Test every outbound link from a cold session.

## [1.1.183] — 2026-09-04

### feat — the Roll the Dice email links straight into E*Trade

- The email states an order to place; acting on it meant retyping the ticker into a browser. The ticker in the order headline now links to the **snapshot quote** page, and a row beneath it carries **quote** and **option chain** explicitly. The `withinBudget` alternative card carries the same pair.
- **Both, not one.** The quote page answers "what is it doing right now"; the chain answers "what is this strike actually bid". Neither substitutes for the other at the moment an order is entered.
- **`src/main/services/etrade-links.ts` now owns both URLs.** The two pages disagree about symbol casing (`symbol=MKC` upper for the quote page, `sym=mkc` lower for quotes-and-research) and the options URL's bare `&` must be escaped inside an HTML attribute — both invisible at a call site copy-pasting a string. `brief-report-builder.ts` and `filters-prefill-report-builder.ts` (3 inline copies between them) now build through the helper; emitted URLs are byte-identical, no behaviour change there.
- Plain `<a>` text links rather than buttons — a bare anchor is the one construct every mail client renders identically, and this is read on a phone.

## [1.1.182] — 2026-09-03

### docs — logged: does the critic's treatment of trend survive contact with the data?

- **No behaviour change.** Raised by a live pick, where the Roll the Dice panel showed both readings of the same fact disagreeing in the open: the critic's *"confirmed uptrend… supports the short put thesis"* directly above the v1.1.169 read's *"46.6% ABOVE its 200-day average… an extended price, not a discount"*. Both describe DINO having run +132% off its 52-week low.
- **The assumption lives in two places, and they are different problems.** `critic-service.ts` `checkTrendAlignment` (~line 404) fires only on a *confirmed downtrend* and states its rationale in code — *"wheel works best on stocks trending sideways to up"* — which is the opposite ordering to what **T6 measured** (bearish band **20.5%** assigned, sideways 24.6%, bullish **31.9%**, bullish also worst on mean return at −1.01%). Separately, the LLM **system prompt says nothing about trend for wheel at all**, so "confirmed uptrend supports the thesis" is the model's own inference — an intuition from directional strategies, where it is correct, imported into short premium, where the evidence disputes it.
- **Corroborated** by v1.1.33, which set `USE_ADX_IN_SCORING` false on a full-year replay because strong-trend names mean-revert over the next ~21 days. Two independent findings now point the same way.
- **Logged rather than fixed, deliberately.** Assignment rate is not tail severity — a confirmed downtrend assigning *less often* does not mean a falling knife is safer when it does assign, so the warning may be defensible even if its stated reason is wrong. T6 also tested trend as a *selection* signal, not as a warning. One regime, 8 of 91 weight.
- **Becomes answerable in about a quarter:** `brief_candidates.signals_json` (v1.1.175) stores `notDowntrend` per candidate and `daily_briefs.picks` stores the critic verdict, making verdict × trend band × settled outcome a direct three-way test — including whether `pass` on a bullish name underperforms `pass` on a sideways one.

## [1.1.181] — 2026-09-03

### fix — total capital uses E*Trade's net liquidation, not a derived sum

- **Found by verifying the first live numbers rather than trusting that they rendered.** The derived total (available + committed) came to **$82,541** while E*Trade's own `totalAccountValue` reported **$79,688** — a **$2,853** gap that is almost exactly the covered call's liability.
- **`available + committed` ignores short-option obligations.** A written call reduces net liquidation without freeing cash or releasing the shares behind it, so the derived sum overstates the account by the cost of buying that call back. Quoting it as "total" would have disagreed with the operator's own E*Trade screen by the size of the option they wrote.
- **`total` now prefers the broker's `totalAccountValue`**, falling back to the derived sum only when the response omits it. `totalSource` records which, and `unreconciled` carries the gap so the three headline figures visibly reconcile instead of silently disagreeing. The strip explains it in plain words, in neutral styling — it is normal whenever a short option is open, not a problem to fix. Utilisation on the live book now reads **47%** of $79,688 rather than 46% of $82,541.
- **The double-count guard held**: committed reads **$37,637** with the covered call contributing zero; a wrong implementation would have shown $34,784.
- **Noticed, not acted on:** the account reports `marginBuyingPower` of **$194,684** — it is a margin account, so available cash is not the binding constraint on how many puts could be sold. Utilisation stays computed against cash and net liq since the operator's practice is cash-secured, but the figure is captured in `account_balances` if that ever needs revisiting.
- 2 new tests pinning the live figures. Suite: 1180 passed.

## [1.1.180] — 2026-09-03

### fix — the balance snapshot ran on only one of two sync paths

- **v1.1.179 shipped capital utilisation, and a manual sync produced nothing.** The Portfolio strip still read "no balance synced yet" and the API log for that day contained **zero `/balance` calls**.
- **Two sync paths, one instrumented.** The scheduled `PortfolioSyncJob` called `syncBalances` itself, but the **Sync button** goes through `portfolio:etrade:sync` straight to `syncPortfolio`, which knew nothing about balances. The snapshot would have appeared on the next scheduled run — the kind of "works, just not when you look" that wastes an evening.
- **Fixed by moving the snapshot INSIDE `syncPortfolio`**, the one function both paths call, rather than patching the second call site and leaving the same trap for a third. `syncBalances` now takes the account list as an argument instead of re-fetching it, so this costs one `/balance` call per account and **no extra `/accounts/list` round trip**. The job's separate step is removed.
- **Pinned by a test of the property, not the path:** a balance row must appear *as a consequence of syncing the portfolio*. Also covered — the required query params are sent (`instType=BROKERAGE`, `realTimeNAV=true`; E\*Trade rejects the call without the first and returns previous-close values without the second); a failing balance call does **not** become a sync error, since the position book is the real payload; a missing field stores **null, not 0**; a same-day re-sync replaces rather than duplicates; and exactly one `/accounts/list` call is made.
- 6 new tests (`tests/etrade-balance-sync.test.ts`). Suite: 1178 passed.

## [1.1.179] — 2026-09-03

### feat — capital utilisation: the app can finally answer "how much of my money is idle?"

- **The question could not be answered at all before this.** Searched 2026-09-03: **no table in the schema held a cash, buying-power or net-liquidation figure**. The only columns with "cash" in the name are a company's operating cash flow (`historical_financials`) and a screener input (`leaps_csp_opportunities.total_cash_to_deploy`).
- **Scope as chosen:** available cash = **E\*Trade only**; committed capital = **the discretionary wheel book only**, not the v2 execution broker whose sizing rules are separate; and the Roll the Dice **$30,000 budget line is unchanged** — a stated position size that drifts upward after a good month stops being a decision.
- **The arithmetic trap this is built around.** E\*Trade **already withholds** cash-secured put collateral from `cashAvailableForInvestment`, so available and committed are **complementary, not overlapping**: `total = available + committed`, `utilisation = committed / total`. Deriving idle as `available − committed` would subtract the same collateral twice and report a working book as far emptier than it is — **available *is* the idle figure**.
- **A second double-count sits alongside it:** a covered call commits no capital of its own (the shares are already counted as stock) and its market value is *negative* — on the live book, −$2,852.50 against 100 TSLA shares. `CC` contributes exactly **zero**. Both traps are pinned by tests, because each would produce a plausible-looking number rather than an obvious error.
- **Built:** `fetchBalance`/`syncBalances` on `EtradePortfolioService` through `etradeGet` (never a hand-rolled signature; `instType=BROKERAGE` and `realTimeNAV=true` are both required — without the first the call is rejected, without the second the values are previous-close); **migration 078 `account_balances`**, one snapshot per account per day because *"how long has it been idle"* needs a series and that is the half actually asked about; `capital-utilisation.ts` (CSP at collateral, stock at market with cost as fallback, long options at debit, CC at zero, unrecognised types **surfaced** rather than silently zeroed); a strip on the Portfolio view with working / idle / utilisation %, a staleness warning past one day, and an idle streak that ends the moment cash goes to work.
- Every field is **null rather than 0** when absent — a missing balance and a zero balance are very different facts, and a wheel operator reading "$0 available" would act on it.
- **Out of scope and staying there:** which instrument to park idle cash in is personalised investment advice. The app reports utilisation and does not rank destinations. Worth knowing while reading it: E\*Trade sweeps uninvested cash by default, so "idle" is not necessarily earning nothing.
- Migration 078, 13 new tests, sync-job stub updated. Suite: 1172 passed.

## [1.1.178] — 2026-09-03

### docs — T6: the price-derived signals add nothing, and `notDowntrend` is anti-predictive

- **No behaviour change.** After v1.1.176 cleared premium richness of causing F8, the remaining suspicion fell on the other 50 of 91 weight. 29 of those are testable — `technicalNeutral` (11), `recentVolatility` (10), `notDowntrend` (8) — while `fundamentalScore` (17) + `leverageQuality` (4) draw on `fundamentals_cache`, which has no history and never can be. Each signal is replicated exactly from `scoring-service.ts`, computed point-in-time, and applied as a selection rule to the whole wheel universe. **4,816 settled liquidity-gated rows across 40 dates.**
- **As a group they add nothing.** Weighted exactly as the composite does, the three move the needle **+0.14 mean / −0.18 median** against no selection at all. **Inverting them is the only rule better on both (+0.43 / +0.95).**
- **`notDowntrend` is anti-predictive, and the banded view is unambiguous**: bearish band **20.5%** assigned, sideways 24.6%, **bullish 31.9%**, with the top band returning **−1.01%** mean. The assignment gradient is monotone and is the robust part — assignment counts are immune to the return tails that make means fragile here. Selecting for "not in a downtrend" produced more assignment and worse returns.
- `technicalNeutral` is **flat** at every level (means −0.27 / −0.58 / −0.10, assignment ~25% throughout) — no signal in either direction. `recentVolatility` is weak and mildly **inverted**: its high-vol end returned a better median (+1.92%) than its low-vol end (+0.72%), the opposite of what a `lower_better` weighting assumes.
- **This is the ADX finding again.** `USE_ADX_IN_SCORING` was set false in v1.1.33 on a full-year Brief Replay A/B, with the recorded reason that strong-trend names mean-revert over the next ~21 days. `notDowntrend` measures nearly the same thing through the SMA stack and reproduces the result on different data — a trend-following term inside a short-premium composite, now found anti-predictive twice, independently.
- **Not acted on**: 8 of 91 weight, a small effect, one regime, and observational rather than an A/B. A faithful weight sweep is impossible today — the wheel composite needs `fundamentals_cache` (no history) and income, the usual proxy, carries no `notDowntrend` term.
- **The v1.1.175/177 capture is what unblocks it.** `brief_candidates.signals_json` stores each candidate's per-signal `{raw, normalized, weight, missing}`, so after a quarter the composite can be recomputed with any one term removed and compared on real outcomes — the exact A/B that cannot be run today. First concrete payoff of that instrumentation.
- **F8's residual is now narrow**: one small measured anti-predictive term, plus `fundamentalScore` (17) + `leverageQuality` (4) — 21 points of permanently unverifiable weight.

## [1.1.177] — 2026-09-03

### feat — Stage-4 candidates capture the earnings date, closing the one gate no study could test

- **The earnings gate is the only rule in the wheel path that has never been testable**, in any study, for one reason: `earnings_calendar` keeps one row per ticker with **no history**, so a replay always sees today's next-report date rather than the date live on the pick date. The consequence is on record — a retrospective run still selects **NVDA on 2026-08-26**, its actual earnings day, the exact failure the gate exists to prevent.
- **v1.1.176 briefly looked like a way out**, since `analysis_snapshots` rows carry a `daysToEarnings` field. It is **NULL on 100% of 23,722 settled rows** — the column exists and is never populated. That made four separate places where the gate could not be evaluated.
- **Migration 077 adds `earnings_date` and `days_to_earnings`** to `brief_candidates`. Both, deliberately: the date is ground truth and auditable, the day count is what a study filters on and pairs with the existing `dte` to answer the gate's real question — does the report land inside the hold window? ~14 bytes. Additive `ALTER TABLE` on a table holding 0 rows, so nothing to backfill.
- **NULL is not "clear".** It means unknown *or stale* as of the pick date — either no calendar row, or a stored date already in the past, which per the dice's own rule means the *next* date is unknown. `roll-the-dice.ts` fails closed on exactly that, and a study reading NULL as "no earnings, therefore fine" would reproduce the precise blindness this column removes. Pinned by a test.
- The job loads future-dated report dates once per run and stamps each candidate, wrapped in try/catch like the rest of the capture, so it can never fail the brief. 2 new tests (14 total). Suite: 1159 passed.
- **Nothing retroactive** — capture starts at the next brief run. After a quarter there will be, for the first time, a sample where the earnings gate can be checked against what was actually known, rather than assumed correct because no test could reach it.

## [1.1.176] — 2026-09-03

### docs — F8's mechanism is refuted: premium richness is not what makes the composite anti-predictive

- **No behaviour change.** v1.1.173 measured the wheel composite anti-predictive at the top of its picks (+1.91% mean return on capital in the 58–63 band against **−4.99%** at 73+) and then *attributed* it to `ivRank` (22) + `premiumYield` (19) — 41 of 91 weight — reasoning that premium richness is compensation for risk rather than edge. **That attribution was inference from weights and the worst tickers, not measurement.** This tests it.
- **`analysis_snapshots` allows the real test**: it holds the whole wheel universe per date — every ticker's actual recommended CSP with strike, premium, delta, IV rank and liquidity — not just the five that reached a brief. So selection rules can be applied to the same universe on the same dates and compared against **no selection at all**. 23,722 settled rows across 40 dates, episode-collapsed, scale-guarded.
- **Premium richness HELPS**, judged on medians as well as means (the worst single outcome in the sample is −87.5%, so a mean can be set by two names): top annualized return **+1.03 mean / +2.67 median** versus no selection; top ivRank + annRet +0.25/+1.60; top ivRank +0.16/+0.91. And the **lowest**-annualized-return rule is the worst of every rule tried, at −1.21/−0.61. The relationship runs the opposite way from the one F8 asserted.
- **So the finding stands and the explanation does not.** The composite *is* anti-predictive at the top of the picks — that was measured on 101 episodes and is untouched. It is simply not `ivRank` + `premiumYield`. **Suspicion moves to the other 50 of 91 weight**: `fundamentalScore` (17), `technicalNeutral` (11), `recentVolatility` (10), `notDowntrend` (8), `leverageQuality` (4). Awkwardly 21 of those draw on `fundamentals_cache`, which has no history and is permanently unvalidatable; the other 29 are price-derived and testable, and that is the next study.
- **The liquidity finding replicates on independent data at 3.5× the sample.** The liquid subset (≥5/10) trails the illiquid one on all three measures — mean **−0.58% vs +0.73%**, median +1.07% vs +1.53%, trimmed +0.31% vs +1.29%. v1.1.170 reached the same conclusion on 6,777 income rows; this reproduces it on 23,722 wheel rows from a different source. Keeping `optionLiquidity` disabled in scoring is now supported twice over.
- **Correction recorded.** An earlier draft of the script claimed this was "the only study in this project that can apply the earnings gate honestly", because `analysis_snapshots` rows carry a `daysToEarnings` field. **It is NULL on 100% of 23,722 rows** — the column exists and is never populated, so the gate is untestable here too. Follow-up worth taking: `brief_candidates` (v1.1.175) does not capture days-to-earnings either, and one additive column would make the earnings gate testable for the first time, from that point forward.
- **CLAUDE.md corrected.** The "signals that pay most are risk premia" quirk claimed both liquidity *and* the composite. Only the liquidity half survives; the composite half is now recorded as a refuted inference, with the transferable lesson kept — a plausible mechanism read off a weight table is a hypothesis, and this project's data can usually test it directly, so test it before it becomes the reason for a decision.
- The wheel composite floor stays rejected regardless: that was measured (every threshold made the book monotonically worse while emptying up to 14 of 35 days), not inferred from the mechanism.

## [1.1.175] — 2026-09-03

### feat — the brief stops discarding the losers: every Stage-4 candidate is persisted

- **When a ranking's quality is in question, the losers are the data you need — and this pipeline threw them away.** The brief keeps only the top `PICKS_PER_STRATEGY` (5) of a `STAGE4_POOL_SIZE` (15) pool, so the 15→5 cut has never been measurable. It matters now: v1.1.173 found the wheel composite **anti-predictive at the top** (+1.91% mean return on capital in the 58–63 band vs **−4.99%** at 73+) and v1.1.174 showed the dice tiebreak is nearly vacuous, leaving this cut as the remaining exposure — testable only from the moment capture begins, never retroactively.
- **A slim new table rather than longer brief retention, and the numbers are why.** `daily_briefs` holds **52.8 MB across 366 rows — 147.7 KB each** (every row carries the full `strategyLabResult` per pick), about **9% of the 567 MB database**, growing **~229 MB per trading year** unpruned. That is why `pruneStaleBriefs(90)` hard-deletes them — and in turn **why every study in this project reports "one regime"**. `brief_candidates` stores what a settlement study needs: ~90 rows/day, **~20 MB per trading year**, roughly a tenth of what the briefs alone would cost, kept **730 days**. The briefs keep their 90-day window for the UI; the evidence outlives it.
- **What is captured:** one row per candidate per strategy per date with `disposition` — `picked` / `capped_out` / `failed_liquidity` / `not_validated` — plus composite, rank, and the structure the strategy would actually trade (slug, strike, premium, expiration, DTE, liquidity), selected through the same `pickRelevantStructure` the report, critic and renderer use so a candidate is directly comparable to a pick. Disposition is derived from the same three sets the existing funnel log computes, so table and log cannot disagree.
- **Outcomes are deliberately NOT stored.** They are settled later against `historical_prices`, so a subsequent split repair *corrects* them rather than leaving a frozen wrong number — the failure mode already on record, where four CRWD rows manufactured −$168,516 of fiction. **`spot` IS stored**, because the split scale guard needs the underlying as of the pick date and that is the one input a repair makes unrecoverable.
- **Fail-safe by construction:** `saveBriefCandidates` returns 0 on any error rather than throwing, so instrumentation can never break the brief that produces the recommendations. Covered by a test that drops the table mid-run.
- **It captures more than the cut strictly needs, because capture is one-directional.** Three studies this session were blocked by capture rather than analysis — the liquidity A/B ran on income because wheel rows had no bid/ask/open_interest until v1.1.132 (wheel is *still* untestable until October), the ETF gate was unsatisfiable because no ETF outcome existed, and this cut discarded its losers. Every study also ended on "which signal caused it?", which on T2 could only be inferred. So the schema takes everything already computed at Stage 4 while it is free: **`signals_json`** (turns "the composite selected badly" into "**this signal** did"), **`delta`** (v1.1.171 showed it drives outcomes, so a selection study must control for it), **`bid`/`ask`/`open_interest`** (precisely what v1.1.132 had to bolt on), plus `pop_estimate`, `annualized_return`, `max_loss`, `net_credit`, `atm_iv` and `grade`.
- Migration 076, `src/main/services/brief-candidates.ts`, 12 new tests. Suite: 1157 passed.
- **Nothing is retroactive** — the first rows appear on the next brief run. Roughly a month for a first look at the top-5 cut; roughly a quarter to ask it across more than one regime.

## [1.1.174] — 2026-09-03

### docs — the dice composite tiebreak is nearly vacuous; the F8 concern does not land there

- **No behaviour change.** v1.1.173 flagged "Roll the Dice breaks ties by highest composite, which may select the worst of its eligible set" as the most decision-relevant open question. The answer is structural, not statistical.
- **The tiebreak almost never has anything to break.** Eligible-set sizes across 62 stored brief days: **0 → 28 days, 1 → 27, 2 → 6, 3 → 1**. Of the 34 days that produced a pick, **27 (79%) had exactly one eligible candidate**. Only 7 days offered a real choice; only 4 are fully settled. The gates ahead of the sort — critic `pass` and non-degraded, liquidity ≥ 8, earnings clear of expiry, real credit — do essentially all the selecting.
- **The four settled choice-days are an anecdote, not evidence**, and are labelled as such: chosen **+2.02%** vs alternatives **+2.10%**, chosen winning 2 of 4. One day (2026-07-14) looks like F8 in miniature — WWD at composite 74.6 assigned and lost −6.66% while MKC at 61.6 returned +2.15% — but a single day is a story.
- **The real exposure is upstream and currently untestable.** The brief keeps only `PICKS_PER_STRATEGY = 5` by composite out of a `STAGE4_POOL_SIZE = 15` pool, and the dice can only see those 5. That cut is where an anti-predictive composite would do its damage, and `daily_briefs` cannot test it because it persists only the survivors. `analysis_snapshots` holds the full universe (65 dates, ~1,223 wheel rows each, 79,477 total, each with a real `recommendedStrike`/`premium`/`delta`/`ivRank`/`optionLiquidityScore`) but carries **no `compositeScore`**, and 21 of the composite's 91 weight comes from `fundamentals_cache` which has no history — so a selection study on the reconstructable signals is possible, a faithful composite replay is not.
- **Proposed, not built:** persist composite + eventual outcome for all 15 Stage-4 candidates rather than just the top 5. Small and additive, and the only way the top-5 cut becomes directly measurable instead of inferred.
- Recorded in CLAUDE.md as a standing lesson: **before studying whether a selection rule picks well, count how often it has anything to pick between** — one eligible-set-size histogram retired this study before it was written. And its corollary: when a ranking's quality is in question, the losers are the data you need, and pipelines habitually discard exactly those.

## [1.1.173] — 2026-09-03

### docs — T2: a wheel composite floor is REJECTED; the composite is anti-predictive at the top

- **No behaviour change.** Wheel stays ungated — now on evidence rather than omission.
- **Replay could not answer this.** It is blind to `premiumYield` (19 of wheel's 91 weight), which shifts and compresses the composite scale; `brief-replay-service.ts` says never to carry an absolute wheel threshold between replay and live, and a gate is exactly that. (Bearish's 70 was safely replay-derived because bearish has no options-derived signal.) So this ran on **live brief picks** with real settled CSPs: 180 picks → **101 independent episodes**, mandatory split scale-guard excluding **0** rows.
- **Every candidate threshold made the surviving book monotonically worse** while emptying days: ungated **+0.56%** mean return on capital; gate 62 → −0.35% (7/35 days emptied); 65 → −1.13% (8/35); 68 → −3.03% (13/35); 70 → **−3.89%** (14/35).
- **Because the composite is anti-predictive at the top.** Mean return by band: 58–63 **+1.91%**, 63–68 +1.84%, 68–73 **−1.08%**, 73+ **−4.99%** — with assignment climbing 16.3% → 61.5%. **Not outlier-driven**: it survives trimming 3 per tail (−1.84% vs +2.32%) and the medians agree (≥68 **+0.27%** vs <68 **+2.44%**).
- **The mechanism is legible in the worst names** — MRVL ×3 (−22.2%, −16.4%, −16.4%), RKLB ×2 (−24.5%, −14.2%), COHR ×2, ON: high-IV semiconductor and space names. `ivRank` (22) + `premiumYield` (19) are **41 of 91 weight** and both reward premium richness, which is *compensation for risk*, not evidence of edge. Selecting harder on the composite selects for higher implied vol, more assignment, worse realised returns.
- **Second time a wheel signal has proved a risk proxy rather than a quality measure** — the first was liquidity in v1.1.170, where the graded score's top quartile carried 50% realized vol against 39% at the bottom. Recorded in CLAUDE.md as a standing caution: before adding a quality floor to a premium-selling strategy, check the *sign* of the relationship — the intuition carried over from directional strategies is inverted here.
- **Deliberately not acted on.** The tempting inference (invert or cap the composite for wheel) is not taken: n=13 per top band, one regime, held to expiry with no roll or post-assignment covered call — all of which cushion exactly the assigned cases concentrated in the high-IV bands. Precedent is explicit: buy/bullish anti-predictiveness was found on a similar sample and recorded rather than engineered on.
- **Top open question, flagged not built:** Roll the Dice breaks ties by **highest composite**, which — if this holds — may be selecting the worst of its eligible set. The dice pool is ≤5 and sits behind the critic, liquidity and earnings gates, so it does not follow automatically, but it is the most decision-relevant question left in the wheel path.

## [1.1.172] — 2026-09-03

### feat — ETF-aware wheel scoring ENABLED, after resolving a validation gate that could never be met

- **ETFs stopped being scored as though they had *failed* two signals they cannot possess.** Wheel's `fundamentalScore` (17) and `leverageQuality` (4) are structurally inapplicable to a fund wrapper; measured, **56 of 60 curated ETFs have no `fundamentals_cache` row** while all 60 have `iv_history` and `historical_prices`. Under FR-SE-03 those weights stayed in the denominator, capping every ETF's wheel composite at **70/91 = 76.9%** of an otherwise-identical stock. `ETF_AWARE_WHEEL_SCORING` now excludes both from numerator *and* denominator — a **×1.30** uplift, ETFs only.
- **The gate the fix waited on was unsatisfiable by construction, and that was the finding.** The code required "a Brief Replay improvement (or at least neutrality) on ETF wheel outcomes" — but there were **0** ETF picks across 62 stored briefs, **0** appearances in 88 wheel analysis snapshots covering 1,077 tickers, and **0** rows in `options_premium_history`. None could be generated while the flag was off, because the deflation is precisely what kept ETFs out of the Stage-4 pool where options data is fetched. *The distortion suppressed the evidence that would justify removing it.*
- **Resolved inside Brief Replay**, where the ON arm can produce ETF picks. New `scripts/replay-arm.mjs` captures and compares arms (replay runs only inside Electron and overwrites its tables each run). Both arms: 45 dates, 2026-06-02 → 2026-08-05, 225 wheel picks each, outcomes 100% matured. ON admits **6 ETF picks (2.7%)** — QQQ ×2, IYR ×2, XRT, KBE — each displacing exactly one stock and **on a higher composite in every case**.
- **Neutral on the metric that matters:** the swapped picks tied **6/6 vs 6/6 on stayed-above-strike**. The added ETFs returned less on the 21-day underlying (+0.22% vs +3.49%), but a short put is capped at the premium and never earns a runaway stock's upside — that column credits PAYX's +15.44% with money the CSP would not have made. Overall arm figures barely moved: stayed-above-strike 77.8% both, mean composite 67.5 both.
- **What this does not establish, stated plainly:** all 12 swapped picks stayed above their strike, so the metric never discriminated — it is a tie because *nothing failed in either arm*, not because ETFs were shown to handle stress. Six swaps, one regime. Replay also has no historical chains (outcomes are stock-return proxies) and runs blind to `premiumYield` for every ticker, leaving ETFs 51/70 populated against stocks' 72/91 even with the fix on — so **2.7% is a floor on the live effect, not a ceiling**.
- **Rollback: `SCORING_ETF_AWARE_WHEEL=0`.** The override now works in both directions, checked live; the `'0'` path also keeps the pre-fix deflation exactly reproducible as a regression baseline (58.3 vs 73.8 on the test fixture).
- New `scripts/fr-etf-wheel-deflation-study.mjs` quantifies the distortion and the bootstrap problem. Suite: 1145 passed.

## [1.1.171] — 2026-09-03

### docs — T1: the short put's 0.30 delta target is validated. No change.

- **The least-audited number in the wheel path now has evidence.** `strategy-lab-service.ts` builds every `short-naked-put` at a hardcoded `deltaTarget: 0.30` — one constant for every ticker in every IV regime, borrowed from tastytrade convention and never tested here.
- **The method the inventory proposed was impossible.** It said to re-derive the CSP at other deltas "from the stored chains" — there are none. `options_cache` is a live cache holding **0 rows**, and `daily_briefs.picks` records only the contract chosen. Synthesising strikes through Black-Scholes on stored IV would ignore the volatility smile, understating OTM put premium and biasing against the low-delta arm under test. Not done.
- **What exists is better.** `options_premium_history` records one **real** CSP per ticker per day per strategy with its real `delta`, `premium` and `strike`, settled against the real close at expiry. Wheel's band spans 0.20–0.30 and income's reaches 0.35, so the stored history is an observational experiment over the range that matters. **16,902 settled wheel CSPs · 1,005 tickers · 31 dates.**
- **Matched pairs are the real test.** Wheel and income sometimes select different strikes on the **same ticker, same day, same expiry** — ticker, regime, IV and DTE constant by construction, only delta differing. 1,151 pairs → **937 independent episodes**: low delta 0.23 → **+0.48%** return on capital, high delta 0.28 → **+1.14%**. Higher delta won **78.3%** of decided episodes (562/718). Decomposition: +0.54pp extra premium against +2.4pp extra assignment — the premium more than covers it. **Dose–response is monotone** (+0.22 / +0.41 / +2.26 pts as the delta gap widens), which is what separates a real effect from noise.
- **Monotone above 0.30 too**, using income's band: 0.20–0.24 +1.11%, 0.24–0.29 +1.23%, 0.29–0.33 +1.33%, 0.33–0.36 **+1.48%** — and the top two bins carry *lower* IV rank (47–48 vs 57–59), so the confound runs against the finding rather than producing it.
- **Not raised anyway, and this is the substantive part.** Sections A–C measure the premium seller's outcome; a wheel is not purely a premium business. v1.1.169 found the cost basis landing at or below the 200-day average separated outcomes by 17.4pp, and delta moves the two **in opposite directions**: ~0.21 → ~0.29 buys ~0.17pp of return on collateral and costs ~7pp of picks landing at or below that line (70.0% → 62.9%). Those are different quantities over different windows and are **not nettable** — combining them would manufacture a precision neither has. With section C's top bin at 542 rows from one regime and own-at-strike itself resting on 12 episodes, FR-SEY-5 does not justify moving a live parameter.
- **Verdict: keep 0.30.** Nothing supports lowering it; raising it is not supported strongly enough. It sits at the top of the wheel band, where the premium evidence is strongest and the cost-basis cost has not yet compounded.
- Caveats carried in the script and changelog: real quotes span 0.20–0.35 only (nothing about 0.10 or 0.45); one regime, 31 dates in 6.5 weeks; section B's pairs are a non-random subset (they exist only where the two code paths disagreed); held to expiry at intrinsic with no management, roll or post-assignment covered call — all three cushion assignment, so the true cost of higher delta is *smaller* than measured, which biases toward raising it and is another reason not to act on one regime.

## [1.1.170] — 2026-09-03

### docs — `optionLiquidity` re-tested on 2.7x the sample; the disable is now data-backed, not judgement

- **No behaviour change.** The signal was already disabled on wheel and income and stays disabled — what changes is the reasoning under it.
- **Why re-run:** the operator asked to turn it back on, not remembering why it was off. v1.1.135 was explicit that the disable had been applied **"on judgment, not on data"** — its weight sweep came back *non-monotone* (the middle worse than both endpoints) on ~80 trades per arm from a single three-week window, which is the correct reading of noise, and it left the question unsettled. Two more months of trades have since matured.
- **Sample grew 2.7×**: 6,777 → **18,219 settled CSPs**, 937 → **1,039 tickers**, 16 → **31 entry dates** (2026-06-15 → 2026-07-29). `scripts/fr-income-liquidity-realized-ab.mjs` needed no change — it selects everything settled up to `MAX(historical_prices.date)`, so it extends itself.
- **The sweep is now MONOTONE** — weight 13 → −0.47%, 9 → −0.27%, 6 → −0.20%, 3 → −0.08%, **0 (disabled) → +0.54%** mean return on capital. Every reduction improves the outcome and disabling flips the arm from losing to profitable, a 156-point swing across 155 trades. **This is the exact test v1.1.135 named** — "a real effect would be monotone" — and the 16-date run failed it.
- **Mechanism corrected.** v1.1.133 attributed the adverse relation to liquidity tracking realized volatility; on the wider sample that holds only for the *graded* scheme (top quartile 50% realized vol vs 39%). The **legacy** scheme — the shipped one — looks mildly *positive* in isolation (bottom quartile +0.82% → top +1.52%), and the resolution is the ivRank column: **liquidity is a noisy proxy for IV rank** (53 → 63 across those bands), which the composite already weights at **30**. Spending 13 more points on a weak echo of a signal already weighted at more than twice that does not add information, it dilutes the signals that carry the edge. v1.1.133's headline is untouched and better supported: liquidity is an execution-cost property, not an outcome-prediction property.
- **Wheel still cannot be tested directly, but is about to become testable.** v1.1.132 (2026-08-06) began persisting wheel's liquidity inputs: of 31,129 wheel CSP rows, **10,792 now carry bid/ask/open_interest and 0 have settled**, because they were entered from 2026-08-06 and expire in September. Income remains the proxy. **Re-run around 2026-10-01** for the first wheel-native result.
- **Correction to `docs/wheel-parameters.md`** (published earlier the same day): it claimed the reason for the 2026-08-07 disable "is not recorded anywhere and needs the operator's memory". That was wrong — it is documented across v1.1.131/132/133/135. Finding **F3** is rewritten (gate-not-ranking is a deliberate, studied design, not an inconsistency) and **T3 is closed**.
- Still one regime: 31 entry dates in a 6.5-week window, ~155 trades per arm in section B. The monotone sweep across five arms is much harder to get by chance than a single pairwise comparison, which is why it is reported as settling the question — but it is not a multi-regime result.

## [1.1.169] — 2026-09-03

### feat — own-at-strike is answered from the stock's own history, not from a curated list

- **v1.1.168 shipped with a recorded cost — "nothing now enforces own-at-strike" — and measuring the band to replace it showed that cost was overstated.** The conviction never-above line is anchored to spot on the day it was written: across all 13 stored rows `price_high / spot` at write time has median **1.126**, while an OTM cash-secured put strikes at median **0.930** of spot. So `strike / price_high ≈ 0.83` by construction and the test cannot fire until spot has risen ~21% above where the band was last written. Over 62 briefs, **0 of 39** picks on a listed ticker breached it; the closest was still 10% under. It was decorative *before* the demotion. (It also drifts: SPY's and VOO's lines now sit at the 195th percentile of their own 52-week range — above every price those funds have traded at.)
- **`own-at-strike.ts` replaces it with a read of the stock's own history.** Where the effective cost basis (`strike − premium`, what assignment actually costs) sits against the ticker's point-in-time 200-day average and 52-week range. Available for **100% of stored wheel picks**, needs no curation, cannot go stale. Fewer than 200 sessions reads as "not enough history", never as a pass; the range percentile is deliberately unclamped because a basis outside the 52-week range is real information.
- **It leads the ownership sentence in both the email and the panel**, with the conviction band demoted to secondary context so it cannot read as an all-clear it did not earn. A basis *above* the long-run average is warned in words and colour, not merely stated.
- **Measured worth** (`scripts/own-at-strike-study.mjs`; outcome = return from the cost basis at expiry+30d, **excess of SPY** over the identical window, for every pick not just the ~27% assigned): raw +14.20% vs +0.61%; SPY was +3.95% vs +3.89% in the two arms, so regime is not the explanation; excess-of-SPY +10.24% vs −3.29%. **Per independent episode — collapsing NVDA×7 and AVGO×6 across 8 consecutive days into one observation each — +12.10% (n=12) vs −5.32% (n=35), a 17.4-point separation.** It grew under de-duplication, survived leave-one-out (14.3 pts without the +46% INTU outlier) and survived dropping NVDA and AVGO entirely (19.1 pts, n=8). 11 of 12 accept episodes positive.
- **It annotates and does NOT gate, per FR-SEY-5.** The accept arm is 12 episodes across three expiries in a single ~4-week window — only picks whose expiry+30d has passed are measurable, truncating everything after early July 2026. This project has rejected several levers that looked exactly this good on one regime (SPY-regime gate, overbought guard, expiry selection). Re-run once ≥3 months of briefs have matured.
- **Fundamentals deliberately excluded** despite `fundamentals_cache` carrying P/E, EPS, value/growth scores and grades: one row per ticker with no history means a replay scores against *today's* values — the same trap that makes the earnings gate unreplayable. Only price anchors are honestly testable.
- 14 new tests (`tests/own-at-strike.test.ts`) plus dice/email regressions, weighted toward the two failures that made the old check useless: that it CAN come out negative, and that "don't know" never renders as a pass. Suite: 1144 passed.

## [1.1.168] — 2026-09-03

### feat — Roll the Dice picks on the trade's merit; your size and conviction list only annotate

- **Today's no-dice day rejected two picks for being about the operator, not about the trade.** MPC ($37,000) and AAPL ($32,000) both cleared every quality gate — critic `pass` and non-degraded, a constructible CSP, liquidity ≥ 8 — and died on the capital ceiling. MPC died on the *first* exception check, "not on your conviction list", so **its composite was never evaluated at all**; that list holds 13 names and the operator no longer actively maintains it.
- **The gates now judge the trade, never the operator.** Trade-quality gates (critic verdict, constructible and liquid CSP, earnings clear of expiry, real net credit) stay hard. Operator-fit facts — capital committed and conviction-list membership — are computed, reported on `pick.fit`, and **exclude nothing**. An operator's stated size and a stale watchlist are not evidence about a trade, and a filter that deletes a setup before they see it does not inform their funding decision, it replaces it.
- **The exception tier is deleted**, not loosened: `qualifiesForStretch`, `STRETCH_MIN_SCORE` (70), `STRETCH_MIN_LIQUIDITY` (11) and `DEFAULT_STRETCH_CAPITAL` ($50k) all go. It existed for exactly one purpose — letting good trades escape the capital gate — and that gate is gone.
- **`maxCapital` survives as a reporting split, not a ceiling.** When the merit pick exceeds it, the result also carries **`withinBudget`**: the highest-scoring eligible candidate that does fit. Demoting the gate therefore never leaves a day with nothing fundable — the operator sees the best trade *and* an affordable one, and chooses between them.
- **Surfaces state the fit rather than justifying it.** An over-budget pick leads with "TIES UP $37,000 — ABOVE YOUR USUAL $30,000" and says it is *not* a rejection. Conviction is stated in four distinguishable states — not listed / listed with no band / strike inside the band / **strike ABOVE the band** (loud: on assignment you would be buying at a price you already ruled out). The gate list no longer claims the price was checked against a limit.
- **Validated per FR-SEY-5** (`scripts/dice-fit-demotion-study.mjs`, 62 stored wheel briefs, both arms sharing identical quality gates): pick-days **26 → 34 (41.9% → 54.8%)**, median winner composite unchanged at **65.9** — removing a non-merit filter can only raise the winner's merit, so a drop would have meant a bug. Of the 34 pick-days, 12 exceed $30,000 and only 3 of those have a within-budget alternative to offer; 17 are not on the conviction list; 0 breach a never-above band.
- **Costs accepted knowingly:** the promise shifts from "close your eyes and do it" to "here is the best wheel entry, check you can fund it", and **nothing now enforces the operator's own own-at-strike rule** — the conviction sentence is the only place that question is still asked, and a badge is not a band. The critic verdict still rejects by far the most and is untouched.
- Tests rewritten to prove the gate **stays** gone rather than that a happy path passes. Suite: 1129 passed.

## [1.1.167] — 2026-09-02

### fix — the E*Trade OAuth calls are instrumented like every other request

- **The auth calls were the one blind spot left in the v1.1.144 logging.** `getRequestToken`, `getAccessToken` and `renewAccessToken` called `fetch` directly rather than going through the instrumented path, so the 2026-09-02 API log held **13,098 E*Trade rows and zero auth entries**. A renew that silently failed left no trace at all — the log could prove a token *worked*, but never whether a renew or re-auth had happened. That is exactly what reduced yesterday's stale-token diagnosis (v1.1.166) to inference.
- **One transport now, not two.** The fetch + timeout + network-fault logging is extracted from `etradeGet` into `sendETradeRequest`, and all four call sites share it. `etradeGet` keeps its own nonce-retry and JSON handling; the OAuth calls keep their form-encoded parsing. Each caller logs its own outcome, because success means different things to a market call and a token exchange.
- **The asymmetry that matters: failures are logged, successes are not.** An auth *failure* body is E*Trade's `oauth_problem=…` envelope — precisely what diagnosis needs, so it is written. An auth *success* body carries `oauth_token` and `oauth_token_secret` in clear text and is **never** written: the API log is a plaintext file with 30-day retention, and a leaked token secret is a live brokerage credential. `oauth_verifier` is not logged either, nor the signed `Authorization` header.
- **The OAuth calls inherit the 30 s hard timeout.** They previously had none, so a stalled socket could be retransmitted by undici — replaying the already-signed header and earning `oauth_problem=nonce_used`. This is a behaviour change on the live auth path, and it applies most to `renewAccessToken`, the call most likely to meet a dormant token that kills the stream rather than returning 401.
- 13 regression tests (`tests/etrade-auth-logging.test.ts`), including leak canaries asserting that a freshly minted token is returned to the caller but never reaches the log, and that a throwing logger can neither break a renew nor swallow its error. Suite: 1126 passed.

## [1.1.166] — 2026-09-02

### fix — a stale token date no longer condemns a working E*Trade token

- **Startup demanded an interactive re-auth for a token that was working perfectly.** `etrade:check-connection` compared the stored `etradeTokenDate` against today's ET date and returned `expired` on a mismatch — **without calling E*Trade at all**. On a mismatch `App.tsx` hijacks startup and redirects to Settings. Observed live 2026-09-02 19:49 ET: the app made **zero** E*Trade calls yet showed the reconnect screen, while the same token returned 200 OK 50 minutes earlier and 90 seconds later.
- **The premise behind that short-circuit is false.** E*Trade documents midnight-ET expiry, and the code took that as certainty ("renew cannot revive it, so don't waste a call"). The API log for 2026-09-02 shows a token stamped **2026-09-01** serving **13,098 successful calls** across the midnight boundary — including at **00:40 ET** — so every check that day reported `expired` about a live token. Only E*Trade can declare a token dead.
- **`etradeTokenDate` now means "last known good", not "issued".** A stale value means *not verified yet today*, which is a reason to ask rather than a verdict. `probeETradeConnection` drops its date short-circuit and always probes; a successful probe (or renew-and-retry) **re-stamps** the date, so the check self-heals and the next startup is free.
- **The free path is unchanged.** Verified today → `ok`, no API call, no added startup latency. Only a stale or missing stamp costs one SPY quote. A missing stamp used to be *assumed valid* and stamped — the same bug pointing the other way — and is now probed too.
- **A network failure can never read as `expired`.** Not reaching E*Trade says nothing about the token, so it maps to a new `unknown` status that startup ignores rather than dragging the user to Settings over a blip. Settings renders `unknown` as a connection error so the reconnect controls stay reachable.
- Logic extracted to an exported `checkETradeConnection(db)` so the startup gate is unit-testable rather than living inside an IPC closure.
- **Known gap, not fixed here:** `getRequestToken` / `getAccessToken` / `renewAccessToken` call `fetch` directly instead of `etradeGet`, so they bypass the v1.1.144 logging choke point entirely — an API log holding 13,098 E*Trade rows contains **zero** auth entries. Diagnosing this needed the auth trail and it did not exist.
- 11 regression tests (`tests/etrade-stale-token-date.test.ts`). Suite: 1113 passed.

## [1.1.165] — 2026-09-02

### fix — conviction bands can no longer be saved inverted, in the service or the schema (FR-CONV-1)

- **The edit modal validated `low < mid < high`; the service did not — and the modal was not the only writer.** The AI review **Apply** path merges LLM-recommended bands *field-by-field* into whatever is stored (`recommendedLow ?? stock.priceLow`, …), so a recommendation returning only a new low can land it above an untouched mid. Three rows (MSFT 433/409, NOW 123/108, PLTR 152/133) sat inverted for **three weeks**, silently feeding wrong Buy-zone alerts and the brief's ⚡ Conviction Alerts callout. An inverted band never throws — it just computes the wrong zone.
- **Enforcement moved to the choke point.** `validateBandOrder()` in `conviction-service.ts` runs inside `add()` and `update()`, so every writer — IPC, the AI-apply loop, anything added later — passes through it. Present pairs must be strictly increasing; nulls are skipped (a partial band is legitimate); equal values are rejected. Messages name the ticker and both offending numbers.
- **A rejected update writes nothing at all.** Validation runs *before* `withTransaction`, so a refused edit leaves the stored bands intact and appends no `conviction_band_history` snapshot — the audit trail records saves, not attempts.
- **The AI-apply loop no longer aborts on the first refusal.** Each row applies independently; refused tickers are listed by name in the error banner and stay selected so they can be fixed by hand, while the rest of the batch lands. Previously the first throw escaped an uncaught `try/finally` and left the batch half-applied with no message.
- **`recommend()` now floors high above mid** (it already floored mid above low), so **Apply all** from the recommendation panel can never produce a set the service rejects — reachable when a stale snapshot's entry zone sits above the current price.
- **Backed by three DB CHECK constraints** (migration 075): `conviction_bands_low_lt_mid`, `_mid_lt_high`, `_low_lt_high`, each a no-op when either side is NULL so partial bands stay legal. The service keeps producing the readable ticker-named error; the CHECKs close the door on raw SQL, repair scripts and anything added later. `conviction_band_history` is **not** constrained — it records what was actually stored, inverted rows included.
- **The rebuild needed to install them had two traps.** `conviction_band_history` has an FK to `conviction_stocks` with `ON DELETE CASCADE`, so dropping the parent would have deleted the entire audit trail — and `PRAGMA foreign_keys=OFF`, the SQLite manual's answer, is a **no-op inside a transaction**, which is exactly where `migrations.ts` runs every migration. The child is copied aside and dropped *before* the parent is replaced, then recreated and refilled with its original ids.
- **Pre-existing violating rows are normalised, not rejected** — a failed migration means the app does not boot. The original is snapshotted into band history (nothing lost), then the present values are sorted into their slots: a low/mid inversion becomes a swap, keeping both numbers. Equal values, which sorting cannot separate under a strict CHECK, drop the duplicate and keep the outer bounds.
- **Dry-run against a copy of the live 590 MB DB**: applied in **4 ms**, all 13 stock rows and all 48 history rows byte-identical including ids, `foreign_key_check` empty, `integrity_check` ok, FK restored, no leftover scratch tables. Inverting a real row by raw SQL is now rejected.
- 25 regression tests across `tests/conviction-band-order.test.ts` (service) and `tests/conviction-band-check.test.ts` (migration + CHECK) — one reproduces the AI-apply merge shape directly, one asserts the audit trail survives the rebuild. Suite: 1102 passed.

## [1.1.164] — 2026-09-02

### feat — Roll the Dice gates on capital, plus a defined exception for better setups
- **The gate is now capital committed (`strike × 100`), not share price**, at a **$30,000** ceiling. Share price was a lossy proxy: the strike sits below spot, so a $306 stock struck at $285 commits **$28,500** while a $299 stock struck at $295 commits **$29,500** — the cheaper-looking one costs more. Over 62 stored wheel briefs the switch moved the hit rate **23 → 25 days (37% → 40%)**, admitting three AAPL setups whose strike was under $300 while spot was over it.
- **A defined exception tier** — capital up to **$50,000**, but only by clearing a strictly higher bar on *every* axis, all of it committed before the setup appeared: on the conviction list, strike ≤ that ticker's `price_high` ("never enter above this"), composite ≥ 70, liquidity ≥ 11/15. Fires **twice** in 62 briefs (AMD, June), lifting the rate to **26/62 (42%)**. An exception mechanism is how a disciplined filter becomes a rationalisation engine, so it demands more evidence, not less — and a ticker allowlist was rejected as the alternative, since favourite names are exactly where overconfidence lives.
- **Two calibration findings changed the design.** `criticVerdict.confidence` reads `high` on **40 of 41** eligible picks, so it is deliberately NOT a criterion — requiring it would add the appearance of rigour and none of the substance. And a first draft used composite ≥ 75, which sits above the observed maximum of 76.0 and fired on nothing; checked against the distribution (58.9–76.0, median 65.9) and corrected to 70.
- **Conviction-list data note:** 3 of 13 rows have `price_low > price_mid` (MSFT 433/409, NOW 123/108, PLTR 152/133), inverting the intended ordering. The gate uses `price_high` only — the one band unambiguous regardless.
- A stretch pick is announced **before** the order in both email and panel, with amount and reason, so it never arrives looking like an ordinary trade.
- **Correction:** I previously reported SNOW as failing only the $300 price limit, "out by $5.84", and used it to motivate this change. Wrong — the diagnostic checked price before liquidity and short-circuited; SNOW fails on **liquidity 7/15** and was never eligible. The capital-gate reasoning stands on its own merits and on the three AAPL setups it genuinely admits, but that example did not support it.
- 18 gate tests (each proving a REJECT) + 11 email tests. Suite: 1077 passed.

## [1.1.163] — 2026-09-02

### feat — 🎲 Roll the Dice by email: one opportunity, built as a card not a report
- A grid is the wrong shape for a single trade — there is nothing to compare it against — so the dice email is laid out as a card. **The subject carries the whole trade** (`🎲 NVDA — sell the $205 put, Fri Sep 25 · $744 credit`), because that is the part most likely to be read on a phone without opening anything.
- **Leads with the order, not the analysis**: *Sell 1 NVDA $205 put*, then expiry and days. Then the three numbers — you collect / cash required / **if assigned, you own it at $X (Y% below spot)**. That last line gets equal weight because it is the question a wheel entry actually turns on.
- **The downside in plain language with real numbers**, not a disclaimer: *"If NVDA is below $205 on Fri Sep 25 you buy 100 shares at $205, costing $20,500. Your break-even is $197.56 — below that you are down roughly $100 for every dollar further it falls."* "Passed every gate" is spelled out, and rejections are listed, so the bar is visible rather than claimed.
- **A no-pick day still sends.** Silence cannot be told apart from a failed job or broken SMTP, and the point is that the operator can stop checking. The empty card says ~2 days in 3 is normal so it does not read as a malfunction. No PDF attachment — one trade does not need one.
- **Sent from inside the brief job**, right after the brief's own email, rather than as its own batch step: it is a pure filter over the brief that job just persisted, so inline guarantees the ordering and avoids adding a `sequence_order` row — the column `registerJob` seeds only on fresh installs, source of four defects already (v1.1.121, v1.1.123, migration 067, v1.1.160). Failure is caught and logged; it can never fail the batch.
- Also an **✉ Email it** button on the dice panel and `scoring:email-roll-the-dice`. All three routes go through the new `computeRollTheDice(db)` so email, panel and IPC cannot disagree about today's pick.
- Email HTML is table-based with fully inline styles and explicit light colours on every cell (Outlook ignores flex/grid, Gmail strips `<style>`, and client dark-mode is how "invisible text" happens); `max-width:560px` for phones.
- **Note:** rendering the preview from real data selected **NVDA from the 2026-08-26 brief — its earnings day**, which is v1.1.162's documented blind spot appearing immediately: with no calendar history the earnings gate cannot fire retrospectively. Live, that pick is rejected.
- 11 unit tests incl. HTML escaping of model-authored critic text. Suite: 1069 passed.

## [1.1.162] — 2026-09-02

### feat — 🎲 Roll the Dice: one wheel entry from the brief, or an explicit nothing
- A Daily Brief button that reduces the whole brief to a single cash-secured put the operator can place without reading anything else. Hard gates, not weights — the brief has already scored and ranked; this layer only removes: critic verdict **pass**, critic **not degraded**, price **≤ $300** (configurable), a constructible `short-naked-put`, liquidity **≥ 8/15**, **no earnings before expiry**, positive net credit. Winner is the highest `compositeScore` among survivors.
- **It must be able to return nothing.** A "close your eyes and do it" feature that always produces a pick would have to lower its bar on a bad day — which is exactly when the bar matters. *"No dice today"* is a first-class result carrying the count considered and the most common rejection, and every rejection is listed with ticker and gate so the bar is visible rather than claimed.
- The card shows strike, expiry, credit, capital required, **cost basis if assigned** and its discount to spot, annualized return, PoP, grade, liquidity, the critic's note, and the runner-up. Styled from theme variables — the v1.1.157 → v1.1.158 lesson, no second palette maintained by hand.
- **Two gates exist because of bugs found earlier in this same session.** Earnings is an *exclusion*, not the brief's −20 penalty: a penalty on a high scorer still leaves it on top, which is how the brief ranked NVDA wheel #1 days before it reported. And an **unknown or PAST** stored earnings date fails closed — `earnings_calendar` is keyed by ticker with no history, so a past `report_date` means the row was never refreshed and the *next* date is unknown (**57 of 1,069 rows** were stale this way). My first implementation read a past date as "clear", repeating the session's opening mistake: *"there is a date stored" is not "the stored date is right."*
- **Validated retrospectively over 62 stored wheel briefs** (2026-06-04 … 09-01, 248 picks): a pick on **23 of 62 days (37%)**; rejections were critic verdict 172, price 27, liquidity 24, with 25 passing. **The earnings gate cannot be validated this way, and the replay shows exactly why it is needed** — with no calendar history the replay sees today's next-report date, records zero earnings rejections, and still selects **NVDA on 2026-08-26, its actual earnings day**. The gate is correct by construction on live data; the replay cannot see it.
- Pure filter over the stored brief: no scoring change, no provider call, nothing written — so FR-SEY-5 does not gate it, though the hit rate is recorded since the gate set is a selection policy. 14 unit tests, each proving a gate **rejects**. Suite: 1058 passed. Docs: `docs/formulas.md#roll-the-dice`, spec §14 (FR-BRIEF-DICE-1..6), `USER_GUIDE.md` §4.1a + PDF.

## [1.1.161] — 2026-09-02

### FR-SEY-5: Big Lizard vs Short Put Vertical, settled — and a harness bug that inverted its sign
- The backtest deferred since v1.1.86 finally has a settled sample. On **160 clean trades** (June + July 2026 entries, hold-to-expiry intrinsic): lizard **+$97,561** at **1.30%** avg return-on-capital vs spread **+$30,482** at **2.65%**. **Delta +1.35pp — the `spv − lizard ≥ 0` gate is MET.** The lizard earns 3.2× the dollars on 11.7× the capital; per dollar deployed the spread is ~2× as efficient with a smaller tail (−$4,985 vs −$7,690).
- Note the lizard's **higher** win rate (74.4% vs 68.1%) — it wins more often and loses bigger. v1.1.86's static estimate put its PoP at 52.7%, a coin flip; realized settlement says 74.4%. Static PoP geometry was wrong in *direction* here, which is exactly why FR-SEY-5 demands realized dollars.
- **`USE_POP_WEIGHTED_PREMIUM` stays disabled despite passing.** The gate answers "is the spread at worst neutral against the lizard?" — yes. It does not answer what enabling the flag *does*: `short-put-vertical` is in `STRATEGY_RELEVANT_SLUGS.inflection`, **not `bullish`**, so in the bullish bucket the flag cannot substitute the spread — only dock the lizard and redirect picks to `long-call-vertical`/`call-zebra`/`call-butterfly`/`poor-mans-covered-call`, none of which this backtest measured. Enabling would ship an unvalidated selection change under cover of a validated one.
- **fix — the harness first reported the lizard at −$70,955, the wrong sign.** Four CRWD picks carried **pre-split** strikes (4:1 split; strike/spot **4.12×**) settled against **post-split** closes: **−$168,516** of fiction from 4 rows out of 164. `split-repair` (v1.1.139) rewrites `historical_prices` but never the legs frozen in `daily_briefs.picks` — and shouldn't, since rewriting them would falsify what was actually recommended. **Counterintuitive consequence: repairing the price series makes stored legs *more* inconsistent, not less.** The harness now carries a scale guard (Δ0.50 short put must be struck within 35% of the pick-date close) and **prints** excluded rows rather than settling them as losses. Its query also didn't select `generated_at`, which the guard needs. Recorded in CLAUDE.md — any future replay reading stored legs needs the same guard.

## [1.1.160] — 2026-09-02

### fix — `portfolio-sync` was seeded with its own schedule and would have run twice a day
- Caught by the operator immediately after v1.1.159. `registerJob` defaults `dailyScheduleEnabled` to **true** and the registration didn't override it. Only `batch-orchestrator` is meant to carry a schedule; every other job is driven by the chain in `sequence_order`. Left as-is the job would have run **twice daily** — once on its own 17:45 timer, once inside the after-close chain.
- Not merely wasteful: a second unattended run writes to the **real position record**, and `position_audit` would have shown two sets of writes per day with no obvious cause — the audit log added one release earlier would have been recording a phantom.
- **Migration 074** corrects any install that already seeded it enabled. `INSERT OR IGNORE` never re-seeds an existing row, so fixing the code alone does nothing for a machine that already ran v1.1.159 — the same frozen-column trap as `config_json` (v1.1.121), `after_close_only` (v1.1.123) and `sequence_order` (migration 067). Four defects now from one root cause.
- **Impact: none — it never ran.** `batch_runs` had 0 rows for the job and `position_audit` was empty; the schedule was disabled before the first 17:45 fired.

## [1.1.159] — 2026-09-02

### feat — nightly portfolio sync, with an audit trail because it writes to money
- New `portfolio-sync` batch job runs last in the after-close chain: refreshes open positions from E*Trade, then imports closed positions with real broker fills. The Portfolio and Performance views are current every morning without anyone pressing a button.
- **Never returns `failed`.** The orchestrator is stop-on-failure and E*Trade's transactions endpoint is demonstrably flaky, so a broker hiccup must not stop the daily brief. Errors surface as a `success` result carrying a warning note.
- **Open positions sync BEFORE the closed import, and the order matters.** When a position vanishes from the broker, `syncPortfolio` writes an estimate marked "realized P&L estimated from last mark" — systematically wrong in both directions (TSLA $350 CSP: estimate −$3,735.53, actual **+$499.48**). Importing immediately afterwards supersedes the estimate with the real fill in the same run, so the wrong figure never reaches the Performance tab.
- This is the first batch job to write to the user's real financial record rather than market data, so **every write is audited** (`position_audit`, migration 073): old and new realized P&L, old and new exit price, the source (`orders` vs `transactions`), and why. Auditing can never break the write it records.

## [1.1.158] — 2026-09-02

### fix — Performance tab styling now matches the rest of the Portfolio view
- The new panel used its own inline light-theme styling, which rendered as white boxes against the app's surface. Operator: *"they are more easy on eyes compared to new boxes with white background."*
- `Stat` now reuses the existing `.summary-card` markup that the Total Positions / Unrealized P&L cards already use, and the panel's hardcoded hex colours were replaced with theme variables — one visual language, and theme changes are picked up for free instead of needing a second palette maintained by hand.

## [1.1.157] — 2026-09-02

### feat — capital-efficiency metrics: return on the capital actually at risk
- Measuring a wheel against total portfolio value understates it whenever capital is deliberately held back. This book realised **3.73%** of a ~$79k account but **11.56%** of the ~$26k actually deployed — against SPY's 13.15%. Both figures are shown so a *sizing* decision is never read as a *strategy* result.
- New `capital-efficiency.ts`: `capitalAtRisk` (a covered call adds none — the shares already secure it), `effectiveEnd` (an assignment hands capital from the put to the stock via a `strike − premium` cost-basis match rather than counting both), `dailyDeployed`, `portfolioEfficiency` (idle days **included**, so holding cash lowers deployed capital and raises return-per-dollar while return-on-portfolio shows what sitting flat cost), and `positionRoc` (projected vs realized annualized).
- New **Performance** tab surfaces portfolio-level efficiency plus a per-trade table: what the premium promised at entry vs what the holding period delivered. 15 unit tests.

## [1.1.156] — 2026-09-01

### fix — drop the mislabelled short twin left by the pre-v1.1.155 import
- The v1.1.155 sign fix corrected how long options are recorded, but rows written by the **earlier** broken import were still present as `CSP`/`CC` twins of positions that were actually long. Migration 072 removes them; migration 071 dedupes rows the import had inserted more than once.
- Closed-position count drops to **28**, and the book reconciles to E*Trade: realized **$2,458.18** against their **$2,457.50** (the $0.68 difference is the assigned TSLA $350 put, absent from E*Trade's G&L because an assignment defers premium into the stock's cost basis), unrealized **$673.45** against their **$673.44**.

## [1.1.155] — 2026-09-01

### fix — LONG options were priced as short premium, inverting their sign
- **Found by reconciling against E*Trade's own Gains & Losses export.** The app's realized total read **$3,309.67** against E*Trade's **$2,457.50**, and the operator's instinct — *"probably you are not seeing losses"* — was right.
- `matchClosedPositions` computed `(open.price − close.price)` for **every** option, which is only correct for short premium, and labelled every put `CSP` / every call `CC` regardless of direction. The TSLA Jul-17 $375 put was **bought** at 19.63 and **sold** at 15.98 — a real loss of **−$364.06** — and was recorded as a `CSP` worth **+$361.97**. **A $726 error on one row, in the direction that flatters the book.**
- `TxLeg` now carries `openedShort`, set from the order's `orderAction` (`SELL_OPEN` → short, `BUY_OPEN` → long). P&L follows direction, positions are labelled `Long Put` / `Long Call` matching what the position sync already writes, and `premium_received` is null for a long option (it pays a debit, it does not collect premium). The transactions path can only ever infer `open` from a SELL, so it is short by construction — one more reason orders is primary.
- **Reconciled line by line against the export**: 22 of 24 rows now agree to the cent. The two differences are understood — the **assigned** TSLA $350 put (**+$499.48** here, absent from E*Trade's G&L because an assignment defers the premium into the stock's cost basis rather than realising it), and two rows that were still last-mark estimates before this import.
- Regression: `etrade-orders-fallback.test.ts` +3 (7 total) — a long put bought high and sold low is a **loss** labelled `Long Put` with null premium; a short put sold high and bought back low is still a **gain** labelled `CSP`; a long call reproduces E*Trade's −$137.03. Suite: 1020 passed.

## [1.1.154] — 2026-09-01

### fix — `etrade-portfolio-service` was the last E*Trade consumer without renew-and-retry
- Every other E*Trade consumer has had `withRenew` since v1.1.94. This service called `etradeGet` **bare on all four of its paths** (`accounts/list`, `portfolio`, `transactions`, `orders`), so a dormant token failed the whole portfolio sync outright instead of recovering. Tokens go dormant after **2 h of inactivity**, and this service is driven by **manual button clicks** — precisely the usage pattern that idles past the window.
- **Retries on ANY error, deliberately.** A dormant token does NOT reliably surface as a 401: it can kill or hang the response stream instead (undici `terminated`). Gating renewal on an auth-shaped message is the exact bug that halted the evening orchestrator chain **8 of 10 trading days** before v1.1.92 and silently emptied option chains before v1.1.94. Renewing an already-active token errors harmlessly, so the retry decides the outcome either way.
- E*Trade's renew **reactivates the existing access token** rather than issuing a new one (which is why `renewAccessToken` returns void), so the same `creds` object stays valid across the retry.
- **The negotiation probes are deliberately NOT wrapped** — they exist to fail fast, and renewing five times over would double an already-slow diagnostic.
- Regression: new `tests/etrade-portfolio-renew.test.ts` (4) — a `terminated` stream (not a 401) triggers renew-and-retry; a renewal that itself throws does not abort the call; exactly one retry so a genuinely dead token still fails; and the orders path renews too, not just account listing. Suite: 1017 passed.

## [1.1.152] — 2026-09-01

### fix — executed ORDERS becomes the primary source; transactions returns 200 but yields nothing
- **Transactions finally worked end to end** on 2026-09-02: with `.json` + `sortOrder=DESC`, all **9 slices returned 200** (one recovered via v1.1.147's nonce retry, latencies 306 ms–91 s). **And it produced zero usable closed positions.**
- **The endpoint was never the only problem — the parser is.** `classifyTransaction` has to infer intent from *"sold means opened, bought means closed"* and then pairs opens to closes **by index**, which yields nothing on this account and would mislabel a long-option round trip or an assignment even when it does match. Orders needs no inference: `orderAction` states OPEN vs CLOSE outright and `averageExecutionPrice` is the realised fill.
- **Measured head to head on the same account**: executed orders → **25 correct closed positions with real fills**; transactions (all slices 200) → **0**. So the order is reversed — orders is primary, transactions is the fallback, kept only because it is the documented alternative and may cover activity orders misses (dividends, fees, corporate actions).
- This also explains why v1.1.151's supersede logic did not fire on its first run: transactions won the race, produced no positions, and `insertClosedPosition` was never called. With orders primary the 13 estimated rows are superseded on the next import.
- Both fallback directions are reported rather than silent (`Executed orders returned no legs; trying transactions` / `Executed orders unavailable, falling back to transactions: …`).
- Regression: `etrade-orders-fallback.test.ts` and `etrade-transactions-slicing.test.ts` updated for the reversed precedence. Suite: 1013 passed.

## [1.1.151] — 2026-09-01

### fix — `sortOrder` is required by the transactions endpoint, and real fills now supersede estimates
- **`sortOrder=DESC` was the missing parameter all along.** On 2026-09-02 the v1.1.149 negotiation found it: `{sortOrder:DESC, count:50}` returned **200 in 447 ms** on an endpoint that had never answered across nine prior hypotheses (range 8mo/31d/7d/none, path ±`.json`, count 5/50, fresh nonce, our signing). It is now tried first and defaulted onto every sliced request, so a slice no longer depends on which variant happened to win. The endpoint is still flaky — one slice failed twice and the run fell through to the orders fallback — but v1.1.147's nonce retry also recovered a slice that had failed once, exactly as designed.
- **Imported fills now SUPERSEDE the estimated rows instead of sitting beside them.** The position sync writes an estimate when a row vanishes from the broker (`exit_price` NULL, "realized P&L estimated from last mark"), and those are systematically wrong in two ways: an **ASSIGNED CSP reads as a large loss when it was a conversion into stock** (TSLA 350: estimate **−$3,735.53**, actual **+$499.48**), and a position closed by expiry is booked at its last mark rather than zero (TSLA 360 CC: estimate **−$463.02**, actual **+$347.47**). Those two rows alone were a **$4,235 swing**.
- The supersede key is deliberately tight — ticker + type + strike + expiry + entry_date + quantity, `IS` rather than `=` so NULL strike/expiry compare correctly. Matching on ticker+type alone collapsed an **open 100-share assignment lot** into a **closed 60-share lot from four months earlier**; both are kept distinct now. An estimate with no matching fill is left untouched rather than dropped or zeroed.
- **Measured result on the real book**: the app displayed **−$2,902**; actual fills give **+$4,494.14** over 2026-04-09 → 08-28 (realized wheel +$3,220.70 across 24 CSP/CC, 16 winners; realized stock +$599.99; open marked +$673.45). A **$7,396 error**, none of it from trading — all of it from the estimated marks. The import also surfaced **9 positions that were never in the database at all** (April/May OXY, PFE, NEM, TSLA), so the book runs 5 months rather than the 84 days previously visible.
- Regression: new `tests/etrade-supersede-estimates.test.ts` (4) — an estimate is overwritten in place rather than duplicated; an open assignment lot is not collapsed into an unrelated closed lot; a second import is idempotent; an estimate with no matching fill survives. Suite: 1013 passed.

## [1.1.150] — 2026-09-01

### feat — fall back to executed ORDERS when the transactions endpoint is dead
- **`/v1/accounts/{key}/transactions` never responds for this account.** Nine hypotheses tested against the API log and all falsified: range (8mo / 31d / 7d / none), path (with and without `.json`), params (`sortOrder=DESC`, `count=5`, `count=50`), transport (fresh nonce, fresh signature), and our signing — against **28 other calls on the same credentials all returning 200 in ~300 ms**.
- **E*Trade exposes no dedicated closed-positions endpoint**; Transactions and Orders are the two documented ways to reconstruct one, and only Transactions was ever wired up. When Transactions fails the import now falls back to `/v1/accounts/{key}/orders` with `status=EXECUTED`, mapping executed orders into the existing `TxLeg` model so `matchClosedPositions` and `insertClosedPosition` work unchanged — including writing a real `exit_price`, which **no row in the database currently has**.
- **Orders is arguably the better source regardless.** `orderAction` states intent outright (`SELL_OPEN` / `BUY_CLOSE` / `BUY_OPEN` / `SELL_CLOSE`), where the transactions path had to guess with "a sell must be an open" — a heuristic that mislabels both a long-option round trip and an assignment. And `averageExecutionPrice` is the realised fill rather than a mark, which is the entire point of this import.
- The fallback is **reported, not silent** (`Transactions unavailable, falling back to executed orders: …`), and the first orders page logs a **structural summary — key names only, never values** — so a schema mismatch is readable instead of prompting another blind guess. Success bodies stay unlogged by design (they carry fills and balances).
- **On the research that prompted this**: the Orders API lead was correct and useful. Other details in it were not, and are recorded so they are not repeated — the base URL was given as `https://etrade.com` (production is `https://api.etrade.com`, sandbox `https://apisb.etrade.com`), the path omitted the `/v1/` prefix, and one comment was garbled filler. Its "critical flags" (`MMDDYYYY`, `count` max 50, `marker` pagination, `.json`) were all already implemented and all already timed out.
- Regression: new `tests/etrade-orders-fallback.test.ts` (4) — a timing-out transactions endpoint routes to orders and a **real fill lands in `exit_price`**; `orderAction` drives OPEN/CLOSE so `BUY_OPEN` → `SELL_CLOSE` reads correctly; numeric `marker` pagination is followed; the reason for the fallback is surfaced. Suite: 1009 passed.

## [1.1.149] — 2026-09-01

### feat — negotiate a working transactions request shape instead of guessing one per release
- **Four hypotheses now falsified against the API log**: range width (31-day slice stalled like 8 months, v1.1.146), transport replay (a FRESH nonce got the same `oauth_problem=nonce_used`, v1.1.147), date parameters (`{count}` only, no dates, still hung and aborted at 45,016 ms, v1.1.148), and our signing (28 other calls on the same key and code, all 200 in ~300 ms). `/v1/accounts/{key}/transactions` hangs ~120 s for this account and reports it as `oauth_problem=nonce_used` — the OAuth message is a mask over a server-side timeout.
- **Guessing one variant per release costs a package-and-click cycle each time.** This tries the remaining plausible request SHAPES in one pass, 20 s each, and uses whichever answers: `.json` suffix (E*Trade honours a format suffix on many endpoints; its error envelopes come back as XML even with `Accept: application/json`), `sortOrder=DESC` (documented, and may be required for `count` to bound the result set — an unbounded scan would explain a fixed ~120 s timeout), both together, `count=5`, and a 7-day window.
- The winning shape is reused for every sliced request, carrying any extra params it needed (`sortOrder` persists; `startDate`/`endDate` are replaced per slice). Every attempt is logged, so total failure stays fully diagnostic and the error names each shape tried. Worst case ~100 s to establish the endpoint is dead, vs ~18 minutes before v1.1.148.
- **Reading it**: a variant answers → real fills. None answer → the endpoint is unusable from any client, pointing at E*Trade server-side or an account entitlement, and the next step is E*Trade support or a CSV import of their transaction history rather than more code guessing.
- Regression: `tests/etrade-transactions-slicing.test.ts` +3/−2 (7) — a `.json`-only winner propagates the suffix to every slice; a `sortOrder`-only winner keeps it while dates are still replaced per slice; nothing-answers issues no sliced requests and names each shape tried. Suite: 1005 passed.

## [1.1.148] — 2026-09-01

### feat — preflight the transactions endpoint: diagnostic, and 18 minutes faster to fail
- **v1.1.147's re-sign retry fired and still failed**: `01:25:21 401 120525ms nonce_used → retrying with a fresh signature` then `01:27:21 401 120565ms nonce_used`. **A fresh nonce cannot have been used before**, which kills the transport-retransmission theory as well as the earlier range-width one. Both attempts took ~120.5 s — essentially identical and suspiciously round — reading as a server-side timeout that E*Trade reports as `oauth_problem=nonce_used`. The OAuth message is a mask, not the cause.
- Everything else on the same credentials, account key and signing code works: `accounts/list` 308 ms, `accounts/{key}/portfolio` 371 ms, 26 market calls ~300 ms, all 200. Only `transactions` hangs, identically for 31 days and for 8 months.
- **Preflight probe** before the sliced loop: one minimal request with **no date range** (E*Trade defaults to a recent window), 45 s budget. It answers the open question — *is this endpoint alive for this account at all, independent of our date parameters?* — and earns its place regardless: without it a dead endpoint costs **9 slices × 120 s ≈ 18 minutes** of silent grinding before the import gives up. Now it fails in under a minute with a message naming the likely owner of the problem.
- **Reading the result**: probe returns 200 quickly → the endpoint is fine and our *date parameters* are the trigger. Probe times out → the endpoint is down for this account, no client-side change will help, and closed positions should be settled from expiry prices instead.
- Regression: `etrade-transactions-slicing.test.ts` +2 (6) — first call carries `{count}` only with no `startDate` on a 45 s budget; an unresponsive endpoint produces exactly **one** call plus the descriptive error rather than nine timeouts. Suite: 1004 passed.
- **Three theories now tested and falsified against the logs** — range width (v1.1.146), transport replay (v1.1.147), and date parameters (this probe). Each was disproved by evidence rather than argument, which only became possible when E*Trade calls gained visibility in v1.1.144; before that this failure was silent for months.

## [1.1.147] — 2026-09-01

### fix — the transactions endpoint is slow per call; v1.1.146's premise was wrong
- **v1.1.146 assumed the 120 s stall came from the 8-month query span and sliced the range to fix it. The next run disproved that**: a **31-day** slice aborted at 30,003 ms. Narrowing the range does not speed this endpoint up — and v1.1.146's own 30 s timeout then *guaranteed* failure on an endpoint already observed taking 120 s, making the symptom deterministic.
- **What is actually true**: the endpoint is slow per call regardless of range (120,250 ms YTD, >30 s for 31 days), while every other E*Trade call in the same sessions finished in ~300 ms — which is what the default timeout was tuned to.
- **`ETRADE_SLOW_TIMEOUT_MS` (180 s), applied per call.** `etradeGet` takes an optional `timeoutMs`; the transactions call passes the slow budget, everything else keeps the 30 s default.
- **Single re-sign retry on `oauth_problem=nonce_used`.** The nonce is baked into the Authorization header at signing time, so a transport retransmission replays it and E*Trade rejects the duplicate; the app sends each request once (verified in the API log), so re-signing is the only recovery. Exactly one retry so a genuinely repeated nonce cannot loop, and scoped to `nonce_used` only — a `token_rejected` 401 is a dead token that re-signing would not fix.
- **Slicing kept, rationale corrected in the code**: it bounds each response and its pagination so one oversized window cannot swallow the import and a failure localises to a month — it is not the stall fix.
- Regression: `etrade-api-logging.test.ts` +4 (11) — one retry with a *different* Authorization header, no loop on repeated nonce_used, no retry on token_rejected, per-call timeout reaches `AbortSignal.timeout`; `etrade-transactions-slicing.test.ts` +1 (4) — transactions gets the slow budget. Suite: 1002 passed.

## [1.1.145] — 2026-09-01

### fix — E*Trade log masked `/v1/accounts/list` as if it were an account key
- v1.1.144's `maskEndpoint` replaced any segment after `/accounts/` with `{acct}`, so the account-LIST call logged identically to an account-scoped one. **`list` is a literal endpoint, not an identifier**, and that distinction is exactly what tells you which sync path ran — the first real use of the new logging needed it and had to infer it from call pairing instead.
- Now preserved verbatim; every genuine account key is still masked. Regression: `tests/etrade-api-logging.test.ts` +1 (7 total). Suite: 994 passed.
- **First diagnosis from the new logging (v1.1.144)**: 28 E*Trade entries captured, all 200 — and **no `/transactions` call in any log file, ever**. The closed-position import had never been triggered: the control is `↓ Import Closed (YTD)` and renders **only on the Portfolio view's Closed tab**. There is no button named "Sync Closed Positions" — that phrase is the `exit_notes` text the sync writes. The observed calls (`/v1/accounts/list` + `/v1/accounts/{acct}/portfolio`) are the regular position sync.

## [1.1.144] — 2026-09-01

### feat — log E*Trade API calls; the provider was completely dark
- **`logs/api/` has instrumented Polygon since the logger existed; E*Trade wrote nothing.** Measured 2026-09-01: **17,200 Polygon entries, zero E*Trade**, and `logs/errors/` empty. Every E*Trade failure was invisible after the fact.
- **This blocked a real diagnosis.** `insertClosedPosition` always writes an `exit_price` and **no row in the DB has one**, so **Sync Closed Positions has never inserted a record** — the failure is upstream at the fetch or the transaction match, and with no log there was no way to tell which, or even whether the request was made. That sync is what replaces estimated marks with real fills: without it the wheel book's realized P&L is inference, and the stored figures are out by **$4,954** against a hand reconstruction (a −$3,736 assignment booked as a loss when it was a conversion into stock; a covered call booked at −$463 when it expired worthless with TSLA at 348.75 vs a 360 strike).
- **`etradeGet` — the single choke point for E*Trade calls — now logs every outcome** with `provider: 'etrade'`: success (status/latency/size); non-2xx (plus `errorMessage` and a 300-char `responseBodyPreview` carrying E*Trade's own error envelope); and **network fault** (`responseStatus: null` + thrown message) — a dormant token can terminate the stream instead of returning 401 (CLAUDE.md), which previously left no trace at all.
- **Three deliberate safety properties.** (1) **Success bodies are never written to disk** — they carry positions, balances and quotes, and the log is plaintext with 30-day retention; only *failure* bodies are previewed. (2) **The account key is masked** — `/v1/accounts/{accountIdKey}/transactions` logs as `/v1/accounts/{acct}/transactions`, preserving the call's shape but not the brokerage identifier. (3) **Logging can never break an API call** — all four sites go through a `safeLog` wrapper that swallows logger exceptions, because the logger touches the filesystem and Electron's userData path and a disk error would otherwise turn every E*Trade request into a hard failure, trading the blind spot for something strictly worse.
- Only the caller's query params are logged (scrubbed via the existing `scrubObject`); the OAuth Authorization header is never included. `ApiLogEntry` gains optional `errorMessage` / `responseBodyPreview`; the Polygon path is untouched.
- Regression: new `tests/etrade-api-logging.test.ts` (6) — success logged without the body, account key masked, provider error envelope captured on a 400, network fault recorded with a null status, real params preserved while credentials and the OAuth header never appear, and **a throwing logger does not break the call**. The leak assertion uses distinctive canary credentials: short values like `'at'` collide with ordinary JSON keys (`"responseStatus"` contains "at"). Suite: 993 passed.
- **What this unblocks**: the next Sync Closed Positions run will either show the E*Trade transactions call in `logs/api/api_<date>.jsonl` or show it was never made. The three candidate fixes (missing `withRenew` on the portfolio path, a rejected request, or the open/close transaction matcher) are mutually exclusive — the log decides which one to make.

Docs: `.ai/AI_CONTEXT.md` §10, `CLAUDE.md`.

## [1.1.143] — 2026-09-01

### Validation — regime detection explored, NOT viable on current data
No code change. Follow-up to v1.1.142, which closed by pointing at regime detection as the next lever; it was explored immediately and does not work.
- **Different question from the rejected v0.32.90 gate** (which asked *should I enter in this regime*): does an entry-time regime feature predict **whether a 21d hold beats a 5d hold**? Four no-lookahead features against the same 125-date replay. Naive results looked strong — `ret20` r=0.582 t=7.94, `distSma50` r=0.323 t=3.79 — but **the t-stats are meaningless**: 125 dates with overlapping 21-day forward windows and near-identical adjacent features means an effective sample of **~6**, not 125.
- **Counterexample visible without statistics**: April `distSma50` +2.56% → outcome **+6.60%**; June `distSma50` +2.75% → outcome **−6.98%**. Near-identical regime, opposite result — any SMA-distance rule must call them the same and be wrong on one.
- **Leave-one-month-out**: `ret20` 4/6, `distSma50` 3/6 (coin flip). 4/6 is not evidence — 3 is chance, 4 occurs ~34% of the time at random — and both `ret20` misses are Feb/Mar in the same direction. The existing binary gate is flat: SPY>SMA50 → +1.17% vs SPY<SMA50 → +0.65%.
- **Structural, not a tuning problem.** Whether 21d beats 5d depends on the market trending over the *following* 21 days, so an entry-time feature only helps if trend persists — `ret20` is a momentum proxy in the same family as the feature that already inverted on full-year data in v0.32.90. Six observations of a monthly-cadence phenomenon cannot support a rule at any effort level.
- **Would need ~3+ years of replay** (36+ monthly observations); `historical_prices` starts 2024-05-31 for most tickers and `iv_history` is shorter. **Disposition: do not build.** Re-open only if the panel reaches 3+ years AND the feature is pre-registered before outcomes are inspected.

Docs: `Requirements/v2-execution/06-seykota-risk-extensions.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.142] — 2026-09-01

### Validation — hold-period (`hold_days`) sweep REJECTED: the effect is regime, not edge
No code change. Recording a null finding so it is not re-litigated.
- **The hypothesis** came out of the 2026-08-28 hand-run P&L study: brief picks looked positive over ~5 days and negative over ~27, in two seemingly independent tests. Brief Replay stores `ret_5d` / `ret_10d` / `ret_21d` per pick, so the sweep needed no new machinery.
- **A one-month preliminary read (June 2026) looked decisive and was wrong.** It showed monotone decay (median alpha +2.27 → +2.28 → +4.19 for income, −1.04 → −13.52 for buy) and I reported it as a clear strategy-dependent result. On six months both strategies **reverse**: income decays (−0.08 → −0.28 → −1.30) and buy improves (+0.79 → +0.91 → **+2.38**). June was also computed on pre-repair prices. Single-month over-fit, the same trap as the SPY-regime gate and the overbought guard.
- **Six-month replay** (2026-02-02…2026-07-31, 125 trading days, **3,189 picks**, run on split/ticker-reuse-repaired data): paired per-pick test of `alpha(5d) − alpha(21d)` gives **−1.01%, t = −3.18** — significant, and with the **wrong sign**: holding 21 days beat holding 5.
- **But the sign flips by month, and every month is individually "significant":** Feb −2.15 (t−4.44) · Mar −0.55 (t−0.96) · Apr −6.66 (t−5.57) · May −5.10 (t−5.18) · Jun **+6.99 (t+13.00)** · Jul +1.16 (t+2.81). **5d beat 21d in 2 of 6 months.** June is the single most extreme pro-short-hold month in the sample — which is exactly the month the preliminary read used.
- **Per-strategy is equally unstable**: wheel +1.52 (t 3.50) and inflection +1.99 (t 2.37) favour short holds; bullish −3.11 (t −3.51) and buy −5.59 (t −6.32) favour long; income is flat (t 0.93).
- **Verdict: `hold_days` stays at 5, unchanged.** Under FR-SEY-5 a lever must be at-worst-neutral on the historical sample; this one is sign-unstable across every slice, so any value fitted to it is fitted to whichever month was sampled. Same disposition as the SPY-regime gate, the overbought guard and FR-SEY-3.
- **What did survive — a structural observation, not a lever.** Mean alpha *rises* with horizon (+0.69 → +1.05 → +1.70) while median *falls* (+0.32 → +0.01 → −1.01). The typical pick decays; a few large winners carry the tail. Feb–Jul 2026 was a semi/memory melt-up (INTC 41→133, MU 322→1214, SNDK 573→2335, all verified as genuine sustained rallies, not data artifacts), so **long holds are a positive-skew bet that pays in a trending regime and bleeds otherwise.** That also explains why the August hand-run study — a single quarter — read the opposite way.

Docs: `Requirements/v2-execution/06-seykota-risk-extensions.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.141] — 2026-09-01

### fix — a reassigned ticker splices two companies into one price series
Third and last bug class in the `historical_prices` integrity thread, after unadjusted splits (v1.1.139) and permanent misclassification (v1.1.140).
- **A symbol can be reassigned to a completely different company** (rename, reverse merger, de-SPAC, delisting then reuse). The stored series splices two unrelated entities and **no re-fetch can repair it** — the provider keys by ticker too and returns the same spliced data, so v1.1.139/140 could only ever mark these `confirmed_real`. Which is what happened: the re-opened verdicts came back `0 repaired, 8 confirmed real`.
- **Volume settles it.** A split rescales share count and settles; a news event spikes then decays; only a *different company* shifts the volume regime permanently. Median volume over 20 bars either side (3-bar buffer to exclude the event-day spike): `BNY "Bank of New York Mellon Corp." 46,254 -> 3,519,645 = 76x` and `SPCX "Space Exploration Technologies" 1,531 -> 82,047,547 = 53,592x`, against six genuine moves at **0.4x-5.0x** (MRNA 5.0, PRIM 2.7, FMC 2.6, CORT 2.0, KD 2.0, CAR 0.4). The 15x threshold sits three times above the largest genuine case.
- **This corrected an earlier wrong call**: MRNA was suspected of being an unadjusted 1:3 reverse split because it stepped 62.96 -> 174.38 and stayed. 46x volume and a 35.7% intraday range say otherwise — a split day has a *normal* intraday range because all four OHLC values are already in the new scale. "Steps and stays" does not imply a split; a permanent repricing on news does the same.
- **`volumeRegimeRatio`** (pure, returns `null` when either side is too thin to judge) + **`isTickerReuse`** (extreme in either direction — reuse can cut volume as well as raise it). **Checked BEFORE any re-fetch**: it saves a pointless API call and is the only one of the three verdicts that isn't a question about price adjustment at all.
- **Truncation, not flagging.** The previous company's bars are deleted from `historical_prices` **and `iv_history`** — every consumer reads those tables directly, so indicators, scoring, backtests and Brief Replay all become correct with no change to any of them. `iv_history` matters as much as prices: it feeds IV rank over a 252-day window and BNY held **246 of 316 rows** on the wrong company.
- Recorded as `status='ticker_reuse'` with the `volume_ratio` evidence; migration 070 rebuilds the table for the extended CHECK + new column (SQLite can't ALTER a CHECK) and re-opens BNY/SPCX so the next run classifies them properly. Run note: `Split scan: N repaired, M confirmed real, K ticker-reuse truncated`.
- Regression: `tests/split-repair.test.ts` 11 -> 14 — the metric separates 76x from 5.0x, declines on thin/zero-volume data, and an end-to-end case truncates the old entity out of both tables **with no API call**. Suite: 987 passed.

Docs: `docs/formulas.md#ticker-reuse`, `Requirements/spec/02-data-model.md`, `.ai/AI_CONTEXT.md` §10, `CLAUDE.md`.

## [1.1.140] — 2026-09-01

### fix — a `confirmed_real` split verdict was permanent, and 3:2 produced false split labels
Follow-up to v1.1.139, from verifying four days of batch output. **v1.1.139's mechanism works**: Aug 28 – Sep 1 ran clean (zero job failures, all slots), **8 tickers repaired** (CRWD, DD, HON×2, KLAC, MNST, MLI, IESC) — CRWD's worst single day fell from **−74% to −20%**, HON from **+95% to 7%** — and the backlog converged to zero flagged by Sep 1.
- **A discontinuity surviving one re-fetch was excluded from detection FOREVER.** Too strong: providers backfill corporate actions late, so a split genuinely absent from the adjusted series today can appear next week, and that row would never be revisited — the failure this module exists to prevent, moved one level up and made invisible. Observed 2026-09-01, all `confirmed_real` and all still wrong: `BNY +1263%`, `SPCX +632%`, `MRNA +177%`, `KD −55%`, `CORT −50%`, `PRIM −50%`, `CAR −48%`, `FMC −47%`. MRNA is the clearest — it stepped 62.96 → 174.38 and **stayed** at 133–158 through Sep 1 (a split steps and stays; a bad print reverts), and `fetched_at` confirms the repair pass did re-fetch it.
- **`CONFIRMED_REAL_TTL_DAYS = 30`**: the verdict is trusted for a month, then the discontinuity falls back into detection. Re-confirming refreshes the TTL, so a genuine crash costs one API call a month rather than one per run. **Migration 069** re-opens the verdicts too large to be real (`|move| ≥ 45%` — the 8 above) so they are re-checked next run instead of waiting out the TTL; deliberately scoped, the 137 verdicts in the −32%…−37% band are left alone.
- **3:2 dropped from `nearestSplitRatio`.** At ±8% tolerance it labelled anything from −28% to −39% a split, which produced every false label in the Aug 28 scan (SRPT, ALGN, ELF, SMCI each fell 32–37% on news; none split). A one-third single-day fall is routine, a halving is not; every remaining candidate implies a move ≥ 46%.
- **The ±8% tolerance stays and must NOT be tightened** — a split day also carries that day's real price move, so the observed ratio is never exact: CRWD's genuine 4:1 printed at **0.2649** vs a theoretical 0.25 (6% off, the stock rose 6% that session). A 3% tolerance would have rejected a true split. The fix for false labels is a safer candidate *set*, not a narrower band. Now an exported `SPLIT_RATIO_TOLERANCE` so the reasoning has somewhere to live. The label is descriptive only — it never drives a repair decision.
- **Also fixed a date-fragile test**: `earnings-refresh-tickers.test.ts` computed fixtures as `now + N days` ignoring weekday. On 2026-09-01 `iso(18)` landed on Saturday, the service correctly applied its documented Saturday→Friday shift (E*Trade returns UTC, so a Saturday-UTC date is a Friday-ET report), and the assertion failed against an unshifted expectation. Production behaviour was correct; the helper now snaps to weekdays.
- **Verification of the rest of the batch**: **earnings calendar 100/100 exact** — ground truth over 2026-09-01…10-16 (663 entries, under the 1500 cap so untruncated) against all 100 constituents reporting inside the 45-day window: **0 late, 0 early, 0 missing** (was 50 exact / 19 early on 2026-08-28; v1.1.137's bounded later-move cleared them). Far-dated poison rows **0**. All key tables current to 2026-09-01; 1123/1136 tickers have today's bar, the 13 stale ones looking like delistings/M&A.
- Regression: `tests/split-repair.test.ts` 8 → 11 (a one-third fall is not labelled a split; a real split skewed by the day's move still matches; an expired verdict is re-verified and repaired). Suite: 984 passed.

Docs: `docs/formulas.md#split-adjustment`, `Requirements/spec/02-data-model.md`, `.ai/AI_CONTEXT.md` §10, `CLAUDE.md`.

## [1.1.139] — 2026-08-28

### fix — `historical_prices` carried unadjusted stock splits
- **Polygon is fetched with `adjusted=true`, so every response is correct *as of that fetch*. The corruption was incremental storage**: `price-gap-fill` re-fetches only a ~3-day window and never revisits older bars, so when a split happens later the pre-split bars keep their old prices while new bars arrive post-split — a permanent step in the middle of the series.
- **Found while marking a quarter of brief picks to market**: CRWD fell **74% in one day** (2026-06-29, 4:1 split) and manufactured a fake $43k loss. Scanning 1,136 tickers over 400 days found **153 discontinuities across 126 tickers**, 35 at a simple split ratio — `DD +203% (1:3)`, `MRNA +177% (1:3)`, `HON +95% (1:2)`, `CRWD −74% (4:1)`, `IESC −53% (2:1)`, `MNST −52% (2:1)`. SPY's largest genuine daily move over the same quarter was **2.58%**.
- **Not cosmetic**: any indicator spanning such a date is wrong — SMA/RSI/ADX, `volume_surge`, breakout detection, relative strength, the backtest engine, and **Brief Replay**, the tool FR-SEY-5 requires to validate every trade-logic change.
- **New `split-repair.ts`**: `detectDiscontinuities` (pure) flags `|close/prev − 1| > 0.25`; `detectAndRepairSplits` re-fetches the flagged ticker's whole stored range (bounded 800d) through the existing `fetchAndStorePrices`, which `INSERT OR REPLACE`s a series adjusted to today — one pass fixes every bar. **Idempotent by construction**: re-fetching a ticker that did not split rewrites identical bars, so a false positive costs one API call and nothing else. The threshold is deliberately asymmetric — a false positive is cheap, a false negative silently corrupts every indicator spanning that date.
- **Genuine moves are classified, not re-fetched forever**: a jump surviving the re-fetch (earnings collapse, buyout) is recorded `confirmed_real` in the new `price_split_repairs` table (migration 068) and skipped thereafter. 118 of the 153 flagged don't match a simple split ratio and settle out this way.
- Detection reads only stored data — **no new provider API surface**, `DataProvider` stays the sole market-data seam.
- **Wired as a second pass in `daily-price-gap-fill`** (which already owns `historical_prices` freshness), after the gap fill so it scans the freshest bars. Never fails the job — a stale-but-present history beats a halted chain. Outcome in the run notes: `Split scan: N repaired, M confirmed real`. Chain order makes it propagate for free: price-gap-fill (seq 6) runs before daily-technical-signals (seq 7), so signals recompute off repaired prices the same run. `maxRepairs` = 40/run bounds API usage; the current 126-ticker backlog clears in ~2 days across the two daily slots.
- Regression: new `tests/split-repair.test.ts` (8) — split and reverse-split detected, ±17% volatility not flagged, zero-close guarded, repair records `repaired`, a surviving jump records `confirmed_real` and is **not** re-fetched next run, clean series makes no API call. Suite: 981 passed.
- **The corrupt bars already in the DB are repaired by running the job** — the Polygon key is encrypted at rest (`enc:`, Electron `safeStorage`), so the repair can only run inside the app, not from a script.

Docs: `docs/formulas.md#split-adjustment`, `Requirements/spec/02-data-model.md`, `Requirements/spec/20-batch-jobs.md`, `.ai/AI_CONTEXT.md` §10, `CLAUDE.md`.

## [1.1.138] — 2026-08-28

### fix — the brief's earnings net was inert in both directions
- **The Daily Brief's last-line-of-defense earnings check for its picks did nothing**, for two independent reasons, either one sufficient. (1) `refreshTickers` skipped **any** stored future date as "still valid" — but a date wrong in the FAR direction is exactly what silently disables the −20 penalty (NVDA held a bogus `2026-11-17` against a true `2026-08-26`, so the net skipped it as valid on the day it reported; the Aug-26 run recorded `{"updated":0,"skipped":53,"failed":3}` — 53 skips, zero verifications). (2) It ran **after** pick selection, so even a correct finding could not remove a pick.
- **`refreshTickers` now verifies what claims to be safe.** Asymmetric skip rule mirroring the sweep's write policy: a stored date **inside** `TRUST_STORED_WITHIN_DAYS` (60) is trusted — the gate is already engaged, re-checking cannot change the outcome, and an error there is fail-safe. Everything else is confirmed against E*Trade: no row, a past row, or a date **beyond** the horizon, which is precisely the value claiming there is no earnings risk. 60 is deliberately wider than the 45-day penalty window, so every date inside that window is trusted and every date outside it is checked.
- **Manual entries are now never overwritten, `force` included** — `force=true` previously skipped the whole guard block, manual check with it, contradicting the documented contract.
- **The net moved ahead of pick selection.** A Stage-3 verification pass confirms the provisional top-`STAGE4_POOL_SIZE` candidates for income/wheel/bearish against E*Trade (an independent source from the Finnhub-derived calendar), then re-applies the penalty to anything newly revealed and re-sorts — before the Stage-4 pool is locked. Penalty application is now a closure tracking `(strategy, ticker)` pairs so the second pass cannot double-penalise. Recorded in `run_meta.earningsVerify`. Typically ~20 E*Trade calls, against a Stage 4 that already makes one chain call per candidate.
- **Had this been in place**: NVDA's `2026-11-17` was 83 days out — beyond the 60-day trust horizon — so it would have been sent to E*Trade, come back `2026-08-26`, taken the −20 in the second pass, dropped 73.3 → 53.3 (below the other wheel picks at 63.6–64.3), and not appeared.
- The old Stage-5b call stays for buy/bullish/inflection picks, where it was never a gate — it feeds the critic and the v2 entry gate complete calendar data. Its comment now says so instead of implying it protects anything.
- **Validation (FR-SEY-5)**: no threshold or rule changed — the 45-day window, −20 magnitude and penalty-bearing strategy set are untouched; this restores the gate's *input data* on the path that selects picks. Per v1.1.137, a replay cannot validate this area (`earnings_calendar` keeps one row per ticker, overwritten in place). The gate becomes strictly **more** conservative — it can only add penalties the stored calendar missed, never remove one — the opposite direction from v1.1.137.
- Regression: new `tests/earnings-refresh-tickers.test.ts` (6). Suite: 973 passed.

Docs: `Requirements/spec/17-earnings-calendar.md`, `Requirements/spec/14-daily-brief-and-critic.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.137] — 2026-08-28

### fix — let a complete sweep absorb a small scheduled-date slip
- **v1.1.136 forbade the sweep from ever pushing a stored earnings date further out.** Right for a ~90-day jump (a Finnhub coverage gap hiding the near date and returning the following quarter — the NVDA failure), wrong for an issuer refining a scheduled date by a day or two.
- **Measured against ground truth right after the v1.1.136 run** (a narrow 45-day Finnhub window — 585 entries, far under the 1500 cap, so untruncatable), across the 69 constituents reporting within 45 days: **50 exact · 0 stored later than truth · 19 stored earlier · 0 missing.** Zero late rows confirms v1.1.136 worked. But the 19 early rows were 1–8 days stale (ACN, SAIL by 8) and every one had been written in **June or July** — the sweep kept seeing the corrected date, kept refusing it as a later move, and the row stayed frozen until Phase 2 eventually refetched it.
- **A complete sweep may now move a date later by at most `MAX_LATER_SLIP_DAYS` (14).** Beyond that still refused; any later move from an *incomplete* sweep still refused; moving a date **nearer** stays unbounded (fail-safe, and what heals poisoned rows). 14d sits well above a typical one-or-two-day refinement and far below the ~90-day coverage-gap leap.
- An early date was never a risk — it makes the −20 penalty engage sooner, never later — just imprecise, excluding a name from wheel/income for up to a week longer than warranted.
- **Validation (FR-SEY-5)**: no threshold or rule changed — the 45-day window and −20 magnitude are untouched; this moves the gate's *input data* toward ground truth. A replay delta is **impossible** here, not just unhelpful: `earnings_calendar` stores only each ticker's NEXT date, overwritten in place, so no past calendar state can be reconstructed — both arms would re-read today's corrected dates. Noted honestly: this makes the gate marginally *less* conservative in one direction, which is the intended correction (names were being penalised on dates the issuer had already moved).
- Regression: `tests/earnings-refresh-job.test.ts` +4 (small slip accepted; quarter jump refused; boundary+1 refused; nearer-move still unbounded). Suite: 967 passed.

Docs: `Requirements/spec/17-earnings-calendar.md`, `.ai/AI_CONTEXT.md` §10, `CLAUDE.md`.

## [1.1.136] — 2026-08-28

### fix — near-term earnings dates were truncated away by Finnhub's bulk result cap
- **The 2026-08-26 brief ranked NVDA the #1 wheel pick (73.3) and a top-5 income pick (42.4) on the day NVDA reported (2026-08-26 AMC)**, and wheel #2 (66.3) the day before. Both strategies carry the −20 earnings-within-45d penalty; with it, NVDA scores 53.3 / 22.4 and drops off both lists (other Aug-26 wheel picks: 63.6–64.3). NVDA's `earnings_calendar` row read **2026-11-17** — one full quarter late. Confirmed locally: +6.3% gap on 08-27 (209.66 → 227.98) on 294M shares vs ~100M, ATM IV 41.5% → 33.2%.
- **Root cause: Finnhub's free-tier bulk calendar caps at 1500 entries and truncates from the FRONT.** Verified against the live API — the exact call the job made on 2026-08-25 (`from=2026-08-25&to=2026-11-23`) returned 1500 entries spanning **only 2026-11-09 … 11-23**. The near-term half of every requested window was silently dropped, so the bulk phase could only ever write far dates. The v1.1.75 nearest-wins guard was powerless: the near date was never in the payload.
- **And the correction was suppressed by the fix's own side effect.** Phase 2's per-ticker lookup has the right answer (`NVDA → [2026-11-17, 2026-08-26]`, nearest kept) but the delta filter only selected tickers with **no row or a past date** — the freshly-poisoned row held a *future* date, so the ticker was skipped until the bogus date passed. The brief's own `refreshTickers` net shares the identical assumption (Aug-26 run: `{"updated":0,"skipped":53,"failed":3}`) and runs *after* Stage 3 scoring anyway.
- **Adaptive sweep** (`sweepBulkWindow`) replaces the two fixed 90-day windows: a response *at* the cap is treated as evidence of truncation and the window is recursively halved until every slice fits under it. Peak season needs ~5-day slices (`2026-10-27…10-31` = 639 entries, but `…11-05` overflows), so a fixed chunk size would not have sufficed. The sweep is reduced to the nearest date per ticker in one pass, so slice order cannot matter.
- **Bulk data may now only move a stored future date NEARER, never further out.** Finnhub's bulk has coverage gaps, and a gap hiding a near date while returning the following quarter would push the stored date out — reintroducing this bug. Nearer is fail-safe and is also what heals poisoned rows (poison always reads too FAR); a genuinely delayed report is caught by Phase 2 once the stored date goes stale.
- **Phase 2 now re-verifies rows dated beyond the 180d sweep horizon** — the truncation signature, and beyond what the sweep can correct.
- **`earnings-refresh` now runs BEFORE `daily-intelligence-brief`.** It was registered after it, so every brief scored its −20 penalty against a calendar refreshed at the *end* of the previous chain — one cycle stale even when correct. Migration 067 reorders existing installs; `after_close_only` stays 1 (the sweep is too many calls for the lean intraday slot, and a <24h calendar is fine for slow-moving dates).
- **Backfill: every non-manual row beyond +120d was re-verified — 14 of 14 were poisoned**, each exactly one quarter late (AFRM, AIT, CACI, CAH, CPAY, EL, FN, IREN, JKHY, MSGS, RMD, SMCI, UI, VIAV). AFRM was an income pick in the 08-27 brief. None had reached the 45-day window yet, so no further brief was mis-scored — but all 14 would have crossed into it still reading a quarter late. Migration 067 deletes any remaining far-dated non-manual rows so the next run re-verifies them.
- **Validation (FR-SEY-5)**: not a scoring-behavior change — no weight, policy parameter, or gate rule is altered. This restores the penalty's *input data* so an already-validated gate fires when it always should have.
- Regression: `tests/earnings-refresh-job.test.ts` +2 (mocked cap with front-truncation; poisoned far-future row re-verified). Suite: 963 passed.

Docs: `Requirements/spec/17-earnings-calendar.md`, `Requirements/spec/20-batch-jobs.md`, `.ai/AI_CONTEXT.md` §10, `CLAUDE.md` Known quirks.

## [1.1.135] — 2026-08-07

### Validation — cutting `optionLiquidity`'s weight shows NO measurable benefit
- **Weight sweep added to `scripts/fr-income-liquidity-realized-ab.mjs`** (section C): vary `optionLiquidity`'s composite weight rather than its formula — the direct test of v1.1.133's "liquidity is a gate, not a ranking signal" conclusion. Weight 0 is equivalent to `enabled: false` (the signal leaves numerator *and* denominator, so the rest renormalise to 100). Legacy formula throughout, since that is the shipped path. Top-5 per date over 16 dates, outcomes settled at intrinsic:

  | weight | assigned | mean return on capital | picks changed vs w=13 |
  | --- | --- | --- | --- |
  | **13** (current) | 60.0% | **−2.92%** | (baseline) |
  | 9 | 61.3% | −3.20% | 11/16 dates |
  | 6 | 67.5% | −3.56% | 14/16 dates |
  | 3 | 62.5% | −3.49% | 15/16 dates |
  | **0** (disabled) | 57.5% | **−2.77%** | 16/16 dates |

- **The sweep is non-monotone, so it is noise, not signal.** Disabling entirely is nominally best (+0.15 pts vs baseline) but the intermediate weights are *worse than both endpoints*, swinging 0.79 pts across the middle. On ~80 trades per arm from a single regime, a real effect would be monotone. **Cutting the weight cannot be shown to help.**
- **Correction to v1.1.133.** That entry named "reduce or remove `optionLiquidity`'s composite weight" as the indicated follow-up. It was an inference from the signal being anti-predictive, and the direct test does not support it. The mechanism finding stands (liquidity tracks realized vol, and belongs as a gate); the prediction that acting on it would improve outcomes does not. At 13 of 100 the signal is dominated by ivRank 30 + premiumRiskRatio 22 + recentVolatility 20 = 72, so its weight barely moves the ranking either way — it changes *which* names are picked (11–16 of 16 dates) without changing *how they do*.

### Applied as operator config — live DB only, baseline untouched
- **`optionLiquidity` is now `enabled: false` on wheel and income in this install's `scoring_strategy_configs`**, at the operator's direction. Enabled weight sums drop to 91 (wheel) / 87 (income) and renormalise to 100. This is a **runtime config change, not a baseline change** — `BASELINE_WHEEL` / `BASELINE_INCOME` in `scoring-service.ts` are untouched, so fresh installs still ship the signal enabled. Same precedent as the 2026-06-23 entry-cap change.
- **The rows now carry `version = 'custom_v1_no_option_liquidity'`, deliberately.** `seedBaselines()` auto-upgrades only rows versioned `baseline_v1`/`baseline_v2`, and its own comment states that customised configs should carry a different version string so they are left alone. Leaving them on `baseline_v3` would mean a future `baseline_v4` upgrade path silently reverts this — the same silent-config-divergence trap that bit the batch-job `config_json` allowlists twice (v1.1.121, v1.1.123). **Trade-off: these two strategies will no longer receive future baseline weight updates automatically.**
- **Rollback:** ⚖ Trade Scoring → Reset to Baseline (per strategy). Pre-change state, for the record: wheel `ivRank:22 premiumYield:19 fundamentalScore:17 technicalNeutral:11 notDowntrend:8 recentVolatility:10 optionLiquidity:9 leverageQuality:4` · income `ivRank:30 premiumRiskRatio:22 recentVolatility:20 trendNeutral:15 optionLiquidity:13`, both `baseline_v3`.
- **Liquidity is still enforced as a gate**, which is the whole point: the brief's `hasAdequateLiquidity` structure gate and the v2 engine's `liquidityScore ≥ 8` in `EntryPolicy` are unaffected. Only its role as a *ranking* input is removed.

Docs: `Requirements/spec/13-scoring-engine.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.134] — 2026-08-07

### Validation (no behavior change) — Wheel (Vetted) thresholds reviewed, NO change
- **The deferred post-Q2 threshold review is done: nothing needs tuning.** The count recovered from **~4 (2026-07-02) to 73 (2026-08-07)** — 58 stocks + 15 ETFs — on unchanged thresholds, confirming the July thinness was a seasonal earnings artifact rather than a threshold problem.
- **Gate margins on the clean read say leave it alone.** Among the 58 **stock** survivors: annualized ≥15% has **zero** within 10% of the bar (min 16.5%); OI ≥250 has **one** (median 1,682); IV ≤80% has three (median 36.8%). The gates actually doing work are suitability ≥75 (by design — it is the quality bar) and spread ≤15% (median 8.3%). Loosening the premium or liquidity floors would not add names; they are not what is binding.
- **The 15 sub-threshold survivors are all ETFs**, on the documented ETF path (`minAnnualizedReturnEtf: 8`, suitability bypassed since ETFs carry no fundamentals). Verified rather than assumed — a suitability of 4 (IWM) or an 8.6% yield (SPY) looks like a leak until you check the ticker type.
- **New finding — the swing is a QUARTERLY CYCLE, not a one-off, and it recurs worse in six weeks.** The earnings gate drops any name reporting on/before the target monthly expiry, and the target is the nearest 3rd Friday ≥25 DTE. Four times a year that window lands on an earnings season. Measured share of the S&P 500 + Russell 1000 excluded by the earnings gate alone:

  | as-of | target expiry | excluded |
  | --- | --- | --- |
  | 2026-08-07 | 2026-09-18 | 16% |
  | 2026-08-21 | 2026-09-18 | **7%** |
  | 2026-09-18 | 2026-10-16 | **6%** |
  | 2026-09-25 | 2026-11-20 | **80%** |
  | 2026-10-16 | 2026-11-20 | 75% |
  | 2026-11-06 | 2026-12-18 | 3% |

  So 2026-07-02's ~4 and today's 73 are the same gates at opposite ends of one cycle, and the **next squeeze is due ~2026-09-25 → 2026-10-23** at roughly 80% excluded — more severe than July's. The list self-heals both times. Do not tune against either extreme: loosening during a trough balloons the list once earnings clear (the same "don't re-engineer on a regime-specific sample" lesson as the scoring-replay work).
- **Correction recorded:** `earnings_calendar` stores only each ticker's **next** report date (nearest-wins, v1.1.75), so it cannot be used to reconstruct a past run's exclusion count — an initial attempt to compute what the 2026-07-02 run faced was invalid and discarded. Far-horizon projections in the table above are a floor for the same reason.

Docs: `Requirements/spec/05-screener-and-filters.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.133] — 2026-08-07

### Validation (no behavior change) — `WHEEL_GRADED_LIQUIDITY` enabling REJECTED
- **New `scripts/fr-income-liquidity-realized-ab.mjs`** — the realized-outcome A/B that v1.1.131 was waiting on, run on **income** rows because they are the only ones carrying the liquidity inputs (all 22,302 income rows have bid/ask/OI; all 21,127 wheel rows are NULL — see v1.1.132). The income composite is fully reconstructible point-in-time (`ivRank` 30 ← stored `iv_rank`, `premiumRiskRatio` 22 ← stored `annualized_return`, `recentVolatility` 20 ← 20-day realized vol from `historical_prices`, `trendNeutral` 15 ← permanently null as in live, `optionLiquidity` 13 ← recomputed from stored bid/ask/OI under both schemes). Outcomes settle at intrinsic: `premium − max(0, strike − close@expiry)`, as % of strike. **6,777 settled CSPs, 937 tickers, 16 dates.**
- **Result: enabling the graded scheme makes realized outcomes WORSE, not better.** Top-5 per date by full composite: legacy 60.0% assigned / **−2.92%** mean return on capital; graded 71.3% assigned / **−4.80%**. **Δ −1.88 pts per trade**, holding at −1.33 at top-10. The flag stays **off**, and this is now a rejection rather than a pending item.
- **The deeper finding — liquidity does not predict outcomes at all.** Spearman(score, realized return) is **−0.015 legacy / +0.032 graded**: no relationship either way. Worse, the graded score is mildly *anti*-predictive by quartile — bottom 25% returns **0.95%** at 14.8% assignment, top 25% returns **0.21%** at 26.6%. The confound is visible in the same table: top-quartile liquidity carries **55% realized vol against 43%** at the bottom, with IV rank flat (~50). Liquidity tracks attention, attention tracks names that move, and names that move breach short puts. Weighting liquidity *positively* in a short-premium ranking composite therefore tilts the book toward exactly the wrong names.
- **What this does and does not overturn.** v1.1.131's calibration was correct on its own terms — the graded formula really is a far better predictor of *execution cost* (Spearman −0.42 → −0.799). Both things are true: it is a better cost model and a worse ranking signal, because **liquidity is an execution-cost property, not an outcome-prediction property.** It answers "can I trade this?", not "should I?". The v2 engine already uses it correctly, as a hard gate (`liquidityScore ≥ 8` in `EntryPolicy`); the category error is carrying it as 13% (income) / 9% (wheel) of a *ranking* composite. The graded formula and flag are kept, since a better-calibrated score makes a better gate.
- **Follow-up recorded, not taken:** the indicated fix is to reduce or remove `optionLiquidity`'s composite weight, not to calibrate it further. That is itself FR-SEY-5-gated and needs its own study.
- **`WHEEL_MONTHLY_FIRST_EXPIRY` is not affected by this finding.** It changes the contract actually recommended, so its benefit is a real fill-cost saving on the trade you would place — a separate mechanism from ranking, and one this study does not measure.

### Caveats on the evidence (printed by the script, repeated here)
- 16 entry dates inside a single 2026-06-15 → 2026-07-08 window — one market regime. The sibling FR-SEY studies used 1,000+ picks over ~1.1 years.
- Income is a *proxy* for wheel: same signal and same `findSuitableChain`, but delta band 0.20–0.35 vs 0.20–0.30 and weight 13 vs 9.
- The volume term (+2 of 10) is floored to 0 in **both** arms — no historical row has volume (migration 066 starts capturing it). Fair between arms, but it caps the graded scheme.
- **The absolute section-B numbers are pessimistic and are not what the live brief produces**: the reconstruction ranks on composite alone, while the live income path also applies the Stage-3 earnings penalty (−20, which strips exactly the earnings runners that blow up a short put), the liquidity hard gate, and the critic. The **delta between arms** is unaffected — both omit the same things.

Docs: `Requirements/spec/13-scoring-engine.md`, `docs/formulas.md#liquidity-score`, `.ai/AI_CONTEXT.md` §10, `Requirements/v2-execution/06-seykota-risk-extensions.md` (rejected-on-data register).

## [1.1.132] — 2026-08-06

### Fixed
- **The wheel path was discarding the liquidity inputs it scores from, emptying three columns of a durable history table for two months.** `analyzeWheel` computes bid/ask/open-interest/volume on the recommended contract, folds them into `optionLiquidityScore`, and then threw them away — `WheelResult` carried no such fields, so `wheelResultToRow` had nothing to write and hardcoded `bid: null, ask: null, openInterest: null`. Every one of the **21,127 wheel rows** in `options_premium_history` (2026-06-15 → 2026-08-05) has NULL bid/ask/open_interest as a result, while all **22,302 income rows** are complete, because `OptionsIncomeResult` did carry them. `WheelResult` now carries `bid`, `ask`, `openInterest` and `volume`, and both mappers persist them.
- **`volume` was captured by nothing at all.** It is the third input to the liquidity score (worth +2 of 10) and no result type carried it, so it could not be recomputed for any historical row of either strategy. Added to `OptionsIncomeResult` and `WheelResult`, plus **migration 066** (`options_premium_history.volume`, nullable).
- **The gap is not backfillable** — the quotes were never stored anywhere — and it is exactly why a retrospective A/B of the liquidity scoring is possible on income rows (**5,797 settled, 969 tickers, 12 dates**, all with bid/ask/OI) but not on wheel rows. Nothing coerces the new columns to 0 when a quote is genuinely absent: a 0 asserts "measured and terrible", which is a different claim (same discipline as `optionLiquidityScore`, v1.1.127). Both properties are pinned by tests.

### Context
- This is the same failure mode as the two preceding fixes — the wheel path repeatedly computed liquidity information and kept only the verdict. **When a signal is added, persist its inputs: a stored verdict cannot be re-validated.**
- Checked while assessing `getPremiumHistoryReadiness()`, which reports **5 of 40 matured days** (43,429 rows, 36 capture dates, 2026-06-15 → 2026-08-05). The 40th capture date lands ~2026-08-11 and must then age 45 days, so that banner will not flip until **~2026-09-25**. That threshold governs return-on-capital analysis, not liquidity validation — the settled sample needed for the latter already exists.

Docs: `Requirements/spec/02-data-model.md` §2.13, `.ai/AI_CONTEXT.md` §8 + §10.

## [1.1.131] — 2026-08-06

### Added (default OFF, FR-SEY-5-gated)
- **`WHEEL_GRADED_LIQUIDITY` — continuous, cliff-free wheel liquidity scoring.** The follow-on to v1.1.130: fixing *which* contract gets measured did not fix how it is *scored*. `optionLiquidityScore`'s three binary gates collapse to a near-constant 0 or 4 because `spread ≤5%` and `volume ≥50` almost never fire — a 5% *relative* bid-ask on a 25-delta put is institutional-grade tight, and per-strike volume ≥50 is rare. Enabled, the score becomes:
  ```
  spread pts (max 4) = 4 × clamp01(1 − (spread% − 5) / 35)    // 5% → 4, 40% → 0; 0 when there is no bid
  OI     pts (max 4) = 4 × clamp01(log10(max(OI, 1)) / 3.3)    // saturates ≈ 2,000 contracts
  volume pts (max 2) = 2 × clamp01(log10(max(vol, 1)) / 2)     // saturates ≈ 100 contracts
  ```
- **Calibrated on real data, not copied.** New `scripts/fr-wheel-liquidity-calibration.mjs` compares candidate schemes over **1,278 real short-put quotes** (0.20–0.30 delta) mined from stored `daily_briefs` structures — all captured during market hours, so the calibration needs no live market and gives a far larger panel than polling chains. Ground truth is what the contract actually costs to trade under the app's own fill model (`options-fill.ts`): `0.5 × half-spread` as a share of the credit collected. Panel medians: OI 74, spread **16.9%**, volume 6, entry cost 4.4% of credit.

  | scheme | distinct values | % scoring 0 | entropy | Spearman(score, cost%) |
  | --- | --- | --- | --- | --- |
  | legacy (binary gates) | 6 | 38% | 0.75 | −0.419 |
  | Strategy-Lab tiers rescaled | 15 | 0% | 0.82 | −0.772 |
  | retuned tiers | 18 | 11% | 0.89 | −0.751 |
  | **continuous (adopted)** | **21** | **2%** | **0.97** | **−0.799** |

  The legacy scheme scores KO — spread 13.9%, volume 39, real entry cost **3.6% of credit** — a flat **0.0/10**.
- **Honest limit of that evidence:** `cost%` is derived from the spread, so any scheme that *grades* spread will beat one that *gates* it on this metric near-tautologically. It shows graded beats binary on the component it measures; it is not independent proof that the OI and volume weights are right, since those price exit optionality and depth that a single-contract entry-cost measure cannot see.
- **Latent bug fixed in the graded branch:** a **no-bid** quote (`bid = 0`) falls into the degenerate-quote path and is handed *full* spread credit — scoring the worst possible liquidity as the best. Legacy behaviour is deliberately left unchanged (it is the shipped default) and pinned by a test. Unreachable via `findSuitableChain`, which filters `bid > 0`, but `wheelOptionLiquidityScore` is exported.
- **Independent of `WHEEL_MONTHLY_FIRST_EXPIRY`** (v1.1.128) — that fixes which contract is measured, this fixes how it is scored; either helps alone and the two are complementary. Both stay off pending realized-outcome validation: the signal carries weight 9 (wheel) / 13 (income), so re-ranking follows, and neither calibration measures trades. Tests: `tests/wheel-graded-liquidity.test.ts` (13).

Docs: `docs/formulas.md#liquidity-score`, `Requirements/spec/13-scoring-engine.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.130] — 2026-08-05

### Added
- **`scripts/fr-wheel-monthly-first-ab.mjs`** — market-hours validation harness for `WHEEL_MONTHLY_FIRST_EXPIRY` (v1.1.128, still default OFF). It implements **both** policies itself and prices them in the **same pass** through the app's API server, so the arms share one instant — an A-now/B-later comparison would be worthless given how strongly time of day moves option liquidity. No app restart, no env var, no DB writes; the app just has to be running. Guards for market-closed (majority `bid = 0`), for early-session runs (per-strike volume accrues through the day, understating the +2 component), and for the score staying near-constant.

### Validation result — flag NOT enabled
- **First live run, 2026-08-05 ~09:53 ET, 39 tickers** (highest IV rank with a resolved chain). The flag does what it was built to do: expiry changed on **34/39 (87%)**, monthly landing **13% → 100%**, median OI **8 → 416**, median spread **50.5% → 23.8%**, `optionLiquidityScore` zeros **79% → 10%**, median score **0 → 4**. `premiumYield` costs little on this sample (median annualized 32.8% → 31.6%, DTE 30 → 44). Estimated wheel composite delta from the two affected signals: **mean +1.92, median +1.79 pts, improved on 27/39**.
- **But the signal still does not discriminate.** Tickers clearing the `≥5/10` suitability gate went **0% → 8%**: the OI component (+4) does all the work while `spread ≤5%` and `volume ≥50` almost never fire, so the score moves from *near-constant 0* to *near-constant 4*. A blue-chip run (AAPL/WMT/PG/DIS/JPM/KO/V/GOOGL) makes it starkest — OI **94 → 2,982**, spread **54.3% → 12.8%**, yet the median score stays **4 → 4**. **WMT with OI 13,824 and a 5.2% spread still scores 4/10, missing the ≤5% gate by 0.2pp.**
- **Conclusion:** fixing *which contract* is measured was necessary but is not sufficient — the remaining defect is threshold calibration (`OI ≥50` / `spread ≤5%` / `volume ≥50`, `docs/formulas.md#liquidity-score`), where the binary 5% relative-spread gate is unreachable for a 25-delta put on essentially any name. The flag stays **off**: FR-SEY-5 asks for realized outcomes, and this harness measures the signal, not trades.

Docs: `docs/formulas.md#liquidity-score`, `Requirements/spec/13-scoring-engine.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.129] — 2026-08-05

### Fixed
- **Analysis mode result types are no longer declared twice.** `BuyResult`, `OptionsIncomeResult`, `WheelResult`, `StrategyResult`, `LizardResult` and the `AnalysisResult` union existed in **both** `src/shared/types.ts` and `src/main/services/analysis-service.ts`, with nothing enforcing that the copies matched — and they had drifted: `currentIv` was present only on the main-process copy. The drift was invisible because `AnalysisAllModesPayload` (in `shared/types.ts`) is built from the **shared** copies while `analysis-service` returns its own structurally-compatible locals, so TypeScript accepted the assignment and the renderer simply never saw `currentIv` on a wheel row — which is why `AnalysisView` hand-rolls its own row types instead of using these. `analysis-service.ts` now imports and re-exports the shared declarations, so every existing `from './analysis-service.js'` import resolves unchanged; `currentIv` was added to the shared `WheelResult`. New fields go in `src/shared/types.ts` only.

### Documented (no behavior change)
- **Brief Replay's blindness to the options-derived signals is now quantified and codified.** Replay has no historical option chains, so `annualizedReturn`, `optionLiquidityScore` and `suitabilityScore` are null for **every** ticker on **every** replay date. Under the scoring engine's FR-SE-03 arithmetic — missing contributes 0 to the numerator but its full weight to the denominator — the signals they feed are a permanent zero at full weight: **wheel loses 28/100** (`premiumYield` 19 + `optionLiquidity` 9, composites built from 72% of live weight) and **income loses 35/100** (`premiumRiskRatio` 22 + `optionLiquidity` 13, 65%). Bullish, bearish, buy and inflection have no options-derived signal and are faithful to live.
  - Ranking *within* a replay run is unaffected — the blind signals are zero for every ticker, so they scale all composites by the same constant.
  - **Replay and live are not on the same scale**, and their wheel/income rankings genuinely differ, because live populates these signals with per-ticker values that vary. No absolute composite threshold may be carried between the two for wheel or income. Bearish's ≥70 gate is unaffected (bearish has no options-based signal).
  - **Replay cannot A/B any of these signals** — toggling one shows a flat zero because it is already null for everyone. The `analysis_snapshots` panel (66 wheel snapshots, 2026-05-14 → 2026-08-03, ~1,029 tickers, real live values) is the instrument for that.
  - Codified as exported `REPLAY_BLIND_SIGNAL_KEYS` and pure `replayWeightCoverage()` in `src/main/services/brief-replay-service.ts`, so a future weight change cannot silently widen the blind spot. Tests: `tests/replay-weight-coverage.test.ts` (7).

Docs: `Requirements/spec/13-scoring-engine.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.128] — 2026-08-05

### Added (default OFF, FR-SEY-5-gated)
- **`WHEEL_MONTHLY_FIRST_EXPIRY` — wheel CSP expiry selection tries 3rd-Friday monthlies first.** Root cause of the `optionLiquidity` signal reading 0/10 across ~94% of the universe, including mega-caps. `findSuitableChain` (`src/main/services/analysis-service.ts`) walks expirations in **ascending date order and returns the first delta-band match** — it never compares candidates — so the earliest qualifying expiry, structurally a **weekly**, always wins. The `[30,45]` DTE window compounds it: consecutive 3rd Fridays are 28–35 days apart, so a 16-day window puts a monthly in range only ~53% of days. From 2026-08-03 the Sep-18 monthly sat at **46 DTE — clipped by one day** — while Sep 4 at 32 DTE won on date order; every row in that 1,029-ticker snapshot landed on Sep 4.
  - At the same ~25 delta the weekly carries **1–2 orders of magnitude less open interest** (2026-08-05, Sep-4 weekly vs Sep-18 monthly): PG **7 vs 4,063** · V 15 vs 802 · DIS 56 vs 2,982 · JPM 65 vs 879 · KO 84 vs 1,702 · WMT **109 vs 13,824** · GOOGL 259 vs 1,757 · AAPL 450 vs 7,668. So the score measures a contract nobody would wheel and charges the **ticker** for it — it cannot separate WMT from a microcap, and contributes its full weight (wheel 9, income 13) as a near-uniform penalty.
  - **Enabled** (`WHEEL_MONTHLY_FIRST=1`): monthlies tried first, window widened `[30,45]` → `[28,52]`. **No extra API calls** — still one chain fetch in the common case, just a different try-order. The widening deliberately does *not* guarantee a monthly is in range (that needs ~35-day width, and a 63-DTE CSP is outside the wheel's premium-selling tenor); coverage goes ~53% → ~82% of days, with the existing weekly fallback on the rest.
  - **Left off** because it changes the recommended CSP itself, so `premiumYield` (wheel weight 19) and Stage-4 pool selection move with it, and it puts a discontinuity in the `options_premium_history` series accumulating since v0.32.94. A clean retrospective A/B is **not possible** — `analysis_snapshots` holds the old measurements and recomputing needs historical chains that were never stored — so validation has to be forward-looking. Same ship-disabled precedent as `ETF_AWARE_WHEEL_SCORING`.
  - **This is not the expiry lever rejected in v1.1.126.** That tested preferring monthlies in `selectExpiration` (Strategy Lab, closest-to-30 in `[20,50]`) for the structures the **engine trades**, and failed because the engine's `liquidityScore ≥ 8` gate already screens thin weeklies out. This is a different code path serving a different purpose: characterising a **ticker for scoring**, not choosing a trade.
  - Pure exported helpers `isMonthlyExpiration()`, `wheelExpirationOrder()`, `wheelDteWindow()`, `wheelMonthlyFirstEnabled()`; `findSuitableChain` takes a `preferMonthly = false` parameter so the options-income caller is bit-identical. Tests: `tests/wheel-monthly-first-expiry.test.ts` (14), including that the default path is unchanged and that the UTC date math survives a ±14h timezone shift.

Docs: `docs/formulas.md#liquidity-score`, `Requirements/spec/06-analysis-engine.md`, `Requirements/spec/13-scoring-engine.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.127] — 2026-08-04

### Fixed
- **Wheel `optionLiquidityScore` no longer reports a fabricated `0` for tickers whose liquidity was never measured.** `analyzeWheel` initialised `liquidityScore = 0` and only raised it when `findSuitableChain` resolved a contract, so any ticker with **no** suitable CSP in the 30–45 DTE / 0.20–0.30 delta window was persisted to `analysis_snapshots` as a hard `0` — indistinguishable from a genuinely illiquid contract. On the 2026-08-03 full-universe snapshot that is **695 of 1,029 rows (68%)**. The same rows also carried a *"Low option liquidity."* explanation asserting a measurement that never ran. The scoring logic is extracted to a pure exported `wheelOptionLiquidityScore(contract | null)` in `src/main/services/analysis-service.ts` which returns `null` when there is no contract to score; `WheelResult.optionLiquidityScore` is now `number | null` (both the `analysis-service.ts` declaration and the dead duplicate in `src/shared/types.ts`), the wheel explanation only claims low liquidity when a chain was actually scored, and the Analysis view renders `—` instead of a false `0/10`. Tests: `tests/wheel-option-liquidity.test.ts` (8).
- **Scope — this deliberately changes no score.** Under the scoring engine's FR-SE-03 arithmetic (`scoring-service.ts`) a missing signal contributes 0 to the numerator **and its full weight to the denominator**, which is exactly what a measured 0 does, so composites, rankings and pick selection are bit-identical. The fix corrects the `missing` flag, the stored snapshot, the explanation text and the UI. It is not FR-SEY-5-gated for that reason, and it was verified that `optionLiquidity` (wheel weight 9, income weight 13) is 5th by weight in both configs, so the critic's `checkCriticalSignalMissing` — which inspects only the top-2 weighted signals — is unaffected too.

### Known issue recorded (not fixed here)
- **Brief Replay is structurally blind to `optionLiquidity`.** `BriefReplayService` sets `optionLiquidityScore` (and `annualizedReturn`, `suitabilityScore`) to `null` for every ticker because replay has no options data. Combined with the arithmetic above, replay scores every ticker as if liquidity were zero while the live path scores it up to 9 (wheel) / 13 (income) points higher for the ~32% of tickers that do resolve a chain. Replay therefore **cannot A/B this signal**, and past wheel/income conclusions drawn from replay inherit a non-uniform deflation. `analysis_snapshots` retains 66 wheel snapshots (2026-05-14 → 2026-08-03, ~1,029 tickers each) with the real live values and is the better panel for validating anything touching it.

Docs: `docs/formulas.md#liquidity-score`, `Requirements/spec/13-scoring-engine.md`, `.ai/AI_CONTEXT.md` §10.

## [1.1.126] — 2026-08-04

### Validation (no behavior change)
- **Expiry-selection lever validated and REJECTED (FR-SEY-5).** `NEW_FRONTIER.md §12` had confirmed that `selectExpiration` (`src/main/services/strategy-lab-service.ts`) picks the [20,50]-DTE expiry closest to 30 with no liquidity awareness, landing on a thin **weekly** ~54% of the time, and flagged this as the largest identified lever on the low critic-pass-rate complaint — pending a realized-P&L A/B once July structures settled. That A/B has now run: **new `scripts/fr-expiry-realized-ab.mjs`**, and the lever **fails on every variant tested**. `selectExpiration` is left unchanged, deliberately; no config knob was added, because a lever with a known-negative expectation is worse than no lever.
  - **Stage 1 (real stored quotes, no model)** reproduces the liquidity gap under a matched `ticker|slug` design with DTE held at 27–33 (871 matched cells / 31 tickers / 29 structure types): execution friction **19.6% of credit on monthlies vs 40.3% on weeklies**, OI/leg **1,569 vs 83**, `liquidityScore` **8.4 vs 4.7**, monthly cheaper on **30/31 tickers**.
  - **But the saving is never actually paid.** Restricted to engine structures that clear the `liquidityScore ≥ 8` gate `EntryPolicy` enforces — the population the engine really trades — friction is **monthly 6.9% vs weekly 6.0%**. The entire 20-point aggregate gap sits inside structures the engine already rejects.
  - **And the monthly's advantage is a 23–33 DTE phenomenon**, exactly where the current rule already selects it: gate-clear rate by bucket is monthly 14–22 DTE **23%** / 23–33 DTE **45%** / 34–44 DTE **20%** / 45–55 DTE **18%**, vs weekly 23–33 DTE **24%**. A monthly pulled away from ~30 DTE — the only case where the rule currently takes a weekly — is *thinner* than the weekly it would replace. The apparent "24% → 51%" deployment gain is an artifact of measuring monthlies only at their best tenor; DTE-weighted it is 28% → 30–31%.
  - **Stage 2 (realized P&L)**: 83 weekly-carrying brief tickers × 213 entry dates = **17,679 paired (ticker, date) cells**, 2025-08-01 → 2026-06-05, short put vertical at 0.30Δ + budget wing (≤$500 max loss), 50% profit target / 200% stop / else expiry, both arms priced by the same Black-Scholes model off `iv_history` ATM IV and settled at real expiry intrinsic so the model bias cancels. Paired vs today's rule: `monthly[23,33]` Δgross −0.09 / Δnet −0.14 pts; `monthly[20,50]` +0.15 / −0.42; `monthly[14,55]` −0.41 / −0.85. DTE-weighted expected pts per candidate: **current 0.533** vs 0.462 / 0.384 / 0.282. The gross tenor effect is noise (flips −2.10 to +2.51 pts month to month) — the DTE shift is neither the win nor the loss; no variant beats doing nothing.
  - **Methodology note worth keeping:** a naive *pooled* weekly-vs-monthly comparison **inverts** the friction result, because monthly-landed rows are dominated by names that carry no weeklies at all, observed at off-30 DTE. Matching on ticker+slug and holding DTE fixed is load-bearing, not cosmetic.

Docs: `Requirements/NEW_FRONTIER.md §12` (full write-up), `Requirements/spec/09-strategy-lab-and-knowledge.md` (rule annotated as deliberately unchanged), `Requirements/v2-execution/06-seykota-risk-extensions.md` (added to the FR-SEY-5 rejected-on-data register), `.ai/AI_CONTEXT.md` §10 + §11.

## [1.1.125] — 2026-07-07

### Changed
- **Filters sidebar template descriptions are now a hover tooltip instead of always-visible body text.** The sidebar's growing template list had pushed past the viewport height, forcing a scrollbar just to see all the cards. Each card now shows icon/label/match-badge only; the explanation lives behind a small "?" icon (hover to read). Extracted the existing `InfoTip` portal-tooltip component out of `PayoffView.tsx` (it was private there) into a shared `src/renderer/src/components/InfoTip.tsx`, used by both `PayoffView.tsx` and `src/renderer/src/views/FiltersView.tsx`. No behavior change to `PayoffView`'s tooltips — pure extraction.

Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.124] — 2026-07-07

### Added
- **Retrospect "In Progress" tab: "Close All" for the Close Signal / Take Profit header badges.** Previously the ⚠/✓ counts spanned every open paper trade across all brief dates, but the tab only ever shows one brief date at a time, so clearing a flagged batch meant switching the date dropdown and closing rows one by one. Each badge now has an adjacent **Close All** button that bulk-closes every open position matching that flag (`recommendation==='close_signal'` or `insight.action==='take_profit'`) in one action, regardless of which brief date is selected, after a confirm dialog stating the count. New `PaperTradingService.closePositions(ids, notes)` (`src/main/services/paper-trading-service.ts`) runs the DB updates in one `withTransaction`, then fires the existing AI-learning-capture call sequentially per closed trade in the background (not in parallel, to avoid bursting the Anthropic API on a large batch). IPC `paper:close-bulk` (`src/main/ipc/ipc-paper-trading.ts`), preload `window.api.paper.closeBulk` (`src/preload/index.ts`). UI in `src/renderer/src/views/RetrospectView.tsx` + `.retro-close-all-btn`/`.retro-alert-badge-group` in `src/renderer/src/styles.css`. Each closed position still auto-fills its exit price from `historical_prices`, same as an individual Close click. Tests: `tests/paper-trading-close-bulk.test.ts`.

Spec: `Requirements/spec/15-retrospect-paper-trading.md`.

## [1.1.123] — 2026-07-07

### Changed
- **Filters Prefill now runs twice a trading day instead of after-close only.** Previously gated `afterCloseOnly` (skipped entirely in the ~10:15 ET lean intraday slot), it now also runs in the lean slot — with a lighter template set — so the summary email/view can surface opportunities same-day instead of only at the ~16:30+ after-close pass. The lean run precomputes `iv_rank_high_vetted` + `wheel_vetted` only (new `DEFAULT_LEAN_PREFILL_TEMPLATES`, override via `config_json.leanEnabledTemplates`); the after-close run is unchanged (`DEFAULT_PREFILL_TEMPLATES`, all 4). The two live-chain templates were deliberately chosen for the lean run because neither depends on a same-day-finalized bar: the liquidity/OI/spread check is a live E*Trade call regardless of time of day, the Wheel-suitability score is fundamentals-only (24h TTL cache, no price input), and the downtrend gate reads whatever `technical_signals.trend_label` the last completed job run wrote (not a same-day partial bar). `rsi_oversold`/`price_alert` stay after-close-only — both read SMA/RSI off `historical_prices`, which does hold a partial same-day bar by 10:15 in the lean slot. Each slot still overwrites its own template rows wholesale (latest-only), so the after-close run always overwrites whatever the lean run wrote earlier that day — the canonical EOD email/view is never left showing morning data. The lean-slot email is now labeled "(Intraday)" in the subject and carries an "Intraday Preview" badge in the body so it isn't mistaken for the EOD version. `src/main/services/jobs/filters-prefill-job.ts`, `src/main/services/filters-prefill-report-builder.ts`, `src/main/index.ts` (drops `afterCloseOnly: true`, adds `leanEnabledTemplates` default config). Tests: `tests/filters-prefill.test.ts` (+8: lean/after-close routing, explicit lean allowlist, manual-run fallback, intraday email tagging).

Spec: `Requirements/spec/05-screener-and-filters.md`, `Requirements/spec/20-batch-jobs.md`, `.ai/AI_CONTEXT.md`.

## [1.1.122] — 2026-07-04

### Fixed
- **Daily Brief Ranked Grid: "Best Structure" cell badges overflowed into the Expiry/Strike/Premium columns.** The Defined-Risk-Alt and L2-Tradeable badges are `<button>` elements built for the card view (where the container is a block-flow layout and each button naturally lands on its own line). In the Ranked Grid's `<td>` they had no wrapping container, so with the table's `white-space: nowrap` and no column width constraint, all three elements (structure link + two alt badges, each several inline spans wide) rendered side by side instead of stacked — ballooning the column and visually bleeding across the columns to its right. Fixed by wrapping the cell's contents in a new `.grid-structure-cell` flex-column container (`max-width: 210px`) and letting the compact alt-badge variants (`.defined-risk-alt--compact`, `.level2-alt--compact`) wrap within it (`max-width: 100%; white-space: normal`). `src/renderer/src/views/DailyBriefView.tsx`, `src/renderer/src/styles.css`. CSS/layout-only — no test changes; full suite re-run clean (909 passed, 1 skipped).

## [1.1.121] — 2026-07-04

### Changed
- **Filters Prefill's default automatic run is now exactly 4 templates: RSI Oversold, IV High (Vetted), Price Alert, Wheel (Vetted).** Plain `IV High` is removed from the default allowlist — it still runs on-demand from the Filters view for browsing the full unscreened list, but it's no longer precomputed automatically now that the vetted version exists and is what the summary email sources from. `src/main/services/jobs/filters-prefill-job.ts`. Test added: `tests/filters-prefill.test.ts` locks in the exact 4-template default.
- **Fixed a real gap this surfaced**: `batch_jobs.config_json` is seeded once via `INSERT OR IGNORE` and never re-seeded on an existing install, so changing `DEFAULT_PREFILL_TEMPLATES` in code has no effect on an install that already ran the job — including the v1.1.120 addition of `iv_rank_high_vetted` itself, which had never actually taken effect on this install (the live config still had the pre-v1.1.120 4-template list). Patched the live `filters-prefill` config row directly to the new default so IV High (Vetted) and the email actually run with real data on the next batch pass.

Spec: `Requirements/spec/05-screener-and-filters.md`, `Requirements/spec/20-batch-jobs.md`, `.ai/AI_CONTEXT.md`.

## [1.1.120] — 2026-07-04

### Added
- **New "IV High (Vetted)" filter template — applies Wheel (Vetted)'s full safety-gate stack to the IV High signal.** Plain `IV High` was a bare `IV Rank > 70` (`> 30` ETFs) threshold with none of Wheel (Vetted)'s protections — no downtrend check, no earnings check, no liquidity check, no vol-bomb ceiling. That was fine for browsing, but not for a curated list an email hands you as "these are worth a look." The new template (mirroring the existing Wheel Opportunity / Wheel (Vetted) pattern) reuses Wheel (Vetted)'s exact pure gate logic — `thirdFridayOnOrAfter`, `pickWheelPut`, `assessWheelPut` — targeting the **ATM (0.50Δ)** option instead of the wheel's 0.30Δ put (this isn't picking a CSP structure, it's a general "can you actually trade this name's options" check) and with **no annualized-yield floor** and **no fundamentals/suitability gate** (IV High serves CSPs, covered calls, and other premium strategies, not just wheel-style ownership). Two-phase funnel: Phase 1 (cheap) applies the same IV-Rank threshold, then free downtrend and earnings-before-expiry gates; survivors are ranked by IV Rank and capped to the top 40 (`IV_HIGH_VETTED_CHAIN_FETCH_CAP`) before Phase 2 spends a live options-chain call per candidate to check open interest ≥ 250, spread ≤ 15%, and exclude IV > 80% vol-bombs. Since this needs the full Phase-1 pool before ranking/capping, it's implemented as a dedicated two-phase runner (`runIvHighVetted`) rather than the generic per-ticker template dispatch every other filter uses. Plain "IV High" is unchanged and still available for browsing the full match list. `src/shared/filter-templates.ts`, `src/main/services/filter-templates-service.ts`, `src/renderer/src/views/FiltersView.tsx`. Tests: `tests/iv-high-vetted.test.ts` (new, 10) covering every gate end to end.
- **Filters Prefill batch job + email now use IV High (Vetted).** The default prefill allowlist grows from 4 to 5 templates (adds IV High (Vetted)), and the summary email's IV High section (added in v1.1.119) is re-sourced from the vetted template — the top 10 shown are now "best of the names that already passed downtrend/earnings/liquidity/vol-bomb screening," not "best of everything, unscreened." The email table also gains OI and Spread columns to show the new liquidity data. `src/main/services/jobs/filters-prefill-job.ts`, `src/main/services/filters-prefill-report-builder.ts`. Tests updated: `tests/filters-prefill.test.ts`, `tests/filters-prefill-report-builder.test.ts`.

Spec: `Requirements/spec/05-screener-and-filters.md`, `Requirements/spec/20-batch-jobs.md`, `.ai/AI_CONTEXT.md`.

## [1.1.119] — 2026-07-03

### Added
- **Filters Prefill batch job now emails a summary, like the Daily Brief.** After the nightly `filters-prefill` run, if email is configured and at least one of IV High / Wheel (Vetted) ran this pass, an HTML email is sent with two lists: **top 10 IV High** picks (ranked by IV Rank descending — a universe=all scan can match hundreds of tickers, so the email is a short actionable list, not the full dump) and **every** Wheel (Vetted) pick (already a small, gated funnel, so not capped), sorted by risk-adjusted return descending to match the Filters view's own default sort. Each row is tagged **ETF** or **Stock**, links the ticker to its E*Trade quote page, and styling matches the Daily Brief email. Empty lists show a clear "no matches today" message rather than an empty table. Email failure never fails the job. New `src/main/services/filters-prefill-report-builder.ts` (`buildFiltersPrefillEmailHtml`, `topIvHigh`, `sortWheelVetted`). `src/main/services/jobs/filters-prefill-job.ts`, `src/main/index.ts` (wires the existing `EmailService`). Tests: `tests/filters-prefill-report-builder.test.ts` (new, 10), `tests/filters-prefill.test.ts` (+4).

## [1.1.118] — 2026-07-03

### Added
- **ETF-aware wheel scoring — implemented, NOT YET ENABLED (pending Brief Replay validation).** Wheel's `fundamentalScore` (weight 17) and `leverageQuality` (weight 4) — 21% of the composite — are structurally inapplicable to ETFs (no P/E, ROE, or traditional debt for a fund wrapper), so under the existing missing-signal rule (FR-SE-03) they're always null for an ETF and always zero-contribute: every ETF's wheel composite is deflated for no reason related to trade quality. Confirmed against the production DB: 56 of 60 curated ETFs have no `fundamentals_cache` row, and 0 of the last 5 daily wheel briefs contained a single ETF pick — ETF wheel candidates are effectively invisible to the brief. New `ETF_AWARE_WHEEL_SCORING` flag (`scoring-service.ts`, default `false`; override `SCORING_ETF_AWARE_WHEEL=1` for a validation run, mirroring the existing `REPLAY_WITH_ADX` pattern) excludes those two signals from both the numerator and denominator for an ETF ticker, renormalizing the rest to 100% instead of zero-contributing them. `TickerSignalData.isEtf` now flows through both the live scoring path and Brief Replay, so the flag can be measured on real ETF wheel outcomes before it ships enabled — this is a trade-logic change (feeds the v2 execution engine's wheel entries) so per this project's FR-SEY-5 rule it needs a Brief Replay improvement, or at least neutrality, first. `src/main/services/scoring-service.ts`, `src/main/services/brief-replay-service.ts`. Tests: `tests/scoring-etf-wheel.test.ts` (new, 6).

### Investigated, no change made
- **Morning-vs-evening liquidity-score bias — insufficient data to confirm.** Hypothesized (in a prior audit pass) that the Strategy Lab's same-day-volume liquidity component reads structurally lower at the ~10:15 intraday brief slot than after close. This is a pre-existing tracked question with its own script (`scripts/fr-liquidity-slot-comparison.mjs`); re-ran it against production: only 1 trading day of data exists so far (the `structure_liquidity_log` instrumentation is new, v1.1.93). The 1,072 paired same-day observations available show the evening slot clearing the tradability bar *more* often than morning (53 vs 34 flips) — the opposite of the hypothesis — and near-identical averages, consistent with single-day noise rather than a real bias. No code change; revisit once ~2–3 weeks have accumulated (see `.ai/AI_CONTEXT.md §11`, `project_expiry_selection_followup` memory).
- **Unvalidated-pick liquidity-gate asymmetry — reviewed, already correct.** `hasAdequateLiquidity()` treats a failed Strategy Lab call differently from a successful one that found no valid structure. On closer read this is not a bug: the human-facing brief shows the unvalidated pick with an explicit info flag telling the reader to check it themselves, while the v2 execution engine's own structure-selection logic (`chosenScore()`) independently excludes any pick with no lab result at all — the engine never trades an unvalidated pick regardless of the brief-side gate's value. No code change.
- **Thin-`iv_history` "double penalty" — reviewed, already appropriately conservative.** A missing top-2-weight signal both deflates the composite and raises a critic warning; the warning only forces an automatic reject when the critic itself degrades (LLM failure), which is intentional (don't trade blind on incomplete data and a skipped adversarial review at once). No code change.

Spec: `Requirements/spec/13-scoring-engine.md` (ETF-aware wheel note + two pre-existing swapped Income/Wheel weight bullets corrected), `Requirements/spec/14-daily-brief-and-critic.md`, `.ai/AI_CONTEXT.md §10, §11`.

## [1.1.117] — 2026-07-03

### Fixed
- **The critic's `checkScoreConcentration` "single-factor thesis" warning could never fire.** It compared `topContrib` (an absolute points value, bounded by that signal's own weight — max ~30 across every baseline strategy config) against a raw `50`, so the condition was structurally unreachable regardless of how concentrated a pick's score was. The check's own description already speaks in share terms ("X of Y composite points"); fixed to compare the actual **share of the composite** (`topContrib / compositeScore`) against the 50% threshold it was meant to enforce. Info-severity and non-gating (the live execution engine accepts both `pass` and `caution` critic verdicts), so this only adds an advisory note to the brief/critic output — it cannot newly reject a trade. `src/main/services/critic-service.ts`. Tests: `tests/critic-service.test.ts` (+4, first-ever coverage of this check).

## [1.1.116] — 2026-07-03

### Fixed
- **Same-day earnings were invisible to the brief's earnings gate.** The Stage-3 −20 composite penalty and the AI Critic's `earnings_in_window`/`earningsKnown` checks compared `report_date` with a strict `>` against today's date, so a ticker reporting **today after the close (`amc`) or at an unknown time** silently read as "no earnings" — no penalty, no warning, hours before an earnings gap. New shared `isEarningsPending(reportDate, reportTime, todayET)` (`earnings-service.ts`) treats a same-day `amc`/unknown report as still pending (penalized/flagged like any other in-window date); only a same-day `bmo` report (already happened before the open) is excluded. `src/main/services/earnings-service.ts`, `src/main/services/jobs/daily-intelligence-brief-job.ts`, `src/main/services/critic-service.ts`. Tests: `tests/earnings-service.test.ts` (new, 5), `tests/critic-service.test.ts` (+3).
- **The critic could run on a stale VIX with no age check.** `getMarketContext()` read `quote_cache`'s VIX row indefinitely — if `refreshVixQuote()` failed for a stretch (e.g. an E*Trade outage over a weekend), the critic kept using a days-old value that no longer described the market (a cached "calm" VIX silently surviving into an actual volatility spike, or vice versa). Now a VIX older than 24h (the refresh runs at the top of every brief, ~18h apart on a normal day) reads as `null` — the pre-existing fail-safe for "never fetched" — rather than stale-but-confident. `src/main/services/critic-service.ts`. Tests: `tests/critic-service.test.ts` (+3).
- **Two of the critic's five trend-conflict checks were silently dead.** `checkTrendAlignment` read a `trendStrength` signal for **wheel** and **buy** picks, but neither strategy's scoring config has that key (it's bullish-only) — `pick.signals['trendStrength']` was always `undefined`, so a wheel pick in a confirmed downtrend or a buy pick lagging on both trend and relative strength never got the designed `trend_strategy_conflict` warning. Fixed to read each strategy's real signal (wheel → `notDowntrend`, buy → `trendAlignment`); bullish/bearish were unaffected and are unchanged. Income's `trendNeutral` branch remains a documented no-op (reads `trendStrengthAdx`, permanently null while ADX is excluded from scoring — a validated, intentional state; no substitute signal exists without re-validating ADX). `src/main/services/critic-service.ts`. Tests: `tests/critic-service.test.ts` (+6, new `checkTrendAlignment` coverage — previously untested).

Spec: `Requirements/spec/14-daily-brief-and-critic.md`, `.ai/AI_CONTEXT.md §10`.

## [1.1.115] — 2026-07-03

### Changed
- **Filters Prefill now precomputes only the filters in regular use** (saves batch time). The nightly job defaulted to all 8 templates; it now runs a configurable **allowlist**, defaulting to the four actually used — **RSI Oversold, IV High, Price Alert, Wheel (Vetted)** — and skips **RSI Overbought, IV Low, Assignment Risk, Wheel Opportunity**. Wheel (Vetted) and Assignment Risk each fetch live option chains per survivor, so dropping Assignment Risk in particular removes a large chunk of E*Trade calls. The allowlist lives in `batch_jobs.config_json.enabledTemplates` (`filters-prefill`), so it's editable without a rebuild; an empty list makes the job skip cleanly. Skipped filters simply aren't pre-populated — clicking one still runs it live on demand. `src/main/services/jobs/filters-prefill-job.ts`, `src/main/index.ts`. Tests extended (`tests/filters-prefill.test.ts`, 12).

## [1.1.114] — 2026-07-03

### Added
- **Filters: "All" universe option.** The universe dropdown now offers **All (S&P + Russell + ETFs)** — the deduplicated union of every list. In an All scan the ETF-vs-stock calibration (ETF-compressed IV thresholds, skipped fundamentals gate, lower vetted-wheel yield floor) is applied **per ticker** from ETF-list membership, so mixing stocks and ETFs in one scan doesn't mis-calibrate either side. ETF rows are labeled `ETF` in the source column context. `src/shared/types.ts`, `src/main/services/constituents-service.ts`, `src/main/services/filter-templates-service.ts`, `src/renderer/src/views/FiltersView.tsx`.
- **Filters Prefill batch job — the Filters screen now opens pre-populated.** A new `filters-prefill` job runs at the very end of the after-close chain (after Market Sync / gap-fill / technical signals / earnings, so every cache it reads is fresh) and precomputes **all 8 filter templates over Universe = All**, storing the latest run per template in a new `filter_template_runs` table (migration 065, shape-versioned like the renderer day-cache — the shared constant is `FILTER_RESULTS_SHAPE_VERSION`). The Filters view loads these on mount: each template card shows a **match-count badge**, and clicking a card shows the freshest cached results instantly — today's manual run or the batch run, whichever is newer — with a muted `batch ran <date time>` stamp (shown indefinitely, so the evening run greets you next morning). **↻ Re-run** still fetches live. A failing template is recorded and the job continues; an aborted run never overwrites a stored run with partial results; the job is `afterCloseOnly` (skipped in the lean ~10:15 slot). Regression tests: `tests/filters-prefill.test.ts` (9 tests). `src/main/services/jobs/filters-prefill-job.ts`, `src/main/ipc/ipc-filters.ts`, `src/preload/index.ts`, `src/main/index.ts`.

## [1.1.113] — 2026-07-02

### Changed
- **Wheel (Vetted): stock annualized-yield floor 20% → 15%.** Reverts to the originally-recommended floor (20% was the user's pick during first calibration). Independent of the current earnings-season thinness: a 20% floor forces selection into only the highest-premium — hence highest-IV, riskiest — names, so 15% admits steadier moderate-premium wheels and *improves* the risk profile (less vol-bomb concentration). ETF floor unchanged (8%). Cache version bumped (5). `src/main/services/filter-templates-service.ts`.

## [1.1.112] — 2026-07-02

### Added
- **Wheel (Vetted) now excludes confirmed downtrends (falling-knife gate).** A gate-comparison against the Daily Brief's wheel model surfaced one missing check: the Brief penalizes selling CSPs on stocks in confirmed downtrends ("assignment at the top of a decline is the wheel's core risk"), but Wheel (Vetted) had no trend awareness. Now names in a **confirmed downtrend** — price < SMA50 < SMA200, i.e. `technical_signals.trend_label = 'Bearish'` (nightly-computed, free DB read) — are excluded before the chain fetch; **uptrend and sideways are both kept** (a flat stock is a fine wheel). Applies to stocks and ETFs; a name with no computed trend passes. The trend is shown in each row's match reason. Cache version bumped (4) so the gate applies on relaunch. Other Brief signals were reviewed and deemed covered or intentionally omitted (RSI/overbought guard — rejected on replay; realized vol — proxied by the IV ceiling). `src/main/services/filter-templates-service.ts`, `src/renderer/src/views/FiltersView.tsx`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.111] — 2026-07-02

### Added
- **Wheel (Vetted) now excludes names with earnings before the target expiry.** The vetted wheel ignored earnings — it targets the ~50-DTE monthly, so a name reporting inside that window (e.g. FCX earnings Jul 21 vs an Aug 21 expiry) would surface a CSP held straight through the earnings gap (the biggest event risk: gap + IV crush, and exactly the "don't sell premium with earnings before expiry" rule). Individual names whose next earnings (from the local `earnings_calendar`) falls on/before the target expiry are now filtered out before the chain fetch. ETFs are exempt (no earnings). Coverage is universe-wide: the daily **Earnings Refresh** batch job populates `earnings_calendar` for every S&P 500 + Russell 1000 constituent via Finnhub, so the gate applies across the whole scan (given the Finnhub key is set and the job has run); the only residual gap is a company that hasn't announced its next date yet. The Filters day-cache version was bumped (3) so the gate takes effect on relaunch rather than showing a stale, pre-gate list. `src/main/services/filter-templates-service.ts`, `src/renderer/src/views/FiltersView.tsx`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.110] — 2026-07-02

### Fixed
- **Filters day-cache is now version-stamped** so a cache written by an older build (different result shape) is discarded instead of rendering new columns as blanks. After v1.1.109 added Expiry/Credit/Spread columns, a cached run from an earlier build lacked those fields → the new columns showed blank until a Re-run. The cache now carries a `CACHE_VERSION`; on read, a mismatch drops the cache (you'll run fresh once). Bump the version whenever the cached metrics/columns change. `src/renderer/src/views/FiltersView.tsx`.

## [1.1.109] — 2026-07-02

### Changed
- **Wheel (Vetted): expiry / credit / spread promoted to columns; Source column dropped.** The match-reason string packed the key trade details; **Expiry**, **Credit** (per-share), and **Spread %** are now sortable columns alongside Score, IV %, Put Strike, Ann %, Risk-Adj %, and OI. The **Source** column (redundant on universe scans — every row just says "Universe") was removed from the Filters results table. To carry a date in a numeric metrics map, `FilterTemplateResult.metrics` was widened to `Record<string, number | string | null>` (string values render as-is and sort lexically — ISO dates sort chronologically). `src/shared/types.ts`, `src/shared/filter-templates.ts`, `src/main/services/filter-templates-service.ts`, `src/renderer/src/views/FiltersView.tsx`.

## [1.1.108] — 2026-07-02

### Changed
- **Filters now remember *each template's* last run separately (was single-last-run).** v1.1.107 cached only the most recent run, so switching templates lost the previous one. The cache is now keyed by template id: clicking a template card shows *its* today-cache instantly (no re-run) or runs fresh if it has none; on return to the view the most recently run template is restored. Each template can be run once and revisited all day; **↻ Re-run** refreshes the active one. Same per-day auto-expiry, renderer-only (`localStorage`). `src/renderer/src/views/FiltersView.tsx`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.107] — 2026-07-02

### Added
- **Filters remember the last run for the day.** Filter results used to live only in component state, so navigating to another screen and back cleared them — you had to re-run every time. The last run (template, source/universe, results, sort) is now cached per day in `localStorage`, so it's restored when you return to Filters (and survives an app restart within the same day); the cache auto-expires the next day. The results header shows when it ran (`· today's run 10:42` when restored, `· ran 10:42` when fresh) and a **↻ Re-run** button refreshes it on demand. Run once, view all day, re-run when you want fresh data. Renderer-only. `src/renderer/src/views/FiltersView.tsx`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.106] — 2026-07-02

### Changed
- **Wheel (Vetted): separate, lower annualized-yield floor for ETFs.** The ETF run returned only 3 names (SMH, SLV, USO) because the 20% yield floor — tuned for high-IV single stocks — excluded the low-IV broad-index/sector ETFs that are the *safest* wheel candidates. ETFs now use `minAnnualizedReturnEtf` (default **8%**) instead of the 20% stock floor, on the rationale that an ETF's much lower risk (no single-name blow-up) makes less premium acceptable and better risk-adjusted. OI / spread / IV-ceiling gates unchanged. Should surface SPY/QQQ/sector ETFs whose ~0.30Δ monthly puts pay ≥ 8% annualized. Regression test +1 (`tests/wheel-vetted.test.ts`, 17 total). `src/main/services/filter-templates-service.ts`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.105] — 2026-07-02

### Added
- **Wheel (Vetted) now supports the ETF universe.** Previously the vetted wheel returned nothing for ETFs (it skipped them because Tier 1 is a fundamentals gate and ETFs have no P/E/ROE/D-E). But ETFs are prime wheel candidates — deep liquidity, standard monthlies, no single-name blow-up risk. Now, for ETFs, the fundamentals gate is skipped (the curated ETF list is wheel-eligible by design) and **IV rank is used as the proxy Score**, while the full **Tier-2 options gate still applies** (monthly ~0.30Δ put, OI ≥ 250, spread ≤ 15%, annualized ≥ 20%, IV ≤ 80%) — mirroring how the loose `wheel_opportunity` template already handles ETFs. Match reason marks these `Vetted (ETF)`. Caveat: the 20% annualized-yield floor means low-IV broad-index ETFs (SPY/QQQ) may not clear the premium bar — higher-IV sector/leveraged ETFs will; the floor can be revisited for ETFs separately. `src/main/services/filter-templates-service.ts`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.104] — 2026-07-02

### Fixed
- **Consistent row-action icons across screens.** The per-row quick-action buttons now use the same icons as the sidebar everywhere: **Analysis 📊 · Validate 🎯 · Options 📉 · Payoff 📐 · Strategy Lab 🔬**. Filters used ✔ for Validate and ⛓ for Options; the Daily Brief was worse — Payoff showed 📊 (the Analysis icon), Validate ✓, Options 📋, Analysis 🔍. Both now match the menu (and the already-correct Opportunity / My Stocks screens). `src/renderer/src/views/FiltersView.tsx`, `src/renderer/src/views/DailyBriefView.tsx`.

## [1.1.103] — 2026-07-02

### Added
- **Wheel (Vetted): risk-adjusted sort + IV ceiling.** Sorting by raw annualized yield front-loads the highest-IV (highest-risk) names — a live run showed the top all carrying 90–130% IV. Two additions: (1) a **Risk-Adj %** column (`annualized × (1 − |delta|)`, discounting yield by assignment probability) that is now the **default sort**, so premium-per-unit-of-risk ranks rather than raw premium; and (2) an **IV ceiling** (`maxIvPct`, default **80%**) on the target put that excludes vol-bombs from the vetted list entirely. Because the screen targets a fixed ~0.30Δ put, the delta-discount is near-uniform (favors the further-OTM puts within the cluster) — the IV ceiling is the primary vol-risk control. Note: on a high-IV universe (e.g. the current semis) an 80% ceiling cuts hard by design; tune `WHEEL_VETTED_DEFAULTS.maxIvPct`. New pure helper `riskAdjustedYield`; IV gate folded into `assessWheelPut`. Regression tests +3 (`tests/wheel-vetted.test.ts`, 16 total). `src/main/services/filter-templates-service.ts`, `src/shared/filter-templates.ts`, `src/renderer/src/views/FiltersView.tsx`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.102] — 2026-07-02

### Changed
- **Wheel (Vetted) thresholds tightened after a live run** (`WHEEL_VETTED_DEFAULTS`): the balanced defaults returned **121** names over S&P 500 + Russell 1000 — a good pool but still browse-heavy. Raised **suitability 70 → 75**, **open interest 100 → 250**, and the **annualized-yield floor 8% → 20%** (user-selected on a live Russell 1000 run where only ~16 names fell below 15% annualized). Spread cap unchanged (15%). Trims the marginal-liquidity / low-premium tail; the highest-yield (highest-IV) names at the top are unaffected. One-line default change; unit tests unchanged (still green). `src/main/services/filter-templates-service.ts`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.101] — 2026-07-02

### Added
- **"Wheel (Vetted)" filter template — a liquidity-gated funnel that turns ~792 matches into a tradeable handful.** The existing `wheel_opportunity` template gates on fundamentals only (suitability ≥ 60), so over S&P 500 + Russell 1000 it returns ~792 names — essentially "every decent large/mid-cap." The new **Wheel (Vetted)** template (Filters → Wheel) runs a two-stage funnel: **Tier 1** applies the cheap fundamentals gate (suitability ≥ 70) to every name with no option call; **Tier 2** fetches **one monthly-expiry chain per survivor**, targets the ~0.30Δ put, and requires **open interest ≥ 100, bid/ask spread ≤ 15% of mid, and annualized CSP yield ≥ 8%** — the liquidity + monthly-expiry + real-premium checks the loose template lacks. Columns: Score, IV %, Put Strike, OI, Ann % (sorted by annualized yield); each row's match reason shows the exact put (expiry/DTE/Δ/credit/OI/spread), and the ⭐ Save to Watchlist + Payoff hand-off (pre-loads a CSP at the vetted strike) both work. Price-agnostic (last price is a sortable column). Deeper/slower scan since survivors hit the options API — a deliberate action, not a browse. Pure gate logic (`thirdFridayOnOrAfter`, `pickWheelPut`, `annualizedCspYield`, `assessWheelPut`) is unit-tested (`tests/wheel-vetted.test.ts`, +13); thresholds in `WHEEL_VETTED_DEFAULTS`. Files: `src/main/services/filter-templates-service.ts`, `src/shared/filter-templates.ts`, `src/renderer/src/views/FiltersView.tsx`. Formula: `docs/formulas.md#annualized-options-return`. Spec: `Requirements/spec/05-screener-and-filters.md`.

## [1.1.100] — 2026-07-02

### Added
- **E*Trade keep-alive heartbeat + live connection test — stops the daily "token expired" pain.** Two changes, building on the v1.1.99 renew fix: (1) A **keep-alive heartbeat** pings E*Trade every ~90 minutes while the app runs (`probeETradeConnection` — a lightweight SPY quote with renew-and-retry). E*Trade tokens go dormant after ~2h idle; a day of Polygon-only work (screener/filters) used to let the token lapse so the after-close batch hit a dormant token. Pinging inside the 2h window keeps it warm, and now that renewal actually works, auto-revives it if it did lapse. Only acts on a date-valid token; a midnight-expired one is left for manual re-auth. Registered in `index.ts`, cleared on quit. (2) A **live connection test**: `etrade:test-connection` IPC / `window.api.etrade.testConnection()` actually calls E*Trade (vs. the date-only `check-connection`), so "Connected" reflects whether the token *works right now* — returns `ok` / `renewed` (was dormant, auto-revived) / `expired` (needs re-auth) / `error` (transient). Settings gains a **Test Connection** button, and on mount it now verifies a today-stamped token with a real probe instead of trusting the date stamp. Files: `src/main/ipc/ipc-etrade.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/views/SettingsView.tsx`. Spec: `Requirements/spec/03-data-providers.md`.

## [1.1.99] — 2026-07-02

### Fixed
- **E*Trade token renewal has never worked — the renew endpoint path was wrong.** `RENEW_TOKEN_PATH` was `'/v1/oauth/renew_access_token'`, but E*Trade's OAuth endpoints live under `/oauth/` (the `/v1/` prefix is only for the market/accounts APIs) — the correct path is `'/oauth/renew_access_token'` (confirmed against E*Trade docs). So **every** `renewAccessToken()` call hit a bad URL and failed; since renew errors are swallowed throughout the renew-and-retry paths, a dormant token (idle > 2 h) was **never actually revived** and always surfaced as "token expired," forcing a manual re-auth. This is the true root cause behind the recurring evening-batch "E*Trade token expired" failures — the v1.1.92/94 fixes improved *detection* (renew-and-retry on any error) but couldn't help because the renewal itself was broken; the unit tests mock `renewAccessToken`, so a wrong URL was invisible. Diagnosed live 2026-07-02: a token reconnected at ~11 am (Daily Brief succeeded) returned `oauth_problem=token_rejected` on the 5 pm batch and an on-demand AAPL options fetch, because the afternoon ran only Polygon traffic → the E*Trade token went dormant → renew hit the wrong URL → never recovered. Regression test asserts the real fetch URL (`tests/etrade-renew-endpoint.test.ts`) — the existing dormancy tests mock renewal and couldn't catch it. `src/main/services/etrade-auth.ts`.

## [1.1.98] — 2026-07-02

### Added
- **Liquidity / open-interest check in the Payoff Pre-Trade Validator.** The validator now weighs **liquidity** as a deterministic check (#8): any option leg with **open interest below 100**, or a **widest bid/ask spread above 20% of mid**, triggers a **caution** (judged by the worst leg — one thin leg flags the whole structure). Legs built from the live chain now carry `openInterest`/`volume`/`bid`/`ask` (added to `PayoffLeg`); manually-entered legs carry none, so the check reports **liquidity unknown (info)** rather than a false pass. Open interest is also shown per leg in the legs list (Δ / IV / **OI**), and the same liquidity data is fed to the **AI "Assess Trade"** context + prompt so the assessment factors execution risk (with an explicit instruction not to cite liquidity figures it wasn't given). Motivation: a strike can look great on paper and be untradeable — thin OI / wide spreads mean poor fills and hard exits. New thresholds `PRETRADE_THRESHOLDS.minOpenInterest` / `maxSpreadPct`. Regression tests: `tests/pretrade-checks.test.ts` (+5). Files: `src/main/services/pretrade-checks.ts`, `src/main/services/payoff-service.ts`, `src/renderer/src/views/PayoffView.tsx`, `src/shared/types.ts`. Spec: `Requirements/spec/08-options-chain-and-payoff.md §8.B.7`.

## [1.1.97] — 2026-07-02

### Added
- **Save filter results to a watchlist (Filters → ⭐ Save to Watchlist).** The results header of every filter template now has a bulk **Save to Watchlist** action: run any scan (e.g. Wheel Opportunity over the Russell 1000) and save *all* matches at once to either a **new** watchlist (enter a name) or an **existing** one (pick from the dropdown). Duplicate tickers already in the target list are skipped and reported (`Saved N tickers to "…", M already present`); the new list appears immediately in the source dropdown so it's usable in other functions (analysis, LEAPS+CSP, other filters) without re-typing tickers. Addresses the friction of navigating from a filter run into per-ticker tools. Reuses existing `watchlists.create` + `watchlists.items.addBulk`; renderer-only change in `src/renderer/src/views/FiltersView.tsx`. Spec: `Requirements/spec/05-screener-and-filters.md §5.B.3`.

## [1.1.96] — 2026-07-02

### Added
- **Roll / Closure Analyzer (Analysis → 🔄 Roll/Close).** The exit-side companion to the Payoff visualizer: where Payoff reviews a structure *before* entry, this analyzes an *existing or hypothetical* single short option (cash-secured put or covered call) for a **close vs hold vs roll** decision. Enter the position manually (ticker, put/call, strike, expiry, contracts, entry credit) or **load an open CSP/CC straight from the E*Trade-synced portfolio**. The screen shows the current close-now P&L (and % of max credit banked), moneyness/DTE, assignment probability (Δ), breakeven and capital at risk, plus a rule-based **hold/close/roll recommendation** — then ranks **credit-roll candidates** across the next several expiries and a strike band (roll down / same / up) by a **metric you pick**: (1) annualized return on capital, (2) largest net credit, (3) risk-adjusted yield (delta-penalized), or (4) capital efficiency (credit per $ committed). Switching the metric re-ranks instantly (no re-fetch). Credit-rolls only (net credit > 0, matching the wheel discipline); each candidate shows the new breakeven with the roll credit folded into the cumulative basis, and a liquidity flag on wide bid/ask. New `RollAnalyzerService` (pure, unit-tested metric math), `roll:analyze` IPC, `window.api.roll.analyze`, `Roll*` types, `RollAnalyzerView.tsx`. Marks are bid/ask midpoints — confirm real fills before trading. Regression tests: `tests/roll-analyzer.test.ts` (9). Formulas: `docs/formulas.md#roll-analyzer`.

## [1.1.95] — 2026-07-02

### Added
- **Index Constituents viewer (Misc → 📇 Index Constituents).** A new screen listing the S&P 500 and Russell 1000 tickers the app tracks, in two tabs, with a sortable grid (Ticker · Company · Sector · **Added**) plus a ticker/company filter box. Sorting defaults to **date-added, newest first**, so members the daily constituents-refresh job (v1.1.91) adds surface at the top; rows added within the last 7 days carry a **NEW** badge, and a header count shows how many were added in the last week. Also shows the list's source and last-refresh date. `src/renderer/src/views/ConstituentsView.tsx`, new `ConstituentsService.getConstituentsWithMeta()` + `screen:get-constituents-with-meta` IPC + `window.api.screen.getConstituentsWithMeta` + `ConstituentWithMeta` type.

### Fixed
- **`added_at` no longer resets on every constituents refresh.** `ConstituentsService.applyRefresh` deletes and re-inserts the index each run; it was stamping **every** ticker with the current time, so "date added" would have shown the entire index as added on the last refresh (making the new viewer useless and any "what's new" query wrong). It now **preserves the original `added_at` for carried-over tickers** and stamps only genuinely new members — so the date reflects when a ticker actually joined the index. (Existing stored rows keep their current date as the baseline; accurate dates accrue from here forward.) Regression test added to `tests/constituents-refresh.test.ts` (9 total). `src/main/services/constituents-service.ts`.

## [1.1.94] — 2026-07-01

### Fixed
- **On-demand E*Trade options path now self-heals from a dormant token (same terminated-stream blind spot as v1.1.92, second path).** `ETradeDataProvider.withRenew` only renewed the token on an **auth-shaped** error (`isEtradeAuthError`: `401|token|auth|oauth`). A dormant token (idle > 2 h) doesn't reliably return a 401 — it kills the response stream (undici `terminated`) — so the renewal never ran and every on-demand options fetch **silently returned an empty chain** (swallowed by the options route's per-expiration `catch`). This affects the **API server** (`/options/:ticker`), the **Strategy Lab**, the **TraderAgent scout**, and — most importantly — the **v2 execution engine's entry-time re-pricing**, where a dormant token would make a live combo re-price come back empty. Discovered live 2026-07-01 while running an ad-hoc MRVL chain query: every expiry (incl. SPY) returned `[]` though the app was up. `withRenew` now **renews and retries once on ANY error** (renewing an active token errors harmlessly and is swallowed; a genuine non-auth error just fails again on the retry, surfacing the real error). Removed the now-unused `isEtradeAuthError` helper. Regression tests: `tests/etrade-dormant-token-renew.test.ts` (updated to the any-error contract + a `terminated`-stream case). `src/main/services/etrade-data-provider.ts`.

## [1.1.93] — 2026-07-01

### Added
- **Structure-liquidity instrumentation (`structure_liquidity_log`, migration 064).** The Stage-4 Strategy Lab run now persists every constructible structure's liquidity measurement (ticker, slug, liquidityScore, grade, zero-bid-leg flag, UTC timestamp + ET date) into a small side table. Motivation (NEW_FRONTIER §11): the after-close brief measures liquidity ~−1.4 pts below intraday — right at the 8/15 tradability bar — but the evidence was only 19 paired observations from one date, because the evening brief **deletes** the same-ET-day morning brief rows (`storeBrief`), destroying the intraday measurements daily. With the 10:15 slot healthy again (v1.1.92 token fix), pairs now accumulate at ~50 structures/day; after 2–3 weeks the artifact can be calibrated properly and, if confirmed, the critic/gate can be taught to use same-day intraday measurements (FR-SEY-5 pass at that point — verdicts gate engine entries). **Pure instrumentation** — nothing on the live path reads the table; logging failures are swallowed (never break the brief); rows pruned at 120 days. `scripts/fr-liquidity-slot-comparison.mjs` now prefers this table over stored briefs. `src/main/services/structure-liquidity-log.ts`; regression tests `tests/structure-liquidity-log.test.ts` (4).

## [1.1.92] — 2026-07-01

### Fixed
- **Evening batch chain no longer halts on a dormant E*Trade token (renew-and-retry on ANY probe failure).** The 17:00 orchestrator slot failed at Daily IV Update with `E*Trade connectivity check failed: terminated` on 8 of the last 10 trading days, forcing a manual re-run at ~18:30–22:00 ET (which also meant the brief measured option liquidity on extra-stale quotes). Root cause: a **dormant token (inactive >2h — idle since the ~10:40 morning run) doesn't reliably fail as a clean 401** — E*Trade kills/hangs the response stream (undici `terminated`), the connectivity check's auth-message heuristic (`401|token|auth|oauth`) didn't match, so `renewToken()` was **never attempted** and the job (and the whole orchestrator chain behind it) died — even though the token was renewable without any login all along (the manual evening re-runs succeeded because opening the app renewed it via `withRenew` paths). The check now **unconditionally renews and retries once on any probe failure** (renewing an active token errors harmlessly); only if the retry also fails does it classify: auth-shaped → "token expired, reconnect" CTA (true midnight expiry), else a real connectivity failure (message now says "after token renew + retry"). The orchestrator's pre-wake renewal (`_checkEtradeToken`) also logs failures instead of swallowing them silently. Manual re-auth is still required only for the true **midnight-ET hard expiry** — the away-at-work dormancy case is now fully automatic. Regression tests: `tests/daily-iv-capture-connectivity.test.ts` (3). `src/main/services/jobs/daily-iv-capture.ts`, `batch-orchestrator-job.ts`.

## [1.1.91] — 2026-07-01

### Added
- **Automated S&P 500 + Russell 1000 constituent refresh (new batch job `constituents-refresh`).** Index membership was a manual step (Wikipedia "Refresh" button / CSV import); it now refreshes automatically as the **first sub-job in the orchestrator chain** (sequence 2, before Market Sync — migration `063` shifted the other jobs +1) so every downstream job sees today's membership. Source: **Vanguard fund holdings** — VOO (S&P 500) and VONE (Russell 1000) via Vanguard's free public paginated JSON API (validated live: 503 / 1,002 rows) — with the existing **Wikipedia scrape as fallback**. Both sources run **gated**: row-count floor (480 / 940) and a ≤25% membership-turnover guard vs the stored list, so a truncated or corrupt feed can never wipe a known-good list (the annual Russell reconstitution is ~8-12% turnover; the gate never fires on a legit rebalance). Sector and company name are **preserved for carried-over tickers** (Vanguard carries no sector field). The manual "Refresh" button now uses the same gated Vanguard-first path (`screen:refresh-constituents`); CSV import stays as the manual override. `ConstituentsService.refreshFromVanguard/refreshIndexAuto/applyRefresh` (+`ConstituentsRefreshOutcome` diff), `src/main/services/jobs/constituents-refresh-job.ts`, `ConstituentsMeta.source` gains `'vanguard'`.
  - **New index members are backfilled automatically**: the job diffs membership and fetches **1 year of Polygon daily bars** for added tickers with no price history (a ticker moving between lists or already tracked keeps its bars — no duplicate fetch). Quotes/fundamentals follow minutes later via Market Sync in the same orchestrator run; technical signals compute the same evening. `iv_history` cannot be backfilled from Polygon — IV rank appears after 21 trading days of the daily IV capture (scoring already treats it as a missing signal until then), or run the manual IVolatility backfill for instant full history.
  - **A source outage never halts the nightly chain**: refresh failures return `status: 'success'` with a "kept existing list" warning note (`tickersFailed` counts them) because a slightly stale constituent list is strictly better than skipping the brief — the orchestrator stops the whole chain on a failed sub-job.
  - Regression tests: `tests/constituents-refresh.test.ts` (8 — pagination, diff, sector preservation, both gates, Wikipedia fallback, bootstrap-only-new, outage-is-success).

## [1.1.90] — 2026-06-30

### Added
- **Daily Brief surfaces a Level-2-tradeable (debit) vertical for bullish/bearish picks (display-only).** The brief's recommended/credit structures (bull-put, big lizard, iron condor) all require IBKR **options Level 3**. Both the Grouped card and the Ranked Grid now also show a `📈 L2-tradeable: Long Call Spread …` (bullish) / `Long Put Spread …` (bearish) chip — a **debit** vertical a **Level 2** account *can* place, so a small, defined-risk directional trade can be made (e.g. to build options history toward L3) instead of nothing. The vertical is narrowed at brief-generation time to a small max-risk budget (**$750** default): long leg ATM, short leg pulled in from the same live chain to the widest strike whose net debit stays within budget (`buildNarrowDebitVertical`, `src/main/services/level2-debit-vertical.ts`, `docs/formulas.md#level2-debit-vertical`), computed inside `StrategyLabService.validate()` and stored on `StrategyLabValidateResult.level2DebitAlts` (no extra E*Trade fetch, no brief-job stage). The chip shows debit / max-risk / **breakeven + move-to-profit — deliberately NOT a PoP**, because the lab's short-strike `popEstimate` is credit-spread semantics and would badly overstate a debit spread's true odds. A leg with no quote is priced via Black-Scholes from its chain IV; if even the narrowest spread exceeds the budget it's shown flagged (`exceededBudget`). Clicking opens the Payoff Visualizer pre-loaded with the legs. **Display-only / account-building context** — not the optimal structure at high IV (you're buying expensive premium), and it does NOT change what the brief recommends, the Conviction score, or what the engine trades (no FR-SEY-5 impact). Accessor `level2DebitAlternative` in `src/shared/brief-ranking.ts`. Regression tests: `tests/level2-debit-vertical.test.ts` (7), `tests/brief-ranking.test.ts` (+4, 18 total). **Needs one brief re-run to populate `level2DebitAlts` on stored picks** (older briefs degrade gracefully to no chip).

## [1.1.89] — 2026-06-29

### Added
- **Total G/L column on the Portfolio open-positions table.** The open-positions grid showed only **Day's G/L** (the single-session change); it now also shows **Total G/L** — the full-position unrealized gain/loss since entry, in dollars and percent (e.g. `+$1.2K (+8.40%)`). Sourced from the E*Trade sync (`totalGain` $, stored as `unrealizedPnl`, + `totalGainPct` %), falling back to the stored `unrealizedPnl` when no E*Trade row is present. Green/red coloured to match Day's G/L. Display-only — no scoring/trade-logic impact (not FR-SEY-5-gated). `src/renderer/src/views/PortfolioView.tsx`.

## [1.1.88] — 2026-06-27

### Added
- **Gap Risk metric on the Validate dashboard (display-only).** Each single-ticker validation now shows a **Gap Risk** indicator: the stock's trailing ~252-day **95th-percentile downside overnight gap** divided by its **IV-implied 1-day move** (`atmIv/√252`). A score **> 1** means the name historically gaps *down* harder than its implied volatility prices — i.e. you're under-compensated by option premium for its jump risk (relevant to owning the stock or selling cash-secured puts); **< 1** means realized gaps sit within what IV implies. Badged High/Mid/Low with the underlying figures (`gap X% vs IV Y%/day`). Pure metric in `src/shared/gap-risk.ts` (`computeGapRisk`, `docs/formulas.md#gap-risk`), wired through `ValidateDashboardResult.gapRisk`. Regression tests: `tests/gap-risk.test.ts` (6).
  - **Context metric, not a trade gate.** A Brief-Replay study (`scripts/fr-gap-risk-study.mjs`, `scripts/fr-gap-risk-csp.mjs`; recorded in `Requirements/NEW_FRONTIER.md §9` as draft FR-SEY-6) found the score is **not** a shippable entry filter on the current ~13-month IV panel: it *inverts* on defined-risk spreads (whose long wing already caps gap loss) and is only a mild, tail-blind win-quality nudge on naked short puts. It is surfaced for the trader to eyeball, never enforced — no FR-SEY-5 gate.

## [1.1.87] — 2026-06-27

### Added
- **Daily Brief surfaces a defined-risk alternative for bullish picks (display-only).** Bullish picks almost always recommend a **Big Lizard** (a coin-flip ATM range trade with a large tail), while the lab also scores a defined-risk **bull put spread** (`short-put-vertical`) that the bullish bucket can't recommend (it's filed under `inflection`). Both the **Grouped** card (expanded detail) and the **Ranked Grid** (under the Best Structure cell) now show a `⚖ Defined-risk alt: Bull Put Spread A+ · $strike · expiry · credit · PoP%` chip when the spread is constructible and carries a strictly smaller max loss than the recommended structure. Clicking it opens the Payoff Visualizer pre-loaded with the spread's legs. This is **purely informational** — it does NOT change which structure the brief recommends or the engine trades, so it's not FR-SEY-5-gated (the engine-side rubric change remains disabled behind `USE_POP_WEIGHTED_PREMIUM` pending the July backtest). Computed client-side from the already-stored lab scores (no job re-run). Bullish-scoped to match the validated finding. New `definedRiskAlternative()` in `src/shared/brief-ranking.ts`; regression tests in `tests/brief-ranking.test.ts` (+5, 14 total).

## [1.1.86] — 2026-06-27

### Added
- **Experimental PoP-weighted premium scoring (disabled) + lizard-vs-spread backtest harness.** Investigation into why the bullish brief recommends a Big Lizard over a bull put spread found the lab's `premiumScore` **saturates** (any short-premium structure returning ≥1.5%/30d on capital pegs the 25-pt cap) and ignores probability-of-profit. A static risk-geometry study of 102 historical bullish picks (using the lab's own stored `maxLoss`/`popEstimate`) showed the bull put spread is risk-adjusted *superior* — higher return-on-risk in 86% of picks, higher PoP in **100%** (70.6% vs the lizard's coin-flip 52.7%), for ~15× less capital — yet the lab grades the lizard ~1.8 pts **higher**. New `USE_POP_WEIGHTED_PREMIUM` flag (**default false**) re-grades the short-premium `premiumScore` as `25 × clamp(ret30d/3,0,1) × clamp((PoP−40)/35,0.3,1)` (`popWeightedPremiumScore`, `docs/formulas.md#pop-weighted-premium`), which on the sample flips selection toward the spread. **Shipped disabled pending an FR-SEY-5 realized-P&L backtest** — the 2026-06 bullish sample doesn't settle until Jul 2–24 2026 (none had expired). Harness `scripts/backtest-lizard-vs-spread.mjs` settles each structure at hold-to-expiry **intrinsic** (no IV assumptions; `src/shared/structure-settle.ts`) from the stored legs + price paths — re-run after Jul 24 to get the delta and decide whether to enable. Finding recorded in `Requirements/v2-execution/06-seykota-risk-extensions.md`. Regression tests: `tests/structure-settle.test.ts` (5), `tests/lab-pop-premium.test.ts` (5). Selection/grading is unchanged with the flag off.

## [1.1.85] — 2026-06-26

### Added
- **Daily Intelligence Brief — Ranked Grid tab + critic pass-filter.** The brief now has two tabs: **Grouped** (the existing expand-by-strategy accordion) and **Ranked Grid** — one flat, sortable row per pick across every strategy. Columns: Ticker · Price · **Conviction** · Strategy · Composite · Best Structure (→ Payoff) · Expiry · Strike · Premium · Rating · Flag · RSI · Actions (Payoff/Validate/Options/Analysis/E*Trade icons). All columns sortable; default sort is **Conviction** descending.
  - **Conviction** is the one ranking that *is* comparable across strategies. Raw composite scores are strategy-specific (different signals/weights) and can't be ranked head-to-head, so Conviction = the **Strategy-Lab structure score** (0–100, shared IV+direction+premium+liquidity rubric) **minus a critic penalty** (caution −15, flag −35, not-vetted −25). It is a quality/triage ordering, **not** a backtested profit forecast — labelled as such in the header tooltip. Composite remains as a (non-comparable) column for reference.
  - A **Critic** segmented filter (All / Pass + Caution / Pass only) is honoured by **both** tabs; pass filters exclude not-vetted picks (no verdict / degraded critic). Tab + filter selections persist to `localStorage`.
  - RSI is shown where available (buy/bullish/bearish picks); wheel/income/inflection render `—`. Ranking + filter logic extracted to `src/shared/brief-ranking.ts`; regression test `tests/brief-ranking.test.ts` (9). Not FR-SEY-5 (display/surfacing only — changes no trade logic).

## [1.1.84] — 2026-06-25

### Changed
- **Paper-tracking now scores brief picks on real structure P&L, not stock direction.** The Retrospect paper-tracking layer (which auto-records every brief pick and snapshots it daily) measured `stock_return_pct` and decided win/loss by a crude proxy (income = within ±8%, others = stock up/down) — which mis-scores the premium-sellers (a wheel CSP "lost" if the stock dipped 1% even when the put expired worthless). It now **Black-Scholes-marks the actual structure from its legs** (`structure-mark.ts`, reusing `black-scholes.ts`) at each daily snapshot and at close, honoring per-leg expiry; the closed-trade **`outcome` now derives from the real structure P&L** (falling back to the stock proxy only when legs can't be priced). New `structure_pnl` / `structure_return_pct` on `paper_trade_snapshots` and `structure_pnl` on `paper_trades` (migration 062); Retrospect History table gains a **Struct P&L** column. `stock_return_pct` is retained for reference. Not FR-SEY-5 (measurement only — changes no trade logic). Regression test `tests/structure-mark.test.ts` (7).

### Notes
- A one-time backfill (`scripts/backfill-structure-pnl.mjs`) re-scores the existing 2,608 snapshots + closed trades; run it once with the app closed **after** launching the new build (so migration 062 has added the columns). Marking holds IV at entry-IV (no historical per-strike IV), so it isolates the underlying move + theta — accurate for direction/theta, approximate across a vol crush. Full suite **756 passing**.

## [1.1.83] — 2026-06-25

### Fixed
- **Validator no longer suggests your own trade back as a "better" structure.** When the Strategy Lab's best pick is effectively the structure you're already evaluating (same legs — e.g. a held NVDA 185 CSP whose lab-best is also a 185 short put), the suggestion now shows **"LAB: NO BETTER ALTERNATIVE"** with a note ("the lab has no higher-graded structure than the one you're evaluating — shown for context") instead of the misleading "LAB SUGGESTS INSTEAD." The useful signal in that case — the grade and the IV-regime note ("consider waiting for higher IV / just own it") — is preserved. New `PretradeSuggestion.sameAsCurrent` flag computed by `suggestionMatchesInput` (leg-set comparison, order-independent). Regression test `tests/pretrade-suggestion-match.test.ts` (5).

## [1.1.82] — 2026-06-25

### Fixed
- **Pre-Trade Validator "Lab suggests instead" no longer recommends a pin-bet butterfly.** For an *ownership* (wheel) intent it was surfacing a grade-A **Put Butterfly** — a neutral structure that pays only if the underlying pins a narrow window at expiry and never acquires shares — because the filter matched any slug containing "put". The suggestion picker now uses explicit per-intent slug allowlists (ownership → `short-naked-put` / `short-put-vertical`; income → the validated short-premium structures; directional → bull/bear categories; hedge → long puts) and **globally excludes pin-bet butterflies** (incl. broken-wing/heart variants) from every suggestion. Regression tests added (`tests/pretrade-checks.test.ts`, 24).

## [1.1.81] — 2026-06-25

### Fixed
- **Root cause of the unstable position-greek signs: two write paths with opposite conventions.** The E\*Trade portfolio sync stored greeks **raw** (verbatim from E\*Trade — a short put's δ negative), while the "refresh greeks from chain" action stored them **position-signed** (negating shorts → +δ/+θ/−ν). Whichever ran last set the sign, so the *same* position flipped convention between a sync and a refresh — which is what made a CSP read as "bearish" in the validator (v1.1.80 patched the symptom downstream; this fixes the source). Both paths now go through one shared helper, `shared/position-greeks.ts` `toPositionSignedGreeks`, so the stored convention is deterministically **position-signed** and the two paths can't drift again. The Portfolio net-greek aggregation and the planned Book Greeks monitor already expect this convention. Regression test `tests/position-greeks.test.ts` (6). (Rows last written by the sync before this version may still be raw until the next portfolio sync re-writes them; the defensive normalization in `position-payoff.ts` keeps the Payoff/validator correct in the meantime.)

## [1.1.80] — 2026-06-25

### Fixed
- **A reconstructed position no longer reads with inverted greeks (a CSP showed as "bearish").** When opening a held position in Payoff (v1.1.79), the Pre-Trade Validator's direction check labeled a cash-secured put — a *bullish* structure — as "bearish, aligns with the bearish trend." Root cause: the portfolio sync's greek **sign convention is unstable** (the same short put was stored *raw* on one sync and *position-signed* on another), so the position's `+`delta got the sell-side flip applied a second time → net delta inverted. Fix: `positionToPayoffLegs` now **normalizes greeks to canonical raw by leg type** (`rawGreeks`: put δ<0 / call δ>0; long-option θ<0, ν>0) before the Payoff engine applies the side sign — correct whichever way the source stored them. Now a CSP correctly reads bullish (→ "against the trend, by intent" when you're a happy owner in a downtrend), and net θ/ν display correctly. Also corrects the (now-wrong) "greeks are always raw" comment in `portfolio-service.ts`. Regression tests added (`tests/position-payoff.test.ts`, 8).

### Known issue (flagged, not yet fixed)
- The **E*Trade greek sign convention is inconsistent across syncs** — the underlying data-integrity cause is still open. All current consumers normalize defensively by type, but the sync itself should be made deterministic (and the planned Book Greeks monitor must normalize, not trust the stored sign).

## [1.1.79] — 2026-06-25

### Fixed
- **Portfolio → Payoff (📐) now shows your *actual* position, not a generic rebuild.** The button used to route through the chain-rebuild path, which snapped the expiry to the nearest of only the **7 weekly Fridays** loaded (so a 57-DTE position like a NOW 80 put expiring 08-21 landed on 08-07), snapped to the nearest weekly strike (80 → 82), and re-priced at the current market mid (your $4.32 entry credit showed as $3.77) — i.e. a brand-new near-term CSP that merely *approximated* your holding. It now reconstructs the position exactly: same strike, same expiry, your entry premium, contract quantity, and stored greeks. New pure helper `src/shared/position-payoff.ts` (`positionToPayoffLegs`) with `tests/position-payoff.test.ts` (6); falls back to the old behavior only if a position lacks the strike/expiry to rebuild.

## [1.1.78] — 2026-06-25

### Changed
- **Pre-Trade Validator: the IV-regime "selling cheap volatility" check is now intent-gated** (first threshold tuning, from validating the live wheel book). When premium isn't your edge — **ownership** purpose or **happy-to-own = yes** — selling into low IV rank is reported as **info** (context), not a warning; for **income / directional** it stays a **warning** (there premium *is* the edge). This matches how the direction and earnings checks already gate on intent, so the verdict reflects *is this good for what you're trying to do*. Net effect on a happy-to-own wheel book: names selling cheap vol (e.g. NVDA IVR 24, TSLA IVR 28) no longer get pushed to caution on the IV check alone — only genuine issues (thin cushion, etc.) do. Regression test added (`tests/pretrade-checks.test.ts`, 22).

## [1.1.77] — 2026-06-25

### Added
- **"Open in Lab →" from the Pre-Trade Validator suggestion.** When the validator flags your trade and the Strategy Lab suggests a better structure, a button next to **LAB SUGGESTS INSTEAD** jumps straight to the Strategy Lab's **Explore** tab, pre-populated with that ticker + structure and **auto-built** (the concrete setup loads without a manual click). Reuses the existing `navigate-to-strategyLab` deep-link (now carries an optional `slug`); `StrategyLabView`/`ExploreTab` accept the slug, land on Explore, and fire a single auto-explore on arrival.

## [1.1.76] — 2026-06-25

### Added
- **Pre-Trade Validator on the Payoff view** — build a structure, declare your **intent** (purpose · happy-to-own? · multi-quarter thesis), and click **Validate Trade** to get a **good / caution / bad** verdict with concrete, deterministic checks: reward-vs-risk (only for defined-risk spreads — a CSP's structural max-loss no longer false-flags it), undefined-risk, **IV-regime fit** (warns when you're selling cheap vol / buying expensive vol), direction-vs-trend (intent-gated — a deliberate ownership fade is info, not a warning), **earnings-before-expiry** (warning, or info if you're happy to own), **cushion-vs-ATR** (flags a thin short-strike on a high-volatility name), horizon match, and effective ownership basis. When a trade is flagged, the **Strategy Lab suggests a better structure** for the same name (intent + IV-regime filtered — and it may say "don't sell premium here"). Each validation is **persisted** (`pretrade_validations`, migration 061). Verdict is **intent-aware** because the same trade can be a bad income trade but a fine ownership trade. Decision-support only — it does not place orders and is not wired to the execution engine. New `pretrade-validator-service.ts` + pure, unit-tested `pretrade-checks.ts` (21 tests); `window.api.pretradeValidator.*`. Thresholds are first-pass and tunable. See `Requirements/PRE_TRADE_VALIDATOR_SPEC.md` + `spec/08`.

### Notes
- ~80% reuse: payoff metrics (renderer), the Strategy Lab (`validate` → IV rank / direction / candidate structures, cached 10 min with a Refresh action), `earnings_calendar` (nearest-date fix v1.1.75), and `technical_signals.atr_pct`. Full suite **728 passing**.

## [1.1.75] — 2026-06-24

### Fixed
- **Earnings calendar dropped the *next* earnings date for actively-reporting names — a real-money risk for the premium-selling book.** The Earnings Refresh job fetches Finnhub in two windows (today→+90d, then +90d→+180d) and the upsert overwrites unconditionally, so any quarterly reporter present in **both** windows had its **near** date (window 1) overwritten by the **following** quarter (window 2). Confirmed live: NVDA stored 2026-11-17 when Finnhub also returned 2026-08-25; same for MRVL/AMAT/ADI (all stored Nov, dropped the real Aug report). Because `earnings_calendar` holds one row per ticker, all three consumers read the wrong date: the v2 **entry gate** (`brief-entry-source` earnings-before-expiry), the **critic** earnings flag, and the brief's **Stage-3 −20 earnings penalty** — so the engine could sell a credit spread / iron condor straight **through** an earnings report believing the window was clear. Fix: Phase 1 now keeps the **nearest** future date (skips a candidate on/after an already-stored future date), matching the per-ticker Phase-2 path. Poisoned data self-heals on the next Earnings Refresh run (runs on startup + after-close). Regression test `tests/earnings-refresh-job.test.ts`.

### Notes
- Found during the iterative Daily Brief accuracy deep-dive (round 9). The rest of the latest brief verified clean: credit/maxLoss/breakeven/annualized all tie out to an independent recompute (conservative slippage-modeled fill at the mid↔adverse-side midpoint), prices fresh + internally consistent, no earnings actually inside today's July expiries (the bug was latent today, not biting). Full suite **707 passing**.

## [1.1.74] — 2026-06-24

### Added
- **Auto-backup location is now configurable.** Settings → Backup → Automatic Backup has a **Backup folder** picker ("Choose…" / "Reset to default"). When set, auto-backups are written into a `TradeAnalyzer-AutoBackups` subfolder of your chosen folder (e.g. a cloud-synced or external drive); otherwise the default app-data location is used. Backups always go into that dedicated subfolder so the newest-5 prune only ever touches its own files, never anything else in the folder you picked. New `autoBackupDir` setting + `settings:pick-directory` IPC.

## [1.1.73] — 2026-06-24

### Fixed / Changed
- **Backup now produces a real `.zip` at the location you choose.** Previously the "Save as .zip" dialog was misleading — it ignored your chosen path and instead dumped an *un-zipped* folder into AppData, telling you to copy it manually. Backup now writes a single zip to the path you pick, containing a **consistent** database snapshot (via SQLite's online backup — WAL-safe, so in-flight data is included, unlike the old live-file copy), plus recent logs, AI_CONTEXT (in dev), and a manifest.
- **Restore now accepts a backup `.zip`** (the database is extracted from it) as well as a bare `.sqlite`/`.db` file. It overwrites the live DB and prompts you to restart.
- **Auto-backup now actually works.** The setting existed but nothing ran it. On launch, if enabled and the chosen interval has elapsed since the last one, the app writes a backup zip to `userData/backups/auto/` (newest 5 retained). The control was also **moved from General to the Backup tab** (where you'd expect it) and gained an **interval (days)** field.

### Notes
- New `src/main/services/backup-service.ts` (shared by the IPC handlers + startup auto-backup); new `adm-zip` dependency. 12 new tests (`tests/backup-service.test.ts`). Full suite **704 passing**.

## [1.1.72] — 2026-06-24

### Added
- **Retrospect header now shows a "Take Profit" signal count** alongside the existing Close Signal badge. A green `✓ N Take Profits` chip appears whenever open paper trades have a take-profit recommendation (counts `insight.action === 'take_profit'`, matching the In Progress grid's Action column). Shows only when N > 0.

## [1.1.71] — 2026-06-24

### Fixed
- **Retrospect → In Progress: the Brief dropdown now stays pinned to the top while you scroll the picks grid.** It used to scroll away with the table, so switching to a different brief meant scrolling all the way back up. The selector bar is now `position: sticky` at the top of the scroll area (full-width with a divider; rows scroll underneath it). CSS-only.

## [1.1.70] — 2026-06-24

### Added
- **Settings-driven, per-mode broker selection** (07-broker-alternatives §3). `exec_config` now carries `paper_broker` / `live_broker` (`mock | ibkr | tradier`), editable as dropdowns in **Execution Settings → Mode**. The active venue is chosen by mode (paper→paper_broker, live→live_broker), with `TA_EXEC_BROKER` env still overriding for dev/tests. Default `mock` preserves the existing opt-in behaviour. Changing the **live** broker requires a confirm gate; the fail-closed spread-permission preflight and live confirm gate are broker-agnostic, so any venue inherits them.
- **Tradier execution adapter (`TradierExecutionBroker`) — skeleton.** Chosen as the path off IBKR (which approved only Options **Level 2** on the live account — no spreads — with a 30-day cooldown, and never had paper spread permission). Tradier is the only venue with a *real* sandbox **and** production on one REST API with native multi-leg orders. Ships fully **unit-tested pure mapping helpers** (OCC/OSI symbols, multileg payload, net credit/debit sign convention, status mapping, combo pricing, preview classification) plus a **fail-closed network shell** implemented to Tradier's documented REST shapes — Bearer auth, sandbox/production by mode, polling-based status/fills, COID idempotency via the order `tag`. Network endpoints are marked `// VERIFY` pending live-sandbox calibration (account + L3 approval + tokens still required). IBKR remains fully supported behind the seam.

### Notes
- Validation-exempt per FR-SEY-5 — broker selection changes neither which trades are selected nor how they're sized/exited. New `tests/tradier-execution-broker.test.ts` + extended factory/schema tests. Full suite **692 passing**.

## [1.1.69] — 2026-06-23

### Fixed
- **Spread-permission preflight timed out instead of returning a verdict — would have blocked arming even *with* permission.** The first live run of the preflight (paper, validating Level 3) showed `check_failed: IBKR request … timed out after 12000ms`. Cause: `discoverProbeSpread` asked TWS for the reference underlying's option contract details with **no expiry/strike filter**, so IBKR tried to return the *entire* SPY put chain (tens of thousands of contracts) and blew past the 12s timeout. The probe now constrains the request to **one near monthly expiry** (`nextMonthlyExpiry` — the next 3rd-Friday ≥10 days out, computed all-UTC), so it returns a few hundred contracts and resolves fast, then picks two strikes as before. (Latent until now: paper skipped the preflight pre-v1.1.66, and live was never reached.)
- **`scripts/ibkr-level3-spread-test.mjs` gave a false "✅ CONFIRMED" after hours.** A market-closed order queues as `PreSubmitted`, but IBKR can still reject it on permission grounds a moment later (→ `Inactive` + error). The script declared victory on the first `PreSubmitted`, then also printed the real "⛔ NOT permitted." It now treats a queued status as **tentative** — confirming only if it survives ~6s with no rejection, and reporting denial on `Inactive`/`Cancelled` or a permission error.

### Notes
- Infrastructure/diagnostic fix to the permission probe — no trade-logic change. Validation-exempt per FR-SEY-5. 4 new tests for `nextMonthlyExpiry` (3rd-Friday math + month roll). Full suite **669 passing**. (Tonight's validation verdict stands: the IBKR paper account is **still not** spread-permitted — an explicit IBKR rejection — so this fix is what makes the engine's own Start give a clean "permitted / not permitted" once the account is upgraded.)

## [1.1.68] — 2026-06-23

### Fixed
- **The critic now cautions on liquidity in step with what the engine will actually trade — a "clean Pass" can no longer hide an untradeable spread.** A brief deep-dive found the critic flagged `low_liquidity` only below score 4, while the v2 entry gate rejects anything below 8 (or with a $0-bid leg). So a defined-risk spread scoring 4–7 got a green "✓ Pass" from the critic yet would be **rejected** by the engine — e.g. today's inflection #1 AEP (liq 6, grade A, "clean pass") sat in that gap, and BALL's long leg had a $0 bid (can't be exited). A human trading the brief's verdict could enter spreads the engine itself refuses.
  - The two thresholds are now one shared constant (`MIN_TRADABLE_LIQUIDITY_SCORE = 8` in `strategy-structures.ts`), used by both the engine gate and the critic, so they can't drift.
  - For **defined-risk multi-leg spreads** (what the engine trades), the critic raises a **warning** when the chosen structure is below the tradability bar, or has a no-bid leg — so the verdict reflects real tradability. Single-name short-premium (where 4–7 liquidity is normal) is unchanged.

### Notes
- Decision-support / display change — the engine's liquidity gate (8) is **unchanged**; this aligns the *critic's* caution to it. Strictly more conservative (the critic can only add caution). Validation-exempt per FR-SEY-5. 4 new critic regression tests. Full suite **665 passing**. Surfaced by the real-money readiness audit of the after-close brief.

## [1.1.67] — 2026-06-23

### Fixed
- **A degraded (LLM-failed) critic no longer reads as an all-clear, and the engine won't trade on it.** When the Anthropic API is overloaded (today's 10:28 brief hit a `529 overloaded_error`), the critic falls back to the rule-based verdict only — which is `pass` when no rule flag fires. Every pick then showed `✓ Pass / low confidence / no rationale`, looking like 21 clean adversarial passes when in fact the LLM critic never ran. Worse, the v2 entry gate accepted that fallback `pass` (it ignored `confidence`/`rationale`), so the engine would have entered trades from an **un-vetted** brief — fail-*open* on AI failure.
  - `CriticVerdict.degraded` now marks a fallback verdict; `EntryPolicy` rejects degraded picks with `critic_degraded` (**fail-closed** — never trade an un-vetted pick).
  - The Daily Brief UI shows **"⚠ Critic unavailable / not vetted"** (neutral, not a green Pass) instead of `✓ Pass` for degraded verdicts, with an explanation on expand.

### Changed
- **Critic AI calls retry harder on transient overload.** The critic's Anthropic client now uses `maxRetries: 4` (above the SDK default of 2) so a brief 429/500/`529` overload rides out on exponential backoff instead of blanking the whole critic layer.

### Notes
- Surfaced by a deep-dive on today's 10:15 brief (user saw "too many pass"). Root cause was the API 529, not lenient scoring. The fail-closed guard is strictly more conservative (it can only *remove* un-vetted trades, never add or re-rank). Validation-exempt per FR-SEY-5. 3 new regression tests (gate rejects `critic_degraded`; brief→PickInput maps `degraded`; clean stays un-degraded). Full suite **661 passing**. (Separately noted from the same audit: the 10:15 lean run can't be trusted for **inflection** — partial-bar `volumeSurge` collapses the composite — and skips the earnings-refresh; trust the after-close run for those.)

## [1.1.66] — 2026-06-23

### Changed
- **The spread-permission preflight now runs in PAPER mode too (not just live).** Root cause of the day's "armed but nothing trades": the IBKR **paper** account (`DUQ795672`) lacks options **spread** (multi-leg) trading permission, so IBKR rejected/cancelled every 2-leg combo the engine sent. `startEngine()` previously ran the fail-closed permission probe in **live mode only** — paper was skipped on the (false) assumption it always has full permissions — so the engine armed and silently spammed rejected orders. Now paper runs the same preflight: `startEngine()` connects, probes `checkSpreadPermission()` (the IBKR adapter uses a non-transmitted whatIf combo), and **refuses to start** with reason `spread_permission:<code>` if the account can't place a spread. The Trading Desk already surfaces this as `Engine refused to start: spread_permission:no_spread_permission`, turning a multi-hour silent failure into a one-line message.

### Notes
- Fail-closed safety change — strictly more conservative (won't arm an account that can't trade the engine's defined-risk spreads); no change to selection/sizing/exits. Validation-exempt per FR-SEY-5. The mock broker grants permission, so tests/dev are unaffected. Updated the existing preflight tests (paper now probes) + added a paper-denied regression test. Full suite **659 passing**. **Operator action required:** enable options spread permission on the IBKR account (Client Portal → Trading Permissions → Options; paper mirrors live) before the engine can trade.

## [1.1.65] — 2026-06-23

### Fixed
- **TWS order-rejection reasons were silently dropped — orders ended `cancelled` with no reason.** With the eTradeOnly/firmQuoteOnly fix (v1.1.62), the engine's combo orders now reach TWS — but TWS was rejecting/cancelling them, and the reason was lost: IBKR reports an order's reject reason on the **error channel** (keyed by order id), which `IbkrExecutionBroker` only handled for *data* requests, and `onIbkrOrderStatus` set `rejectReason` only for a literal `'rejected'` status (not `'cancelled'`/`'inactive'`). So every rejected order showed `status='cancelled', reject_reason=NULL` and the operator had no idea why. The broker now matches an order-id error to its tracked order, logs it (`[ibkr] order N … error`), and surfaces it as a status update carrying the reason; `OrderManager.handleStatus` persists it into `exec_orders.reject_reason` via `COALESCE` (robust to error/status event ordering).

### Notes
- Diagnostic/observability fix — no change to order construction or trade logic. Validation-exempt per FR-SEY-5. New regression test asserts a broker reject reason lands on the order row. Full suite **658 passing**. **This unblocks diagnosing why TWS rejects the paper combos** — the next rejected order will record the IBKR reason in `exec_orders.reject_reason` (and the app log).

## [1.1.64] — 2026-06-23

### Fixed
- **Dropped/never-acked orders permanently consumed the daily entry cap, so the engine stopped entering.** An order the broker silently drops (the eTradeOnly/firmQuoteOnly TWS bug, v1.1.62) sits `submitted` forever, and its `approved` proposal kept counting against `max_new_entries_per_day`/`_per_week` indefinitely. After the two dropped AVGO orders this morning, `dayUsed` was stuck at 2/2 and every subsequent cycle silently rejected all picks with `daily_cap`. New `OrderManager.reconcileStaleOrders()` runs at the start of each market cycle: any order stuck `pending`/`submitted` past 90s with no broker ack is cancelled (best-effort broker cancel + `stale_no_ack`), and its proposal is `expired` (OPEN) — freeing the cap — or its position un-stuck to `open` for a retry (CLOSE). This also **auto-clears today's two phantom AVGO entries** on the first cycle after restart.
- **No per-ticker entry dedup — the same name could be entered repeatedly.** AVGO was proposed twice today because the first order never filled (no position to dedup against), and the daily cap was the *only* thing limiting the stacking. `EntryPolicy.generateEntries` now skips any pick whose ticker already has a non-closed position or a `pending`/`approved` entry proposal (and dedups repeats within a batch), rejecting with `duplicate_ticker`.
- **A filled entry was counted twice against the cap.** On fill, the position was opened but its proposal stayed `approved`, so `countNewEntries` (which counts approved proposals **and** open positions) counted one entry twice — a single fill could consume the whole `cap=2`. The proposal is now retired to `superseded` when its position opens, so each entry counts exactly once throughout its life.

### Notes
- Correctness/safety fixes to engine plumbing (cap accounting, stuck-order cleanup, concentration dedup) — no change to scoring weights, signals, or entry/exit thresholds; the dedup is strictly more conservative (won't stack a name). Validation-exempt per FR-SEY-5. 6 new regression tests across `tests/order-manager.test.ts` + `tests/entry-policy.test.ts`. Full suite **657 passing**. **Relaunch + Start: the stale-order sweep clears today's stuck cap automatically.**

## [1.1.63] — 2026-06-23

### Fixed
- **Engine showed "running + armed" after a restart but was inert — no broker connection, no cycle loop, no trades.** `engine_state` is persisted in `exec_risk_state`, but the broker connection and the cycle loop are process-local and were never restored on restart, and nothing at boot re-ran `startEngine()`. So after a relaunch (crash, reboot, repackage-and-relaunch) the Trading Desk/`/exec/state` reported `engineState:"running"`, `armed:true` while `brokerConnected:false` and `lastCycleAt:null` — the engine took no trades, silently. Surfaced when an IBKR-paper relaunch sat "armed" with no socket to TWS.
- **Boot reconciliation (operator choice: force-stopped-on-boot).** On boot, any persisted `running`/`paused` engine state is now reset to `stopped` (`RiskGovernor.forceStopOnBoot()` → audited distinctly as `boot_reset`), so the UI tells the truth and the operator must explicitly **Start** — which reconnects the broker and restarts the loop — after every restart. A tripped kill switch is left tripped (manual-clear only).

### Notes
- Engine **lifecycle** change, not trade logic — no change to selection/sizing/exits; strictly more conservative (won't trade after a restart until an explicit Start). Validation-exempt per FR-SEY-5. New regression tests cover `forceStopOnBoot` (running→stopped, paused→stopped, no-op when stopped, kill-tripped left tripped). Full suite **651 passing**.

## [1.1.62] — 2026-06-23

### Fixed
- **IBKR combo orders silently dropped by TWS — nothing reached the paper account.** The armed unattended engine logged `proposal → gate_pass → approved → order_submitted` for live AVGO wheel entries, but no fills came back and nothing appeared at the broker. Cause: the production `IbkrExecutionBroker` order object omitted the legacy compliance flags **`eTradeOnly: false`** and **`firmQuoteOnly: false`**. Newer TWS **silently drops** combo orders that lack them — no `orderStatus`, no `error`, no fill — while the `placeOrder()` API call returns cleanly, so the engine recorded "submitted" and waited forever. The three validated diagnostic scripts (`scripts/ibkr-*.mjs`) already set both flags; the engine's own placement path never did. Both the live order and the whatIf permission-preflight order now go through a single shared `buildComboOrder()` that always sets the flags.

### Notes
- Bug fix to order **delivery**, not trade logic — no change to which trades are selected, how they're sized, or how they exit. Validation-exempt per FR-SEY-5. New regression test asserts `eTradeOnly`/`firmQuoteOnly` are `false` on both live and whatIf combo orders (`tests/ibkr-execution-broker.test.ts`, 29 tests). **Re-arm and re-run on paper to confirm fills now land at IBKR.**

## [1.1.61] — 2026-06-23

### Added
- **Execution control API wired into boot.** `ExecutionControlApi` (Fastify on `127.0.0.1:7433`, token-authed via `~/.tradeanalyzer/agent.token`) was built in Phase 3b but never started; it now launches at app boot and stops on `will-quit`. This lets an external operator/agent read live engine state and drive control (start/pause/stop, kill switch) **while the app window is closed** — and, concretely, lets you confirm whether the three switches for an unattended day are set without eyeballing UI pills.
- **`/exec/state` now surfaces `broker` (mock vs ibkr), `automationMode`, and `armed`.** When wired with the engine facade's `getState()`, the endpoint returns the full state view (engine-state, kill switch, executionMode, **automationMode**, **armed**, drawdownPct, health) plus the **broker kind** — the exact fields needed to verify "is it really on IBKR, running, and armed?". `GET http://127.0.0.1:7433/exec/state` with header `X-Agent-Token: <token>`.

### Notes
- Back-compatible: the endpoint still works from core+governor alone (broker defaults to `mock`). No engine/trade-logic change — validation-exempt per FR-SEY-5. New regression test (`tests/control-api.test.ts`) covers the broker/automationMode/armed pass-through. Full suite: **644 passing**.

## [1.1.60] — 2026-06-23

### Added
- **Trading Desk redesign (spec 08 §5, Part D — the last piece of the unattended-operation feature).** The desk is now **tabbed** so each grid stays large enough for many rows, with a proper stylesheet, **aligned column headers**, and **click-to-sort** on every grid (via the shared `useSortable` hook). The always-visible header (PAPER/LIVE + engine pill, arm switch with the paper-only guard, Start/Pause/Stop, kill switch, capital gauge + day P&L + health) sits above the tabs unchanged.
- **Seven tabs:** **Live** (default landing) · **Proposals** · **Entries** · **Exits** · **Rejects** · **Positions** · **Activity**. Each tab badges its row count; **Proposals** badges/highlights (⚠) only when something needs approval and **auto-focuses** the moment a new pending proposal appears.
- **Live tab = the day's story.** A horizontal **daily activity timeline** (9:30 open / 4:00 close markers, shaded entry window, pinned events — brief committed, entries, exits, kill trip/clear) above a friendly **live activity feed** (today's audit events rendered as readable one-liners with colored dots).
- **Entries / Exits / Rejects** are derived per-day (ET): Entries = positions opened today **+ dry-run "not placed" rows**; Exits = positions closed today **+ dry-run exits**, tagged **protective vs discretionary**; Rejects = today's gate/proposal/order rejections with the gate reason.

### Notes
- Validation-exempt per FR-SEY-5 — pure presentation; no change to trade selection, sizing, or exits. One small backend read added: `ExecutionEngine.getRecentPositions` (open + recently-closed, for the Entries/Exits day tabs) → `execution:get-recent-positions` IPC + `window.api.execution.getRecentPositions`; `getPositions` stays open-only for the Positions tab. Trading Desk stylesheet (`.td-*`) added to `styles.css`. This completes spec 08 (Parts A–D all shipped). Full suite: **643 passing**.

## [1.1.59] — 2026-06-22

### Added
- **Lean intraday batch (spec 08 §4, #4).** The daily brief sits at position 8 in the job sequence; everything after it (options snapshot, paper snapshot, earnings refresh, options-premium history) runs *after* the brief commits and can't contribute to it. A new per-job flag **`batch_jobs.after_close_only`** lets the orchestrator's **lean ~10:15 slot skip that post-brief tail** while still running the brief's full upstream closure (jobs 2–8) — so the brief is **identical**, and the morning run is faster (the tail is options-API-heavy). The after-close ~17:00 slot runs everything.
- **Slot lean-ness** is `OrchestratorJobConfig.leanSlots` (explicit) or the default — **every slot except the latest** (the after-close slot is the full run); manual/startup runs always do the full batch. Pure `isLeanSlot` helper.
- **Batch view:** a per-job **Slot** column with a **Lean / After-close** toggle (re-classify a job without a code change), and a **brief-freshness banner** (`batch:brief-freshness`) showing whether the engine has a fresh same-day brief to act on.

### Notes
- Validation-exempt per FR-SEY-5 — the lean brief is bit-identical (same upstream job closure); only the post-brief housekeeping is deferred. The 4 tail jobs are seeded `after_close_only=1` (migration 059 UPDATE for existing installs; `registerJob({afterCloseOnly:true})` for fresh); user toggles persist via `INSERT OR IGNORE`. New tests (`tests/lean-batch.test.ts`): `isLeanSlot` cases, the per-job flag + lean filter expression, freshness. Full suite: **643 passing**. Still deferred: the Part D Trading Desk visual redesign (tabs + activity timeline).

## [1.1.58] — 2026-06-22

### Added
- **Unattended paper operation (spec 08, Part A).** The execution engine can now run a full unattended paper trading day. A single **arm switch** (`exec_config.automation_mode`) has three stances: **Off** (`semi` — approve each, current), **Dry-run** (decide everything, place nothing → `exec_dry_run_log`), and **Armed** (`unattended` — auto-approve entries + auto-fire discretionary exits). **Auto-entry is PAPER-ONLY** — enforced in the engine (`tryGenerateEntries` auto-approves only when `executionMode==='paper'`); live always stays semi-auto.
- **Cycle loop driver wired.** `ExecutionCore.startLoop` was previously unwired (nothing ticked unattended); the engine now starts the management/entry loop on start at `exec_config.cycle_interval_sec` (default 120s) and stops it on stop. index.ts opts in via `enableCycleLoop`.
- **Brief-freshness gate.** The engine acts only on a brief generated **today (ET)** — `loadBriefPickInputs(..., requireToday=true)` — never yesterday's after-close brief. Eliminates the 10:00–10:15 stale-brief window.
- **Notifications.** Per-action OS push (gated by `notify_push`) + email on each entry/exit/kill-trip (`notify_per_action`), and an **end-of-day digest email** that fires **only when armed** (`notify_eod_digest`). Wired in index.ts via Electron `Notification` + the existing `EmailService`.
- **Keep-awake while armed.** index.ts starts an Electron `powerSaveBlocker('prevent-display-sleep')` whenever the engine is armed (running + unattended + paper), released on disarm/stop, so an all-day run doesn't sleep.
- **UI.** Trading Desk gains an **Automation (arm switch)** panel + prominent `⚡ ARMED` / `DRY-RUN` header pills; Execution Settings gains an **Automation & notifications** section. New `exec_config` columns + `exec_dry_run_log` table (migration 058); `execution:get-dry-run-log` IPC + `window.api.execution.getDryRunLog`.

### Notes
- Validation-exempt per FR-SEY-5 — nothing changes which trades are selected or how they're sized/exited; auto-entry only removes the human click on already-selected picks, the freshness gate only prevents acting on stale picks, and every auto-entry passes the full risk gate (re-priced) exactly as a human approval does. Caps (1/day etc.) and the kill switch bind unchanged. The planned separate `entry_mode` column was folded into `automation_mode` (one source of truth). Deferred to a later pass (Part D): the full tabbed Trading Desk redesign + activity timeline, the lean intraday batch (#4), and the in-app live notification feed. New tests: freshness gate, unattended/semi/live/dry-run cycle behavior, dry-run dedupe + no audit pollution, armed state. Full suite: **633 passing**.

## [1.1.57] — 2026-06-22

### Added
- **Live preflight: broker spread-permission gate (fail-closed).** Before the engine goes **live**, `startEngine()` now confirms the broker account can actually place a defined-risk option spread, and **refuses to start** if it can't — so a Level-1 / cash IBKR account can never go live and sit silently getting every multi-leg order rejected. The TWS API doesn't expose the options trading level directly, so the IBKR adapter probes with a **non-transmitted `whatIf` combo order** on a reference vertical (default SPY): an `OrderState` back ⇒ permitted; an order error ⇒ not permitted. Any failure to confirm (not connected, no probe buildable, permission/eligibility error, unrelated error, or timeout) is fail-closed (`started:false`, reason `spread_permission:<code>` / `broker_connect_failed:…`), with outcomes written to the audit log (`preflight_permission_ok` / `_failed`). New `ExecutionBroker.checkSpreadPermission()` (mock always grants — a simulator models no entitlement). Spec: `Requirements/v2-execution/02-risk-governor.md §2.13`.

### Notes
- **Context:** IBKR approved the *live* account for **Options Level 1 only** (covered calls / protective puts), which can't place the engine's credit spreads; the live flip is deferred pending an account upgrade to Level 3, and the operator is staying **paper-only** for now. This gate is defensive insurance for the eventual live flip. **PAPER IS UNAFFECTED** — the preflight runs in LIVE mode only (paper has full permissions and is left out of the soak path), and the broker still defaults to mock with IBKR strictly opt-in. New tests: engine paper-skips / live-refuses / live-allows; IBKR pure helpers (`classifyPermissionError`, `interpretWhatIfState`, `pickProbeSpread`). Full suite: **626 passing**.

## [1.1.56] — 2026-06-21

### Added
- **Per-strategy composite floors are now editable in Execution Settings → Entry policy.** The `exec_config.min_composite_by_strategy` map (shipped v1.1.55) was migration-set only; it now has a UI editor — one floor input per eligible strategy (plus any stale override key, flagged "not eligible" so it can be removed). A blank input inherits the global **Min composite score** (shown as the placeholder); a value overrides it. Reads/writes the existing config field, so it round-trips through `getConfig`/`updateConfig` with no engine changes. This makes the income=0 floor (and any future per-strategy calibration) adjustable without a migration.

### Notes
- No behavior change to the engine — `EntryPolicy.filterPick` already used `minCompositeByStrategy[strategy] ?? minCompositeScore`. UI-only (renderer). The **liquidity gate** (`max_combo_spread_pct`) remains in the UI and **off** by default (FR-SEY-5: not backtestable). Full suite: **617 passing**.

## [1.1.55] — 2026-06-18

### Added
- **v2 execution now trades Iron Condors** (income) — the neutral, high-IV, two-sided theta workhorse, and the second strategy in the multi-strategy book. New 4-leg `iron-condor` `ExecStructure`; income picks map to the lab's iron-condor setup. **Budget-width extended to the condor**: each long wing is sized to the per-trade budget via the existing per-wing selector, so a condor that was $2.7k–$12.6k max loss (today's income brief) becomes ≤ budget (~$400). The exit policy (credit + DTE based) already handled it with no changes. FR-SEY-5 validated (`scripts/fr-iron-condor-study.mjs`, 1,397 income replay picks, budget-sized IC, 0.16Δ shorts, 30 DTE, 50% PT / 2× stop): **win 82.3% / return-on-capital 5.7% / avg max loss $403**, vs a random-day baseline of 75.4% / 1.9% — a real edge and the highest win rate of any strategy. Migration 057.
- **Per-strategy composite floors** (`exec_config.min_composite_by_strategy`, JSON `{strategy: floor}`). A single global `min_composite_score` is wrong for a multi-strategy book — composites aren't comparable across strategies. Income scores on a lower scale (replay picks all < 50) and composite isn't predictive for condors, so the inflection-calibrated 50 floor would gate out **every** income pick; income's floor is set to 0 (the validated population). Strategies without an override fall back to the global floor (inflection/wheel unchanged).

### Notes
- `eligible_strategies` is now `inflection,wheel,income`. Caps still bind across the union (the engine takes its best 1/day, 3/week), so income adds neutral-market coverage without raising the trade rate. Iron condor exit/order/sizing reused the existing structure-agnostic machinery (4-leg BAG, credit-based exits). Tests: income→IC mapping, per-strategy floor round-trip; `tests/{brief-entry-source,entry-policy}.test.ts`. Full suite: **617 passing**.

## [1.1.54] — 2026-06-18

### Added
- **v2 execution now trades the Wheel** (as a defined-risk put credit spread) — the first step in broadening the engine from a single-setup sniper to a multi-strategy book. The entry source is generalized: it reads the latest brief for **every eligible strategy** (`exec_config.eligible_strategies`, now `inflection,wheel`) and maps each to the credit structure the engine trades — inflection → direction-locked vertical, **wheel → short-put-vertical** (the small-account "wheel"; a naked CSP can't be sized at $10k, the put credit spread can). All existing gates/caps/pricing/fills are reused unchanged. FR-SEY-5 validated (`scripts/fr-wheel-spread-study.mjs`, 1,388 wheel replay picks, budget-sized put credit spread, 30 DTE, 50% PT / 2× stop): **wheel win 79.8% / return-on-capital 8.2%**, vs inflection 75.1% / 6.1% and a random-day baseline of 74.3% / 3.7% — a real selection edge that beats the already-shipped inflection edge. Wheel composites (66–75) clear the 50 floor and all picks carry critic verdicts, so the existing filters apply cleanly. Migration 056 (preserves a user override).

### Notes
- The daily/weekly caps still apply across the **union** of strategies, so adding wheel widens the candidate pool (more days have something tradeable) without raising the trade rate — consistent with the "capital deployed in validated edges, not trades/day" goal. Iron condors (income) are the next strategy to add. `brief-entry-source` generalized to `loadBriefPickInputs(db, strategies, now)` + `briefPickToPickInput(pick, strategy, …)`; tests in `tests/brief-entry-source.test.ts`. Full suite: **614 passing**.

## [1.1.53] — 2026-06-18

### Changed
- **Risk-budget spread width is now ON by default** (migration 055) — FR-SEY-5 validated. The inflection vertical's hedge leg is sized to the per-trade budget (5% of capital), so high-priced names become tradeable on a small account instead of being silently rejected. Validation (`scripts/fr-budget-width-study.mjs`, faithful `simulateSingleSpread` replica over 1,386 inflection replay picks, same 0.30Δ short + same picks, only the wing differs), at the operative **$500** budget: return/max-loss **5.6% → 6.1%** (Δ **+0.5 pts**), win rate **75.0% → 75.1%** (unchanged), **sizeable at $500: 58% → 100%**. Narrower spreads carry a higher credit/max-loss ratio on wins → return-on-capital is neutral-to-better while every pick becomes sizeable. (Sensitivity: +0.9 pts at $250, −1.2 pts at $1,000 — wider budgets widen spreads and lose efficiency, which the 5% cap already prevents.) Toggle in **Execution Settings → Entry policy**.

### Added
- **Execution Settings** exposes the two new controls: **Risk-budget spread width** (toggle, now on) and **Max combo spread (rel.)** (the liquidity gate).

### Notes
- The **liquidity gate** (`max_combo_spread_pct`, v1.1.52) stays **OFF**: it can't be backtested (no historical bid/ask to compute a combo spread), so per FR-SEY-5 it ships disabled with the finding recorded. Live evidence — the Phase 7 AMAT round-trip crossed ~23% of the credit — is the rationale to enable it (~0.20) manually. Validation script committed as `scripts/fr-budget-width-study.mjs`. Full suite: **610 passing**.

## [1.1.52] — 2026-06-18

### Added
- **v2 execution — small-account spread fitness (infrastructure, default OFF).** Two gaps that Phase 7 paper calibration surfaced — both shipped disabled pending FR-SEY-5 validation:
  - **Risk-budget-driven spread width** (`exec_config.budget_width_enabled`, migration 053). The strategy lab builds short verticals with delta-targeted legs (sell 0.30Δ, buy 0.15Δ), so width is uncontrolled — $60 wide on AMAT (580/520), max loss $4,428, which the risk gate sizes at **0 contracts** under a $10k/5% ($500) budget. When enabled, the brief passes the per-trade budget to the lab and `findBudgetWidthHedge` picks the **widest** hedge leg whose max loss still fits the budget (~$5 wide on AMAT → sizeable). Returns `unavailable` ("No spread within the per-trade risk budget") if even the narrowest spread busts the budget.
  - **Liquidity / economics gate** (`exec_config.max_combo_spread_pct`, migration 054). Even when sized, wide-bid/ask names bleed the edge to slippage (live AMAT round-trip crossed ~23% of the credit). When > 0, `EntryPolicy.buildProposal` rejects a proposal (`wide_market`) whose combo relative spread `(ask−bid)/|mid|` exceeds the threshold.

### Notes
- **Both default OFF** (`budget_width_enabled = 0`, `max_combo_spread_pct = 0`) — no behavior change until validated. Per FR-SEY-5, a backtest delta on the budget-sized width must show at-worst-neutral before either ships enabled. New formula doc: `docs/formulas.md#budget-width`. Tests: `findBudgetWidthHedge` (4) in `tests/strategy-lab-service.test.ts`; liquidity gate (2) in `tests/entry-policy.test.ts`. Full suite: **610 passing**.

## [1.1.51] — 2026-06-18

### Fixed
- **IBKR combo pricing now prices from the individual legs, not the BAG.** During live Phase 7 calibration on the paper account, `IbkrExecutionBroker.priceCombo` returned no bid/ask: IBKR doesn't serve market data for smart-routed BAG combos (single-leg option data works fine). `priceCombo` now requests top-of-book for **each leg** and nets them into the combo quote (new pure helper `comboQuoteFromLegs`): a sold leg adds its premium, a bought leg subtracts it; `bid` is the conservative side (sell each short leg at its bid, buy each long leg at its ask), `ask` the other, `mid`/`netCredit` from leg mids. Validated live (AAPL 280/275 put vertical → ~$0.59 credit at mid, bid $0.49 / ask $0.70). Requires an **options market-data subscription** on the account (OPRA); a leg with no quote raises a clear error.

### Notes
- This needs the account's US options data subscription (OPRA add-on) — confirmed active on the paper account. Order placement/fills don't need data, but pricing proposals does. New unit tests for `comboQuoteFromLegs` (credit spread, lone CSP, debit, ratios) in `tests/ibkr-execution-broker.test.ts`. Diagnostic scripts added: `ibkr-md-diagnose.mjs` (single-leg vs combo data) and `ibkr-price-from-legs.mjs` (live leg-based pricing check). Full suite: **604 passing**.

## [1.1.50] — 2026-06-18

### Changed
- **Lowered the v2 inflection entry gate `min_composite_score` from 70 → 50** (migration 052; configurable, preserves a user override). Backtest-validated, not a guess: over **5 years / 32,760 with-trend up-breakouts**, on a bull-put-spread outcome proxy (short strike 5% OTM, ~30-day hold) the inflection composite is **non- to mildly *anti*-predictive**. Any breakout wins ~75.9% (random-day baseline 74.9%); the composite ≥70 slice wins only ~69.7% while admitting <3% of breakouts, and `volume_surge`/`decisiveness` are monotonically *anti*-predictive (higher value → lower win rate). So the 70 gate wasn't protecting quality — it selected slightly-worse trades **and** starved the inflection-only engine of entries (no inflection pick ever reached 70). A ~50 sanity floor admits genuine breakouts at the base rate (~76%) — at worst neutral per FR-SEY-5 — and leaves real quality control to the critic gate + defined-risk structures + 2× stop / profit target + 1/day, 3/week caps.

### Notes
- **`volume_surge`/`breakoutDecisiveness` `normMax` scaling intentionally left unchanged.** `decisiveness` normMax:3 is technically too harsh (real breakouts top ~1.5 at p95 → norm 50), but the signal is anti-predictive, so re-scaling it to drive the score *more* would amplify the wrong signal. The "miscalibration" isn't worth fixing because the signal doesn't predict outcomes.
- This is a directional proxy (no credit/IV/stop modeling) — it shows the *directional* signals don't predict the stock holding up; it does **not** claim inflection is unprofitable (the credit/IV economics need the app's option-priced Backtest engine, which only has forward data from now). Re-validate once live inflection trades accumulate.
- `entry-policy.test.ts` seeded-default assertion updated to 50. Full suite: **600 passing**.

## [1.1.49] — 2026-06-18

### Fixed
- **The after-close batch run failed to overwrite the morning run's *partial* daily price bar — silently corrupting breakout/inflection scoring.** The batch runs twice a trading day: an intraday scan (≈10:15 ET) and an after-close run (≈16:30+ ET). The morning run stores a partial same-day bar (only the session-so-far volume + an intraday "close"). `PriceGapFillJob`'s staleness gate (`HAVING MAX(date) < date('now')`) then treated that partial bar as "fresh," so the after-close run **skipped the ticker entirely** and never refreshed it. The evening brief therefore computed breakouts on a non-final close and read `volume_surge` at ~10–25% of average for *every* candidate (today's bar held only the first ~50 min of volume). Because `volume_surge` is 25% of the inflection composite weight, this structurally capped inflection composites well below the v2 entry gate (`min_composite_score = 70`). The job now re-fetches the recent daily-bar window for **every** ticker with history on every run; `historical_prices` is `INSERT OR REPLACE` on (ticker, date), so the finalized after-close bar overwrites the partial morning one.
- **Paper-trade snapshots now overwrite today's row on a same-day re-run** (`paper_trade_snapshots` ON CONFLICT `DO NOTHING` → `DO UPDATE` for today only). The after-close run replaces the morning intraday/partial-bar close with the finalized close; past snapshots stay immutable.

### Notes
- Root cause of the inflection brief's "no tradeable picks" symptom found in the brief-accuracy audit: with full-volume bars, `volume_surge` will reflect real breakout participation and inflection composites can clear 70. The audit-found data bug is fixed at the source; no scoring weights were changed.
- Audit of all batch jobs' same-day write semantics: `historical_prices`/`options_premium_history` (INSERT OR REPLACE), `technical_signals`/`iv_history` (ON CONFLICT DO UPDATE), `daily_briefs` (newest row) all already overwrite; only price-gap-fill (skip) and paper-snapshot (DO NOTHING) needed fixing.
- New spec §20.5 documents the two-slot "refresh + overwrite" invariant. Regression test `tests/price-gap-fill-refetch-today.test.ts`. Full suite: **600 passing**.

## [1.1.48] — 2026-06-17

### Fixed
- **The on-demand E\*Trade options path now self-heals from token dormancy** — the second half of the "TraderAgent makes no trades on evening runs" problem (the first was the v1.1.47 Saturday-expiration bug). E\*Trade access tokens go dormant after ~2 h of inactivity and the API then returns 401. The nightly batch jobs already renew-and-retry, but `ETradeDataProvider.getOptionsChain` / `getOptionsExpirations` — the path the API-server options route, the TraderAgent scout, and the Strategy Lab all use — did **not**. So any options fetch made more than ~2 h after the last E\*Trade activity threw a 401, which the options route swallowed into an empty chain (and the agent recorded zero contracts). The provider now wraps both calls in `withRenew`: on a dormant-token auth error it calls `renewAccessToken` once and retries. A fully expired token (past midnight ET) still propagates — that needs a manual re-auth in Settings → E\*Trade Connection.

### Notes
- This rescues **early-evening** agent runs (token idle but E\*Trade still serving quotes). It cannot manufacture data if E\*Trade is fully dark late at night; for reliability, run the agent during or within ~1–2 h of the close. Combined with v1.1.47, a market-hours run now produces trades again.
- Regression test: `tests/etrade-dormant-token-renew.test.ts` (4 tests — renew-and-retry on 401 for both chain and expirations, no renew on non-auth errors, propagate a failed renew). Full suite: **599 passing**.

## [1.1.47] — 2026-06-17

### Fixed
- **The local API options endpoint returned an empty chain on evening runs — which silently starved the TraderAgent of trades (zero new positions for ~10 days).** `GET /api/v1/options/:ticker`, when called without an explicit `expiration`, guesses the next 8 weekly Friday expirations. That helper (`nextFridays`) computed the weekday from **local** time (`getDay()`/`getDate()`) but serialized the result with **UTC** (`toISOString()`). Run after the local clock crossed UTC midnight — i.e. any evening run in a timezone behind UTC — every "Friday" it produced shifted to the **Saturday** UTC date. E\*Trade lists Friday expirations only, so each chain lookup missed, the route swallowed the per-expiration miss, and returned `{ ok: true, [] }`. The TraderAgent scout therefore recorded **zero option contracts** for every survivor, and `decide` had nothing to select. Verified against the data: the agent's last trade was June 8 (a daytime run); every evening run June 9→18 produced 80–130 survivors but 0 contracts, while the app's own snapshot job (which resolves real expirations) kept pulling Friday chains the whole time. `nextFridays` now computes entirely in UTC, matching the pattern already used in `analysis-service` / `filter-templates-service`.

### Notes
- Root cause was purely the expiration-date math in `routes-options.ts`; E\*Trade auth, the screener (Polygon), and the agent's own pipeline were all healthy. The two other Friday-expiration helpers (`ipc-options.generateNextFridays`, `opportunity-service.nearestFridayAtLeast`) serialize with **local** methods throughout, so they were internally consistent and unaffected.
- Regression test: `tests/options-route-fridays.test.ts` (2 tests) pins the helper to UTC Fridays under a fake evening clock. Full suite: **595 passing**.

## [1.1.46] — 2026-06-17

### Added
- **v2 execution — Phase 6b (part 1): the brief→entry source.** The execution engine can now turn the daily brief's **inflection** picks into entry proposals. A new `brief-entry-source.ts` reads the latest committed inflection brief, selects the direction-locked defined-risk vertical from each pick's Strategy Lab result (`pickRelevantStructure`: up-breakout → short-put-vertical, down → short-call-vertical), and maps it to the normalized `PickInput` the `EntryPolicy` consumes — legs, composite score, critic verdict, liquidity, earnings-before-expiry (resolved from `earnings_calendar`), and per-contract max loss. The engine runs this on each **market-open cycle** (not at brief-commit), so the entry window (10:00–15:00 ET), daily/weekly caps, critic/composite filters, and live IBKR re-pricing all apply; a stale brief never trades a stale price, and the daily cap stops repeats across cycles.

### Notes
- Wired on the existing `ExecutionEngine` market-cycle hook — **no engine/UI changes** beyond the new source. Entries only generate while the engine is **running**, the broker is **connected**, and the market is **open**; generation is fail-safe (never throws into the management cycle). With the mock broker this runs offline; against IBKR it prices each candidate on the live chain. **Still pending (Phase 7): live combo pricing + order/fill calibration on the paper account once options-spread approval lands.**
- Pure mapping + the loader covered by `tests/brief-entry-source.test.ts` (15 tests). Full suite: **590 passing**.

## [1.1.45] — 2026-06-17

### Added
- **v2 execution — Phase 6a: the IBKR adapter (`IbkrExecutionBroker`).** A live implementation of the `ExecutionBroker` seam over the TWS socket API (via `@stoqey/ib`), so the engine can place/manage real orders through a locally-running **TWS or IB Gateway**. Paper vs live is purely the connection port (TWS paper 7497 / live 7496, Gateway paper 4002 / live 4001) — never an engine or UI change. A new **broker factory** (`broker-factory.ts`) selects mock vs IBKR: the default stays the deterministic `MockExecutionBroker`, and IBKR is **opt-in** via `TA_EXEC_BROKER=ibkr` (with `TA_IBKR_HOST` / `TA_IBKR_PORT` / `TA_IBKR_GATEWAY` / `TA_IBKR_CLIENT_ID` overrides), so existing installs are unaffected. The IBKR combo net-price sign convention (credit-positive → IBKR's credit-negative BUY limit) is centralised in one helper for paper calibration.

### Notes
- **Connection, contract qualification, buying-power, and position/order reads are live-verified** against the IBKR paper account (account-summary + positions smoke via `scripts/ibkr-probe.mjs`); these need no options permission. **Combo order placement + fills are implemented to IBKR's documented combo conventions but are calibrated/verified on paper in Phase 7**, once the account's options-spread permission is approved. The paper account is a *margin* paper account, so credit-spread paper validation is possible there even though a live **cash** account would need a Reg-T margin upgrade first.
- Pure mapping logic (expiry/contract/status/net-price conversions + factory settings) covered by `tests/ibkr-execution-broker.test.ts` (16 tests). Full suite: **575 passing**.

## [1.1.44] — 2026-06-17

### Added
- **Full-sync close now records an estimated realized P&L**, so a position closed at the broker no longer lands in the Closed tab with a blank P&L. When `closeMissingPositions` marks a position closed it sets `realized_pnl = COALESCE(realized_pnl, unrealized_pnl)` — i.e. its last E\*Trade mark (`totalGain`, persisted since v1.1.43) — and stamps `exit_date` + an `exit_notes` flag that it's an estimate. **It never overwrites a realized P&L already set** (e.g. by the transaction-history "Sync Closed Positions", which stays the authoritative exact source).

### Notes
- Applies to positions closed **going forward** (the estimate needs the last mark, stored only since v1.1.43). A position that was already closed before these builds (no stored mark) stays blank — run **Sync Closed Positions** to pull its exact figure from transaction history. Regression coverage in `tests/etrade-portfolio-reconcile.test.ts` (estimates from the last mark; doesn't overwrite an existing realized figure).

## [1.1.43] — 2026-06-17

### Fixed
- **Portfolio Unrealized P&L now populates from the E\*Trade sync (was always $0).** E\*Trade's portfolio response includes the dollar gain/loss per position (`totalGain`), but `upsertPosition` only stored the *percentage* (`total_gain_pct`) and never set `unrealized_pnl`. Since `getPnLSummary` sums `unrealized_pnl` (null for every synced position), the **Unrealized P&L** summary card read $0. The sync now stores `raw.totalGain` into `unrealized_pnl` on both insert and update, so per-position and total unrealized P&L show after a sync. (`current_price` stays driven by the live-quote refresh — short options can't derive a clean per-share price from market value.)

### Notes
- **Re-sync required**: existing rows have `unrealized_pnl = null`; run the portfolio E\*Trade sync once on the new build to backfill them. Found via user report ("not showing P&L"). Regression coverage in `tests/etrade-portfolio-reconcile.test.ts` (totalGain → unrealized_pnl on insert and re-sync update).

## [1.1.42] — 2026-06-17

### Fixed
- **Portfolio E\*Trade sync is now a full sync — positions closed at the broker drop off.** The sync only *upserted* the positions E\*Trade returned; a position you closed (e.g. NVDA) stayed in the local DB and kept showing as open. The sync now **reconciles**: after a successful fetch, any OPEN, E\*Trade-sourced position for that account whose broker id is no longer in the response is marked `closed` (the row is kept, so notes / realized P&L / history are preserved; the portfolio shows only open positions). The sync result reports the count (e.g. "Synced: 8 updated, 0 skipped, **1 closed**"). Safety: reconciliation runs **only after a successful fetch** (a fetch error never closes anything), is **scoped to the synced account(s)**, and **never touches manual positions** (those without an `etrade_position_id`); the upsert also re-asserts `status='open'`, so a position the broker reports again self-heals back to open.

### Notes
- Found via user report (closed NVDA still showing). Regression coverage in `tests/etrade-portfolio-reconcile.test.ts` (closes a gone position; leaves manual / other-account / already-closed alone; closes all when the account is flat).

## [1.1.41] — 2026-06-17

### Added
- **Payoff "🔧 Fix" now covers lizards and iron condors** (was the two vertical credit spreads only). It still narrows the protective wing(s) toward the short strike(s) — keeping your shorts — re-priced from the live chain, widest passing strike first:
  - **Jade Lizard / Big Lizard** — narrows the long **call** so total credit ≥ the call-spread width (the "no upside risk" condition).
  - **Reverse Jade / Reverse Big Lizard** — narrows the long **put** so credit ≥ the put-spread width.
  - **Iron Condor / Dynamic Width Iron Condor** — greedily narrows whichever wing is currently **wider** (the binding side) until credit ≥ ⅓ × max(put width, call width).
  Refactored into a generalized single-wing path + a two-wing condor path in `src/shared/payoff-fix.ts`; the button stays hidden when the rule already passes or no strike narrows enough.

## [1.1.40] — 2026-06-17

### Added
- **One-click "🔧 Fix" in the Payoff strategy-rules panel.** When a credit spread fails the "credit ≥ ⅓ of spread width" rule (shown with a ✗), a Fix button appears that adjusts the legs to pass it — **narrowing the protective wing toward the short strike while keeping your short strike** (the thesis), re-priced from the live option chain at mid, choosing the widest strike that passes (least narrowing). E.g. a bull put $620/$590 ($30 wide, $9.40 credit, ✗) becomes $620/$595 ($25 wide, credit ≥ ⅓). Scope: the two vertical credit spreads (Bull Put Spread / Bear Call Spread — the inflection launch structures and the common failing case); the button is hidden when no fix applies (chain not loaded, unsupported strategy, or no strike narrows enough). Implemented as the pure, unit-tested `fixLegsForStrategy` (`src/shared/payoff-fix.ts`).

## [1.1.39] — 2026-06-17

### Fixed
- **Opening Payoff from the Daily Brief now loads the option chain for the pick's own expiry, not the nearest weekly.** When navigating to the Payoff visualizer from a brief pick (which supplies pre-built legs), the brief-nav effect only set the legs and never loaded the chain or set `selectedExpiry` — so the chain panel and the "Suggested next leg" / manual leg-add buttons fell back to this week's Friday, adding legs at the wrong expiry (e.g. this Friday instead of the 7/17 the pick used). The effect now also loads the chain for `initialExpiry` (snapped to the nearest available expiry, which is an exact match when the brief's expiry is listed) and sets `selectedExpiry`, so all leg operations use the pick's expiry. Mirrors the existing Opportunity-navigation behavior.

### Notes
- Renderer-only — **no brief re-run needed**; relaunch the app. Found via user report (added next leg landed on this Friday instead of the 7/17 expiry from the brief).

## [1.1.38] — 2026-06-17

### Changed
- **Brief card lab line is now a single row** with the setup inline after the recommended structure: `CSP A+ : $470 Jul 17 $2305.00 cr | Top lab pick: Big Lizard A+` (was a two-row layout with the setup under the grade). The setup sits right after its structure's grade (`:` separator) so it can't be misread; the Top-lab-pick cross-reference follows after a `|`. Display layout only.

## [1.1.37] — 2026-06-17

### Changed
- **Renamed the brief card's "Best fit" cross-reference to "Top lab pick".** On a pick whose recommended structure isn't the single highest-scoring lab structure, the card shows that top structure as an FYI (e.g. a Big Lizard on a wheel CSP card). "Best fit" implied it was a *better* choice for the strategy; it's actually just the highest-scoring structure overall for the ticker across all strategies. "Top lab pick" reads as informational, not a competing recommendation. Display-label only.

## [1.1.36] — 2026-06-17

### Fixed
- **The Daily Brief's Payoff/Options buttons now load the recommended structure, not the best-overall one.** On a pick whose recommended trade isn't the single highest-scoring lab structure, `PickNavRow` used `scores[0]` (the best-OVERALL structure across all 31 strategies) for the Payoff visualizer and the Options expiry — so clicking **Payoff** on a wheel **CSP** pick (AMD $470 / \$2,305) loaded a **Big Lizard** (\~\$6,200) instead. This affected wheel, income, buy, and **inflection** (the v2 launch strategy — its Payoff loaded a Big Lizard rather than the bull-put credit spread). The nav row now resolves the structure via the same `pickDisplayStructure(scores, strategy, breakoutDirection)` selector the card uses, so Payoff/Options/legs match the recommended trade shown on the card.
- **The brief card's setup line is now labeled with its structure.** The `strike · expiry · premium` line describes the *relevant* structure (e.g. the CSP), but it visually trailed the "Best fit: Big Lizard A+" tag, making it ambiguous which structure the `$470 / $2,305` belonged to. It's now prefixed with the structure name (`CSP: $470 · Jul 17 · $2305.00 cr`).

### Notes
- Renderer-only change — **no brief re-run needed**; relaunch the app and the persisted brief renders correctly. The relevant-structure selector (`pickDisplayStructure`) is covered by `tests/strategy-structures.test.ts`; this routes the nav row through it (same pattern as the v1.1.30 inflection-direction fix). Found via user report (wheel AMD).

## [1.1.35] — 2026-06-17

### Fixed
- **The critic no longer calls a bounded short-put loss "unlimited/uncapped" — it now cites the precomputed max loss.** The critic's structure context omitted `maxProfit`/`maxLoss`, so on every bullish big-lizard the LLM described the short-put downside as "uncapped … nearly unlimited" — technically wrong: a short put's loss is **bounded** (worst case at underlying → 0), and the figure was already computed (e.g. AMD −\$44,836, ALAB −\$29,931). Only a naked short **call** is truly unbounded. The critic context now carries `structure.maxProfit` / `structure.maxLoss` (per-contract ×100; `null` ⇒ genuinely unbounded — naked short call) and `structure.breakevens`, and the prompt instructs the model to cite these for any reward/risk or max-loss statement and to never call a finite `maxLoss` "unlimited/uncapped". Same remediation pattern as the precomputed expected-move (v1.1.31) and IV (v1.1.20/29) — a number the critic reasons about must be given, not invented. This also lets the critic affirm the **defined-risk max loss** on inflection credit spreads (the v2 launch structures).

### Notes
- Rationale-accuracy only — no rule check, gate, or trade selection changed (the deterministic defined-risk preference already used `maxLoss`; this only surfaces it to the LLM). The bounded-short-put / unbounded-short-call facts are covered by `classifySingleExpiryPnl` tests (`tests/strategy-lab-service.test.ts`). The persisted 2026-06-17 brief keeps the old wording; **re-run the brief** for rationales that cite the real max loss.

## [1.1.34] — 2026-06-17

### Fixed
- **ATM (0.50-delta) structure bodies are now centered on spot, fixing a silent directional skew from stale E\*Trade Greeks.** The neutral body legs of straddles / iron-flies (income) and big-lizards (bullish) target 0.50 delta, but E\*Trade can serve deltas computed at an old spot whose deviation still slips under the `trustDeltas` 8% guard — e.g. on the 2026-06-17 brief MRVL's delta-implied ATM was \$300 vs spot \$278.67 (7.65%), so the "neutral" iron-fly/big-lizard body was placed at \$300, **7.7% above spot** (an ITM short put that needs a rally to profit). The critic flagged this on nearly every income/bullish pick (AMD \$520/+2.5%, COHR \$400/+4.5%, Z \$35/+5.2%, ALAB \$380/+5.1%). `findByDelta` now selects `deltaTarget ≈ 0.50` legs by **moneyness** (the strike nearest spot — correct for ATM by definition and robust to stale Greeks); OTM-wing selection (0.16/0.20/0.05 delta) is unchanged. This re-centers the income iron-flies and bullish big-lizards on spot.
- **The degenerate-spread guard is now expiration-aware.** With ATM bodies selected by moneyness, a calendar's two 0.50-delta legs legitimately land on the same strike (different expirations) — the guard compared strike only and falsely rejected them as degenerate. It now requires same strike **and** same expiration, so calendars/diagonals build correctly while a real same-expiry collision (mislabeled condor) is still caught.

### Notes
- Structure-quality fix on already-selected picks — **ticker selection is unchanged** (income/bullish composites come from `analysis-service` signals, not the lab structures), so it's neutral on Brief Replay by construction (no FR-SEY-5 gate). Income/bullish are decision-support (not in the v2 inflection-only launch scope). The persisted 2026-06-17 brief keeps the skewed bodies; **re-run the brief** for centered structures. Regression coverage in `tests/strategy-lab-service.test.ts` (`findByDelta` ATM-by-moneyness vs stale delta; calendar same-strike build).

## [1.1.33] — 2026-06-17

### Fixed
- **ADX is no longer ~14× too large (Wilder average, not sum).** `analysis-service.computeADX` reused the Wilder running-**sum** helper for the final ADX step and never divided by `period` — correct for the +DI/−DI ratios (the sums cancel) but wrong for ADX, which is the **average** of DX. So ADX came out an impossible ~648 for AMD (true ~46), saturating the trend signals and surfacing "trendNeutral score of 630" in a brief rationale. Fixed by `÷ period` (the exact Wilder ADX recursion); ADX is now bounded [0, 100]. The companion `daily-technical-signals-job.computeADX` was already correct.

### Changed
- **ADX removed from composite scoring (FR-SEY-5 validated).** A full-year Brief-Replay A/B (the corrected ADX fed into scoring vs absent) showed enabling it is **net-negative on every strategy that uses it** — bullish **−1.50pp**, bearish **−1.15pp**, income **−0.43pp** on direction-aware forward returns, with lower hit-rates — because strong-trend (high-ADX) names mean-revert over the next ~21 days. The live brief was *accidentally protected* because the 14× bug saturated the signal to a non-discriminating constant, so naively shipping the arithmetic fix would have silently degraded those strategies. `ScoringService.USE_ADX_IN_SCORING = false`: `trendStrength` (bullish) and `downtrendScore` (bearish) now use only their MA-stack component, and income's `trendNeutral` goes missing — the validated-best state (≈ prior behaviour; replay never fed ADX into scoring). The corrected ADX is retained for **display only** (Validate dashboard, Analysis view).

### Notes
- Net effect on the brief: bullish/bearish/income rankings unchanged-or-better, no more "ADX 630", and the "fixing the bug silently hurts" trap is defused. Buy/wheel/inflection never used ADX (unaffected). The A/B harness `tests/adx-replay-validation.test.ts` (gated behind `RUN_ADX_AB`, ADX-on arm via `REPLAY_WITH_ADX`) stays for future re-validation. see `docs/formulas.md#adx`.

## [1.1.32] — 2026-06-16

### Changed
- **One canonical ATM-IV definition shared by the lab and the live E\*Trade provider — the provider no longer uses a "closest call only" measure.** An audit of the 2026-06-16 brief flagged AMD reading **70.27%** ATM IV in the brief/critic vs **81.83%** in `quote_cache`. Investigation showed the bulk of that gap is a legitimate *tenor* difference (the brief measures its ~30-DTE expiration; the chain-view value measures the **nearest** expiration, which spikes hardest on AMD's −7.3% day) — **the brief was correct and never reads the chain-view value.** But it also surfaced a real definitional inconsistency: `etrade-data-provider.getOptionsIV` computed ATM IV from the **closest call only**, while the lab (`computeAtmIv`) and `iv_history` use the **call+put average** at the closest strike, so the same expiration could read differently by the put/call skew. Both now share the single pure `atmIvAtClosestStrike(items, underlyingPx)` (`src/main/services/iv-utils.ts`) = average IV of every contract at the strike nearest spot. The lab's number is **unchanged** (the helper replicates its prior call+put average exactly); the E\*Trade chain-view / dashboard / screener IV now includes the put side. No trade-logic or brief change — the brief/critic path was already self-consistent on the 30-DTE value. see `docs/formulas.md#atm-iv`.

### Notes
- Affects display surfaces only (options-chain view, Morning-Briefing dashboard, screener wheel metrics, `quote_cache.current_iv`); the brief, critic, IV-rank, and execution paths are untouched. Regression coverage in `tests/iv-utils.test.ts` (call+put average vs calls-only, nearest-strike selection, unit pass-through, null/empty guards).

## [1.1.31] — 2026-06-16

### Fixed
- **The critic no longer computes the expected 1-sigma move itself — it now cites a precomputed value, fixing rationales that overstated the move by 40–85%.** The critic prompt handed the LLM the formula (`impliedVolPct × √(dte/365)`) and asked it to compute the expected/1-sigma move; the model's manual arithmetic was unreliable, routinely overstating it on the 2026-06-16 brief — **AMD** (wheel) "the 1-sigma downside move … is roughly ±\$149 (~29%)" when the true figure is **±\$104 (20.5%)** (70.271% IV, 31 DTE, \$507.29 — confirmed against live data); **MRVL** (bullish) "~\$152" vs the true **±\$82 (29.5%)**. This is the same class of error as the IV fabrication already eliminated from the volatility context (v1.1.20/29): a number the critic reasons about numerically must be *given* to it, not derived. The expected move is now precomputed via the exported pure `expectedOneSigmaMove(impliedVolPct, dte, price)` and passed in `volatility.expectedMove1SigmaPct` / `expectedMove1SigmaUsd`; the prompt instructs the model to cite the provided numbers verbatim and **never** compute the move itself (and to skip expected-move reasoning entirely when they're absent). see `docs/formulas.md#expected-move`.

### Notes
- Rationale-accuracy only — no rule check, gate, or trade selection changes; the deterministic rule layer never relied on the LLM's move estimate. The persisted 2026-06-16 brief still carries the old (LLM-computed) rationales; **re-run the brief** for rationales that cite the precomputed move. Regression coverage in `tests/critic-service.test.ts` (AMD ±\$104/20.5%, MRVL ±\$82/29.5%, null-IV/zero-DTE → no move).

## [1.1.30] — 2026-06-16

### Fixed
- **Inflection structure selection is now LOCKED to the breakout direction, so an up breakout can never surface a bearish bear-call spread.** Inflection's two relevant verticals are direction-opposite (bull-put `short-put-vertical` for an up breakout, bear-call `short-call-vertical` for a down breakout) and **both are always constructible on any chain**. `pickRelevantStructure` chose the *higher-graded* of the two — so on the 2026-06-16 brief **MCHP** (an UP breakout, `breakout_state = 1`) surfaced a **short-call vertical** because the bear-call (A+, 94) out-graded the bull-put (A+, 93) by a single point. The advocate rationale even flagged it ("notably this is a call-side structure, implying bearish inflection") — a bearish trade recommended on a bullish breakout. This is the v2 launch strategy (real-money path), and it diverged from how **Brief Replay / Backtest** (`simulateSingleSpread`) already select the spread (up → bull-put, down → bear-call). Selection now narrows to the breakout-side slug via a new shared `relevantSlugsForPick(strategy, breakoutDirection)`; the breakout side is persisted on each pick as `BriefPick.breakoutDirection` (`'up'`/`'down'`, set from `technical_signals.breakout_state`) so the advocate, critic, PDF/email report, and Daily Brief card all lock to the **same** direction-matched structure. The brief's liquidity gate (`getBestLiquidityScore`/`hasAdequateLiquidity`) is direction-aware too, so it evaluates the structure actually recommended. Defaults to `'up'` (the launch/default config — down breakouts are off by default) when direction is absent, and surfaces **nothing** rather than the opposite-side trade if the breakout-side vertical is unavailable.

### Notes
- **Ticker selection is unchanged** (composite-driven, independent of lab grade) — only the structure shown per already-selected inflection pick changes, so this is neutral on Brief Replay returns by construction (no FR-SEY-5 gate). It in fact brings the live brief into line with the direction-locked spread the backtest already simulates. The persisted 2026-06-16 brief still holds the old (grade-locked) structure; **re-run the brief** for MCHP to show its correct bull-put vertical. Regression coverage in `tests/strategy-structures.test.ts` (MCHP up-breakout, down-breakout lock, up-default, unavailable-side → null).

## [1.1.29] — 2026-06-16

### Fixed
- **The critic now sees the full structure (all legs), not just the short strike.** The advocate was given the complete leg list (v1.1.23) but the critic's LLM context still passed only the single short-leg `strike`, so on multi-leg structures the critic misread the trade — on the latest brief it called a **put zebra**'s $35 financing short leg a lone in-the-money strike and flagged an "inconsistency" against the advocate's fuller "$37.5/$35" description (LBRDK, EL). The critic context now carries `structure.legs` (e.g. `["buy 2× put $37.5", "sell put $35"]`) via a single shared `formatStructureLegs` used by both the advocate and the critic — so both reason about the same complete structure, with leg quantities shown for ratio structures (zebra/butterfly bodies). The old single short strike is retained as `shortStrike`/`strikeOtmPct`.
- **The critic no longer mistakes the advocate's "recent volatility" for an implied-vol discrepancy.** The advocate cites the realized-vol scoring signal (e.g. ASTS "recent volatility 138.7"); the critic only had `impliedVolPct` (111.6) and flagged a phantom "unexplained IV discrepancy," inflating the verdict to `flag`. `extractVolatilityContext` now also surfaces `volatility.realizedVolPct` (the recentVolatility signal), and the prompt states it is realized vol — a momentum signal, expected to differ from implied vol — so the gap is not treated as an error. Residual of the v1.1.20 IV-conflation class, from the advocate-number angle.

### Notes
- Critic-context completeness only — no risk was hidden and no recommendation changed; these removed muddled reasoning and ~1 phantom flag. The persisted brief carries the critic verdicts from its generation run; **re-run the brief to get verdicts from the improved context.**

## [1.1.28] — 2026-06-16

### Fixed
- **Structure P&L is now computed from the actual expiry payoff, fixing wrong max-profit on debit verticals and dangerously understated max-loss on butterflies.** `classifySingleExpiryPnl` previously classified by leg signature, which broke two ways the defined-risk/directional preferences (v1.1.25/27) newly surfaced: **(a)** long/*debit* verticals (`long-put-vertical`, `long-call-vertical`) used a wrong-sign width → **negative max profit** (GPN −698.75, EL −753.75; should be +301.25 / +246.25) and a breakeven off the wrong leg; **(b)** 3-leg **butterflies** fell through the 2-leg branch and reported max loss as just the debit, **understating the true risk ~5–30×** on the broken-wing flies the lab builds (ARE reported −$8.75, true −$258.75; FLUT −$115, true −$615). It now evaluates the position's piecewise-linear payoff (entry cash flow + each leg's intrinsic at every kink), taking extrema for max profit/loss and sign-changes for breakevens, with explicit unbounded detection (net-short calls → `null` loss, net-long calls → `null` profit; puts always bounded since S ≥ 0). This prices verticals (both orientations), balanced and broken-wing butterflies, condors, lizards, and ratio/zebra structures correctly, and surfaces breakevens the old code missed (e.g. a big lizard's upper breakeven). Iron condors/flies and the calendar/PMCC diagonal branch are unchanged.
- **Debit reward/risk now uses the actual max loss, not the debit paid.** The lab's premium score for debit structures divided max profit by `netDebit`; for a broken-wing butterfly the true max loss exceeds the debit, so this overstated attractiveness. It now divides by `|maxLoss|` (equal to the debit for a simple vertical, larger for a broken-wing fly), so the corrected risk flows into the grade.
- **Degenerate spread wings are rejected.** When a spread's long and short legs on the same side collapse to the *same strike* (no further-OTM strike available — observed on an ASTS "iron condor" built sell-call \$100 / buy-call \$100, really a mislabeled put spread), the structure is now marked unavailable instead of presenting a phantom wing.

### Notes
- Ticker selection is unchanged (composite-driven). The corrected max-loss/max-profit do shift some lab **grades** (directional debit verticals up; broken-wing butterflies to an honest, lower reward/risk), but only the structure shown per already-selected pick — neutral on Brief Replay by construction, no FR-SEY-5 gate. The persisted 2026-06-16 brief still holds the old values; **a fresh brief run is needed for the corrected figures to appear.**

## [1.1.27] — 2026-06-16

### Changed
- **Directional strategies now de-prioritise narrow-range "pin bet" butterflies in favour of directional structures.** A put/call butterfly only pays off if the underlying lands in a tight window at expiry (low probability of profit), so it's a poor expression of a directional bullish/bearish thesis — yet because butterflies can post a high reward/risk score, the defined-risk preference (v1.1.25) was surfacing them as the recommended structure (e.g. 3 of 5 bearish picks on the 2026-06-16 brief). `pickRelevantStructure` now, for directional strategies (bullish/bearish/buy), prefers a directional structure over a butterfly — **but only when a reasonably graded (≥ C) directional alternative exists**; it keeps the butterfly when the only directional options are badly priced (D/F), so it never trades a viable structure for a broken one. On the 2026-06-16 bearish brief this switches LBRDK (put-butterfly A → poor-man's-covered-put B, directional) while correctly keeping ARE/FLUT's C butterflies (their only directional alternatives were grade F). No-op for income (range-bound — iron flies/condors are appropriate) and inflection/wheel.
- **Ticker selection is unchanged** (composite-driven, independent of the lab structure), so this is neutral on Brief Replay returns by construction — same picks, only the structure-per-pick differs. No FR-SEY-5 gate (verified on the live 2026-06-16 brief: only one pick's structure changed, no ticker/order change).

## [1.1.26] — 2026-06-16

### Fixed
- **Brief `valid_until` is now based on the ET calendar date and is DST-correct.** `nextTradingDayOpen()` had two date bugs. (1) It computed the next trading day from the **UTC** date of `generated_at`; for an evening-ET run (already "tomorrow" in UTC — e.g. a Monday 8:57pm EDT brief is `00:57Z` Tuesday) it skipped a trading day, so the brief was marked valid until Wednesday instead of Tuesday. It now keys off the **ET** calendar date. (2) It hardcoded 9:30 ET as `13:30Z`, which is correct only under EDT — all winter (EST) 9:30 ET is `14:30Z`, so `valid_until` was an hour early. It now derives the ET↔UTC offset for the target date. Cosmetic-only (affects the "valid until" label / auto-supersede timing, never pick data), surfaced while reviewing overnight-run behavior. Regression test: `tests/next-trading-day-open.test.ts` (+6: evening-ET no-skip, winter EST instant, weekend/holiday skips, host-TZ independence).

## [1.1.25] — 2026-06-16

### Changed
- **The Brief now prefers defined-risk structures over unbounded-risk ones when a viable alternative exists.** `pickRelevantStructure` partitions a strategy's relevant validated structures into defined-risk (finite `maxLoss`) vs unbounded (`maxLoss === null` — naked short call, strangle/straddle, reverse lizard) and presents the best **defined-risk** one, falling back to the unbounded set only when no capped-risk structure is viable. Real-money safety: the brief never *recommends* an unlimited-risk structure when a capped-risk alternative is on the table. On the 2026-06-16 brief this shifts **income** picks from short straddles/strangles to iron flies/condors (4 of 5; all still A+/B grade) and — combined with the v1.1.24 unbounded-maxLoss fix — **bearish** reverse-big-lizards to long put verticals. It is a **no-op for inflection/wheel/bullish/buy**, whose relevant structures are already all defined-risk (the v2 execution engine, inflection-only, is unaffected).
- **All four brief structure selectors are now unified on the shared `pickRelevantStructure` / `pickDisplayStructure`** (critic, advocate, `DailyBriefView`, `brief-report-builder`). Previously each had subtly different ad-hoc logic (first-relevant vs max-score vs first-valid), so the card, the email/PDF, and the critic could feature *different* structures for the same pick. Now the displayed structure always matches what the critic evaluated.

### Notes
- **Ticker selection is unchanged.** Composite scores (which tickers are picked and in what order) come from the scoring engine, independent of the lab structure/grade; this change only swaps *which structure* is shown per already-selected pick. Brief Replay outcomes are ticker-return-based and therefore unaffected — so this is neutral on the historical sample by construction (no FR-SEY-5 trade-selection delta to validate). Verified on the 2026-06-16 brief: same tickers, same order, only the structure-per-pick changed.

## [1.1.24] — 2026-06-16

### Fixed
- **Reverse Big Lizard / Reverse Jade Lizard now report their unbounded risk honestly.** These structures pair a short put *spread* with a **naked short call**, so the upside loss is unlimited. `buildSetup` mis-classified them into the bounded-risk branch and reported `maxLoss` as the small put-spread residual — e.g. FLUT's bearish #1-ish pick showed **max loss −$11.25** and an **annualized return of 100,248%** on a position that can lose without bound (LBRDK 15,154%, ARE a *positive* +$43.75 "max loss"). The P&L classifier now returns `maxLoss = null` (unbounded) for any naked-short-call structure, which cascades correctly: `annualizedReturn` becomes `null` (capital is undefined). The single-expiration P&L logic was extracted into a pure, exported `classifySingleExpiryPnl()` with direct unit coverage of every branch. **Ranking is unchanged** — the structure's `premiumScore` falls back to the short-put-strike capital basis (line 614–616), which yields the same score band, so this is a risk-display correctness fix, not a scoring change (no FR-SEY-5 gate). Found in the 2026-06-16 brief audit. See `docs/formulas.md#structure-pnl`.

## [1.1.23] — 2026-06-15

### Fixed
- **Critic is no longer structure-blind on inflection (the v2 launch strategy).** The critic's copy of the strategy→relevant-structure-slug map (`STRATEGY_RELEVANT_SLUGS` in `critic-service.ts`) had drifted from the brief job's and was **missing the `inflection` entry**. So `selectRelevantStructure()` returned null for every inflection pick: the LLM context carried *no structure*, the structure-aware rule checks (liquidity, grade) silently skipped, and the `if (strategy === 'inflection')` direction branch was dead code. With no structure, the critic invented a non-existent straddle and reasoned **backwards** — warning that high IV made options "severely overpriced" for *buying*, when the actual `short-put-vertical` *sells* premium (high IV is favorable). Found in the 2026-06-16 brief audit (AMD inflection critic literally said *"the absence of a `structure` field means no specific trade parameters exist to evaluate"*).
- **All four copies of the strategy→slug map are now one shared source of truth** (`src/shared/strategy-structures.ts`, imported by the critic, brief job, report builder, and `DailyBriefView`). This is the drift class that caused the bug above. `tests/strategy-structures.test.ts` asserts every `ScoringStrategy` is covered (the guarantee the critic lacked) and that `pickRelevantStructure` resolves an inflection structure.
- **The advocate (Stage-5 rationale) now describes the actual trade, not an invented one.** It previously received only ticker/strategy/score/signals — no structure — so it guessed the structure from the strategy name. For inflection it recommended "straddle sells / iron condors / directional calls" (the inverse of the real bull-put credit spread) and argued high IV was bad. It now gets a compact `structure` summary (type, credit-vs-debit with the IV implication spelled out, and legs) and is instructed to base the rationale on it and never suggest a different structure.
- **`counter_trend_itm_strike` critic flag no longer false-fires on bearish debit verticals.** The rule judged the first `sell` leg of the structure; for a `long-put-vertical` (a defined-risk *debit* spread) that leg is the lower short put, which correctly sits *below* spot. The rule mislabeled a 7–11% **OTM** short put as "at/in the money — zero cushion" (GPN, EL on the 2026-06-16 brief), and both critics burned their entire rationale rebutting the bad flag. The rule now evaluates only the rally-exposed **short call** (skipping structures without one), and the contradictory "(at/in the money)" wording is gone. Regression test added; existing counter-trend tests updated to model the short call explicitly.

## [1.1.22] — 2026-06-15

### Fixed
- **Morning Briefing market regime now reads the real VIX.** `BriefingService.getMarketRegime()` fetched VIX via `dataProvider.getQuote('VIX')` — Polygon's *stocks* snapshot, which can't serve an index, so it always returned null (and burned a rate-limited API call each call). It now reads VIX from `quote_cache`, where the brief job's `refreshVixQuote()` writes the E*Trade-sourced value (v1.1.21). So the dashboard's `vixValue`/`vixLevel` and regime summary reflect the actual VIX, consistently with the critic. Completes the VIX migration — both consumers now use one E*Trade-sourced value. Regression test: `briefing-service.test.ts` (+3; asserts `getQuote('VIX')` is never called and the level is classified from `quote_cache`).

## [1.1.21] — 2026-06-15

### Added
- **VIX is now wired into the critic's macro context (E*Trade).** Follow-up to the v1.1.20 audit's documented VIX gap. The brief job's new `refreshVixQuote()` fetches VIX via E*Trade `/v1/market/quote/VIX` (`getETradeLastPrice` in `etrade-options.ts`), sane-range-validates it (`[5,150]` — a quote typo can return an unrelated symbol), and upserts it into `quote_cache` (ticker `'VIX'`) before the critic stage runs; `CriticService.getMarketContext()` reads it there. This re-activates the two previously-dormant VIX rules (wheel/income caution at VIX>30, bearish complacency at VIX<14) and fills the macro "fear/complacency regime" context. **Fail-closed at every step** — no E*Trade creds, fetch error, out-of-range value, or wrong account index symbol leaves `quote_cache` untouched and the critic keeps its safe null-VIX behavior. The fetched value is surfaced in `runMeta.vix` so the operator can verify it against the real VIX on the first run (**the E*Trade index symbol `'VIX'` is unverified offline**). Tests: `critic-service.test.ts` (+3: reads populated VIX, wheel fear rule fires at VIX>30, dormant when null).

### Verified (no change needed)
- **The advocate rationale does not fabricate volatility.** Audited all 30 picks (`scripts/advocate-rationale-audit.mjs`): every number the advocate cites maps to a real scoring signal it was given (`0/30` cite a vol figure without an IV/vol signal). This also explains the v1.1.20 critic "140.8% IV": that's the wheel `recentVolatility` **signal** (140.8, realized vol), which the advocate correctly labels "recent volatility 140.8" — the **critic** received it via `advocateRationale` and mislabeled it as *implied* volatility. The v1.1.20 F1 fix (real `impliedVolPct` + forbid inventing/relabeling vol) addresses exactly that conflation.

### Note
- `briefing-service.getQuote('VIX')` (a separate market-summary consumer) still uses the broken Polygon stocks-snapshot path and is **not** migrated to read `quote_cache` — left as a follow-up.

## [1.1.20] — 2026-06-15

### Fixed — daily-brief accuracy audit (pre-real-money)
- **Critic no longer fabricates volatility figures.** The critic's LLM context carried **no** implied- or realized-vol field, yet its system prompt instructed the model to compute an "expected 1-sigma move (annualized vol / sqrt(365/dte))." With nothing to anchor to, the model **invented** precise vol numbers shown to the user as risk rationale (e.g. MRVL wheel cited "140.8% implied volatility" against the true 104.7% ATM IV; RKLB "~108% realized," ASTS "~139%"). Now `extractVolatilityContext()` feeds the real `{ impliedVolPct, ivRank }` from the lab context, the prompt uses that field for all expected-move reasoning, and it **forbids** citing any volatility figure not provided (null → "could not be measured"). Rationale-accuracy only — no change to which trades are taken. Tests: `critic-service.test.ts` (+3).
- **Breakeven-distance is now strike-aware.** `breakevenDistancePct` was `|netCredit| / price`, which equals the breakeven distance only for an **at-the-money short straddle**; for short strangles, iron condors, and OTM-strike CSPs the short strikes sit away from spot, so it understated the true breakeven ~10× (MRVL iron condor read **2.3%** vs the real **~28%**) and made the critic falsely flag structurally-wide condors `thin_breakeven`. Replaced with an exported pure `breakevenDistancePct(legs, netCredit, price)` that computes the distance to the nearest `shortStrike ± credit` using only the short legs (long wings cap loss, not breakeven). Fixes both the LLM context value (income) and the `thin_breakeven` rule (income/wheel). Tests: `critic-service.test.ts` (+8); `docs/formulas.md#breakeven-distance` rewritten.
- **Brief diagnostic `scripts/brief-deep-dive.mjs` repaired.** The script used to vet a brief before relying on it was itself unreliable: it crashed on a stale `analysis_snapshots` schema, printed `undefined` in its verdict summary (read `f.rule`; flags carry `f.key`), displayed `scores[0]` (the overall top structure) instead of the strategy-relevant one — which made bearish picks *look* like they had bullish structures — and omitted the 6th `inflection` strategy entirely. Now shows the actual presented structure, includes all six strategies, fixes the freshness query (`technical_signals`), and adds a "no relevant structure" anomaly check.

### Known gap (documented, not yet fixed)
- **VIX is always null** in the critic's macro context. Nothing writes a `'VIX'` row to `quote_cache`, and the only fetch hits Polygon's *stocks* snapshot for ticker `VIX` (an index = `I:VIX`, an Indices-plan ticker the Stocks Starter plan lacks). The macro context is SPY-trend-only and the two VIX critic rules (wheel/income VIX>30, bearish VIX<14) are dormant — fail-safe (null → rules skip). A real fix needs a verified index-quote source (E*Trade `/market/quote` or a Polygon Indices plan) and is deferred until live-verifiable. Documented in `CLAUDE.md` Known quirks + `.ai/AI_CONTEXT.md §10`.

### Not changed (validated, deliberately left alone)
- Bearish picks can surface on stocks in short-term uptrends (lab `directionBias: bullish`, `trend: Sideways/Bullish`) driven by fundamental-weakness + the `rsiOverbought` signal saturating below RSI 70. This is a **validated** characteristic of the bearish ≥70 composite (real short edge on full-year replay), an overbought guard was already tested and **rejected** on the same sample (FR-SEY-5), and the critic surfaces the risk (`elevated_market_risk`, `counter_trend_itm_strike`). Not re-engineered.

## [1.1.19] — 2026-06-15

### Fixed
- **Premium-history wheel rows now label covered-call fallbacks as `CC`, not `CSP`.** The wheel analysis (`findSuitableChain`) recommends a cash-secured put when one exists in the 0.20–0.30 delta band, and otherwise **falls back to a covered call** in the same band (intended behavior — both are valid wheel legs). But `wheelResultToRow` hardcoded `structure: 'CSP'`, so ~12% of daily wheel picks (the CC fallbacks, concentrated in lower-priced names whose coarse strike grid has no put in the tight band — e.g. AA, ACGL) were recorded as `CSP` in `options_premium_history`. That would corrupt the future CSP-vs-CC return-on-capital analysis the table exists to enable. The structure is now derived from **delta sign** (put ≤ 0 → `CSP`, call > 0 → `CC`; null delta → `CSP`) — robust because sign is fixed by option type, surviving E*Trade's stale-greek magnitude drift, and `findSuitableChain` guarantees a non-null delta on any real recommendation. No trade-logic change: the recommendation itself is untouched, only its recorded label. Self-heals already-persisted rows on the next capture. Regression tests in `tests/options-premium-history.test.ts` (+2: positive-delta → CC, null-delta → CSP). `docs/formulas.md#wheel-structure-label`.

## [1.1.18] — 2026-06-14

### Fixed
- **🤝 Execution views now scroll — the Execution Settings Save button was unreachable.** `.main` is `overflow: hidden`, so each view must manage its own scroll; the Trading Desk and Execution Settings root divs didn't, so on shorter windows the tall Settings form (and its Save/Revert buttons) was clipped with no scrollbar. Both view roots now fill and scroll (`flex: 1; min-height: 0; overflow-y: auto`) — same pattern as the v1.1.11 sidebar fix. CSS-only; no testable unit.

## [1.1.17] — 2026-06-14

### Added
- **v2 execution — inflection-direction guard (FR-SEY-3 follow-up, execution layer).** Completes the "both, configurable" rollout: the execution engine now also refuses to propose the validated-losing inflection side. Migration **051** adds `exec_config.inflection_direction` (`'up'` default / `'down'` / `'both'`, CHECK-constrained). `EntryPolicy.filterPick` rejects an inflection pick whose breakout direction isn't allowed (`short-put-vertical` = up, `short-call-vertical` = down) with reason `inflection_direction`. Mapped in `RiskGovernor` config; editable in 🤝 Execution Settings → Mode. So whether picks come from the brief (app `inflectionDirection` setting) or the engine's own entry policy (`exec_config`), the same up-only-by-default policy holds. Tests: `entry-policy.test.ts` (+2: default rejects down, `'both'` accepts). Full suite 459 green.

## [1.1.16] — 2026-06-14

### Changed
- **Inflection is now up-breakout-only by default (configurable) — strategy layer.** The FR-SEY-3 follow-up validated (on authoritative `simulateSingleSpread` P&L) that down-breakout/bear-call inflection is a net loser (−1.4%/trade) while up-breakout/bull-put is solidly profitable (+6.1%, 76% win). A new **`inflectionDirection`** app setting (`'up'` default / `'down'` / `'both'`) gates which breakout sides the scoring engine surfaces: `ScoringService.hasBreakout` honours it, so both the **Daily Brief** and **Brief Replay** (both score via `scoreFromSignalData`) stop recommending the losing bear-call side. Set it in **⚙ Settings → General**. Refreshed once per scoring pass (runtime changes apply without restart). Wired through `AppSettings` + `settings:get-all/set-all`. Regression tests in `tests/inflection-scoring.test.ts` (default gates down to 0; `'both'` re-enables; `'down'` gates up to 0). Full suite 457 green. (Execution-engine guard for the same setting lands next.)

## [1.1.15] — 2026-06-14

### Added
- **v2 execution — FR-SEY-1: sector-concentration cap (Seykota diversification).** Caps concurrent open positions sharing a correlation bucket so "five semiconductor spreads" count as one bet, not five — a gap the count caps (5 concurrent, 1/ticker) couldn't see. Bucket = SPDR sector ETF, derived from `fundamentals_cache` via `sectorStringToEtf` (coarse enough that "semiconductors" and "electronic computers" both map to XLK); unmapped names stay uncapped. **Default OFF** (`maxPositionsPerSector = null`). Migration **050** adds `exec_config.max_positions_per_sector`. New pure `per_sector` check in `evaluateGate` (skipped when off); `risk-governor` resolves sectors from `fundamentals_cache` only when the cap is enabled. Extracted the sector→ETF mapper into a shared `src/main/services/sector-etf.ts` (was private in `scoring-service.ts`) so both the scorer and the governor use one source. Exposed in Execution Settings → Risk limits. Tests: `risk-gate.test.ts` (+2) and `risk-governor.test.ts` (+3); full suite 455 green. Ships disabled by default per FR-SEY-5 (a conservative concentration limit, not an edge claim).

## [1.1.14] — 2026-06-14

### Added
- **v2 execution — FR-SEY-2: drawdown-scaled risk (Seykota "equity-curve money management").** The risk governor now tracks a **closed-equity high-water mark** and, when drawdown from it reaches `drawdownThrottlePct`, multiplies the effective per-trade risk by `drawdownThrottleFactor` (e.g. 0.5 = half size) until the curve recovers — a graduated step between "normal" and the binary daily kill switch. **Default OFF** (`drawdownThrottlePct = 0`), so behaviour is unchanged until the operator opts in (Execution Settings → Risk limits). Migration **049** adds `exec_config.drawdown_throttle_pct`/`_factor` and `exec_risk_state.equity_high_water` (seeded to the ceiling, ratchets up only). Pure helper `drawdownThrottleFactor()` in `risk-gate.ts`; the gate's `per_trade_risk` check uses a new optional `effectiveMaxRiskPct`; `risk-governor` computes drawdown (closed-equity, to avoid unrealized-swing thrash), applies the throttle in `sizeEntry` + `checkEntry`, and exposes `drawdownPct` on the engine state view. The Trading Desk shows drawdown + HWM + throttle status. Tests: `risk-gate.test.ts` (+5) and `risk-governor.test.ts` (+4); full suite 450 green. Per FR-SEY-5 it ships **disabled by default** (a conservative size-reducer, not an edge claim — enabling is the operator's risk choice).

## [1.1.13] — 2026-06-14

### Changed
- **Moved 🔔 Alerts into the 🗂️ Misc landing screen.** Alerts was a standalone button under the Personal section; it's now a card on the Misc screen alongside Backtest / Test API / Data Sync / History, further trimming the sidebar. The 🗂️ Misc button highlights while Alerts (or any other Misc tool) is open. AlertsView and its IPC are unchanged.

## [1.1.12] — 2026-06-14

### Changed
- **Decluttered the sidebar: the Misc section is now a single 🗂️ Misc entry** that opens a landing screen with the four occasional tools as cards — **Backtest**, **Test API**, **Data Sync**, **History** (`src/renderer/src/views/MiscView.tsx`). Selecting one pushes it onto the nav stack, so a **← Back** returns to the Misc screen. The Misc sidebar button highlights while any of those four views is open. No functionality removed — the views and their IPC are unchanged; only the navigation path changed.

## [1.1.11] — 2026-06-14

### Fixed
- **Sidebar now scrolls when the menu is taller than the window.** The nav lives in a single `.nav-section` inside `.sidebar` (which is `overflow: hidden`), so on shorter windows the bottom items (Misc → History, and the new Execution section) were clipped and unreachable. `.nav-section` now fills the sidebar and scrolls (`flex: 1; min-height: 0; overflow-y: auto`) — `min-height: 0` lets the flex child shrink below its content height so the overflow scrolls instead of clipping. CSS-only; no testable unit (visual layout fix).

## [1.1.10] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5c/d (control panel UI), completing Phase 5.** New **🤝 Execution** sidebar section with two Electron views, both driving the (mock-backed) engine through `window.api.execution.*`. **Trading Desk** (`src/renderer/src/views/TradingDeskView.tsx`): master header with PAPER/LIVE badge + engine-state pill; Engine panel (Start/Pause/Stop — master Stop = hard stop — + broker/health/last-cycle); Kill Switch panel (status + Trip/Clear); Capital panel (deployed-vs-ceiling gauge, day P&L, trip threshold); proposals queue with Approve/Reject (**paper = 1-click, live = type-to-confirm**); open-positions table; activity log off the audit trail. Live-updates via `execution:event` + a 15 s poll fallback. **Execution Settings** (`src/renderer/src/views/ExecutionSettingsView.tsx`): an editor over the `exec_config` row (`getConfig`/`updateConfig`) grouped into Mode / Risk limits / Entry policy / Exit policy, with dirty-tracking, Save/Revert, and a confirmation gate on switching to live mode. `src/renderer/src/App.tsx` adds the section, `View` union entries, and `renderEntry` cases. No new automated tests (renderer views; underlying engine/IPC already covered — full suite green, 441). No auto-generated entries yet (brief→`PickInput` lands with Phase 6); the desk otherwise reflects live engine state. The product is now demonstrable end-to-end without IBKR.

## [1.1.9] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5b (activation).** The first **non-dormant** step: `ExecutionEngine` is now instantiated in `src/main/index.ts` against the deterministic `MockExecutionBroker` and starts `stopped` (constructing it opens no broker connection and places no orders), and its event stream is forwarded to the renderer (`webContents.send('execution:event', …)`). New `src/main/ipc/ipc-execution.ts` (`registerExecutionIpc`) exposes the engine facade as a thin pass-through — reads (`execution:get-state`/`:get-config`/`:get-risk-state`/`:get-positions`/`:get-proposals`/`:get-audit`), config (`:update-config`), control (`:start`/`:stop`/`:pause`, `:kill-trip`/`:kill-clear`), and approvals (`:approve-proposal` routing entry→order-manager, exit→management; `:reject-proposal`). New `window.api.execution.*` preload namespace (34th) mirrors it, with `onEvent(cb)` subscribing to the live event stream. New renderer-facing facade types in `src/shared/types.ts` (`ExecEngineStateView`, `ExecEngineHealth`, `ExecEngineEvent`, `ExecPositionRow`, `ExecProposalRow`, `ExecAuditRow`, `ExecApproveResult`, `ExecStartResult`). No new tests — the facade is covered by `tests/execution-engine.test.ts` and the IPC layer is a pure pass-through; full suite green (441). The Electron Trading Desk / Settings UI lands next (Phase 5c/d); live auto-entries (brief→`PickInput`) land with the IBKR adapter (Phase 6).

## [1.1.8] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 5a (engine assembly).** `src/main/execution/execution-engine.ts` (`ExecutionEngine`) wires the whole subsystem into one object: governor, order manager, entry/exit policy, management loop, and the headless core — with the management loop bound to the core's market-cycle hook (so each market-open cycle evaluates exits and acts). The broker is **injected**, so the same assembly runs the `MockExecutionBroker` (tests/dev) or the IBKR adapter (Phase 6) with no code change. Exposes the small facade the IPC/control-API layers will call: lifecycle (`startEngine`/`stopEngine`/`pauseEngine`/kill-switch), `generateEntries`, approval routing (`approveProposal` dispatches entry→order-manager / exit→management; `rejectProposal`), and reads (`getState`/`getConfig`/`updateConfig`/`getRiskState`/`getPositions`/`getProposals`/`getAudit`). Constructing it is inert — engine starts `stopped`, no broker connection, no orders. `tests/execution-engine.test.ts` (6): start, generate→approve→open, the full open→mark-moves→protective-stop-close loop, discretionary exit-proposal approval routing, reject, config/risk reads. Still dormant — **not yet instantiated in the app.**

## [1.1.7] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4c (exit policy), completing Phase 4.** The position-management half of the trade logic. Migration **048** adds the configurable exit rules to `exec_config` (`stop_multiple` 2×, `defensive_dte` 2, `profit_target_pct` 50, `hold_days` 5, `time_exit_dte`, plus `profit_target_mode`/`time_exit_mode` propose|auto) and `exec_proposals.position_id`/`close_reason` (for exit proposals). `src/main/execution/exit-policy.ts` (`ExitPolicy.evaluate`, pure): priority-ordered rules — **protective** stop (loss ≥ 2× credit) and defensive-expiry close (auto, §0.3 invariant), then **discretionary** profit-target (≤ 50% of credit) and planned/time exit. `src/main/execution/position-manager.ts` (`ManagementLoop`): each cycle evaluates every open position and acts — protective → auto `submitClose`; discretionary → auto-close if the mode is `auto`, else raise an exit proposal (one pending per position); `approveExitProposal` closes on approval. Tests: `tests/exit-policy.test.ts` (9, every rule + priority + unpriced) and `tests/position-manager.test.ts` (6, protective auto-close, discretionary propose/auto, no-dup, no-trigger, approve-exit). Still dormant — wired to nothing yet; the engine assembly + brief→pick source land with the IBKR integration.

## [1.1.6] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4b (order manager).** The bridge between proposals/exits and the broker. Migration **047** adds `exec_orders.position_id` (links an order to the position it opens/closes). `src/main/execution/order-manager.ts` (`OrderManager`): `approveProposal` re-runs the pre-trade gate at submission (§2.5), mints a client order id and persists the order row **before** the broker send (idempotency, §2.8), then submits an open combo order; broker status/fill callbacks drive the order state machine and **open an `exec_positions` row** on fill (recomputing deployed capital). `submitClose` reverses the position's legs into a close order, marking the position `closing → closed` with its `close_reason` on fill. Fills are de-duplicated by broker exec id; expired/already-approved proposals and gate failures are rejected with reasons; everything is audited (`proposal_approved`, `order_submitted`, `fill`, `position_opened`, `position_closed`). `tests/order-manager.test.ts` (6): full approve→fill→position, not-pending, expired, gate-recheck reject, close→freed capital, already-closed. Still dormant — wired to nothing yet.

## [1.1.5] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 4a (entry policy).** The first half of the trade logic: turning eligible brief picks into priced, risk-gated proposals awaiting approval. Migration **046** adds the configurable entry-policy columns to `exec_config` (`min_composite_score` 70, `max_new_entries_per_day` 1, `max_new_entries_per_week` 3, `avoid_earnings_before_expiry`, `entry_window_start`/`_end` 10:00–15:00 ET, `reprice_tolerance_pct`), surfaced through `ExecConfig` + the governor. `src/main/execution/entry-policy.ts` (`EntryPolicy`, on a normalized `PickInput` so it's decoupled from v1 brief internals): `filterPick` (eligible strategy · critic pass/caution · composite ≥ floor · liquidity · earnings · entry window), `buildProposal` (price the combo at the venue → size via the governor → run the pre-trade gate → persist a pending `exec_proposals` row with shelf-life, audited), and `generateEntries` (daily/weekly caps, highest-composite first). Helpers `etMinutesOfDay`/`hhmmToMinutes` added to `market-hours.ts`. Tests: `tests/entry-policy.test.ts` (14). Still dormant — wired to nothing yet.

## [1.1.4] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 3b (control API + SSE), completing Phase 3.** `src/main/execution/control-api.ts` (`ExecutionControlApi`): a Fastify server on `127.0.0.1:7433` — separate from the v1 agent API (`:7432`) so it's reachable when the app window is closed — that wraps the `ExecutionCore` + `RiskGovernor`. Token-authed via `X-Agent-Token` (reuses `~/.tradeanalyzer/agent.token`), with a public `/exec/health` probe. Routes: engine control (`POST /exec/engine/start|stop|pause`, `POST /exec/kill-switch/trip|clear`), reads (`GET /exec/state|config|risk|positions|audit`), the zero-latency `POST /exec/brief-ready` handoff (audits + invokes an optional Phase-4 `onBriefReady` hook), and an SSE stream `GET /exec/events` of the core's engine-state/cycle/health/reconcile events. `tests/control-api.test.ts` (9 tests, via `fastify.inject`): auth gating, state, engine start/pause/stop, pause-409, kill trip/clear, config/risk/positions/audit reads, brief-ready hook, SSE frame formatting. Still dormant — wired to nothing yet.

## [1.1.3] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 3a (headless core runtime).** The always-on engine that ties the governor + broker together (control API/SSE follow in 3b). `src/main/execution/market-hours.ts`: a DST-correct US RTH gate (`isMarketOpen`, Mon–Fri 09:30–16:00 ET via `Intl`, configurable holidays) + `etDateString` (ET date for the day-P&L anchor). `src/main/execution/reconciliation.ts`: `reconcile()` — the broker is the source of truth; syncs order status + position marks into `exec_*` and detects drift (positions the broker holds that the core doesn't, and vice-versa), plus `markNeedsAttention()`. `src/main/execution/execution-core.ts` (`ExecutionCore`): owns the broker + governor and runs the management cycle — **cold-start reconcile-before-act** (refuses to start on drift, flags the positions), a per-cycle flow that **fails closed** on a disconnected broker and **trips the kill switch** on drift, only invokes the entry/exit policy hook while the market is open (the hook is filled in Phase 4), a health watchdog (broker-disconnected / stale-cycle), and an event stream for the SSE layer. Tests: `tests/market-hours.test.ts` (7), `tests/reconciliation.test.ts` (5), `tests/execution-core.test.ts` (11). Still dormant — wired to nothing yet.

## [1.1.2] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 2 (risk governor, the safety core).** Added the fail-closed risk layer that no order may bypass, split into a pure decision layer and a stateful service. `src/main/execution/risk-gate.ts` (pure, no I/O): `sizePosition()` (contracts = floor(per-trade-risk / max-loss), capped by remaining deployable capital) and `evaluateGate()` — the ordered 10-check pre-trade gate (engine running · broker connected · defined-risk & eligible strategy · per-trade risk · max concurrent · per-ticker · per-strategy · capital ceiling · buying power · daily-loss headroom), first failure supplies the reject reason. `src/main/execution/risk-governor.ts` (`RiskGovernor`, DB-backed): the single source of risk truth — reads/writes `exec_config` + `exec_risk_state`, the engine state machine (`start`/`stop`/`pause`/`tripKillSwitch`/`clearKillSwitch` with validated transitions — can't start while kill-tripped, manual clear only), day-P&L accounting that auto-trips the kill switch at the configured % loss (realized + unrealized, resets at session anchor), deployed-capital recompute, COID minting, and the append-only audit log; every state change commits atomically with its audit entry. `checkEntry()` assembles a context from the DB + broker and runs the pure gate. Tests: `tests/risk-gate.test.ts` (17) + `tests/risk-governor.test.ts` (18). Still dormant — wired to nothing yet.

## [1.1.1] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 1 (broker seam + mock).** Added the `ExecutionBroker` interface (`src/main/execution/execution-broker.ts`) — the abstraction over the venue that prices, places, and fills orders, so the engine never depends on a concrete broker (paper vs live becomes a config of the IBKR implementation, not a code branch). Added `MockExecutionBroker` (`src/main/execution/mock-execution-broker.ts`): a deterministic, fully controllable in-memory broker (configurable pricing, fills full/partial/reject/manual, connection state, buying power, marks) that lets the entire engine — risk governor, loops, control panel — be built and tested with **no IBKR account**. It is idempotent on `clientOrderId` (a repeated COID never duplicates an order) and matches closing orders to their opening position regardless of leg direction. `tests/mock-execution-broker.test.ts` (12 tests) pins the contract: pricing, auto/manual/partial/reject fills, idempotency, fail-closed-when-disconnected, position open/close, marks, cancel. Still dormant — wired to nothing yet.

## [1.1.0] — 2026-06-14

### Added
- **v2 execution subsystem — Phase 0 (schema foundation).** First increment toward automated trade execution (full requirements in `Requirements/v2-execution/`). Migration **045** creates the seven namespaced `exec_*` tables — `exec_config`, `exec_risk_state`, `exec_proposals`, `exec_orders`, `exec_fills`, `exec_positions`, and the append-only `exec_audit_log` — and seeds the singleton config + risk-state rows with the locked v2.0 defaults ($10k ceiling · 5% max-risk/trade · 5 concurrent · 10% daily-loss trip · 1 position/ticker · inflection-only · engine `stopped`). Added the `Exec*` domain types to `src/shared/types.ts` and `tests/exec-schema.test.ts` (table presence, seeded defaults, single-row + enum CHECK constraints, idempotent seeding, COID uniqueness). **The tables are dormant** — created and seeded but not yet wired to any service or UI; the headless execution core, risk governor, loops, and control panel come in later phases. No behavior change to the existing app.

## [1.0.0] — 2026-06-14

### Milestone
- **v1.0.0 — the decision-support app is feature-complete.** This release draws the line under v1: watchlists, screener, five-mode analysis, the configurable scoring engine, the daily AI intelligence brief + critic, Brief Replay, validation dashboards, multi-leg payoff modeling, E\*Trade-synced portfolio tracking, LEAPS+CSP / collared-LEAPS screeners, earnings calendar, News & Research, the Agent overhaul, and backtesting — all shipped and verified against the v1 spec (`Requirements/spec/`). The app remains **read-only at the broker** by design: it analyzes, recommends, and validates, but never places an order.
- **Next phase is v2: automated execution.** Work begins on a headless execution core (semi-auto, approve-each), trading a segregated IBKR account in paper first, then real capital under hard risk limits. This is a new subsystem with its own requirement set — see the new execution spec section and `.ai/AI_CONTEXT.md §11`. No behavior change in this release; it is the version marker that separates decision-support (v1) from execution (v2).

## [0.34.10] — 2026-06-14

### Added
- **💰 dollar P&L for directional strategies (buy / bullish / bearish)** — the Brief Replay summary's 💰 button now appears on the three directional rows too, so you can compare **buy vs bullish dollar-to-dollar**. These aren't premium structures, so instead of an option sim they run a **fixed-notional stock position**: $10,000 deployed per pick (long for buy/bullish, **short for bearish**), marked at the replay's 21-day forward close. Every pick uses the same $10k, so Total P&L is directly comparable between buy and bullish; the modal notes the premium strategies above use a different capital base (option collateral), so those are compared by ROC, not headline dollars. `AggregatePickBacktest.structure` gains `'stock'`; new `notionalPerTrade` field. The modal labels, subtitle, chart caption, and footnote adapt to the stock structure (ROC → "return").

## [0.34.9] — 2026-06-13

### Added
- **💰 aggregate backtest now covers Inflection (directional credit spread)** — the Brief Replay summary's 💰 button now appears on the **inflection** row too, not just wheel/income. Because inflection is a directional credit spread (not a CSP), it runs a new `simulateSingleSpread`: a **bull put spread** for up-breakouts / **bear call spread** for down-breakouts (sell ~0.30Δ, buy 0.15Δ — mirroring the live `short-put-vertical`/`short-call-vertical`), per pick, IV-priced, **defined-risk** (return on max-loss capital, each loss capped at the spread width). The modal labels and footnote adapt to the credit-spread structure. `AggregatePickBacktest` gains a `structure` ('csp' | 'credit-spread') field.

## [0.34.8] — 2026-06-13

### Fixed
- **💰 aggregate backtest: dollar-based equity curve + drawdown (was misleading)** — the modal previously showed a "Cumulative ROC" that summed per-trade *percentages* across all trades (e.g. +407%) and a "Max drawdown" of −158% — dimensionally meaningless (you can't draw down 158% of capital). The equity curve is now **cumulative realized dollar P&L** (ending exactly at Total P&L), and **Max drawdown is a real dollar figure** (largest peak-to-trough drop). The line turns red when the strategy is net-negative. Added an explanatory note for the common case of a **high win rate but net dollar loss** — the short-premium asymmetry (many small premium wins, a few large assignment losses; avg ROC is equal-weight per trade while Total P&L is collateral-weighted, so they legitimately diverge). Type: `AggregatePickBacktest.equityCurve[].cumReturnPct → cumPnl`, `maxDrawdownPct → maxDrawdownPnl`.

## [0.34.7] — 2026-06-13

### Added
- **💰 aggregate CSP backtest shows dollar P&L** — the "CSP backtest over every pick" modal now displays **Total P&L** ($) and **Avg $/trade** alongside the ROC metrics (the backend already computed `totalPnl`; it just wasn't surfaced). Total P&L = sum of one CSP contract (100 shares) per pick.

## [0.34.6] — 2026-06-13

### Changed
- **Backtest auto-runs when opened from a deep-link** — landing on Backtest via the 🔁 action (My Stocks / Brief picks) now runs the backtest automatically with the pre-filled ticker + strategy, instead of waiting for a manual "Run" click. It waits for IV coverage to load first so the start date defaults to the IV-accurate range, then kicks off. Manually opening the Backtest view still shows the form for you to fill in.

## [0.34.5] — 2026-06-13

### Changed
- **Backtest: dropped the Starting Capital input** — the field is gone; the engine auto-sizes the capital base to exactly one contract (`max spot × 100`) and reports metrics as return on the capital one contract ties up. This also **removes the capital gate** entirely, so high-priced stocks (META, etc.) just run — no more flat-zero curve and no need for the "raise capital" error added in v0.34.4. (`starting_capital` stays in the schema for back-compat but is unused.)
- **Backtest trade log is now sortable** — click any column header to sort (toggles asc/desc; nulls last). Defaults to **entry date, descending** (most recent trades first).

## [0.34.4] — 2026-06-13

### Fixed
- **Backtest no longer silently returns a flat-zero curve when capital is too small** — a CSP/Wheel backtest on a high-priced stock (e.g. META ~$645 → ~$60k collateral) with the default $25k starting capital could never open a position, producing a flat equity curve and all-zero metrics with no explanation. The engine now throws a clear error: *"No trades: starting capital ($25,000) is below the ~$60,000 collateral a 0.30-delta CSP needs for META. Raise Starting Capital."* (Also covers the no-premium/insufficient-data case.) Note: the aggregate 💰 P&L backtest is unaffected — it's per-trade ROC, not capital-constrained.

## [0.34.3] — 2026-06-13

### Added
- **Backtest trade log shows the underlying stock price at entry & exit** — new **Stk@Entry** and **Stk@Exit** columns (migration 044 adds `backtest_trades.entry_spot` / `exit_spot`, populated by the engine from the simulated spot at open and close). Makes each trade readable — you can see where the stock sat relative to the strike. Existing runs show "—" for these until re-run.

## [0.34.2] — 2026-06-13

### Added
- **Backtest trade log shows exit price** — the trade table now has an **Exit Px** column (the option's settlement/buyback price per share at close: the closing mid on a profit/stop exit, intrinsic on assignment, 0 on a worthless expiry). The entry premium column is relabeled **Entry Px** for symmetry. (No data change — `exitPremium` was already captured per trade.)

## [0.34.1] — 2026-06-13

### Added
- **Backtest form guides toward IV-accurate start dates** — the New Backtest form now defaults its start date to the oldest date in `iv_history` (when available) and sets that as the date input's `min`, so backtests are IV-priced by default. If a start date earlier than IV coverage is chosen, an inline ⚠ warning explains that earlier dates are priced from realized vol (not implied vol) and offers a one-click "Use {date}". When the start is within coverage, a "✓ IV-priced" hint confirms it. `BacktestEngine.ivHistoryStart()` + IPC `backtest:iv-coverage`. (IV history currently begins 2025-05-29 — ~1 year — so older backtests were silently realized-vol priced.)

## [0.34.0] — 2026-06-13

### Added
- **Aggregate "backtest my picks" in Brief Replay (integration phase 2 of 2)** — the summary table's new **💰 P&L** button (on the wheel & income rows) simulates a cash-secured put on **every** historical Brief-Replay pick for that strategy and pools the results into one view: trade count, win rate, avg/median return-on-capital, cumulative ROC, max drawdown, avg days held, and an **equity curve** (cumulative ROC by exit date). This answers *"if I'd traded every wheel/income pick, what would they have actually returned?"* — using **real option P&L** (Black-Scholes from historical price + IV), not the stock-move proxy the summary columns show. `BacktestEngine.backtestReplayPicks(strategy)`; IPC `backtest:replay-picks`. Each pick is one 0.30-delta / 30-DTE CSP with 50%-profit / 200%-stop exits; equal-weight, capital unconstrained. Completes the backtest integration begun in v0.33.7.

## [0.33.8] — 2026-06-13

### Changed
- **Backtest engine prices off historical implied volatility** — the simulator now uses `iv_history` ATM IV (as-of the entry date) for its Black-Scholes volatility input, falling back to 20-day realized vol only when no IV history exists. Previously it always used realized vol, which understated the premium a CSP/CC/Wheel actually collects (sellers are paid IV, which runs above realized — the variance risk premium). The same `sigma` drives strike selection, entry premium, and daily mark-to-market. See `docs/formulas.md#backtest-iv`.

## [0.33.7] — 2026-06-13

### Added
- **Backtest deep-link from recommendations (integration phase 1 of 2)** — a "🔁 Backtest" action now appears on **My Stocks** rows (every stock → pre-fills a CSP) and on **Daily Brief** wheel/income pick cards (wheel → Wheel, income → CSP), opening the Backtest view pre-filled with the ticker + strategy. No more manual one-stock data entry to test a recommendation. (Backtest only appears where its engine applies — premium-selling strategies; buy/bullish/bearish/inflection brief picks don't show it.) New `navigate-to-backtest` event; `BacktestView` accepts `initialTicker`/`initialStrategy`. Phase 2 (aggregate "backtest all my picks" with one equity curve) is next.

## [0.33.6] — 2026-06-13

### Fixed
- **My Stocks email: header/data column alignment** — the email table's header cells were all left-aligned while the numeric data cells were right-aligned, so headers didn't line up over their columns. Header and data alignment are now driven by a single per-column definition (numeric columns right, text columns left, flag centered).

## [0.33.5] — 2026-06-13

### Added
- **My Stocks: "in play" flag** — each stock in the conviction list has an on/off 🚩 flag (migration 043 adds `conviction_stocks.in_play`) to mark stocks you want to pay attention to / may act on. Toggle it from a new flag column in the table (flagged rows are highlighted and counted in the header). It's a transient marker — toggling does **not** write a band-history snapshot.
- **My Stocks: email the list** — a new "✉ Email My Stocks" button sends the list (via the existing SMTP/email config) as an HTML table including the 🚩 flag, sorted in-play first then by zone. The **Actions** column is omitted (UI-only, no information). The button is disabled with a tooltip when email isn't configured. New IPC: `conviction:set-in-play`, `conviction:send-email`, `conviction:email-configured`.

## [0.33.4] — 2026-06-13

### Changed
- **Daily Brief & email/PDF: strategy sections now ordered by the day's top composite score** — instead of a fixed sequence, the strategy with the highest-scoring single pick that day appears first, then descending. The previous fixed order (wheel→bullish→bearish→income→buy→inflection) is the tiebreaker and orders strategies with no picks last. Applied consistently to the on-screen brief, the HTML email, and the PDF (shared `orderByTopComposite`). Note: composite scores are strategy-specific (different signals/weights per strategy), so this is a surfacing heuristic — it floats the strongest-scored pick to the top, not a cross-strategy quality ranking (the score-badge tooltip already flags this). Also fixed the PDF cover's hardcoded "across 5 strategies" → actual count.

## [0.33.3] — 2026-06-13

### Changed
- **Brief Replay Score-Signal tab now shows all strategies** — the score-quintile and pick-rank charts were hardcoded to curated 3-strategy subsets (buy·bullish·bearish / buy·bullish·wheel), so inflection (and income/wheel) didn't appear. Both charts now render every strategy in the chart payload, driven by `data.strategies` with a per-strategy color fallback. Inflection's bars use its direction-adjusted 21d return.

## [0.33.2] — 2026-06-13

### Fixed
- **Brief Replay charts now include the Inflection strategy** — the Monthly hit-rate chart (labeled "all strategies") used a hardcoded 5-strategy list that omitted inflection, and the charts modal's color/label maps had no `inflection` entry (so it rendered gray/uncapitalized in the Performance, Regime, and Ticker tabs). Added inflection to `ReplayChartMonthlyRow` + the backend monthly builder (`mHr('inflection')`, using the already-direction-adjusted 21d return), and to `STRAT_COLORS`/`STRAT_LABEL` + the Monthly chart's line/legend lists. The curated Score-Signal and Rank charts (explicitly buy·bullish·bearish / buy·bullish·wheel) are unchanged by design.

## [0.33.1] — 2026-06-13

### Added
- **Bearish inflection (both directions complete)** — the Inflection strategy now also takes **down breakouts** (fresh 20-day-low break in a downtrend → **bear call spread**, `short-call-vertical`), not just up breakouts. `hasBreakout` accepts `breakout_state === ±1`. To make the metrics correct for a mixed long/short strategy, **Brief Replay outcomes are now direction-aware**: migration 042 adds `replay_outcomes.direction` (1 long / −1 short, populated per pick from the breakout sign; bearish = −1, others = 1; legacy rows fall back to the strategy-implied direction). The replay summary hit-rate uses it uniformly, and inflection's average return is direction-adjusted (positive = thesis worked) so long and short picks don't cancel; the charts direction-adjust inflection's 21-day return likewise. The critic now selects inflection's **higher-graded** relevant vertical (the lab's direction bias makes the correct one — bull put for up-breaks, bear call for down — grade higher), matching the brief card's existing best-score pick.

## [0.33.0] — 2026-06-13

### Added
- **Inflection strategy live in the Daily Brief (Phase 3 of 3)** — `inflection` joins the live brief as a 6th strategy: a **directional credit spread anchored at a fresh 20-day breakout** (bullish). It surfaces up to 5 top-ranked breakout picks per day; on days with few breakouts it shows fewer (the signal scores 0 without a fresh with-trend breakout). The structure is the existing **`short-put-vertical` (bull put spread)** credit vertical — already defined-risk with correct credit P&L; mapped via `STRATEGY_RELEVANT_SLUGS` so the liquidity gate, critic, and brief card all use it. Added a 6th section to the Daily Brief view (and the PDF/email report), with `short-put-vertical`/`short-call-vertical` shown as "Bull Put Spread"/"Bear Call Spread". Brief Replay scores the same 6 strategies (`REPLAY_STRATEGIES` now aliases `STRATEGIES`). **Still bullish-only**; bearish inflection (down-break → bear call spread) remains a follow-up needing direction-aware replay outcomes.

### Fixed
- Corrected the inflection relevant-slug mapping introduced in v0.32.99 — it referenced non-existent `bull-put-spread`/`bear-call-spread` slugs; the real Strategy Lab credit verticals are `short-put-vertical`/`short-call-vertical`.

## [0.32.99] — 2026-06-13

### Added
- **Inflection scoring strategy (Phase 2 of 3)** — `inflection` is now a 6th `ScoringStrategy`. Its composite ranks breakout-setup quality from four signals, **all gated on a fresh with-trend breakout** (`breakout_state`): `breakoutDecisiveness` (30), `volumeSurge` (25), `breakoutIvRank` (25, premium richness), `breakoutAtrPct` (20). A ticker with no fresh breakout scores 0 and never surfaces. Signals are read live from `technical_signals` (`gatherSignalData`) and point-in-time in Brief Replay. **Phase 2 surfaces bullish (up) breakouts only** so the replay "stock-up = win" aggregation is correct; bearish (down → bear call spread) is a follow-up needing direction-aware outcomes. The strategy scores in **Brief Replay** (`REPLAY_STRATEGIES`) for validation but is **not yet in the live Daily Brief** (`STRATEGIES` stays at 5) — that's Phase 3. Tune its weights in the Trade Scoring view.

## [0.32.98] — 2026-06-13

### Added
- **Breakout/continuation signals (Inflection strategy — Phase 1 of 3)** — `DailyTechnicalSignalsJob` now computes and stores five breakout signals per ticker (migration 041 adds them to `technical_signals`): `breakout_state` (−1 fresh 20-day-low breakdown in a downtrend / 0 none / 1 fresh 20-day-high breakout in an uptrend), `breakout_level` (the broken 20-day high/low), `breakout_decisiveness` (`|close − level| / ATR14`), `volume_surge` (today vs 20-day avg volume), and `atr_pct` (`ATR14 / close × 100`). Gated to **with-trend continuation** (up-breaks above SMA50, down-breaks below). These feed the forthcoming Inflection strategy (a directional credit spread anchored at the breakout level); nothing reads them yet, so this phase is purely additive. Validated offline: top-quintile breakouts let a credit spread placed ~0.5–1 ATR beyond the level expire OTM ~84–90% of the time. See `docs/formulas.md#breakout-signals`.

## [0.32.97] — 2026-06-13

### Changed
- **Realistic option fill modeling (slippage haircut)** — credits/debits are no longer priced at the optimistic mid. A new shared `fillPrice()` (`options-fill.ts`) models a leg's fill toward the disadvantageous side: sells fill below mid (toward the bid), buys above mid (toward the ask), by `SLIPPAGE_FRACTION` (0.5) × the half-spread. Applied to Strategy Lab `buildSetup` net credit/debit (incl. PMCC/calendar net debit) and to wheel/income premium in `analysis-service.ts`. **Wheel & income previously used `premium = mid/2`** — an indefensible flat 50% haircut; they now use the realistic fill (premiums rise toward accurate, which shifts their scoring rankings and the values captured in `options_premium_history`). The Strategy Lab previously used raw mid (optimistic); its credits now drop slightly. The effect is largest where liquidity is worst — exactly where it should be. See `docs/formulas.md#fill-model`.
- **Liquidity score now counts same-day volume** — the Strategy Lab `liquidityScore` (0–15) is rebalanced to spread 8 / open interest 4 / **volume 3**, and the wheel `optionLiquidityScore` (0–10) to OI 4 / spread 4 / **volume 2**. A high-OI/zero-volume strike (stale interest that won't fill well) no longer scores as fully liquid; an actively-traded low-OI strike is credited. `SetupLeg` gains a `volume` field. See `docs/formulas.md#liquidity-score`.

## [0.32.96] — 2026-06-13

### Added
- **Strategy Lab: PMCC & calendar second-expiration construction** — the lab now fetches a second far-dated chain (~120 DTE) so the four two-expiration structures (Poor Man's Covered Call/Put, Call/Put Calendar) build real legs instead of returning `unavailableReason: 'Requires two expirations'`. The long leg is drawn from the far chain, the short leg from the near chain. Max profit (which has no closed form for diagonals/calendars) is computed by valuing the long leg's residual time value at the short leg's expiry via Black-Scholes (`bsPrice`), assuming the underlying pins the short strike. This gives buy/bullish a defined-risk, B-grade-capable structure in high-IV regimes where single-leg debits grade C/F. One extra E*Trade `getOptionsChain` call per ticker in `validate()` (graceful: those strategies stay unavailable if no suitable far expiration exists). See `docs/formulas.md#calendar-diagonal-pnl`.

### Changed
- **Black-Scholes extracted to a shared util** (`src/main/services/black-scholes.ts`, exports `bsPrice` / `normCdf` / `RISK_FREE_RATE`); `collared-leaps-service.ts` and the new Strategy Lab calendar/PMCC math both use it (was duplicated).

## [0.32.95] — 2026-06-13

### Added
- **Brief Replay: premium-history readiness banner** — an in-app check that surfaces in the Brief Replay view once enough `options_premium_history` has accumulated to compute real income/wheel ROC. `BriefReplayService.getPremiumHistoryReadiness()` (IPC `replay:premium-history-readiness`) reports total rows, distinct days, date range, and **matured** days (entries older than ~45 days, so the recommended option would have expired). While accumulating it shows a muted progress note (`N/40 matured days`); once ≥40 matured days exist it shows a green "ready — ask Claude to build the ROC view" prompt. Renders nothing when the table is empty, so it stays invisible until the new daily capture job (v0.32.94) has run for a while.

## [0.32.94] — 2026-06-13

### Added
- **Daily Options Premium History job + table** — a new batch job (`daily-options-premium-history`, registered last in the sequence) and table (`options_premium_history`, migration 040) that captures a durable, query-friendly daily time series of the recommended option structure (strike, expiry, premium, delta, bid/ask, IV, annualized return) per ticker for **premium-based strategies**. Wheel CSP rows are reused from the same-day wheel snapshot (`analysis_snapshots`) so no extra E*Trade calls are made; income CSP/CC rows are fetched live via `analyzeTicker('options_income')` — the previously-missing data. One row per `(as_of_date, ticker, strategy)`, **never pruned**. This closes the gap where income/wheel premium had no durable history: a year from now this enables **true return-on-capital** analysis (and real income/wheel ROC in Brief Replay, replacing the stayed-above-strike proxy). Configurable via `config_json` (`callDelayMs`, `maxTickers`, `captureWheel`, `captureIncome`). No startup run; driven by the orchestrator or manual trigger.

## [0.32.93] — 2026-06-13

### Added
- **Bearish composite quality gate (≥70)** — bearish picks now require a composite score ≥70 to surface in the daily brief and Brief Replay (`minCompositeForStrategy()` in `scoring-service.ts`; applied at the Stage-4 pool filter in `daily-intelligence-brief-job.ts` and at replay pick selection in `brief-replay-service.ts`). Full-year replay (2025-05 → 2026-06, 1,300 bearish picks) shows sub-70 picks have ~0 alpha vs SPY and lose money in aggregate (short P&L −1.8%, win 46%), while ≥70 picks underperform SPY by ~3.3% — a real short edge (short P&L +1.0%, win 56%). The gate is rank-agnostic (a rank-2/3 pick clearing 70 is kept; a top-ranked pick below 70 is dropped) and self-suppresses bearish on weak days (~42% of dates yield zero ≥70 picks). Other strategies are ungated.

### Removed
- **Brief Replay: SPY regime risk gate / ⚠ badge (reverted from 0.32.90)** — the regime badge in the summary and picks tables (and `ReplaySummary.regimeRiskDates` / `ReplayPickRow.spyRegime`) is removed. Its "bearish HR ~25% in bullish regime vs ~79% in bearish regime" basis was a 5-month small-sample artifact; the full-year replay *inverts* it — gating bearish to bear-regime dates (SPY below its 50-day SMA at entry) actually performed worse (short P&L −6.7%, win 38%), because below-SMA dips kept V-bouncing and squeezing shorts. Replaced by the composite quality gate above. `computeSpyRegimes()` is retained solely for the descriptive Regime chart tab (no longer drives any filter or badge).

## [0.32.92] — 2026-06-13

### Added
- **Brief Replay: performance charts modal** — a "Charts" button appears after a replay run. Clicking it opens a full-screen modal with five tabs: Performance (avg 21d return + hit rate per strategy), Regime (bull vs bear SPY regime split), Monthly (HR21d line chart), Score Signal (score quintile → return chart exposing the anti-predictive scoring pattern, plus rank-order chart), and Tickers (top/worst tickers per strategy with at least 4 appearances). All aggregations are computed server-side in `BriefReplayService.getChartData()` using `computeSpyRegimes()` for regime splits. Bearish strategy HR/sorting is direction-aware (stock down = win). Charts use Recharts (existing dependency).

## [0.32.91] — 2026-06-13

### Fixed
- **Daily Brief: $5 price floor for briefing candidates** — the screener candidate SQL in `BriefingService` now filters `lastPrice >= 5`, preventing sub-$5 penny stocks (e.g. NWL at $4.92) from appearing in income/wheel/buy picks. The same screener data already had this filter in Brief Replay (replay job enforced it) but the live briefing query did not.

### Added
- **Critic: `high_vol_naked_structure` rule** — fires `warning` when the income strategy selects a `short-straddle` or `short-strangle` (unlimited-risk structures) for a stock whose 1Y price return exceeds 100%. High directional momentum contradicts the range-bound thesis required for straddles/strangles; rule recommends a defined-risk alternative (iron condor or iron fly).
- **Critic: `thin_breakeven` rule** — fires `warning` when income or wheel strategy has a breakeven buffer below 2%. Computed the same way as the LLM context: `|netCredit| / price` (per-contract ÷ per-share = %). A thin buffer means a small adverse move wipes the premium entirely.

## [0.32.90] — 2026-06-12

### Added
- **Brief Replay: SPY regime risk gate for bearish picks** — `BriefReplayService.computeSpyRegimes()` checks whether SPY closed above its 50-day SMA on each replay date. Bearish picks on bullish-regime dates are flagged with a ⚠ badge in the picks table (tooltip: "SPY above 50-day SMA — bullish regime reduces bearish win rate"). The hit-rate summary table shows a "⚠ N/Total regime risk" count on the bearish row (e.g. "⚠ 76/98 regime risk"), derived from replay data showing bearish HR averages ~25% in bullish regimes vs ~79% in bearish regimes. No schema change — computed at query time from existing `historical_prices` SPY bars.

## [0.32.89] — 2026-06-12

### Added
- **Brief Replay** — new Intelligence section screen that back-tests the 5-strategy scoring pipeline against historical dates. Pick a date range, hit Run, and the pipeline scores every NYSE trading day in the window using point-in-time price/IV data and current fundamentals. Produces a hit-rate summary table (5d/10d/21d) per strategy and a drillable picks detail table with entry price, forward returns, and max drawdown. No E*Trade options chains (Option A liquidity proxy: avgVolume ≥ 1 M + price ≥ $5). New tables: `replay_briefs`, `replay_outcomes` (migration 038). Cancellable in-progress runs; data cleared and re-populated on each Run.

## [0.32.88] — 2026-06-12

### Added
- **Daily Brief: 🔍 Analysis and 🏦 E*Trade quick-nav buttons** on every pick card, next to Payoff/Validate/Options. Analysis navigates to the Analysis view pre-loaded with the ticker; E*Trade opens the ticker's quote page (`us.etrade.com/e/t/invest/quotesandresearch?content=3&sym={ticker}`) in the system browser — same deep-link the Opportunity screen uses.
- **Brief email: ticker symbols are now E*Trade links** — each ticker in the per-strategy tables links to its E*Trade quote page, so you can jump from the morning email straight to the order screen.

## [0.32.87] — 2026-06-12

### Fixed
- **ORCL fake net-cash: stale EDGAR concepts no longer serve as current data** — Oracle's only `LongTermDebt` entry in us-gaap is a $0 value from FY2022 (its real ~$90B of debt lives in dimensioned per-instrument contexts that `companyfacts['us-gaap']` doesn't aggregate). The provider served that 4-year-old zero as "current debt" against $38B of current cash → `netDebtToEbitda` −1.37. New `conceptIsStale()` guard: any concept whose newest entry (any form) is older than 540 days is skipped during concept selection — active filers always have an entry within ~120 days, so this only rejects abandoned tags. ORCL's debt now correctly resolves to null (no fake numbers). Also applied to the composite D&A base. T/VZ/MO verified unaffected (current concepts).
- **Banks no longer spuriously pass the leverage value-score criterion** — `netDebtToEbitda` is now null for the financial sector (same detection as the existing D/E exemption): EBITDA is meaningless for banks, and their cash positions produced absurd negatives (RF: −176) that passed `passLte(≤3)` and inflated valueScore/growthScore. Also nulled when |ratio| > 50 (near-zero EBITDA denominators — observed 252, 909). Legitimate negatives for true net-cash companies are kept.
- **docs/formulas.md `#quality-signals` anchor now exists** — code comments referenced it but the section was never written; added with the FCF/NI, ROIC, and NetDebtToEBITDA formulas and null conditions.

## [0.32.86] — 2026-06-11

### Fixed
- **netDebtToEbitda null for 373/1,002 tickers — composite D&A fallback** — modern filers (MSFT, GOOGL, ORCL) no longer tag a combined D&A concept in us-gaap: they tag `Depreciation` (PP&E only) and amortization parts separately, with the combined cash-flow line often in a company extension namespace invisible to `facts['us-gaap']`. New `compositeEntries()` sums `Depreciation` + `AmortizationOfIntangibleAssets` + `FinanceLeaseRightOfUseAssetAmortization` per exact reporting period (each component deduped per period first so comparative re-reports can't double-count), producing a synthetic entry list that flows through the normal `annualSeries`/`ttmPair` machinery. Selection keeps the most-recent-annual-wins rule: the composite replaces a combined concept only when its annual series is strictly more recent — covering both "no combined concept at all" and "combined concept abandoned years ago". Base-only periods are acceptable: understating D&A overstates net-debt-to-EBITDA, the conservative direction for a leverage-risk signal. Validated against live filings: MSFT D&A $31.4B, GOOGL $21.7B, ORCL $6.2B. Banks/energy nulls (no `OperatingIncomeLoss`) are structural and remain null by design.

## [0.32.85] — 2026-06-11

### Fixed
- **Brief rationales: max_tokens sized for the real request volume** — stage 5 requests rationales for all stage-4 candidates (up to 15 per strategy = 75, not the final 25), because the liquidity gate runs later at assembly. The v0.32.81 cap of 4096 still truncated: the first live run salvaged 38/75 and the income/buy strategies (last in the array) got zero rationales. Raised to 16384 (~7K actually needed). The v0.32.81 salvage + `runMeta.aiError` visibility is what made this immediately diagnosable from run history.

## [0.32.84] — 2026-06-11

### Added
- **Dividend yield wired (was 100% null)** — `getFundamentals()` now also queries Polygon `/v3/reference/dividends` (included in the Stocks Starter plan): trailing yield = sum of regular cash dividends with ex-date in the last 365 days / current price × 100. Special dividends (`dividend_type='SC'`) are excluded so one-off payouts don't inflate the yield the wheel/income scoring sees. 0 = confirmed non-payer; null only when the fetch fails. see docs/formulas.md#dividend-yield
- **Beta wired (was 100% null)** — new `BetaService` computes 1-year daily beta vs SPY from local `historical_prices` (1,046/1,067 tickers have ≥250 bars; zero API cost): cov/var over date-joined returns, `adjusted_close` preferred, null under 200 overlapping observations. Injected into `PolygonDataProvider` as an optional callback. see docs/formulas.md#beta

## [0.32.83] — 2026-06-11

### Changed
- **EDGAR fundamentals: true TTM from 10-Q roll-forward** — slot-0 income/cash-flow values were the last 10-K, which is up to ~11 months stale for companies early in their fiscal year (MSFT's FY ends in June; its "TTM" revenue was from June 2025 while P/E used today's price). New `ttmPair()` implements the standard XBRL roll-forward: TTM = FY + YTD(current 10-Qs) − YTD(prior year same period). The prior-year TTM (YoY denominator) rolls the same way using the two-years-back comparative. TTM mode engages only when the full quarterly chain exists; otherwise both values fall back to consistent fiscal years — a TTM numerator over an FY denominator would misstate YoY growth by the stub-period difference. Verified live: MSFT TTM revenue now $318.3B through 2026-03-31 (was $282B through 2025-06-30), NI $125.2B (was $102B). 5Y CAGR keeps its annual base.

## [0.32.82] — 2026-06-11

### Fixed
- **Earnings blind spot: "no earnings data" no longer reads as "no earnings risk"** — ~11% of the universe (119/1,068 tickers) has no future row in `earnings_calendar` (Finnhub bulk-fill gaps; DELL was picked tonight while invisible to the earnings check). Three changes: (1) the brief job now runs a per-pick E*Trade earnings fallback for the ~25 final pick tickers before the critic stage — `refreshTickers` smart-skips tickers that already have valid future dates, so this is typically only a handful of API calls; result recorded in `runMeta.earningsFallback`. (2) The critic's rule check now distinguishes "known clear" from "no data": a pick with an options structure but no future earnings row gets an info-severity `earnings_unknown` flag telling the trader to verify the report date manually. (3) The critic's AI context gains `earningsKnown` so the LLM treats missing calendar data as unverified risk rather than absence of risk.

## [0.32.81] — 2026-06-11

### Fixed
- **Daily brief: all 25 AI rationales were dropped silently** — Stage 5 asks for 25 pick rationales in one call with `max_tokens: 2048`, but 25 × ~90 tokens needs ~2.3K+. The response truncated mid-JSON, the `\[[\s\S]*\]` extraction regex found no closing bracket, and every `aiRationale` stayed null while the ~$0.07 API spend was still incurred — with no error recorded. Fixes: (1) `max_tokens` raised to 4096; (2) new `parseRationaleResponse()` (own module, unit-tested) salvages every complete object from a truncated array instead of all-or-nothing regex matching; (3) `stop_reason === 'max_tokens'` and zero-parse outcomes are now recorded in `runMeta.aiError` so partial/failed synthesis is visible in the run history instead of silent.

## [0.32.80] — 2026-06-11

### Fixed
- **EDGAR 5Y CAGR was computed from a 2-years-ago base, not 5** — every 10-K re-reports the two prior fiscal years as comparatives, so the raw 10-K entry list contains each year 2–3 times (FY25, FY24, FY24, FY23, FY23, FY23…). The provider indexed this list as if entry N were N years back, landing the "5 years ago" slot on FY-2. Result: `revenueGrowth5Y`/`epsGrowth5Y` systematically understated for every steady grower (AAPL: computed 1.66% vs true 8.68%), which suppressed the `earningsGrowth`, `revenueGrowth5Y`, and `epsGrowth5Y` signals in the bullish/buy strategies plus valueScore/growthScore/stockGrade universe-wide. Fix: new `annualSeries()` dedupes by period end (most recently filed wins, so restatements are honored) and drops non-annual durations (<300 or >400 days) that some filers tag inside 10-Ks. `EdgarEntry` now captures `start` to enable the duration check.
- **5Y CAGR no longer silently degrades to a 3–4 year base** — the old fallback computed a "5Y" CAGR from whatever history existed. Now companies with fewer than 6 deduped annuals get null, which the scoring engine correctly treats as a missing signal and reweights.

## [0.32.79] — 2026-06-11

### Changed
- **Fundamentals now sourced from SEC EDGAR instead of Polygon** — Polygon `/vX/reference/financials` requires a Developer plan ($199/mo); the current Stocks Starter plan returns 403. Replaced with the free SEC EDGAR XBRL API (`data.sec.gov`), which requires no API key and exposes the same financial data via US-GAAP concept tags.
- **CapEx now included in FCF calculation** — EDGAR exposes CapEx (`PaymentsToAcquirePropertyPlantAndEquipment`), which Polygon never reliably provided. Added `capital_expenditures` to `PolygonFinancials.cash_flow_statement` so `computeRatios()` can compute proper FCF = Operating CF − |CapEx| instead of using Operating CF alone.
- **Removed Polygon plan-restriction workaround** — the `fundamentalsPlanRestricted` flag and 403 branch in `screener-service.syncUniverse()` have been removed. EDGAR does not have plan tiers.

### Implementation notes
- New `src/main/services/sec-edgar-provider.ts`: `resolveEdgarCik()` (ticker → CIK, cached per process), `getEdgarFundamentals()` (companyfacts fetch → `PolygonFinancials`). Concept selection uses "most-recent annual date wins" heuristic to handle ASC-606-style transitions (e.g. Apple: `Revenues` → `RevenueFromContractWithCustomer…` in 2019).
- Filing array layout: 20 slots (so `sumFiveYearAgoTtm()` length check passes). Real data at slots 0 (current annual), 4 (prior year), 16 (5-years-ago). All other slots hold an empty placeholder so `sumTtm()` skips them gracefully.
- Balance sheet at slot 0 uses the most-recent entry regardless of form (10-Q preferred over 10-K for currency).
- `EDGAR_HEADERS`, `resolveEdgarCik`, `pickEdgarLatest`, `EDGAR_FIELD_SPECS`, and `EdgarEntry` are exported from `sec-edgar-provider.ts` and imported by `ipc-test-api.ts` (no duplication).

## [0.32.78] — 2026-06-11

### Fixed
- **EDGAR test: concept selection picks most-recent data, not first-found** — when a company has multiple matching US-GAAP concepts (e.g. Apple has both `Revenues` with 2018 data and `RevenueFromContractWithCustomerExcludingAssessedTax` with current data), the old code returned the first one that had any entries, giving stale 2018 revenue. Fix: collect all matching candidates and pick the one with the most recent 10-K filing date.

## [0.32.77] — 2026-06-11

### Added
- **Test API — SEC EDGAR tab** — new tab in Test API screen for validating the SEC EDGAR XBRL data source before full provider implementation. Enter any ticker to: (1) resolve CIK via `company_tickers.json` (cached for the session); (2) fetch `companyfacts/{CIK}.json`; (3) check all 11 US-GAAP concepts that `computeRatios()` needs (revenue, net income, operating income, D&A, stockholders' equity, current assets/liabilities, long-term debt, cash, operating CF, CapEx). Results show per-field found/not-found, concept name used, latest annual (10-K) and quarterly (10-Q) values with dates, and filing counts. Concept browser shows all available GAAP concepts, highlighting the ones in use. No API key required; SEC rate limit is 10 req/s.

## [0.32.76] — 2026-06-11

### Fixed
- **Market sync: Polygon fundamentals plan restriction (403) is now visible, not silent** — `/vX/reference/financials` requires a Polygon Developer plan or higher; the Stocks Starter plan (currently in use) returns 403. Previously v0.32.75 silently skipped the 403 per-ticker, which meant fundamentals data was quietly missing with no indication in the job history. New behaviour: on the first 403 from the fundamentals endpoint the flag `fundamentalsPlanRestricted` is set, all subsequent tickers skip the fundamentals call (avoiding ~1000 redundant 403 round-trips), and the job completes with status `success` but with a note: "Fundamentals skipped — /vX/reference/financials requires a Polygon Developer plan or higher (current plan: Stocks Starter)." Quotes still sync normally. The note is visible in Batch Jobs → run history.
- **Root cause of "why only with the orchestrator"** — the fundamentals cache TTL is 24 hours (`TTL_SECONDS.FUNDAMENTALS = 86_400`). All prior manual runs happened within 24 hours of each other, so `isStale()` always returned false and `getFundamentals()` was never called. The orchestrator's strict daily schedule is the first code path that reliably runs with a stale cache, triggering the live Polygon call and exposing the plan restriction.

## [0.32.75] — 2026-06-11

### Fixed
- **Market sync: false "Invalid Polygon API Key" abort on 403 plan-restriction responses** — Polygon returns 403 (not 401) for plan-tier restrictions, and their 403 body frequently contains the phrase "apiKey" (e.g. "your apiKey plan does not include this endpoint"). The screener's `includes('api key')` check matched this and aborted the entire sync with a misleading "Invalid or missing Polygon API Key" error even though the key was perfectly valid. Fix: only hard-abort on a genuine HTTP 401 (`'Polygon HTTP 401'`); 403 plan-restriction errors now silently skip that ticker, matching the existing behaviour for other per-ticker failures.
- **Polygon provider: 4xx auth/plan errors were retried unnecessarily** — `fetchWithRetry` retried all non-ok responses including 401 and 403. These will never recover on retry. Fix: only retry 429 (rate limit) and 5xx (server errors), matching the comment that was already in the code.

## [0.32.74] — 2026-06-11

### Fixed
- **Orchestrator: second daily slot re-runs all jobs instead of skipping everything** — the previous skip rule (`lastSuccessDate === today`) caused the 16:30 slot to skip all 10 jobs because the 10:15 slot had already marked them as "succeeded today". Replaced with a 90-minute time window: a job is skipped only if its last successful run completed within the past 90 minutes. This means a resume (re-trigger minutes after a failure) still skips the already-done jobs, while a second scheduled slot hours later re-runs everything. Skip log message now shows how long ago the job ran (e.g. "skipped (succeeded 12m ago)").

## [0.32.73] — 2026-06-11

### Fixed
- **Orchestrator: false "token invalid" on active E*Trade sessions** — the orchestrator was calling `renewAccessToken()` as the validity check, but E*Trade rejects that call when the token is active (recently used, non-dormant). This caused the orchestrator to abort with "E*Trade token invalid — renewal failed" even though Settings showed "✓ Connected". Fix: use the same date-stamp check that `checkConnection` (Settings page) uses — if `etradeTokenDate` matches today's ET date the token is valid. `renewAccessToken()` is now called as a best-effort wakeup for dormant tokens only; a failure on an active token is silently ignored.

## [0.32.72] — 2026-06-11

### Fixed
- **Orchestrator Edit modal: schedule slots now editable** — replaced the "use raw config editor" note with a full slot manager: list current slots with remove (✕) buttons, add new slots via HH:MM input (Enter or + Add), auto-sorted, duplicate/format validation. The Schedule column in the jobs table now shows the orchestrator's actual `scheduleSlots` instead of the unused `dailyScheduleTime` fallback.

## [0.32.71] — 2026-06-11

### Added
- **Batch Orchestrator** — new `BatchOrchestratorJob` (`batch-orchestrator`, sequence position 1) is the single scheduled job that drives all others. Features: non-trading day guard (scheduled runs only), E*Trade token renewal check, consolidated start email (token status + resume state + outcome), stop-on-first-failure, natural resume via per-job `last_success_date`, multi-slot scheduling (`config_json.scheduleSlots` — each slot fires at most once per day). Sub-jobs are called via `BatchService.runJobDirect()` so their full run history is preserved. "Run All in Sequence" button excludes the orchestrator. Custom orchestrator config modal in Batch Jobs view: job enable/disable list (in sequence order), validateEtradeToken + emailOnStart toggles.
- **Remote trigger** — `POST /api/v1/orchestrator/run` + `GET /api/v1/orchestrator/status` routes (X-Agent-Token auth) allow triggering and polling from Termius / Claude Code CLI when away from home.
- **Trigger context in run history** — `batch_runs.trigger` (`manual|schedule|startup`) and `batch_runs.slot_time` are recorded on every run. Batch Jobs view shows a Trigger column in run history.
- **Migration 037** — shifts all `batch_jobs.sequence_order` +1 to reserve position 1 for the orchestrator; adds `trigger` and `slot_time` columns to `batch_runs`.

## [0.32.70] — 2026-06-10

### Changed
- **Brief Stage-4 pool deepened 10 → 15 per strategy** — the liquidity gate now correctly rejects thin chains (v0.32.69), which left wheel with 4 picks and income with 3. A deeper validation pool gives the gate more candidates so each strategy can still fill 5 picks. Worst-case E*Trade cap rises to 75 unique tickers/run (typically far fewer due to cross-strategy overlap).

## [0.32.69] — 2026-06-10

### Fixed
- **Strategy Lab: stale E*Trade Greeks no longer poison structures** — E*Trade serves months-old deltas on thin (OI=0) chains while option *prices* stay correct (2026-06-10 brief: WSO chain claimed delta −0.50 at $450 with spot at $375.66 → wheel put built 11.8% ITM; AWI income straddle struck 31% above spot *passed* the critic; MIDD, ALGM also affected — 4 of 25 picks). The lab estimated the underlying from those deltas. Now: underlying price comes from `chain.underlyingPrice` (E*Trade's real-time spot, was always available but unused) → live Polygon quote → chain-delta estimate as last resort. When the delta-implied ATM deviates >8% from real spot, chain deltas are distrusted and leg selection uses moneyness.
- **Critic prompt: `strikeOtmPct` defined side-aware** — the "positive = OTM" gloss is wrong for puts; it made the LLM read AWI's broken +31% straddle as "safely OTM". Now defined as strike-vs-spot with explicit per-side ITM/OTM semantics.

### Added
- **Critic rule: `stale_lab_price`** (warning) — fires when the lab's underlying price deviates >5% from the live pick price; deterministic catch-all for structure-data integrity regardless of LLM judgment.

## [0.32.68] — 2026-06-10

### Changed
- **Batch Jobs screen: stable three-panel layout** — all three panels now have fixed heights (Registered Jobs 300px, Run History ~4 rows, Live Activity log 200px) so nothing shifts or "dances" while a job runs. The Live Activity panel is permanently visible (placeholder when idle) and the log is no longer auto-cleared 3s after a run — it persists until the next run starts, so failures can be inspected. Added ⧉ Copy (clipboard) and ✕ Clear buttons. Auto-scroll now scrolls only the log's own scrollbar; previously `scrollIntoView` yanked the entire page down on every progress event, pushing the jobs grid out of view.

## [0.32.67] — 2026-06-10

### Fixed
- **`annualizedReturn` 100× unit bug** — per-share premium was divided by per-contract collateral (`strike × 100`), understating annualized options return 100×. This zeroed the wheel `premiumYield` (wt 19) and income `premiumRiskRatio` (wt 22) scoring signals for every ticker — both strategies effectively ranked without their premium signal, letting earnings-pumped high-IVR names float to rank 1. Values self-correct on the next analysis snapshot refresh.
- **`GRADE_RANK` missing `'A+'`** — an A+ structure ranked 0 (below F); a pick whose only available structures were A+ and F would incorrectly fire `poor_structure_grade`.
- **Critic liquidity flag now reads the chosen structure** — previously it reported the *best* liquidity across relevant structures while the LLM context showed the *chosen* structure's, producing contradictory numbers in the same prompt (observed: HAYW flagged 5/15, context said 3/15 — the LLM called out the discrepancy).

### Changed
- **Earnings penalty extended to wheel + bearish** — the −20 composite penalty for earnings within 45 days (previously income-only) now applies to all short-premium strategies. 3 of 5 wheel picks on 2026-06-10 carried confirmed earnings inside the expiry window.
- **Critic calibration: info flags are advisory** — prompt now states a pick whose only flags are info-severity can still merit `pass`; `low_liquidity` threshold lowered from <6 to <4 (4–6 is normal for single-name large caps).
- **Buy strategy is stock-first** — when no buy-relevant structure grades B or better (systematic in high-IV regimes, where all debit structures grade C/F), the pick is presented as a plain stock purchase: `📈 Buy Shares` chip in the brief view, structure demoted to "Optional", `poor_structure_grade` suppressed, and the critic LLM told to evaluate the stock thesis.

### Added
- **Critic rule: bearish SPY mirror** — bearish picks now get an info flag when SPY is above its 200-day MA (the bullish/buy macro-headwind check already existed; the mirror didn't).
- **Critic rule: `counter_trend_itm_strike`** — warning when a bearish short strike sits at/below the current price (zero cushion) while SPY trends up. 3 of 5 bearish picks on 2026-06-10 had ATM/ITM short strikes on a bullish tape.

## [0.32.66] — 2026-06-10

### Added
- **Brief Trend: total Return $ in summary bar** — sum of dollar returns across all rated picks shown next to avg return.

## [0.32.65] — 2026-06-10

### Added
- **Brief Trend: Return $ column** — shows dollar return (latest available price − brief price) alongside Return %. Uses the same colour coding as Return %. Sortable.

## [0.32.64] — 2026-06-10

### Added
- **Brief Trend: all columns sortable** — click any column header to sort ascending; click again to flip to descending. Active column shows ▲/▼; inactive columns show a faint ⇅. Nulls always sort last. Sort resets when changing the brief date or strategy filter.

## [0.32.63] — 2026-06-10

### Fixed
- **Portfolio sync now captures all legs of multi-leg strategies** — long option legs (e.g. the long call in a jade/big lizard) were silently skipped during E*Trade sync. Added `'Long Put'` and `'Long Call'` position types; upsertPosition now maps LONG CALL → `Long Call` and LONG PUT → `Long Put` instead of dropping them. Greeks for long positions use natural (un-negated) chain values. Migration 036 expands the `position_type` CHECK constraint via table recreation.

## [0.32.62] — 2026-06-09

### Fixed
- **Paper trades: stale picks from multi-run days now replaced, not accumulated** — each time the brief runs on the same date, `autoCapture` now deletes all existing open picks for that strategy/date before inserting the current run's picks. Previously, picks from earlier runs (e.g. debugging iterations) were permanently retained alongside the final run's picks via the `ON CONFLICT DO UPDATE` upsert that only updated matching tickers and couldn't remove ones that were dropped. Result: income could accumulate 13 picks across 7 runs when only 5 are correct.
- **Historical cleanup on next brief run** — `cleanupStalePicksAllDates()` is called once at the start of each Stage 6. Uses `json_each(picks)` to compare open paper trades against the latest brief for each date/strategy, and deletes any ticker not present in that final run. Removes stale picks from all past dates on the next brief generation (61 stale picks identified across June 3, 5, 8, 9 from dev/debugging runs).

## [0.32.61] — 2026-06-09

### Fixed
- **Critic context mismatch: structures with `unavailableReason` excluded from LLM context** — `synthesizeVerdict` was selecting the first structure where `setup != null`, but an unavailable structure (e.g. PMCC requiring two expirations) has a non-null `setup` object with `unavailableReason` set. The LLM was seeing grade-F ghost data (no legs, no credit, no strike) instead of the actual gate-passing structure. Fixed in both `synthesizeVerdict` and `getStructureExpiry` to require `!s.setup.unavailableReason`.
- **Critic prompt: LLM never gave `pass` verdict** — system prompt framing ("your job is to find problems") and the mandatory second sentence ("what should the user check") structurally biased the LLM to give `caution` even for clean picks. Updated prompt with explicit verdict calibration definitions, allows 1–2 sentences, and instructs "do not default to caution."

### Added
- **`checkStructureGrade` critic rule** — fires `warning` when every valid structure for the strategy is grade F. Catches picks like VRT (all buy structures grade F) via a deterministic rule rather than relying solely on LLM analysis. Severity `warning` → forces `flag` verdict and surfaces as an explicit rule flag in the UI.

## [0.32.60] — 2026-06-09

### Fixed
- **`breakevenDistancePct` formula was 100× too high** — `netCredit` is stored per-contract (×100 shares) but the formula was also multiplying by 100, causing every income pick to show e.g. 760% instead of 7.6%. Fixed by removing the `* 100` (dividing per-contract credit by per-share price already yields a percentage). Added formula documentation to `docs/formulas.md#breakeven-distance`.
- **`low_liquidity` critic rule inflating flag count** — severity was `'warning'` for picks at liqScore=5/15 (the gate minimum), which forced verdict to `flag` even when the LLM was unavailable. Downgraded to `'info'` so borderline-liquid picks that passed the gate become `caution` rather than false positives.
- **Grade-F structures passing the liquidity gate** — picks where the Strategy Lab ran but all relevant structures had `unavailableReason` set (e.g. PMCC requiring two expirations) were passing `hasAdequateLiquidity()` via the `best === null → true` fallback. Fixed: now only passes when `labResult` is `null` (validation failed entirely); a lab result with no valid structure returns `false`.

### Changed
- **Critic LLM batching: 25 concurrent → 5×5 serial** — AI critic calls were all fired in parallel across all 25 picks, causing ~50% LLM failure (rate limiting). Now runs one strategy's picks (≤5) in parallel, then the next strategy. Drastically reduces rate-limit failures while still completing all 5 strategies in sequence.
- **Income scoring: −20 penalty for earnings within 45 days** — income candidates (strangles, condors) with an earnings event in the next 45 days are penalised −20 composite points before the liquidity gate. Replaces the current pattern of scoring them highly and then flagging them via the critic; keeps them out of the top 5 unless no clean alternatives exist. Configurable via `loadIncomeEarningsPenalty()` in the brief job.

## [0.32.59] — 2026-06-09

### Fixed
- **Brief funnel log: distinguish liq-failed vs outranked** — the previous log conflated two different exclusion reasons under "gated": tickers that failed the liquidity gate (liq < 5) and tickers that passed the gate but were cut by the 5-pick output cap. Log now shows `liq-failed: FWONA(3/15), CSX(3/15)` separately from `outranked: MSFT(9/15), MPC(11/15)`. `totalGated` now only counts true gate failures, not cap-cuts.

## [0.32.58] — 2026-06-09

### Changed
- **Brief: pre-gate pool widened from 5 → 10 per strategy** — each strategy now sends its top 10 scored candidates to E*Trade validation (was top 5). Post-gate output is still capped at 5 picks per strategy. Gives the liquidity gate more candidates to work with — especially for income, which frequently loses 3+ picks to the gate in low-VIX trending markets. `STAGE_4_CAP` updated from 25 → 50 unique tickers.
- **Brief: $750 price cap** — stocks priced above $750 are excluded from all brief picks before Stage 4 validation. Avoids options with very large notional size (e.g. FIX at $1,860, COST at $935). Applied after scoring so high-priced stocks still contribute to relative-strength benchmarks. Configurable via `MAX_PICK_PRICE` constant in `daily-intelligence-brief-job.ts`.

## [0.32.57] — 2026-06-09

### Changed
- **Brief funnel log: show liquidity score for each gated ticker** — log now reads e.g. `income: 5 pre-gate → 2 final (gated: CSX(liq=4/15), FWONA(liq=2/15), OGE(liq=1/15))`. Extracted `getBestLiquidityScore()` helper; `hasAdequateLiquidity()` delegates to it. No behavior change.

## [0.32.56] — 2026-06-09

### Fixed
- **`sectorMomentum` signal: ~50% null rate fixed** — `SECTOR_ETF` used GICS sector names ("Technology") but Polygon stores lowercase SIC descriptions ("electronic computers", "semiconductors & related devices"). Added `sectorStringToEtf()` keyword-matching fallback that maps Polygon SIC descriptions to SPDR sector ETFs. Coverage goes from ~0% (only GICS exact matches) to ~58% of tickers in `fundamentals_cache`. Affects `sectorMomentum` (bullish/buy) and `sectorWeakness` (bearish) signals.
- **`leverageQuality` signal: always-null fixed for wheel/bearish** — `netDebtToEbitda` has only ~9% coverage in Polygon fundamentals. Falls back to `debtToEquity * 2.5` as an approximation (D/E 1.0 ≈ ND/EBITDA 2.5) when ND/EBITDA is null. Raises signal coverage from 9% to ~30% for wheel and bearish strategies.

### Added
- **Daily brief funnel logging** — `[brief funnel]` console log per strategy at the liquidity gate showing pre-gate count, post-gate count, and names of gated tickers. Diagnostic only — no behavior change. Helps distinguish liquidity-gate scarcity from genuine candidate scarcity.
- **Score badge tooltip in Daily Brief** — hovering the composite score badge shows "Scores are strategy-specific — not comparable across strategies" to prevent cross-strategy score misinterpretation.

## [0.32.55] — 2026-06-09

### Fixed
- **Critic: `strikeOtmPct` formula was inverted** — `(price - strike) / price` produces a negative value when the short strike is OTM (above current price for a call), directly contradicting the "positive = OTM" description sent in the LLM system prompt. Corrected to `(strike - price) / price`. This eliminates the ~3 false bullish flags (e.g. COHR, ALAB, MRVL) produced each brief run.

### Added
- **Critic rule: `data_anomaly_suspected`** — new `info`-severity rule flag emitted when `priceMomentumPct` exceeds 500%. Catches spinoff/reverse-merger tickers (e.g. SNDK after the WD spinoff) where the oldest available bar gives a nonsensical 1-year return, causing the pick to slip through as a false PASS when the LLM is unavailable.
- **Critic rule: `earnings_in_window`** — new `warning`-severity rule flag emitted when a known earnings date falls between today and the structure's expiry. Previously earnings were only passed as LLM context and disappeared when the LLM was rate-limited or unavailable. Now always present in `criticVerdict.flags` regardless of LLM status.

## [0.32.54] — 2026-06-09

### Added
- **Retrospect › Brief Trend: click ticker to view 45-day chart** — clicking any ticker in the grid opens a candlestick popup showing price from the brief date through a 45-calendar-day window (the typical options expiry horizon). Overlays: dashed blue horizontal line at the brief price, `Brief` arrowUp marker on the brief date bar, `D5` arrowDown marker on the Day-5 bar (when available). Click outside the card or press Escape to close. No new IPC — reuses `historical.getPrices`. Data is partial for recent briefs (shows what's available in `historical_prices` through today).

## [0.32.53] — 2026-06-09

### Fixed
- **Brief Trend: critic column blank for all brief dates except today** — two bugs combined: (1) when the Anthropic LLM call inside `synthesizeVerdict` threw (rate-limit, transient API error, expired E*Trade token), the catch block only logged a warning and left `criticVerdict = null` with no fallback. Now falls back to a rule-check-only verdict (`confidence: 'low'`) so the column is never blank. (2) `getBriefPickDrilldown` looked up critic data via `WHERE DATE(generated_at) = ?` (UTC date) against `paper_trades.brief_date` (ET date), which is fragile. Replaced with a `brief_id` join (`MAX(brief_id) … GROUP BY brief_strategy`) that uses the direct FK already stored in `paper_trades`.

## [0.32.52] — 2026-06-09

### Fixed
- **Price Gap Fill: today's close never loaded on the same evening** — the stale-ticker threshold was `MAX(date) < date('now', '-1 day')`, so a ticker whose latest bar was yesterday was considered "fresh" and skipped. Changed threshold to `date('now')` so any ticker missing today's date is fetched. Same fix applied to the reference-ticker freshness check. Reference tickers that exist but are missing today now use a `fromDate` override (3-day lookback) instead of refetching the full 1Y range.

## [0.32.51] — 2026-06-09

### Changed
- **Retrospect › Brief Trend: 5-day trading-day price columns** — replaces the single Day+5 Price column with five individual columns (Day 1 – Day 5) showing the closing price on each of the first 5 trading days after the brief date. Weekends and market holidays are skipped naturally because data comes directly from `historical_prices` (which only contains market-open days). Each cell shows the price when available or ⏳ while that day is still in the future. Return % always reflects brief price → most recent available day; Outcome updates progressively as each day populates. Data caps at Day 5 — no tracking beyond 5 business days.
- **Retrospect › Brief Trend: drop Entry Zone / In Zone columns** — removed the buy-strategy entry zone and in-zone check columns to reduce clutter.
- **Service**: `getBriefPickDrilldown` now queries `historical_prices` directly via ROW_NUMBER() partition instead of `paper_trade_snapshots`; entry-zone lookup removed. `BriefPickDetail` type updated accordingly (`day1-5Price`, `returnPct`, `latestVerdict` replacing old day5 fields).

## [0.32.50] — 2026-06-09

### Added
- **Retrospect: Brief Trend tab** — new tab next to History that lets you drill into any individual brief's picks and compare prediction vs Day+5 outcome. Select a brief date from the dropdown, optionally filter by strategy. Table columns: Ticker (hover = AI rationale), Strategy, Score, Brief Price, Entry Zone (buy strategy only, from nearest analysis snapshot), In Zone? (was brief-day price inside the zone), Day+5 Price with actual days elapsed, Return % colour-coded per strategy direction, Outcome emoji (✅/❌/➖/⏳), Critic verdict badge with critic rationale on hover. Summary bar at top shows hit count, rated pick count, and average Day+5 return. New service methods `getBriefDates()` + `getBriefPickDrilldown()` in `paper-trading-service.ts`; new IPC `paper:brief-dates` + `paper:brief-pick-drilldown`; new `BriefPickDetail` shared type.

## [0.32.49] — 2026-06-09

### Improved
- **Daily Brief banners: hover tooltips** — both header banners now show explanatory tooltips on hover. The B-01 label explains "Day+5 hit-rate" and colour thresholds; each strategy chip shows exact hit counts and avg return. The B-02 label explains "critic pass-rate", trend arrow direction, and colour thresholds; each strategy chip shows the current pass-rate, trend description, and a full per-date pass-rate history (oldest → newest).

## [0.32.48] — 2026-06-09

### Added
- **Daily Brief: critic health trend banner (B-02)** — a second slim bar appears in the brief header showing per-strategy critic pass-rate trend across the last 7 briefs (e.g. `wheel ↑55% · buy →42% · bullish ↓28%`). Trend direction is computed by comparing the older half vs newer half of pass rates (>8pp difference = improving ↑ / declining ↓, otherwise stable →). Colour-coded: green ≥60% / amber ≥40% / red <40%; arrow coloured green (improving) / red (declining) / amber (stable). Only shows when at least one strategy has enough critic data; silently absent otherwise. New `getBriefHealthTrend()` method in `scoring-service.ts` queries `daily_briefs`, deduplicates per calendar-date, parses `picks` JSON for `criticVerdict.verdict` counts. New IPC `scoring:brief-health-trend` + preload entry.

## [0.32.47] — 2026-06-09

### Improved
- **Conviction Alerts moved to My Stocks** — the ⚡ entry-zone alert strip now lives at the top of the My Stocks screen where it belongs, reusing the already-loaded stocks list (no extra API call). Each in-zone stock shows as a colour-coded chip (green = Buy Zone, yellow = Mid Zone) with ticker, zone badge, current price, IV, and IVR. Removed from Daily Brief where it was a detour.

## [0.32.46] — 2026-06-09

### Added
- **Daily Brief: prior-brief performance banner (B-01)** — a slim bar appears directly below the brief toolbar showing last brief's Day+5 hit-rate and average return per strategy (e.g. `wheel 3/5 +1.8% avg · buy 2/4 +3.2% avg`). Colour-coded green ≥60% / amber ≥40% / red <40%. Only visible once Day+5 snapshot data exists for a prior brief; silently absent otherwise. New `getBriefPerformanceSummary()` service method uses a CTE to find the most-recent mature brief_date and aggregate per-strategy Day+5 metrics from `paper_trade_snapshots`. New IPC `paper:brief-performance-summary` + preload entry.

## [0.32.45] — 2026-06-09

### Added
- **My Stocks: AI Advisor** — new 🤖 AI Advisor button reviews all conviction stocks in a single Claude call and returns per-stock action signals + recommended price zones. For each stock it receives: current price, zone status, bands, trend direction, RSI, SMA50/200, P/E, EPS growth, grade, IV/IVR, and days to earnings. Claude returns `add` / `hold` / `reduce` / `remove` action, `keep` / `adjust` zone verdict, recommended Low/Mid/High prices, a short risk flag, and a one-sentence rationale. Results appear in a panel below the table with checkboxes per row; clicking **Apply Selected** (or **Apply All**) updates the zones in one pass (history snapshot written automatically for each change). Stocks with `adjust` verdict are pre-checked; `remove` action stocks start unchecked to prevent accidental deletion.

## [0.32.44] — 2026-06-09

### Improved
- **Filters screen: Strategy Lab button in results grid** — added 🔬 button to each row's action column, alongside the existing Analysis, Validate, Options chain, and Payoff buttons. Clicking navigates directly to Strategy Lab pre-loaded with that ticker.

## [0.32.43] — 2026-06-09

### Fixed
- **My Stocks (ConvictionView): IV showing as thousands percent** — `conviction-service.ts` was multiplying `atm_iv` values by 100 before using them, but `iv_history.atm_iv` is already stored as a percentage (e.g., 31.726 = 31.7% IV). The double-multiply produced values like 3172.6%. Removed the erroneous `* 100` from all three locations: the `list()` display path, the `recommend()` IV rank computation, and the `get()` single-ticker fetch.

## [0.32.42] — 2026-06-09

### Improved
- **Scoring engine: trend direction signals** — three strategies now penalize picks that conflict with the current price trend, making the Daily Brief's recommendations more directionally actionable:
  - **Buy** (`trendAlignment`, weight 10): uptrend=100, sideways=25, bearish=0. A sideways stock costs ~7.5 pts on the composite — enough to push a range-bound name below better-aligned alternatives. Previously sideways and uptrend stocks scored identically on this dimension.
  - **Bullish** (`trendAlignment`, weight 7): same mapping, same penalty logic. Bullish spreads need a directional tailwind.
  - **Wheel** (`notDowntrend`, weight 8): uptrend=100, sideways=75, bearish=10. Avoids selling CSPs into confirmed downtrends (falling-knife assignment risk); sideways remains acceptable for premium selling.
  - **Bearish** and **Income** unchanged — `downtrendScore` and `trendNeutral` already capture direction for those strategies.
- **Seed upgrade**: `seedBaselines()` auto-upgrades `baseline_v1`/`v2` DB configs → `baseline_v3` on startup, so existing installs pick up the new signals without resetting manual customizations.
- **Trend derivation**: when `trendLabel` is unavailable from analysis snapshots, direction is derived from `sma50`/`sma200` stack in `technical_signals` — providing coverage for all ~1055 universe tickers without requiring a prior analysis run.

## [0.32.41] — 2026-06-08

### Fixed
- **DailyBrief watchlist not appearing in dropdown**: after the brief job creates or refreshes the `DailyBrief-MMDD` watchlist, the main process now sends a `watchlists:updated` IPC push to the renderer. `App.tsx` subscribes via `window.api.watchlists.onUpdated` and calls `refreshLists()` immediately — the new watchlist appears in every dropdown without requiring an app restart or manual navigation. New `onUpdated` push listener added to the preload `watchlists` namespace.

## [0.32.40] — 2026-06-08

### Added
- **Daily Brief auto-watchlist**: after each brief run, a watchlist named `DailyBrief-MMDD` is automatically created (or cleared and refreshed if it already exists for today). All final picks from all 5 strategies are added as items; the notes field shows which strategies each ticker was picked for (e.g. `wheel · buy`). The watchlist is immediately available in Watchlists, Screener, Analysis, and anywhere else watchlists are consumed. New public methods `findByName()` and `clearItems()` added to `WatchlistService`.

## [0.32.39] — 2026-06-08

### Improved
- **Daily Brief: collapsible pick cards** — each pick is now a single-line summary row (rank · ticker · price · score · structure grade · critic verdict) that expands on click to reveal signals, strategy lab detail, nav buttons, AI rationale, and full critic analysis. Collapsed by default to reduce scrolling.

## [0.32.38] — 2026-06-08

### Fixed
- **trendNeutral signal (income)**: ADX was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes 14-period Wilder ADX for all ~1055 universe tickers and stores it in `technical_signals.adx` (migration 035). `loadTechnicalSignals()` populates `trendStrengthAdx` from it as a fallback, so income picks are now range-bound filtered even without a prior analysis run.
- **breakoutScore signal (buy)**: `entryZoneLow` was only available from watchlist analysis runs. `DailyTechnicalSignalsJob` now computes the 20-day price low as a support-zone proxy and stores it in `technical_signals.support_level`. `loadTechnicalSignals()` populates `entryZoneLow` from it, enabling the `priceNearSupport` component of `breakoutScore` for all batch-scored tickers.

## [0.32.37] — 2026-06-08

### Improved
- **AI Critic context enrichment**: four grounding improvements to reduce LLM hallucinations and improve verdict accuracy:
  - **DTE pre-computed**: `structure.dte` (calendar days to expiry) is now calculated server-side and passed directly — removes LLM date arithmetic errors (e.g. treating a 39-DTE July expiry as a "12-month hold")
  - **Market context**: VIX level and SPY trend (vs 200MA) now passed to the LLM as `marketContext` — model previously had no visibility into the macro environment
  - **Earnings in window**: `earningsInWindow` field added — queries `earnings_calendar` for any event between today and expiry; non-null result tells the model the exact date, days from now, and confirmation status of the biggest event risk
  - **Pre-computed risk metrics**: `strikeOtmPct` (how far the short strike is from current price) and `breakevenDistancePct` (income only — how far price can move before loss) are now computed server-side, removing another class of LLM arithmetic errors

## [0.32.36] — 2026-06-08

### Fixed
- **AI Critic price hallucination**: critic LLM was overriding correct live prices with stale training-data prices (e.g. flagging AMD at $490 as "fabricated" because it "remembered" AMD at ~$110). Fix: system prompt now explicitly instructs the model that all `marketData` fields are live and authoritative — training knowledge about prices is years out of date and must not be used to contradict provided data. Context also now includes `price52wReturnPct` so the model can calibrate price level from the known 1-year return without needing to recall an absolute price from training.

## [0.32.35] — 2026-06-08

### Fixed
- **Daily Brief scoring — fundamental signals always missing**: `loadFundamentals()` was reading from `screen_results` (the last screener run), so any ticker not in that run had null earningsGrowth, fundamentalScore, revenueGrowth5Y, epsGrowth5Y, leverageQuality etc. — which the AI Critic immediately flagged as `critical_signal_missing`. Root cause: the last screener run used the ETF universe (60 tickers), leaving all ~1000 stock picks with no fundamental data. Fix: `loadFundamentals()` and `loadSectorMomentum()` now read from `fundamentals_cache`, which is populated by the market-sync batch jobs for the full constituent universe (1067 rows, updated daily). `loadTechnicalSignals()` also now provides `rsi`, `smaStack`, and `lastPrice` as fallbacks from the nightly `DailyTechnicalSignalsJob` (1055 tickers), so those signals are no longer watchlist-scoped.

## [0.32.34] — 2026-06-08

### Fixed
- **Earnings Refresh bulk**: filter Finnhub bulk entries to constituent tickers only — bulk was storing 1500+ global entries (random small caps, international) of which only ~100 were S&P500/Russell1000. Counter and per-ticker delta now reflect actual constituent coverage.

## [0.32.33] — 2026-06-08

### Fixed
- **Earnings Refresh per-ticker loop**: Finnhub earnings calendar requires `from`/`to` date parameters — omitting them returns an empty response. Per-ticker calls now include a 365-day window so AAPL, MSFT etc. are correctly retrieved.

## [0.32.32] — 2026-06-08

### Fixed
- **Earnings Refresh Phase 2**: Finnhub's free-tier bulk call has a result cap (~1500 global entries); confirmed tickers like AAPL (Jul 29) were missing because they didn't fit in the bulk response. Added per-ticker Finnhub fallback loop for all constituents still missing a future date after the bulk calls. Rate-limited to 1 call/second (within 60/min free tier). Run notes show both bulk and per-ticker counts.

## [0.32.31] — 2026-06-08

### Changed
- **Earnings Refresh**: removed E*Trade loop entirely — job is now Finnhub-only. Companies without an announced next date simply have nothing to return yet; they appear on the next daily run once published. No more 950+ useless E*Trade no-data calls.

## [0.32.30] — 2026-06-08

### Added
- **Earnings Calendar**: 🗑 Reset button clears all non-manual entries (manual dates kept) — use before a clean Finnhub re-fetch

### Fixed
- **Earnings Refresh Phase 1**: Finnhub now makes two bulk calls (today→+90d and +90d→+180d) instead of one, doubling coverage and avoiding the free-tier result cap that left tickers like ABNB out of the first call. E*Trade Phase 2 delta is computed after both Finnhub calls.

## [0.32.29] — 2026-06-08

### Changed
- **Earnings Refresh**: Finnhub dates stored as `confirmed=true` — calendar shows "✓ Confirmed" instead of "~ Estimated"; Finnhub data quality verified to be reliable (ABNB, ADBE etc.). E*Trade Phase 2 loop still runs for tickers Finnhub didn't cover, but cannot overwrite Finnhub future dates (delta filter excludes them).

## [0.32.28] — 2026-06-08

### Added
- **Finnhub API key in Settings** (API & Data tab) — stored encrypted alongside Polygon/IVolatility keys; saved by the same Save Settings button
- **Earnings Refresh — Finnhub Phase 1**: when a Finnhub key is configured, the batch job now opens with a single bulk call (`today → +90d`) that pre-fills `earnings_calendar` for every ticker Finnhub covers (including ABNB, ADBE, AA, AAL etc. that E*Trade's API silently drops). Source stored as `'finnhub'`, `confirmed=false`. E*Trade Phase 2 then overwrites with confirmed dates for the remaining delta. Run notes show both phases.

## [0.32.27] — 2026-06-08

### Added
- **Test API — Finnhub tab**: API key save/load, date-range earnings calendar fetch (bulk, not per-ticker), constituent coverage counter, results table (Date · Symbol · BMO/AMC · Quarter · EPS Est/Actual · Revenue Est/Actual), raw JSON sample. Pre-implementation validation before wiring Finnhub into the earnings pipeline.

## [0.32.26] — 2026-06-08

### Fixed
- **Earnings Refresh delta filter**: the `force=true` flag passed by "Run All in Sequence" was bypassing the delta query and falling back to all 1000+ tickers. The delta filter now always runs regardless of the force flag — `force` is for non-trading-day guards in other jobs, not earnings caching.

## [0.32.25] — 2026-06-08

### Changed
- **My Stocks actions**: buttons consolidated to single row, icon-only (🎯🔬📐📉✎🕓✕) with tooltips — prevents 2-line wrapping

## [0.32.24] — 2026-06-08

### Added
- **My Stocks actions column**: four navigation buttons added — 🎯 Validate, 🔬 Lab, 📐 Payoff, 📉 Options — alongside the existing Edit / History / Remove buttons

## [0.32.23] — 2026-06-08

### Fixed
- **Earnings Refresh batch job**: switched from full-population iteration to delta mode — a single SQL LEFT JOIN now pre-filters the ticker list to only those with no stored date or a past/today date. The day after a full run, only tickers whose earnings just occurred are fetched instead of all 1000+. Manual entries and tickers with future dates are excluded before the loop even starts.

## [0.32.22] — 2026-06-08

### Fixed
- **Payoff risk matrix**: spot row is now vertically centred in the visible table area on load and whenever the strike list changes — no more scrolling to find current price

## [0.32.21] — 2026-06-08

### Fixed
- **Lizard → Payoff**: legs now always pre-populate when strikes + expiry are available; per-leg premiums default to 0 for snapshots run before v0.32.20 so the structure is pre-filled even on older data

## [0.32.20] — 2026-06-08

### Fixed
- **Lizard → Payoff navigation**: clicking 📐 Payoff from Jade Lizard or Big Lizard grid rows now pre-populates all 3 legs (sell put, sell call, buy call) with correct strikes and mid-premiums. `LizardResult` now stores per-leg premiums (`putPremium`, `shortCallPremium`, `longCallPremium`).

## [0.32.19] — 2026-06-08

### Changed
- **Grid width**: removed fixed `maxWidth` caps from Analysis Engine (1200px), My Stocks (1200px), Batch Jobs (1100px), and Strategy Lab (1000px) — grids now use full available width, eliminating horizontal scrollbars

## [0.32.18] — 2026-06-07

### Added
- **Analysis Engine — Jade Lizard & Big Lizard modes**: two new watchlist-screening tabs that find the best setup for each ticker (30–45 DTE), calculate net credit received, verify the "no upside risk" constraint (credit > spread width), and sort by total premium descending
  - **Jade Lizard** 🦎: short OTM put (~30Δ) + short OTM call (~20Δ) + long call one strike above
  - **Big Lizard** 🐊: short ATM straddle + long call one strike above ATM
  - Columns: Ticker · Price · Exp · DTE · Put Strike · Short Call · Long Call · Net Credit · Spread W · No ↑ Risk · Breakeven↓ · IV Rank · Actions
  - Both use the E*Trade options chain (same pipeline as Wheel/Options Income)

## [0.32.17] — 2026-06-07

### Added
- **Analysis Engine**: Actions column in all five mode grids (Buy, Options, Wheel, Bullish, Bearish) with 📐 Payoff, 📉 Options, and 🔬 Lab buttons — navigate directly to the respective view with the ticker (and strike/expiry where available) pre-filled

## [0.32.16] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cell and chip borders thickened from 1px to 2px

## [0.32.15] — 2026-06-07

### Changed
- **Earnings Calendar grid**: cells and ticker chips now use the Batch Jobs color palette (`#131b2e` cells, `#2d3748` borders, `#89b4fa` blue accent, `#95a5a6` muted text)

## [0.32.14] — 2026-06-07

### Changed
- **Earnings Calendar**: reverted screen chrome (toolbar, background, buttons, list rows) back to app dark theme; calendar cell colors preserved for follow-up tuning

## [0.32.13] — 2026-06-07

### Changed
- **Earnings Calendar**: replaced near-black navy palette with a light blue theme — cell backgrounds `#eff6ff`/`#e0ecff`/`#bfdbfe`, borders `#bfdbfe`/`#93c5fd`, text `#1e3a5f`, toolbar `#dbeafe`

## [0.32.12] — 2026-06-07

### Changed
- **Sidebar**: Portfolio moved above My Stocks in the Personal section

## [0.32.11] — 2026-06-07

### Changed
- **Sidebar**: swapped Personal and Misc section order — Personal now follows Strategy, Misc is last

## [0.32.10] — 2026-06-07

### Changed
- **Sidebar**: moved 🤖 Agent to Intelligence section below 📡 News & Research; moved 🔔 Alerts to the bottom of the menu (below 📋 Watchlists)

## [0.32.9] — 2026-06-07

### Changed
- **Sidebar**: merged ⚡ LEAPS and 🛡️ Collared LEAPS into 🔬 Strategy Lab as in-view tabs — reduces sidebar from 26 to 24 entries; LEAPS and Collared LEAPS are now tab buttons at the top of the Strategy Lab screen

## [0.32.8] — 2026-06-07

### Changed
- **Sidebar**: moved 📡 News & Research from the Screeners section to the Intelligence section, directly below 📅 Earnings

## [0.32.7] — 2026-06-07

### Changed
- **Scoring engine**: removed vestigial `phase2` signal infrastructure — the field existed in `ScoringSignal` but no current baseline used it; all `!s.phase2` guards removed from scoring-service, critic-service, daily-intelligence-brief-job, and TradeScoringView. The "Phase 2" section and badge in the Trade Scoring config UI are gone. All signals are now fully active or disabled by the user toggle with no hidden suppression.
- **Daily Brief AI model**: upgraded from `claude-haiku-4-5-20251001` to `claude-sonnet-4-6` for both the pick rationale synthesis (stage 5) and the AI Critic (stage 5b). Sonnet produces deeper second-order reasoning on signal interactions; cost estimate updated accordingly (~$3/M input, ~$15/M output).

## [0.31.5] — 2026-06-07

### Fixed
- Earnings Refresh Edit modal now shows correct default delay (500ms) instead of IV job's 1100ms
- `registerJob` now accepts `defaultConfig` option — seeded to DB on first registration, backfilled for existing rows where `config_json IS NULL` (upgrade path)

## [0.31.4] — 2026-06-07

### Changed — Earnings Refresh redesign
- **Universe**: now scans all unique tickers from `constituents` (S&P 500 + Russell 1000) instead of portfolio/watchlist/conviction only
- **Smart caching**: a ticker is skipped if it already has a *future* report_date stored — no re-fetch needed until that date passes. Only tickers with past/missing dates are refreshed each run
- **E*Trade only**: removed Polygon `analysis_snapshots` fallback — single source of truth, clearer failure mode
- **Rate limit**: configurable `callDelayMs` (default 500ms) in Edit modal, clamped 200–2000ms. Skipped tickers (cached) incur no delay — only tickers that actually call E*Trade
- **No-data clarity**: if E*Trade is not connected, job returns `skipped` with a message rather than looping 1,000 failed calls

## [0.31.3] — 2026-06-07

### Fixed
- Earnings Refresh: all tickers showed no-data due to a dead placeholder SQL query in `estimateFromPolygon` referencing `constituents.period_of_report_date` (column does not exist). SQLite validates column names at prepare() time even with WHERE 0. Removed the dead query; the analysis_snapshots fallback now runs correctly.

## [0.31.2] — 2026-06-07

### Changed
- Earnings Refresh is now a proper batch job visible in Batch Jobs screen (was a silent fire-and-forget in App.tsx)
- Runs on startup with 60s delay (after E*Trade tokens load) — respects 24h TTL so most launches are all-skips
- Manually triggerable via Run Now; shows per-ticker progress in live log
- Reverted silent App.tsx useEffect (v0.31.1) — batch job is the correct home

## [0.31.1] — 2026-06-07

### Fixed
- Earnings startup refresh (Earnings Refresh batch job) was missing — now fires on app open as a background task. 24h cache TTL means it is a no-op on most launches; only fetches stale or new tickers.

Reverse-chronological. Per spec EP-2.3, this is the index; per-version detail lives in `changelogs/`.

## v0.31.0 — 2026-06-07

Earnings Calendar: full feature shipping as v0.31.0. New migration 034, EarningsService (E*Trade FUNDAMENTAL quote primary, analysis-snapshot estimate fallback, manual override), IPC handlers, preload exposure. Dedicated "📅 Earnings" sidebar view with date groups, refresh, manual entry, and delete. Earnings warning banner in Validate view (fires when earnings ≤45 DTE from ticker selection). Earnings badge on Portfolio open positions (📅 with ! when before expiry). Payoff View: amber earnings annotation below P&L chart; Risk Matrix earnings column highlighted amber with 📅 icon.

## v0.30.7 — 2026-06-07

Risk Matrix critical fix: Black-Scholes was dividing leg.iv by 100 a second time. OptionContract.iv from the E*Trade chain is already a decimal fraction (0.38 = 38%), so the formula was computing sigma = 0.0038 (0.38% IV) instead of 38% — making all OTM options appear worthless and showing +$2.2k everywhere. Formula corrected to use leg.iv directly as sigma.

## v0.30.6 — 2026-06-07

Risk Matrix fix: when no options chain is loaded (manually-entered legs), intermediate date columns are now generated automatically as weekly synthetic intervals between today and the leg's expiry. Previously only the "Today" column existed, making time decay invisible. Synthetic column dates marked with ~ in the header. Footer now shows separate notices for synthetic columns and missing IV.

## v0.30.5 — 2026-06-07

Risk Matrix fix: strike rows now always include leg strikes and extend below them, even when the option strike is outside the ±25% spot range (e.g. TSLA CSP at $290 when stock is at $395). Previously all visible rows were above the strike showing only profit — now the table covers the full risk picture including losses below the strike. Leg strike rows highlighted in amber with "◀ strike" marker.

## v0.30.4 — 2026-06-07

Risk Matrix: click any cell to expand a per-leg breakdown panel showing each leg's entry price, current theoretical value, P&L, and action recommendation (Take profits / Consider closing / Close — loss exceeds premium / Watch / Hold). Click same cell or × to dismiss. Net P&L shown in header. Selected cell highlights blue.

## v0.30.3 — 2026-06-07

Payoff Visualizer: "📈 Chart / ⬛ Risk Matrix" toggle. Risk Matrix is a 2D P&L grid — rows are chain strike prices (±25% of spot), columns are Today + available chain expiry dates (all within 45 DTE; extends to 10 expiries for monthly-only chains). Pre-expiry cells computed via Black-Scholes (r=4.5%, IV from each leg; falls back to 30% when IV missing). Final column uses intrinsic-only math. Color-coded green→red, spot row highlighted, Zone label per row at expiry.

## v0.30.2 — 2026-06-07

Trade Management Alerts (ENH-5): collapsible "⚡ Trade Management" banner above the open positions table showing three rule-based alerts — Take Profits (≥50% gain via E*Trade totalGainPct), Manage Now (≤21 DTE), Delta Drift (|Δ| > 0.45). "View →" expands the relevant position row and scrolls to it. Pure frontend — no new backend code.

## v0.30.1 — 2026-06-07

Portfolio Greeks (ENH-3): "⚡ Refresh Greeks" button fetches live delta/theta/vega for all open CSP/CC positions from the options chain and writes them to the positions table. Portfolio Greeks bar now includes manually entered positions (not just E*Trade-synced ones). Short-position sign convention applied on write: positive theta/negative vega for premium sellers.

## v0.30.0 — 2026-06-07

Conviction List Phase 2: zone-entry toast notifications (FR-CV-01) when a stock transitions into Buy Zone, green count badge on the "⭐ My Stocks" sidebar item (FR-CV-03), and a "⚡ Conviction Alerts" section at the top of the Daily Brief listing any stocks currently in Buy or Mid zone (FR-CV-02).

## v0.27.0 — 2026-06-06

Payoff: InfoTip tooltip now flips to show below the trigger when the element is in the upper half of the viewport. Fixes the metrics bar tooltips being hidden under the title bar after the bar was moved to the top.

## v0.26.9 — 2026-06-06

Payoff layout: Max Profit, Max Loss, Breakeven, Net Credit/Debit, Δ, Θ, V now fit in a single compact horizontal bar above the chart. Chart height reduced (SVG 160→120, tighter padding). Options chain drawer reduced from 70vh to 45vh so chart remains visible below it.

## v0.26.8 — 2026-06-06

Payoff chart: hover tooltip. Mouse over shows a vertical crosshair, a dot on the P&L curve at that price, a faint horizontal hairline, and a tooltip box with exact price and P&L value (color-coded green/red). Tooltip flips to the opposite side when the cursor is in the right half of the chart.

## v0.26.7 — 2026-06-06

Payoff Visualizer: leg strikes are now click-to-edit (underlined, same UX as premium). Changing a sell leg strike snaps to the nearest real chain contract and updates premium + Greeks. For lizard strategies (Jade/Big/Reverse), changing any sell leg automatically recalculates the buy hedge strike using the credit ≥ spread width rule.

## v0.26.6 — 2026-06-06

Jade/Big/Reverse Lizard hedge leg selection: all three layers (Strategy Lab, Payoff auto-fill, Payoff reload) now select the buy call/put at the FURTHEST available strike where `credit ≥ spread width`, guaranteeing no upside/downside risk. Previously all three used nearest-to-percentage-of-spot, which could overshoot the credit due to $5 strike increments. Falls back to nearest OTM when no valid strike exists. `fillLegsFromChain` utility DRYs out Payoff template fill and reload logic.

## v0.26.5 — 2026-06-06

Payoff Visualizer: (1) Strategy Formula Panel — below the recognition badge, shows the key tastytrade rules for the detected strategy with actual computed values and ✓/✗ pass/fail. Covers Jade Lizard, Big Lizard, Reverse variants, Iron Condor, Iron Fly, Short Strangle/Straddle, CSP, Covered Call, vertical spreads, Bull/Bear spreads. (2) Reload Strategy button — appears at the top of the legs section when a template was applied and a chain expiry is selected; re-snaps all legs to the selected expiry using live mid-prices.

## v0.26.4 — 2026-06-06

Payoff Visualizer: fix false "∞ loss" on short-put strategies (CSP, Big Lizard, Jade Lizard, Short Straddle downside, etc.). Max loss is now computed at stock price = $0 (the true floor) rather than the chart's 50% boundary. Left-side slope removed from unlimited detection — stock cannot go below $0 so downside is always bounded. Right-side slope detection preserved for genuinely unlimited positions (naked short calls, short stock). Also fixes false "∞ profit" on long puts.

## v0.26.3 — 2026-06-06

Payoff template selection: spot price is no longer required when a ticker is set. Chain load provides the live spot automatically. Error message updated: only fires when both ticker and spot are absent.

## v0.26.2 — 2026-06-06

Payoff Visualizer: selecting a strategy template now auto-fills real premiums from the live chain when a ticker is set. Skeleton legs appear immediately; chain loads in background; each leg is snapped to the nearest real Friday expiry for that DTE and filled with the live mid-price + Greeks. Spot price updates to chain's live price. Chain panel opens automatically.

## v0.26.1 — 2026-06-06

Payoff Visualizer: templates section replaced with a grouped dropdown covering all 31 Strategy Lab strategies (Jade Lizard, Big Lizard, Reverse variants, Iron Fly, Zebras, Front Ratios, Butterflies, PMCC/PMCP, Calendars, etc.). `recognizeStrategy` expanded to identify all new structures including 3-leg lizard variants, zebras, front ratios, butterfly families (standard + broken-wing), calendar spreads, Poor Man's covered positions, and Short/Long Straddle/Strangle disambiguation.

## v0.26.0 — 2026-06-06

AI Critic — second-opinion engine for the Daily Brief. Every pick now gets a `pass / caution / flag` verdict from an adversarially-prompted Claude haiku call, backed by 6 deterministic rule checks (trend alignment, liquidity, missing signals, score concentration, cross-strategy conflict, market regime). Verdict badge shown inline on each pick card in the Brief UI with expandable flags and rationale. Strategy section headers show aggregate counts. Email now includes a Critic column. See `Requirements/ai-critic.md` for full spec.

## v0.25.0 — 2026-06-05

Options Snapshot now runs against the full S&P 500 + Russell 1000 universe (~1,100 tickers) instead of the top 300. At confirmed 0.57s/ticker this takes ~10-11 min — same as before the performance work but now covers all tickers, giving the Daily Brief `annualizedReturn` and `optionLiquidityScore` for every candidate rather than just the top 300 by IV rank.

## v0.24.9 — 2026-06-05

Options Snapshot speed fix (root cause found): `modeWheel` was making up to 9 E*Trade/Polygon calls per ticker. Two fixes: (1) `findSuitableChain` now checks DTE before calling `getOptionsChain` — cuts from 7 chain fetches to 1-2 per ticker since only the last 1-2 of the 7 generated Fridays fall in the 30-45 DTE window; (2) `forceCache=true` skips `getOptionsIV` (uses `iv_history.atm_iv` instead) and `getEarningsCalendar` (always returns null). Expected: ~2 E*Trade calls/ticker instead of ~9 → similar speed to IV Update.

## v0.24.8 — 2026-06-05

Options Snapshot: bypass Polygon API calls when run as a batch job. `analyzeTicker` now accepts `forceCache: true` which reads quote, fundamentals, and price bars directly from the local DB instead of making 3 Polygon API calls per ticker. Market Sync runs earlier in the sequence so the data is already warm. Eliminates the rate-limiter wait per ticker — expect ~0.4s/ticker vs ~2s/ticker (~4 min for 300 tickers vs ~10 min).

## v0.24.7 — 2026-06-05

Configurable call delay extended to Daily Options Snapshot (same 200–2000ms range, default 1100ms). Edit Job modal shows E*Trade Rate Limit section and run-time estimate for both IV Update and Options Snapshot.

## v0.24.6 — 2026-06-05

PERF-8: Fixed Options Snapshot candidate sort order regression (v0.24.4 introduced alphabetical ordering). Now sorts by most recent IV (atm_iv DESC) → buy_signal_score DESC → alphabetical, so the 300-ticker cap covers the most premium-rich candidates first.

## v0.24.5 — 2026-06-05

PERF-1: IV Update call delay is now configurable in the Edit Job modal (200–2000ms, default 1100ms). Shows live run-time estimate as you adjust. Migration 028 adds `config_json` to `batch_jobs` for per-job settings.

## v0.24.4 — 2026-06-05

Daily Brief and Options Snapshot now score the full S&P 500 + Russell 1000 + ETF universe directly instead of reading from screener results. Scoring engine handles quality ranking per strategy — removes Bearish blind spot and eliminates stale-screener dependency. Daily Screener job still runs for the Screener UI. See [`changelogs/v0.24.4_2026-06-05.md`](changelogs/v0.24.4_2026-06-05.md).

## v0.24.3 — 2026-06-05

New Daily Screener batch job (PERF-7): runs after Market Sync to keep `screen_results` fresh. Two passes — stocks (S&P 500 + Russell 1000, strict, default preset) and ETFs (soft, volume ≥ 500 k + price ≥ $10). Daily Brief and Options Snapshot now merge all today's screener runs instead of reading a potentially stale single row. See [`changelogs/v0.24.3_2026-06-05.md`](changelogs/v0.24.3_2026-06-05.md).

## v0.23.4 — 2026-06-04

Sidebar: Trade Scoring (⚖) moved from Intelligence to Data section, directly below Settings. See [`changelogs/v0.23.4_2026-06-04.md`](changelogs/v0.23.4_2026-06-04.md).

## v0.23.3 — 2026-06-04

E*Trade OAuth split into two non-interactive scripts for Claude Code on phone. `etrade-step1.mjs` fetches request token + prints auth URL + saves state. `etrade-step2.mjs <verifier>` completes the exchange — verifier passed as CLI arg, no readline needed. Original `etrade-login.mjs` kept for direct SSH terminal use. See [`changelogs/v0.23.3_2026-06-04.md`](changelogs/v0.23.3_2026-06-04.md).

## v0.23.2 — 2026-06-04

E*Trade remote token refresh via SSH from phone. New `scripts/etrade-login.mjs` does the full OAuth 1.0a flow in a terminal — reads consumer creds from the running app API (or `~/.tradeanalyzer/etrade-config.json` as fallback), prompts for verifier code, stores tokens immediately if app is running or writes a pending file imported on next launch. New API endpoints `GET /api/v1/etrade/credentials` + `POST /api/v1/etrade/token`. `api-server.ts` now writes `etrade-config.json` and imports pending tokens on every startup. See [`changelogs/v0.23.2_2026-06-04.md`](changelogs/v0.23.2_2026-06-04.md).

## v0.23.1 — 2026-06-04

Two fixes surfaced by Retrospect showing false negatives on day-0 paper trades:

**Retrospect day-0 verdict suppression**: open positions now show Neutral / Hold on day 0 (no full trading day elapsed). Previously `historical_prices` close (updated by the gap-fill job) could predate the brief's captured entry price, making any return % a data-freshness artefact rather than real price movement. Verdict and estimated P&L are now suppressed until `daysHeld ≥ 1`.

**`recentVolatility` scoring signal (Income + Wheel)**: new signal measuring 20-day annualized realized volatility from `historical_prices` (std dev of log returns × √252). `lower_better` — a stock making large recent moves (e.g. ADBE up 16% in 20 days) is a poor candidate for a short strangle or CSP. Income weight 20 (taken from ivRank/premiumRiskRatio/trendNeutral/optionLiquidity); Wheel weight 10. Baseline bumped to `baseline_v2` — existing configs need **Reset to Baseline** in Trade Scoring to pick up the new signal. Signal label `recentVolatility` added to DailyBriefView chip renderer.

## v0.23.0 — 2026-06-03

Paper Trading / Retrospect — closed-loop validation for the Daily Intelligence Brief. Every brief run now auto-captures all post-liquidity-gate picks as paper trades (server-side, no user action required). Unique key `(ticker, brief_strategy, brief_date)` means same-day re-runs update existing records rather than duplicate. New **🔍 Retrospect** screen (Intelligence section) with four tabs: **In Progress** (open positions grouped by brief date, with stock return %, delta-based estimated P&L, Positive/Negative/Neutral verdict, Hold/Close Signal recommendation, expandable legs detail, Close and Delete actions), **Summary** (win rate per strategy, avg return, best/worst trade, strategy accuracy table), **History** (closed/expired trades with outcomes), **Settings** (per-strategy thresholds for negative definition and Close Signal triggers — all configurable, sensible defaults applied). Positions auto-expire on view load when expiry date has passed; exit price auto-filled from `historical_prices`. Daily Brief history bar now shows brief accuracy chip (e.g. `71%`) next to each date when ≥ 3 closed picks exist; selecting a historical date shows an inline accuracy banner. No new Polygon API calls. Migration 025. See [`changelogs/v0.23.0_2026-06-03.md`](changelogs/v0.23.0_2026-06-03.md).

## v0.22.31 — 2026-06-03

Daily Brief email fixes: (1) Strategy order now matches the screen (`wheel → bullish → bearish → income → buy`). (2) "Score" column replaced with "Lab Score" (Strategy Lab `totalScore` 0-100, same system as the grade) instead of `compositeScore` (scoring engine rank used to select picks — a different system causing confusing mismatches like Grade A with Score 18). Both email and PDF updated. See [`changelogs/v0.22.31_2026-06-03.md`](changelogs/v0.22.31_2026-06-03.md).

## v0.22.30 — 2026-06-03

Fix Daily Brief showing stale data from earlier same-day runs. `persistBrief` now deletes all existing records for the same strategy on the same ET day before inserting, so each run is a clean replacement. Fixes mixed-run display (UI showing 2+4 from run 1 while email showed 5+5 from run 2) and the history view inconsistency where selecting today showed different data than the default latest view. DST-safe: uses JS `toLocaleDateString('en-CA', {timeZone: 'America/New_York'})` for the comparison. See [`changelogs/v0.22.30_2026-06-03.md`](changelogs/v0.22.30_2026-06-03.md).

## v0.22.29 — 2026-06-03

Fix two Daily Brief bugs: (1) Email showed 25 picks (pre-liquidity-gate) while UI showed 19 (post-gate) — email now uses the same `persistedPicks` map built from `liquidFiltered` data. (2) Brief history showed tomorrow's date (e.g. 6/4 for a run at 10:30pm ET on 6/3) because `generated_at` is UTC and `.slice(0,10)` gave the UTC date — fixed with `toETDate()` converting to ET before display and grouping. See [`changelogs/v0.22.29_2026-06-03.md`](changelogs/v0.22.29_2026-06-03.md).

## v0.22.28 — 2026-06-03

Daily Intelligence Brief: email delivery with PDF attachment. After the brief is generated, an HTML email is sent with trade-ready tables (ticker, grade, structure, strike, expiry, DTE, credit/debit, ann. return, POP, max loss) and a full PDF is attached (all 25 picks, complete AI rationale, signal breakdown). Uses existing SMTP config from Agent Config → Email. Email failure does not fail the job. New: `EmailService`, `BriefReportBuilder`, `pdfkit` dependency. See [`changelogs/v0.22.28_2026-06-03.md`](changelogs/v0.22.28_2026-06-03.md).

## v0.22.27 — 2026-06-03

Fix batch job stuck on "Running" with non-functional cancel. Two root causes: (1) stale `running` DB state from crashed/killed sessions — fixed by cleaning up `batch_runs` and `batch_jobs` in `BatchService` constructor on every startup. (2) `cancelJob` only signalled the abort but never updated the DB, so the UI never changed until the hung Promise settled — fixed by immediately writing `cancelled` to the DB and freeing `runningJobId` in `cancelJob`, with a guard in `runJob` to skip the final DB write if the signal was aborted. See [`changelogs/v0.22.27_2026-06-03.md`](changelogs/v0.22.27_2026-06-03.md).

## v0.22.26 — 2026-06-03

Daily Options Snapshot + Daily Intelligence Brief: graceful skip when options provider is unavailable. Both jobs now probe `getOptionsExpirations('SPY')` before doing any work. Expired E*Trade token (or any connectivity failure) returns `status: 'skipped'` with a clear reconnect message instead of timing out on every ticker. `DailyOptionsSnapshotJob` now takes `OptionsProvider` as a constructor arg. See [`changelogs/v0.22.26_2026-06-03.md`](changelogs/v0.22.26_2026-06-03.md).

## v0.22.25 — 2026-06-03

Fix Daily Options Snapshot stuck on "Running". Added a 30-second per-ticker timeout (`withTimeout`) around each `analyzeTicker` call. An expired E*Trade token (or any hung HTTP call) was causing the job to hang indefinitely on the first ticker with no way to recover. Timed-out tickers now count as failed and the loop moves on. See [`changelogs/v0.22.25_2026-06-03.md`](changelogs/v0.22.25_2026-06-03.md).

## v0.22.24 — 2026-06-03

Daily IV Capture: overwrite on every run. Removed the "already done today" skip so each run captures the latest snapshot and the 4:30pm job always writes EOD data. `storeReading()` already uses `ON CONFLICT DO UPDATE` so no schema change needed. Supports multiple intraday runs within the 10,000 credit/day MarketData.app limit (~1,500 credits per run). See [`changelogs/v0.22.24_2026-06-03.md`](changelogs/v0.22.24_2026-06-03.md).

## v0.22.23 — 2026-06-03

Daily IV Capture job switched from E*Trade to MarketData.app. Job now runs fully unattended — no OAuth token, no midnight expiry. Calls `getLiveChain(ticker, nearestMonthlyExpFor30Dte())` (single API call per ticker, `?expiration=` param), computes ATM IV inline, stores with `source='marketdata'`. E*Trade code untouched — only `DailyIvCaptureJob` and its constructor wiring in `index.ts` changed. See [`changelogs/v0.22.23_2026-06-03.md`](changelogs/v0.22.23_2026-06-03.md).

## v0.22.22 — 2026-06-03

Test API: MarketData.app live chain support. New **Live (today)** mode on the MarketData.app tab uses `?expiration=` instead of `?date=` (historical-only param that was causing 400 errors). Auto-selects the nearest monthly 3rd-Friday expiration to 30 DTE. New `getLiveChain()` / `getRawLiveChain()` methods on `MarketDataProvider`; `nearestMonthlyExpFor30Dte()` helper exported. New `test-api:get-marketdata-live-chain` IPC handler + `getMarketDataLiveChain` preload bridge. See [`changelogs/v0.22.22_2026-06-03.md`](changelogs/v0.22.22_2026-06-03.md).

## v0.22.21 — 2026-06-02

Quality signals wired into the Trade Scoring Engine and Daily Brief. `scoreFundamentals()` now uses ROIC and FCFToNetIncome alongside ROE/margin/growth. `computeEarningsGrowthScore()` blends 1Y and 5Y CAGR (1.5× weight on 5Y). Four new explicit scoring signals: `leverageQuality` (Wheel, wt 8), `leverageRisk` (Bearish, wt 8), `revenueGrowth5Y` (Bullish wt 10, Buy wt 10), `epsGrowth5Y` (Buy wt 8). AI rationales can now mention ROIC, FCF quality, and 5-year growth context. Note: existing strategy configs in DB are not auto-updated (INSERT OR IGNORE) — call Reset to Baseline in the Scoring Config UI to pick up new signals. See [`changelogs/v0.22.21_2026-06-02.md`](changelogs/v0.22.21_2026-06-02.md).

## v0.22.20 — 2026-06-02

WheelMetrics quality signals — FCFToNetIncome, ROIC, NetDebtToEBITDA, 5-year revenue/EPS CAGR, and VS/GS composite scores with StockGrade added to the fundamentals pipeline. All metrics computed from existing Polygon `/vX/reference/financials` data (no new API calls); quarterly filings limit bumped to 24 (≈6 years) for 5Y CAGR. New screener columns with star grade renderer. See [`changelogs/v0.22.20_2026-06-02.md`](changelogs/v0.22.20_2026-06-02.md).

## v0.22.19 — 2026-06-01

Phase 2 scoring signals — Relative Strength vs SPY + Sector Momentum. Four new signals wired into the Trade Scoring Engine from `historical_prices` only (no new API calls): `relativeStrength` (Bullish wt 15, Buy wt 20), `relativeWeakness` (Bearish wt 15), `sectorMomentum` (Bullish wt 10, Buy wt 10), `sectorWeakness` (Bearish wt 10). `PriceGapFillJob` now bootstraps SPY + 11 SPDR sector ETFs with 6M bars before the main stale-ticker pass so reference data is always available. Sector lookup uses `ScreenResultPayload.sector` → GICS→SPDR map. Relative strength = 90-day excess return vs SPY; sector momentum = 90-day return of the ticker's sector ETF. See [`changelogs/v0.22.19_2026-06-01.md`](changelogs/v0.22.19_2026-06-01.md).

## v0.22.18 — 2026-06-01

Daily Options Snapshot batch job — nightly Wheel analysis run on the top 300 screener candidates to keep `optionLiquidityScore` in `analysis_snapshots` current. Scheduled at 06:00 ET + on startup (5-min delay). Migration 024 makes `analysis_snapshots.watchlist_id` nullable so the batch snapshot has no watchlist affiliation. See [`changelogs/v0.22.18_2026-06-01.md`](changelogs/v0.22.18_2026-06-01.md).

## v0.22.17 — 2026-06-01

Nav: Data Sync moved to Misc (between Test API and History); Batch Jobs is now the default landing page on app launch. Data section simplified to Settings + Batch Jobs. See [`changelogs/v0.22.17_2026-06-01.md`](changelogs/v0.22.17_2026-06-01.md).

## v0.22.16 — 2026-06-01

Trade Scoring Config — full UI redesign. Pill strategy tabs with emoji, scrollable 4-column signal table (toggle, label+direction badge, weight+bar, rationale), Phase 2 divider, green/red total row, sticky footer with version input and Save/Reset buttons. See [`changelogs/v0.22.16_2026-06-01.md`](changelogs/v0.22.16_2026-06-01.md).

## v0.22.15 — 2026-06-01

Daily Brief — hard liquidity gate and specific setup details on pick cards. Picks are now dropped in Stage 6 if the best relevant Strategy Lab structure has `liquidityScore < 5` (catches OI=1 + wide spreads, threshold ≈ 3). Progress message reports gated count. Pick cards now show a second line under the grade badge: `$240 · Jul 17 · $3.25 cr` — the exact strike, expiry, and net premium from the Strategy Lab setup. See [`changelogs/v0.22.15_2026-06-01.md`](changelogs/v0.22.15_2026-06-01.md).

## v0.22.14 — 2026-06-01

Fix Payoff Assess Trade — AI was reading the expiry year (`2026`) as the DTE value, producing responses like *"long 2026 DTE provides ample theta runway"*. DTE is now computed from `leg.expiry` and injected into the prompt as `expiry 2026-07-17 (45 DTE)`. See [`changelogs/v0.22.14_2026-06-01.md`](changelogs/v0.22.14_2026-06-01.md).

## v0.22.13 — 2026-06-01

Daily Brief — Payoff, Validate, and Options quick-nav buttons on pick cards. Each card now has a compact row of three buttons: **📊 Payoff** opens the Payoff Visualizer pre-loaded with the Strategy Lab legs (slug, expiry, all option strikes/premiums/deltas); **✓ Validate** opens the Validate tab for the ticker; **📋 Options** opens the Options Chain pre-filtered to the expiry that Strategy Lab used. All three use the existing `navigate-to-*` CustomEvent deep-link system. See [`changelogs/v0.22.13_2026-06-01.md`](changelogs/v0.22.13_2026-06-01.md).

## v0.22.12 — 2026-06-01

Daily Brief — stock price and Wheel capital requirement on pick cards. Each pick now shows the last known price (`$245.30`). Wheel picks additionally show the CSP buying-power requirement (`~$24,530 cap` = price × 100) so you can gauge capital needs before opening Strategy Lab. `BriefPick.price` added to shared types; populated from `signalData.lastPrice` in the brief job at no extra DB cost. See [`changelogs/v0.22.12_2026-06-01.md`](changelogs/v0.22.12_2026-06-01.md).

## v0.22.11 — 2026-06-01

Fix Strategy Lab scrolling. Root div had no `overflow-y: auto` so `.main`'s `overflow: hidden` clipped the list after ~6–8 rows — C/F grades were rendered but unreachable. Added `overflowY: auto` + `height: 100%` to the root container. See [`changelogs/v0.22.11_2026-06-01.md`](changelogs/v0.22.11_2026-06-01.md).

## v0.22.10 — 2026-06-01

Daily Brief — Strategy Lab grade alignment on pick cards. Each validated pick now shows the grade for the strategy-relevant structure (e.g. `CSP  B`) and the best overall fit when they differ (e.g. `·  Best fit: Reverse Big Lizard  A+`). Makes the gap between stock-level scoring and live-chain execution immediately visible. See [`changelogs/v0.22.10_2026-06-01.md`](changelogs/v0.22.10_2026-06-01.md).

## v0.22.9 — 2026-06-01

Daily Intelligence Brief UI redesign. Previous layout had zero CSS — signal labels, scores, and badges were unstyled inline text. New design: bordered rounded strategy sections with collapsible headers (emoji prefix, pick count pill), two-column pick cards (circular rank badge | ticker · score badge · Validated chip · Strategy Lab button), signal chips with human-readable labels and smart value formatting, italic AI rationale with left-border accent. See [`changelogs/v0.22.9_2026-06-01.md`](changelogs/v0.22.9_2026-06-01.md).

## v0.22.8 — 2026-06-01

Daily Technical Signals batch job. New `DailyTechnicalSignalsJob` runs nightly after price-gap-fill — reads `historical_prices`, computes MACD, RSI, Bollinger Bands, SMA stack, candlestick patterns, and a `buySignalScore` (0–100, mirrors Validate screen logic), then upserts to a new `technical_signals` table. `ScoringService` now reads `buySignalScore` from this table, enabling the scoring engine to include buy-signal strength as a signal for the **Buy** (weight 20) and **Bullish** (weight 15) strategies without any live API calls. See [`changelogs/v0.22.8_2026-06-01.md`](changelogs/v0.22.8_2026-06-01.md).

## v0.22.7 — 2026-06-01

Daily Intelligence Brief & Trade Scoring Engine. New capability: configurable per-strategy scoring engine (5 strategies × expert-backed weights) + post-market batch job that screens the universe, scores candidates, validates top picks via E*Trade Strategy Lab, synthesizes AI rationale (Claude Haiku), and persists a dated brief. Two new sidebar views: **Daily Brief** (ranked picks per strategy, AI rationale, → Strategy Lab button, history dropdown) and **Trade Scoring Config** (weight sliders, signal toggles, version labels, Reset to Baseline). Two new computed signal fields: `priceMomentumPct` (52-week return from `historical_prices`) and `breakoutScore` (MA alignment + price near support). Phase 2 signal slots (`relativeStrengthVsSpy`, `sectorMomentum`) reserved in config as disabled placeholders. See [`changelogs/v0.22.7_2026-06-01.md`](changelogs/v0.22.7_2026-06-01.md).

## v0.22.6 — 2026-06-01

Batch Jobs sequence order — move to edit modal. Removed ▲/▼ buttons from the job table. The `#` column now shows the sequence number read-only. Sequence order is editable as a number field in the Edit Job modal (min 1). Saving updates the single job's `sequence_order` via `updateJobConfig` (no full-list reorder required). See [`changelogs/v0.22.6_2026-06-01.md`](changelogs/v0.22.6_2026-06-01.md).

## v0.22.5 — 2026-06-01

Fix Daily IV Update batch job — all tickers returned "no-data". Two bugs: (1) `etrade-options.ts` looked for `currentPrice` in `OptionChainResponse` but E*Trade returns the underlying price as `nearPrice` — so `underlyingPrice` was always `null`, causing `captureFromEtradeChain` to bail out immediately on every ticker. Fixed by checking `nearPrice` first with `currentPrice` as fallback. (2) `OptionContract.iv` is a decimal fraction (0.285 = 28.5%) but `captureFromEtradeChain` passed it straight to `computeAtmIv` with a wrong "already a percentage" comment — stored IV values would have been 100× too small. Fixed by multiplying by 100 when mapping. See [`changelogs/v0.22.5_2026-06-01.md`](changelogs/v0.22.5_2026-06-01.md).

## v0.22.4 — 2026-06-01

Batch Jobs sequence ordering. Jobs now have a `sequence_order` field; jobs with the same schedule run in that order. `BatchView` job table gains a `#` column with ▲/▼ buttons to move jobs up or down — changes persist to the DB immediately. New migration `021_batch_sequence.sql` adds the column (existing rows numbered by insertion order). `BatchService.reorderJobs(jobIds[])` writes new positions; `batch:reorder` IPC + `window.api.batch.reorderJobs` preload bridge expose it to the renderer. See [`changelogs/v0.22.4_2026-06-01.md`](changelogs/v0.22.4_2026-06-01.md).

## v0.22.3 — 2026-06-01

Single instance lock. Clicking the shortcut while TradeAnalyzer is already running now focuses the existing window instead of launching a second copy. Uses `app.requestSingleInstanceLock()` + `second-instance` event. See [`changelogs/v0.22.3_2026-06-01.md`](changelogs/v0.22.3_2026-06-01.md).

## v0.22.2 — 2026-06-01

Analysis sidebar order + per-tab default sort + Options Income extra columns. **Sidebar:** 📊 Analysis moved above 🔬 Strategy Lab. **Default sort:** Buy → Score desc; Options Income → Premium desc; Wheel → Suitability desc; Bullish/Bearish → Max Loss desc — applied on every tab switch and after each run. **Options Income:** three new columns — Bid, Ask, OI (open interest) — pulled from the selected contract; `OptionsIncomeResult` type and analysis service updated. See [`changelogs/v0.22.2_2026-06-01.md`](changelogs/v0.22.2_2026-06-01.md).

## v0.22.1 — 2026-06-01

Batch Jobs global session toggle. New toggle switch in `BatchView` header enables/disables all automatic batch jobs (startup + scheduled) for the current session. Defaults ON on every launch — never persists. Manual "Run Now" is unaffected. Amber warning banner shown when disabled. See [`changelogs/v0.22.1_2026-06-01.md`](changelogs/v0.22.1_2026-06-01.md).

## v0.22.0 — 2026-06-01

Analysis Engine redesign — one-click runs all 5 modes in sequence. Mode selector removed; replaced with strategy tabs (📈 Buy / 💰 Options Income / 🎯 Wheel / 🐂 Bullish / 🐻 Bearish) that populate after run. Snapshots moved below results, newest first, with per-row delete and Clear All. Each run saves a single combined snapshot (`mode='all'`) containing all 5 mode outputs. New backend: `analyzeWatchlistAllModes()`, `saveAllModesSnapshot()`, `getAllModesSnapshot()` in analysis service; `analysis:run-all` and `analysis:get-all-modes-snapshot` IPC handlers; `runAll`/`getAllModesSnapshot` on `window.api.analysis`. Progress events now include `mode` field. See [`changelogs/v0.22.0_2026-06-01.md`](changelogs/v0.22.0_2026-06-01.md).

## v0.21.1 — 2026-06-01

Batch Jobs UI — moved Run History above Live Activity panel so completed run data is visible without scrolling past the (conditionally shown) live log. See [`changelogs/v0.21.1_2026-06-01.md`](changelogs/v0.21.1_2026-06-01.md).

## v0.21.0 — 2026-06-01

Automated Batch Jobs + Live Progress Log. Three daily background jobs now run automatically: **Daily Market Sync (Stocks)** — runs `screenerService.syncUniverse('both')` at startup (+60s) and 16:30 ET; **Daily Market Sync (ETFs)** — same for the ETF universe (+90s); **Daily Price Gap Fill** — detects tickers missing recent price history and backfills via Polygon (+120s). All three chain sequentially under the existing `BatchService` scheduler. `DailyIvCaptureJob` now auto-renews dormant E*Trade tokens and surfaces a "Reconnect" CTA notification when the midnight-rollover token must be re-authed manually. `BatchView` gains a **Live Activity** panel — streaming per-ticker log with spinner header, animated progress bar, live counters (✓ updated / — skipped / ✗ failed), monospace ticker log (max 300 events, auto-scroll, auto-clears 3s after job completes). App auto-launches on Windows login. Production DB path fixed for packaged exe (`app.getPath('userData')`). `npm run package` fixed: `CSC_IDENTITY_AUTO_DISCOVERY=false` + `win.forceCodeSigning: false` prevent winCodeSign symlink errors; Windows Developer Mode required (one-time). See [`changelogs/v0.21.0_2026-06-01.md`](changelogs/v0.21.0_2026-06-01.md).

## v0.20.0 — 2026-05-31

Strategy Lab — score and explore all 31 tastylive option strategies for any single ticker using entirely fresh live data (no cache). New **🔬 Strategy Lab** sidebar entry in the Strategy section, just above 📚 Knowledge. Two tabs: **Validate** (scores all 31 strategies — IV score, direction score, premium score, liquidity score → letter grade A+/A/B/C/F, sorted best first) and **Explore** (pick any strategy + ticker → build the concrete setup with legs, strikes, P&L summary). Live data path: fresh 90-day bars for direction bias (MA20/MA50), live `getOptionsExpirations` + `getOptionsChain` for the nearest 20–50 DTE expiry, and `iv_history` table for IV rank/percentile. Each strategy card shows expandable score bars, condition flags (✓/~✗), leg table, and action buttons: **→ Explore Strategy** (cross-tab navigation), **📈 View in Payoff** (fires existing `navigate-to-payoff` event), **✨ AI Rationale** (cost-conscious on-demand Claude haiku call ~$0.003–0.005/click). New service `StrategyLabService` with `validate()`, `explore()`, `getContext()`. New IPC file `ipc-strategy-lab.ts` with handlers `strategyLab:validate`, `strategyLab:explore`, `strategyLab:aiRationale`. All 31 strategy types added to `shared/types.ts`. See [`changelogs/v0.20.0_2026-05-31.md`](changelogs/v0.20.0_2026-05-31.md).

## v0.19.2 — 2026-05-31

History screen overhaul + price bulk load. "IV History" sidebar entry renamed to **"History"**. The Gap Fill run button removed from the History screen (it already existed in Data Sync section 3). **History screen** now hosts two sections: IV (key status, coverage summary with gap count, Step 1/2 initial load) and Price History (new Bulk Price Load — fetches 2Y daily OHLCV bars for S&P 500 / Russell 1000 / Both via Polygon, universe selector, progress bar, cancelable, coverage count displayed). **Data Sync** gains section 5 **Price Gap Fill** — finds all tickers already in `historical_prices` whose latest bar is >2 days old and refreshes the last month for each; stale count shown with a ↻ Check button. Three new IPC handlers: `historical:getUniverseTickers`, `historical:getStalePriceTickers`, `historical:getPriceTickerCount`. See [`changelogs/v0.19.2_2026-05-31.md`](changelogs/v0.19.2_2026-05-31.md).

## v0.19.1 — 2026-05-31

Closed positions sync from E*Trade transaction history. New **↓ Import Closed (YTD)** button on the Portfolio Closed tab. `EtradePortfolioService.syncClosedPositions()` fetches the full YTD transaction history via `/v1/accounts/{id}/transactions` (paginated, marker-based), classifies each transaction as open/close/expired/assigned using OCC symbol parsing, pairs open+close legs FIFO per symbol, and inserts matched closed positions into the local DB with dedup guard (ticker + position_type + entry_date + exit_date). New `portfolio:etrade:sync-closed` IPC handler + `window.api.portfolio.etrade.syncClosed()` preload bridge. See [`changelogs/v0.19.1_2026-05-31.md`](changelogs/v0.19.1_2026-05-31.md).

## v0.19.0 — 2026-05-31

Knowledge Base — tastylive strategy guide (TT1469) embedded as a quick-reference view. New `📚 Knowledge` sidebar entry at the bottom of the Strategy section. 31 option strategies extracted from the PDF across 6 categories (Bullish, Bearish, Omnidirectional, Neutral, Neutral-Bullish, Neutral-Bearish). Each strategy stored as a high-resolution PNG (150 DPI) and a structured JSON one-pager in `src/renderer/src/knowledge/`. `KnowledgeView` with collapsible left drawer (search + categorized strategy list with colored section labels and active-highlight), and a content panel with **🖼 Image / 📄 Text** toggle. Image mode shows the original PDF page exactly. Text mode renders structured layout: key params (Direction, IV, DTE, PoP), setup steps, risk/reward grid, Greeks row (color-coded Long/Short/Flat/Dynamic), How It Works cards (Ideal / Not Ideal / Defensive Tactics), Volatility 2-col grid, At Expiration cards, and Takeaways. Sidebar reorganized into labeled sections (Data / Analysis / Strategy / Settings / Personal). See [`changelogs/v0.19.0_2026-05-31.md`](changelogs/v0.19.0_2026-05-31.md).

## v0.18.2 — 2026-05-31

ENH-3 Portfolio Greeks Monitor. Aggregate Greeks summary bar added to `PortfolioView`, visible whenever open positions exist. Shows **Net Δ** (sum of position deltas, stock + options), **Θ/day** (daily theta income in dollars, options only), **Vega** (aggregate vega, options only), **BP Used %** (capital deployed / configured account size — hidden until account size is set), and **Expiration buckets** (count of positions expiring ≤7d / ≤14d / ≤21d, color-coded red/amber/gray). Greeks sourced from existing `PositionEtrade` E*Trade sync data — no new API calls. `accountSize` added to `AppSettings` (default 0); inline "Set account size" prompt saves via `settings.setAll`. Formula documented at `docs/formulas.md#portfolio-greeks`. See [`changelogs/v0.18.2_2026-05-31.md`](changelogs/v0.18.2_2026-05-31.md).

## v0.18.1 — 2026-05-30

**Bug fix: `atm_iv` stored as decimal fraction instead of percentage.** IVolatility API returns IV as decimal fractions (0.285 = 28.5%). The ingest path in `IvHistoryService.backfillIvHistory()` was storing them raw, and the E*Trade auto-capture path was explicitly dividing `OptionContract.iv` (already a %) by 100 before `computeAtmIv`, producing a decimal result. Both paths now store percentages: IVolatility reads are multiplied × 100 before `storeReading()`; E*Trade reads pass `c.iv` directly (no division). Migration 017 (`UPDATE iv_history SET atm_iv = atm_iv * 100`) converts all previously stored decimal rows to percentages. The `Curr IV` column in the Opportunity Dashboard now shows e.g. `30%` instead of `0.3%`. See [`changelogs/v0.18.1_2026-05-30.md`](changelogs/v0.18.1_2026-05-30.md).

## v0.18.0 — 2026-05-30

ENH-2 Opportunity Dashboard. Removed Morning Briefing screen. New `🎯 Opportunity` sidebar view with composite scoring engine: fundamentals 25% (ROE, P/E, D/E, margin, revenue growth) + IV rank 30% + technical 25% (from analysis snapshots) + premium yield 20% (estimated 1.5%/mo). Strategy mode selector (Wheel / CSP / Spreads / Bullish / Bearish) — premium-selling modes rank high IV as favorable; directional modes invert the score. Universe selector (S&P 500 / Russell 1000 / Both). All data pulled from local DB (quote cache, iv_history, screen_results, analysis_snapshots) — no additional API calls. `OpportunityService` with batch SQL queries for IV ranks (one window-function query for entire universe), quote cache lookup, latest screen fundamentals, and latest analysis snapshot scores. `ipc-opportunity.ts` + `window.api.opportunity.run()` preload bridge. `OpportunityView` with score circles, mini score bars, IV rank badges, one-click drill-in to Analysis and Options Chain views. See [`changelogs/v0.18.0_2026-05-30.md`](changelogs/v0.18.0_2026-05-30.md).

## v0.17.0 — 2026-05-30

IV History feature — true IV rank and IV percentile from 252 days of daily 30-day constant-maturity ATM IV. New `iv_history` SQLite table (migration 016). `MarketDataProvider` HTTP client for MarketData.app historical options chains. `IvHistoryService` computes ATM IV via DTE-weighted interpolation between two expirations bracketing 30 days, detects gaps, orchestrates backfill, and queries IV rank/percentile. `IvHistoryView` management screen with token config, coverage summary, Step 1/2 initial load controls, ongoing gap fill, and live progress panel. E*Trade auto-capture: silently stores today's ATM IV whenever an options chain is fetched — free, no extra API call. `window.api.ivHistory.*` preload bridge. `marketdataApiToken` added to secure encrypted storage. Formula docs added at `docs/formulas.md#iv-history`, `#atm-iv-interpolation`, `#trading-days`. See [`changelogs/v0.17.0_2026-05-30.md`](changelogs/v0.17.0_2026-05-30.md).

## v0.16.0 — 2026-05-30

Payoff Visualizer improvements + E*Trade Quote Inspector + IV History design. Payoff: fixed Anthropic API key injection (`new Anthropic({ apiKey })`), fixed `probOfProfit` tool schema type, redesigned assessment panel with structured risks/opportunities/exit guidance cards and collapsible chain drawer. E*Trade Test API: new `etrade:get-raw-quote` IPC handler calls `/v1/market/quote/{symbol}?detailFlag=ALL` and returns full raw JSON; `QuoteInspector` component in `TestApiView` auto-highlights any IV/volatility fields found in the response. Planning: `Requirements/enhancements.md` and `Requirements/iv-history-design.md` capture the full IV rank build plan. See [`changelogs/v0.16.0_2026-05-30.md`](changelogs/v0.16.0_2026-05-30.md).

## v0.15.0 — 2026-05-26

Dual-provider architecture for options data. New `OptionsProvider` interface (`options-provider.ts`) with `getOptionsExpirations`, `getOptionsChain`, `getOptionsIV`, `getOptionsIVAndPremium`. `PolygonDataProvider` implements both `DataProvider` and `OptionsProvider`. New `ETradeDataProvider` implements `OptionsProvider` using the E*Trade Market API with live OAuth tokens. Provider chosen at startup via `optionsProvider` settings key ('polygon'|'etrade'). `LeapsCspService` refactored to take separate `DataProvider` (quotes/fundamentals/bars) and `OptionsProvider` (options calls). Settings UI adds "Options Data Source" dropdown; `window.api.settings.getOptionsProvider/setOptionsProvider` bridge. Fixed 7 pre-existing TypeScript strict-mode errors. Screener filter tests updated to match Polygon-compatible defaults. See [`changelogs/v0.15.0_2026-05-26.md`](changelogs/v0.15.0_2026-05-26.md).

## v0.14.0 — 2026-05-25

LEAPS + CSP Strategy Screener. New `⚡ LEAPS+CSP` sidebar tab. Market gate (SPY trend vs 50d/200d MA, VIX level + 5d change, HYG/IEF ratio) returns PASS/CAUTION/FAIL. Universe loaded from screener cache (no redundant API calls). LEAPS candidates screened by delta 0.70–0.90, DTE 365–730, spread ≤5%, OI ≥100, extrinsic ≤15%. CSP candidates screened by delta −0.15 to −0.30, DTE 25–50, annualised return ≥12%. Cross-ticker pairing: CSP on same OR different ticker. Combined score = LEAPS sub-score × 60% + CSP sub-score × 40%. Grades A+ (≥9.0) / A / B / C / F. Results ranked table with expandable scoring breakdowns, caution flags, alternative CSPs per LEAPS, and "Mark as Opened" tracking. Migration 011. See [`changelogs/v0.14.0_2026-05-25.md`](changelogs/v0.14.0_2026-05-25.md).

## v0.13.0 — 2026-05-25

Backtesting Engine. `BacktestEngine` service with multi-strategy back-test against historical OHLCV data. IPC handlers via `ipc-backtest.ts`. `BacktestView` in renderer. `🔁 Backtest` sidebar tab.

## v0.10.0 — 2026-05-08

Phase 10: Settings Enhancements (Priority 9). Extended AppSettings with soundAlertsEnabled, autoConnectWebSocket, defaultScreenerIndex ('sp500'|'russell1000'|'both'), theme ('dark'|'light'), keyboardShortcuts config. Added Keyboard Shortcuts tab to SettingsView. Theme support via CSS variables and data-theme attribute. Conditional WebSocket auto-connect in main process based on setting. ScreenerView loads default universe from settings. See [`changelogs/v0.10.0_2026-05-08.md`](changelogs/v0.10.0_2026-05-08.md).

## v0.9.0 — 2026-05-08

Phase 9: Morning Briefing Dashboard (Priority 7) + Alerts System (Priority 8). `007_alerts.sql` migration with `alerts` table (price, position types with thresholds). `BriefingService` with market regime detection (SPY trend via 20/50 SMA, VIX classification), action items (expiring positions, delta breaches), top 15 quality setups (ROE>15%, D/E<1.0, MarketCap>$10B). `AlertsService` with price alert checking via WebSocket updates. IPC handlers: `briefing:getFull`, `briefing:refresh` and `alerts:create`, `list`, `delete`, `markTriggered`. `BriefingView` component with MarketRegimeCard (trend/vix badges), ActionItemsList (priority icons), TopSetupsTable (sortable columns). Auto-refresh every 5 minutes. See [`changelogs/v0.9.0_2026-05-08.md`](changelogs/v0.9.0_2026-05-08.md).

## v0.8.0 — 2026-05-08

Phase 8: Portfolio Tracking (Priority 6). `006_portfolio.sql` migration with `positions` table (CSP, CC, Stock types with entry/exit prices, quantities, strike/exp dates). `PortfolioService` with CRUD operations and P&L calculations. IPC handlers: `portfolio:add`, `list`, `update`, `close`, `pnlSummary`. `PortfolioView` component with add position form, Open/Closed tabs, sortable columns, P&L summary cards (total positions, unrealized/realized P&L, capital deployed, win rate). Added to sidebar navigation. See [`changelogs/v0.8.0_2026-05-08.md`](changelogs/v0.8.0_2026-05-08.md).

## v0.7.0 — 2026-05-07

Phase 7: Screener Enhancements (Priority 5). Sortable columns using `useSortable` hook on all 17+ columns (Ticker, Company, Sector, Last Price, Day %, P/E, EPS, Market Cap, Revenue Growth, EPS Growth, D/E, ROE, Margin, FCF, Current Ratio, Volume, Beta, Pass Score). Quick Actions per row: "Add to Watchlist" dropdown and "Run Analysis" button. CSV export for filtered results. Pagination (50 items per page) with page navigation. Cache status indicator in Screener header with auto-refresh warning when data >1 hour old. See [`changelogs/v0.7.0_2026-05-07.md`](changelogs/v0.7.0_2026-05-07.md).

## v0.6.0 — 2026-05-07

Phase 6: Historical Charts (Priority 4). **Database**: `005_historical_data.sql` with `historical_financials` and `historical_prices` tables, indexes, views. **Backend**: `HistoricalDataService` with `getFinancials`, `upsertFinancial`, `getPrices`, `upsertPrice`, `calculateSMA`, `getDateRangeFromTimeRange`; IPC handlers `historical:getFinancials`, `historical:getPrices`, `historical:getPricesWithSMA`, `historical:fetchFinancials`, `historical:fetchPrices`, `historical:fetchAndStore`, `historical:needsRefresh`; Polygon API integration for financials and aggregates. **Frontend**: `HistoricalFinancialChart` (Recharts Area chart with metric selector: Revenue, Net Income, EPS, EBITDA, Total Assets, Shareholders Equity, Free Cash Flow; Quarterly/Annual toggle; CSV export), `HistoricalPriceChart` (line chart with volume, timeframe selector 1M/3M/6M/1Y/2Y/5Y, 50-day SMA overlay, price change indicator; CSV export); integrated into AnalysisView with click-to-open from ticker symbols. See [`changelogs/v0.6.0_2026-05-07.md`](changelogs/v0.6.0_2026-05-07.md).

## v0.5.0 — 2026-05-07

Phase 5: Cache Management + Wheel Columns + Real-Time WebSocket. **Cache Management System**: `cache_metadata` table, `CacheManager` service, staleness tracking with 1-hour threshold, `CacheStatusIndicator` UI component (green/red with timestamp), `useCacheStatus` hook polling every 5 minutes, auto-refresh trigger. **Wheel Strategy Columns**: `WheelCalculator` service with suitability formula (ROE×30% + D/E_Quality×30% + MarketCap×20% + Stability×25%), Target Strike (Current × 0.92), Est. Premium (Strike × 1.2%), integrated into watchlist table with color coding and sortable columns via `useSortable` hook. **Real-Time WebSocket**: `WebSocketService` connecting to `wss://delayed.polygon.io/stocks`, trade/aggregate message handlers, exponential backoff reconnection (3s, 6s, 12s, 24s, 48s), `RealtimePriceTicker` component for Analysis view, live price updates in watchlist with green/red indicators, connection status in status bar. New dependencies: `ws`, `recharts`. See [`changelogs/v0.5.0_2026-05-07.md`](changelogs/v0.5.0_2026-05-07.md).

## v0.4.0 — 2026-05-02

Phase 4: Validation Dashboard Polish + Settings/Diagnostics. Chart: pattern callouts at correct price/time coordinates, entry zone band, target line (amber), stop loss, demand/supply zone labels. Section A: EPS sparkline (SVG). Full Settings panel (SettingsView): General, API & Data, Cache & Limits, Diagnostics self-check, Backup & Restore. Settings IPC (9 handlers). Diagnostics IPC. Bug fix: `detectEveningStar` guard was inverted. See [`changelogs/v0.4.0_2026-05-02.md`](changelogs/v0.4.0_2026-05-02.md).

## v0.3.0 — 2026-05-02

Phase 3: Analysis Engine + Producer/Consumer Pipeline. FR-3 fully implemented — 5 analysis modes (Buy Opportunities, Options Income, Wheel Strategy, Bullish Strategies, Bearish Strategies) over any watchlist with composite scoring, entry/stop/target, annualized returns. FR-4.4 Validate All — batch deep-dive with verdict (Strong/Acceptable/Caution/Avoid), full indicator suite. Pipeline: `TokenBucketRateLimiter` + SQLite-backed `JobQueue` for resumable batch jobs. New `analysis_snapshots` + `job_runs` + `job_progress` DB tables. Full indicator library (`computeSMA`, `computeEMA`, `computeRSI`, `computeATR`, `computeADX`, Bollinger, MACD, swing high/low) documented in `docs/formulas.md`. AnalysisView with mode cards, run/cancel, progress bar, mode-specific results, snapshot history, save-as-watchlist.

See [`changelogs/v0.3.0_2026-05-02.md`](changelogs/v0.3.0_2026-05-02.md).

## v0.2.0 — 2026-05-02

Phase 2: Index Screener. FR-2 fully implemented — S&P 500/Russell 1000 screener with 17 default filters, strict/soft-match modes, presets, run history, save-as-watchlist. Polygon DataProvider + fundamentals computer with all ratios documented in `docs/formulas.md`. Quote auto-refresh (60s) on watchlist view. Structured API + error logging (EP-3/EP-4).

See [`changelogs/v0.2.0_2026-05-02.md`](changelogs/v0.2.0_2026-05-02.md).

## v0.1.2 — 2026-05-02

Fix `rebuild:electron` so it actually swaps the better-sqlite3 binary's ABI (v0.1.1's `electron-builder install-app-deps` was a no-op when a Node binary was already in place). Replaces both rebuild scripts with a small `scripts/rebuild-better-sqlite3.mjs` helper that calls `prebuild-install --force` and derives the Electron target dynamically. `npm run dev` now opens the window cleanly and migrations run.

See [`changelogs/v0.1.2_2026-05-02.md`](changelogs/v0.1.2_2026-05-02.md).

## v0.1.1 — 2026-05-02

Swap DB driver back from `node:sqlite` to `better-sqlite3` 12.x now that VS Build Tools 2022 is installed on the dev box. Drops the `createRequire` workaround and the vitest forks-pool/`node:` externals. Adds paired `rebuild:electron` / `rebuild:node` scripts wired into `predev` / `pretest` so the native binary's ABI always matches the runtime. Tests + typecheck still green; no behavior change.

See [`changelogs/v0.1.1_2026-05-02.md`](changelogs/v0.1.1_2026-05-02.md).

## v0.1.0 — 2026-05-01

Initial scaffold. Section 7 (Engineering Practices) infrastructure in place. Phase 1 (FR-1 — watchlist management) implemented end-to-end with persistence, CSV round-trip, and tests. No market-data integration yet.

See [`changelogs/v0.1.0_2026-05-01.md`](changelogs/v0.1.0_2026-05-01.md).
