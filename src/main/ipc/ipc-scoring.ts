// IPC handlers for the Trade Scoring Engine.
// Exposes config CRUD + latest brief queries to the renderer.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4, §6, §7

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ScoringService } from '../services/scoring-service.js';
import type { ScoringSignal, ScoringStrategy } from '../services/scoring-service.js';
import type { IpcResult, BriefPick, ScoringStrategy as ScoringStrategyAlias } from '@shared/types.js';
import type { EmailService } from '../services/email-service.js';
import { buildEmailHtml, buildPdf } from '../services/brief-report-builder.js';
import { STRATEGIES } from '../services/scoring-service.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'SCORING_ERROR', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try { return ok(fn(...args)); }
    catch (err) { return fail(err); }
  };
}

export function registerScoringIpc(scoringService: ScoringService, emailService: EmailService): void {
  // Get config for a strategy (or all strategies)
  ipcMain.handle(
    'scoring:get-config',
    wrap((strategy?: ScoringStrategy) =>
      strategy ? scoringService.getConfig(strategy) : scoringService.getAllConfigs()
    )
  );

  // Update config for a strategy
  ipcMain.handle(
    'scoring:update-config',
    wrap((strategy: ScoringStrategy, signals: ScoringSignal[], version: string) => {
      scoringService.updateConfig(strategy, signals, version);
      return true;
    })
  );

  // Reset a strategy to baseline weights
  ipcMain.handle(
    'scoring:reset-to-baseline',
    wrap((strategy: ScoringStrategy) => {
      scoringService.resetToBaseline(strategy);
      return scoringService.getConfig(strategy);
    })
  );

  // Get the latest daily brief (one row per strategy, or filtered by strategy)
  ipcMain.handle(
    'scoring:get-latest-brief',
    wrap((strategy?: ScoringStrategy) => {
      const rows = scoringService.getLatestBrief(strategy);
      return rows.map(r => ({
        id: r.id,
        generatedAt: r.generated_at,
        validUntil: r.valid_until,
        strategy: r.strategy,
        picks: JSON.parse(r.picks) as unknown[],
        runMeta: r.run_meta ? (JSON.parse(r.run_meta) as unknown) : null,
      }));
    })
  );

  // Get brief history (last N entries across all strategies)
  ipcMain.handle(
    'scoring:get-brief-history',
    wrap((limit?: number) => {
      const rows = scoringService.getBriefHistory(limit ?? 30);
      return rows.map(r => ({
        id: r.id,
        generatedAt: r.generated_at,
        validUntil: r.valid_until,
        strategy: r.strategy,
        picks: JSON.parse(r.picks) as unknown[],
        runMeta: r.run_meta ? (JSON.parse(r.run_meta) as unknown) : null,
      }));
    })
  );

  // Resend the most recent brief as email+PDF without re-running the job.
  // Useful for validating email/PDF layout changes or sending on non-trading days.
  // Signal weight suggestions from Pearson correlation (1e)
  ipcMain.handle('scoring:signal-correlations', wrap((strategy: ScoringStrategyAlias) =>
    scoringService.computeSignalCorrelations(strategy)
  ));

  // B-02: critic pass-rate trend per strategy (last 7 briefs)
  ipcMain.handle('scoring:brief-health-trend', wrap(() => scoringService.getBriefHealthTrend()));

  ipcMain.handle('scoring:resend-brief-email', async (_e: IpcMainInvokeEvent): Promise<IpcResult<{ sent: boolean; message: string }>> => {
    try {
      if (!emailService.isConfigured()) {
        return ok({ sent: false, message: 'Email not configured — check Settings → Email.' });
      }

      const rows = scoringService.getLatestBrief();
      if (rows.length === 0) {
        return ok({ sent: false, message: 'No brief in database — run the job first.' });
      }

      // Reconstruct briefsByStrategy from persisted rows
      const briefsByStrategy = new Map<ScoringStrategy, BriefPick[]>();
      let generatedAt = rows[0]!.generated_at;

      for (const strategy of STRATEGIES) {
        const row = rows.find(r => r.strategy === strategy);
        if (row) {
          briefsByStrategy.set(strategy as ScoringStrategy, JSON.parse(row.picks) as BriefPick[]);
          if (row.generated_at > generatedAt) generatedAt = row.generated_at;
        }
      }

      const dateStr = new Date(generatedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const [emailHtml, pdfBuffer] = await Promise.all([
        Promise.resolve(buildEmailHtml(dateStr, briefsByStrategy)),
        buildPdf(dateStr, briefsByStrategy),
      ]);

      const totalPicks = [...briefsByStrategy.values()].reduce((n, p) => n + p.length, 0);
      const subject = `[Resend] Daily Intelligence Brief — ${new Date(generatedAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${totalPicks} picks`;

      await emailService.send(subject, emailHtml, [{
        filename: `daily-brief-${dateStr}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }]);

      return ok({ sent: true, message: `Resent brief from ${dateStr} (${totalPicks} picks).` });
    } catch (err) {
      return fail(err);
    }
  });
}
