// Thin wrapper over `better-sqlite3`. We keep `withTransaction` as a small helper so
// the rest of the codebase doesn't depend on better-sqlite3-specific features (the
// `db.transaction(fn)()` pattern). If we ever swap drivers again, this file is the
// only one that has to change.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DbHandle = Database.Database;

export function openDatabase(filePath: string): DbHandle {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Run `fn` inside a transaction. If `fn` throws, the transaction is rolled back
 * and the error propagates. Equivalent to `db.transaction(fn)()` but avoids the
 * driver-specific `.transaction()` higher-order API leaking into callers.
 */
export function withTransaction<T>(db: DbHandle, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
