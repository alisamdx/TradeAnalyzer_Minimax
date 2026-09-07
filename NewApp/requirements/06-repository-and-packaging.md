# 06 — Repository, packaging and cut-over

> **Status:** draft v1, 2026-09-05. Implements Q11 (same repo, old app untouched at root, `packages/core` + `packages/next`), Q12 (same stack, separate SQLite file), Q4 (collector hosted in the old app first) and the D1 promise. Facts about the existing repo below were read from `package.json` (v1.1.191), `tsconfig.*.json` and `scripts/` on 2026-09-05.
> **Acceptance criteria owned here:** the *test placement* for AC-7, AC-11, AC-15 and the purity guard that keeps `core` Electron-free.

---

## 1. Layout

```
TradeAnalyzer_Minimax/                 ← the EXISTING app stays here, unmoved
  package.json                         ← gains "workspaces": ["packages/*"]; nothing else structural
  src/ migrations/ tests/ scripts/ …   ← untouched except §5
  NewApp/                              ← these documents
  packages/
    core/                              ← @tradeanalyzer/core — shared, Electron-free
      package.json  tsconfig.json  vitest.config.ts
      src/
        dictionary/                    ← the data dictionary as code (02 §0.5) + DDL generator
        collector/                     ← phases, capture rules, sticky sets, archive writer, host interface (04)
        ingest/                        ← one module per raw table (04 §2.3)
        qa/                            ← check registry, gate, exception lifecycle, email rendering (03)
        providers/                     ← request builders + parsers: polygon, etrade (incl. OAuth signing), edgar, finnhub, treasury
        units/                         ← converters named by the dictionary (P7)
        calendar/                      ← trading-day rules
        legacy/                        ← hand-off payload schema + validators (04 §8), import validators (Q19)
      test/
    next/                              ← @tradeanalyzer/next — the new exe
      package.json  electron.vite.config.ts  tsconfig.node.json  tsconfig.web.json
      src/main/  src/preload/  src/renderer/
      resources/
```

Rules:

- **The existing app is not relocated.** Moving 76k lines under `packages/legacy/` would touch every import and build script for no benefit (Q11). Its `package.json` becomes the workspace root; its scripts keep working unchanged.
- **`core` is bundled into `next`'s main process, not externalized** (built B1): `externalizeDepsPlugin` is given `exclude: ['@tradeanalyzer/core']`, so the packaged exe resolves no workspace symlink at runtime — the built bundle imports only `electron` and `node:path`. `next`'s `predev`/`prebuild`/`prepackage`/`typecheck:node` build `core` first, so nothing is ever compiled against a stale `dist/`.
- **`core` is Electron-free and native-free.** It imports nothing from `electron`, uses no `app.getPath`, no `safeStorage`, no `fetch` of its own, and links no native module. Everything environmental enters through `CollectorHost` (04 §1) or function parameters. A purity test (§7) fails the build if `core` ever imports `electron` or uses a path alias.
- **No path aliases in `core` or `next`.** The existing `@shared/*` alias is the reason plain-node harnesses could never import the real services (CLAUDE.md). `core` is imported as `@tradeanalyzer/core` by package name; `next` uses relative imports internally.

---

## 2. `packages/core`

| field | value |
|---|---|
| name | `@tradeanalyzer/core` |
| version | independent semver, starts `0.1.0`; **this is `meta_run.collector_version`** |
| type | `module`; compiled with `tsc` to `dist/` (ESM, `.d.ts`), `exports` map per sub-path (`./dictionary`, `./collector`, `./qa`, …). **At B1 the map is `.` and `./db` only** — a sub-path is added when its directory lands, rather than declaring entry points to files that do not exist |
| dependencies | none at runtime beyond `zlib` (Node built-in) for the archive; OAuth signing uses `node:crypto` |
| peerDependencies | `better-sqlite3` (same major as root — a **type-only** dependency: `core` receives an open `Database` from the host and uses a narrow `SqliteLike` interface, so it never loads the binary itself) |
| devDependencies | `vitest`, `typescript`, `better-sqlite3` (for tests only; built for Node by the root `pretest`) |

The **dictionary version** is a separate integer exported from `dictionary/index.ts`, bumped on any change to any entry; it is `meta_run.dictionary_version` and `meta_dictionary.dictionary_version`.

What moves from the existing app into `core`, and when: **only what the collector needs, at the moment it needs it** (Q11). Expected first movers: E*Trade OAuth 1.0a signing and request building (from `etrade-auth.ts`, minus the Electron-bound credential store and the `logs/api` writer, which become host-injected `fetch` and `logSink`); the chain/expiration/quote/portfolio/orders parsers (`etrade-options.ts`, `etrade-portfolio-service.ts` parsing halves); the Polygon aggregates/snapshot/reference parsers; the `sweepBulkWindow` earnings subdivision; the SEC EDGAR fact parser; the Saturday→Friday earnings shift; the split-discontinuity and volume-regime detectors. Each move is: copy into `core` with injected environment → tests green in `core` → the existing app imports it from `core` and deletes its copy in the same commit. Never two live copies.

---

## 3. `packages/next` — the new exe

| field | value |
|---|---|
| name | `@tradeanalyzer/next`; `productName` **TradeAnalyzer 2** (decided 2026-09-05) but `executableName` **`TradeAnalyzer2`**, no space (operator decision 2026-09-06) — the display name is what a person reads (window title, installer, Programs list) and the executable name is what a script types, and a space there has to be quoted by every shortcut, command line and `Get-Process -Name` that ever touches it; the one that forgets fails in a way that looks like the file is missing. `check-not-running.mjs` matches the **process** name, which follows `executableName`, so the two are pinned together by a test; `appId` `com.tradeanalyzer.next`; icon a binary-bodied candlestick in amber, `build/icon.ico`, generated by `build/make-icon.py` (operator choice 2026-09-06). Seven frames, **each drawn at its own size** rather than downsampled — Windows takes 16/24 for the taskbar, 32/48 for alt-tab and 256 for the desktop, and a single-frame `.ico` is legal, silent and blurred at all of them |
| version | starts `0.1.0`, independent of the existing app's `1.1.x` |
| stack | Electron pinned to the **identical range string** as root, not merely the same minor, so npm keeps exactly one copy and the root `rebuild-better-sqlite3` ABI still governs both apps. **Built B1 — this needed a second pin nobody had drafted:** with `electron` hoisted to the root, electron-builder cannot compute a version from `packages/next` and refuses to package (`Cannot compute electron version from installed node modules`), so `build.electronVersion` is set explicitly. That is now two values that can drift apart and neither drifts loudly, so `next/test/app-identity.test.ts` asserts the range equals root's *and* `electronVersion` equals the version actually **installed** — comparing against the installed copy rather than another declaration, because the installed copy is what the ABI script targets, electron-vite ^2.3, React 18, TypeScript ^5.6, better-sqlite3 ^12.10 (same as root), lightweight-charts 4.1 (bars view), Vitest ^2.1 |
| userData | `%APPDATA%/trade-analyzer-next/` — **distinct from the existing app's `trade-analyzer/`** so settings, logs and window state never collide |
| data root | configurable; default `%APPDATA%/trade-analyzer-next/data/gen-NNN/`; may point at another drive (the archive grows ~4–5 GB/yr) |
| scripts | mirror root: `predev`/`dev`, `prebuild`/`build`, `prepackage`/`package`, `typecheck:node`/`typecheck:web`, `pretest`/`test` — same ABI-swap pattern via the root `scripts/rebuild-better-sqlite3.mjs` |

Structure mirrors the existing app (`src/main`, `src/preload`, `src/renderer`) so a future session's instincts transfer, but the main process is thin: generation open/close, the `window.api` surface of 05 §9, the worker thread for heavy queries, the job runner that calls `core`'s one-shot jobs through a `NextCollectorHost` (initially without provider transports — stage 1 hosting is in the old app), the `tradeanalyzer-next://` deep-link handler, and `safeStorage` for the archive decrypt.

**No `migrations/` directory.** Schema comes from the dictionary's DDL generator (02 §0.5). Evolution rule: within a generation, changes are **additive only** (new tables, new nullable columns, new indexes) and applied as a generated forward-only DDL diff at open, recorded in `meta_dictionary`; anything else (type change, rename, unit change) is by definition a **replay into a new generation** (04 §7.5), never an in-place migration. This is P1 applied to the schema itself.

### 3.1 The shared data-root pointer

In stage 1 the collector (in the old app) writes the generation and the new exe reads it, so both must agree where it is. One small JSON file, `%APPDATA%/tradeanalyzer-shared/data-root.json` → `{ "dataRoot": "...", "currentGeneration": 1 }`, written by whichever app creates a generation, read by both at startup. It is the only file the two apps share, and it contains no secrets.

---

## 4. Workspace mechanics

- Root `package.json`: add `"workspaces": ["packages/*"]`. npm hoists shared dependencies; **`electron` and `better-sqlite3` are pinned to identical versions in root and `next`** so exactly one copy exists and the existing ABI-swap script keeps working (a second copy would be rebuilt for the wrong runtime silently — the exact failure CLAUDE.md warns about).
- `scripts/rebuild-better-sqlite3.mjs` is unchanged; both apps' `pre*` hooks call it. `scripts/check-not-running.mjs` is extended to refuse `package` of either app while **either** exe is running (the new exe also holds the generation DB open).
- Root-level aggregate scripts (added, additive): `typecheck:all`, `test:all`, `lint:all` → `npm run <x> --workspaces --if-present` plus the root's own. The existing `npm test` / `npm run typecheck` keep their current meaning (root app only) so nothing about the existing workflow changes.
- ESLint 9 + Prettier 3 stay in the root **`eslint.config.js`** (not `.mjs` as first drafted — the root `package.json` already declares `"type": "module"`, so that file is ESM today and renaming it would touch the existing app for no behavioural gain, **built B1**). Both packages extend it from their own `eslint.config.js`, adding only their build-output ignores and `no-undef: 'off'` for TypeScript sources — TypeScript resolves identifiers itself, and leaving the rule on reports every ambient type (`NodeJS`, `JSX`) as undefined. The root ignore list carries `packages/*/{out,dist,release}` explicitly, because flat-config ignores are relative to the config file. The existing rules are not tightened for the old app.
- `package.json` files are edited with the Edit tool or Node, never PowerShell `Set-Content` (BOM quirk).

---

## 5. Changes to the existing app — the complete list (D1)

This is the whole set of edits the existing app receives for stage 1. Anything beyond it needs a new decision in `00-discovery-qa.md`.

| # | Change | Where |
|---|---|---|
| 1 | `"workspaces"` entry; aggregate scripts; shared eslint config | `package.json`, `eslint.config.mjs` |
| 2 | Dependency on `@tradeanalyzer/core` | `package.json` |
| 3 | `ElectronCollectorHost` adapter implementing `CollectorHost` over the app's existing `etradeGet`, Polygon transport (through the rate limiter), `safeStorage`, nodemailer, batch progress | `src/main/collector-host/` (new directory) |
| 4 | Three batch handlers registered in `index.ts`: `data-collector` (17:05, after-close only), `collector-watchdog` (19:30), `collector-oneshot` (2-minute interval; claims one `meta_job_request` row queued by the new exe — 04 §1.1) | `src/main/index.ts`, `src/main/services/jobs/collector-*.ts` |
| 5 | One call in the brief job: build `LegacyBriefHandoff` and `host.legacyHandoff(payload)`, fire-and-forget (04 §8) | the brief job + a `legacy-handoff-builder.ts` |
| 6 | Code that moves to `core` is replaced by an import from `core` (§2), one module at a time | wherever the module lived |
| 7 | Version bump + changelog entry per the existing conventions for each of the above | `CHANGELOG.md`, `changelogs/`, `.ai/AI_CONTEXT.md` |

Explicitly **not** changed: any view, any IPC handler the UI uses, any scoring/analysis/brief logic, any existing table, any existing job's schedule or output, the E*Trade credential store.

---

## 6. Versioning and release

| artefact | version | released how |
|---|---|---|
| existing app | `1.1.x` patch bumps as today | `npm run package` at root, as today |
| `@tradeanalyzer/core` | semver; `collector_version` | not released separately; consumed in-repo |
| dictionary | integer; `dictionary_version` | bumped on any entry change; DDL diff generated |
| new exe | `0.x.y` until pilot exit, then `1.0.0` | `npm run package -w packages/next` → `release/win-unpacked/TradeAnalyzer2.exe` (`--dir`, no installer, matching current practice; Windows Developer Mode quirk applies) |

Both exes can be installed and running at once; they share only the data root pointer and the generation directory (one writer, one reader in stage 1).

**Backup**: a generation directory is self-contained (`data.sqlite` + `archive/` + `MANIFEST.json`). Copy it when no run is active (the inspector's Overview says so), or use SQLite's online backup for the DB plus a plain copy of the archive (append-only files are safe to copy live). Account archive files stay unreadable off the machine (DPAPI, Q20); recovery is re-pull.

---

## 7. Tests: what lives where

| test | location | asserts |
|---|---|---|
| **Core purity** | `packages/core/test/purity.test.ts` | no `electron` import, no path alias, no native module load, no Electron-shaped global (`app.getPath`, `safeStorage`, `ipcMain`/`ipcRenderer`, `BrowserWindow`), no `fetch` of its own, and no **value-level** `better-sqlite3` import (type-only permitted) anywhere under `core/src`. **Built B1 with negative controls**: every rule carries `fires` and `clean` fixtures, both asserted, plus an assertion that the source tree is non-empty. A source scan whose regexes match nothing passes exactly as greenly as one with nothing to find — the failure mode this project already shipped once in the own-at-strike gate (CLAUDE.md). The tree scan was verified to fail against a deliberately violating file before it was removed |
| **Dictionary conformance** (AC-3) | `core/test/dictionary/*.test.ts` | every entry complete; nullable ⇒ null meaning present; status columns declared; DDL generates and round-trips |
| **Unit conversion** (AC-7) | generated per converted field in `core/test/units/` | conversion from the provider representation; **grep test** that no `*100`/`/100`/`* 0.01` appears outside `core/src/units/` and `next/src/renderer` formatters |
| **Single writer** (AC-11) | `core/test/writers.test.ts` | for each raw table exactly one module contains an `INSERT` targeting it; `next/src` contains none |
| **Ingestion determinism** (AC-4) | `core/test/ingest/*.test.ts` | golden archived responses (fixtures, secrets scrubbed) → byte-identical rows on repeated runs |
| **Gate & lifecycle** | `core/test/qa/*.test.ts` | each QC check fires on a constructed fixture and not on a clean one (the P10 proof, at unit level); lifecycle transitions; no auto-resolve without remediation |
| **Leak canaries** (AC-15) | `core/test/etrade/logging.test.ts` (moved with the transport) + `next/test/archive-encryption.test.ts` | tokens/secrets/auth-success bodies never reach any sink; account archive lines carry the header and do not decrypt without the host |
| **Job-queue claim** | `core/test/jobs/claim.test.ts` | the conditional UPDATE claims exactly once under concurrent attempts; a claim that changes zero rows yields the job to the other host; a `queued` row older than the stall threshold is reported, not silently retried |
| **Host adapter** | `tests/collector-host.test.ts` (existing app) | `ElectronCollectorHost` satisfies the interface; renew-and-retry preserved; masked key in `endpoint` |
| **Hand-off** | `tests/legacy-handoff.test.ts` (existing app) | payload includes every scored candidate; IV converted once; `volumeReported` reflects field presence; never throws into the brief |
| **Inspector genericity** (AC-13) | `next/test/inspector.test.ts` | a throwaway dictionary entry + table appears with sort/filter/null glyphs, no code change |
| **Fake timers** | everywhere | `flushTimersUntil()` per the existing convention |

Root `npm run test:all` runs all three suites; the existing `npm test` is unchanged.

---

## 8. Development workflow

- Day to day: the existing app runs **packaged** (it is the daily driver and hosts the collector); the new exe runs under `npm run dev -w packages/next` against the same generation. Both hold the DB open; WAL allows it; only the collector writes raw tables.
- Never run `npm run dev` for the old app while its packaged instance is collecting — two hosts would both try to run the 17:05 job (the batch mutex is per process). `check-not-running.mjs` guards `package`, not `dev`; the rule is documented here and in the new exe's Overview banner ("collector host: TradeAnalyzer 1.1.x packaged, last run …").
- Every material change to either app or to `core` follows the existing conventions: Conventional Commit, changelog, `.ai/AI_CONTEXT.md` for the old app; for the new app, `NewApp/CHANGELOG.md` and the affected `NewApp/requirements/NN-*.md` section (this set becomes the new app's living spec, patched per section, never regenerated wholesale).

---

## 9. Stage-1 build order and definition of done

The paper work ends when the operator says so; this is the order the build then follows, each step leaving both apps working.

| step | deliverable | gate to next |
|---|---|---|
| B1 ✅ | Workspaces; empty `core` and `next` packages; purity test; both exes build and package | `typecheck:all`, `test:all` green; existing app unchanged in behaviour — **built 2026-09-06**, see `NewApp/CHANGELOG.md` |
| B2 ✅ | Dictionary as code for all 02 tables; DDL generator; `meta_dictionary`; new exe opens `gen-001` and the **Data** and **Dictionary** views render every (empty) table | AC-3, AC-13 — **built 2026-09-06**: 45 tables, 684 columns, 75 indexes, 74 append-only triggers. AC-13 is asserted structurally (no table or domain-column name anywhere in the renderer) rather than shown in a screenshot, because a screenshot proves this table renders and not that the next one will |
| B3 ✅ | `CollectorHost` interface; `ElectronCollectorHost`; archive writer; `meta_run`/`meta_response`; `meta_job_request` + the `collector-oneshot` claim loop; phases 0–1 (`universe_seed`) | AC-1, AC-2 on real rows — **built 2026-09-06**. Both asserted end to end against a real database and a real archive, walking raw row → `meta_response` → archive file → bytes → value and re-checking the digest. The shared pointer proven live: the dev queue script found `gen-001` through it and queued a request the app could read |
| B4 ✅ | Phases 2–4 (bars, quotes, actions) + their QC checks + the gate skeleton + email + watchdog | first green/red email received — **built 2026-09-06**. The check API makes P10 structural: a magnitude check returns every value it measured and the framework derives the distribution, so fires cannot be recorded without the distribution they came from. A real QC-204 run reports `n=1086 p99=3.0% threshold=40% nearBoundary=0`, which is the evidence that the boundary sits in an empty gap |
| B5 | `backfill_bars`; review queue cleared (04 §11) | QC-205 exceptions all resolved/accepted |
| B6 | Phases 5–7 (account, subset, chains) + checks incl. QC-412/413; Chains and Account views | chain parse-count equality (AC-5) on a full run |
| B7 | Phase 8 domains; `bootstrap_iv` (source chosen); phase 9 derivation; IV view | overlap check recorded |
| B8 | Legacy hand-off in the old brief job; `legacy_import`; Legacy view | a full brief run appears in `legacy_*` with losers |
| B9 | Exceptions workbench; Runs; the **Jobs view** over `meta_job_request` (05 §7) incl. `replay` (scratch) and `reset` | AC-4 (replay equal over fact columns, 04 §7.5), AC-14 |
| B10 | **Pilot**: 20 clean trading days; zero-fire review; per-domain inspection | `meta_generation.status = production` |

**Launching one-shot jobs before B9.** The queue table and its claim loop land at B3, but the Jobs *UI* that writes to it is B9 — so from B3 to B8 a one-shot is started by inserting a `meta_job_request` row directly (`scripts/queue-job.mjs` in `packages/core`, dev-only). This is deliberate: it means `universe_seed` (B3) and `backfill_bars` (B5) exercise the exact same claim-and-execute path the UI will use later, rather than a temporary direct-call path that would then be deleted untested.

**Stage 1 is done** when AC-1 through AC-15 hold on the production generation and the operator has promoted it. Stage 2 (derived layers, studies, then screening) starts only then, in a new document set under `NewApp/requirements/stage-2/`.

---

## 10. Decisions closed 2026-09-05, and what stays open

### 10.1 Closed

| item | decision | consequence |
|---|---|---|
| `core`'s SQLite abstraction | **Narrow `SqliteLike` interface.** `core` defines it (§2.1); `better-sqlite3` stays a type-only peer dependency and `core` never loads the binary. | The purity test (§7) additionally fails on any **value-level** import of `better-sqlite3` under `core/src`. Type-only imports are permitted. |
| Bundling `docs/formulas.md` in the new exe | **No.** Stage 1 has exactly one derived table and 02 §13 writes its method out inline; the rest of that file documents the existing app's scoring engine, which is out of scope. | A derived field's method note lives in its dictionary entry, which is the only authority the new app has. Revisit when stage 2 adds derived layers — a bundled copy that drifts is worse than none. |
| `productName` | **TradeAnalyzer 2.** | Start-menu and taskbar name; `appId`, package name (`@tradeanalyzer/next`), userData directory (`trade-analyzer-next`) and the deep-link scheme are unchanged — they are stable identifiers, and renaming any of them later costs a re-registration or a data-root move for no user-visible gain. |

### 10.2 Still open, by design

- Every threshold marked † — settled after the first 20 pilot runs (03 §10), not before.
- The 04 §11 pre-pilot checklist: eight measurements that need real provider calls, including the IV bootstrap source (Q17).

---

## 11. `SqliteLike` — the interface `core` compiles against

Declared in `core/src/db/sqlite-like.ts`; the host passes an instance in. Covers exactly what the collector and gate use, no more:

```ts
export interface SqliteStatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteLike {
  prepare(sql: string): SqliteStatementLike;
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}
```

**The rule that keeps this from rotting**: it is not permitted to grow to accommodate a convenience. `.pluck()`, `.raw()`, `.iterate()`, user-defined functions and the online-backup API are deliberately absent — a driver-specific feature is the signal that the work belongs in the host, not in `core`. If a large scan ever genuinely needs streaming, the host passes a callback, it does not widen the interface. Widening it until it re-exports `better-sqlite3` would restore exactly the coupling this avoids: `core`'s own test run would then need the Node-ABI binary, and the ABI-flip quirk (CLAUDE.md) would bite a third package.
