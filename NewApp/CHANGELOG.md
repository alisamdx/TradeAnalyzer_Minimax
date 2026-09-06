# NewApp changelog

The new application's living changelog (06 §8). The existing app keeps its own
`CHANGELOG.md` and `changelogs/` at the repo root; nothing here applies to it.

Versions: `@tradeanalyzer/core` and `@tradeanalyzer/next` are versioned
independently of the existing app's `1.1.x`, and both stay on `0.x` until pilot
exit (06 §6).

---

## B1 — workspaces, empty packages, purity guard (2026-09-06)

`core@0.1.0`, `next@0.1.0`. First build step. Both apps build; the existing app
is unchanged in behaviour.

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
