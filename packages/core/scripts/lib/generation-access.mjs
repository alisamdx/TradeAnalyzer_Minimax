/**
 * The one way a script may open a generation — NewApp 06 §3.4.
 *
 * Two rules, both learned the expensive way on 2026-09-07, when `meta_response`
 * was corrupted twice (`btreeInitPage() returns error code 11`) while these
 * scripts were being run against a generation the collector was writing.
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
 */
import { existsSync } from 'node:fs';
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
 * Loads the same SQLite the applications use, or explains why it cannot.
 *
 * Write-capable, never readonly: on Windows a readonly connection cannot attach
 * the WAL index and silently reads only up to the last checkpoint (CLAUDE.md).
 */
export function openGenerationExclusively(dbPath) {
  assertNotOpenElsewhere(dbPath);

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
