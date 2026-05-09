// IPC handlers for cache management
// Exposes cache status and refresh operations to renderer
// see SPEC: §3.3 Caching Strategy

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { CacheManager } from '../services/cache-manager.js';
import type { IpcResult } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'CACHE_ERROR', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try {
      return ok(fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerCacheIpc(db: Database): void {
  const cacheManager = new CacheManager(db, 1); // 1 hour threshold

  // Get current cache status
  ipcMain.handle('cache:getStatus', wrap(() => cacheManager.getCacheStatus()));

  // Get detailed cache stats
  ipcMain.handle('cache:getStats', wrap(() => cacheManager.getCacheStats()));

  // Update last screener run (called after successful screen)
  ipcMain.handle('cache:updateLastRun', wrap((recordCount?: number) => {
    cacheManager.updateLastRun(recordCount);
    return true;
  }));

  // Reset cache metadata
  ipcMain.handle('cache:reset', wrap(() => {
    cacheManager.resetCache();
    return true;
  }));

  // Refresh cache: clears data and resets metadata
  ipcMain.handle('cache:refresh', wrap(() => {
    db.prepare('DELETE FROM quote_cache').run();
    db.prepare('DELETE FROM fundamentals_cache').run();
    db.prepare('DELETE FROM constituents').run();
    db.prepare('DELETE FROM constituents_meta').run();
    cacheManager.resetCache();
    return true;
  }));

  // Check if cache is stale (simple boolean)
  ipcMain.handle('cache:isStale', wrap(() => cacheManager.isCacheStale()));
}
