import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError } from './helpers.js';

export function registerOrchestratorRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  const bs = svc.batchService;

  // POST /orchestrator/run — fire the orchestrator (manual trigger, force=false).
  // Returns immediately; progress streams via the renderer's batch:progress channel.
  app.post('/orchestrator/run', async (_req, reply) => {
    const runningId = bs.getRunningJobId();
    if (runningId !== null) {
      return apiError(reply, `A job is already running: ${runningId}`, 'ALREADY_RUNNING', 409);
    }
    // Fire-and-forget — caller polls /orchestrator/status for outcome.
    bs.runJob('batch-orchestrator', 'manual', false).catch(err =>
      console.error('[api] orchestrator/run error:', err)
    );
    return apiOk(reply, { started: true });
  });

  // GET /orchestrator/status — current running state + last run summary.
  app.get('/orchestrator/status', (_req, reply) => {
    const runningId = bs.getRunningJobId();
    const lastRun   = bs.getLastRun('batch-orchestrator');
    return apiOk(reply, {
      running:      runningId !== null,
      currentJobId: runningId,
      lastRun: lastRun ? {
        startedAt:   lastRun.startedAt,
        completedAt: lastRun.completedAt,
        status:      lastRun.status,
        trigger:     lastRun.trigger,
        slotTime:    lastRun.slotTime,
        notes:       lastRun.notes,
        errorMessage: lastRun.errorMessage,
      } : null,
    });
  });
}
