import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

export function registerWatchlistRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  const ws = svc.watchlistService;

  // GET /watchlists
  app.get('/watchlists', async (_req, reply) => {
    try {
      const lists = ws.list();
      return apiOk(reply, lists);
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // POST /watchlists  { name: string }
  app.post<{ Body: { name?: string } }>('/watchlists', async (req, reply) => {
    const { name } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return apiError(reply, 'name is required', 'VALIDATION_ERROR');
    }
    try {
      const wl = ws.create(name);
      return reply.code(201).send({ ok: true, data: wl });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, code === 'NAME_TAKEN' ? 409 : 400);
    }
  });

  // GET /watchlists/:id/tickers
  app.get<{ Params: { id: string } }>('/watchlists/:id/tickers', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return apiError(reply, 'Invalid watchlist id', 'VALIDATION_ERROR');
    try {
      ws.get(id); // throws NOT_FOUND if missing
      const items = ws.listItems(id);
      return apiOk(reply, items);
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, code === 'NOT_FOUND' ? 404 : 400);
    }
  });

  // POST /watchlists/:id/tickers  { tickers: string[] }
  app.post<{ Params: { id: string }; Body: { tickers?: string[] } }>(
    '/watchlists/:id/tickers',
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return apiError(reply, 'Invalid watchlist id', 'VALIDATION_ERROR');
      const tickers = req.body?.tickers;
      if (!Array.isArray(tickers) || tickers.length === 0) {
        return apiError(reply, 'tickers array is required', 'VALIDATION_ERROR');
      }
      try {
        const result = ws.addItemsBulk(id, tickers.map((t) => ({ ticker: String(t).toUpperCase() })));
        return apiOk(reply, {
          added: result.added.length,
          skipped: result.skipped
        });
      } catch (err) {
        const { message, code } = fromServiceError(err);
        return apiError(reply, message, code, code === 'NOT_FOUND' ? 404 : 400);
      }
    }
  );

  // DELETE /watchlists/:id/tickers  { tickers: string[] }
  app.delete<{ Params: { id: string }; Body: { tickers?: string[] } }>(
    '/watchlists/:id/tickers',
    async (req, reply) => {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return apiError(reply, 'Invalid watchlist id', 'VALIDATION_ERROR');
      const tickers = req.body?.tickers;
      if (!Array.isArray(tickers) || tickers.length === 0) {
        return apiError(reply, 'tickers array is required', 'VALIDATION_ERROR');
      }
      try {
        // Get item IDs for the provided tickers
        const items = ws.listItems(id);
        const tickerSet = new Set(tickers.map((t) => String(t).toUpperCase()));
        const ids = items.filter((i) => tickerSet.has(i.ticker)).map((i) => i.id);
        if (ids.length > 0) ws.removeItems(id, ids);
        return apiOk(reply, { removed: ids.length });
      } catch (err) {
        const { message, code } = fromServiceError(err);
        return apiError(reply, message, code, code === 'NOT_FOUND' ? 404 : 400);
      }
    }
  );
}
