# 22 — TraderAgent Integration & Local API Server

Two integration surfaces with an **external autonomous trading agent** ("TraderAgent"): a read/run UI inside TradeAnalyzer, and a local HTTP API the agent calls to reuse TradeAnalyzer's intelligence.

---

## Part A — Agent view

Service: `agent-db-service.ts` (opens the TraderAgent SQLite **read-only**). IPC: `window.api.agent.*`. View: `AgentView.tsx` (🤖 Agent). Settings hold `agentDbPath` + `agentProjectPath`. Native learnings persist in `agent_trade_learnings` (§2.17).

### 22.A.1 Tabs
- **Overview / Dashboard** — `getDashboard()` returns a live `AgentDashboard` computed from open positions: count, capital deployed, win rate, total P&L, estimated daily theta, avg IV/delta/DTE. Plus ML-weight snapshot from the agent DB when present. Works from day one with only open positions.
- **Trades** — filterable open/closed/all (`getTrades`), with Close (`closeTrade`) and Delete (`deleteTrade`) actions and per-row navigation (Analysis/Validate/Options).
- **Lessons** — agent DB lessons (`getLessons`) plus **native** lessons computed by TradeAnalyzer (`getNativeLessons`: expiry risk, IV collapse, strike breach, pattern) and theory checks (`getTheoryChecks`).
- **Recommendations** — live actionable recs (`getLiveRecommendations`: Close Now / Roll / Defend / New Entry) with severity badges + drill-in, plus agent DB recs (`getRecommendations`).
- **Actions** — full action list derived from open positions (DTE urgency, ITM/near-strike risk, premium-captured close), severity-coded.
- **Run phase** — `runPhase(phase, projectPath)` spawns the agent CLI and streams stdout/stderr (`onLog`, `onPhaseDone`).

### 22.A.2 Strategy config
The agent's strategies are configured in-app: `AgentStrategy` (name, id, description, screeningMode, screenerUniverse, DTE/delta/IV/OI/return params). `AgentStrategiesState` tracks the active strategy + list. CRUD via `listStrategies`, `saveStrategy`, `deleteStrategy`, `setActiveStrategy`; persisted as JSON in settings and exported to `.env` for the agent CLI. The active strategy's params are used when running a phase.

### 22.A.3 Trade learnings
`captureTradeLearning(trade)` runs Claude (`claude-haiku-4-5`) on a closed agent trade and stores a learning note (`agent_trade_learnings`, one per `agent_trade_id`). `getTradeLearnings()` lists them. Config read/write (`readConfig`/`writeConfig`) and `sendPositionsEmail(projectPath)` round out the surface.

---

## Part B — Local HTTP API server

Service: `api-server.ts` (Fastify). Route modules in `src/main/api/`. Runs on `127.0.0.1:7432` (configurable).

### 22.B.1 Auth & lifecycle
- Token auth: a token file at `~/.tradeanalyzer/agent.token`; the chosen port is written to `~/.tradeanalyzer/api.port`.
- A headless mode (`TRADEANALYZER_HEADLESS=1`) runs the API without the UI.
- On startup it also writes `etrade-config.json` (consumer creds for the SSH login scripts) and imports any `etrade-tokens-pending.json`.
- Uniform response contract: `{ ok, data | error }`.

### 22.B.2 Routes
Route modules cover all service groups: health, watchlists, screener, analysis, validation, options, quotes, fundamentals, jobs, settings, etrade. Two intelligence routes the agent depends on:
- **`GET /api/v1/strategy-lab/:ticker`** — runs Strategy Lab (§09), returns all 31 scored strategies + per-category recommendations (`bestOverall`, `bestIncome`, `bestBullish`, `bestBearish`). The agent calls this in its decide phase instead of always defaulting to CSP/CC.
- **`POST /api/v1/critic/evaluate`** — accepts a candidate pick payload and returns a `CriticVerdict` (§14.3). The agent blocks entry on `flag`, warns on `caution`.
- **`GET /api/v1/analysis/snapshots/latest?mode=<mode|all>`** — newest `analysis_snapshots` row of a mode across **all** watchlists, including the global (`watchlist_id NULL`) rows batch jobs write, which `GET /analysis/snapshots?watchlistId=N` can never return. Response shape matches `/analysis/snapshots/:id`; 404 `NOT_FOUND` when none exists. Exists so scripts read the live panel through the app rather than opening the SQLite file (v1.1.220).
- **Diagnostics routes** (read by scripts so nothing opens a SQLite file from a shell): `GET /api/v1/diagnostics/day?date=` (`scripts/day-report.mjs`, v1.1.245); `GET /api/v1/diagnostics/pick-greeks?from=&to=` (`scripts/pick-greek-audit.mjs`, v1.1.252); `GET /api/v1/diagnostics/settled-csp-panel?strategy=income|wheel` (`scripts/fr-income-liquidity-realized-ab.mjs`, v1.1.267) — every stored CSP recommendation with a settlement close, its bid/ask/OI, IV rank, annualized return, and the realized vol **as of its own date by the live `recentVolatility` rule** (`services/settled-csp-panel.ts`, checked against `ScoringService` in its tests); that script used to open `trade-analyzer.sqlite` itself through a redirected `%APPDATA%`; **`POST /api/v1/diagnostics/generation-snapshot`** (v1.1.256) — a consistent copy of the TradeAnalyzer 2 generation taken with `VACUUM INTO` on the app's own connection, into `~/.tradeanalyzer/rehearsal/gen-NNN-<ET stamp>.sqlite` (five newest kept). Refused with 409 while a collector job runs. Consumed by `packages/core/scripts/rehearse-gate.mjs`. Also `GET /api/v1/diagnostics/premium-roc?strategy=income|wheel` (`scripts/premium-roc-report.mjs`, v1.1.336 — every stored CSP settled on real premium, with Brief Replay's proxy beside it) and `GET /api/v1/diagnostics/spread-study-panel?strategy=wheel&quotes=1` (`scripts/fr-bull-put-spread-study.mjs`, v1.1.338 — replay picks, their bars and `iv_history`, and with `quotes=1` the three quote sources; an unreadable quote table is `null`, never `[]`).
- E*Trade helper routes: `GET /api/v1/etrade/credentials`, `POST /api/v1/etrade/token` — let a remote SSH session complete the OAuth flow and push tokens into the running app (`scripts/etrade-login.mjs`, two-step verifier flow).
- **`GET /api/v1/options/:ticker`** — when called without an explicit `expiration`, the route guesses the next 8 weekly **Friday** expirations and fetches each chain. This date math MUST be computed entirely in UTC: a local-weekday/UTC-serialization mix shifts every guessed date to Saturday on evening runs (local clock past UTC midnight), which silently returns an empty chain because E\*Trade lists Friday expirations only. (Fixed v1.1.47 — had starved the agent of contracts for ~10 days.)

### 22.B.3 Remote token refresh
Because E*Trade tokens expire at midnight ET, a non-interactive two-step script flow (`etrade-step1.mjs` prints the auth URL + saves state; `etrade-step2.mjs <verifier>` completes the exchange) lets the user re-auth from a phone/SSH without a desktop TTY.
