// useSortable hook - generic sorting for table columns
// Provides asc/desc toggle with null handling
// see SPEC: §2.1.3 Sortable Columns

import { useState, useCallback, useMemo } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortConfig {
  key: string;
  direction: SortDirection;
}

interface UseSortableReturn<T> {
  sortedData: T[];
  sortConfig: SortConfig | null;
  requestSort: (key: string) => void;
  getSortIndicator: (key: string) => string;
}

export function useSortable<T>(
  data: T[],
  defaultKey?: string,
  defaultDirection: SortDirection = 'asc'
): UseSortableReturn<T> {
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(
    defaultKey ? { key: defaultKey, direction: defaultDirection } : null
  );

  const requestSort = useCallback((key: string) => {
    setSortConfig((current) => {
      if (!current || current.key !== key) {
        return { key, direction: 'asc' };
      }
      // Toggle direction
      return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  }, []);

  const getSortIndicator = useCallback(
    (key: string): string => {
      if (!sortConfig || sortConfig.key !== key) return '';
      return sortConfig.direction === 'asc' ? '▲' : '▼';
    },
    [sortConfig]
  );

  const sortedData = useMemo(() => {
    if (!sortConfig) return data;

    const { key, direction } = sortConfig;
    const sorted = [...data];

    sorted.sort((a, b) => {
      const aValue = (a as Record<string, unknown>)[key];
      const bValue = (b as Record<string, unknown>)[key];

      // Handle null/undefined values - push to end
      if (aValue == null && bValue == null) return 0;
      if (aValue == null) return direction === 'asc' ? 1 : -1;
      if (bValue == null) return direction === 'asc' ? -1 : 1;

      // Compare values
      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return direction === 'asc' ? aValue - bValue : bValue - aValue;
      }

      // String comparison
      const aStr = String(aValue).toLowerCase();
      const bStr = String(bValue).toLowerCase();
      if (aStr < bStr) return direction === 'asc' ? -1 : 1;
      if (aStr > bStr) return direction === 'asc' ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [data, sortConfig]);

  return {
    sortedData,
    sortConfig,
    requestSort,
    getSortIndicator
  };
}

export default useSortable;
