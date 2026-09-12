# NewApp changelog

The new application's living changelog (06 §8). The existing app keeps its own
`CHANGELOG.md` and `changelogs/` at the repo root; nothing here applies to it.

Versions: `@tradeanalyzer/core` and `@tradeanalyzer/next` are versioned
independently of the existing app's `1.1.x`, and both stay on `0.x` until pilot
exit (06 §6).

---

## B10b — bar volume was zero, and the check that reads it had never run (2026-09-12)

`core` **0.6.6**, `next` **0.4.5**, dictionary **v15**; existing app **v1.1.236**.
**Needs a reset** — gen-001 keeps its zeros and its INTEGER column.

Found by reading three numbers off the Runs view before Monday: QC-205 reported
**Evaluated 0** on all three backfills, QC-204 fired **152 → 151** although the
split list grew from 1,000 to 6,700, and a pasted AAPL bar read `volume 0` beside
`transactions 1,225,501`.

- **Volume.** Polygon's daily `v` is fractional — it counts fractional-share
  trades. Dictionary v14 declared it INTEGER with a converter that "asserted
  integrality"; the parser computed `invalid` and then wrote `volume.value ?? 0`.
  So most bars stored a plausible zero with nothing marking it. Now REAL, in a new
  `share_quantity` unit (not `shares` — that is a Form 4 column, and AC-13 caught
  the unit key as one), nullable (absent → null, never 0), stored as sent;
  `raw_eod_quote.day_volume` likewise.
- **The chain subset admitted nobody because of it.** `advol20` is the mean of
  `close × volume`; with volume 0 every ticker measured $0/day. This had been put
  down to too few bars and the empty brief hand-off — both real, neither the main
  cause.
- **QC-205 measured the wrong thing even with good data.** It compared the last 20
  rows of a ticker with the 20 before — stacked backfills made that ~13 days, and a
  reuse anywhere but the tail could not be seen. Rewritten to 03 §3.3's
  definition: 20 sessions of volume either side of each step larger than QC-204's
  threshold, latest observation per day by `MAX(row_id)`, every measured step
  recorded (fired or not), a step with a short window not yet measured. Keys are now
  `TICKER DATE`, which the workbench's reuse candidate already parses.
- **Why splits barely moved QC-204.** A single-pass adjusted backfill has no split
  steps to explain. The 151 are genuine moves, reuse or bad bars (max ratio
  487,399), which is exactly the population QC-205 exists to sort — and could not.
- **One-shot jobs are dated to their session.** Run 9 started 01:35 Saturday and
  recorded trading date 2026-09-12. `sessionOnOrBefore()` (rules only, no
  database) now dates it 2026-09-11.
- **A refused Data-view query no longer draws "no rows".** The operator's
  `volume = 0` filter was refused for lacking an indexed column, and the empty grid
  beneath the refusal read as a clean answer.
- The backfill note's finding count is labelled generation-wide (it read 512 on a
  run whose QC-204 fired 151); a pilot-exit comment claiming QC-204/205 are warnings
  is corrected against their `blocking` definitions.
- **`next` did not typecheck.** `PilotConditionDto.key` lacked `backfill_queue`,
  the ninth pilot-exit condition added in core 0.6.4, so the Pilot view also had no
  label for it. Vitest transpiles per file, so the test run stayed green.

Not changed, noted for the pilot: the host stamps `requestedAt`/`respondedAt` —
and therefore `observed_at` on raw rows — with `toISOString()` (UTC), not
`etTimestamp()`. Consistent within a table, so supersession by `observed_at`
still orders correctly; QC-205 uses `row_id` regardless.

---

## B10b — the EDGAR contact address, decided (2026-09-11)

Existing app **v1.1.227**; `core` unchanged. The collector's EDGAR calls
(filings, company facts, the daily index and Form 4s) now carry a declared
contact address, built by the host from an operator setting.

`core` continues to send **no** user agent — 04 §11's rule, and the reason it
exists is visible in this change: the library does not know who is running it,
and an address compiled into a shared library is an address in a repository's
history forever. The host supplies it, and the same module supplies it to the
existing app's own EDGAR provider, which had been sending `trader@local` — an
address nobody can be reached at, which looks like compliance and delivers none.

**What the SEC actually asks**, checked rather than assumed: declare a user
agent with a contact; enforcement is on **rate** (10/s, brief limiting, resume
after 10 minutes below the threshold), plus a clause against unclassified bots.
Our EDGAR volume is roughly 30 calls a day. So the contact is a courtesy and
protection against being classified as an anonymous crawler — not a gate, and
nothing was ever blocked. The `edgar-form-index` failure on the 2026-09-10 run
was the day's index not having posted yet; that URL serves correctly.

Unset degrades to a name-only agent rather than emitting `TradeAnalyzer/x.y.z ()`,
which would read as a bug at the receiving end.

## B10b — short interest was never actually tested (2026-09-11)

`core` 0.6.2, existing app **v1.1.226**. The domain recorded as *"the one §12
domain with no confirmed free source"* had been asked for at
`/stocks/vX/short-interest` — the documentation's placeholder, unreplaced.
Polygon answers that with an 18-byte `404 page not found`, and the failure was
read as a plan gap. It then propagated: into 02 §12 as settled fact (**naming
the wrong path in the same sentence**), into the dictionary as a verify note,
and into the pilot checklist as the last blocker on promotion. The endpoint is
`/stocks/v1/short-interest`, documented as included in every Polygon Stocks
plan, with fields matching `raw_short_interest` exactly — parser, dictionary and
capture rule all unchanged.

**The shape worth keeping: a wrong URL and an unentitled URL return the same
status.** A 404 is evidence about a *path* before it is evidence about a *plan*,
and the cheap check — read the path — was never done, because a plausible
explanation was already available (Finnhub's genuine 403 the same week). Every
downstream signal agreed with the wrong conclusion: a non-2xx in `meta_response`,
a `failed` phase, QC-904 reporting `9999` days since settlement. None of them
could distinguish the two causes, and the spec recorded the conclusion rather
than the observation.

**The verify note stays** until a live 200 returns rows. A document is not a
response, and mistaking one for the other is precisely the error being
corrected. `packages/core/test/provider-paths.test.ts` now fails any collector
path carrying an unreplaced `vX` / `vN` / `v{…}`, with a fixture proving the scan
is not vacuous.

## `next` 0.4.4 — rebuilt on `core` 0.6.4 (2026-09-11)

Provenance bump. No dictionary change this time — v14 stands; the inspector picks
up the seeded `ref_macro_series`, the insider index fallback and the ninth
pilot-exit condition (`backfill_queue`), which the Pilot exit view renders from
`pilotExitStatus` without needing to know about it.

## `next` 0.4.3 — rebuilt on `core` 0.6.3, dictionary v14 (2026-09-11)

Provenance bump, as below. This one carries a **dictionary change**: whichever
application opens the generation first applies v14 — `legacy_brief_candidate`
rebuilt with the corrected `mode` enum (it is empty, so a clean rebuild) and
`meta_response.parse_error` added as a nullable column.

## `next` 0.4.2 — rebuilt on `core` 0.6.2 (2026-09-11)

Same provenance-only bump as 0.4.1 below, for `core` 0.6.2.

## `next` 0.4.1 — rebuilt on `core` 0.6.1 (2026-09-11)

No change in `next` itself. The version moves because the build bundles a
different `core`: two binaries stamped 0.4.0 carrying 0.6.0 and 0.6.1 would be
indistinguishable from the outside, and "which build am I running" is exactly
the question a version stamp exists to answer. The inspector does not run the
gate — the checks fixed in 0.6.1 execute in the collector host — so this is a
provenance bump, not a behaviour change.

**Also fixed here (no rebuild needed):** `packages/next` required
`@tradeanalyzer/core` at `"0.1.0"` while core was 0.6.1. npm links a workspace
package by name, so every build was correct and the stale range sat there for
six minor versions — but `npm ls` exited non-zero with
`invalid: "0.1.0" from packages/next`, and core is private and unpublished, so
any resolution that took the range literally would look for a registry package
that does not exist. The range is now `*` (always satisfied by whatever the
workspace links; a pin would recreate the trap on the next core bump), and
`package-lock.json` — which still recorded both packages at 0.1.0, the version a
`npm ci` machine would be told it has — is refreshed.
`packages/next/test/workspace-versions.test.ts` pins both. The packaged 0.4.1
exe is unaffected: the bundle comes from the workspace link either way.

## B10b — three more paths that had never worked once (2026-09-11)

`core` 0.6.4, existing app **v1.1.233**. Found by asking, before Monday rather
than after it: *which phases have never produced a row, and would we notice?*
Run 6's own domain table named the suspects — `events_indexQuotes`
**expected 0, stored 0**, `events_insider` 0.

**`ref_macro_series` had no seeder.** The only `INSERT` in the repository was a
test fixture, so `runIndexQuotes` skipped every run since B7a and
`raw_index_quote` held **0 rows**. The sharper half: **QC-901 is blocking** and
maps over the enabled series, so on an empty table it evaluated nothing — a
blocking check that could not fire, guarding a VIX never fetched. Seeded in
preflight beside `ensureTradingCalendar`, for the identical reason that one is.

**The insider sweep asked for a file that does not exist yet.** It fetches
EDGAR's daily form index *for the trading date*; EDGAR publishes it late that
evening, and the collector runs hours earlier. Both the 9/10 and 9/11 runs got
404 on a URL that serves correctly later the same night, so a same-day fetch was
structurally incapable of storing a Form 4 — and `events_insider` at 0 looks
exactly like a day nobody filed one. Now falls back to the previous trading
day's index and records **which date it actually used**.

**`backfillQueueClear` claimed to be "a precondition on the pilot's clean-day
streak" and was referenced by nothing.** A generation could have been promoted
with an unruled ticker-reuse candidate outstanding — the precise outcome its own
comment forbids. Now the ninth pilot-exit condition, with its real (narrower)
scope stated rather than quietly widened.

**The rule behind all three**, now enforced by
`preconditions-are-wired.test.ts`: an exported function whose docstring calls
itself a *precondition on* something must be referenced outside its own file.
Four times in one evening prose asserted a mechanism that did not exist —
`void dte;` after a return, a comment claiming the host signed a request it never
signed, a blocking check reading a table nobody wrote, and this one. Prose is
what gets read when somebody asks "is this handled?"

**Still to run, and not automatable from an agent shell** (queueing writes a
`meta_job_request` row into the generation): `backfill_bars` has never run, which
is why bars sit at ~3 per ticker and the chain subset admits nobody; and no
`replay` has ever been queued, though QC-956 starts warning around 9/21.

## B10b — every brief hand-off had failed since the contract shipped (2026-09-11)

`core` 0.6.3, dictionary **v14**, existing app **v1.1.232**.

Three hand-offs exist — 9/10 evening, 9/11 morning, 9/11 evening — and every one
wrote **zero rows**. `legacy_brief_candidate`: 0 rows, since B8.

**One vocabulary, two spellings.** `legacy_brief_candidate.mode` holds the
existing app's *scoring strategy*. The dictionary declared
`['wheel', 'buy', 'options', 'bullish', 'bearish']` — taken from CLAUDE.md's
prose about the **analysis** engine, and matching neither real list: the analysis
engine's value is `options_income`, the brief's is `income`, and `'options'` was
an orphan nothing could ever write. The brief scores all six strategies every
run, so every payload carried `income`, every insert violated the CHECK inside
the write transaction, and the capture recorded `parse_status = 'failed'` with
zero rows. Deterministic from the first hand-off.

**Four things had to line up for it to stay invisible**, and each is now closed:

1. A hand-off runs as a **manual** run, and manual runs are not gate-evaluated →
   **QC-010** (warning) checks that a hand-off which arrived was ingested.
2. The parse error was computed and **discarded** → **`meta_response.parse_error`**.
3. The caller logged `0 rows` as though it were a result → it **warns** now.
4. The pins still landed — `pinSticky` reads `c.legs` and never touches `mode` —
   so 141 pinned contracts sat beside an empty table, which reads like success.

**Why no test caught it:** every fixture used `mode: 'wheel'`, inside the four
values the two lists happened to share. **A fixture drawn from the overlap of two
vocabularies cannot test that they agree.** And an `as` cast at the hand-off site
silenced the compiler. Both are gone; the new test reads `STRATEGIES` from the
existing app's own source rather than restating it, because a restatement would
agree with a copy.

**The knock-on, previously misattributed:** `recommended_by_legacy` admissions
read `legacy_brief_candidate`, so that whole admission path was dead. The chain
subset sitting at one ticker was blamed entirely on the 20-bar dollar-volume
rule; that was half of it.

**Cost to fix: none.** The table is empty, so the enum change is a clean rebuild
on next open — no new generation, and the pilot clock is untouched. The three
archived payloads replay back in after Monday's run.

## B10b, day 0 — the collector's Finnhub calls carried no key (2026-09-11)

Existing app **v1.1.223**; `core` unchanged. Every Finnhub call on gen-001's
first full run came back non-2xx, so earnings and recommendations stored
nothing. `core` builds the URLs without a key — correctly, since credentials
are the host's job — and the host's generic `httpGet` added none, because the
host was never given a Finnhub key: its options had `getPolygonApiKey` and no
equivalent. The host now receives it and sends it as the `X-Finnhub-Token`
header (never a query parameter, so it cannot reach a URL, a log or the
archive), and refuses the call outright when none is configured.

The reason it survived to the pilot is the reason worth keeping: `httpGet` was
the one transport that wrote nothing to `logs/api/`, so the failure had no
witness but the archive. It logs now. **A transport that is not instrumented is
a provider that fails silently, however well the others are covered** — the
existing app learned that for E*Trade twice.

**Paced as of v1.1.224**: Finnhub calls go through ONE limiter (55/min, burst 5)
shared with the host app's `EarningsRefreshJob`, because Finnhub limits per key
and two buckets would be two budgets spending one allowance — the same reason
the collector shares this app's Polygon limiter. It matters from early October,
when the chain subset fills and the weekly recommendations sweep becomes a few
hundred calls instead of one.

## B10b, day 0 — four checks that could never pass (2026-09-11)

`core` 0.6.1; existing app **v1.1.222**. The first read of the streak after B10a
said **0 of 20**, and the reason was not the data. gen-001's first full daily
run (2026-09-10) was red on three blocking checks, each of which would have
fired on every run for as long as the pilot lasted:

- **QC-001** read `derived_iv30_daily`. A derived row is a function of many
  stored rows, so the dictionary makes its `source_response_id` null by
  definition — and the check called that an orphan. The check contradicted the
  dictionary it reads. It now reads only the parsed layers.
- **QC-008** flagged every EDGAR filer with 1,000+ filings (16 of 20). The cap
  was deliberately reported "even though harmless" — but reported as *blocking
  with no possible remediation*, which is not a report, it is a permanent red.
  The flag now means what QC-008 needs it to mean: truncated *for the window
  being stored*, measured from the oldest filing the response kept.
- **QC-409** could not pass for any pin outside the chain subset, because
  phase 7 only walked members — while the reason pins exist is that a contract
  must keep being priced after its ticker leaves the subset. 141 pins, with the
  subset at one ticker (the 20-day dollar-volume rule has three bars to work
  with). Pinned tickers are now always fetched, a non-member at its pinned
  expirations only, and the expirations not fetched are stored as `outside` so
  QC-402 does not read them as captured-and-empty.
- **QC-207** (warning) counted every day of its window without a bar, so a
  three-day-old series read as 17 missing days on all 1,083 tickers; its own
  description already said "on both sides".

**The transferable shape:** a check's first real run is itself a test of the
check. Four of the nine that fired did so for a reason visible from the check's
source alone, and none of them was catchable earlier because every fixture had
been built to exercise the case the check was *for*. When a check fires on
100 % of its population on day one, read the check before the data.

Still open and not addressed here (warnings): Finnhub non-2xx on every call,
Polygon short interest non-2xx (the pending source decision), and a chain
subset that stays near-empty until 20 bars exist.

## B10a — pilot-exit machinery (2026-09-11)

`core` 0.6.0, `next` 0.4.0, dictionary **v13**. The existing app moves to
**v1.1.221** with it, because the gate runs there: the two new checks and the
streak fix only exist once the collector host bundles this `core`.

B10 was split the same way B9 was: **B10a** is everything the pilot ends with,
built now so it is proven before it is needed; **B10b** is the pilot itself —
twenty clean trading days, a replay a week, and the reviews done by a person.

### The clean-day streak counted across a day nothing recorded

`cleanDayStreak` walked `DISTINCT trading_date` from `qa_domain_day_status`. A
session on which the host app never ran — no 17:05 run, and so no 19:30
watchdog either, the one day nothing can write `not_run` — had no rows, so it
was not in the walk, and the streak counted straight across it. The status
email's streak had the same blind spot. It now walks `ref_trading_day` (falling
back to the rule generator for any date the table lacks) and a trading day with
no rows breaks the streak. A test pins both halves: a gap breaks it; a weekend
and Labor Day do not.

### Rulings, inspections, promotion

- **`qa_check_ruling`** (append-only): keep / fix / drop for a check that never
  fired, confirm / move / unmeasurable for a working threshold. 03 §8 put these
  on the registry row, but that row's definition is frozen, so a ruling is its
  own row keyed to the version it judged, with a required note and the evidence
  shown at the time. Refused when it does not fit: a zero-fire ruling on a check
  that has fired, a threshold ruling on one that is not `working`, a `move`
  without a value.
- **Pooled distributions are bounds, not estimates.** Runs store summaries, so a
  pooled p99 cannot be computed — but it must lie between the smallest and
  largest per-run p99, and that is exact. The two QC-955 shapes (decorative,
  bulk-against) therefore answer `yes`, `no` or `maybe`, and an approximation is
  never presented as a finding.
- **`meta_domain_inspection`** (append-only): one row per look, per gate domain.
- **`promoteToProduction`** recomputes the checklist and refuses, naming every
  unmet condition, behind a typed `promote gen-NNN`. The checklist is stored on
  `meta_generation.pilot_exit_evidence_json`, so the promotion carries its
  evidence.

### Replay, as the gate can actually see it

QC-951 was drafted as "the gate replays a sampled day weekly"; the gate cannot
run one (replay is a manual one-shot in the host app). So it reads the replays
the operator ran: the **latest** verdict per replayed day, `different` blocking.
Latest, so a re-replay after a fix stops it firing and the exception can be
resolved. **QC-956** (new, warning) fires after 7 sessions with no passing
replay, and promotion requires it clear.

### One promotion blocker is already known

The dictionary has always said a generation cannot be promoted while any column
carries a verify note, and one does: `raw_short_interest.short_interest` — no
confirmed free source (02 §12). The checklist shows it; it needs a decision
(confirm Polygon's coverage, use FINRA, or drop the domain) before day 20.

### The view

A new **Pilot exit** section (05 §6 as built): the checklist, the inspections,
the never-fired list and the threshold review, each with its rulings; Overview
shows the streak. An IPC test now pins that every write-verb channel is
registered through `handleWrite`, so a read-only window refuses it.

`463` tests in `core`, `56` in `next`.

---

## B9c — filters and saved questions, study pins, and closed generations read-only (2026-09-10)

`core` 0.5.0, `next` 0.3.0, dictionary **v12**. The existing app is unchanged
(it keeps `core` 0.4.0, and a v12 generation holds nothing it cannot read).

### Replay into a new generation — deferred, and why

On reading what it needs, it turned out much larger than its one-line entry.
Only **parser output** is replayable; a generation also holds everything
*computed* along the way — universe membership reconciliation, the chain subset
per day, the sticky set, every run's gate and exceptions, the legacy imports —
and a new generation built from a replay would need all of it re-executed in
historical order. And gen-001 predates recipes, so a replay of it today would
produce an almost empty generation. Scratch replay already carries AC-4 and
reset already carries "start clean", so it waits until a generation captured
entirely under recipes needs a parser fix carried forward (04 §7.5).

### Filters, and saved questions on top of them

The Data view only sorted. It now filters by column, with the operators each
column's type allows — **decided in `core`**, so the form offers only what the
query will run, and a saved question is validated by the same code that runs
it. Plus the latest version of each fact (as of a date), keyset paging that
survives NULLs in the sort column, a column chooser, and a capped "matching"
count.

- **05 §8's index rule, as built.** Drafted as "every filter maps to an index",
  it is now: on a table above 200,000 rows, a filtered or latest-version query
  needs **at least one** filter an index can start from, and the refusal names
  those columns. Below that, anything goes — a small scan is cheaper than the
  refusal. A `contains` on an indexed column does not count, because it cannot
  use the index. The row estimate is `MAX(row_id)`, O(log n), where `COUNT(*)`
  would have scanned the very table the rule protects.
- **Latest version** puts filters on the natural-key columns *inside* the
  window (exact, and index-usable) and the rest outside, so a value filter tests
  the latest value instead of picking "the latest version that happened to
  match".
- **Saved questions** live in the generation (`meta_saved_question`,
  append-only with `retired_at` as its only edit). Saving under a name in use
  retires the old definition, so what a name meant last week stays readable.

### Pin for study — provenance recorded, not waived

`ref_sticky_contract` carries the standard columns, so every row names a run
and a response, and a manual pin has neither. Making them nullable for this one
reason would have been a constraint change a populated generation cannot take,
and would have written "no provenance" into a table where every other row has
it. So the **operator's request is archived** as a `host_app` response under an
operator run, and the pin points at it — the legacy import's resolution again
(the rows it read ARE the source). The note is required and lives in the
archived request. It is TA2's only write to the archive, to a file the collector
host never appends to. No recipe, so a replay counts it as having no parser,
which is true.

### Closed generations open read-only, in their own window

Overview lists every generation on disk, each read from its own
`meta_generation` row; a closed one opens in a window with its own frame colour,
title and banner. Every IPC call runs in **its window's generation**, so the same
main-process code answers for whichever file that window shows. Write channels
refuse there, with SQLite's own read-only refusal behind them. The file keeps
the schema it was built with — a read-only connection cannot run
`applyDictionary`, and the file is evidence of what it was — so a table added
since reads as absent rather than failing.

`readonly: true` is safe here in a way it is not for the live generation: the
CLAUDE.md warning is that a readonly connection cannot attach a *live*
write-ahead log on Windows, and a generation nobody writes has none.

AC-13 caught one more: the pin DTO's `reason` is a dictionary column
(`ref_sticky_contract.reason`), so the field is `pinnedFor`. Seven renames
across the build, zero exemptions.

`442` tests in `core` (+22), `54` in `next` (+6).

---

## B9b — replay, and the recipe that makes it a re-run rather than a reconstruction (2026-09-10)

`core` 0.4.0, `next` 0.2.1, dictionary **v11**, existing app v1.1.219. **AC-4 is met**:
a real captured day — bars, two chain expirations, an encrypted account
response, the IV derivation — replays through the real one-shot job into a
scratch file and comes back equal, table by table.

### Recipes, recorded at capture

B9a found the archive held every response's bytes but not the arguments its
parser was built with. They are recorded now, as **recipes**: which module,
built with which arguments. Three design points, each forced by something the
code actually does:

- **What is recorded is what ran.** `captureResponse` no longer takes a parser
  function. It takes a recipe and builds the parser from it through
  `buildIngest`, so there is no path where a caller runs one thing and
  describes another. ~25 call sites moved, mechanically, by a script.
- **Content-addressed.** The Form 4 parser carries the whole ~1,089-entry CIK
  map and every earnings slice the universe list. One row per distinct recipe
  in `meta_ingest_recipe`, pointed at from `meta_response`, stores an
  unchanged map once instead of hundreds of times a day.
- **The account key never lands anywhere.** The open question from B9a
  answered itself on reading the parsers: all four only ever *hashed* the key.
  The recipe carries the digest the rows already store.

`meta_response` also gains **`capture_rule_id`**. It had only ever been on the
rows a response produced, so a response that produced none could not say which
rule asked for it — and a replay could not rebuild the rows it did produce
without guessing. Both columns are last and carry no `REFERENCES` clause:
`applyDictionary` adds columns with a bare `ALTER`, and a declared FK would have
left `meta_response` reported as drifted on every open. A test builds a
populated v10 table and asserts the upgrade is plain growth.

### Replay

Runs in the **old app**, because account archive lines are encrypted with its
safeStorage key. Reads the index and the bytes, verifies each digest, and runs
the same `indexAndIngest` capture uses — split out of `captureResponse` for
exactly this, so "replay reproduces ingestion" is a claim about the function and
not about a copy of it.

**The comparison basis** is per replayed response, over every column except the
primary key and the reference columns. `observed_at` is compared on raw rows
(it comes from the archive) and **excluded on derived rows** — I first planned
to make the derivation's `observed_at` deterministic, and a test pinned the
reason not to: re-deriving a day must append a *later* version, or a derivation
fix could not supersede the old row. There it is the derivation's clock.

**Coverage is reported and zero is not a pass.** `nothing_replayable` is its own
verdict and `equal_on_replayed` says "equal, but something could not be
replayed" — the zero-overlap trap again, designed out rather than remembered.
Rows written by non-parser code (universe reconciliation, legacy import, sticky
pins) fall outside the comparison because their responses carry no recipe; the
legacy import's `ingest: () => []` was removed so it would not claim to be a
parse that writes nothing.

**Every run captured before v11 — gen-001's entire history — is
`nothing_replayable`.** That is the honest answer, not a gap: the first
replayable run is the first daily run after the old app picks up `core` 0.4.0.

### The diff viewer

The replay card is queueable (run id optional, validated before the row is
written). Its report renders coverage first, then per table stored / replayed /
matched / added / removed / changed, with sample rows drawn from whatever
columns they carry — the renderer names none, so AC-13 holds.

### Deferred to B9c

Replay **into a new generation** (a create-fill-switch handshake across the two
apps: the new exe owns creation, the old app holds the decryption key), pin-for-
study, saved questions, and closed generations in a read-only window. None is
needed for AC-4. QC-951, the weekly sampled replay, belongs to B10.

`420` tests in `core` (+23), `48` in `next`, `1,261` in the existing app.

---

## B9a — the operator surface, and three drafted claims that did not survive the build (2026-09-10)

`core` 0.3.9, `next` 0.2.0. The existing app is unchanged. **B9 is split**: B9a
(this) is the Exceptions workbench, the Runs view, the Jobs view, reset and the
deep links — gate AC-14, met. B9b is replay (AC-4), which turned out to need a
change to capture before it can be built at all.

### Replay could not have worked as 04 §7.5 describes it

The section iterates "`MANIFEST.json` + per-file line order". **Nothing writes a
MANIFEST** — the index is `meta_response` and nothing else.

The larger gap: an archive line holds a response's bytes and params, but **not
the arguments its ingest module was built with**. The expiration parser needs the
rule's selection, the chain parser the sticky set, the order and transaction
parsers the fingerprints and ids already stored — which is database state — the
earnings parser its ticker filter, and the account parsers the raw account key,
which the archive deliberately holds only masked. Replaying today's archive
would mean reconstructing all of that, and **a reconstructed replay that reports
"equal" is a check that cannot fail on the case it exists for** — the conviction
band again, one level up. Decided: B9b records the arguments at capture
(`meta_response.ingest_args_json`, nullable, additive) and replays only responses
that carry them; older ones are reported as not replayable, never guessed. The
account key needs its own answer and is recorded as open.

### Reset executes in the new exe, not the old app

04 §7.6 had the old app execute reset. It was the older of two rules that
disagree: since 2026-09-07 **generation creation belongs to the new exe alone**,
and `ElectronCollectorHost` refuses to create a database because the one time it
did, it manufactured a generation with no `meta_generation` row. Reset also calls
no provider, which was Q4's only reason to route jobs through the old app.

`performReset` in `core` owns the order and the refusals; the app supplies two
callbacks (open the successor, move the pointer). **The pointer is the commit
point**: the successor is complete — schema, predecessor, reason, the two
follow-up jobs queued — before anything points at it, and the old generation is
closed only after. A crash before the pointer moves changes nothing either app
can see; a crash after it leaves the old one reading `pilot` while nothing writes
to it. Closing first would have left the reverse — a `closed` generation still
being written. Tested both ways, plus the successor-without-a-row case.

A run marked `running` blocks a reset **only within six hours** of starting. A
host that dies mid-run leaves its row `running` forever, and the operator cannot
edit `meta_run`, so a literal reading would let one crash veto every reset after
it. Older rows are listed as presumed dead — visible, not a veto.

### The Jobs view says what the spec's spinner would have hidden

05 §7 assumes the old app claims a queued request within ~2 minutes. That loop
was removed in v1.1.206, so **nothing claims a request on its own**; it waits for
the operator to run *Collector one-shot jobs* in the old app's Batch view. The
view says so in a banner, on the confirmation and on every waiting row. A second
request for a kind that already has one pending is refused (a double click would
otherwise queue two backfills), and cancel is the same conditional UPDATE as the
claim, so the two cannot both win.

### The workbench

Every button is one call to the `core` function `scripts/exception.mjs` has used
since B5, so the refusals — resolving while still firing, a missing note — are
`core`'s and the workbench shows them as the answer. Two fixes in `core` came out
of wiring it:

- **The 180-day ceiling on an acceptance was specified for the form only** (05
  §5). A limit enforced by the form is enforced only for callers who use the
  form — the conviction bands' AI-review path is the precedent — so it is in
  `accept()` now, along with a refusal of any expiry that is today or earlier.
- **An acceptance taken in the evening ran a day longer.** The default expiry
  added 30 days to the instant and serialised it with `toISOString()`, so after
  20:00 ET it landed on the next UTC date. Regression test at 21:30 ET.

Bulk acknowledge exists; bulk resolve and bulk accept deliberately do not, and a
test asserts their absence. The zero-fire list is read-only until B10, where the
keep/fix/drop ruling belongs.

The operator actions now take an `OperatorHost` — a clock and a name — rather
than a full `CollectorHost`, so the workbench does not fake provider transports
to acknowledge an exception.

### Deep links

The status email's `tradeanalyzer-next://exceptions?run=…` link has been
unhandled since B4. It now works: single-instance lock, `second-instance`
delivery, a pending route for a link that launched the app. The scheme is
registered **from the packaged exe only** — registering from dev would overwrite
the packaged registration and send every emailed link to a dev server. The
route type has no way to express an action, and a test pins the grammar to the
link `core` actually writes.

### AC-13, once more

`verdict` is a dictionary column, and the new DTOs used it in three views. It is
now `gate` (the run's green/amber/red) and `usability` (a domain-day). Six
renames across the build, zero exemptions.

### Deferred, and to where

Pin-for-study (05 §4.2), saved questions (05 §11.2) and closed generations in a
read-only second window (05 §8) move to B9b. AC-14's "previous generation
readable" is asserted by reopening the closed file with a fresh connection.

`397` tests in `core` (+16), `47` in `next` (+18).

---

## B8 COMPLETE — the import, and a re-run guarantee that was not there (2026-09-09)

`core` 0.3.8, `next` 0.1.4, existing app v1.1.218. **The gate is met**: a full
brief run appears in `legacy_*` with its losers, live and on import.

### `legacy_import` — two of Q19's five categories, and no path for the rest

Categories 2, 3 and 4 have **no code path at all** — not a flag, not a disabled
branch. A category that cannot be copied by accident beats one guarded by a
boolean somebody flips.

Category 1 goes through validators, and the one Q19 names is the one that
matters: **an inverted conviction band is rejected, not carried**. That
condition never throws — it just computes the wrong zone — and it fed wrong
Buy-zone alerts for three weeks in the old app. Every rejected row is **listed
with its reason**, not counted: a count says the import dropped something, the
list says what and why.

### Two drafted claims in 04 §7.4 turned out to be wrong

**It does not ATTACH.** The section describes attaching the old database
"write-capable but read-only in intent" to work around the Windows WAL problem.
But the job runs *inside* the old app, which already holds that handle — so it
is passed in, and the problem the workaround existed for does not arise.

**"Re-runnable: a second run writes nothing already present (natural keys)" was
false.** `naturalKey` in the dictionary is **metadata only** — the DDL generator
emits no unique index from it — so the `INSERT OR IGNORE` written against that
promise had nothing to conflict on and dedupped nothing. It would have read as
protection while providing none.

The two halves want different behaviour and both are now explicit:

- **Configuration is versioned per import** — `import_run_id` is in its natural
  key, so each import is an event, and that answers something a deduplicated
  table could not: what the config looked like at each import.
- **Decisions are deduplicated** by an explicit natural-key check. Their key
  carries no import id, so without it a second import would have duplicated the
  entire brief history.

`import_run_id` is also an **INTEGER foreign key to `meta_run`**, not a
composite string. Assuming otherwise cost a round of foreign-key failures.

### The Legacy view keeps two samples apart

Rows handed over live carry every candidate; rows imported backwards are
survivors-only. The split is the **first thing on the screen**, because pooling
a biased sample with an unbiased one is the failure `pre_collector` exists to
prevent. A run's **rejected** count leads the table, and a zero there on an
imported run reads *"not recorded"* rather than *"it rejected nothing"* — those
are opposite facts.

AC-13 caught three more real collisions — `slot`, `mode`, `survived`, all
dictionary columns — and none was exempted: the DTO fields are `phase`,
`strategy`, `picked`. That is five renames across two views today and zero
exemptions, which is the only way the rule keeps meaning anything.

One boundary worth recording: the IV chart's geometry moved to `shared/`
because the renderer and the tests are **different TypeScript projects**, so a
test importing from `renderer/` passed under Vitest and failed `typecheck:node`
— a split that only shows up in one of the two checks.

`381` tests in `core`, `29` in `next`, `1,256` in the existing app.

---

## B8, part 1 — the legacy hand-off, and the losers are the point (2026-09-09)

`core` 0.3.6. **B8's gate is met in `core`**: a full brief run appears in
`legacy_*` with its rejected candidates, their gates, their tested values and
the threshold each one missed. Ten tests.

The existing app's `daily_briefs` stores only survivors, which is why it can
never answer whether its own ranking was any good — the rejected candidates are
the control group. `writeLegacyHandoff` takes what the brief already holds in
memory and records **every candidate it scored**, plus the gate that stopped
each one and how far off it was.

### The payload is archived as a `host_app` response

`legacy_*` rows carry `source_response_id` NOT NULL, and a hand-off is not a
provider response — the same shape as the `derived_iv30_daily` problem found
earlier in the day, but with the **opposite** resolution: here there genuinely
is something to archive. The `host_app` provider value already existed for
exactly this ("not a vendor: the host application itself"), so the payload is
captured like any other response. That buys three things at once — AC-1
provenance for the legacy layer, replay (AC-4) for the hand-off, and the
original payload surviving intact if the parse is later found wrong.

### Three border crossings that went wrong before, now pinned by tests

- **`volume`**: an unreported volume stores as `omitted`, never `0`.
  `leg.volume ?? 0` turned "not reported" into "did not trade" on 23 of 250
  stored legs and a liquidity gate rejected them for it. A genuine zero still
  stores as zero — both halves are tested, because one without the other is
  how the distinction quietly dies.
- **`iv`**: stored as a fraction. The old app holds percentages; the builder
  converts once, at the border, and a test asserts `0.38` rather than `38` —
  the same hundredfold error the IV bootstrap is guarded against.
- **The slot is part of the run key.** The old app stored one row per day and
  deleted the other, so 248 of 250 stored picks were evening readings while the
  morning pick — the one actually read — came from data destroyed hours later.

### Sticky pins share the transaction, and the dedup lives in the writer

Every recommended contract is pinned `recommended_by_legacy` in the same
transaction as the facts, so a leg is sticky whether the brief ran before or
after that day's collection. **The loser's legs are pinned too** — the brief
considered them, so tomorrow should still be able to price them.

The "already pinned" check is in the writer rather than the ingest module, and
the split is the point: the `legacy_*` facts must replay byte-identically from
a fixture, so that module stays pure and handle-free (P11), while a sticky pin
is *current state* — re-pinning an open one would leave two open ranges for one
contract, the exact ambiguity a validity range exists to prevent.

**Still to build in B8**: the call site in the existing app's brief job
(fire-and-forget, must not change what the brief decides or emails), the
`legacy_import` one-shot for the backward import, and the Legacy view.

---

## B7b COMPLETE — the IV view, and a gap that must stay a gap (2026-09-09)

`next` 0.1.3. **The step's gate is met**: QC-907 fires on a zero-overlap fixture,
and the overlap check records its paired-day count on every evaluation.

The view shows both series on one chart, the stitch date as a vertical line, the
overlap window shaded, and the paired count and median difference as numbers
rather than as an impression. Zero paired days is rendered as a **failure in
words** — *"the two series have never measured the same day"* — not as an empty
count, because that is the state the existing app was in for a year without
anyone being able to see it.

### The one thing on this screen that can be silently wrong

**A chart that bridges a gap looks perfect.** The line is smooth, the page reads
normally, and it asserts a value on days our own series explicitly declared it
could not compute. Those statuses exist so a gap is a stated fact; drawing
across them throws that away at the very last step, after every other layer got
it right.

So the geometry is a **pure module** (`iv-path.ts`) rather than a detail inside
the component, and eight tests pin it: the line breaks at a gap, an isolated
value emits nothing because a point is not a line, gaps at either end produce no
stray segment, and a flat series still renders instead of dividing by a zero
span (which would come out blank — reading as missing data rather than as a
constant, and those are opposite facts). Inside the component none of that was
checkable except by looking.

### AC-13 caught two real collisions, and neither got an exemption

The renderer may name no table or domain column, asserted structurally. It
found:

- **`window.api.iv`** — `iv` is a column on the option snapshot, matched on a
  word boundary. The namespace is now `volatility`.
- a local variable **`reason`** — also a column.

Both were renamed. Adding either to the scan's exemption list would have been
one line and would have cost the rule some of its meaning; a local variable is
the cheapest thing in the codebase to rename.

`29` tests in `next`.

---

## B7b, part 4 — the bootstrap loader, and a unit that is corroborated rather than measured (2026-09-09)

`core` 0.3.5, existing app v1.1.214. `bootstrap_iv` is complete, fixture-tested
and wired into `collector-oneshot`; it cannot **run** until the subscription is
bought, which is a spend decision, not a build one.

**Every other phase-8 parser in this project was written after reading a live
response. This one could not be**, and the honest thing was to say so in the
spec rather than let the assertion "iv30 arrives as a decimal fraction" stand
unqualified. What actually supports it:

- `iv-history-service.ts:484` stores `row.iv30 * 100` into a percentage column,
  so the existing app treats the value as a fraction
- ~262k rows loaded that way over a year produced IV ranks nobody called absurd
- but the parser feeding it says in its own comment *"We don't know the exact
  field names until we test the API"*, tries **nine** candidate keys per field,
  and normalises strings with **`n > 2 ? n / 100 : n`**

So the fraction reading rests partly on a magnitude guess.

### The heuristic is not carried across, and the reason generalises

**A magnitude-based unit guess is untestable and fails silently in the one case
that matters.** 200%+ implied vol is ordinary for a biotech binary or a squeezed
meme name, so `n > 2 → n / 100` corrupts precisely the highest-vol tickers — the
ones a premium seller cares most about — and leaves a plausible number behind.

The loader **stores the value exactly as sent** and the job reports `outOfBand`,
the count outside the fraction band `(0, 5)`, beside the row count. Nothing is
rescaled and nothing is dropped: dropping would make a systematic unit error
look like sparse coverage, correcting it would make the error invisible. If
IVolatility sends percentages, the entire first load falls outside the band at
once and the operator's own summary line says `N value(s) OUTSIDE the fraction
band — check the unit before accepting`. **`outOfBand == rowsStored` means the
unit is wrong, not the data**, and those want opposite responses.

Fourteen tests, and what they pin is not "IVolatility sends X" — it is "whatever
it sends, this code does not silently rescale it".

### Other decisions worth keeping

`accepted = 0` is written **explicitly** on every row rather than defaulted, at
the one place that could blur *loading is not accepting*. The method note
travels on every row, because two vendors' "30-day ATM IV" are not the same
number and the difference is only recoverable if the method is stored beside
the data — and IVX is not our construction either, which is the whole reason
QC-908's threshold is a quantity to measure rather than trust.

A row with no date is skipped rather than given a guessed one: it could never be
paired, and a fabricated date would put a fabricated pairing into the single
comparison this step exists for.

`351` tests in `core`.

---

## B7b, part 3 — the overlap check, and a check that fires hardest on nothing (2026-09-09)

`core` 0.3.5, dictionary **v10**.

**QC-907 shown firing on a zero-overlap fixture — that is the step's gate, and
it is the first test in `iv-bootstrap.test.ts`.** The fixture is the exact shape
of the existing app's splice: both series long, both present, sharing no date at
all. The check reports `paired_days = 0` and fires. Drafted the obvious way —
"for every day both series exist, store the paired difference" — it would have
evaluated nothing, stored nothing, and read as clean.

Two structural decisions carry that:

- **The check is driven by the ticker list, not by the join.** A ticker with no
  common day produces no join row, so iterating the join skips precisely the
  case the check exists for. Pinned by its own test.
- **`paired_days` is reported on every evaluation, fired or not** (P10), so the
  framework derives a distribution and "never had an overlap" cannot look like
  "overlap was clean".

A day our own derivation could not compute does **not** count as a paired day,
even though both tables have a row for it. Counting those would inflate the very
quantity the check protects.

QC-908 evaluates only series that have cleared QC-907 — a disagreement measured
over three days is not a disagreement. It uses the **median**, computed in JS
because SQLite has none, and a mean is not a substitute: the overlap compares
two different *methods*, so a few days where one priced badly must not decide it.
A test stores three bad days among twenty-one and asserts the verdict does not
move.

### Registration is conditional on data, not on a shipped phase

`ALL_CHECKS` does not contain these two. `checksFor(db)` adds them only once an
`ext_iv_history` row exists, because a check registered against an unbought
bootstrap evaluates nothing every run and lands in QC-952's zero-fire review
looking exactly like one that is silently broken — which is how that review
stops being read.

### `accepted` is a mutable column, and that is the narrow exception

Dictionary **v9 → v10** adds `accepted`, `accepted_at`, `accepted_note` to
`ext_iv_history` with `mutableColumns`. The append-only guard's own note
describes this case exactly: a row whose content is a fact but which later
learns something *about itself*. The IV value stays frozen — a test asserts the
trigger still refuses to rewrite it — while the acceptance decision may be
recorded. **Loading is not accepting**, and the flag is written `0` explicitly by
the loader rather than defaulted, so the distinction is visible at the one place
that could blur it.

### Fixtures kept being wrong, and the schema kept being right

Four times in this step: `body_bytes` for `byte_length`, `quote_status` for
`price_status`, a missing `meta_run.host_app`, and an `UPDATE` on the
append-only `derived_iv30_daily`. Every one was a hand-written fixture taking a
liberty the production path could not take either. The run row is now created
through `beginRun` rather than by hand.

`337` tests in `core`.

---

## B7b, part 1 — the IV30 derivation, and a table that could not be written (2026-09-09)

`core` 0.3.5, dictionary **v9**.

Phase 9's arithmetic, as a pure function: `deriveIv30` in `packages/core/src/derive/iv30.ts`,
14 tests. No database, no clock, no provider — the same inputs give the same row
forever, which is what lets a replay recompute a stored value and compare it
rather than trust it (P4).

**Total variance is interpolated in time, not the volatilities.** `iv² · t` is
additive in time and the vols are not; the two agree exactly on a flat term
structure and diverge as soon as it slopes, which is why the test that pins the
method uses 0.20 at 16 days and 0.40 at 51 — variance interpolation gives
0.3487, naive vol interpolation 0.28, so it cannot pass by accident.

**The gaps are the interesting half.** Every refusal is a declared status rather
than a number:

| situation | status |
|---|---|
| every expiration on one side of 30 days | `insufficient_expirations` — never extrapolate |
| chain present, nothing prices at the money | `no_atm_quotes` |
| spot outside the quoted strike range | `no_atm_quotes` — clamping would substitute a deep-ITM vol and report it `ok` |
| only one leg quoting at a strike | `no_atm_quotes` |

That last one is a deliberate reading of an under-specified line. 02 §13 says
"mid-IV of call and put" without saying what to do with a one-sided quote, and
falling back to the single leg would make `iv30` *sometimes* a mid and
*sometimes* not, with nothing in the row to say which — a quantity whose
definition varies invisibly between rows is the shape this project keeps being
bitten by. The subset is chosen for liquidity, so both legs at ATM is the
ordinary case; if measurement says otherwise that is a `derivation_version` bump,
which is what the column is for.

An expiration also has to be *priceable* before it can be a bracketing endpoint.
Choosing the nearest expiration to 30 days and only then discovering it has no
ATM quotes would turn a quote-quality problem into a silent interpolation over
the wrong interval.

### The table B2 declared could not be written

`derived_iv30_daily` carries `standardColumns: true`, so `source_response_id` was
**NOT NULL with a foreign key** — and a derived row is a function of many stored
rows, not a parse of one response. There was nothing legitimate to put in it, and
naming one contributing response would have been a false provenance claim.
Phase 9 could not have inserted a single row.

02 §0.2 says these are the columns on every *raw and snapshot* table, so the
declaration was always outside what the spec asked for; nothing had tried to
write the table, so nothing had noticed. On the `derived` layer the column is now
nullable with an explicit `nullMeaning`, and a test pins that the relaxation does
**not** reach the raw layer — AC-1 rests on it being non-null there.

Dictionary v8 → v9. The table is empty in every generation, so the empty-table
rebuild added at B7a applies it in place — the first time that rule has been
load-bearing rather than defensive.

### Phase 9 is wired, and runs last

`runDerivePhase` reads what phase 7 stored and writes a row per ticker —
**including the tickers it could not compute**, because storing only the
successes would make "we could not price this" indistinguishable from "we never
looked". It is the only phase that calls no provider, so it runs last, and a day
with no chain is a no-op rather than an error: phase 7's own counts already
report an absent chain, and failing here would report one problem twice.

It resolves supersession the way every reader of an append-only table must —
latest `observed_at` per `osi_symbol` — rather than reading whatever rows come
back. A derivation that averaged two observations of one contract would produce
a number that depends on how often the collector happened to run that day.

Six tests against a real generation rather than a mock, which is the point: the
column phase 9 could not fill was NOT NULL with a foreign key, and a mock would
have accepted it cheerfully. Two of the six failures while writing them were the
schema being right and the fixture being wrong — `price_status` is not
`quote_status`, and the P3 status CHECK refused an `invalid` status carrying a
usable-looking number.

`324` tests in `core`.

---

## Two clean seeds, and the fix everyone expected did nothing (2026-09-09)

`core` 0.3.5, existing app v1.1.211, dictionary v8.

**After five consecutive corruptions, two `universe_seed` runs in a row came back
`integrity_check: ok`** — 19:51 and 20:09, on fresh generations, doing the
identical work every corrupt run did (1,092 responses, 1,083 references, 1,587
memberships, the same 6 failures). Not clean because it did less.

Three things this run had that no previous one did:

- **A baseline.** 52 tables, `ok`, every count zero, `meta_generation = 1` before
  the seed touched it. "Was it clean beforehand" had been unanswerable each
  previous round, which made every result an inference.
- **Disjointness as a reading.** `closed_at` shipped yesterday, and its first use
  showed TA2 holding the file 19:40:24–19:40:28 and the host 19:51:04–19:51:38.
  On 2026-09-09 that same question was put to the operator and answered from
  memory.
- **An instrument on the suspect itself**, which is what makes the next paragraph
  possible.

### The checkpoint is struck off, by measurement

```
checkpoint applied — walBytes=4157112 busy=0 log=0 checkpointed=0
checkpoint applied — walBytes=4148872 busy=0 log=0 checkpointed=0
```

A **4.15 MB WAL file with zero pending frames**, both times. `wal_autocheckpoint`
flushes every 1000 pages by default and had already done the work long before
`close()`. The explicit checkpoint added in v1.1.209 moved no frames on either
run, so it is not what stopped the corruption — it is a correct durability fix
for a case that did not arise here.

**One version earlier both runs would have logged nothing at all, and this would
have entered the record as the fix.** The instrument was added the same afternoon
for exactly this reason, and it repaid itself on its first use.

### What is actually left

The 01:08 corrupt seed and the 19:51/20:09 clean ones differ in the build,
dictionary v7→v8, the new `recordCloseHandle` write, the (excluded) checkpoint —
and **the care taken over concurrency**. That last one is live: "concurrent
access" sits in the eliminated table on recollection alone, and at dictionary v7
`meta_open_handle` could not have recorded a close even if the question had been
asked. **The eliminations that rest on recollection are the ones still standing.**

Downgraded from *reproduces every time* to *does not reproduce under a protocol
where both applications are verified closed*. Not closed.

### And then concurrency was eliminated by test (20:35)

A third seed, run deliberately with **TA2 open and actively reading the Data
view** throughout:

```
TradeAnalyzer 2  20:34:34 ──────────────────────────── 20:37:55
TradeAnalyzer          20:35:05 ─── seed ─── 20:35:40
```

Fully nested, stated outright by the diagnostic from the recorded intervals —
*two writers on one write-ahead log* — and `integrity_check: ok`, with the same
1,092 / 1,083 / 1,587 / 6 and the same 2,347,008 bytes as the first clean run.

**So the last suspect standing on recollection is now eliminated on
measurement.** It was the live candidate at 20:20 and it is gone by 20:40, which
is the whole argument for spending 35 seconds on an experiment instead of an
evening on an inference.

The checkpoint line under concurrency was identical — `walBytes=4157112 busy=0
log=0 checkpointed=0` — so `wal_autocheckpoint` behaves the same with a second
process on the file. (The `busy=1` predicted beforehand never had a chance to
appear: with zero pending frames there is nothing to contend over, so that
prediction was untestable as posed rather than wrong.)

It also validated the v1.1.211 verdict fix in the field: the same line now reads
**"had nothing to do — the WAL held no pending frames"** where one version
earlier it said `applied`.

### Where that leaves it: three clean seeds, no named cause

Everything in the difference set between the 01:08 corrupt seed and the three
clean ones is now either excluded or implausible as a btree-damage mechanism —
the checkpoint (measured no-op), concurrency (measured clean), and otherwise a
single-row `recordCloseHandle` write plus a nullable column added to
`meta_open_handle`. **Nothing left in that set explains corrupting
`meta_response`.**

Which leaves intermittency genuinely on the table. Five corrupt then three clean
is unlikely to be chance (~2% on a naive exact test) but the runs are not
independent draws from one unchanged process — the operator's procedure changed
too, and the baseline diagnostic that now precedes every seed did not exist
before.

**The operational consequence, and it is the useful one:** QC-001 catches this
condition on every run. What failed last time was not detection — it was that 69
consecutive reds went into an inbox nobody could act on, because the retry loop
was generating them. With the collector jobs manual-only, a red gate is now seen.
So the bug stays open, watched by a check that works, rather than blocking the
build indefinitely.

---

## The checkpoint has to say when it worked, too (2026-09-09)

Existing app v1.1.210. `core` 0.3.4, dictionary v8 — no schema change.

The collector host got its explicit `wal_checkpoint(TRUNCATE)` yesterday and
logged a `WARNING` **only when the checkpoint fell short**. That is the same
ambiguity the checkpoint was added to remove, moved up one level: no line in the
log is equally consistent with *the checkpoint applied cleanly* and with
*`close()` was never reached*.

Which matters right now more than it would at any other time. **The next
`universe_seed` is the test of the checkpoint hypothesis**, and under
warning-only reporting a clean generation would have arrived with no way to tell
whether the fix had done anything or had simply not run.

Every close now writes a line — `INFO` applied, `WARNING` short or busy,
`WARNING` threw — carrying `walBytes`, the WAL size that preceded it. A fully
applied checkpoint over an empty WAL is not the same evidence as one over four
megabytes, and `-1` (no `-wal` to stat) is reported as itself rather than as
zero.

`packages/next` has done this since it was written. **A rule pinned in one
implementation does not constrain the second one** — fourth time, and the third
of those was in this same investigation.

Spec 06 gains §3.5, which states the rule for *every* writer of a generation
rather than for the two that happen to have been fixed.

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
