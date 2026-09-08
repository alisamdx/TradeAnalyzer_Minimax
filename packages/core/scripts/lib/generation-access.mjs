/**
 * The one way a script may open a generation — NewApp 06 §3.4.
 *
 * Four rules, all learned the expensive way on 2026-09-07, when `meta_response`
 * was corrupted twice (`btreeInitPage() returns error code 11`) while these
 * scripts were being run against a generation the collector was writing.
 *
 * **They all live in `openGenerationExclusively`, and that is the point.** Until
 * 2026-09-08 they were scattered across the callers — the redirect check copied
 * into two scripts, the in-use check here, the refusal to create a missing file
 * in one script only — and `exception.mjs`, written later for B5's ticker-reuse
 * rulings, had none of the four. It opened the live generation directly, from
 * any shell, while both applications were running. **A capability that must
 * apply to every caller belongs in the function they all call**; a copy in each
 * caller is not a safeguard, it is a list of the callers somebody remembered.
 *
 * **1. Never while an application has it open.** A `-shm` file exists exactly
 * when some process holds the database, so its presence is the check. Both
 * corruptions happened with a script and an app on the file at once, and both
 * landed in the table the collector was actively writing.
 *
 * **2. Never with a different SQLite library than the applications use.** These
 * scripts used `node:sqlite` — chosen because a built-in "has no ABI to be
 * wrong", which was reasoning about the wrong risk. `node:sqlite` bundles
 * **SQLite 3.51.3** and `better-sqlite3` bundles **3.53.1**, and the WAL index
 * (`-shm`) format is not guaranteed compatible between versions. Two libraries
 * coordinating through one wal-index is a corruption mechanism, and it also
 * showed up as lost writes: a `queue-job` insert that reported success and left
 * no row, twice returning "request 1".
 *
 * The ABI cost is real and is accepted deliberately. `better-sqlite3`'s binary
 * is swapped between the Node and Electron runtimes by
 * `scripts/rebuild-better-sqlite3.mjs`, so after `npm run package` these scripts
 * need `npm run rebuild:node`. **They say so and refuse, rather than falling
 * back to `node:sqlite`** — a fallback would reintroduce exactly the mixing this
 * exists to prevent, at the moment nobody is watching.
 *
 * **3. Never from a containerised shell.** `%APPDATA%` is then redirected with
 * copy-on-write, and opening a WAL database from there *moves* it: the lock and
 * the write-ahead log stay on the real files while the base file is a private
 * copy, and the checkpoint on close lands in the copy. The original is left as a
 * bare header page reporting zero tables, which looks exactly like the
 * application never having created it.
 *
 * **4. Never create.** `new Database(path)` creates the file, and generation
 * creation belongs to TradeAnalyzer 2 alone. A generation made by anything else
 * has no `meta_generation` row and is healthy from every angle except whose it
 * is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Refuses if any process holds the generation open.
 *
 * `-shm` is not a perfect proxy for "in use" — an unclean exit can leave one
 * behind — so the message says what to do in that case too. Recovering it is a
 * job for the application, never for a script: starting TradeAnalyzer 2 once
 * replays the WAL and checkpoints it, which is the same path that makes the
 * hand-off durable in normal operation.
 */
export function assertNotOpenElsewhere(dbPath) {
  if (!existsSync(`${dbPath}-shm`)) return;
  console.error(
    [
      'Refusing to open: a `-shm` file is present, which means an application has this',
      'generation open right now.',
      '',
      'A script and an app on one WAL database is how `meta_response` was corrupted twice',
      'on 2026-09-07 — both times in the table the collector was writing at that moment.',
      '',
      'Close TradeAnalyzer and TradeAnalyzer 2, then run this again. If both are already',
      'closed, the sidecars are left over from an unclean exit: start TradeAnalyzer 2 once',
      'and close it, which replays the write-ahead log and checkpoints it properly.'
    ].join('\n')
  );
  process.exit(5);
}

/**
 * Refuses if this process's `%APPDATA%` is redirected into an MSIX container.
 *
 * Not a nicety. Under a redirect the generation's `data.sqlite` may already have
 * been copy-on-written into the container while `-wal` and `-shm` still fall
 * through to the real ones, so opening it is not a read: SQLite keeps its lock
 * and write-ahead log on the real files while writing a private base file, and
 * the checkpoint on close moves the schema somewhere nobody will ever open
 * again. That destroyed a generation on 2026-09-07.
 *
 * The probe measures the redirect by writing a marker and going to look for it,
 * because `%APPDATA%`, `process.execPath`, `cwd()` and `import.meta.url` all read
 * as the real thing from inside a container. It lives in `core` so the two
 * applications and these scripts share one implementation.
 *
 * **An `undetermined` probe does not refuse.** A cheap local check standing in
 * for an authority must be able to say "don't know"; saying "no" here would
 * refuse to open the only database there is.
 */
export async function assertNotRedirectedHere(paths, who = 'this script') {
  let assertNotRedirected;
  try {
    ({ assertNotRedirected } = await import('../../dist/db/appdata-redirect.js'));
  } catch {
    console.error(
      [
        'packages/core is not built, so the redirect guard cannot be loaded — and opening a',
        'generation without it is how one gets destroyed. Build it first:',
        '',
        '  npm run build --prefix packages/core'
      ].join('\n')
    );
    process.exit(2);
  }

  // `core`'s own implementation, the same call the two applications make, with
  // the same wording. A second copy of the message here would drift from the one
  // the operator sees in the app, and they are describing one fault.
  //
  // The **directories** are the argument rather than `%APPDATA%` because the
  // redirect is per file: `dataRoot` is configurable and may sit outside AppData
  // entirely, while the pointer never does. Each caller probes what it resolved
  // — `resolveGenerationPointer` the pointer's directory, this the generation's
  // — so between them both are covered, exactly as the applications cover both.
  try {
    assertNotRedirected(paths, who);
  } catch (err) {
    // A stack trace is the wrong shape for a one-shot script. The message is
    // several paragraphs of what happened and what to do, and it is the whole
    // value of the guard.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
}

/**
 * Refuses to open a generation that does not exist, because `new Database(path)`
 * would **create** it.
 *
 * Generation creation belongs to TradeAnalyzer 2 alone (06 §3). A script that
 * creates one produces a database with 52 tables, `integrity_check: ok` and
 * **zero rows in `meta_generation`** — healthy from every angle except whose it
 * is, and indistinguishable from the real generation having lost its data. The
 * collector host learned this the same day (v1.1.203); the scripts needed it
 * too, and only one of the three had it.
 */
export function assertGenerationExists(dbPath) {
  if (existsSync(dbPath)) return;
  console.error(
    [
      `No generation database at ${dbPath}.`,
      '',
      'Refusing to create one: `new Database(path)` creates the file, and a generation made by',
      'anything but TradeAnalyzer 2 has no `meta_generation` row. Run TradeAnalyzer 2 once.'
    ].join('\n')
  );
  process.exit(1);
}

/**
 * Where the generation is, according to the pointer both applications read.
 *
 * **Never invents it.** A missing pointer means the new exe has not been run;
 * guessing a path would open — and therefore create — a second, empty
 * generation that looks exactly like the real one having lost its data. The
 * applications refuse for the same reason and in the same words.
 */
export async function resolveGenerationPointer() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const pointerPath = join(appData, 'tradeanalyzer-shared', 'data-root.json');

  // Before the pointer is even read. Under a redirect this file is served from
  // the container's copy, so a script could read a *different* pointer than the
  // applications wrote and then confidently operate on a generation nobody else
  // is using.
  await assertNotRedirectedHere([dirname(pointerPath)], 'this script');

  if (!existsSync(pointerPath)) {
    console.error(
      `No generation pointer at ${pointerPath}.\n` +
        'Run TradeAnalyzer 2 once — it creates the generation and writes the pointer both apps read.'
    );
    process.exit(1);
  }
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  if (typeof pointer.dataRoot !== 'string' || typeof pointer.currentGeneration !== 'number') {
    console.error(`${pointerPath} is present but malformed; refusing to guess where the data is.`);
    process.exit(1);
  }
  const dir = join(pointer.dataRoot, `gen-${String(pointer.currentGeneration).padStart(3, '0')}`);
  return {
    ...pointer,
    pointerPath,
    generationDir: dir,
    dbPath: join(dir, 'data.sqlite'),
    archiveRoot: join(dir, 'archive')
  };
}

/**
 * Loads the same SQLite the applications use, or explains why it cannot.
 *
 * Write-capable, never readonly: on Windows a readonly connection cannot attach
 * the WAL index and silently reads only up to the last checkpoint (CLAUDE.md).
 */
export async function openGenerationExclusively(dbPath, who = 'this script') {
  // Every refusal that must apply to a script opening a generation lives HERE,
  // and no longer in the callers.
  //
  // It used to be split: `queue-job.mjs` and `diagnose-generation.mjs` each
  // carried their own redirect check, this function carried the in-use check,
  // and the refusal to *create* a missing file lived in `queue-job.mjs` alone.
  // `exception.mjs` — written later, for the ticker-reuse rulings B5's gate
  // needs — used none of them: it opened the live generation directly, from any
  // shell, while both applications were running, and ran `applyDictionary`
  // against it. Found 2026-09-08.
  //
  // That is the project's most expensive recurring shape, and this is the third
  // time it has been written down: **a capability that must apply to every
  // caller belongs in the function they all call.** Patching the second caller
  // leaves the trap set for the third.
  await assertNotRedirectedHere([dirname(dbPath)], who);
  assertNotOpenElsewhere(dbPath);
  assertGenerationExists(dbPath);

  // The require and the construction are in ONE try, because better-sqlite3
  // loads its native binding lazily: `require` succeeds happily against the
  // wrong ABI and `new Database(...)` is what throws. Guarding only the require
  // let the raw `NODE_MODULE_VERSION 128 vs 137` stack through instead of the
  // message that names the fix — caught by the test, which is what that test is
  // for.
  try {
    const Database = require('better-sqlite3');
    return new Database(dbPath);
  } catch (err) {
    const abiMismatch =
      err?.code === 'ERR_DLOPEN_FAILED' || /NODE_MODULE_VERSION/.test(String(err?.message));
    if (abiMismatch) {
      console.error(
        [
          "better-sqlite3 in this repo is currently built for Electron, so plain Node can't load it.",
          'Switch it back and run this again:',
          '',
          '  npm run rebuild:node',
          '',
          '(and `npm run rebuild:electron`, or any `npm run package`, when you want the apps again).',
          '',
          'This script will NOT fall back to node:sqlite. That would put a second SQLite library',
          'on the same write-ahead log, which is what corrupted a generation twice on 2026-09-07.'
        ].join('\n')
      );
    } else {
      console.error(`Could not open ${dbPath} with better-sqlite3: ${err?.message ?? String(err)}`);
    }
    process.exit(6);
  }
}

/**
 * Makes this connection's writes durable, then closes.
 *
 * Not left to close-time semantics. Measured 2026-09-07: TradeAnalyzer 2 built a
 * 918,792-byte WAL, another process read the committed rows out of it, and the
 * close deleted the WAL with `data.sqlite` byte-for-byte unchanged — the entire
 * write silently discarded. A checkpoint that does nothing must never again be
 * indistinguishable from one that worked.
 */
export function checkpointAndClose(db) {
  try {
    const [row] = db.pragma('wal_checkpoint(TRUNCATE)');
    if (row && (row.busy !== 0 || row.log !== row.checkpointed)) {
      console.error(
        `WARNING: checkpoint did not fully apply — busy=${row.busy}, log=${row.log}, ` +
          `checkpointed=${row.checkpointed}. Writes may not be durable.`
      );
    }
  } catch (err) {
    console.error(`WARNING: checkpoint failed: ${err?.message ?? String(err)}`);
  }
  db.close();
}
