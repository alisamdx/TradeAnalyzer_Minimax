# Data Provider — Polygon.io mappings

> Status: skeleton. Will be filled in starting Phase 2 (screener), as endpoints are integrated.

## Provider abstraction

All market-data access flows through the `DataProvider` interface (TBD, lands in Phase 2). The Polygon implementation will sit in `src/main/providers/polygon/` and is the only adapter shipping in v1, but the interface stays slim so an alternative provider can drop in.

## Endpoint inventory (per spec §4.2.1)

| Provider call | Polygon endpoint | Where it surfaces |
| --- | --- | --- |
| Quote | `/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` | watchlist row, validation dashboard |
| Aggregates (OHLCV) | `/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from}/{to}` | candlestick chart, indicators |
| Options chain | `/v3/snapshot/options/{underlying}` | options income / wheel modes |
| Financials | `/vX/reference/financials` | screener filters, validation summary |
| Ticker details | `/v3/reference/tickers/{ticker}` | sector, market cap, share count |
| Dividends | `/v3/reference/dividends` | yield calc |
| Splits | `/v3/reference/splits` | adjusted-price math |
| Indicators | `/v1/indicators/{indicator}/{ticker}` | SMA / EMA / RSI / MACD overlays |
| Delayed WS | `wss://delayed.polygon.io` | streaming snapshot updates (deferred) |

## Index constituents

Polygon does not provide constituent lists. Resolution order:

1. **Bundled list** refreshed manually by the user (`assets/sp500.json`, `assets/russell1000.json`).
2. **Optional Wikipedia scrape** as backup, single fetch per refresh, cached 7 days.
3. **User CSV override**.

## Derived ratios (lands with Phase 2)

P/E, profit margin, ROE, debt/equity, revenue growth, EPS growth, FCF, current ratio are **computed** from `/vX/reference/financials` raw output by `src/main/services/fundamentals-computer.ts`. Each formula is documented in `formulas.md` and referenced in code via `// see docs/formulas.md#name`.

## Rate limiting

Default 100 req/min, token-bucket, configurable 10–500. On HTTP 429: halve the rate, exponential backoff for 5 min, ramp back. Lands in Phase 3 with the producer/consumer pipeline.
