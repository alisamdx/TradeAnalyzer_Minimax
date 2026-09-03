# 24 — Engineering Practices (mandatory)

These practices keep the codebase debuggable, regression-safe, and resumable across sessions. They are requirements, not suggestions — a rebuild must reproduce them.

## 24.1 Versioning

- A single canonical semantic version in `package.json` (`MAJOR.MINOR.PATCH`), starting at `0.1.0`.
- Shown in the **status bar** (injected as `__APP_VERSION__` at build) and the About dialog.
- Bump per change: PATCH = fix, MINOR = feature, MAJOR = breaking. Logs, error reports, and snapshots include the producing version.

## 24.2 Changelog

- `CHANGELOG.md` at the root is the reverse-chronological index.
- Each material change adds `changelogs/v{version}_{YYYY-MM-DD}.md` with: version, date, summary, features added, bugs fixed, breaking changes, and free-form "AI session notes" for future sessions.
- Trivial commits (typos, formatting) need no entry; anything changing behavior, schema, public API, dependencies, or rate-limit defaults does.

## 24.3 Logging

- Structured JSON logs of every outbound provider call (`logs/api/`, E*Trade OAuth calls included since v1.1.167 — an auth *failure* body is logged, an auth *success* body never is, because it carries a live token secret): ISO-8601 timestamp (ms), provider, endpoint, method, params (**API key redacted**), status, latency ms, response size, retry count, `job_run_id` if part of a batch. Plus screen/analysis run logs and an errors log (`logs/errors/`).
- The log directory path is shown in Settings. Secrets are never logged.

## 24.4 Testing & regression

- Vitest, offline by default (< 90s). Live-provider smoke tests gated behind an env flag, not in the default run.
- Unit tests required for: fundamentals computer, indicators (RSI/MACD/ADX/ATR/Bollinger/SMA/EMA), screening filter logic, wheel-suitability and scoring math, rate limiter, queue/batch sizing, CSV round-trip, options-structure builders, and migration apply/idempotency (count-agnostic).
- **Every bug fix ships with a regression test** that fails before and passes after.
- Providers are interfaces → mockable. Fake-timer tests use a `flushTimersUntil()` polling helper (not `vi.runAllTimers()`), because the rate limiter's promise chain won't otherwise drain.

## 24.5 AI context maintenance

- `.ai/AI_CONTEXT.md` is the live build-state snapshot (stack, schema, services, views, quirks), kept under ~1,500 lines and accurate to the code. History lives in `changelogs/`, not there.
- `/CLAUDE.md` is the operating manual (rules, conventions, key files, standing instructions). `README.md` is human onboarding. This `Requirements/spec/` folder is the authoritative specification.
- Every material change updates `CHANGELOG.md` + the per-version changelog + `.ai/AI_CONTEXT.md` **in the same commit**.

## 24.6 Migrations & data safety

- Numbered SQL migrations in `migrations/`, applied in order on startup, idempotent, recorded in `schema_version`. Never edit an applied migration — add a new one.
- All DB access goes through `withTransaction(db, fn)` (never `db.transaction(fn)()` directly) and the `openDatabase()` wrapper, so the driver stays swappable.
- Backups: a Settings "Backup everything / Restore" path; never commit `backups/`, `.env`, or credentials.

## 24.7 Git workflow

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`). Branch off the default branch for changes; don't commit secrets.
- Each material change is one commit containing the code + version bump + changelog + AI_CONTEXT update.
- After committing, run `npm run package` so the packaged exe (what the user runs daily) reflects the change.

## 24.8 Build, packaging & platform gotchas

- Scripts: `dev` (HMR), `typecheck` (main+web), `lint`, `test` (Vitest), `build` (installer), `package` (`--dir`, no installer).
- **better-sqlite3 ABI**: `predev`/`prebuild`/`prepackage` run `rebuild:electron`; `pretest` runs `rebuild:node`. A `NODE_MODULE_VERSION X vs Y` error means the wrong binary — run the matching rebuild. Do **not** use `electron-builder install-app-deps` (it reports success without swapping the ABI).
- **`package.json` must be UTF-8 without BOM** — a BOM (e.g. PowerShell `Set-Content -Encoding utf8`) breaks electron-vite's JSON parse. Edit via diff tools or Node.
- **Packaging requires Windows Developer Mode ON** (winCodeSign archive contains macOS symlinks). `CSC_IDENTITY_AUTO_DISCOVERY=false` + `win.forceCodeSigning:false` avoid signing errors.
- **`node:fetch` does not exist** in Node 24 — use global `fetch`.
- **`window.api`** is declared only in `renderer/src/global.d.ts` (avoid TS2717).
- The `dev` script guards **`ELECTRON_RUN_AS_NODE`** to prevent the CJS/ESM mismatch crash.
- Production DB path = `app.getPath('userData')/trade-analyzer.sqlite` when packaged, `<appPath>/data/` in dev.

## 24.9 Resumable batch acceptance (pipeline)

- "Validate All" on 100 tickers completes < 2 min at default rate.
- Stop mid-run leaves the DB consistent (no half-written rows); all data fetched before Stop is queryable with a "partial" badge.
- Resume skips completed tickers and processes only the remainder.
- A forced 429 triggers auto-throttle visible in the status bar.
- The UI stays responsive (chart/watchlist navigation works) while a long job runs.
