import { app } from 'electron';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyDictionary,
  assertNotRedirected,
  DICTIONARY_VERSION,
  recordOpenHandle,
  type SqliteLike
} from '@tradeanalyzer/core';

/**
 * Opening a generation — 06 §3, §3.1.
 *
 * A generation is a self-contained directory: `data.sqlite` plus `archive/`.
 * Backing one up is copying a folder, and resetting one is replacing it — which
 * is the property the whole generation idea exists for (P14, AC-14).
 */

export interface GenerationInfo {
  readonly generationNo: number;
  readonly status: 'pilot' | 'production' | 'closed';
  readonly openedAt: string;
  readonly dbPath: string;
  readonly archivePath: string;
  readonly dataRoot: string;
  readonly dictionaryVersion: number;
  readonly createdNow: boolean;
}

/**
 * The pointer both applications read — 06 §3.1.
 *
 * In stage 1 the collector runs inside the *existing* app and writes the
 * generation; this exe reads it. They must agree where it is, and one small JSON
 * file is the whole of that agreement: no IPC, no socket, no shared process. It
 * holds no secrets.
 */
interface DataRootPointer {
  dataRoot: string;
  currentGeneration: number;
}

export function pointerPath(): string {
  return join(app.getPath('appData'), 'tradeanalyzer-shared', 'data-root.json');
}

export function defaultDataRoot(): string {
  return join(app.getPath('userData'), 'data');
}

export function readPointer(): DataRootPointer | undefined {
  const path = pointerPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DataRootPointer>;
    if (typeof parsed.dataRoot !== 'string' || typeof parsed.currentGeneration !== 'number') {
      // A malformed pointer is reported, never silently replaced: it is the only
      // thing that says where the data is, and overwriting it could orphan a
      // generation the operator still wants.
      throw new Error('data-root.json is present but malformed');
    }
    return { dataRoot: parsed.dataRoot, currentGeneration: parsed.currentGeneration };
  } catch (err) {
    throw new Error(
      `Could not read the shared data-root pointer at ${path}: ${(err as Error).message}. ` +
        'It names where the generation lives and is shared with the collector host, so it is not ' +
        'replaced automatically.'
    );
  }
}

export function writePointer(pointer: DataRootPointer): void {
  const path = pointerPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

export function generationDir(dataRoot: string, generationNo: number): string {
  return join(dataRoot, `gen-${String(generationNo).padStart(3, '0')}`);
}

let handle: { db: Database.Database; info: GenerationInfo } | undefined;

/**
 * Opens the current generation, creating `gen-001` on first run.
 *
 * The dictionary is applied on every open, not only on creation. It is additive
 * and idempotent, so re-applying costs nothing — and it means a generation can
 * never be running against a schema older than the code reading it, which is the
 * failure that would otherwise surface as a mysterious missing column.
 */
export function openGeneration(): GenerationInfo {
  if (handle) return handle.info;

  const pointer = readPointer() ?? { dataRoot: defaultDataRoot(), currentGeneration: 1 };
  const dir = generationDir(pointer.dataRoot, pointer.currentGeneration);
  const dbPath = join(dir, 'data.sqlite');
  const archivePath = join(dir, 'archive');
  const createdNow = !existsSync(dbPath);

  // Before anything is created and long before SQLite is involved: a
  // containerised launch would open a private copy of `data.sqlite` while
  // sharing the real write-ahead log with the other application, which is not a
  // stale read but a corrupted generation (see `assertNotRedirected`). Both the
  // pointer's directory and the generation's are checked, because `dataRoot` is
  // configurable and may sit outside AppData while the pointer never does.
  assertNotRedirected([dirname(pointerPath()), dir], 'TradeAnalyzer 2');

  mkdirSync(archivePath, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // both apps hold this file open (06 §8)
  db.pragma('foreign_keys = ON');

  applyDictionary(db as unknown as SqliteLike);

  const openedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path)
     VALUES (?, ?, 'pilot', ?, ?)
     ON CONFLICT(generation_no) DO NOTHING`
  ).run(pointer.currentGeneration, openedAt, dbPath, archivePath);

  const row = db
    .prepare('SELECT generation_no, opened_at, status FROM meta_generation WHERE generation_no = ?')
    .get(pointer.currentGeneration) as { generation_no: number; opened_at: string; status: GenerationInfo['status'] };

  // Says, inside the generation itself, which application saw which file. The
  // guard above prevents the split we understand; this is what makes any other
  // one visible instead of silent.
  recordOpenHandle(db as unknown as SqliteLike, {
    appName: 'TradeAnalyzer 2',
    appVersion: app.getVersion(),
    dbPath,
    dictionaryVersion: DICTIONARY_VERSION,
    openedAt,
    processId: process.pid
  });

  writePointer(pointer);

  const info: GenerationInfo = {
    generationNo: row.generation_no,
    status: row.status,
    openedAt: row.opened_at,
    dbPath,
    archivePath,
    dataRoot: pointer.dataRoot,
    dictionaryVersion: DICTIONARY_VERSION,
    createdNow
  };
  handle = { db, info };
  return info;
}

export function currentDb(): Database.Database {
  if (!handle) throw new Error('No generation is open.');
  return handle.db;
}

export function currentGeneration(): GenerationInfo {
  if (!handle) throw new Error('No generation is open.');
  return handle.info;
}

export function closeGeneration(): void {
  handle?.db.close();
  handle = undefined;
}
