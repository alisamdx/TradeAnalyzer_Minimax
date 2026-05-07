// CacheStatusIndicator component - visual cache status display
// Shows green for fresh, red for stale, with age text
// see SPEC: §3.3 Caching Strategy, §4.3 Cache Management

import React from 'react';
import type { CacheStatus } from '@shared/types.js';

interface CacheStatusIndicatorProps {
  status: CacheStatus | null;
  isLoading?: boolean;
  onRefresh?: () => void;
  showRefreshButton?: boolean;
}

export const CacheStatusIndicator: React.FC<CacheStatusIndicatorProps> = ({
  status,
  isLoading = false,
  onRefresh,
  showRefreshButton = true
}) => {
  if (isLoading || !status) {
    return (
      <div className="cache-status-indicator loading">
        <span className="cache-dot gray" />
        <span className="cache-text">Loading...</span>
      </div>
    );
  }

  const dotColor = status.isStale ? 'red' : 'green';
  const statusText = status.isStale ? 'Stale' : 'Fresh';

  return (
    <div className={`cache-status-indicator ${status.isStale ? 'stale' : 'fresh'}`}>
      <span className={`cache-dot ${dotColor}`} title={statusText} />
      <span className="cache-text">
        {status.isStale ? 'Data stale' : 'Data fresh'}
        {status.ageText && ` • ${status.ageText}`}
      </span>
      {showRefreshButton && onRefresh && (
        <button
          className="cache-refresh-btn"
          onClick={onRefresh}
          title="Refresh all data"
          disabled={isLoading}
        >
          ↻ Refresh
        </button>
      )}
    </div>
  );
};

export default CacheStatusIndicator;
