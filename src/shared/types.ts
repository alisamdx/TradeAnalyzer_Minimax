// Types crossing the IPC boundary. Imported by main, preload, and renderer.

export interface Watchlist {
  id: number;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
}

export interface WatchlistItem {
  id: number;
  watchlistId: number;
  ticker: string;
  notes: string | null;
  addedAt: string;
}

export interface CsvImportResult {
  watchlistId: number;
  imported: number;
  skipped: Array<{ row: number; ticker: string; reason: string }>;
}

export interface CsvExportResult {
  filePath: string;
  rowCount: number;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
