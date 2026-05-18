import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';
import type { AnalysisMode } from '@shared/types.js';

const VALID_MODES: AnalysisMode[] = ['buy', 'options_income', 'wheel', 'bullish', 'bearish'];

export function registerAnalysisRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  const as = svc.analysisService;

  // POST /analysis/run
  app.post<{
    Body: {
      mode?: string;
      watchlistId?: number;
      tickers?: string[];
      saveSnapshot?: boolean;
    };
  }>('/analysis/run', async (req, reply) => {
    const body = req.body ?? {};
    const mode = body.mode as AnalysisMode | undefined;

    if (!mode || !VALID_MODES.includes(mode)) {
      return apiError(reply, `mode must be one of: ${VALID_MODES.join(', ')}`, 'VALIDATION_ERROR');
    }

    let tickers: string[];
    let watchlistId: number;

    if (Array.isArray(body.tickers) && body.tickers.length > 0) {
      tickers = body.tickers.map((t) => String(t).toUpperCase());
      // Use watchlistId 1 (Default) as the snapshot anchor when running ad-hoc tickers
      watchlistId = typeof body.watchlistId === 'number' ? body.watchlistId : 1;
    } else if (typeof body.watchlistId === 'number') {
      watchlistId = body.watchlistId;
      const items = svc.watchlistService.listItems(watchlistId);
      tickers = items.map((i) => i.ticker);
    } else {
      return apiError(reply, 'Provide watchlistId or a non-empty tickers array', 'VALIDATION_ERROR');
    }

    if (tickers.length === 0) {
      return apiError(reply, 'No tickers to analyze', 'NO_TICKERS');
    }

    try {
      const results = await as.analyzeWatchlist(watchlistId, tickers, mode, () => {});
      const saveSnapshot = body.saveSnapshot !== false;
      const snapshot = saveSnapshot ? as.saveSnapshot(watchlistId, mode, results) : null;

      return apiOk(reply, {
        snapshotId: snapshot?.id ?? null,
        mode,
        resultCount: results.length,
        results
      });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // GET /analysis/snapshots?watchlistId=N
  app.get<{ Querystring: { watchlistId?: string } }>('/analysis/snapshots', async (req, reply) => {
    const wlId = req.query.watchlistId ? parseInt(req.query.watchlistId, 10) : undefined;
    try {
      const snapshots = wlId !== undefined ? as.listSnapshots(wlId) : as.listSnapshots(0);
      return apiOk(reply, snapshots.map((s) => ({
        id: s.id,
        mode: s.mode,
        watchlistId: s.watchlistId,
        runAt: s.runAt,
        resultCount: s.resultCount
      })));
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // GET /analysis/snapshots/:id
  app.get<{ Params: { id: string } }>('/analysis/snapshots/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return apiError(reply, 'Invalid snapshot id', 'VALIDATION_ERROR');
    try {
      const snap = as.getSnapshot(id);
      if (!snap) return apiError(reply, 'Snapshot not found', 'NOT_FOUND', 404);
      const payload = JSON.parse(snap.payloadJson) as { results: unknown[] };
      return apiOk(reply, {
        id: snap.id,
        mode: snap.mode,
        watchlistId: snap.watchlistId,
        runAt: snap.runAt,
        resultCount: snap.resultCount,
        results: payload.results
      });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
