import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError } from './helpers.js';
import { buildDayReport, etDate, isIsoDate } from '../services/day-diagnostics.js';
import { auditPickGreeks, type PickAuditDb } from '../services/greek-consistency.js';
import {
  settledCspPanel, PANEL_STRATEGIES, type PanelDb, type PanelStrategy
} from '../services/settled-csp-panel.js';

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

  // GET /diagnostics/pick-greeks?from=YYYY-MM-DD&to=YYYY-MM-DD — how many stored brief candidates
  // were chosen on an E*Trade delta that disagrees with the spot stored beside them. Read-only.
  // Read by scripts/pick-greek-audit.mjs. see greek-consistency.ts
  app.get<{ Querystring: { from?: string; to?: string } }>('/diagnostics/pick-greeks', async (req, reply) => {
    const to = req.query.to ?? etDate(new Date().toISOString());
    const from = req.query.from ?? '2026-01-01';
    if (!isIsoDate(from) || !isIsoDate(to)) return apiError(reply, 'from and to must be YYYY-MM-DD', 'VALIDATION_ERROR');
    try {
      return apiOk(reply, auditPickGreeks(svc.db as unknown as PickAuditDb, from, to));
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });

  // GET /diagnostics/settled-csp-panel?strategy=income|wheel — every stored CSP recommendation that
  // has a settlement close, with bid/ask/OI, IV rank, annualized return and the live-rule realized
  // vol as of its date. Read-only. Read by scripts/fr-income-liquidity-realized-ab.mjs, which used to
  // open the SQLite file itself through a redirected %APPDATA%. see settled-csp-panel.ts
  app.get<{ Querystring: { strategy?: string } }>('/diagnostics/settled-csp-panel', async (req, reply) => {
    const strategy = (req.query.strategy ?? 'income') as PanelStrategy;
    if (!PANEL_STRATEGIES.includes(strategy)) {
      return apiError(reply, `strategy must be one of ${PANEL_STRATEGIES.join(', ')}`, 'VALIDATION_ERROR');
    }
    try {
      return apiOk(reply, settledCspPanel(svc.db as unknown as PanelDb, strategy));
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });

  // POST /diagnostics/generation-snapshot — a consistent copy of the TradeAnalyzer 2 generation
  // (VACUUM INTO, on the app's own connection) under ~/.tradeanalyzer/rehearsal, for
  // packages/core/scripts/rehearse-gate.mjs. Lets a gate fix be checked against today's data within
  // minutes, with both apps open. see services/generation-snapshot.ts
  app.post('/diagnostics/generation-snapshot', async (_req, reply) => {
    const take = svc.diagnostics?.snapshotGeneration;
    if (!take) return apiError(reply, 'Generation snapshots are not wired in this build', 'UNAVAILABLE', 503);
    try {
      const result = take();
      if ('unavailable' in result) return apiError(reply, result.unavailable, 'UNAVAILABLE', 409);
      return apiOk(reply, result);
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });
}
