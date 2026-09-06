# NewApp changelog

The new application's living changelog (06 §8). The existing app keeps its own
`CHANGELOG.md` and `changelogs/` at the repo root; nothing here applies to it.

Versions: `@tradeanalyzer/core` and `@tradeanalyzer/next` are versioned
independently of the existing app's `1.1.x`, and both stay on `0.x` until pilot
exit (06 §6).

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
