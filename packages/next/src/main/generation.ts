import { app } from 'electron';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyDictionary,
  assertNotRedirected,
  DICTIONARY_VERSION,
  etTimestamp,
  performReset,
  recordCloseHandle,
  recordOpenHandle,
  type ResetReport,
  type SqliteLike
} from '@tradeanalyzer/core';
import { operatorHost } from './operator.js';

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
  /** The generation a reset replaced, or null for a first generation. */
  readonly predecessorNo: number | null;
  readonly resetReason: string | null;
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
 * Creates or opens one generation's database, schema applied and self-described.
 *
 * **The only place this application makes a SQLite handle on a generation**,
 * shared by the startup open and by a reset's successor — so both go through
 * the same redirect guard, the same pragmas and the same `meta_generation`
 * row. A reset that opened its new generation by some second route would be
 * the one path that forgot the guard, which is the shape of every
 * dev-script incident in this project.
 */
function openGenerationDb(
  dataRoot: string,
  generationNo: number
): { db: Database.Database; dbPath: string; archivePath: string; createdNow: boolean } {
  const dir = generationDir(dataRoot, generationNo);
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

  // ET, never `toISOString()`. Every timestamp in a generation carries the
  // America/New_York offset (02 §0.1), and UTC is indistinguishable from it at a
  // glance while being a day out every evening. This line WAS `toISOString()`,
  // and it put `2026-09-07 23:02 ET` into the forensic record of a corruption as
  // `2026-09-08T03:02:53Z`, next to a collector row that was correctly in ET.
  db.prepare(
    `INSERT INTO meta_generation (generation_no, opened_at, status, db_path, archive_path)
     VALUES (?, ?, 'pilot', ?, ?)
     ON CONFLICT(generation_no) DO NOTHING`
  ).run(generationNo, etTimestamp(), dbPath, archivePath);

  return { db, dbPath, archivePath, createdNow };
}

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
  const { db, dbPath, archivePath, createdNow } = openGenerationDb(pointer.dataRoot, pointer.currentGeneration);

  const row = db
    .prepare(
      `SELECT generation_no, opened_at, status, predecessor_no, reset_reason
         FROM meta_generation WHERE generation_no = ?`
    )
    .get(pointer.currentGeneration) as {
    generation_no: number;
    opened_at: string;
    status: GenerationInfo['status'];
    predecessor_no: number | null;
    reset_reason: string | null;
  };

  // Says, inside the generation itself, which application saw which file. The
  // guard above prevents the split we understand; this is what makes any other
  // one visible instead of silent.
  recordOpenHandle(db as unknown as SqliteLike, {
    appName: 'TradeAnalyzer 2',
    appVersion: app.getVersion(),
    dbPath,
    dictionaryVersion: DICTIONARY_VERSION,
    openedAt: etTimestamp(),
    processId: process.pid
  });

  writePointer(pointer);

  // Durable NOW, not at some future close. The other application reads this file
  // on a 2-minute tick, so "the generation exists and here is who opened it" has
  // to be a fact on disk the moment it is true — not something held in a WAL that
  // a shutdown might discard. The read-back is deliberate: it reports what the
  // file holds rather than what we believe we wrote, which is the distinction
  // that cost most of 2026-09-07.
  checkpoint(db, 'startup');
  const persisted = db.prepare('SELECT COUNT(*) AS n FROM meta_generation').get() as { n: number };
  console.log(`[next] meta_generation rows after checkpoint: ${persisted.n}`);

  const info: GenerationInfo = {
    generationNo: row.generation_no,
    status: row.status,
    openedAt: row.opened_at,
    dbPath,
    archivePath,
    dataRoot: pointer.dataRoot,
    dictionaryVersion: DICTIONARY_VERSION,
    createdNow,
    predecessorNo: row.predecessor_no,
    resetReason: row.reset_reason
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

/**
 * Resets the current generation — 04 §7.6, AC-14 — and reopens on the new one.
 *
 * `core`'s `performReset` owns the order and the refusals; this supplies the
 * two file-shaped steps. **The successor must not already exist**: a leftover
 * `gen-(N+1)` from an earlier reset that died before moving the pointer holds
 * whatever that attempt wrote, and "resetting" into it would start the new
 * generation with data nobody chose. The refusal names the path so the
 * operator can look at it and decide.
 *
 * Executed here rather than queued to the old app: generation creation belongs
 * to this application alone, and a reset calls no provider (see `core`'s
 * `reset.ts` for the whole argument).
 */
export function resetCurrentGeneration(reason: string, confirmation: string): ResetReport {
  if (!handle) throw new Error('No generation is open.');
  const { db, info } = handle;

  // A holder rather than a `let`: the assignment happens inside a callback,
  // which control-flow analysis cannot see, so a plain variable would read as
  // never assigned in the `finally`.
  const successor: { db?: Database.Database } = {};

  let report: ResetReport;
  try {
    report = performReset({
      db: db as unknown as SqliteLike,
      host: operatorHost(),
      generationNo: info.generationNo,
      reason,
      confirmation,
      openSuccessor: (no) => {
        const target = join(generationDir(info.dataRoot, no), 'data.sqlite');
        if (existsSync(target)) {
          throw new Error(
            `gen-${String(no).padStart(3, '0')} already exists at ${target}. A reset opens a generation ` +
              'that holds nothing, and this one holds whatever an earlier attempt wrote — so it was not ' +
              'touched. Look at it, then move it aside if it is not wanted.'
          );
        }
        successor.db = openGenerationDb(info.dataRoot, no).db;
        return successor.db as unknown as SqliteLike;
      },
      commitPointer: (no) => {
        // The successor's rows are on disk before anything points at it.
        if (successor.db) checkpoint(successor.db, 'reset successor');
        writePointer({ dataRoot: info.dataRoot, currentGeneration: no });
      }
    });
  } finally {
    if (successor.db?.open) {
      checkpoint(successor.db, 'reset successor close');
      successor.db.close();
    }
  }

  // Hand over: close the predecessor (stamping the close), then open through the
  // pointer, which now names the successor. No restart (04 §7.6).
  closeGeneration();
  openGeneration();
  return report;
}

/**
 * Makes this connection's writes durable in `data.sqlite`, and says what
 * happened.
 *
 * **Never leave the hand-off to close-time semantics.** Two applications share
 * this file, and "SQLite checkpoints when the last connection closes" turned out
 * not to be something that could be relied on here: measured 2026-09-07, TA2
 * wrote a 918,792-byte WAL, a second process read the committed rows out of it,
 * and on close the WAL was **deleted with `data.sqlite` byte-for-byte unchanged**
 * — 1,212,416 bytes, same mtime, across every cycle. The whole startup write was
 * silently discarded, which read as "the collector lost my generation".
 *
 * `wal_checkpoint(TRUNCATE)` returns `{ busy, log, checkpointed }`: `busy = 1`
 * means it could not finish, and `log > checkpointed` means frames were left
 * behind. Both are logged, because a checkpoint that quietly does nothing is the
 * failure being fixed and it must never be silent again.
 */
function checkpoint(db: Database.Database, when: string): void {
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)') as {
      busy: number;
      log: number;
      checkpointed: number;
    }[];
    const row = result[0];
    console.log(`[next] checkpoint (${when}): ${JSON.stringify(row ?? result)}`);
    if (row && (row.busy !== 0 || row.log !== row.checkpointed)) {
      console.error(
        `[next] checkpoint (${when}) did NOT fully apply: busy=${row.busy}, ` +
          `log=${row.log}, checkpointed=${row.checkpointed}. Writes may not be durable.`
      );
    }
  } catch (err) {
    console.error(`[next] checkpoint (${when}) failed: ${(err as Error).message}`);
  }
}

export function closeGeneration(): void {
  if (!handle) {
    console.log('[next] closeGeneration: nothing open');
    return;
  }
  console.log('[next] closeGeneration: checkpointing and closing');
  checkpoint(handle.db, 'close');
  // Stamped before the close, for the same reason the collector host does it:
  // two open timestamps are consistent with any amount of overlap, so without a
  // close the table cannot say whether both applications held the file at once.
  recordCloseHandle(handle.db as unknown as SqliteLike, {
    appName: 'TradeAnalyzer 2',
    dbPath: handle.info.dbPath ?? '',
    closedAt: etTimestamp()
  });

  handle.db.close();
  handle = undefined;
  console.log('[next] closeGeneration: closed');
}
