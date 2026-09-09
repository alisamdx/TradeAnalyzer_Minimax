# NewApp changelog

The new application's living changelog (06 §8). The existing app keeps its own
`CHANGELOG.md` and `changelogs/` at the repo root; nothing here applies to it.

Versions: `@tradeanalyzer/core` and `@tradeanalyzer/next` are versioned
independently of the existing app's `1.1.x`, and both stay on `0.x` until pilot
exit (06 §6).

---

## The corruption has a signature, and it points at universe_seed (2026-09-09)

`core` 0.3.3, dictionary version 7. **Both corrupt generations were read for the
first time**, and they agree.

| | `gen-001-corrupt-20260907` | `gen-001` |
|---|---|---|
| dictionary | v5 (51 tables) | v6 (52 tables) |
| damaged | `meta_response` (Tree 5) + `raw_ticker_reference` (Tree 12) | `meta_response` (Tree 7) + `raw_ticker_reference` (Tree 14) |
| damaged pages | 453-469 | 418-432 |
| file | 2,342,912 bytes (572 pages) | 413,073,408 bytes (100,848 pages) |
| contents | 1 run, 1,092 responses, **0 bars** | 71 runs, 78,645 responses, **227,352 bars** |

**The same two tables both times, and only those two** — Tree 5/12 and Tree 7/14
are the same pair renumbered by the dictionary bump, which is exactly the trap
recorded on 2026-09-07 and this time it resolves rather than misleads, because
the tool now looks the numbers up.

**The damage does not track write volume.** `raw_daily_bar` holds 227,352 rows in
the large file and is undamaged; `raw_ticker_reference` holds 1,083 and is
wrecked. Those two tables are precisely what `universe_seed`'s per-ticker loop
writes together in one transaction.

**And it sits where the first seed wrote.** 418-432 of 100,848 pages is inside
the first ~570 — the region that file's first seed allocated. The small file
contains exactly one seed and is damaged at 453-469: the same region.

### What follows, and what does not

*Inference, recorded as one:* the damage is inflicted during a `universe_seed`
and nothing afterwards extends it. Today's corruption most likely dates from
gen-001's own first seed on 09-06/07 rather than from anything in the last two
days — the 71 runs since have been writing into an already-broken file, which is
why QC-001 had been failing for **69 consecutive runs**. Those are consequences,
not 69 fresh events. If that holds, the count of corruption *events* is the count
of seeds, not the count of times someone noticed.

**It does not explain the clean replay.** The offline harness writes this exact
pattern — same schema, same transaction shape, same two tables, 1,089 responses
at the real 250 ms pace — in both Node and Electron, and comes back `ok` every
time. Whatever the live seed does differently is still the open question.

### `meta_open_handle` could not answer the question it exists for

Keyed on `app_name` alone, so the upsert held only each application's **latest**
open. An earlier redirected open is overwritten by the next healthy one.

Measured: the corrupt generation reported both applications on the same
`db_path` — true of their last opens, evidence of nothing, and read at first as
"no split". Now keyed on `(app_name, db_path)`, so a path an application ever
resolved is permanent and a second row is a standing accusation.

**Before trusting a negative from a table, check whether the table's own key
could have destroyed the positive.**

### The new exe stamped `openedAt` in UTC

The two rows being compared were in two time bases:

```
TradeAnalyzer 2  2026-09-08T03:02:53.252Z     <- actually 2026-09-07 23:02 ET
TradeAnalyzer    2026-09-08T23:54:19-04:00
```

`tests/collector-host.test.ts` has pinned the collector host against exactly this
since it was written. The new exe had the bug anyway, because **the rule lived in
a test attached to one implementation rather than in a function both applications
call**. `etTimestamp()` is now in `core` and both call it.

---

## Every script's generation open goes through one door (2026-09-08)

`core` 0.3.2. Found while building the Electron arm of the seed replay, by
asking a question that had not been asked: *which code can open a generation?*

**Three scripts, four refusals, and they were spread across the callers.** The
redirect check was copied into `queue-job.mjs` and `diagnose-generation.mjs`; the
`-shm` in-use check lived in `openGenerationExclusively`; the refusal to create a
missing file lived in `queue-job.mjs` alone. **`exception.mjs` had none of the
four.** It resolved the pointer from `homedir()` — a third spelling of a path the
other two each spelled differently — opened the live generation with
`new Database(dbPath)`, ran `applyDictionary` against it, and closed with
`db.close()` rather than a checkpoint.

So it would open the generation from a containerised shell, while both
applications were running, creating the file if it were missing, and could lose
its writes on the way out. Every one of those failures has cost this project a
day already, and each was already prevented somewhere else in the same directory.

**The recurring shape, written down for the fourth time: a capability that must
apply to every caller belongs in the function they all call.** The changelog
entry for the redirect guard says exactly this about the applications, and the
scripts it was describing were themselves an instance of it. A copy in each
caller is not a safeguard — it is a list of the callers somebody remembered, and
`exception.mjs` was written after the list.

**Now**: `resolveGenerationPointer()` probes the pointer's directory and refuses
to invent it; `openGenerationExclusively(dbPath, who)` probes the generation's
directory, refuses while a `-shm` exists, refuses to create, and opens with the
applications' own SQLite. Both delegate to `core`'s `assertNotRedirected`, so the
operator sees the same words the applications print rather than a second copy
that drifts. Directories are the argument rather than `%APPDATA%`, because the
redirect is per file and `dataRoot` is configurable while the pointer is not.

**And the invariant is asserted rather than remembered.** A new scan in
`generation-access.test.ts` fails any script under `scripts/` that resolves the
shared pointer without importing the helper, or that constructs a `Database`
itself. It strips comments and keeps strings — the module path and the pointer
filename *are* string literals — and it ships with three fixtures: one that must
fire, one that must not, and one of pure prose about the trap that must not fire
either. Four source scans in this project have now fired on their own
documentation.

`293` tests in `core`.

### The Electron arm, and one gotcha that cost an hour

`replay-seed-in-electron.cjs` runs the seed replay inside a real Electron main
process against the Electron-ABI binary. Both arms share
`scripts/lib/seed-replay.mjs`, so the runtime is the only difference.

**Electron 32 does not run a `.mjs` entry point, and does not say so.** Passed
one on the command line it produces no output, no error and no exit — a headless
main process that has to be killed. The identical file as `.cjs` runs and prints
normally. That silent hang is indistinguishable from the corruption bug being
investigated, which is a rich source of wasted evenings; the harness is CommonJS
on purpose and the header says why.

The replay also now prints the WAL's size **before** the checkpoint (4,157,112
bytes on a clean run). The previous entry recorded
`checkpoint {busy:0, log:0, checkpointed:0}` being read as "the WAL was empty"
and carried into a wrong diagnosis. A number that had to be inferred is now
printed.

---

## STILL OPEN: `meta_response` corrupts during universe_seed (2026-09-07)

**Read this before re-running anything.** An earlier version of this entry
declared the MSIX redirect to be the cause. **That was wrong** — the corruption
recurred twice more after the redirect was guarded, on a shell verified clean,
with both applications on fixed builds. The redirect was a real bug and the
guard is worth having; it was not this.

**Do not re-seed a generation to "see if it happens again".** It has happened
three times, it costs an evening each time, and a fourth identical run adds
nothing. The two harnesses below exist so the question can be asked in minutes.

### Ruled out, each by test rather than by argument

| Suspect | How it was eliminated |
|---|---|
| ~~MSIX `%APPDATA%` redirect~~ | **BACK ON THE LIST (2026-09-09).** It was eliminated on the grounds that the corruption recurred "on a shell verified clean". The shell was not clean — see below |
| `node:sqlite` (3.51.3) vs `better-sqlite3` (3.53.1) on one wal-index | Scripts moved to one library (v1.1.204); recurred |
| The environment — path, filesystem, antivirus | `stress-sqlite.mjs`: 1,100 paced transactions into the generation's own directory over 285 s, **clean** |
| `applyDictionary` drift rebuilding tables | Idempotent — zero rebuilds on re-apply |
| A second collector job overlapping | `BatchService.runJob` returns immediately while anything runs |
| Two processes on one WAL file | TradeAnalyzer 2 was **closed** for every corrupting run |
| The collector code path | `replay-seed-locally.mjs`: real `runUniverseSeed`, real schema, real capture contract, 1,089 responses, offline — **clean** |
| The 2-minute tick's `meta_dictionary` churn | 60 open/apply/close cycles on a seeded database — **clean** |
| A mismatched native binary | `node_modules` differs from the packaged copies, which are byte-identical to each other; the ABI swap is correct |
| **Real latency between writes** | The Electron arm again at 250 ms per response — **285.5 s**, the real seed's duration, with the real schema — **clean**. `stress-sqlite.mjs` had paced 1,100 writes over 285 s without the schema; this adds it |
| **The Electron main process and ABI** | `replay-seed-in-electron.cjs`: the identical replay inside Electron 32.3.3 main (node 20.18.1, **ABI 128**), with `better-sqlite3` built for Electron — **clean**, twice, byte-identical counts to the Node arm. Again with real `safeStorage` for the archive (`REPLAY_SAFE_STORAGE=1`) — **clean** |

The two arms now share one body (`scripts/lib/seed-replay.mjs`) and differ only
in the runtime, because a divergence between two copies would be
indistinguishable from the finding.

### The redirect was never actually excluded (2026-09-09)

**A copy-on-write shadow of the generation exists in the tooling container, and
its timestamps are the evidence.**

```
%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming
  	rade-analyzer-next\data\gen-001\data.sqlite
     1,789,952 bytes   created 2026-09-06 17:47 ET   modified 2026-09-07 23:05 ET
```

Windows creates that copy **at the moment a redirected process first writes to
the path**. So the creation time is when redirected writing to `gen-001` started
and the modified time is when it last happened — a ~30-hour window that spans
every corruption event and **continues after the redirect guard shipped in both
applications**.

That removes the entire basis for eliminating the redirect. The elimination
rested on one sentence — *"the corruption recurred twice more after the redirect
was guarded, on a shell verified clean"* — and the shell was not clean. It is the
Claude Code session's own shell, it is MSIX-containerised, and it was never
probed; `assertNotRedirected` reports it redirected on the first call.

**What this does NOT establish.** Which process wrote the copy is unknown, and
nothing here shows the writing caused the corruption. The candidates are
`exception.mjs` (no guard of any kind until 2026-09-08), the earlier unguarded
versions of `queue-job.mjs` / `diagnose-generation.mjs`, and either application
launched from inside the container — both have full Electron profiles there. The
honest statement is that a known corruption mechanism was demonstrably active
throughout the window, not that it is the cause. **This is exactly the promotion
of a corroborating detail to a premise that this file already warns about, so it
is being written down as evidence and not as a verdict.**

**The two clean replay arms still stand** — the collector code path and the
Electron runtime are genuinely cleared, because those tests do not depend on the
shell.

### The paced arm did not pace, it stalled (2026-09-09)

The replay's inter-write delay used `Atomics.wait`, chosen deliberately on the
grounds that a synchronous block keeps the test honest and an `await` would
"hand the loop back and change the shape of what is being tested". Wrong twice:

- **Fidelity.** The live collector waits on a real HTTP response, which is
  asynchronous. Yielding the loop between writes is the faithful model; blocking
  it is the artificial one.
- **Function.** Parking the *Electron main thread* in `Atomics.wait` stops libuv
  running its callbacks, so the seed's own async continuations never resume. The
  paced arm used **1.9 seconds of CPU in 17 minutes** and produced no output at
  all.

The comment guarded against the opposite failure — an arm that "ran at full speed
while reporting a pace" — and the real one was worse and in the other direction.
Now `await new Promise(r => setTimeout(r, ms))`, which is both faithful and
functional.

### The diagnostic was describing the wrong file (2026-09-09)

`diagnose-generation.mjs` probed for the redirect, printed it, and then printed
the pointer contents, the derived database path, its size, its modification time,
its sidecars and the list of generations — **all read through the redirected
`%APPDATA%`, and therefore all facts about the container's shadow copy.** It
refused only later, just before opening.

Measured: it reported `data.sqlite` at 1,789,952 bytes modified 2026-09-07 23:05
with no `-wal` and no `-shm`, while the collector had been running against the
real file the following evening. Every number was real and every one answered a
different question.

It now refuses **at the probe**, before a single line about the generation, and
prints the container's own copy under a heading saying that is what it is.
*"We refuse before opening"* sounded sufficient and was not — the reading was
already wrong long before the open. **A diagnostic that cannot see its subject
must say so and stop; what it must never do is describe something else in the
same format and leave the reader to notice.**

### A new suspect, and it is not a runtime (2026-09-08)

**`exception.mjs` opened the live generation with no guards at all.** It resolved
the shared pointer itself, called `new Database(dbPath)` directly, ran
`applyDictionary` against it — the DELETE and re-INSERT of ~760
`meta_dictionary` rows, i.e. exactly the page churn that frees pages for
`meta_response` to reuse — and closed without a checkpoint. No redirect check, no
`-shm` in-use check, no refusal to create the file.

It was written for **B5's ticker-reuse rulings**, which is what was being
operated on the evenings in question, and it is the third script in a directory
where the other two had the guards. It is invisible in `meta_open_handle`,
because it never wrote a row there either.

**This is a hypothesis, and it is recorded as one.** Nothing establishes that it
was run during a corrupting window; the shell history is gone and the script left
no trace by design. What it does establish is that the "shell verified clean"
claim covered the wrong thing: **the tooling shell in use is itself
containerised** — `detectRedirect` reports `%APPDATA%` served from
`AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming`, and both
applications have full Electron profiles under that path, `trade-analyzer-next`
including a private `data\gen-001\data.sqlite` and two archive files from the
2026-09-07 seed. A redirected process opening the generation is the one mechanism
that is *known* to corrupt it, and one existed in the toolbox the whole time.

The defect is fixed on its own terms regardless of whether it caused the three
events — see the entry below.

### What remains

Everything reproducible offline is now clean: the collector code path, the
Electron runtime and ABI, real `safeStorage`, the real schema at the real pace
(285 s), and the environment. Two differences from a live corrupting run are
left, and they are of very unequal weight:

1. **A redirected process writing the same file.** Established above as having
   happened throughout the window, and it is the *only* mechanism anyone has
   shown can corrupt this database. Every path that could do it is now guarded —
   both applications (v1.1.202), all three dev scripts (v1.1.205), the
   diagnostic's reporting (v1.1.207).
2. **The full application around the collector** — the batch service, the API
   server, the renderer, the other jobs. Untested, and no mechanism proposed.

**The next step is therefore not another elimination.** It is to read what the
real `gen-001` says, from a shell that can see it: `PRAGMA integrity_check`, and
`meta_open_handle`, which records every application that opened the generation
and the `db_path` each one resolved. Two different `db_path` values in that table
would show the split directly rather than by inference — that is what the table
was added for, and it has never been read.

### Two claims that were presented as evidence and were not

- **"Identical file sizes prove this is not I/O damage."** Three events, three
  sizes: 2,318,336 / 2,355,200 / 2,363,392. The first two matched and I carried
  the inference forward without rechecking it when the third arrived.
- **`checkpoint {busy:0, log:0, checkpointed:0}` means the WAL was empty.** A
  healthy control run reports exactly that with a WAL that peaked at 4,120,032
  bytes. It is what a successful `TRUNCATE` looks like.

Both were load-bearing in a wrong diagnosis. **A corroborating detail should be
re-checked when new data arrives, not promoted to a premise.**

### What the redirect investigation did produce (all still valid)

**None of the three hypotheses recorded with the original bug was
right, either.** `applyDictionary` running every tick, the FK behaviour of the rebuild
paths and the archive/transaction ordering were all innocent.

**What it actually was.** Both applications had been launched at some point from
a **containerised (MSIX) shell**, which silently redirects `%APPDATA%` into that
package's `LocalCache\Roaming` with **copy-on-write**. The evidence is
unambiguous and was sitting on disk the whole time:

- A full Electron profile for **each** app exists under
  `AppData\Local\Packages\<pkg>\LocalCache\Roaming\` —
  `trade-analyzer-next\` (blob_storage, Cache, GPUCache, Preferences,
  `data\gen-001\data.sqlite` at 1,941,504 bytes) and `trade-analyzer\`
  (Preferences and blob_storage written **2026-09-07 17:16**, inside the
  corruption window). Those are the applications running redirected, not stray
  file copies.
- Enumerating the generation directory through `%APPDATA%` lists **`gen-001` and
  `gen-001-corrupt-20260907`**; enumerating the container path lists **`gen-001`
  only**. A redirected directory listing is a *merge* of the two views, so this
  proves there are two `data.sqlite` files behind one logical path, and that a
  redirected process is served the container's copy.

**Why that corrupts rather than merely diverging.** The redirect is per file. By
the time the seed ran, `data.sqlite` had been copy-on-written into the container
while `-wal` and `-shm` still fell through to the real ones. So the two processes
coordinated through **one lock and one write-ahead log while writing two
different base files**: WAL frames written against one base were read and
checkpointed against the other. That is not a stale read, it is a manufactured
btree.

Every recorded symptom follows from it, including the ones that made it look
like an application bug:

- **`Tree 5` is `meta_response`** — confirmed by building a fresh generation from
  the dictionary and reading `sqlite_master.rootpage`. It is the table
  `universe_seed` writes hardest, so it is where mismatched frames land first.
  It also disposes of the note that "the damage reaches an early table"; the
  damaged table *is* the busy one.
- **Identical 2,318,336 bytes on two independent runs** — deterministic because
  the interleaving is deterministic, not because a code path is.
- **1,587 membership rows and ~1,001 `meta_response` rows first** — the seed's
  three list responses plus about a thousand of 1,089 per-ticker reference calls.

### The fix

**`assertNotRedirected`** (`packages/core/src/db/appdata-redirect.ts`) measures
the redirect by writing a marker and going to look for it — the only honest test,
since `%APPDATA%`, `process.execPath`, `cwd()` and `import.meta.url` all read as
the real thing from inside a container. **Both exes call it on the one path that
opens a generation, before any SQLite handle exists**: `openGeneration()` in the
new exe, `ElectronCollectorHost.openGenerationDb()` in the collector host. Each
checks the pointer's directory *and* the generation's, because `dataRoot` is
configurable and the pointer is not.

The guard existed only in `queue-job.mjs` and `diagnose-generation.mjs` — the two
places that could not destroy anything — while the applications that could had
none. Both scripts now import the same implementation. **That is the recurring
shape: a capability that must apply to every caller belongs in the function they
all call.**

Three details the guard gets right on purpose:

- It answers **without writing** for a path outside AppData, since no container
  redirects one.
- It probes the nearest existing ancestor, so a first run whose generation
  directory does not exist yet is still answered.
- An inconclusive probe is **`undetermined`, never `redirected`**. A cheap local
  check standing in for an authority must be able to say "don't know" — saying
  "no" here would refuse to open the only database there is.

**`meta_open_handle`** (dictionary version 6) is the second half. The guard
prevents the split that is now understood; the table makes any other one
*visible*. Both applications write a row on open — name, version, pid, resolved
`db_path` — so "are the two apps looking at the same file" is answered by reading
rather than by inference. `diagnose-generation.mjs` prints it and flags a
disagreeing path or a lone row. On 2026-09-07 that question was answered by
inference repeatedly and wrongly every time, because **a redirected process reads
every path back exactly as it wrote it**.

Tests: `packages/core/test/appdata-redirect.test.ts` (12) and
`test/open-handle.test.ts` (4). The redirect test builds a **real fake container**
— a junction whose `LocalCache\Roaming` *is* the probed directory — so the guard
is asserted to fire, not only to stay quiet. A guard that can only be tested for
silence is the own-at-strike band again: structurally incapable of firing and
indistinguishable from one nothing violates.

### Where the generation stands

`gen-001` is corrupt and should not be re-seeded until the Electron test above
has been run. Both harnesses live in `packages/core/scripts/`:

```
node packages/core/scripts/stress-sqlite.mjs "<dir>" 1100 250
node packages/core/scripts/replay-seed-locally.mjs "<dir>" 1089
```

Both need `npm run rebuild:node` first if the repo was last used to package, and
both say so rather than failing cryptically. Neither touches a real generation.

## The universe came from the wrong place (2026-09-07)

The first live `universe_seed` succeeded — 2,096 Polygon calls, every one a 200,
membership reconciled, archive written. **It captured the wrong 2,000 tickers.**

`NEW_APP_UNIVERSE_SOURCES` asked Polygon for `market=stocks&type=CS` and
`type=ETF` with `limit=1000`, under the list names `sp500` and `etf_list`. Two
faults, compounding:

1. **No index filter.** Polygon has no index-membership endpoint on this plan,
   so the query returned *every* US common stock. The list names were
   aspirational and nothing contradicted them.
2. **No paging.** `limit=1000` returns one page; Polygon pages with `next_url`,
   and the parser read a single `results[]`.

Result: **2,000 tickers, alphabetical, A through DBND** — `AAAA`, `AACI` and
every microcap in between — with **MSFT, NVDA, TSLA, SPY, GOOGL, META, JPM, XOM
and WMT all absent.** Every call returned 200 and the job reported success. It is
the Finnhub cap trap again: *a response at the cap is not a complete answer*, and
here nothing looked at the cap at all.

**The correct lists were never remote.** The host application maintains them in
its own `constituents` table — 503 S&P 500, 1,024 Russell 1000, 60 ETFs, **1,089
distinct across 1,587 rows**, exactly the figure 04 §4.1 records. "Which source
answers for each list" was always meant to be host-side configuration; the
mistake was assuming host-side meant *remote*.

**`UniverseListSource` now supplies its own response** instead of naming a
Polygon path. A remote source calls the host's transport; a local one serialises
what the host already holds. Both go through the same capture contract, so a
membership row still points at real archived bytes — the archive records *what we
were given*, and the host's curated list as of that moment is a legitimate answer
to that. `core` stays ignorant of the other application's schema, which is the
point of the seam. New provider value `host_app`, because attributing the list to
a data vendor would be a lie in the one column that says where a row came from.

**Recovery needs no reset**: `reconcileMembership` closes members absent from an
incoming list, so a corrected seed closes the 2,000 wrong memberships and opens
the right ones. The stray `raw_ticker_reference` rows stay, which is what
append-only means — they are true observations of tickers that were briefly in
the universe.

### And a third gap in the schema guard, from the same change

Adding `host_app` to an enum changes **no column name**, so the migration guard
saw nothing — `enumOf` bakes its values into a CHECK at CREATE TABLE time, and
the first insert using the new value would have failed on a constraint inside
someone else's transaction, long after the change.

`applyDictionary` now compares the whole stored DDL against the generated one.
Because that comparison is textual it is only ever allowed to **rebuild an empty
table**, never to refuse a populated one — a normalisation false positive then
costs one harmless recreate instead of bricking the app. Drift on a populated
table is **reported** (`driftBlocked`), not thrown: those rows are still valid
under the constraint they were written with, and refusing to open the generation
would be the worse failure.

The normalisation was wrong on its first run — the generator terminates its
statement and `sqlite_master.sql` does not, so all 50 tables read as drifted.
Caught by the idempotence test, which is exactly what that test is for.

`268` tests in `core`.

## The trading calendar seeds itself (2026-09-07)

`ref_trading_day` was in the dictionary from B2, is read by preflight, the
watchdog and several checks — and **nothing had ever written it.** Found while
getting the collector ready for its first real daily run.

**An empty calendar does not stop anything, which is the whole problem.**
Preflight and the watchdog both treat an unknown date as a trading day, and that
default is right: a needless run costs calls, a skipped one costs a day that
cannot be recovered. But it fails open in one direction only — with no calendar,
**every weekend and holiday looks like a session.** The collector would have run
today (Labor Day), written holiday-dated snapshots of Friday's data, and the
watchdog would have emailed "no daily run exists for today" every Saturday and
Sunday. A watchdog that cries on a schedule is one nobody reads.

**Generated from rules, not from a pasted list.** `source = 'nyse_rules'` was
always the intent. A hardcoded table of dates works until the year it runs out,
and it runs out silently — the existing app's covers 2023–2027, so a 2028 run
would read every weekday as a session and expect bars on Christmas. The
generator does the ten scheduled closures with their observance rules, 13:00
early closes, and the monthly expiration as the third Friday **or the preceding
session when that Friday is a holiday**.

**Validated against an independent source, in both directions.** The rules are
tested against the existing app's separately maintained 2023–2027 list: nothing
missing, nothing extra. Fifty dates agreed by two sources built from different
information is much better evidence than either alone — and the single
disagreement is the finding. 2025-01-09 (National Day of Mourning, Jimmy Carter)
is an unscheduled closure no rule can generate, so it is listed explicitly with
`source = 'manual'`, which the generator never overwrites.

**Three rules that are quietly easy to get wrong**, each with its own test: the
NYSE does **not** observe New Year's Day when it falls on a Saturday (unlike
every other fixed-date holiday, so December 31 stays a session); Good Friday has
no fixed date and no n-th-weekday rule, so it needs the Easter computation; and
Juneteenth begins in 2022. `263` tests in `core`.

**A test fixture I had to correct, which is worth recording.** The
expiration-walks-back case first asserted April 2015 — but 2015-04-03 was Good
Friday and only the *first* Friday of the month, so the test was wrong and the
code was right. The case needed a month where the two genuinely collide:
2019-04-19 was both Good Friday and the third Friday, and the expiration moved
to Thursday the 18th.

## The IV bootstrap source: IVolatility (2026-09-07)

Spec only. Q17's last open item closed, and the reason is worth recording
because **the changelog alone would have given the wrong one.**

v0.23.7 reverted MarketData.app with "hit rate limits in practice" — but that
revert was of the **daily capture** job, which is a different role from a
one-time historical pull. Rate limits on an unattended nightly job say nothing
about a one-shot backfill, so on the changelog alone MarketData.app still looks
viable for the bootstrap.

**The disqualifying fact lives in a source comment, not in any changelog.**
`marketdata-provider.ts` records that MarketData.app returns null IV — *"common
for historical chains"* — and falls back to solving Black-Scholes from the
bid/ask midpoint, tracking which it used in `ivSource: 'api' | 'bs'`. Its `date`
parameter is an **expiration filter, not an as-of date**, so a historical
snapshot needs a two-call bracket per day. `ivolatility-provider.ts` reads
`/equities/eod/ivx`, which returns pre-computed constant-maturity ATM IV as true
as-of-date snapshots, and is annotated "the primary source for IV history
backfill". The stored rows agree: IVolatility **262k** over a year,
MarketData.app **1k** over two days.

**`.ai/AI_CONTEXT.md` had the two backwards** — MarketData.app listed as
"IV-history backfill" and IVolatility as "Alternative IV-history source" —
which is the opposite of what both the code and the data say. Corrected. A state
snapshot that inverts a settled decision is worse than no snapshot: it is exactly
the document a later session would trust.

**Two consequences for B7b.** `iv30` arrives as a **decimal fraction**, which is
what 02 §0.1 stores, so there is **no ×100** — the existing app multiplies
because it stores percentages, and carrying that habit across would inflate every
bootstrap row a hundredfold. And IVX is **IVolatility's own** constant-maturity
computation while `derived_iv30_daily` is ours, so the overlap window compares
two different *methods*, not just two vendors — which makes QC-908's 2-vol-point
threshold a quantity to **measure over the first 20 paired days**, not to trust.

---

## The new exe could not start, and survived not starting (2026-09-07)

B7a's `raw_index_quote` status split added a NOT NULL column, which
`applyDictionary` refused — correctly by the letter of its rule. The exe then
**failed invisibly**, which is the part worth keeping.

**What the operator saw: nothing.** No window, no error, no exit — and three
`TradeAnalyzer2` processes sitting in Task Manager looking exactly like an app
somebody forgot to close. It was found only because the build guard kept
refusing to package, and the first reading of it was wrong: three processes with
no window title looked like orphaned children of a closed app, and they were a
launch that had never opened one. **A live instance reports an empty
`MainWindowTitle` too, so that signal proves nothing; the real tell is the
process count — a healthy instance has four (main, gpu, renderer, utility) and
the broken one had three, because the renderer is spawned by the window that was
never created.**

**Two independent bugs, and the second is the transferable one.**

1. `openGeneration()` throwing inside `app.whenReady().then(...)` with no
   `.catch()` became an *unhandled rejection warning* on a stderr nobody reads.
2. Because `createWindow()` never ran, **no window ever existed** — and
   `window-all-closed` only fires once a window has been created and closed. So
   `app.quit()` was never called and the process lived forever. **The absence of
   a window is precisely what disabled the mechanism that would have shut it
   down.** Startup failures now show a dialog and `app.exit(1)`, and
   `unhandledRejection`/`uncaughtException` route to the same place.

**The schema rule had a matching gap, in both directions.** It protects *written
rows*, so an **empty** table is a different case: nothing can be reinterpreted
that was never recorded. A reshape of an empty table is now applied by
rebuilding it from the dictionary; a table holding even one row keeps the strict
refusal, and the error now names the row count. gen-001 held **zero** collected
facts — 1,442 `meta_dictionary` rows and two bookkeeping rows — so the change
that was refused could not have destroyed anything.

**And the guard only ever looked one way.** It compared columns the dictionary
had *gained* and never ones it had **lost**, so a dropped column stayed in the
table — still NOT NULL, still carrying its CHECK — leaving a table that accepts
no inserts at all. That would have surfaced much later as a constraint error
inside an ingestion transaction, reading as a parser fault rather than as schema
drift. **A reshape has two halves and only one was being checked.**

Verified end to end against the real gen-001: the table was rebuilt with its
append-only triggers and index intact, the window opened, and closing it left
**zero** processes behind. `247` tests in `core`.

---

## B7a — the event and macro domains (2026-09-07)

Phase 8 runs inside the daily collection: earnings, EDGAR filings and XBRL
facts, index quotes, the treasury curve, the macro calendar, short interest,
analyst recommendations and Form 4 insider transactions — nine sub-phases across
five transports, with twelve checks registered alongside them (QC-601–604,
QC-701–702, QC-901–906) and the Earnings view reading what they write. `241`
tests in `core`, `21` in `next`.

**B7 was split.** `bootstrap_iv` waits on a spend decision — which IV source to
buy — and nothing else in the step does, so the eight domains that were ready
shipped rather than waiting behind a purchase. B7b carries the bootstrap, phase
9's derivation, QC-907/908 and the IV view.

**Every parser here was written after reading a live response, and that is where
all four findings came from.** Reading first cost four fetches; each of the four
would otherwise have been a silent wrong answer rather than a crash.

- **The FOMC page has three traps and every one of them is silent.** A meeting
  straddling a month boundary names *both* months (`Apr/May 30-1`) and the
  decision day belongs to the **second** — reading the first gives 2024-04-01, a
  real date wrong by a month. Not every entry is a range: 2025 carries
  `August 22 (notation vote)`, which a regex demanding `d-d` drops without a
  word. And the year panels are **not in chronological order** (2026 first, down
  to 2021, then 2027), so a flat sweep attaches every meeting to whichever year
  parsed last.
- **The Treasury CSV spells one tenor differently from the other thirteen.**
  `1.5 Month` where the rest abbreviate (`1 Mo`, `3 Mo`, `1 Yr`). The parser maps
  by **name**, so a renamed header drops one column and QC-902 reports 13 of 14
  tenors; a positional parser survives the rename and silently shifts an entire
  curve one column. Column *order* is not part of a CSV's contract unless the
  publisher says it is.
- **EDGAR's `filings.recent` is capped at 1,000**, with the rest in a
  `filings.files` overflow — the same truncation shape as Finnhub's 1,500-row
  calendar, flagged the same way even though this one truncates from the *older*
  end and is therefore harmless here. Harmless-in-the-current-usage is not a
  reason to leave a cap undetected; the Finnhub one was harmless too until a
  window grew.
- **A Form 4 wraps every value in a `<value>` element** that may sit beside a
  `<footnoteId/>`, so reading the field's text concatenates both — and a gift's
  absent price is an *empty* element rather than a missing one, stored null and
  never zero, which would read as a free purchase.

**One design correction, found by the schema rather than by a response.**
`raw_index_quote` gave `last, open, high, low, prev_close` a single shared
status, which the generated CHECK constraint reads as strictly all-or-nothing.
A response missing only `open` would then have had to null `last` as well — and
QC-901 treats an absent `last` as **blocking**, so one missing context field
would have taken out the market-regime read entirely. `last` now carries its own
status and the four session fields share theirs. **A shared status column is an
assertion that those fields arrive together; it has to be earned per group, not
applied to whatever a table happens to hold.**

**Derivative transactions are deliberately not captured.** A Form 4 carries them
alongside the share trades, and `raw_insider_transaction` has no column that
would tell them apart — so storing both would put an option grant's notional
share count in the same `shares` column as an open-market purchase and corrupt
every insider-buying signal computed from it, undetectably. Admitting them needs
a column first, which is a decision rather than an ingestion detail. Same reason
`transaction_code` stays verbatim: an `F` (shares withheld for tax) is not a
sale, and a two-way buy/sell mapping manufactures insider selling out of payroll.

**The earnings sweep subdivides on the cap rather than trusting it**, which is
the one piece of this step with a body count behind it: the existing app trusted
a response sitting exactly at Finnhub's 1,500-row limit, stored NVDA's August
report as November, and ranked NVDA wheel #1 on the day it printed. QC-601
enforces the asymmetry that follows — a date may move **nearer** without bound,
but **later** only by 14 days, because a large later slip is the truncation
signature and not an issuer refining its plans.

**The cadence gate reads `meta_response`, not the domain tables.** "When did we
last write a recommendation row" cannot separate a call that was never made from
one that was made and returned nothing, and those two want opposite responses.

---

## The IV bootstrap must buy an overlap (2026-09-07)

Spec only — no code. `04 §7.3`, `03 §3.8a` (QC-907, QC-908), `02 §13`, `05 §4.6`,
`06 §9`'s B7 gate, and the Q17 answer in `00`.

**Measured on the existing app's `iv_history`, which is what prompted this.**
333,497 rows, 1,126 tickers, 2025-05-29 → 2026-09-04, 0.46 % internal gaps —
well populated, not the empty table CLAUDE.md's note implied. But it is spliced
from IVolatility (to 2026-05-29) to E*Trade-computed values (from 2026-06-01)
with **zero overlapping ticker-days**, and that is the whole problem: on equal
67-day windows the E*Trade era carries 1.30× the IV range and 1.24× the
day-to-day noise, which would matter a great deal to IV rank — but the windows
are different calendar quarters, so source character and market regime cannot be
separated, and no further analysis of the stored data ever will separate them.

**The seam's level step is not evidence of anything**, which is worth recording
because it was my first reading: +2.9 % across the join, against +1.0 %, +3.4 %
and +5.2 % on comparable weekends *inside* the IVolatility era. A step with no
baseline beside it is not a finding.

**So the requirement is on the purchase, not only on the check.** The pull must
cover `stitch_date + 20 trading days`. A source that sells history only up to
the purchase date cannot be accepted whatever it costs, because the comparison
it forecloses cannot be recovered later — this is the one requirement here that
is impossible to add retroactively, and the old table is the proof.

**Loading and accepting are now separate.** Rows land `accepted = 0` and
**nothing reads them**; rank reports its declared gap exactly as if no bootstrap
had been bought. Acceptance needs 20 paired days and an operator ruling on the
disagreement statistic, and only then does `stitch_date` get set.

**A zero-overlap check now FAILS.** As drafted it read "for every day both
series exist, store the paired difference" — which on zero such days evaluates
nothing and is indistinguishable from a clean result. The paired-day count is
now a thresholded quantity in its own right (QC-907), reported on every
evaluation whether it fired or not, so *no overlap* and *clean overlap* can
never look alike. Same shape as the conviction band that could never fire and
the liquidity gate that always did; the fourth instance in this project, and the
first one caught in a spec rather than in production. B7's gate now requires
QC-907 to be **shown firing on a zero-overlap fixture**.

---

## B6 — the account, the chain subset, and the chains (2026-09-07)

Dictionary 4 → 5. Phases 5, 6 and 7 now run inside the daily collection, with
the thirteen chain checks and the six account checks registered alongside them,
and the inspector grew the two views that read what they write. `184` tests in
`core`, `21` in `next`.

**What runs.** Phase 5 discovers the account keys rather than taking them from
configuration (`/v1/accounts/list`, every account not `CLOSED`), captures
positions, balance, executed orders and the transactions fallback, and derives
the `held_in_book` sticky contracts from the positions it just wrote — which is
why it runs *before* the chain phases rather than after them. Phase 6 evaluates
the subset rule and admits; it never removes. Phase 7 asks each ticker for its
own expirations and then makes one chain call per selected expiration, storing
every strike returned.

**Every converter here exists because a live response disagreed with a field
name.** `inTheMoney` is the string `"y"`/`"n"` and `Boolean("n")` is `true`;
`timeStamp` is epoch seconds while an order's `executedTime` is milliseconds; a
genuine `0` volume arrives on 60 of 171 live SPY calls, so absence is a
**presence** test and never a truthiness one; `lastPrice` is `0` for a contract
that has not traded, which is stored as null rather than as a trade at zero.
Each of those is one test.

**`order_id` is deliberately not unique.** The draft made it unique and said a
re-pull of a stored order writes nothing. That is the right *behaviour*, but the
unique index was the wrong mechanism: QC-803 exists to catch an executed order
arriving a second time with different leg data, and a unique index turns that
finding into an insert failure indistinguishable from a parse fault — the
evidence lands in QC-001 with no way to see what differed. So the table is keyed
`(order_id, observed_at)` like every other supersession in this schema, an
`order_fingerprint` column makes an unchanged re-pull a genuine no-op at the
ingestion module, and a changed one appends a second observation that QC-803 can
read. Making this one table the exception would have been the odd case.

**The subset window reads days, not rows.** `advol20` takes the latest
observation *per trade date*. Bars are append-only, so a re-fetch leaves two rows
for one day, and "the last 20 rows" would silently be ten days of two readings
each — with a superseded value averaged into the admission decision. Found by a
test that asserted the ticker it had just pushed below the floor was in fact
below it, and was not: the assertion existed only because the first version of
the test had passed for the wrong reason.

**A second promotion rule.** A warning became blocking only on *how many*
evaluations fired, which cannot express QC-405 and QC-412 — both aggregate to a
single evaluation whose value already *is* the rate, so the fired fraction is
always 1 and carries no information. `promoteToBlockingAtValue` promotes on the
measured value instead. Both read "warning on any, blocking above N", and
neither rule can be written in terms of the other.

**The domain views stay inside AC-13.** Chains and Account need layouts the
generic table cannot give, and hard-coding `open_interest` and `delta` in the
renderer would have quietly retired AC-13's claim while everything still worked.
So the column list is chosen in the main process and every label, unit and null
meaning is read from the dictionary; the renderer receives columns it cannot
name. The structural scan still passes over the whole renderer.

**The AC-13 scan now strips JSX text.** It reported a `close` link in a panel
header as a reference to the bar close column — the fourth time in this project
a source scan has fired on its own prose, and the lesson a developer takes from
that one is "reword the button". Text nodes with no braces or tags are stripped,
and the stripper has fixtures both ways so it cannot over-reach into vacuity.

---

## The E*Trade verify list, closed (2026-09-07)

Dictionary 3 → 4. The operator re-authorised, and **one live SPY chain call, one
quote and one portfolio call settled every open E*Trade question in 02 §16** —
the list that had been blocking four pre-pilot items and showing as twelve
unverified columns on the Overview screen.

**Settled as drafted.** `theta` is per day (E*Trade -0.18651 against a
Black-Scholes -0.2285/day and -83.39/year — three orders of magnitude between
the candidates). `timeStamp` is epoch seconds. IV is a decimal fraction. The VIX
symbol is plain `VIX`, and all five drafted `All.*` names exist. `positionId` is
present and numeric. `brokerage.quantity` and `brokerage.price` are present, and
`brokerage.product` is an empty object on cash transactions — so the drafted
null meaning turned out to describe the observed behaviour rather than assume it.

**Two findings that were not on the list, which is the point of asking.**

`inTheMoney` is the **string** `"y"` / `"n"`, not a boolean. The dictionary
declares `in_the_money` a flag, so a cast was the obvious implementation — and
`Boolean("n")` is `true`, so **every contract would have read as in-the-money**.
Nothing throws, no check fires, and a moneyness filter silently selects the whole
chain. Now converted explicitly. `expiryType` has a fourth value, `MONTHEND`,
which is harmless *only because* the column is stored verbatim rather than mapped
into an enum of our own — the general argument for raw provider vocabularies,
made concrete on the first live call.

**QC-410's tolerance is 0.05, and the reasoning matters more than the number.**
E*Trade's delta sits 0.018–0.029 below a European Black-Scholes across twelve
strikes, monotonically in moneyness. Adding SPY's ~1.15 % dividend yield halves
the gap but does not close it, and the residual's shape says *model* rather than
error: SPY options are American and E*Trade does not publish its pricer. So the
tolerance sits far above a model difference and far below anything a unit or
scale fault could produce, since those are off by 100× or sign-flipped.
**QC-410 verifies that the Greeks are on the scale the dictionary claims — not
that they match our model.** Reproducing a vendor's American pricer to three
decimals is a different and much harder goal, and not what P4 asks for.

One verify marker remains, and it is a sourcing question rather than a field
shape: short interest still has no confirmed free provider.

---

## B5 — backfill_bars and the review queue (2026-09-06)

`core@0.1.0`, existing app v1.1.198. Gate: **every QC-205 finding resolved or
accepted**. 137 tests in `core`, 19 in the existing app.

**Five years in one pass per ticker, so the whole series shares an adjustment
basis.** That is the point of doing it as a job rather than letting history
accumulate: the existing app built its bars incrementally and re-fetched only a
three-day tail, so a split occurring later left pre-split bars sitting beside
post-split ones — 153 permanent steps across 126 tickers. Freshness of the tail
never implies consistency of the history.

**Splits are fetched before the bars.** A discontinuity found during the sweep
then has something to be explained *by*. Fetching them afterwards would open
exceptions the very next statement could close, and an exception raised and
immediately resolved still costs the operator a reading.

**The ticker-reuse ruling destroys nothing.** 03 §6 calls it "truncate before
splice", and 03 §303 already specifies the honest form: close the membership
range at the boundary and open a new one with a `predecessor_ticker` lineage —
the bars stay. A reader intersecting bars with membership then sees one entity
at a time. Demonstrated end to end: 50 bars before the ruling, 50 after, and the
two entities separate cleanly at 25 bars each. Deleting the earlier company's
history to fix an *interpretation* problem would be the wrong trade, and no
re-fetch could achieve the separation anyway — the provider keys by ticker too.

**A usability improvement found by making the mistake.** Running the flow by
hand, the splice date was given one day late, and the consequence was silent:
one bar of the new company stayed in the old entity's range and nothing
complained. The date was never in doubt — QC-204 keys its finding `TICKER
YYYY-MM-DD` at the exact boundary — so `recordTickerReuse` now takes the splice
date from that finding when none is given, and refuses when it has neither.

**Operator actions built four steps before their UI.** The Exceptions workbench
is B9, but B5's gate needs rulings now, so `acknowledge` / `resolve` / `accept` /
`expireAcceptances` / `recordTickerReuse` exist in `core` with tests, and
`packages/core/scripts/exception.mjs` drives them until the workbench arrives.
The workbench then wires buttons to behaviour already proven rather than being
the first place any of it runs.

Three refusals worth naming:

- **`resolve` is refused while the check is still firing** (unless the kind is
  `false_positive`, which is a claim about the *check* rather than the data).
  Resolving would mark the domain-day usable on the strength of an opinion, and
  the next run would reopen it — so the only lasting effect would be a
  misleading clean day in between. `accept` is the honest tool there, and it
  carries an expiry.
- **Every acceptance gets an expiry**, defaulting to 30 days. An acceptance
  without one is a decision nobody revisits.
- **Expiry moves an acceptance to `expired_review` without making the day
  unusable** (03 §5.2). The data has not changed; letting expiry flip the day
  back would mean an acceptance taken on pilot day 1 resets the streak around day
  21, every time, defeating the 20-day criterion with its own escape valve.

**A third table gained `mutableColumns`.** `qa_quality_report` is append-only,
but whether the email got out is learned a moment after the row is written. The
DDL generator now handles a named mutable set on any append-only table, not only
on validity-range ones: the row's *content* stays frozen while a column that
records something learned afterwards may be filled in. The alternative — making
the table mutable — would also have permitted rewriting the verdict.

---

## B4 — the quality gate, phases 2-4, and the first email (2026-09-06)

`core@0.1.0`, existing app v1.1.197, dictionary version 2 → 3. Gate: **the first
green/red email**. 118 tests in `core`, 18 in `next`, 1,228 in the root suite.

**The check API is the P10 mechanism, and that is the whole design of this
step.** A magnitude check does not decide whether it fired and report a boolean;
it returns *every value it measured*, and the framework computes the
distribution, the near-boundary count and the extreme keys from that. A check
therefore **cannot** record fires without also recording the distribution they
came from.

That matters because the existing app shipped a conviction gate whose tested
quantity could never approach its threshold — 0 of 39 eligible picks rejected
over 62 briefs, and nobody noticed, because a gate that never fires is
indistinguishable from a gate nothing violates. `qa_check_result
.distribution_json` is what makes them distinguishable. A real run of QC-204
produces:

```
n=1086  p50=1.4%  p90=2.7%  p99=3.0%  max=75%  threshold=40%  nearBoundary=0
```

which says in one line that the 40 % boundary sits in a genuine empty gap — the
claim the "measured" basis makes, now checkable on every run rather than taken
on trust. `extreme_keys_json` keeps the twenty largest values **whether or not
they fired**, because the rows nearest the boundary are the evidence a threshold
review needs and exactly the ones a fired-only record throws away.

**Four threshold bases, not two.** `measured` (from real data, evidence named
and asserted non-empty by a test), `working` (a placeholder for the pilot to
set), `not_applicable` (a predicate check — a row either has provenance or it
does not), and **`structural`**, added when the validation caught four checks
claiming `not_applicable` while measuring a magnitude. Their thresholds are zero
*by definition* — "any crossed quote at all is a finding" is not a number anyone
chose — and calling that `working` would have parked them in the pilot's
threshold-review queue forever.

**Exceptions are facts about the data, not about the run.** Same fingerprint
tomorrow is the same exception: it ages, escalates after three consecutive runs,
and reopens rather than duplicating on recurrence. An exception that **stops
firing without a remediation stays open** and is listed as "no longer observed,
unresolved" — because "it went away" is exactly how the earnings-date bug hid
for a quarter. The gate resolves only when a remediation succeeded *and* the
fingerprint evaluates clean.

**A check that throws is a finding, not a pass.** Swallowing it would make a
broken check indistinguishable from a clean one — the failure the gate exists to
prevent, one level up.

**Usability is derived and never stored on the run.** `qa_domain_day_status` is
recomputed from the exceptions that are actually open; `meta_run.gate_verdict`
records what the gate concluded when the run finished and is never rewritten. A
test asserts both: resolving an exception flips the day to `usable` while the
run still reads `red`. A stored `usable` column would be correct for one day and
drift thereafter — the same denormalisation trap that let a stale earnings date
suppress its own corrections.

**The email goes out after every run, including green ones** (03 §7). An email
only on failure makes silence ambiguous, and the failure this system most needs
to catch is a collector that stopped running. The watchdog sends the other half:
the email that reports the absence of an email, and writes `not_run` so a dead
scheduler shows as a declared gap rather than as an absence of rows.

**The registry needed a distinction the dictionary did not have.**
`qa_check_registry` is append-only, but 03 §4 says the gate *updates* its fire
statistics — so `mutableColumns` now names the counters a validity-range table
may accumulate. The check's **definition** stays frozen (a threshold change is a
new version, so a past result can still be read against the boundary actually in
force); its **instrumentation** moves. Everything not named still refuses an
edit.

**Added**: six `qa_` tables; the check registry with 15 checks across
cross-cutting, bars, quotes and corporate actions; the gate; the email; phases
2-4 with their ingestion modules. Checks for domains that do not exist yet are
deliberately **not** registered — one evaluating zero things every run would sit
in the zero-fire list looking exactly like a check that is silently broken.

---

## B3 — the collector host, the archive and the first real rows (2026-09-06)

`core@0.1.0`, existing app v1.1.196. Gate: **AC-1 and AC-2 on real rows**, both
asserted end to end against a real database and a real archive on disk rather
than against mocks. 95 tests in `core`, 15 new in the existing app, 1,226 in the
root suite.

**The seam.** `CollectorHost` is the only way anything environmental reaches the
collector, which is a library with no Electron, no scheduler and no network
client of its own. That is not decoration: this app's transports carry years of
hardening — rate limiting, renew-and-retry, masked-key logging — and
reimplementing any of it in `core` would mean maintaining two copies of lessons
that were expensive to learn once.

**The per-response contract has one path and no alternative** (04 §2.2), and the
ordering is the design:
- **Archive before parsing.** A crash in between leaves an orphan line, which
  QC-953 reconciles. Index-first would leave a row pointing at bytes that do not
  exist, and a dangling pointer is worse than an unreferenced fact.
- **Index and ingest in one transaction.** Either half alone breaks AC-1 in a way
  no check could distinguish from a genuinely empty response.
- **An ingestion failure still commits the index row**, `parse_status = failed`,
  zero data rows. Rolling back would discard the evidence needed to fix the
  parser; the body is on disk, so a replay recovers the rows without refetching.
- **Non-2xx responses and network faults are archived and indexed like any
  other.** They are evidence about the day.

**Archive records are length-prefixed, not newline-delimited.** Compressed and
encrypted bytes contain 0x0A freely, so splitting on newlines would corrupt
records at random — only the unlucky ones, never reproducibly the same ones.
There is a test whose fixture is asserted to actually contain newline bytes.

**The claim loop is a single conditional UPDATE.** Read-then-write leaves a
window where two hosts both see `queued` and both run the job, and the jobs this
queue carries include `reset`, which destroys a generation. The loser yields
rather than retrying. A request stuck at `queued` is **reported, not retried**:
it means the collector host is not running, which is the failure a queue
introduces (P9), and a silent retry would hide it better than a spinner would.

**The dictionary needed a distinction it did not have, and the tests found it.**
02 §0.2 says membership tables use `valid_from`/`valid_to` *instead of*
supersession — so closing `valid_to` is legitimate, and the append-only trigger
was correctly refusing it. Turning the guard off for those four tables would have
been the one-line fix and the wrong one. Instead `validRangeColumn` generates a
**narrower** pair of triggers: one refusing any UPDATE that touches a column
other than the range and its reason, one refusing to reopen a closed range, plus
the same DELETE refusal as every fact table. "This membership ended" and "what
this membership said" stay two different acts, or the range buys nothing over an
overwrite. Dictionary version 1 → 2.

**Refusals that are the feature.** `universe_seed` refuses to reconcile when it
fetched none of its lists — an empty incoming set would close every member, a
total wipe caused by a network blip. `encryptForArchive` refuses when
`safeStorage` is unavailable rather than writing account data in the clear; the
archive is permanent, so a file written unencrypted stays that way with no way to
tell later which files those were. The shared pointer is never invented: if it is
missing the new exe has not been run, and creating a path would make a second
empty generation indistinguishable from the real one having lost its data.

**Preflight stops on almost nothing** — only a non-trading day or a closed
generation. A failing E*Trade probe does not abort: the phases that need it fail
individually and the gate says which, which is a more useful answer than a run
that refused to start. An unknown calendar date proceeds, because refusing would
turn an unseeded reference table into silent data loss.

**Proven end to end, not just in tests.** `packages/core/scripts/queue-job.mjs`
(dev-only, 06 §9) found the generation through the shared pointer the new exe
wrote, queued a `universe_seed` request into `gen-001`, and the row was read back
and cancelled. That is the exact claim-and-execute path the Jobs UI will use at
B9 — exercised now by use rather than by a temporary direct call that would then
be deleted untested.

**Not done at B3, by design.** The daily run is phase 0 only: preflight and the
run record. Phases 1–10 arrive from B4. `collector-oneshot` implements
`universe_seed` and explicitly **fails** any other kind rather than leaving it
`claimed` — a request that vanishes into `claimed` and never moves looks
identical to a crashed host.

---

## Executable renamed — `TradeAnalyzer2.exe` (2026-09-06)

Operator decision. The exe filename loses its space; **the display name keeps
it**. `productName` stays "TradeAnalyzer 2" — window title, installer and
Programs list are unchanged — and electron-builder's `executableName` splits the
filename off from it.

A space in an executable name has to be quoted by every shortcut, script,
command line and `Get-Process -Name` that ever touches it, and the one that
forgets fails in a way that looks like the file is missing rather than like a
quoting mistake.

`check-not-running.mjs` matches the **process** name, which follows
`executableName` and not `productName`. If those two drift the guard silently
stops seeing the new app and lets a build run over a locked file — so a test now
reads the executable name out of `package.json` and asserts the guard watches for
exactly it. Verified live: the guard refuses while the renamed exe runs and
clears when it closes.

---

## B2 — the dictionary, the DDL generator, and the inspector (2026-09-06)

`core@0.1.0`, `next@0.1.0`. **45 tables, 684 columns, 75 indexes, 74 append-only
triggers.** `typecheck:all` green; 54 tests in `core`, 17 in `next`; the packaged
exe opens `gen-001`, applies the schema and renders every table. Gate: AC-3 and
AC-13, both asserted rather than demonstrated.

**The dictionary is code, and it is the only way a table exists.** There is no
migrations directory: the DDL generator reads `DICTIONARY` and nothing else, so
AC-3 and AC-13 hold by construction rather than by discipline. Within a
generation the schema may grow only by new tables, new nullable columns and new
indexes; `applyDictionary` **refuses** a NOT NULL addition rather than attempting
it, because anything else silently reinterprets rows already written and is by
definition a replay into a new generation (04 §7.5).

**Three things the drafting turned up that 02 did not have.**

1. `withStatus` returns the value column **and** its status column from one call,
   so a status column cannot be forgotten — the pattern is one call, not two
   entries kept in step by hand. 69 values are guarded that way, and the DDL
   emits a CHECK that the value is null *exactly when* its status is not `ok`.
   Without it the pair drifts into a null value with `ok` status (a silent gap)
   or a present value with `omitted` (a lie), and neither would ever raise.
2. Two units the spec had not distinguished, both found by the conformance test
   rather than by reading. `ratio` for a dimensionless value not bounded to 0..1
   — a 1-for-4 split, which must never render as a percentage. And
   `provider_defined` for a value whose unit varies per **row** and is named by a
   sibling column: `raw_edgar_fact` legitimately holds USD, shares, USD/shares
   and pure numbers in one column, and declaring one unit for all of them would
   be a lie the inspector then renders as a badge. A `provider_defined` column
   without a `unitColumn` is refused — a per-row unit recorded nowhere is a
   number nobody can interpret later.
3. `meta_dictionary` gained `unit_column` to carry (2) into the database.

**What is asserted, and why that is more than a screenshot.** AC-3 is checked
twice over: once against the dictionary, and once read back out of
`meta_dictionary`, because asserting the dictionary against itself proves only
internal consistency. The DDL round-trips through real SQLite and `PRAGMA
table_info` is compared to the declaration for every table — column set, order,
type and nullability. The append-only triggers, the enum CHECKs, the flag CHECKs
and the status-coherence CHECK are each shown to actually reject.

AC-13 is a **structural** test, not a picture. A screenshot shows that a table
renders; it cannot show that the *next* table will, which is the actual claim. So
`next/test/inspector.test.ts` asserts that **no table name and no domain column
name appears anywhere in the renderer**. The moment someone writes
`if (table === 'raw_option_contract_snapshot')` to fix one view, the claim is
false — and it would stay invisible for a long time, because the special case
would work. There is also a live proof in `core`: a throwaway dictionary entry
produces a real table and appears in the grouping with no code change anywhere.

**Added to `next`**: generation open with the shared data-root pointer (06 §3.1);
the typed IPC surface for `generation`, `dictionary` and `inspect`; the Overview,
the schema-driven **Data** view and the **Dictionary** view. Every column header,
unit badge, alignment, enum chip and null glyph comes from the dictionary.

**A null cell is never blank.** It carries a glyph and the reason on hover — the
four statuses look identical as an empty cell and call for four different
responses. That is AC-3 made visible, and it is why the Dictionary view puts
"what a null means" on screen without scrolling.

**Fixed while building, each worth its own note.**

- A CSS **grid blowout**: `.content` had no `min-width: 0`, so a wide table
  pushed the grid track past the window instead of scrolling inside it. Every
  level containing a scrollable table now sets it.
- The renderer showed `**bold**` and backticks literally. The descriptions are
  the same strings that go into `meta_dictionary` and are written to be read, so
  a tiny inline-markdown renderer was better than either leaving the markers on
  screen or stripping the emphasis out of the source.
- Long text values wrapped, turning a 100-row page into a wall. Cells are now one
  line with the full value on hover; the row-detail drawer (05 §3.2) is B9.
- The window opens **maximized**, matching the existing app (operator request).
  `maximize()` rather than `fullscreen: true` — fullscreen hides the title bar
  and taskbar, which is wrong for a tool meant to sit beside the other app.

**A guard fired on its own documentation, twice.** `core`'s purity rule matched
the word `safeStorage` inside a column *description*, and `next`'s AC-13 scan
matched `meta_dictionary` and `OFFSET` inside its own doc comment. Both now strip
comments and string contents before matching, with fixtures both ways. Left
alone, this trains people to work around the guard or to stop writing the
comments that explain it.

---

## Icon — TradeAnalyzer 2 (2026-09-06)

`next@0.1.0`. Operator choice from four candidates rendered at real icon sizes.

**Added** — `packages/next/build/icon.ico` (7 frames: 16, 24, 32, 48, 64, 128,
256), `icon.png` for dev, and `make-icon.py` that generates both. Wired via
`build.win.icon`; electron-builder no longer logs *default Electron icon is
used*, and the 32px frame extracted back out of the packaged exe is the mark.

**The mark** is a candlestick whose body is punched through with binary digits —
market data made of bits — in amber on near-black. Amber because the existing
app wears the default Electron icon, and the two must never be confused in a
taskbar.

**Each size is drawn, not scaled.** Three digits at 128 and above, two at 48–64,
none below — and the body and wick thicken as the icon shrinks, because the
proportions that read as a candlestick at 256px read as a plain stick at 16px.
Downsampling one 256px drawing to 16px turns the digits into grey noise, which
was visibly the failure of two of the four candidates and the reason the other
two were redrawn rather than merely rescaled.

**Asserted, not assumed.** An `.ico` holding a single large frame is legal,
builds silently and looks blurred at every size Windows actually uses — the
taskbar takes 16/24, alt-tab 32/48, the desktop 256. So `app-identity.test.ts`
parses the ICO directory and checks both the exact frame list **and** that all
seven payload offsets are distinct, which is what proves each size is its own
drawing rather than one image resampled seven times.

**The generator is committed alongside its output.** A binary asset with no
source is a dead end the first time anything about it needs to change.

---

## B1 — workspaces, empty packages, purity guard (2026-09-06)

`core@0.1.0`, `next@0.1.0`. First build step. `typecheck:all` green, `core` 22
tests and `next` 7 tests green, both packages lint clean, and
`release/win-unpacked/TradeAnalyzer 2.exe` packages (186 MB, `--dir`, no
installer) and launches — window titled *TradeAnalyzer 2*, `userData` created at
`%APPDATA%/trade-analyzer-next/` with the existing app's `trade-analyzer/`
untouched. The existing app packages too (v1.1.193) and is unchanged in
behaviour. **B1's gate is met.**

**Added**

- npm workspaces at the repo root (`packages/*`), with aggregate scripts
  `typecheck:all`, `test:all` and `lint:all`. The existing `npm test`,
  `npm run typecheck` and `npm run lint` keep their current meaning — root app
  only — so nothing about the existing workflow changes.
- `packages/core` (`@tradeanalyzer/core`): ESM, compiled by `tsc` to `dist/`,
  no runtime dependencies. Contains `SqliteLike` (06 §11) and the two version
  constants written into every run header — `COLLECTOR_VERSION` and
  `DICTIONARY_VERSION` (0 until the dictionary lands at B2).
- `packages/core/test/purity.test.ts`: the guard that keeps `core` Electron-free
  and native-free. Six rules — no `electron`, no value-level `better-sqlite3`
  (type-only permitted), no native module, no path alias, no Electron-shaped
  global, no `fetch` of its own.
- `packages/next` (`@tradeanalyzer/next`, productName **TradeAnalyzer 2**,
  appId `com.tradeanalyzer.next`): Electron shell — window, context-isolated
  preload, React renderer — plus `test/app-identity.test.ts` pinning the
  separation from the existing app.
- `scripts/check-not-running.mjs` now refuses a build while **either** exe is
  running, from either app's build (06 §4).

**Decisions taken during the build, and why**

- **The purity test carries negative controls.** Every rule has `fires` and
  `clean` fixtures, both asserted, and the tree scan was verified to fail
  against a deliberately violating file before that file was removed. 06 §7
  only asked for the rules. The controls are there because this project has
  already shipped a gate that was structurally incapable of firing and looked
  healthy for 62 brief days (CLAUDE.md, own-at-strike); a source scan whose
  regexes silently match nothing fails in exactly that way, and passes just as
  greenly. There is also an explicit assertion that the source tree is non-empty
  — a scan over zero files is the other way to be vacuously green.
- **`core` is bundled into `out/main`, not externalized.** `externalizeDepsPlugin`
  is given `exclude: ['@tradeanalyzer/core']`, so the packaged exe has no
  workspace symlink to resolve at runtime. Verified: the built main bundle
  imports only `electron` and `node:path`.
- **`next`'s `prebuild`/`prepackage`/`predev`/`typecheck:node` build `core` first**,
  so the package is never typechecked or bundled against a stale `dist/`.
- **`COLLECTOR_VERSION` is asserted equal to `package.json`'s `version`.** It is
  written to `meta_run.collector_version`, so drift between the two would
  mislabel every run of a generation — silently, and only visibly much later.

- **Packaging needed a pin 06 had not anticipated.** With `electron` hoisted to
  the workspace root, electron-builder cannot compute a version from
  `packages/next` and refuses outright: *Cannot compute electron version from
  installed node modules*. Fixed by declaring `electron` in `next` at the
  **identical range string** as root (so npm still keeps one copy) **and**
  setting `build.electronVersion` explicitly. Those are two values that can now
  drift apart, and neither drifts loudly — a mismatched range installs a second
  Electron rebuilt for the wrong runtime silently, and a stale `electronVersion`
  packages a runtime the native modules were not built against. So the identity
  test asserts both, comparing `electronVersion` against the version actually
  **installed** rather than against another declaration: the installed copy is
  what `rebuild-better-sqlite3.mjs` targets. Verified to fail when the value is
  moved off by a version.

**Deviations from 06 as written, recorded rather than silently taken**

- 06 §4 says the root ESLint config becomes `eslint.config.mjs`. It stays
  `eslint.config.js`: the root `package.json` already declares `"type": "module"`,
  so that file is ESM today, and renaming it would touch the existing app for no
  behavioural gain. Both packages extend it from their own `eslint.config.js`,
  which is what §4 actually asks for. Each package adds only its own build-output
  ignores and turns `no-undef` off for TypeScript sources (TypeScript resolves
  identifiers itself; leaving it on reports every ambient type as undefined).
  The root ignore list gained `packages/*/{out,dist,release}` — flat-config
  ignores are relative to the config file, so the root run needed them spelled out.
- 06 §2 describes an `exports` map with a sub-path per `core` directory. At B1
  the map has `.` and `./db` only. Sub-paths are added as the directories land,
  rather than declaring entry points to files that do not exist.

**Not done at B1, by design**

`core`'s `dictionary/`, `collector/`, `ingest/`, `qa/`, `providers/`, `units/`,
`calendar/` and `legacy/` directories do not exist yet — they arrive with the
build steps that need them (06 §9). Nothing was created empty to look complete.
