import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DbHandle } from './connection.js';
import { withTransaction } from './connection.js';

const MIGRATION_FILE_RE = /^(\d{3,})_.+\.sql$/;

export interface MigrationFile {
  version: number;
  fileName: string;
  fullPath: string;
}

export function listMigrations(migrationsDir: string): MigrationFile[] {
  return readdirSync(migrationsDir)
    .map((fileName) => {
      const match = MIGRATION_FILE_RE.exec(fileName);
      if (!match) return null;
      return {
        version: parseInt(match[1]!, 10),
        fileName,
        fullPath: join(migrationsDir, fileName)
      } satisfies MigrationFile;
    })
    .filter((m): m is MigrationFile => m !== null)
    .sort((a, b) => a.version - b.version);
}

function ensureSchemaVersionTable(db: DbHandle): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

export function appliedVersions(db: DbHandle): Set<number> {
  ensureSchemaVersionTable(db);
  const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

/**
 * Applies any pending migrations from `migrationsDir` against `db`.
 * Each migration runs inside a transaction so partial application can't leave
 * the DB inconsistent.
 */
export function runMigrations(db: DbHandle, migrationsDir: string): number[] {
  const all = listMigrations(migrationsDir);
  const applied = appliedVersions(db);
  const ranNow: number[] = [];

  for (const m of all) {
    if (applied.has(m.version)) continue;
    const sql = readFileSync(m.fullPath, 'utf8');
    withTransaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    });
    ranNow.push(m.version);
  }
  return ranNow;
}

export function currentSchemaVersion(db: DbHandle): number {
  ensureSchemaVersionTable(db);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | null }
    | undefined;
  return row?.version ?? 0;
}
