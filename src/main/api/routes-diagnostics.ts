import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError } from './helpers.js';
import { buildDayReport, etDate, isIsoDate } from '../services/day-diagnostics.js';
import { auditPickGreeks, type PickAuditDb } from '../services/greek-consistency.js';
import {
  settledCspPanel, PANEL_STRATEGIES, type PanelDb, type PanelStrategy
} from '../services/settled-csp-panel.js';
import { premiumRoc, ROC_STRATEGIES, type RocStrategy } from '../services/premium-roc.js';
import { buildSpreadShadowReport } from '../services/spread-mode-settle.js';
import { spreadStudyPanel } from '../services/spread-study-panel.js';
import { spreadCapturePanel } from '../services/spread-capture-panel.js';
import { poolSelectionPanel } from '../services/pool-selection-panel.js';
import { readStaleGreekShadow } from '../services/stale-greek-shadow.js';

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

  // GET /diagnostics/stale-greek-shadow?from=YYYY-MM-DD&to=YYYY-MM-DD — the wheel put STALE_GREEK_MODEL_DELTA
  // would have picked on each chain the stale-Greek guard flagged (v1.1.320). Read-only; the evidence the
  // OFF flag is to be decided on. see services/stale-greek-shadow.ts
  app.get<{ Querystring: { from?: string; to?: string } }>('/diagnostics/stale-greek-shadow', async (req, reply) => {
    const to = req.query.to ?? etDate(new Date().toISOString());
    const from = req.query.from ?? '2026-09-01';
    if (!isIsoDate(from) || !isIsoDate(to)) return apiError(reply, 'from and to must be YYYY-MM-DD', 'VALIDATION_ERROR');
    try {
      return apiOk(reply, readStaleGreekShadow(svc.db, from, to));
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

  // GET /diagnostics/premium-roc?strategy=income|wheel — every stored CSP settled at expiry on its
  // real premium, beside Brief Replay's 0.85×-entry proxy on the same row; split-scale mismatches
  // are listed, not settled. Read-only. Read by scripts/premium-roc-report.mjs. see premium-roc.ts
  app.get<{ Querystring: { strategy?: string } }>('/diagnostics/premium-roc', async (req, reply) => {
    const strategy = (req.query.strategy ?? 'income') as RocStrategy;
    if (!ROC_STRATEGIES.includes(strategy)) {
      return apiError(reply, `strategy must be one of ${ROC_STRATEGIES.join(', ')}`, 'VALIDATION_ERROR');
    }
    try {
      return apiOk(reply, premiumRoc(svc.db as unknown as PanelDb, strategy));
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });

  // GET /diagnostics/spread-study-panel?strategy=wheel&quotes=1 — the replay picks, bars, iv_history
  // and (with quotes=1) quote sources that scripts/fr-bull-put-spread-study.mjs reads, so it no longer
  // opens the SQLite file itself. Read-only. see services/spread-study-panel.ts
  app.get<{ Querystring: { strategy?: string; quotes?: string } }>('/diagnostics/spread-study-panel', async (req, reply) => {
    const strategy = req.query.strategy ?? 'wheel';
    if (!/^[a-z_]{1,32}$/.test(strategy)) return apiError(reply, 'strategy must be a strategy name', 'VALIDATION_ERROR');
    try {
      return apiOk(reply, spreadStudyPanel(svc.db as unknown as PanelDb, strategy, req.query.quotes === '1'));
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });

  // GET /diagnostics/spread-capture-panel?earnings=1 — the spread_chain_capture entry rows (and with
  // earnings=1, earnings_calendar) that the BPS-4/BPS-19 harnesses read through
  // scripts/lib/spread-study-lib.mjs. Read-only. see services/spread-capture-panel.ts
  app.get<{ Querystring: { earnings?: string } }>('/diagnostics/spread-capture-panel', async (req, reply) => {
    try {
      return apiOk(reply, spreadCapturePanel(svc.db as unknown as PanelDb, req.query.earnings === '1'));
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });

  // GET /diagnostics/pool-selection-panel — the wheel analysis snapshots (latest per date, projected)
  // and price series that scripts/fr-spread-pool-selection-study.mjs (BPS-2) reads. Read-only.
  // see services/pool-selection-panel.ts
  app.get('/diagnostics/pool-selection-panel', async (_req, reply) => {
    try {
      return apiOk(reply, poolSelectionPanel(svc.db as unknown as PanelDb));
    } catch (err) {
      return apiError(reply, err instanceof Error ? err.message : String(err), 'INTERNAL', 500);
    }
  });

  // GET /diagnostics/spread-shadow — every bull put spread shadow pick settled forward on its own
  // captured quotes, and progress against the 08 §4 enable gate. Read-only. Read by
  // scripts/spread-shadow-report.mjs. see services/spread-mode-settle.ts
  app.get('/diagnostics/spread-shadow', async (_req, reply) => {
    try {
      return apiOk(reply, buildSpreadShadowReport(svc.db, etDate(new Date().toISOString())));
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
