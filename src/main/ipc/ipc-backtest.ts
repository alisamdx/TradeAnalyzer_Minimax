import { ipcMain } from 'electron';
import type { BacktestConfig } from '@shared/types.js';
import { BacktestEngine } from '../services/backtest-engine.js';

function ok<T>(value: T) { return { ok: true as const, value }; }
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false as const, error: { code: 'BACKTEST_ERROR', message } };
}

export function registerBacktestIpc(engine: BacktestEngine): void {

  // ── Config management ────────────────────────────────────────────────────

  ipcMain.handle('backtest:config:list', () => {
    try { return ok(engine.listConfigs()); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('backtest:config:create', (_e, cfg: Omit<BacktestConfig, 'id' | 'createdAt'>) => {
    try { return ok(engine.createConfig(cfg)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('backtest:config:delete', (_e, configId: number) => {
    try { engine.deleteConfig(configId); return ok(true); }
    catch (err) { return fail(err); }
  });

  // ── Run management ───────────────────────────────────────────────────────

  ipcMain.handle('backtest:run:list', (_e, configId?: number) => {
    try { return ok(engine.listRuns(configId)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('backtest:run:get', (_e, runId: number) => {
    try { return ok(engine.getRun(runId)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('backtest:run:delete', (_e, runId: number) => {
    try { engine.deleteRun(runId); return ok(true); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('backtest:run:start', async (e, configId: number) => {
    try {
      const result = engine.simulate(configId, (progress) => {
        try { e.sender.send('backtest:progress', progress); } catch { /* window closed */ }
      });
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('backtest:run:cancel', () => {
    try { engine.cancel(); return ok(true); }
    catch (err) { return fail(err); }
  });

  // ── Results ───────────────────────────────────────────────────────────────

  ipcMain.handle('backtest:run:metrics', (_e, runId: number) => {
    try { return ok(engine.getMetrics(runId)); }
    catch (err) { return fail(err); }
  });

  ipcMain.handle('backtest:run:trades', (_e, runId: number) => {
    try { return ok(engine.getTrades(runId)); }
    catch (err) { return fail(err); }
  });
}
