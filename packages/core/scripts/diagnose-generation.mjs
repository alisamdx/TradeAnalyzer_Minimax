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
import { dirname, join } from 'node:path';
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



/**
 * An explicit generation to inspect, instead of the one the pointer names.
 *
 *   node packages/core/scripts/diagnose-generation.mjs "<dir-or-data.sqlite>"
 *
 * Added 2026-09-09 for the obvious gap: a **retired** generation — the whole
 * point of renaming a corrupt one aside rather than deleting it — was
 * unreachable by the only tool that can read it, because the path came solely
 * from the pointer. Every guard still applies; this changes which file is
 * examined, never whether it may be.
 */
const argPath = process.argv[2];

let pointer;
let genDir;

if (argPath) {
  genDir = argPath.toLowerCase().endsWith('.sqlite') ? dirname(argPath) : argPath;
  pointer = { dataRoot: dirname(genDir), currentGeneration: null, explicit: true };
  console.log(`pointer path      : (not used — explicit path given)`);
  console.log(`explicit target   : ${genDir}`);
} else {
  const pointerPath = join(appData, 'tradeanalyzer-shared', 'data-root.json');
  console.log(`pointer path      : ${pointerPath}`);
  if (!existsSync(pointerPath)) {
    console.log('pointer           : MISSING — run TradeAnalyzer 2 once to create the generation.');
    process.exit(1);
  }
  pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  console.log(`pointer contents  : ${JSON.stringify(pointer)}`);
  genDir = join(pointer.dataRoot, `gen-${String(pointer.currentGeneration).padStart(3, '0')}`);
}

// The redirect is invisible from the inside, so it is measured, not guessed —
// and measured against **the directory this run will actually read**, not
// against `%APPDATA%` globally. The redirect is per file: an explicit target
// under `C:\temp` is not redirected by anything, and refusing to look at it
// because some *other* directory is would make a retired generation
// un-examinable from the one shell that has it. Same correction as
// `lib/generation-access.mjs` — probe what you resolved.
const probeDir = argPath ? genDir : appData;
const finding = detectRedirect(probeDir);
const redirect = finding.redirectedTo;
console.log(`probing           : ${probeDir}`);
console.log(
  `redirected        : ${redirect ?? `no (this shell writes where it says it does)${finding.undetermined ? ` — ${finding.undetermined}` : ''}`}`
);

// ── Stop HERE when redirected, before reporting a single fact about the
// generation (v1.1.207) ──────────────────────────────────────────────────────
//
// This script used to refuse further down, just before opening the database,
// and print the pointer, the derived path, the file size, the sidecars and the
// generation list on the way. Every one of those is read through `%APPDATA%`,
// and under a redirect `%APPDATA%` is served from the container — so once the
// container holds a copy-on-written shadow of a file, those lines describe the
// SHADOW and say nothing whatever about the real generation.
//
// Measured 2026-09-09: this script reported `data.sqlite` at 1,789,952 bytes
// modified 2026-09-07 23:05 with no sidecars, and the container's own copy is
// byte-for-byte that same size and timestamp — while the collector had run
// against the real file the following evening. **The report was a confident,
// authoritative description of the wrong file.**
//
// Not printing them is the fix. A diagnostic that cannot see its subject must
// say so and stop; the one thing it must never do is describe something else in
// the same format and leave the reader to notice.
if (redirect) {
  console.log(
    [
      '',
      'REFUSING — and not reporting anything about the generation either.',
      '',
      `This shell is containerised: everything it reads under ${appData} is served from`,
      `  ${redirect}`,
      'so the pointer, the database size, the sidecars and the generation list would all be',
      'facts about the container\'s private copy, not about the real generation. Printing them',
      'would be worse than printing nothing — they look authoritative and they are answers to',
      'a different question.',
      '',
      'Opening it would be worse still. SQLite would keep its lock and write-ahead log on the',
      'real files while writing a private base file, and the checkpoint on close would move the',
      'schema into the copy — leaving the original a bare header page reporting zero tables.',
      '',
      'Run this from an ordinary terminal (Win+X -> Terminal), in the same Windows session as',
      'the applications:',
      '',
      '  npm run rebuild:node',
      '  node packages/core/scripts/diagnose-generation.mjs',
      '',
      '(`rebuild:node` is safe to leave in place — the packaged apps carry their own binary,',
      'and `npm run package` flips it back on its own.)',
      ''
    ].join('\n')
  );

  // What CAN honestly be said from here: what the container itself holds. It is
  // evidence in its own right — a shadow copy exists exactly because some
  // redirected process WROTE to that path, and its timestamps say when.
  const shadow = join(redirect, 'trade-analyzer-next', 'data');
  if (existsSync(shadow)) {
    console.log(`The container's OWN copy (this is not the generation):`);
    for (const gen of readdirSync(shadow)) {
      const f = join(shadow, gen, 'data.sqlite');
      if (!existsSync(f)) continue;
      const st = statSync(f);
      console.log(
        `  ${gen}/data.sqlite  ${st.size} bytes  created ${st.birthtime.toISOString()}  modified ${st.mtime.toISOString()}`
      );
    }
    console.log(
      '  A copy appears the moment a redirected process first writes to that path, so the\n' +
        '  creation time is when redirected writing STARTED and the modified time is when it\n' +
        '  last happened.'
    );
  }
  process.exit(3);
}

/** Whether WAL sidecars existed BEFORE this script opened anything. */
let sidecarsBefore = false;

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

// The redirect refusal used to live HERE, and that was the bug: everything
// between the probe and this point reported on files read through a redirected
// `%APPDATA%`, i.e. on the container's shadow copy. It now refuses at the probe,
// before a single line about the generation is printed. Left as a note rather
// than deleted, because "we refuse before opening" sounded sufficient and was
// not — the reading was already wrong long before the open.

// Same SQLite the applications use, and only when none of them has it open.
// This tool was itself part of the corruption on 2026-09-07: run against a live
// generation it put a second SQLite library on the same wal-index. A diagnostic
// that damages what it inspects is worse than no diagnostic.
//
// The refusals are now all inside `openGenerationExclusively` — redirect, in
// use, and never create. The redirect check above stays because a diagnostic
// should *report* what it found before it declines to continue, and the exit
// there simply happens first.
const db = await openGenerationExclusively(dbPath, 'diagnose-generation.mjs');

// Even the table list can throw. `sqlite_master` is a btree like any other, and
// on a badly damaged file `SELECT ... FROM sqlite_master` raises SQLITE_CORRUPT
// before a single line of the report exists — which comes out as a raw
// `wrappers.js` stack and reads as *the script broke*, not *the database is
// damaged*. This file's own header warns about exactly that failure and the
// query sat outside the guard anyway. Reproduced 2026-09-09 on a deliberately
// corrupted copy.
//
// So: nothing here is unguarded, and the order is integrity FIRST. A verdict is
// the one thing worth having even when everything else is unreadable.
let tables = [];
let schemaError = null;
try {
  tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log(`\ntables            : ${tables.length}`);
} catch (err) {
  schemaError = err?.message ?? String(err);
  console.log(`\ntables            : UNREADABLE — ${schemaError}`);
  console.log('  The schema itself will not read. That is severe damage, not a missing table.');
}

// `schemaError === null` matters as much as the count. An UNREADABLE schema and
// an EMPTY one are different facts with opposite remedies, and the catch above
// makes them look identical — the same shape as `decrypt()` returning `''` for
// "could not decrypt", which turned unreadable credentials into unset ones and
// cost an afternoon. Here the empty branch ends in **`Remove-Item -Recurse
// -Force`**, so collapsing the two would advise deleting a damaged database that
// is the only record of how it broke. A corrupt file falls through to the
// integrity report instead, which renames rather than deletes.
if (schemaError === null && tables.length === 0) {
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
/**
 * Turns `Tree 7 page 432` into the name of the object whose root page that is.
 *
 * A tree number on its own is unreadable, and worse than unreadable: it looks
 * like an object id and is not one. On 2026-09-07 two events reported `Tree 5`
 * and `Tree 7`, which read as two different tables and were **the same table** —
 * adding `meta_open_handle` to the dictionary shifted every later root page by
 * two. That misreading kept the diagnosis pointing the wrong way for an evening.
 *
 * **A tree number is only meaningful against the schema version that produced
 * it**, so it is resolved here, against this file, rather than remembered.
 */
function nameTrees(text) {
  const trees = [...new Set([...String(text).matchAll(/Tree (\d+)/g)].map((m) => Number(m[1])))];
  if (trees.length === 0) return [];
  const lookup = db.prepare('SELECT name, type, tbl_name FROM sqlite_master WHERE rootpage = ?');
  return trees.map((t) => {
    try {
      const row = lookup.get(t);
      if (!row) return `  Tree ${t}: no object has that root page (the schema itself may be damaged)`;
      const owner = row.type === 'index' ? ` on ${row.tbl_name}` : '';
      return `  Tree ${t}: ${row.type} ${row.name}${owner}`;
    } catch (err) {
      return `  Tree ${t}: could not resolve — ${err?.message ?? String(err)}`;
    }
  });
}

/**
 * The forensic reads, each guarded on its own.
 *
 * Called on a healthy file AND on a corrupt one. The first version of this
 * script exited on corruption *before* reaching `meta_open_handle` — so the one
 * table that answers "which applications opened this, and did they resolve the
 * same path" was skipped in precisely the case it exists for. Damage in one
 * btree says nothing about whether another is readable, and a small metadata
 * table usually is.
 *
 * Every read is wrapped, because on a corrupt file any of them can throw and one
 * throw must not take the rest of the report with it.
 */
function reportForensics(degraded) {
  const say = (label, fn) => {
    try {
      fn();
    } catch (err) {
      console.log(`  ${label}: UNREADABLE — ${err?.message ?? String(err)}`);
    }
  };

  if (degraded) {
    console.log('\nBest-effort reads from the damaged file (a throw below is itself a finding):');
  }

  console.log('\nrow counts:');
  for (const t of [
    'meta_generation', 'meta_run', 'meta_job_request', 'meta_response',
    'ref_trading_day', 'ref_universe_membership', 'raw_ticker_reference', 'raw_daily_bar'
  ]) {
    // "missing" is a claim about the schema, and it can only be made when the
    // schema was readable. Otherwise the honest word is "unknown".
    if (!tables.includes(t)) {
      console.log(`  ${t.padEnd(26)} ${schemaError === null ? 'TABLE MISSING' : 'unknown (schema unreadable)'}`);
      continue;
    }
    say(t.padEnd(26), () => {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      console.log(`  ${t.padEnd(26)} ${n}`);
    });
  }

  // Which applications have opened THIS file, in their own words. The question
  // that cost most of 2026-09-07 was "are the two apps looking at the same
  // database", and it was answered by inference every time, wrongly. Both exes
  // write a row here on open, so it is answered by reading.
  if (tables.includes('meta_open_handle')) {
    console.log('\nopened by:');
    say('meta_open_handle', () => {
      const handles = db
        .prepare('SELECT app_name, app_version, opened_at, closed_at, process_id, db_path, dictionary_version FROM meta_open_handle ORDER BY opened_at')
        .all();
      if (handles.length === 0) {
        console.log('  (nothing has opened this generation since the handle table existed)');
        return;
      }
      const paths = new Set(handles.map((h) => h.db_path));
      for (const h of handles) {
        console.log(
          `  ${h.app_name} v${h.app_version}  dict v${h.dictionary_version}  pid ${h.process_id}` +
            `  open ${h.opened_at}  closed ${h.closed_at ?? 'NOT RECORDED'}`
        );
        if (h.db_path !== dbPath) console.log(`    ** resolved a DIFFERENT path: ${h.db_path} **`);
      }
      if (paths.size > 1) {
        console.log('');
        console.log('  ** More than one db_path appears above. That is a SPLIT FILE SET: two');
        console.log('     processes coordinating through one lock and write-ahead log while');
        console.log('     writing different base files. It is the one mechanism known to');
        console.log('     corrupt this database. **');
      }
      // The overlap question, answered by reading rather than by asking. Two
      // open timestamps are consistent with any amount of overlap or none, which
      // is why `closed_at` exists — on 2026-09-09 "was the other app running"
      // had to be taken on recollection at the exact point where concurrency was
      // the live hypothesis.
      const spans = handles
        .filter((h) => h.closed_at)
        .map((h) => ({ name: h.app_name, from: Date.parse(h.opened_at), to: Date.parse(h.closed_at) }))
        .filter((sp) => Number.isFinite(sp.from) && Number.isFinite(sp.to));
      for (let i = 0; i < spans.length; i++) {
        for (let j = i + 1; j < spans.length; j++) {
          const a = spans[i];
          const b = spans[j];
          if (a.name !== b.name && a.from < b.to && b.from < a.to) {
            console.log('');
            console.log(`  ** ${a.name} and ${b.name} held this file AT THE SAME TIME. **`);
            console.log('     Two writers on one write-ahead log. Read from the recorded intervals,');
            console.log('     not inferred from the open timestamps.');
          }
        }
      }
      const unclosed = handles.filter((h) => !h.closed_at).map((h) => h.app_name);
      if (unclosed.length > 0) {
        console.log('');
        console.log(`  No close recorded for: ${unclosed.join(', ')}. Either it still holds the`);
        console.log('  file, or it died without closing, or it predates the close stamp (dict v8).');
        console.log('  Overlap CANNOT be ruled out from these rows — that is not the same as ruling it in.');
      }

      if (new Set(handles.map((h) => h.app_name)).size === 1) {
        console.log('  Only one application has opened this file. If both have been run since');
        console.log('  this version was installed, they are not sharing a generation.');
      }
    });
  }
}

// Guarded like everything else: `integrity_check` walks every btree, so on a
// file damaged badly enough it raises rather than returning a verdict. "The
// check itself could not run" IS the verdict in that case, and it has to be
// printed rather than thrown.
let integrityResult;
try {
  integrityResult = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
} catch (err) {
  integrityResult = `integrity_check could not run: ${err?.message ?? String(err)}`;
}
if (schemaError !== null || integrityResult !== 'ok') {
  console.log(`\nintegrity_check   : ${String(integrityResult).slice(0, 400)}`);

  const named = nameTrees(integrityResult);
  if (named.length > 0) {
    console.log('\ndamaged objects   :');
    for (const line of named) console.log(line);
  }

  console.log('\n** THIS DATABASE IS CORRUPT. ** Row counts below are best-effort, not evidence.');

  reportForensics(true);

  // **Rename, do not delete.** A corrupt generation is the only physical record
  // of how it got that way, and this script previously said `Remove-Item
  // -Recurse -Force`. That is the same shape as the evening this tool reported a
  // healthy database as empty and nearly had it deleted on the strength of it —
  // and a generation is cheap to rebuild (the jobs re-run) while the evidence is
  // not reproducible at all.
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Both separators: the path may arrive with either, and dropping the
  // backslash would leave a Windows path unsplit and name the whole thing.
  const genName = genDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const alreadyRetired = /-corrupt-\d{8}$/.test(genName ?? '');
  // A generation that has already been retired needs no advice — it is evidence
  // sitting where it belongs. Suggesting a rename here produced
  // `gen-001-corrupt-20260907-corrupt-20260909`, which is the tell that the
  // recovery text was written for one case and printed in every case.
  if (alreadyRetired) {
    console.log('\nThis generation is already retired (its name carries a `-corrupt-` stamp), so');
    console.log('there is nothing to do: it is being kept deliberately as the record of a failure.');
    console.log('Corruption here is expected — it is why the directory was set aside.');
  } else {
    console.log('\nRecovery — rename, never delete: this file is the only record of how it broke,');
    console.log('and the generation itself is cheap to rebuild by re-running the jobs. Close both');
    console.log('applications, then:');
    console.log(`  Rename-Item "${genDir}" "${genName}-corrupt-${stamp}"`);
    console.log('  # then launch TradeAnalyzer 2 once — it recreates the generation and the pointer');
    console.log('The archive directory is append-only and separate; it is unaffected either way.');
  }
  checkpointAndClose(db);
  process.exit(2);
}
console.log('integrity_check   : ok');

reportForensics(false);

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
