import { ipcMain } from 'electron';
import { unverifiedColumns } from '@tradeanalyzer/core';
import { currentGeneration, openGeneration } from './generation.js';
import { columns, query, stats, tables, tree, type QueryRequest } from './inspect.js';
import type { IpcResult, QueryRequestDto } from '../shared/types.js';

/**
 * IPC handlers — 05 §9.
 *
 * Every method returns an `IpcResult`. A thrown error crossing the bridge
 * arrives at the renderer as an opaque string with the stack mangled, so a
 * failure is returned as **data** and the UI can say what actually went wrong
 * rather than showing a spinner forever (P9).
 */

function handle<T>(channel: string, fn: (...args: never[]) => T): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<IpcResult<Awaited<T>>> => {
    try {
      return { ok: true, data: (await fn(...(args as never[]))) as Awaited<T> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

export function registerIpc(): void {
  handle('generation:current', () => {
    try {
      return currentGeneration();
    } catch {
      return openGeneration();
    }
  });

  handle('dictionary:tables', () => tables());
  handle('dictionary:tree', () => tree());
  handle('dictionary:columns', (table: string) => columns(table));
  handle('dictionary:stats', (table: string) => stats(table));
  handle('dictionary:unverified', () => unverifiedColumns());

  handle('inspect:query', (req: QueryRequestDto) => query(req as QueryRequest));
}
