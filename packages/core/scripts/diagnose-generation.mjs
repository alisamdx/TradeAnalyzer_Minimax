#!/usr/bin/env node
/**
 * Says what the generation actually is, from the shell you run it in.
 *
 *   node packages/core/scripts/diagnose-generation.mjs
 *
 * Exists because "which file is this process really looking at" turned out to be
 * the hardest question of 2026-09-07, and inference was repeatedly wrong about
 * it. A containerised shell has `%APPDATA%` redirected without saying so, a
 * readonly SQLite handle on Windows reads a stale WAL snapshot, and the queue
 * script and the app can disagree while both appear correct. So this reports
 * observations rather than conclusions: the pointer, the derived path, what is
 * on disk, and what the schema holds — plus any *other* generation directory it
 * can find, because two of them is the failure that started all of this.
 *
 * Uses **`better-sqlite3`** — the same SQLite both applications use — and refuses
 * while either has the generation open. It used to use `node:sqlite` so it would
 * work whichever ABI the native module currently carried; that convenience is
 * what made it dangerous. `node:sqlite` bundles SQLite 3.51.3 and
 * `better-sqlite3` bundles 3.53.1, the wal-index format is not guaranteed
 * compatible across versions, and running this tool against a live generation
 * was part of corrupting `meta_response` twice on 2026-09-07. **A diagnostic
 * that damages what it inspects is worse than no diagnostic.** After
 * `npm run package` it needs `npm run rebuild:node`, and it says so.
 *
 * **Run it from an ordinary shell, never a redirected one.** Opening a WAL
 * database from a process whose `%APPDATA%` is redirected is not a read: on
 * close SQLite checkpoints the WAL into whatever `data.sqlite` *that* process
 * can see — the private copy — and then removes the shared WAL. The original is
 * left as a bare header page with no schema, and the data now lives in a copy
 * nobody else will ever open. That happened on 2026-09-07 and it cost a
 * generation. The redirect check above is not a nicety; it is the guard.
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkpointAndClose, openGenerationExclusively } from './lib/generation-access.mjs';

// One implementation of the probe, shared with `queue-job.mjs` and — the part
// that actually matters — with both applications, which call it before they open
// a generation.
let detectRedirect;
try {
  ({ detectRedirect } = await import('../dist/db/appdata-redirect.js'));
} catch {
  console.error(
    'packages/core is not built, so the redirect guard cannot be loaded — and opening a\n' +
      'generation without it is how one gets destroyed. Build it first:\n' +
      '  npm run build --prefix packages/core'
  );
  process.exit(2);
}

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
console.log(`APPDATA           : ${appData}`);

// The redirect is invisible from the inside, so it is measured, not guessed.
const finding = detectRedirect(appData);
const redirect = finding.redirectedTo;
console.log(
  `redirected        : ${redirect ?? `no (this shell writes where it says it does)${finding.undetermined ? ` — ${finding.undetermined}` : ''}`}`
);

/** Whether WAL sidecars existed BEFORE this script opened anything. */
let sidecarsBefore = false;

const pointerPath = join(appData, 'tradeanalyzer-shared', 'data-root.json');
console.log(`pointer path      : ${pointerPath}`);
if (!existsSync(pointerPath)) {
  console.log('pointer           : MISSING — run TradeAnalyzer 2 once to create the generation.');
  process.exit(1);
}
const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
console.log(`pointer contents  : ${JSON.stringify(pointer)}`);

const genDir = join(pointer.dataRoot, `gen-${String(pointer.currentGeneration).padStart(3, '0')}`);
const dbPath = join(genDir, 'data.sqlite');
console.log(`derived db path   : ${dbPath}`);
console.log(`  exists          : ${existsSync(dbPath)}`);
if (existsSync(dbPath)) {
  const st = statSync(dbPath);
  console.log(`  size            : ${st.size} bytes`);
  console.log(`  modified        : ${st.mtime.toISOString()}`);

  // Reporting only the main file is misleading, and it misled once already. In
  // WAL mode a freshly created database keeps its schema in `-wal` until a
  // checkpoint, so `data.sqlite` can sit at a single 4,096-byte header page
  // while the whole schema exists. A present `-shm` means some process has the
  // database OPEN right now, which is usually the thing you actually wanted to
  // know.
  for (const suffix of ['-wal', '-shm']) {
    const side = `${dbPath}${suffix}`;
    if (existsSync(side)) sidecarsBefore = true;
    console.log(
      `  ${suffix.padEnd(16)}: ${existsSync(side) ? `${statSync(side).size} bytes` : 'absent'}`
    );
  }
  if (existsSync(`${dbPath}-shm`)) {
    console.log('  (a -shm file means the database is open in another process right now)');
  }
}

// Every generation directory under the data root, because the whole point is to
// notice a second one.
if (existsSync(pointer.dataRoot)) {
  const gens = readdirSync(pointer.dataRoot).filter((d) => d.startsWith('gen-'));
  console.log(`generations found : ${gens.join(', ') || '(none)'}`);
}

if (!existsSync(dbPath)) {
  console.log('\nNo database at the derived path. Launch TradeAnalyzer 2 to create it.');
  process.exit(1);
}

// Refusing rather than warning, because opening it is the harm. A WAL database
// opened from a redirected process is checkpointed on close into the copy THAT
// process can see, and the shared WAL is then removed — leaving the original a
// bare header page and the data in a copy nobody will open again. This is not a
// hypothetical: it cost a generation on 2026-09-07, and it happened while
// running this very script to find out why the generation looked empty.
if (redirect) {
  console.log('\nRefusing to open the database: this shell is redirected, and opening a WAL');
  console.log(`database from here MOVES it — the checkpoint lands in ${redirect}`);
  console.log('and the shared WAL is deleted. Run this from an ordinary terminal instead.');
  process.exit(3);
}

// Same SQLite the applications use, and only when none of them has it open.
// This tool was itself part of the corruption on 2026-09-07: run against a live
// generation it put a second SQLite library on the same wal-index. A diagnostic
// that damages what it inspects is worse than no diagnostic.
const db = openGenerationExclusively(dbPath);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`\ntables            : ${tables.length}`);

if (tables.length === 0) {
  console.log('\nThis connection sees NO SCHEMA.');
  // `sidecarsBefore`, not a fresh existsSync: opening the database above CREATES
  // `-wal` and `-shm`, so checking now always says they are present and the
  // advice is always "close the reader and try again" — which is wrong, and was
  // wrong the first time it mattered.
  if (sidecarsBefore) {
    console.log('A `-wal` was present with no `-shm`, so the schema is in an unreplayed write-ahead');
    console.log('log left by an unclean exit. Start TradeAnalyzer 2 once and close it — that replays');
    console.log('and checkpoints it — BEFORE concluding the database is empty.');
    process.exit(1);
  }
  console.log('No sidecars either, so something created the file without applying the');
  console.log('dictionary — most likely a process that opened the path before TradeAnalyzer 2 did.');
  console.log('Delete the generation directory and launch TradeAnalyzer 2 first:');
  console.log(`  Remove-Item -Recurse -Force "${genDir}"`);
  process.exit(1);
}

// Integrity before counts. Without this a corrupt file reports plausible
// numbers for the first few tables and then throws mid-loop, which reads as "the
// script broke" rather than "the database is damaged" — and the numbers already
// printed look like findings.
const integrity = db.prepare('PRAGMA integrity_check').get();
const integrityResult = Object.values(integrity)[0];
if (integrityResult !== 'ok') {
  console.log(`\nintegrity_check   : ${String(integrityResult).slice(0, 400)}`);
  console.log('\n** THIS DATABASE IS CORRUPT. ** Row counts above, if any, are not evidence.');
  console.log('Nothing here is recoverable in place. Close both applications, delete the');
  console.log('generation directory, and let TradeAnalyzer 2 recreate it:');
  console.log(`  Remove-Item -Recurse -Force "${genDir}"`);
  checkpointAndClose(db);
  process.exit(2);
}
console.log('integrity_check   : ok');

const interesting = [
  'meta_generation', 'meta_run', 'meta_job_request', 'meta_response',
  'ref_trading_day', 'ref_universe_membership', 'raw_ticker_reference', 'raw_daily_bar'
];
console.log('\nrow counts:');
for (const t of interesting) {
  if (!tables.includes(t)) { console.log(`  ${t.padEnd(26)} TABLE MISSING`); continue; }
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  console.log(`  ${t.padEnd(26)} ${n}`);
}

// Which applications have opened THIS file, in their own words. The question
// that cost most of 2026-09-07 was "are the two apps looking at the same
// database", and it was answered by inference every time, wrongly. Both exes now
// write a row here on open, so it is answered by reading.
if (tables.includes('meta_open_handle')) {
  const handles = db
    .prepare('SELECT app_name, app_version, opened_at, process_id, db_path FROM meta_open_handle ORDER BY app_name')
    .all();
  console.log('\nopened by:');
  if (handles.length === 0) console.log('  (nothing has opened this generation since the handle table existed)');
  for (const h of handles) {
    console.log(`  ${h.app_name} v${h.app_version}  pid ${h.process_id}  ${h.opened_at}`);
    if (h.db_path !== dbPath) console.log(`    ** resolved a DIFFERENT path: ${h.db_path} **`);
  }
  if (handles.length === 1) {
    console.log('  Only one application has opened this file. If both have been run since this');
    console.log('  version was installed, they are not sharing a generation — check for a redirect.');
  }
}

if (tables.includes('meta_job_request')) {
  const rows = db
    .prepare('SELECT request_id, run_kind, state, error FROM meta_job_request ORDER BY request_id')
    .all();
  console.log('\njob requests:');
  if (rows.length === 0) console.log('  (none)');
  for (const r of rows) {
    console.log(`  #${r.request_id} ${r.run_kind} -> ${r.state}${r.error ? ` (${String(r.error).slice(0, 90)})` : ''}`);
  }
}

// The check that would have caught the wrong universe on the day it happened:
// content, not status code.
if (tables.includes('ref_universe_membership')) {
  const total = db
    .prepare('SELECT COUNT(DISTINCT ticker) AS n FROM ref_universe_membership WHERE valid_to IS NULL')
    .get().n;
  const bellwethers = ['MSFT', 'NVDA', 'SPY', 'TSLA', 'AAPL'];
  const present = bellwethers.filter(
    (t) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM ref_universe_membership WHERE ticker = ? AND valid_to IS NULL')
        .get(t).n > 0
  );
  console.log(`\nactive universe   : ${total} distinct tickers`);
  console.log(`  bellwethers     : ${present.join(', ') || 'NONE PRESENT'} (of ${bellwethers.join(', ')})`);
  if (total > 0 && present.length < bellwethers.length) {
    console.log('  ** A universe missing these is not the index lists. Check the seed sources. **');
  }
}

checkpointAndClose(db);
