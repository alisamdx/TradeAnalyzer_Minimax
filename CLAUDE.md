# CLAUDE.md — TradeAnalyzer project instructions

> **Start every session here, then read `.ai/AI_CONTEXT.md`** for current build state (stack, schema, services, views, quirks). If anything below conflicts with `.ai/AI_CONTEXT.md`, prefer `.ai/AI_CONTEXT.md` — it is verified against the code. `Requirements/spec/` is the authoritative, rebuild-from-scratch specification (start at `Requirements/spec/00-index.md`); treat `FR-*` / `NFR-*` as acceptance tests. Older scattered specs are archived in `Requirements/_legacy/`.
>
> This file is the **operating manual** (rules, conventions, key files). `.ai/AI_CONTEXT.md` is the **state snapshot**. `README.md` is **human onboarding**. `.ai/AI_PROMPT.md` is a **thin session-kickoff pointer** (it points here for the rules — it must never restate them).

## Project

TradeAnalyzer is an Electron + React + TypeScript desktop app for a retail options/swing trader. Watchlists, screener, five-mode analysis engine (buy/options/wheel/bullish/bearish), configurable scoring engine, daily AI intelligence brief, validation dashboards, multi-leg payoff modeling, portfolio tracking synced from E*Trade, LEAPS+CSP and collared-LEAPS screeners, earnings calendar, News & Research, backtesting. The app is feature-complete against the v1 spec; the gate to v1.0.0 is real-world usage validation.

## Stack

- **Shell**: Electron 32.x
- **UI**: React 18 + TypeScript 5.x
- **Build**: electron-vite 2.x
- **DB**: better-sqlite3 12.x (wrapped in `src/main/db/connection.ts`)
- **Charts**: lightweight-charts 4.1.x
- **Tests**: Vitest 2.x
- **Lint**: ESLint 9 + Prettier 3

## Commands

```bash
npm run dev          # dev with HMR
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # production build
npm run package      # package without installer
```

## Architecture

```
src/main/            ← Electron main process: db, services, IPC, API server
src/preload/         ← context-isolated bridge (window.api.*)
src/renderer/        ← React UI (views, components, hooks)
src/shared/types.ts  ← shared TypeScript types
migrations/          ← numbered SQL migrations
docs/formulas.md     ← every financial metric formula
```

**Data flow**: React view → `window.api.*` → `ipcRenderer.invoke` → main IPC handler → Service → better-sqlite3 / DataProvider (Polygon.io)

## Rules

### Before coding
- Read `.ai/AI_CONTEXT.md` for current build state, schema, and known quirks
- Standing instructions live in this file (see "Standing instructions for AI sessions" below)
- Read `Requirements/spec/` for the full spec (start at `00-index.md`; FR-* / NFR-* are acceptance tests)

### Code style
- TypeScript strict mode. No `any` unless unavoidable.
- Functional React components with hooks. No class components.
- Service classes in `src/main/services/`. IPC handlers in `src/main/ipc/`.
- DB access goes through `withTransaction(db, fn)` — never raw `db.transaction()`.
- All market data flows through `DataProvider` / `OptionsProvider` interfaces — never ad-hoc `fetch` to Polygon.
- Formula comments must reference `docs/formulas.md#anchor`.

### Never
- Bypass the rate limiter for Polygon API calls
- Invent or synthesize market data — surface missing fields as null
- Log secrets — API keys live in OS keychain or `.env`
- Commit `.env`, credentials, or `backups/`
- Use `any` type — prefer `unknown` with type guards
- Reach for `db.transaction(fn)()` directly — use `withTransaction(db, fn)`

### Financial data conventions
- IV is stored and displayed as a **percentage** (38.82, not 0.3882). E*Trade returns IV as a decimal fraction (0.3882) — always multiply by 100 when ingesting.
- All monetary values in USD. Prices per share, not per contract.
- DTE is calendar days (not trading days).
- `// see docs/formulas.md#anchor` comment on every derived metric.

### E*Trade integration
- OAuth 1.0a flow implemented in `src/main/services/etrade-auth.ts`
- **The E*Trade OAuth renew endpoint is `/oauth/renew_access_token`, NOT `/v1/oauth/...`** (the `/v1/` prefix is only for market/accounts APIs). It was wrong until v1.1.99, so `renewAccessToken()` silently failed and dormant tokens **never auto-revived** — every dormancy forced a manual re-auth, masquerading as the recurring evening-batch "token expired" failure. Renew errors are swallowed in the renew-and-retry paths, and the renewal tests **mock** `renewAccessToken`, so the bad URL was invisible; `tests/etrade-renew-endpoint.test.ts` now asserts the real fetch URL. A dormant token returns `oauth_problem=token_rejected` (not `token_expired`). `checkConnection()` was a **date-stamp check only** (fast, no live call) and so could not tell a working token from a dead one — as of v1.1.166 it probes whenever the stamp isn't today's (see the midnight-ET quirk below). v1.1.100 adds a **live** `probeETradeConnection`/`etrade:test-connection` (real SPY quote + renew-and-retry → `ok|renewed|expired|error`) used by the Settings "Test Connection" button and a **~90-min keep-alive heartbeat** (`index.ts`) that pings E*Trade inside the 2h window so the token never goes dormant during a running session.
- Tokens expire at midnight ET. After 2h inactivity they go dormant — call `renewAccessToken()`. The nightly jobs **and** the on-demand `ETradeDataProvider.getOptionsChain`/`getOptionsExpirations` (via `withRenew`, v1.1.48) auto-renew-and-retry on a dormant-token 401; a token expired past midnight still needs a manual re-auth. A dormant token used to silently yield an empty chain on evening agent/lab runs.
- **A dormant token does NOT reliably fail as a 401** — it can kill/hang the response stream (undici `terminated`). Never gate a renewal attempt on an auth-shaped error message; renew-and-retry on ANY E*Trade failure (renewing an active token errors harmlessly). This bit **two** paths with the same auth-message heuristic: the daily-iv-update connectivity check (halted the evening orchestrator chain 8 of 10 trading days, fixed v1.1.92) **and** `ETradeDataProvider.withRenew` (the on-demand options path used by the API server, Strategy Lab, agent, and v2 execution re-pricing — silently returned empty chains > 2 h after last activity, fixed v1.1.94). Both now renew on any error.
- E*Trade credentials stored encrypted in settings via `secure-settings.ts`
- All E*Trade API calls go through `etradeGet()` which handles signing — never construct auth headers manually.

### Git conventions
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- Every material change updates, in the same commit: version + `CHANGELOG.md` + `changelogs/v{version}_{date}.md` + `.ai/AI_CONTEXT.md` + the affected `Requirements/spec/` section (+ `docs/formulas.md` if a formula changed)
- Bug fixes ship with a regression test

### Documentation maintenance (keep these in sync)
Update only what the change touches — don't regenerate everything:

| You changed… | Update |
|---|---|
| Any behavior/feature | `CHANGELOG.md` + `changelogs/v{version}_{date}.md`, and the matching `Requirements/spec/NN-*.md` section |
| Schema (a migration) | `Requirements/spec/02-data-model.md` + `.ai/AI_CONTEXT.md §8` |
| A financial formula | `docs/formulas.md` + `Requirements/spec/23-formulas.md` |
| A wheel scoring weight, gate, delta/DTE target or pipeline cutoff | `docs/wheel-parameters.md` (the parameter inventory + its provenance and test queue) |
| Services/views/IPC/providers | `.ai/AI_CONTEXT.md` (state map) + the relevant `spec/` section |
| A non-obvious gotcha | `CLAUDE.md` Known quirks + `.ai/AI_CONTEXT.md §10` |
| Install/run/config | `README.md` |
| A user-facing workflow/screen | `UserManual/USER_GUIDE.md`, then regenerate the PDF (`python UserManual/build_pdf.py`) |

`Requirements/spec/` is authoritative and per-section — patch the one affected section, not the whole set. A full spec regeneration is a deliberate, occasional task, not a per-commit one. `Requirements/_legacy/` is frozen — never edit it.

### Testing
- `npm test` runs Vitest
- Test files in `tests/` directory
- Migration tests are count-agnostic (don't assert specific migration count)
- Fake timer tests use `flushTimersUntil()` helper, not `vi.runAllTimers()`

## Key files

| File | Purpose |
|------|---------|
| `src/main/index.ts` | App lifecycle, window creation, provider wiring, IPC + batch job registration |
| `src/main/db/connection.ts` | DB wrapper (`openDatabase`, `withTransaction`) — the only DB entry points |
| `src/main/db/migrations.ts` | Runs numbered migrations from `migrations/` |
| `src/main/api-server.ts` | Fastify local API on 127.0.0.1:7432 (TraderAgent integration) |
| `src/main/services/data-provider.ts` | `DataProvider` interface (quotes/fundamentals/bars) |
| `src/main/services/polygon-provider.ts` | Polygon implementation of `DataProvider` |
| `src/main/services/options-provider.ts` | `OptionsProvider` interface (chains/IV/expirations) |
| `src/main/services/etrade-data-provider.ts` | E*Trade `OptionsProvider` (active default) |
| `src/main/services/etrade-auth.ts` | OAuth 1.0a flow + `etradeGet()` |
| `src/main/services/analysis-service.ts` | 5 analysis modes + indicator math |
| `src/main/services/scoring-service.ts` | Configurable 5-strategy scoring engine |
| `src/main/services/strategy-lab-service.ts` | Scores/explores all 31 tastylive strategies |
| `src/main/services/payoff-service.ts` | Multi-leg payoff modeling + AI assessment |
| `src/main/services/portfolio-service.ts` | Position CRUD + P&L + Greeks |
| `src/main/services/earnings-service.ts` | Earnings calendar (E*Trade), Saturday→Friday shift |
| `src/main/services/batch-service.ts` | Daily job scheduler (`BatchJobHandler`, mutex, schedules) |
| `src/main/services/secure-settings.ts` | Encrypted settings (E*Trade creds) |
| `src/main/services/jobs/*.ts` | 13 batch job handlers |
| `src/main/ipc/*.ts` | 27 IPC handler modules |
| `src/renderer/src/App.tsx` | Layout + sidebar routing (9 sections, 31 views) + status bar |
| `src/renderer/src/views/*.tsx` | 31 feature views |
| `src/renderer/src/global.d.ts` | `window.api` type declaration (only place) |
| `src/shared/types.ts` | All cross-process types |
| `src/preload/index.ts` | `window.api.*` bridge (34 namespaces) |

## Known quirks

- **better-sqlite3 ABI flips** between Node and Electron. `predev`/`prebuild`/`prepackage` swap the Electron binary; `pretest` swaps the Node binary. `NODE_MODULE_VERSION 128 vs 137` = wrong binary; run the matching `rebuild:*` script. Don't revert to `electron-builder install-app-deps` (reports success without swapping the ABI).
- **`package.json` must never be written by PowerShell `Set-Content -Encoding utf8`** — writes a UTF-8 BOM electron-vite rejects. Use the Edit tool or Node.
- **`npm run package` needs Windows Developer Mode ON** — winCodeSign archive has macOS symlinks; non-admin symlink creation is otherwise blocked. One-time setup.
- **`node:fetch` does not exist** in Node 24. Use global `fetch`.
- **`window.api` declaration** lives only in `src/renderer/src/global.d.ts`. Never redeclare per-file (TS2717).
- **`ELECTRON_RUN_AS_NODE`** guard in `dev` script prevents CJS/ESM mismatch crashes.
- **Options provider is switchable** (`optionsProvider` setting), read at startup; **E*Trade is the active default** (Polygon Options Starter cancelled). `DataProvider` is always Polygon.
- **IV rank/percentile** are null from Polygon snapshot — computed from `iv_history`, which needs the MarketData.app/IVolatility backfill populated.
- **Earnings** come from E*Trade (no Polygon public endpoint). **E*Trade dates are UTC** → Thursday-evening ET reports show as Saturday UTC; `earnings-service.ts` shifts Saturday→Friday, marks unconfirmed.
- **E*Trade IV** is a decimal fraction (0.3882 = 38.82%). `* 100` when ingesting into percentage storage; pass directly to Black-Scholes as sigma.
- **VIX comes from E*Trade, not Polygon** — Polygon's *stocks* snapshot can't serve VIX (it's an index, `I:VIX`). The brief job's `refreshVixQuote()` fetches it via E*Trade `/v1/market/quote/VIX`, sane-range-validates (`[5,150]`), and upserts into `quote_cache` for the critic. **The E*Trade index symbol `'VIX'` is unverified** — check `runMeta.vix` against the real VIX after a brief run; if wrong, the value is ignored (fail-safe) and the symbol needs fixing. Both the critic (`getMarketContext`) and the Morning Briefing dashboard (`BriefingService.getMarketRegime`) read this one cached value.
- **Critic LLM gets only the data in its context** — it has no live feed. It was told to compute a "1-sigma move (annualized vol …)" with **no** vol field provided, so it fabricated IV numbers. Anything the critic should reason about numerically (IV, realized vol, …) must be in the context object; the prompt now forbids citing vol figures not present in `volatility`.
- **Fake-timer tests** use `flushTimersUntil()`, not `vi.runAllTimers()`.
- **The batch runs twice a trading day** (≈10:15 ET intraday scan + ≈16:30+ ET after close) and the after-close slot re-runs every job. **Every job must refresh + overwrite what the morning slot wrote** — the morning run stores a *partial* same-day daily bar (first ~50 min of volume, intraday close), and breakout/`volume_surge` scoring reads it. Don't gate a job on `MAX(date) < date('now')` (that made the evening price refresh skip a ticker that already had a partial morning bar — fixed v1.1.49; price-gap-fill now always re-fetches + `INSERT OR REPLACE`s the recent window). The after-close daily bar must be **final** when fetched — Polygon keeps settling it past 16:00 ET, so ≈17:00 ET is safer than 16:30. See spec §20.5.
- **Weekly-expiration date math must stay in one time base.** Helpers that guess upcoming **Friday** expirations (e.g. `routes-options.ts` `nextFridays`) must compute the weekday *and* serialize in the **same** time base — all UTC (`getUTCDay`/`Date.UTC`/`setUTCDate`/`toISOString`) or all local. Mixing local weekday math with `toISOString()` shifts every date to **Saturday** on evening runs (local clock past UTC midnight), and E\*Trade lists Fridays only → the chain lookup silently returns an empty array. This starved the TraderAgent of option contracts for ~10 days (fixed v1.1.47). The canonical UTC pattern lives in `analysis-service.ts` / `filter-templates-service.ts`.
- **IBKR (TWS API via `@stoqey/ib`) gotchas** (v2 execution, validated live on paper 2026-06-18): (1) **No market data for BAG combos** — `reqMktData` on a smart-routed combo returns nothing even with an options subscription; single-leg option data works, so `IbkrExecutionBroker.priceCombo` prices **from the individual legs** (`comboQuoteFromLegs`), never the BAG. (2) **Orders need `eTradeOnly:false, firmQuoteOnly:false`** or newer TWS silently drops them (no status, no error). The engine's own placement path was missing these until v1.1.62 — the armed paper engine logged `order_submitted` but no fill ever came back and nothing reached the account (the diagnostic scripts always had the flags, so the gotcha was known but the production `IbkrExecutionBroker` path was never exercised end-to-end). Both the live order and the whatIf preflight now build through the shared `buildComboOrder()` which always sets them. (3) **Options pricing needs an OPRA market-data subscription**; order placement/fills do **not** (execution ≠ data). (4) **Paper account permissions** can't be toggled independently in Client Portal (the UI mirrors live). Do **not** assume paper has full options permissions — verify empirically: the paper account (`DUQ795672`) was found on 2026-06-23 to **lack options spread (multi-leg) permission**, so IBKR rejected/cancelled every 2-leg combo the engine sent. The engine now runs the spread-permission preflight in **paper as well as live** (v1.1.66) and refuses to start with `spread_permission:<code>` rather than arming into silent rejections; fix is operator-side (Client Portal → Trading Permissions → Options → spread level). (5) A **combo is one BAG order with N legs** (TWS "show legs" expands it), filled as a package — never N independent leg orders. (6) **An order's reject reason comes on the `error` event keyed by order id, NOT on `orderStatus`** — a rejected/cancelled order's `orderStatus` is just `Cancelled`/`Inactive` with no reason. The broker must match an order-id error to its tracked order and surface the reason, else orders end `cancelled` with `reject_reason=NULL` and you're blind (fixed v1.1.65). Diagnostics: `scripts/ibkr-*.mjs`.
- **`historical_prices` can hold UNADJUSTED SPLITS — `adjusted=true` on the fetch is not enough.** Polygon returns a series adjusted *as of that fetch*, but bars are stored incrementally and price-gap-fill only re-fetches a ~3-day window, so a split that happens later leaves pre-split bars next to post-split ones — a permanent step mid-series. Measured 2026-08-28: **153 discontinuities across 126 tickers**, incl. CRWD −74% in one day (4:1 split), DD +203%, MRNA +177%, against SPY's largest genuine daily move of 2.58%. This silently corrupts SMA/RSI/ADX, `volume_surge`, breakouts, relative strength, the backtest engine, and **Brief Replay** — the tool FR-SEY-5 depends on. `split-repair.ts` (v1.1.139) detects the step and re-fetches the whole range; repair is idempotent, so a false positive costs one API call while a false negative corrupts every indicator spanning the date. **Any incrementally-stored price series has this bug class — freshness of the tail does not imply consistency of the history.**
- **A price discontinuity has THREE possible causes and only one is repairable (v1.1.139-141).** (1) *Unadjusted split* -> re-fetch the whole range. (2) *Genuine violent move* -> data is correct; mark it, but the verdict must EXPIRE (30d TTL) since providers backfill corporate actions late. (3) *Ticker reuse* — the symbol was reassigned to a different company, so the series splices two entities and **no re-fetch can ever fix it** (the provider keys by ticker too); truncate `historical_prices` + `iv_history` before the splice. **Discriminate with VOLUME, not price**: reuse shifts the volume regime >=15x permanently (BNY 76x, SPCX 53,592x) while genuine moves stay <=5x (MRNA 5.0x). A split day's intraday range is *normal* (~2-5%) because OHLC are all already in the new scale — so a wide range means a real move. **"Steps and stays" does NOT imply a split**: a permanent repricing on news looks identical on price alone (I called MRNA a reverse split on that basis and was wrong).
- **A split repair fixes `historical_prices` but NOT the option legs frozen in `daily_briefs.picks`.** The two then sit on *different price scales*, and any replay/backtest that settles a stored strike against a stored close manufactures enormous fake losses. Measured 2026-09-02: 4 CRWD picks (4:1 split, strike/spot **4.12x**) contributed **-$168,516** of fiction to a lizard-vs-spread backtest whose reported total was **-$70,955** — the real figure was **+$97,561**, so four rows out of 164 *inverted the sign of the headline*. `split-repair` cannot fix this: rewriting historical option legs would falsify what was actually recommended at the time. Any harness reading stored legs must carry a **scale guard** — compare the short strike to the underlying's close on the pick date and exclude (don't settle) rows that disagree. `scripts/backtest-lizard-vs-spread.mjs` has one (`SCALE_TOLERANCE = 0.35`); it prints excluded rows rather than dropping them silently. **This bug class outlives the repair that causes it — a fixed price series makes stored legs MORE wrong, not less.**
- **Before trusting a P&L/backtest number, check the underlying series for discontinuities.** A single unadjusted split turned into a fake $43k loss in a hand-run study before it was caught.
- **A capped bulk API response is NOT a complete answer — Finnhub truncates from the FRONT.** Finnhub's free-tier bulk earnings calendar returns at most **1500 entries** and drops the *earliest* dates, so `from=today&to=+90d` comes back holding only the last ~2 weeks of the range during earnings season (verified: `from=2026-08-25&to=2026-11-23` → 1500 entries spanning only 2026-11-09…11-23). The old `EarningsRefreshJob` trusted that payload and stored NVDA's **2026-08-26** report as **2026-11-17** — one quarter late — so the −20 earnings penalty never fired and the brief ranked NVDA **wheel #1 on the day it printed**. Treat a response *at* the cap as evidence of truncation and subdivide (`sweepBulkWindow`, v1.1.136); peak season needs slices as narrow as ~5 days, so a fixed chunk size is not enough. **Corollary that bit three layers at once: "there is a future date stored" is not the same as "the stored date is right."** The nearest-wins guard, `EarningsRefreshJob`'s Phase-2 delta filter, and the brief's `refreshTickers` all skipped on a stored future date — so the bad write silently suppressed every mechanism that would have corrected it. Bulk data may move an earnings date **nearer** without bound, but **later** only on a *complete* sweep and only by ≤ 14 days (`MAX_LATER_SLIP_DAYS`) — enough for an issuer refining its date, far short of the ~90-day jump that means a coverage gap hid the near date.
- **Jobs that consume another job's output must be registered BEFORE nothing — order is `sequence_order`, seeded from registration order in `index.ts` and then frozen in the DB.** `registerJob()` uses `INSERT OR IGNORE`, so reordering registrations only affects **fresh installs**; an existing install needs a migration to move `batch_jobs.sequence_order` (see migration 067, which moved `earnings-refresh` ahead of `daily-intelligence-brief` — the brief's earnings penalty had been reading a calendar refreshed at the *end* of the previous chain). Same frozen-column trap as `config_json`/`after_close_only` (v1.1.121, v1.1.123).
- **E*Trade API calls are logged to `logs/api/` only since v1.1.144 — before that the provider was completely dark** (2026-09-01: 17,200 Polygon entries, zero E*Trade). `etradeGet` was the single choke point and logs success, non-2xx (with a 300-char `responseBodyPreview` of E*Trade's error envelope) and network faults (`responseStatus: null` — a dormant token can terminate the stream rather than 401). **Success response bodies are deliberately NEVER logged** (positions/balances/quotes; plaintext file, 30-day retention), the **account key is masked** out of the endpoint path, and all sites go through `safeLog` so a logger failure can never break an API call. When an E*Trade path misbehaves, check `logs/api/api_<date>.jsonl` for `"provider":"etrade"` BEFORE guessing.
- **Closed positions come from EXECUTED ORDERS, not transactions (v1.1.150–154).** `/v1/accounts/{key}/orders?status=EXECUTED` is the primary source: `orderAction` states OPEN vs CLOSE outright and `averageExecutionPrice` is the realised fill. **`/transactions` is a trap here** — it needs `sortOrder=DESC` (+ often `.json`) to respond at all, is intermittently unresponsive for ~120 s answering `oauth_problem=nonce_used` (a mask over a server-side timeout, not an OAuth fault — a FRESH nonce gets it too), and even when all 9 slices return 200 its parser yields **zero** positions: `classifyTransaction` infers intent from "sold means opened" and pairs opens to closes BY INDEX. Kept only as a fallback for what orders misses (dividends, fees, corporate actions). **Two bugs were hiding each other** — a dead endpoint and a broken parser; fixing either alone still looked like failure. None of it was diagnosable until E*Trade calls were logged at all (v1.1.144).
- **An ASSIGNED CSP is a CONVERSION into stock, not a loss — but only the real fill proves it.** Before the import worked, every closed position's `realized_pnl` was an "estimated from last mark" fallback, and those are systematically wrong in both directions: TSLA 350 CSP read −$3,736 (actual **+$499.48**), TSLA 360 CC read −$463 (actual **+$347.47**), while AMD 450 read +$554 (actual **+$859**) and NOW 90 read +$4 (actual **−$143**). Measured 2026-09-01 the whole book read −$2,902 when it was **+$3,983.12**. A real fill supersedes an estimate in place (match on ticker+type+strike+expiry+entry_date+quantity — ticker+type alone collapses an open assignment lot into an unrelated closed lot). **Do not reconstruct P&L by inference when fills are obtainable**: the fills corrected five positions the reconstruction got wrong and surfaced nine trades that were not in the DB at all.
- **Inspecting the production DB while the app is running**: open it with a **write-capable** better-sqlite3 connection (`new Database(path)`), never `readonly: true`. On Windows a readonly connection can't attach the live WAL index (needs write access to `-shm`) and silently reads only up to the last checkpoint — writes from minutes ago (e.g. a just-finished brief) appear missing. Write-capable read-only queries are safe in WAL mode.

- **A validated form is not a validated field — find every writer.** The My Stocks conviction bands must satisfy `low < mid < high`, and the edit modal always checked it. But the **AI review "Apply"** path is a second writer: it merges LLM-recommended bands *field-by-field* into the stored ones (`recommendedLow ?? stock.priceLow`, …), so a recommendation that returns only a new low can push it above an untouched mid. Three rows (MSFT 433/409, NOW 123/108, PLTR 152/133) sat inverted for **three weeks** — an inverted band never throws, it just computes the wrong zone, so it silently fed wrong Buy-zone alerts and the brief's conviction callout. Fixed v1.1.165 by moving enforcement into `validateBandOrder()` in the **service** (`add`/`update`), the choke point every writer passes through; validation runs *before* the transaction so a rejected edit writes no `conviction_band_history` row. **Corollary: a per-field merge of model output into stored state can violate an invariant neither the model nor the store ever saw whole.** Backed by three CHECK constraints (migration 075); installing them exposed a second trap worth remembering — **`PRAGMA foreign_keys=OFF` is a no-op inside a transaction, and `migrations.ts` wraps every migration in one**, so a table rebuild cannot suppress FK cascades the way the SQLite manual's procedure assumes. Dropping `conviction_stocks` would have cascade-deleted the whole `conviction_band_history` audit trail; the child must be copied aside and dropped first. A rebuild migration must also **normalise** rows that would fail the new constraint, never let them fail the copy — a failed migration means the app does not boot.

- **"Expires at midnight ET" is E*Trade's documented policy, NOT observed behaviour — never treat a stale date stamp as proof a token is dead.** `etrade:check-connection` returned `expired` purely on `etradeTokenDate !== todayET()` with **no API call**, and `App.tsx` hijacks startup and redirects to Settings on anything but `ok` — so a working token produced a demanded re-auth (observed 2026-09-02 19:49 ET: zero E*Trade calls made, reconnect screen shown, same token 200 OK 50 min before and 90 s after). The API log for that day shows a token stamped **2026-09-01** serving **13,098 successful calls** across the midnight boundary, including at **00:40 ET**. `probeETradeConnection` had the same short-circuit, so even the *live* "Test Connection" refused to probe. Fixed v1.1.166: the stamp now means **last known good**, a stale value only means "unverified today", both paths probe, and a successful probe re-stamps (self-healing, and the verified-today fast path still costs nothing). A transient network failure maps to `unknown`, never `expired` — being unable to reach E*Trade is not evidence about the token. **General shape: a cheap local heuristic standing in for a remote authority must be allowed to say "don't know", never "no".**
- **Every E*Trade call — OAuth included — now goes through one instrumented transport (`sendETradeRequest`, v1.1.167).** `getRequestToken`, `getAccessToken` and `renewAccessToken` used to call `fetch` directly and so were the ONE part of the integration v1.1.144's logging never covered: a log holding 13,098 E*Trade rows contained **zero** OAuth entries, so a silently failing renew left no trace and the 2026-09-02 stale-token diagnosis had to be inferred. They now share the transport with `etradeGet` (so they also get the 30 s timeout that stops undici retransmitting a signed header into `oauth_problem=nonce_used`). **The asymmetry that matters: an auth FAILURE body is logged (`oauth_problem=...`, exactly what diagnosis needs) but an auth SUCCESS body is NEVER logged — it carries `oauth_token` and `oauth_token_secret` in clear text, and the log is a plaintext file with 30-day retention.** `oauth_verifier` is never logged either. `tests/etrade-auth-logging.test.ts` pins this with leak canaries.

- **A threshold anchored to the same quantity it is tested against can be structurally incapable of firing — and looks like a working check forever.** The Roll the Dice conviction "never enter above this" band was meant to enforce own-at-strike. Measured 2026-09-03: `price_high` is set from **spot on the day the row is written** (median `price_high/spot` = **1.126** across all 13 rows), while an OTM cash-secured put strikes at median **0.930** of spot. So `strike/price_high ≈ 0.83` **by construction**, and the test cannot fire until spot has risen ~21% above where the band was last written — it rejected **0 of 39** eligible picks over 62 briefs, closest margin 10%. Nobody noticed because a gate that never fires is indistinguishable from a gate nothing violates. **Two transferable rules:** (1) before trusting any threshold, compute the *ratio of the tested quantity to the threshold* over real data — if its distribution never approaches 1.0, the check is decorative; (2) a band written as "spot ± x%" is a **recency anchor, not a valuation**, and it drifts without limit as price moves (SPY and VOO now sit at the **195th percentile** of their own 52-week range — above every price they have ever traded at). Replaced by `own-at-strike.ts`, which reads the cost basis against the ticker's own SMA200 and 52-week range; that one *can* come out negative. See `docs/formulas.md#own-at-strike`. **Corollary for the v1.1.168 write-up: "we removed a protection" was wrong — the protection had never been running.**
- **A signal measured only where outcomes have matured is a sample of ONE regime, however large n looks.** The own-at-strike study had 88 usable picks — but only picks whose `expiry + 30d` had already passed are measurable, which truncated everything after early July 2026, so all 12 accept-arm episodes shared three expiries in a single ~4-week window. Two de-biasing steps are mandatory before believing any such result and both are in `scripts/own-at-strike-study.mjs`: (a) measure **excess of SPY over the identical window** (raw returns just report the tape), and (b) **collapse repeated picks of the same position into one episode** — NVDA appeared 7 times and AVGO 6 across 8 consecutive days, which is *one* move counted 13 times, and pooling lets a single stock set the headline. Here the separation survived both (and grew, 13.5 → 17.4 pts), which is why it shipped as an annotation — but under FR-SEY-5 a one-regime sample never justifies a gate, whatever the effect size.

- **A signal that looks like quality can be a risk proxy — but check WHICH one before believing it of a whole composite.** (1) LIQUIDITY: confirmed twice on independent data. v1.1.170 found the graded score's top quartile carried 50% realized vol vs 39% at the bottom; v1.1.176 reproduced it on 23,722 `analysis_snapshots` rows where the liquid subset (>=5/10) trails the illiquid one on mean (**-0.58% vs +0.73%**), median and trimmed mean alike. Liquidity tracks attention, attention tracks names that are moving, moving names breach short puts — so it belongs as a gate, never as a ranking signal. (2) THE COMPOSITE: v1.1.173 measured it anti-predictive at the top of the brief's picks (58-63 band **+1.91%**, 73+ **-4.99%**) and I attributed that to `ivRank` + `premiumYield` rewarding premium richness. **v1.1.176 refuted the attribution** — ranking the whole universe on premium richness BEATS no selection (+1.03 mean / +2.67 median), and ranking on the lowest premium is the worst rule tested. The finding stands; the mechanism was inference from weights and the worst tickers, and it was wrong. **The lesson is the shape of the error: a plausible mechanism read off a weight table is a hypothesis, and this project's data can usually test it directly — so test it before it becomes the reason for a decision.** A minimum-composite gate for wheel remains rejected (every threshold made the book monotonically worse while emptying up to 14 of 35 days), which was measured and does not depend on the refuted mechanism.
- **Before studying whether a selection rule picks well, count how often it has anything to pick between.** Roll the Dice sorts its eligible set by composite and takes the highest, and v1.1.173's finding that the composite is anti-predictive at the top made that tiebreak look like the most urgent question in the wheel path. Measured (v1.1.174): the tiebreak fires on **7 of 62** brief days, and on **27 of 34 pick-days (79%) exactly one candidate survives the gates** — there is nothing to break. The upstream gates were doing all the selecting. **A selection rule can only matter as often as it faces a choice**, and that is one cheap query — an eligible-set-size histogram — that can retire an entire study before it is written. The corollary that mattered more: the composite's real influence on the dice is the brief's top-5-of-15 cut, which `daily_briefs` cannot test because it persists only survivors. **When a ranking's quality is in question, the losers are the data you need, and pipelines habitually discard exactly those.**

- **A portfolio sync has TWO entry points and instrumenting one is not instrumenting the feature.** The scheduled `PortfolioSyncJob` and the UI's Sync button (`portfolio:etrade:sync` IPC) both end at `EtradePortfolioService.syncPortfolio`, but they reach it separately. v1.1.179 added the cash-balance snapshot to the job only; the operator pressed Sync, saw "no balance synced yet", and the API log held **zero `/balance` calls** — the feature looked broken when it had simply never been called on that path. Fixed in v1.1.180 by moving the snapshot INSIDE `syncPortfolio` itself. **General rule: when a capability must apply to every caller, put it in the function they all call, not in each call site** — patching the second one leaves the trap for the third. The same shape has bitten this project before: the earnings-date write silently suppressed three separate correction mechanisms, and the E*Trade OAuth calls sat outside the one instrumented transport for 23 versions.

## Standing instructions for AI sessions

- **No phased delivery anymore** — the app is feature-complete. Implement the requested change end-to-end: tests green, changelog + `.ai/AI_CONTEXT.md` + affected `Requirements/spec/` section updated, single Conventional Commit, then `npm run package`.
- Prefer the simplest implementation that satisfies the request. Don't add features outside scope; if one seems needed, surface it and add to `Open decisions` in `.ai/AI_CONTEXT.md`.
- Keep `.ai/AI_CONTEXT.md` accurate and lean (target < 1,500 lines). It describes current state, not history — history goes in `changelogs/`.
- When you hit a non-obvious gotcha, add it to `Known quirks` here and/or `.ai/AI_CONTEXT.md §10`.
- Announce when `npm run package` starts and finishes.
- **Validate-before-ship for trade-logic changes (FR-SEY-5).** Any change to a scoring weight/signal, an entry/exit policy parameter, or a risk-gate rule that affects *which trades the engine takes or how it sizes/exits them* must be backed by a **Brief Replay and/or Backtest delta** showing it is at worst neutral on the historical sample before it ships on the live path. A rule that can't be shown to help on the data doesn't ship enabled — it may ship **disabled** (configurable, default off) with the null/negative finding recorded. Precedent: the SPY-regime gate and overbought guard were both tested and rejected on full-year replay. See `Requirements/v2-execution/06-seykota-risk-extensions.md`.