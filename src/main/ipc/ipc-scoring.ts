// IPC handlers for the Trade Scoring Engine.
// Exposes config CRUD + latest brief queries to the renderer.
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §4, §6, §7

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ScoringService } from '../services/scoring-service.js';
import type { ScoringSignal, ScoringStrategy } from '../services/scoring-service.js';
import type { IpcResult } from '@shared/types.js';

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

export function registerScoringIpc(scoringService: ScoringService): void {
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
}
