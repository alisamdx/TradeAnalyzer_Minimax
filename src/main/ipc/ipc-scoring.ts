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
import type { DbHandle } from '../db/connection.js';
import {
  rollTheDice, DEFAULT_MAX_PRICE,
  type DicePickInput, type DiceResult,
} from '../services/roll-the-dice.js';

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

export function registerScoringIpc(
  scoringService: ScoringService,
  emailService: EmailService,
  db: DbHandle,
): void {
  // Roll the Dice — ONE wheel entry from the latest brief, or an explicit nothing.
  //
  // Pure filter over the stored brief: no scoring change, no provider call, nothing written.
  // The earnings map is read LIVE from `earnings_calendar` rather than trusted from the pick's
  // stored signals, because a brief can outlive a calendar correction — this session opened with
  // exactly that failure (a stale stored date put NVDA at wheel #1 on its earnings day).
  ipcMain.handle(
    'scoring:roll-the-dice',
    wrap((maxPrice?: number): DiceResult => {
      const rows = scoringService.getLatestBrief('wheel');
      const brief = rows[0] ?? null;
      const picks: DicePickInput[] = brief ? (JSON.parse(brief.picks) as DicePickInput[]) : [];

      // ET date — the brief and the earnings calendar are both keyed to it.
      const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      // A ticker with no row is left OUT of the map entirely. `report_date` is NOT NULL and the
      // table is keyed by ticker, so presence always means "we have a date" -- absence means we
      // do not know, and the caller fails closed on that.
      const earnings = new Map<string, string>();
      if (picks.length > 0) {
        const marks = picks.map(() => '?').join(',');
        const rowsE = db.prepare(
          `SELECT ticker, report_date FROM earnings_calendar WHERE ticker IN (${marks})`,
        ).all(...picks.map(p => p.ticker)) as Array<{ ticker: string; report_date: string }>;
        for (const r of rowsE) earnings.set(r.ticker, r.report_date);
      }

      return rollTheDice(
        picks, earnings, todayEt,
        brief ? brief.generated_at.slice(0, 10) : null,
        maxPrice ?? DEFAULT_MAX_PRICE,
      );
    })
  );

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
