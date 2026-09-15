import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError } from './helpers.js';
import { buildDayReport, etDate, isIsoDate } from '../services/day-diagnostics.js';

export function registerDiagnosticsRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // GET /diagnostics/day?date=YYYY-MM-DD — everything recorded about one ET day: batch runs,
  // the errors log, a summary of the API log, and the TradeAnalyzer 2 collector's runs, gate
  // report and email status. Defaults to today. Read by scripts/day-report.mjs.
  app.get<{ Querystring: { date?: string } }>('/diagnostics/day', async (req, reply) => {
    const diagnostics = svc.diagnostics;
    if (!diagnostics) return apiError(reply, 'Diagnostics are not wired in this build', 'UNAVAILABLE', 503);
    const date = req.query.date ?? etDate(new Date().toISOString());
    if (!isIsoDate(date)) return apiError(reply, 'date must be YYYY-MM-DD', 'VALIDATION_ERROR');
    try {
      const report = await buildDayReport(
        { batchDb: svc.db, logsDir: diagnostics.logsDir, readCollectorDay: diagnostics.readCollectorDay },
        date
      );
      return apiOk(reply, report);
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });
}
