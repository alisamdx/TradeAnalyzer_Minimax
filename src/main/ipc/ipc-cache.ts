// IPC handlers for cache management
// Exposes cache status and refresh operations to renderer
// see SPEC: §3.3 Caching Strategy

import { ipcMain } from 'electron';
import type { Database } from 'better-sqlite3';
import { CacheManager } from '../services/cache-manager.js';

export function registerCacheIpc(db: Database): void {
  const cacheManager = new CacheManager(db, 1); // 1 hour threshold

  // Get current cache status
  ipcMain.handle('cache:getStatus', () => {
    return cacheManager.getCacheStatus();
  });

  // Get detailed cache stats
  ipcMain.handle('cache:getStats', () => {
    return cacheManager.getCacheStats();
  });

  // Update last screener run (called after successful screen)
  ipcMain.handle('cache:updateLastRun', (_event, recordCount?: number) => {
    cacheManager.updateLastRun(recordCount);
    return true;
  });

  // Reset cache metadata
  ipcMain.handle('cache:reset', () => {
    cacheManager.resetCache();
    return true;
  });

  // Check if cache is stale (simple boolean)
  ipcMain.handle('cache:isStale', () => {
    return cacheManager.isCacheStale();
  });
}
