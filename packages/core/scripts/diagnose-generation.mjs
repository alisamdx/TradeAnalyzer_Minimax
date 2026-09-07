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
 * Uses `node:sqlite`, so it works whichever ABI `better-sqlite3` currently
 * carries (CLAUDE.md).
 */
import { existsSync, readFileSync, statSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
console.log(`APPDATA           : ${appData}`);

// The redirect is invisible from the inside, so it is measured, not guessed.
const marker = `.diagnose-probe-${process.pid}`;
let redirect = null;
try {
  writeFileSync(join(appData, marker), 'probe', 'utf8');
  const packages = join(homedir(), 'AppData', 'Local', 'Packages');
  if (existsSync(packages)) {
    for (const pkg of readdirSync(packages)) {
      if (existsSync(join(packages, pkg, 'LocalCache', 'Roaming', marker))) {
        redirect = join(packages, pkg, 'LocalCache', 'Roaming');
        break;
      }
    }
  }
} catch { /* reported below as "could not test" */ } finally {
  try { rmSync(join(appData, marker), { force: true }); } catch { /* best effort */ }
}
console.log(`redirected        : ${redirect ?? 'no (this shell writes where it says it does)'}`);

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

const db = new DatabaseSync(dbPath);
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log(`\ntables            : ${tables.length}`);

if (tables.length === 0) {
  console.log('\nThe file exists but has NO SCHEMA. Something created it without applying the');
  console.log('dictionary — most likely a process that opened the path before TradeAnalyzer 2 did.');
  console.log('Delete the generation directory and launch TradeAnalyzer 2 first:');
  console.log(`  Remove-Item -Recurse -Force "${genDir}"`);
  process.exit(1);
}

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

db.close();
