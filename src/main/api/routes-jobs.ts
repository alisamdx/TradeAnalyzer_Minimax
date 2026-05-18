import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

export function registerJobsRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  const jq = svc.jobQueue;

  // POST /jobs  { type: "validate_all", watchlistId: number, config: {} }
  app.post<{ Body: { type?: string; watchlistId?: number; config?: Record<string, unknown> } }>(
    '/jobs',
    async (req, reply) => {
      const { type, watchlistId, config } = req.body ?? {};

      if (type !== 'validate_all') {
        return apiError(reply, 'type must be validate_all', 'VALIDATION_ERROR');
      }
      if (typeof watchlistId !== 'number') {
        return apiError(reply, 'watchlistId is required', 'VALIDATION_ERROR');
      }

      try {
        const items = svc.watchlistService.listItems(watchlistId);
        if (items.length === 0) return apiError(reply, 'Watchlist has no tickers', 'NO_TICKERS');

        const tickers = items.map((i) => i.ticker);
        // validateWatchlist internally enqueues the job synchronously before its first await.
        // Start it fire-and-forget, then read the ID it created.
        svc.validateAllService.resetCancel();
        svc.validateAllService.validateWatchlist(watchlistId, tickers).catch(console.error);
        // The enqueue is synchronous, so the job row exists by this point.
        const recentJobs = jq.listRuns('validate_all', 1);
        const jobRunId = recentJobs[0]?.id ?? -1;

        return reply.code(201).send({ ok: true, data: { jobRunId } });
      } catch (err) {
        const { message, code } = fromServiceError(err);
        return apiError(reply, message, code, 500);
      }
    }
  );

  // GET /jobs — list recent jobs (last 10)
  app.get('/jobs', async (_req, reply) => {
    try {
      const jobs = jq.listRuns(undefined, 10);
      return apiOk(reply, jobs);
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // GET /jobs/:id
  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return apiError(reply, 'Invalid job id', 'VALIDATION_ERROR');
    try {
      const job = jq.getRun(id);
      if (!job) return apiError(reply, 'Job not found', 'NOT_FOUND', 404);
      const stats = jq.getRunStats(id);
      const failedTickers = jq.getProgress(id)
        .filter((p) => p.status === 'failed')
        .map((p) => ({ ticker: p.ticker, error: p.errorMsg }));
      return apiOk(reply, { ...job, ...stats, failedTickers });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // POST /jobs/:id/stop
  app.post<{ Params: { id: string } }>('/jobs/:id/stop', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return apiError(reply, 'Invalid job id', 'VALIDATION_ERROR');
    try {
      svc.validateAllService.cancel();
      jq.stopRun(id);
      return apiOk(reply, { jobRunId: id, status: 'stopped' });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });

  // POST /jobs/:id/resume
  app.post<{ Params: { id: string } }>('/jobs/:id/resume', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return apiError(reply, 'Invalid job id', 'VALIDATION_ERROR');
    try {
      const job = jq.getRun(id);
      if (!job) return apiError(reply, 'Job not found', 'NOT_FOUND', 404);
      if (job.type !== 'validate_all' || !job.watchlistId) {
        return apiError(reply, 'Only validate_all jobs with a watchlistId can be resumed', 'UNSUPPORTED');
      }

      const pendingTickers = jq.getPendingTickers(id);
      if (pendingTickers.length === 0) {
        return apiError(reply, 'No pending tickers — job may already be complete', 'NO_PENDING');
      }

      svc.validateAllService.resetCancel();
      jq.resumeRun(id);
      // Fire and forget
      svc.validateAllService
        .validateWatchlist(job.watchlistId, pendingTickers)
        .catch(console.error);

      return apiOk(reply, { jobRunId: id, status: 'running', pendingCount: pendingTickers.length });
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
