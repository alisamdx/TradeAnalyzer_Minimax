import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

export function registerQuotesRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // POST /quotes  { tickers: string[] }
  app.post<{ Body: { tickers?: string[] } }>('/quotes', async (req, reply) => {
    const tickers = req.body?.tickers;
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return apiError(reply, 'tickers array is required', 'VALIDATION_ERROR');
    }

    const normalized = tickers.map((t) => String(t).toUpperCase());
    const results: unknown[] = [];

    for (const ticker of normalized) {
      // Serve from cache if fresh
      const cached = svc.quoteCache.get(ticker);
      if (cached && !svc.quoteCache.isStale(ticker)) {
        results.push({
          ticker,
          last: cached.last,
          dayChangePct: cached.last !== null && cached.prevClose !== null && cached.prevClose !== 0
            ? ((cached.last - cached.prevClose) / cached.prevClose) * 100
            : null,
          volume: cached.volume,
          ivRank: cached.ivRank,
          fetchedAt: cached.fetchedAt
        });
        continue;
      }

      try {
        const quote = await svc.dataProvider.getQuote(ticker);
        svc.quoteCache.upsert({ ...quote, currentIv: (quote as { currentIv?: number | null }).currentIv ?? null, fetchedAt: new Date().toISOString() });
        results.push({
          ticker,
          last: quote.last,
          dayChangePct: quote.last !== null && quote.prevClose !== null && quote.prevClose !== 0
            ? ((quote.last - quote.prevClose) / quote.prevClose) * 100
            : null,
          volume: quote.volume,
          ivRank: quote.ivRank,
          fetchedAt: new Date().toISOString()
        });
      } catch {
        results.push({ ticker, last: null, dayChangePct: null, volume: null, ivRank: null, fetchedAt: null, error: 'FETCH_FAILED' });
      }
    }

    return apiOk(reply, results);
  });
}
