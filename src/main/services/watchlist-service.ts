import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { Watchlist, WatchlistItem } from '@shared/types.js';

const DEFAULT_WATCHLIST_NAME = 'Default';

export class WatchlistError extends Error {
  constructor(
    public readonly code:
      | 'NAME_TAKEN'
      | 'NOT_FOUND'
      | 'CANNOT_DELETE_DEFAULT'
      | 'INVALID_NAME'
      | 'INVALID_TICKER'
      | 'DUPLICATE_TICKER',
    message: string
  ) {
    super(message);
    this.name = 'WatchlistError';
  }
}

interface WatchlistRow {
  id: number;
  name: string;
  is_default: number;
  created_at: string;
  updated_at: string;
  item_count: number;
}

interface WatchlistItemRow {
  id: number;
  watchlist_id: number;
  ticker: string;
  notes: string | null;
  added_at: string;
  sector: string | null;
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

function rowToWatchlist(r: WatchlistRow): Watchlist {
  return {
    id: r.id,
    name: r.name,
    isDefault: r.is_default === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    itemCount: r.item_count
  };
}

function rowToItem(r: WatchlistItemRow): WatchlistItem {
  return {
    id: r.id,
    watchlistId: r.watchlist_id,
    ticker: r.ticker,
    notes: r.notes,
    addedAt: r.added_at,
    sector: r.sector,
    currentIv: null  // IV fetched on demand via options API
  };
}

export class WatchlistService {
  private readonly listAllStmt;
  private readonly getOneStmt;
  private readonly findByLowerNameStmt;
  private readonly insertStmt;
  private readonly renameStmt;
  private readonly deleteStmt;
  private readonly deleteSnapshotsStmt;
  private readonly listItemsStmt;
  private readonly insertItemStmt;
  private readonly findItemStmt;
  private readonly removeItemsStmt;
  private readonly deleteItemsStmt;
  private readonly touchUpdatedAtStmt;
  private readonly findItemByIdStmt;
  private readonly findDefaultStmt;

  constructor(private readonly db: DbHandle) {
    this.listAllStmt = db.prepare(`
      SELECT w.id, w.name, w.is_default, w.created_at, w.updated_at,
             (SELECT COUNT(*) FROM watchlist_items i WHERE i.watchlist_id = w.id) AS item_count
      FROM watchlists w
      ORDER BY w.is_default DESC, lower(w.name) ASC
    `);
    this.getOneStmt = db.prepare(`
      SELECT w.id, w.name, w.is_default, w.created_at, w.updated_at,
             (SELECT COUNT(*) FROM watchlist_items i WHERE i.watchlist_id = w.id) AS item_count
      FROM watchlists w
      WHERE w.id = ?
    `);
    this.findByLowerNameStmt = db.prepare(
      'SELECT id FROM watchlists WHERE lower(name) = lower(?)'
    );
    this.insertStmt = db.prepare(
      'INSERT INTO watchlists (name, is_default) VALUES (?, ?)'
    );
    this.renameStmt = db.prepare(
      `UPDATE watchlists
         SET name = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`
    );
    this.deleteStmt = db.prepare('DELETE FROM watchlists WHERE id = ?');
    this.deleteSnapshotsStmt = db.prepare('DELETE FROM analysis_snapshots WHERE watchlist_id = ?');
    this.deleteItemsStmt = db.prepare('DELETE FROM watchlist_items WHERE watchlist_id = ?');
    this.listItemsStmt = db.prepare(
      `SELECT wi.id, wi.watchlist_id, wi.ticker, wi.notes, wi.added_at,
              (SELECT c2.sector FROM constituents c2 WHERE upper(c2.ticker) = upper(wi.ticker) LIMIT 1) AS sector
       FROM watchlist_items wi
       WHERE wi.watchlist_id = ?
       ORDER BY wi.ticker ASC`
    );
    this.insertItemStmt = db.prepare(
      `INSERT INTO watchlist_items (watchlist_id, ticker, notes, added_at)
       VALUES (?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`
    );
    this.findItemStmt = db.prepare(
      'SELECT id FROM watchlist_items WHERE watchlist_id = ? AND upper(ticker) = upper(?)'
    );
    this.removeItemsStmt = db.prepare(
      'DELETE FROM watchlist_items WHERE watchlist_id = ? AND id IN (SELECT value FROM json_each(?))'
    );
    this.touchUpdatedAtStmt = db.prepare(
      `UPDATE watchlists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
    );
    this.findItemByIdStmt = db.prepare(
      `SELECT wi.id, wi.watchlist_id, wi.ticker, wi.notes, wi.added_at, c.sector
       FROM watchlist_items wi
       LEFT JOIN constituents c ON upper(wi.ticker) = upper(c.ticker)
       WHERE wi.id = ?`
    );
    this.findDefaultStmt = db.prepare(`
      SELECT w.id, w.name, w.is_default, w.created_at, w.updated_at,
             (SELECT COUNT(*) FROM watchlist_items i WHERE i.watchlist_id = w.id) AS item_count
      FROM watchlists w WHERE w.is_default = 1
    `);
  }

  /** Idempotent: ensures the undeletable Default watchlist exists. Called at startup. */
  ensureDefault(): Watchlist {
    const existing = this.findDefaultStmt.get() as WatchlistRow | undefined;
    if (existing) return rowToWatchlist(existing);

    const result = this.insertStmt.run(DEFAULT_WATCHLIST_NAME, 1);
    const created = this.getOneStmt.get(Number(result.lastInsertRowid)) as WatchlistRow | undefined;
    if (!created) throw new Error('Failed to create Default watchlist');
    return rowToWatchlist(created);
  }

  list(): Watchlist[] {
    return (this.listAllStmt.all() as unknown as WatchlistRow[]).map(rowToWatchlist);
  }

  get(id: number): Watchlist {
    const row = this.getOneStmt.get(id) as WatchlistRow | undefined;
    if (!row) throw new WatchlistError('NOT_FOUND', `Watchlist ${id} not found`);
    return rowToWatchlist(row);
  }

  create(name: string): Watchlist {
    const trimmed = name.trim();
    if (!trimmed) throw new WatchlistError('INVALID_NAME', 'Watchlist name cannot be empty');
    if (this.findByLowerNameStmt.get(trimmed)) {
      throw new WatchlistError('NAME_TAKEN', `A watchlist named "${trimmed}" already exists`);
    }
    const result = this.insertStmt.run(trimmed, 0);
    return this.get(Number(result.lastInsertRowid));
  }

  rename(id: number, newName: string): Watchlist {
    const trimmed = newName.trim();
    if (!trimmed) throw new WatchlistError('INVALID_NAME', 'Watchlist name cannot be empty');

    const current = this.get(id);
    if (current.name === trimmed) return current;

    const conflict = this.findByLowerNameStmt.get(trimmed) as { id: number } | undefined;
    if (conflict && conflict.id !== id) {
      throw new WatchlistError('NAME_TAKEN', `A watchlist named "${trimmed}" already exists`);
    }
    this.renameStmt.run(trimmed, id);
    return this.get(id);
  }

  delete(id: number): void {
    const target = this.get(id);
    if (target.isDefault) {
      throw new WatchlistError(
        'CANNOT_DELETE_DEFAULT',
        'The Default watchlist cannot be deleted (FR-1.3). It can be renamed.'
      );
    }
    // Delete items first, then snapshots, then the watchlist
    this.deleteItemsStmt.run(id);
    this.deleteSnapshotsStmt.run(id);
    this.deleteStmt.run(id);
  }

  listItems(watchlistId: number): WatchlistItem[] {
    this.get(watchlistId);
    return (this.listItemsStmt.all(watchlistId) as unknown as WatchlistItemRow[]).map(rowToItem);
  }

  addItem(
    watchlistId: number,
    ticker: string,
    notes: string | null = null,
    addedAt: string | null = null
  ): WatchlistItem {
    this.get(watchlistId);
    const sym = normalizeTicker(ticker);
    if (!TICKER_RE.test(sym)) {
      throw new WatchlistError('INVALID_TICKER', `"${ticker}" is not a valid ticker symbol`);
    }
    if (this.findItemStmt.get(watchlistId, sym)) {
      throw new WatchlistError('DUPLICATE_TICKER', `${sym} is already in this watchlist`);
    }
    const result = this.insertItemStmt.run(watchlistId, sym, notes, addedAt);
    this.touchUpdatedAtStmt.run(watchlistId);
    const row = this.findItemByIdStmt.get(Number(result.lastInsertRowid)) as
      | WatchlistItemRow
      | undefined;
    if (!row) throw new Error('Failed to insert watchlist item');
    return rowToItem(row);
  }

  /**
   * Bulk-add tickers. Each row that fails (invalid or duplicate) is reported but does not
   * abort the rest, matching FR-1.10 ("never silently dropped").
   */
  addItemsBulk(
    watchlistId: number,
    rows: Array<{ ticker: string; notes?: string | null; addedAt?: string | null }>
  ): { added: WatchlistItem[]; skipped: Array<{ ticker: string; reason: string }> } {
    this.get(watchlistId);
    const added: WatchlistItem[] = [];
    const skipped: Array<{ ticker: string; reason: string }> = [];

    withTransaction(this.db, () => {
      for (const r of rows) {
        try {
          added.push(this.addItem(watchlistId, r.ticker, r.notes ?? null, r.addedAt ?? null));
        } catch (err) {
          if (err instanceof WatchlistError) {
            skipped.push({ ticker: r.ticker, reason: err.message });
          } else {
            throw err;
          }
        }
      }
    });
    return { added, skipped };
  }

  removeItems(watchlistId: number, itemIds: number[]): number {
    this.get(watchlistId);
    if (itemIds.length === 0) return 0;
    const result = this.removeItemsStmt.run(watchlistId, JSON.stringify(itemIds));
    if (result.changes > 0) this.touchUpdatedAtStmt.run(watchlistId);
    return Number(result.changes);
  }
}
