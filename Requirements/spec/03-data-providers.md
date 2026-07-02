# 03 — Data Providers & Integrations

All external data is reached through **interfaces**, so any provider is a single-class swap and is mockable in tests (NFR-8). The renderer never calls a provider — only the main process does, behind IPC.

## 3.1 Provider responsibilities

| Provider | Responsible for | Required |
| --- | --- | --- |
| **Polygon.io** (Stocks Starter) | Stock quotes, fundamentals (computed from raw financials), historical OHLCV bars, financial statements, news headlines | Yes |
| **E*Trade** (OAuth 1.0a) | Options chains, per-contract Greeks/IV, expirations, earnings date (via quote), portfolio positions, transaction history | Yes — the **active default** options + portfolio source |
| **MarketData.app** | Historical 30-day ATM IV for IV-history backfill | Optional |
| **IVolatility** | Alternative IV-history source (IVX surface) | Optional |
| **Anthropic Claude** | AI synthesis: daily brief, critic, portfolio advisor, news, strategy-lab rationale, payoff assessment | Optional (AI features degrade gracefully) |
| **SEC EDGAR** | Insider transactions (Form 4) for News & Research | Optional (public, unauthenticated) |

The options provider is selected by the `optionsProvider` setting (`'polygon' | 'etrade'`), read once at startup and injected into the services that need it (`AnalysisService`, `LeapsCspService`, `CollaredLeapsService`, options IPC). Changing it requires a restart. **E*Trade is the default** (the Polygon Options Starter subscription was cancelled). The `DataProvider` (quotes/fundamentals/bars) is always Polygon.

## 3.2 `DataProvider` interface

Defined in `data-provider.ts`; Polygon implementation in `polygon-provider.ts`.

```ts
interface DataProvider {
  getQuote(ticker): Promise<QuoteSnapshot>;            // last, bid, ask, volume, day range, prev close
  getFundamentals(ticker): Promise<DerivedRatios>;     // P/E, EPS, ROE, D/E, margin, FCF, growth, beta, sector…
  getEarningsCalendar(ticker): Promise<EarningsInfo>;  // null from Polygon — see §17 for the real source
  getHistoricalBars(ticker, timeframe, lookback): Promise<HistoricalBar[]>;  // OHLCV
  getOptionsChain(ticker, expiration): Promise<OptionsChain>;
  getIndexConstituents(index): Promise<ConstituentRow[]>; // no-op — ConstituentsService owns this
  ping(): Promise<boolean>;
}
```

### Polygon endpoints used
- Tickers / details: `/v3/reference/tickers`, `/v3/reference/tickers/{ticker}` (name, sector, market cap, shares).
- Aggregates (OHLCV): `/v2/aggs/ticker/{ticker}/range/{mult}/{span}/{from}/{to}`.
- Snapshot: `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}`.
- Options snapshot: `/v3/snapshot/options/{underlying}` (used only when `optionsProvider='polygon'`).
- News: `/v2/reference/news?ticker={ticker}`.
- Dividends / splits: `/v3/reference/dividends` (TTM dividend yield numerator, v0.32.84), `/v3/reference/splits`.
- WebSocket (delayed): `wss://delayed.polygon.io` for optional live price ticker.

> **Financial statements do NOT come from Polygon** (v0.32.79): `/vX/reference/financials`
> requires a Developer plan. `getFundamentals()` sources statements from **SEC EDGAR XBRL**
> (`sec-edgar-provider.ts`, see §3.3) and keeps Polygon for ticker details, snapshot price,
> and dividends.

### Important Polygon facts
- **IV rank / IV percentile are null** from the snapshot endpoint — computed separately from `iv_history` (§11).
- **No public earnings calendar** — earnings come from E*Trade (§17).
- `getIndexConstituents` is a **no-op**; constituents are loaded from bundled CSVs + the `constituents` table by `ConstituentsService`.

## 3.3 Fundamentals pipeline (SEC EDGAR + computer)

Financial statements come from the free **SEC EDGAR XBRL API** (`sec-edgar-provider.ts`, v0.32.79+):
- CIK resolution via `company_tickers.json` (cached per process); facts via `companyfacts/CIK{padded10}.json`. No API key; `User-Agent` header required; 10 req/s limit. OTC/foreign tickers absent from the SEC list are skipped (fundamentals null).
- Per field role, candidate US-GAAP concepts are ranked by **most-recent annual date wins** (handles ASC-606-style concept transitions). The depreciation role additionally has a **composite fallback** (`compositeEntries`, v0.32.86): when no combined D&A concept is current, `Depreciation` + `AmortizationOfIntangibleAssets` + `FinanceLeaseRightOfUseAssetAmortization` are summed per exact reporting period (modern filers tag the parts separately; the combined line often lives in extension namespaces invisible to us-gaap).
- `annualSeries()` dedupes 10-K comparative re-reports by period end (latest filed wins; restatements honored) and drops non-annual durations — without this, "5 years ago" lands on FY-2 (v0.32.80).
- `ttmPair()` builds **true TTM**: FY + current 10-Q YTD − prior-year same-period YTD; the YoY denominator rolls the same way with the two-years-back comparative. TTM only when the full quarterly chain exists, else a consistent FY pair (v0.32.83).
- Output is translated into the legacy `PolygonFinancials` filings shape: slot 0 = current TTM + most-recent balance sheet, slot 4 = prior TTM, slot 16 = 5-years-ago annual (CAGR base), 20 slots total.

`fundamentals-computer.ts` then derives all ratios (it does **not** trust any pre-computed provider ratio). Outputs `DerivedRatios`: P/E, EPS, profit margin, ROE, D/E (financial sector exempt → null), revenue growth YoY, EPS growth YoY, FCF (= op CF − |capex|, capex from EDGAR), current ratio, plus quality signals (ROIC, FCF-to-net-income, net-debt-to-EBITDA, 5Y revenue/EPS CAGR, value/growth/grade scores), **dividend yield** (TTM regular cash dividends / price, Polygon dividends endpoint, v0.32.84), **beta** (1Y daily vs SPY from local `historical_prices`, `beta-service.ts`, v0.32.84), sector, industry, market cap. Every formula is written out in §23. Results are cached 24h in `fundamentals_cache`.

## 3.4 `OptionsProvider` interface

Defined in `options-provider.ts`. Implemented by both `PolygonDataProvider` and `ETradeDataProvider`.

```ts
interface OptionsProvider {
  getOptionsExpirations(ticker): Promise<string[]>;   // Polygon returns [] → callers fall back to generated Fridays
  getOptionsChain(ticker, expiration): Promise<OptionsChain>;
  getOptionsIV(ticker): Promise<number | null>;
  getOptionsIVAndPremium(ticker, …): Promise<…>;
}
```

`OptionContract` (a chain row) carries: `symbol`, `osiKey`, `optionType` (CALL|PUT), `strike`, `bid`, `ask`, `bidSize`, `askSize`, `lastPrice`, `volume`, `openInterest`, `inTheMoney`, Greeks `{ delta, gamma, theta, vega, rho, iv }`, and `hasGreeks` / `hasBidAsk` flags.
- **`OptionContract.iv` is a decimal fraction** (0.38 = 38%). Used directly as sigma in Black-Scholes. When persisting to a percentage column, multiply by 100.

## 3.5 E*Trade integration (OAuth 1.0a)

E*Trade is the live options + portfolio source. Implemented in `etrade-auth.ts` (signing + flow), `etrade-data-provider.ts` (`OptionsProvider`), `etrade-options.ts` (chain parsing), `etrade-portfolio-service.ts` (accounts/positions/transactions).

### Auth flow
1. User saves **consumer key + secret** (encrypted via `secure-settings.ts`).
2. `startAuth()` → request token → returns an authorization URL the user opens in a browser.
3. User authorizes, receives a **verifier code**, submits it via `submitVerifier(code)` → access token + secret obtained.
4. Tokens are stored encrypted.

### Token lifecycle (critical)
- Tokens **expire at midnight ET**. After ~2h of inactivity they go **dormant** (E*Trade returns `oauth_problem=token_rejected`) → call `renewAccessToken()` to reactivate. **The renew endpoint is `/oauth/renew_access_token` — NOT `/v1/oauth/...`** (the `/v1/` prefix is only for market/accounts APIs). It was wrong until v1.1.99, so renewal silently failed and dormant tokens never auto-revived; the mocked renew tests couldn't catch it (`tests/etrade-renew-endpoint.test.ts` now asserts the real URL).
- A **date-based** `checkConnection()` returns `ok | no_credentials | no_token | expired` with **no API call** (compares token issue date to current ET date).
- Batch jobs attempt `renewToken()` on auth failure; a hard (midnight) expiry surfaces a "Reconnect → Settings" notification.
- **All requests go through `etradeGet(path, params, creds)`** which builds the OAuth 1.0a signature. Never construct auth headers by hand.

### E*Trade endpoints
- Quote: `GET /v1/market/quote/{symbol}?detailFlag=ALL` — full field set. With `requireEarningsDate=true`, the `All.nextEarningDate` field is populated (`MM/DD/YYYY`); without it, that field is `""`.
- Option chains: `GET /v1/market/optionchains` with `includeGreeks=true` (Greeks/IV otherwise absent).
- Expirations: `GET /v1/market/optionexpiredate`.
- Accounts / positions / transactions: `GET /v1/accounts/...`, `/v1/accounts/{id}/transactions` (paginated, marker-based) for closed-position sync.

### E*Trade data quirks (must handle)
- **IV is a decimal fraction** (0.3882 = 38.82%) — `×100` when ingesting to a percentage store.
- **Chain underlying price** is in `OptionChainResponse.nearPrice`, **not** `currentPrice`.
- **Dates are UTC.** A company reporting after ET close (Thursday evening) appears as **Saturday UTC** → the earnings service shifts Saturday→Friday and marks the date unconfirmed (§17).
- Greeks/IV are missing pre-market/post-market for some contracts → callers fall back to delta-by-moneyness or a default IV.

## 3.6 IV-history providers

- **MarketData.app** (`marketdata-provider.ts`) — historical option chains for a date or live (`?expiration=`). Dedicated 50 RPM limiter. Parses parallel-array JSON. Primary IV-history backfill source.
- **IVolatility** (`ivolatility-provider.ts`) — IVX surface (iv7…iv360) per date. Alternative source, surfaced in the Test API screen.

Both feed `iv-history-service.ts`, which computes 30-day constant-maturity ATM IV and stores it in `iv_history` (§11). The app also **silently captures** today's IV from any E*Trade chain fetch (no extra API call) via `captureFromEtradeChain()`.

## 3.7 Anthropic Claude

Used directly via `@anthropic-ai/sdk` in each AI service. The key is stored encrypted; if absent, every AI feature degrades to a rule-only path (no crash). Models currently used:
- `claude-opus-4-7` — Portfolio Advisor, Payoff "Assess Trade".
- `claude-haiku-4-5` — Daily Brief synthesis, AI Critic, News synthesis, Strategy-Lab rationale, paper-trade learning capture.

AI prompts must instruct Claude to **never invent financial figures** — only reference values provided in the prompt, and flag missing inputs.

## 3.8 SEC EDGAR

Public, unauthenticated full-text search for Form 4 insider transactions, used by `news-data-fetcher.ts` for the News & Research dossier (§16). Fields: filer name/title, transaction type (buy/sell), shares, price, total value, filing date.

## 3.9 Rate limiting & retry

- **`TokenBucketRateLimiter`** (`rate-limiter.ts`): configurable 10–500 req/min (default 100). Token-bucket, not fixed sleep. On HTTP 429: halve the rate, exponential backoff ~5 min, then ramp back; surface in the UI status bar (NFR-6).
- **All Polygon traffic must pass through the limiter** — no ad-hoc `fetch` anywhere else.
- **Retry with backoff**: 3 attempts on transient/connection errors; after 5 consecutive connection failures a batch run auto-pauses and prompts (§07/§24).
- E*Trade and MarketData.app each have their own respectful pacing (E*Trade's ~250ms natural latency is itself a soft limiter; batch jobs add a configurable `callDelayMs`).

## 3.10 Producer/consumer pipeline

Long runs (Validate All, Screen Run, large analysis/snapshot jobs) use a two-stage decoupled pipeline backed by `job_runs` + `job_progress`:
- **Fetcher** pulls one-ticker jobs from a queue, calls the provider (rate-limited), pushes raw responses to a result queue. Does not write the DB.
- **Persister** pulls raw responses, parses, computes derived fields, writes SQLite. Independent of the fetch loop.
- **UI coordinator** subscribes to progress events (queued/fetched/persisted/failed) and can pause/resume/cancel.

Properties: every persisted ticker is marked complete, so a stopped run **resumes** from the remainder; partial data is fully usable (with a "partial" badge); Stop is graceful (in-flight requests finish and persist). Acceptance criteria in §24.

## 3.11 Caching summary (NFR-3)

| Data | TTL | Store |
| --- | --- | --- |
| Fundamentals | 24h | `fundamentals_cache` |
| Quotes | 60s (configurable) | `quote_cache` |
| Options chains | 5 min | `options_cache` |
| Constituents | 7 days (manual refresh) | `constituents` + `constituents_meta` |

All TTLs, the rate limit, and batch size are configurable in Settings.
