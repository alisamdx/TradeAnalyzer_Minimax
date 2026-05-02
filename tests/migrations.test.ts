import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations, currentSchemaVersion, listMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

describe('migrations', () => {
  it('discovers numbered migration files in order', () => {
    const found = listMigrations(MIGRATIONS_DIR);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]!.version).toBe(1);
  });

  it('applies migrations to a fresh in-memory db and records the version', () => {
    const db = openDatabase(':memory:');
    const ran = runMigrations(db, MIGRATIONS_DIR);
    expect(ran).toEqual([1]);
    expect(currentSchemaVersion(db)).toBe(1);
  });

  it('is idempotent — running twice does not re-apply', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const second = runMigrations(db, MIGRATIONS_DIR);
    expect(second).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(1);
  });

  it('creates the expected core tables', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain('watchlists');
    expect(names).toContain('watchlist_items');
    expect(names).toContain('settings');
    expect(names).toContain('schema_version');
  });
});
