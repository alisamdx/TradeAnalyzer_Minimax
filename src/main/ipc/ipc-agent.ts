// IPC handlers for TraderAgent integration (v0.12.0).
// Provides read-only views into the agent DB + process spawning to run agent phases.

import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDbService } from '../services/agent-db-service.js';
import type {
  AgentStatus, AgentTrade, AgentLesson, AgentRecommendation, AgentMemorySnapshot
} from '@shared/types.js';

function ok<T>(value: T) { return { ok: true as const, value }; }
function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' : 'UNKNOWN';
  return { ok: false as const, error: { code, message } };
}

export function registerAgentIpc(agentDb: AgentDbService): void {

  // ── DB management ──────────────────────────────────────────────────────────

  ipcMain.handle('agent:open-db', (_e, dbPath: string) => {
    try {
      const opened = agentDb.open(dbPath);
      return ok(opened);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:close-db', () => {
    try {
      agentDb.close();
      return ok(true);
    } catch (err) { return fail(err); }
  });

  // ── Read queries ───────────────────────────────────────────────────────────

  ipcMain.handle('agent:get-status', () => {
    try {
      const status: AgentStatus = agentDb.getStatus();
      return ok(status);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-trades', (_e, statusFilter?: 'open' | 'closed' | 'all') => {
    try {
      const trades: AgentTrade[] = agentDb.getTrades(statusFilter);
      return ok(trades);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-lessons', (_e, limit?: number) => {
    try {
      const lessons: AgentLesson[] = agentDb.getLessons(limit);
      return ok(lessons);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-recommendations', () => {
    try {
      const recs: AgentRecommendation[] = agentDb.getRecommendations();
      return ok(recs);
    } catch (err) { return fail(err); }
  });

  ipcMain.handle('agent:get-memory', () => {
    try {
      const mem: AgentMemorySnapshot | null = agentDb.getMemory();
      return ok(mem);
    } catch (err) { return fail(err); }
  });

  // ── Process spawning ───────────────────────────────────────────────────────

  ipcMain.handle('agent:run-phase', (_e, phase: string, projectPath: string) => {
    try {
      if (!projectPath || !existsSync(projectPath)) {
        return fail(new Error(`Agent project path not found: ${projectPath}`));
      }

      const validPhases = ['scout', 'decide', 'trade', 'monitor', 'learn', 'run'];
      if (!validPhases.includes(phase)) {
        return fail(new Error(`Unknown phase: ${phase}`));
      }

      const npmScript = `agent:${phase}`;

      const child = spawn('npm', ['run', npmScript], {
        cwd: projectPath,
        shell: true,
        env: { ...process.env }
      });

      const pid = child.pid ?? -1;

      const sendLog = (line: string) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:log', { pid, phase, line });
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(line);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(`[stderr] ${line}`);
        }
      });

      child.on('exit', (code) => {
        sendLog(`[exit] phase=${phase} code=${code ?? '?'}`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:phase-done', { pid, phase, code });
          }
        }
      });

      child.on('error', (err) => {
        sendLog(`[error] ${err.message}`);
      });

      return ok({ pid, phase });
    } catch (err) { return fail(err); }
  });

  // ── Close trade (delegates to agent CLI) ──────────────────────────────────

  ipcMain.handle('agent:close-trade', (_e, tradeId: number, reason: string, projectPath: string) => {
    try {
      if (!projectPath || !existsSync(projectPath)) {
        return fail(new Error(`Agent project path not found: ${projectPath}`));
      }

      const pkgJson = join(projectPath, 'package.json');
      if (!existsSync(pkgJson)) {
        return fail(new Error('No package.json in agent project path'));
      }

      const child = spawn(
        'npm',
        ['run', 'agent:close-trade', '--', '--id', String(tradeId), '--reason', reason],
        { cwd: projectPath, shell: true, env: { ...process.env } }
      );

      const sendLog = (line: string) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:log', { pid: child.pid ?? -1, phase: 'close-trade', line });
          }
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(line);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (line.trim()) sendLog(`[stderr] ${line}`);
        }
      });

      child.on('exit', (code) => {
        sendLog(`[exit] close-trade id=${tradeId} code=${code ?? '?'}`);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('agent:phase-done', { pid: child.pid ?? -1, phase: 'close-trade', code });
          }
        }
      });

      return ok({ pid: child.pid ?? -1, tradeId });
    } catch (err) { return fail(err); }
  });
}
