# Data Provider — Polygon.io mappings

> Status: Phase 2 implemented. DataProvider interface + Polygon implementation + Fundamentals Computer shipped.

## Provider abstraction

All market-data access flows through the `DataProvider` interface
(`src/main/services/data-provider.ts`). The Polygon implementation lives at
`src/main/services/polygon-provider.ts`. A future provider drop-in is a single-class swap.

## Endpoint inventory (per spec §4.2.1)

| Provider call | Polygon endpoint | Status |
| --- | --- | --- |
| Quote | `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` | ✓ Implemented |
| Fundamentals | `/vX/reference/financials` + `/v3/reference/tickers/{ticker}` | ✓ Implemented via fundamentals-computer |
| Aggregates (OHLCV) | `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}` | ✓ Implemented |
| Options chain | `/v3/snapshot/options/{underlying}` | ✓ Implemented |
| Earnings calendar | — | Stub (null); Polygon has no public endpoint |
| Ticker details | `/v3/reference/tickers/{ticker}` | ✓ Bundled in getFundamentals |
| Dividends | `/v3/reference/dividends` | Not called in Phase 2 |
| Splits | `/v3/reference/splits` | Not called in Phase 2 |
| Indicators | `/v1/indicators/{indicator}/{ticker}` | Phase 4 |
| Delayed WS | `wss://delayed.polygon.io` | Phase 3 (pipeline) |

## Index constituents

Polygon does not provide constituent lists. Resolution order:

1. **Bundled CSV** at `src/main/assets/constituents/sp500.csv` / `russell1000.csv` — bootstrap on first run.
2. **SQLite cache** (7-day TTL via `constituents_meta` table) — refreshed from bundled or Wikipedia.
3. **Wikipedia scrape** — triggered by user's ↻ button, single fetch, cached 7 days.
4. **User CSV import** via Settings dialog.

Implementation: `src/main/services/constituents-service.ts`.

## Rate limiting

Default 100 req/min, token-bucket. On HTTP 429: halve the rate, exponential backoff 5 min, ramp back.
Implemented by the producer/consumer pipeline (Phase 3). PolygonDataProvider makes raw calls with a simple 3× retry on 5xx.

## Logging

Every Polygon call is logged to `logs/api/api_YYYY-MM-DD.jsonl` (EP-3) with: timestamp, endpoint, HTTP status, latency ms, retry count, bytes. API keys are scrubbed at write time. No other network calls are made outside this service.

## Credentials

`POLYGON_API_KEY` is loaded from `.env` at startup. Never logged. Never sent anywhere except `api.polygon.io`.
