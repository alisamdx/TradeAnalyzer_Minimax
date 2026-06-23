// IPC surface for the v2 execution engine (Requirements/v2-execution §4, Phase 5b).
//
// Thin pass-through to the ExecutionEngine facade — the renderer's Trading Desk and
// Execution Settings drive everything through here. The engine is constructed in
// index.ts with the MockExecutionBroker and starts `stopped`, so registering this
// surface is inert until the user explicitly starts the engine. Live core events are
// pushed to the renderer separately via `webContents.send('execution:event', …)`
// (wired in index.ts).

import { ipcMain } from 'electron';
import type { ExecutionEngine } from '../execution/execution-engine.js';
import type {
  IpcResult,
  ExecConfig,
  ExecEngineStateView,
  ExecRiskState,
  ExecPositionRow,
  ExecProposalRow,
  ExecAuditRow,
  ExecDryRunRow,
  ExecApproveResult,
  ExecStartResult,
} from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> { return { ok: true, value }; }
function fail(message: string): IpcResult<never> { return { ok: false, error: { code: 'ERR', message } }; }

function guard<T>(fn: () => T): IpcResult<T> {
  try {
    return ok(fn());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

async function guardAsync<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function registerExecutionIpc(engine: ExecutionEngine): void {
  // ── reads ──
  ipcMain.handle('execution:get-state', (): IpcResult<ExecEngineStateView> =>
    guard(() => engine.getState()));
  ipcMain.handle('execution:get-config', (): IpcResult<ExecConfig> =>
    guard(() => engine.getConfig()));
  ipcMain.handle('execution:get-risk-state', (): IpcResult<ExecRiskState> =>
    guard(() => engine.getRiskState()));
  ipcMain.handle('execution:get-positions', (): IpcResult<ExecPositionRow[]> =>
    guard(() => engine.getPositions() as ExecPositionRow[]));
  ipcMain.handle('execution:get-recent-positions', (_evt, limit?: number): IpcResult<ExecPositionRow[]> =>
    guard(() => engine.getRecentPositions(limit) as ExecPositionRow[]));
  ipcMain.handle('execution:get-proposals', (): IpcResult<ExecProposalRow[]> =>
    guard(() => engine.getProposals() as ExecProposalRow[]));
  ipcMain.handle('execution:get-audit', (_evt, limit?: number): IpcResult<ExecAuditRow[]> =>
    guard(() => engine.getAudit(limit) as ExecAuditRow[]));
  ipcMain.handle('execution:get-dry-run-log', (_evt, limit?: number): IpcResult<ExecDryRunRow[]> =>
    guard(() => engine.getDryRunLog(limit) as ExecDryRunRow[]));

  // ── config ──
  ipcMain.handle('execution:update-config', (_evt, patch: Partial<ExecConfig>): IpcResult<ExecConfig> =>
    guard(() => engine.updateConfig(patch)));

  // ── lifecycle / control ──
  ipcMain.handle('execution:start', (): Promise<IpcResult<ExecStartResult>> =>
    guardAsync(() => engine.startEngine()));
  ipcMain.handle('execution:stop', (): IpcResult<{ ok: true }> =>
    guard(() => { engine.stopEngine(); return { ok: true } as const; }));
  ipcMain.handle('execution:pause', (): IpcResult<{ ok: true }> =>
    guard(() => { engine.pauseEngine(); return { ok: true } as const; }));
  ipcMain.handle('execution:kill-trip', (): IpcResult<{ ok: true }> =>
    guard(() => { engine.tripKillSwitch(); return { ok: true } as const; }));
  ipcMain.handle('execution:kill-clear', (): IpcResult<{ ok: true }> =>
    guard(() => { engine.clearKillSwitch(); return { ok: true } as const; }));

  // ── approvals ──
  ipcMain.handle('execution:approve-proposal', (_evt, proposalId: number): Promise<IpcResult<ExecApproveResult>> =>
    guardAsync(() => engine.approveProposal(proposalId)));
  ipcMain.handle('execution:reject-proposal', (_evt, proposalId: number): IpcResult<{ ok: boolean }> =>
    guard(() => engine.rejectProposal(proposalId)));
}
