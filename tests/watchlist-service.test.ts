import { describe, it, expect } from 'vitest';
import { makeService } from './helpers.js';
import { WatchlistError } from '../src/main/services/watchlist-service.js';

describe('WatchlistService — CRUD', () => {
  it('ensures a Default watchlist exists on init (FR-1.3)', () => {
    const { service } = makeService();
    const lists = service.list();
    expect(lists).toHaveLength(1);
    expect(lists[0]!.name).toBe('Default');
    expect(lists[0]!.isDefault).toBe(true);
  });

  it('creates a new watchlist with a unique name', () => {
    const { service } = makeService();
    const wl = service.create('Tech Megacaps');
    expect(wl.id).toBeGreaterThan(0);
    expect(wl.name).toBe('Tech Megacaps');
    expect(wl.isDefault).toBe(false);
  });

  it('rejects an empty name', () => {
    const { service } = makeService();
    expect(() => service.create('   ')).toThrow(WatchlistError);
  });

  it('enforces case-insensitive name uniqueness (FR-1.1)', () => {
    const { service } = makeService();
    service.create('Tech');
    expect(() => service.create('tech')).toThrowError(/already exists/);
    expect(() => service.create('TECH')).toThrowError(/already exists/);
  });

  it('preserves user casing on create and rename', () => {
    const { service } = makeService();
    const wl = service.create('My Watchlist');
    expect(wl.name).toBe('My Watchlist');
    const renamed = service.rename(wl.id, 'My WATCHLIST');
    expect(renamed.name).toBe('My WATCHLIST');
  });

  it('renames a watchlist (FR-1.2)', () => {
    const { service } = makeService();
    const wl = service.create('Old');
    const renamed = service.rename(wl.id, 'New');
    expect(renamed.name).toBe('New');
  });

  it('rename to the same name is a no-op', () => {
    const { service } = makeService();
    const wl = service.create('SameName');
    const renamed = service.rename(wl.id, 'SameName');
    expect(renamed.name).toBe('SameName');
  });

  it('rejects rename if it would collide with another watchlist', () => {
    const { service } = makeService();
    service.create('A');
    const b = service.create('B');
    expect(() => service.rename(b.id, 'a')).toThrowError(/already exists/);
  });

  it('deletes a non-default watchlist', () => {
    const { service } = makeService();
    const wl = service.create('Tmp');
    service.delete(wl.id);
    expect(service.list()).toHaveLength(1); // only Default remains
  });

  it('refuses to delete the Default watchlist (FR-1.3)', () => {
    const { service } = makeService();
    const def = service.list().find((w) => w.isDefault)!;
    expect(() => service.delete(def.id)).toThrowError(/Default watchlist cannot be deleted/);
  });

  it('allows renaming the Default watchlist (FR-1.3)', () => {
    const { service } = makeService();
    const def = service.list().find((w) => w.isDefault)!;
    const renamed = service.rename(def.id, 'My Defaults');
    expect(renamed.name).toBe('My Defaults');
    expect(renamed.isDefault).toBe(true);
  });

  it('returns NOT_FOUND for missing ids', () => {
    const { service } = makeService();
    expect(() => service.get(9999)).toThrowError(/not found/i);
  });
});

describe('WatchlistService — items', () => {
  it('adds and lists items', () => {
    const { service } = makeService();
    const wl = service.create('T');
    service.addItem(wl.id, 'aapl');
    service.addItem(wl.id, 'MSFT', 'core position');
    const items = service.listItems(wl.id);
    expect(items.map((i) => i.ticker)).toEqual(['AAPL', 'MSFT']);
    expect(items.find((i) => i.ticker === 'MSFT')!.notes).toBe('core position');
  });

  it('rejects invalid tickers (FR-1.5)', () => {
    const { service } = makeService();
    const wl = service.create('T');
    expect(() => service.addItem(wl.id, '???')).toThrowError(/not a valid ticker/);
    expect(() => service.addItem(wl.id, '')).toThrowError(/not a valid ticker/);
    // Unchanged list
    expect(service.listItems(wl.id)).toHaveLength(0);
  });

  it('rejects duplicate tickers within the same watchlist', () => {
    const { service } = makeService();
    const wl = service.create('T');
    service.addItem(wl.id, 'AAPL');
    expect(() => service.addItem(wl.id, 'aapl')).toThrowError(/already in this watchlist/);
  });

  it('allows the same ticker in different watchlists', () => {
    const { service } = makeService();
    const a = service.create('A');
    const b = service.create('B');
    service.addItem(a.id, 'AAPL');
    service.addItem(b.id, 'AAPL');
    expect(service.listItems(a.id)).toHaveLength(1);
    expect(service.listItems(b.id)).toHaveLength(1);
  });

  it('removes selected items in one action (FR-1.6)', () => {
    const { service } = makeService();
    const wl = service.create('T');
    const a = service.addItem(wl.id, 'AAPL');
    const m = service.addItem(wl.id, 'MSFT');
    service.addItem(wl.id, 'NVDA');
    const removed = service.removeItems(wl.id, [a.id, m.id]);
    expect(removed).toBe(2);
    expect(service.listItems(wl.id).map((i) => i.ticker)).toEqual(['NVDA']);
  });

  it('cascade-deletes items when the watchlist is deleted', () => {
    const { service, db } = makeService();
    const wl = service.create('T');
    service.addItem(wl.id, 'AAPL');
    service.delete(wl.id);
    const count = db.prepare('SELECT COUNT(*) AS c FROM watchlist_items').get() as
      | { c: number }
      | undefined;
    expect(count?.c).toBe(0);
  });

  it('bulk add reports skipped rows without aborting', () => {
    const { service } = makeService();
    const wl = service.create('T');
    const result = service.addItemsBulk(wl.id, [
      { ticker: 'AAPL' },
      { ticker: '???' },
      { ticker: 'MSFT' },
      { ticker: 'aapl' } // dup of first
    ]);
    expect(result.added).toHaveLength(2);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.ticker)).toEqual(['???', 'aapl']);
    expect(service.listItems(wl.id).map((i) => i.ticker).sort()).toEqual(['AAPL', 'MSFT']);
  });
});

describe('WatchlistService — itemCount', () => {
  it('reports correct itemCount per watchlist', () => {
    const { service } = makeService();
    const wl = service.create('T');
    service.addItem(wl.id, 'AAPL');
    service.addItem(wl.id, 'MSFT');
    const refreshed = service.list().find((w) => w.id === wl.id)!;
    expect(refreshed.itemCount).toBe(2);
  });
});
