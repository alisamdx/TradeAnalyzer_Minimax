// Thin wrapper over Node's built-in `node:sqlite`. The wrapper exists so we can swap to
// better-sqlite3 later (when the dev box has Visual Studio Build Tools or better-sqlite3
// publishes a Node-24 prebuilt) by changing only this file.
//
// We pull `node:sqlite` via createRequire instead of a static import because Vite/Vitest's
// resolver has trouble with the `node:` prefix in some configurations.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export type DbHandle = InstanceType<typeof DatabaseSync>;

export function openDatabase(filePath: string): DbHandle {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Run `fn` inside a transaction. Mimics better-sqlite3's `db.transaction(fn)()`.
 * If `fn` throws, the transaction is rolled back and the error propagates.
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
