import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';
import { DEFAULT_FILTER_SPECS } from '../services/screener-service.js';
import type { ScreenCriteria, FilterDef, Universe } from '@shared/types.js';

function buildDefaultFilters(): FilterDef[] {
  return DEFAULT_FILTER_SPECS.filter((f) => f.defaultEnabled).map((f) => ({
    id: f.id,
    enabled: true,
    value: [f.defaultMin, f.defaultMax] as [number, number]
  }));
}

export function registerScreenerRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  const ss = svc.screenerService;

  // GET /screener/presets
  app.get('/screener/presets', async (_req, reply) => {
    try {
      return apiOk(reply, ss.listPresets());
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // GET /screener/presets/:id
  app.get<{ Params: { id: string } }>('/screener/presets/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return apiError(reply, 'Invalid preset id', 'VALIDATION_ERROR');
    try {
      const presets = ss.listPresets();
      const preset = presets.find((p) => p.id === id);
      if (!preset) return apiError(reply, 'Preset not found', 'NOT_FOUND', 404);
      return apiOk(reply, preset);
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // POST /screener/run
  app.post<{
    Body: {
      universe?: string;
      mode?: string;
      topN?: number;
      filters?: FilterDef[];
    };
  }>('/screener/run', async (req, reply) => {
    const body = req.body ?? {};
    const universe = (body.universe ?? 'sp500') as Universe;
    const mode = (body.mode ?? 'strict') as 'strict' | 'soft';
    const topN = typeof body.topN === 'number' ? body.topN : undefined;
    const filters: FilterDef[] = Array.isArray(body.filters) ? body.filters : buildDefaultFilters();

    if (!['sp500', 'russell1000', 'both'].includes(universe)) {
      return apiError(reply, 'universe must be sp500, russell1000, or both', 'VALIDATION_ERROR');
    }
    if (!['strict', 'soft'].includes(mode)) {
      return apiError(reply, 'mode must be strict or soft', 'VALIDATION_ERROR');
    }

    const criteria: ScreenCriteria = { universe, mode, filters };

    try {
      const output = await ss.runScreen(criteria);
      const runResult = ss.saveRun(criteria, universe, output.rows);
      let rows = ss.getResults(runResult.id);
      if (topN !== undefined && topN > 0) {
        rows = rows.slice(0, topN);
      }
      return apiOk(reply, { runId: runResult.id, resultCount: rows.length, rows });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
