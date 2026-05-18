import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

export function registerFundamentalsRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // GET /fundamentals/:ticker?refresh=true
  app.get<{ Params: { ticker: string }; Querystring: { refresh?: string } }>(
    '/fundamentals/:ticker',
    async (req, reply) => {
      const ticker = req.params.ticker.toUpperCase();
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
        return apiError(reply, 'Invalid ticker symbol', 'VALIDATION_ERROR');
      }

      const forceRefresh = req.query.refresh === 'true';

      try {
        // Try cache first (unless force refresh)
        if (!forceRefresh) {
          const cached = svc.fundamentalsCache.get(ticker);
          if (cached && !svc.fundamentalsCache.isStale(ticker)) {
            return apiOk(reply, { ticker, fetchedAt: cached.fetchedAt, fromCache: true, ...cached.ratios });
          }
        }

        const ratios = await svc.dataProvider.getFundamentals(ticker);
        svc.fundamentalsCache.upsert(ticker, ratios);
        return apiOk(reply, {
          ticker,
          fetchedAt: new Date().toISOString(),
          fromCache: false,
          ...ratios
        });
      } catch (err) {
        const { message, code } = fromServiceError(err);
        return apiError(reply, message, code, 500);
      }
    }
  );
}
