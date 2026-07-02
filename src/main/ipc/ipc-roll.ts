// IPC handlers for the Roll / Closure Analyzer.

import { ipcMain } from 'electron';
import { RollAnalyzerService } from '../services/roll-analyzer-service.js';
import type { OptionsProvider } from '../services/options-provider.js';
import type { IpcResult, RollPositionInput, RollMetric, RollAnalysis } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(err: unknown): IpcResult<never> {
  return { ok: false, error: { code: 'ROLL_ERROR', message: err instanceof Error ? err.message : String(err) } };
}

export function registerRollIpc(optionsProvider: OptionsProvider): void {
  const svc = new RollAnalyzerService(optionsProvider);

  ipcMain.handle(
    'roll:analyze',
    async (_e, input: RollPositionInput, metric: RollMetric): Promise<IpcResult<RollAnalysis>> => {
      try { return ok(await svc.analyze(input, metric)); }
      catch (err) { return fail(err); }
    },
  );
}
