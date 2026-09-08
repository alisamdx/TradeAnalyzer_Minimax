#!/usr/bin/env node
/**
 * Does SQLite survive a `universe_seed`-shaped write load in THIS directory?
 *
 *   node packages/core/scripts/stress-sqlite.mjs "C:\\some\\dir"
 *
 * Written 2026-09-07 after `meta_response` was corrupted three times
 * (`btreeInitPage() returns error code 11`) and two confident diagnoses were
 * wrong: the MSIX redirect (a real bug, but the corruption recurred after it was
 * guarded) and mixing `node:sqlite` with `better-sqlite3` (also real, also
 * recurred once fixed).
 *
 * **This deliberately involves none of the application code.** One process, one
 * library, no Electron, no collector — just the write shape the seed produces:
 * ~1,100 single-row transactions into a table with a UNIQUE index, in WAL mode.
 * If that corrupts, the fault is the environment (the path, the filesystem, a
 * scanner or sync agent touching the file) and no amount of application work
 * will fix it. If it stays clean here and the real seed still corrupts, the
 * fault is in how the applications use the database, and this rules out the
 * ground beneath it.
 *
 * Run it in **two** places — the generation's own directory and somewhere
 * unrelated, e.g. `C:\\temp` — because a pass on its own says much less than a
 * pass and a fail side by side. That is the whole point: a single arm cannot
 * distinguish "this location is fine" from "this test is too weak".
 *
 * It writes `stress-<pid>.sqlite*` and deletes them again. It never opens, reads
 * or touches `data.sqlite`.
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dir = process.argv[2];
const rounds = Number(process.argv[3] ?? 1100);

/**
 * Milliseconds between writes.
 *
 * Not cosmetic. The seed's ~1,090 writes are each preceded by a network call, so
 * it spans MINUTES; without a delay this test finishes in well under a second
 * and cannot reproduce anything that depends on a file being written slowly over
 * a long window — which is precisely the shape of interference from a scanner,
 * a sync client or a backup agent. A fast pass proves much less than it looks.
 */
const delayMs = Number(process.argv[4] ?? 0);

if (!dir) {
  console.error('Usage: node packages/core/scripts/stress-sqlite.mjs <directory> [rows] [delayMs]');
  console.error('  e.g. ... "%APPDATA%\trade-analyzer-next\data\gen-001" 1100 250');
  process.exit(2);
}

let Database;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  const abi = err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message));
  console.error(
    abi
      ? 'better-sqlite3 is built for Electron right now. Run `npm run rebuild:node` first.'
      : `Could not load better-sqlite3: ${err?.message ?? String(err)}`
  );
  process.exit(6);
}

mkdirSync(dir, { recursive: true });
const dbPath = join(dir, `stress-${process.pid}.sqlite`);
for (const s of ['', '-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true });

console.log(`directory : ${dir}`);
console.log(`database  : ${dbPath}`);
console.log(`rows      : ${rounds}${delayMs ? ` (${delayMs}ms apart, ~${Math.round((rounds * delayMs) / 60000)} min)` : ' (as fast as possible)'}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Shaped like `meta_response`: the table all three corruptions landed in. The
// UNIQUE index matters — it is a second btree taking an insert per row, and
// `capture.ts` probes it by `dedup_hash` before every write.
db.exec(`
  CREATE TABLE stress_response (
    source_response_id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    params_json TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    responded_at TEXT,
    http_status INTEGER,
    byte_length INTEGER NOT NULL,
    archive_file TEXT NOT NULL,
    archive_offset INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    dedup_hash TEXT NOT NULL UNIQUE,
    parse_status TEXT NOT NULL,
    parsed_row_count INTEGER NOT NULL
  );
`);

const probe = db.prepare('SELECT source_response_id FROM stress_response WHERE dedup_hash = ?');
const insert = db.prepare(
  `INSERT INTO stress_response (
     run_id, provider, endpoint, params_json, requested_at, responded_at, http_status,
     byte_length, archive_file, archive_offset, sha256, dedup_hash, parse_status, parsed_row_count
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const started = Date.now();
for (let i = 0; i < rounds; i++) {
  if (delayMs > 0) sleep(delayMs);
  const hash = `${'0'.repeat(48)}${String(i).padStart(16, '0')}`;
  // One transaction per response, exactly as the capture contract does it.
  db.transaction(() => {
    probe.get(hash);
    insert.run(
      1,
      'polygon',
      `/v3/reference/tickers/SYM${i}`,
      JSON.stringify({ ticker: `SYM${i}` }),
      new Date().toISOString(),
      new Date().toISOString(),
      200,
      2048,
      `polygon/2026-09-07/reference-tickers.jsonl`,
      i * 2048,
      hash.slice(0, 64),
      hash,
      'ok',
      1
    );
  })();
  if (i % 200 === 0 && i > 0) process.stdout.write(`  ${i}\r`);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const walBefore = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;

// The checkpoint is reported, not assumed. A checkpoint that quietly applies
// nothing is one of the unexplained behaviours this exists to catch: on
// 2026-09-07 a 918,792-byte WAL vanished with the main file byte-for-byte
// unchanged.
const [ck] = db.pragma('wal_checkpoint(TRUNCATE)');
const integrity = db.prepare('PRAGMA integrity_check').get();
const verdict = Object.values(integrity)[0];
const rows = db.prepare('SELECT COUNT(*) AS n FROM stress_response').get().n;

console.log(`\nwrote     : ${rows} rows in ${elapsed}s (WAL peaked at ${walBefore} bytes)`);
console.log(`checkpoint: ${JSON.stringify(ck)}`);
console.log(`integrity : ${String(verdict).slice(0, 300)}`);

db.close();

// Re-open cold and check again. The first check ran on the connection that did
// the writing and therefore shares its page cache; a fresh handle reads what the
// file actually holds. That distinction is the one that kept being lost tonight.
const reopened = new Database(dbPath);
const coldVerdict = Object.values(reopened.prepare('PRAGMA integrity_check').get())[0];
const coldRows = reopened.prepare('SELECT COUNT(*) AS n FROM stress_response').get().n;
console.log(`cold read : ${coldRows} rows, integrity ${String(coldVerdict).slice(0, 300)}`);
reopened.close();

for (const s of ['', '-wal', '-shm']) rmSync(`${dbPath}${s}`, { force: true });

const ok = verdict === 'ok' && coldVerdict === 'ok' && coldRows === rounds;
console.log(`\nVERDICT   : ${ok ? 'CLEAN' : '*** FAILED IN THIS DIRECTORY ***'}`);
process.exit(ok ? 0 : 1);
