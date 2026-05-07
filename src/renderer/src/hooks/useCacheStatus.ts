// useCacheStatus hook - polls cache freshness every 5 minutes
// Provides cache status and auto-refresh trigger
// see SPEC: §3.3 Caching Strategy

import { useCallback, useEffect, useState } from 'react';
import type { CacheStatus } from '@shared/types.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface UseCacheStatusReturn {
  status: CacheStatus | null;
  isStale: boolean;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useCacheStatus(autoRefreshCallback?: () => void): UseCacheStatusReturn {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await window.api.cache.getStatus();
      setStatus(result);

      // Trigger auto-refresh callback if cache is stale and callback provided
      if (result.isStale && autoRefreshCallback) {
        autoRefreshCallback();
      }
    } catch (err) {
      console.error('[useCacheStatus] Failed to fetch cache status:', err);
    } finally {
      setIsLoading(false);
    }
  }, [autoRefreshCallback]);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll every 5 minutes
  useEffect(() => {
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchStatus();
  }, [fetchStatus]);

  return {
    status,
    isStale: status?.isStale ?? true,
    isLoading,
    refresh
  };
}
