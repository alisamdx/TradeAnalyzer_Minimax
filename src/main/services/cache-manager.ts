// CacheManager service - tracks cache staleness and triggers auto-refresh
// Provides cache status checking and metadata management
// see SPEC: §3.3 Caching Strategy, §4.3 Cache Management

import type { Database } from 'better-sqlite3';

export interface CacheStatus {
  isStale: boolean;
  lastUpdated: number | null;  // Unix timestamp in ms
  ageMs: number | null;
  ageText: string;
  recordCount: number;
}

export interface CacheStats {
  lastScreenerRun: number | null;
  recordCount: number;
  updatedAt: string;
}

export class CacheManager {
  private db: Database;
  private staleThresholdMs: number;

  constructor(db: Database, staleThresholdHours = 1) {
    this.db = db;
    this.staleThresholdMs = staleThresholdHours * 60 * 60 * 1000;
  }

  /**
   * Get current cache status
   * Returns staleness info, age, and record count
   */
  getCacheStatus(): CacheStatus {
    const row = this.db.prepare(
      'SELECT last_screener_run, record_count FROM cache_metadata WHERE id = 1'
    ).get() as { last_screener_run: number | null; record_count: number } | undefined;

    if (!row || row.last_screener_run === null) {
      return {
        isStale: true,
        lastUpdated: null,
        ageMs: null,
        ageText: 'Never updated',
        recordCount: row?.record_count ?? 0
      };
    }

    const now = Date.now();
    const ageMs = now - row.last_screener_run;
    const isStale = ageMs > this.staleThresholdMs;

    return {
      isStale,
      lastUpdated: row.last_screener_run,
      ageMs,
      ageText: this.formatAge(ageMs),
      recordCount: row.record_count
    };
  }

  /**
   * Check if cache is stale (convenience method)
   */
  isCacheStale(): boolean {
    const status = this.getCacheStatus();
    return status.isStale;
  }

  /**
   * Update the last screener run timestamp
   * Called after successful screener run
   */
  updateLastRun(recordCount?: number): void {
    const now = Date.now();
    // If recordCount is provided, always use it (don't preserve old value)
    if (recordCount !== undefined && recordCount !== null) {
      this.db.prepare(
        `UPDATE cache_metadata
         SET last_screener_run = ?,
             record_count = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 1`
      ).run(now, recordCount);
    } else {
      // Just update timestamp
      this.db.prepare(
        `UPDATE cache_metadata
         SET last_screener_run = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 1`
      ).run(now);
    }
  }

  /**
   * Get detailed cache stats - actually counts records from the database
   */
  getCacheStats(): CacheStats {
    // Count actual constituents from database (this is what matters for the Data view)
    const constituentsCount = this.db
      .prepare('SELECT COUNT(*) as cnt FROM constituents')
      .get() as { cnt: number };

    // Also check when constituents_meta was last updated
    const metaRow = this.db
      .prepare('SELECT MAX(refreshed_at) as last_sync FROM constituents_meta')
      .get() as { last_sync: string | null } | undefined;

    return {
      lastScreenerRun: null,
      recordCount: constituentsCount.cnt,
      updatedAt: metaRow?.last_sync ?? new Date().toISOString()
    };
  }

  /**
   * Reset cache metadata (for testing or manual reset)
   */
  resetCache(): void {
    this.db.prepare(
      `UPDATE cache_metadata
       SET last_screener_run = NULL,
           record_count = 0,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = 1`
    ).run();
  }

  /**
   * Format age in milliseconds to human-readable string
   */
  private formatAge(ageMs: number): string {
    const seconds = Math.floor(ageMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} min ago`;
    return 'Just now';
  }
}
