#!/usr/bin/env node
/**
 * Queues a one-shot job by inserting a `meta_job_request` row — NewApp 06 §9.
 *
 *   node packages/core/scripts/queue-job.mjs universe_seed
 *   node packages/core/scripts/queue-job.mjs replay '{"sourceGeneration":1}'
 *
 * DEV ONLY, and deliberately so. The queue table and its claim loop land at B3,
 * but the Jobs UI that writes to it is B9 — so between the two, a one-shot is
 * started by inserting the row by hand. That means `universe_seed` (B3) and
 * `backfill_bars` (B5) exercise the **exact same claim-and-execute path** the UI
 * will use later, rather than a temporary direct-call path that would then be
 * deleted untested.
 *
 * **Run this from your own shell, in the same Windows session as the app.**
 * Two environment traps, both of which make the insert land somewhere the
 * collector will never look:
 *
 *  1. A **containerised shell** (an MSIX/packaged host such as a store app's
 *     embedded terminal) has `%APPDATA%` redirected into its package's
 *     `LocalCache\Roaming`. Reads fall through to the real file until the first
 *     write, at which point Windows makes a private copy — so the row is
 *     written, reads back perfectly, and the app never sees it. Diagnosed
 *     2026-09-07 after a queued request sat unclaimed through a dozen ticks.
 *     The script refuses to run when it detects the redirect.
 *  2. A different Windows user, which has its own `%APPDATA%` entirely.
 *
 * Uses **`better-sqlite3`** — the same library both applications use — and only
 * when no application has the generation open. It used to use `node:sqlite`,
 * chosen because a built-in "has no ABI to be wrong", and that was reasoning
 * about the wrong risk: `node:sqlite` bundles SQLite 3.51.3 while
 * `better-sqlite3` bundles 3.53.1, and the wal-index format is not guaranteed
 * compatible across versions. Running this against a live generation corrupted
 * `meta_response` twice on 2026-09-07 and silently lost an insert twice more.
 * The ABI dance is the price, and it is cheap by comparison — see
 * `lib/generation-access.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkpointAndClose, openGenerationExclusively } from './lib/generation-access.mjs';

// The redirect probe lives in `core` and nowhere else. It used to be a copy in
// this script and a second copy in `diagnose-generation.mjs`, while the two
// applications — the ones that can actually destroy a generation by opening it
// from a redirected process — had none at all. Importing the built module keeps
// one implementation; it is plain JavaScript with no native binding, so it has
// no ABI to be wrong about (which is why `node:sqlite` is still used below).
let detectRedirect;
try {
  ({ detectRedirect } = await import('../dist/db/appdata-redirect.js'));
} catch {
  console.error(
    'packages/core is not built, so the redirect guard cannot be loaded — and running without it\n' +
      'is exactly how a generation gets corrupted. Build it first:\n' +
      '  npm run build --prefix packages/core'
  );
  process.exit(2);
}

const KINDS = ['universe_seed', 'backfill_bars', 'bootstrap_iv', 'legacy_import', 'replay', 'reset'];

const kind = process.argv[2];
const paramsArg = process.argv[3] ?? '{}';

if (!kind || !KINDS.includes(kind)) {
  console.error(`Usage: node packages/core/scripts/queue-job.mjs <${KINDS.join('|')}> [paramsJson]`);
  process.exit(2);
}

try {
  JSON.parse(paramsArg);
} catch {
  console.error(`Params must be JSON; got: ${paramsArg}`);
  process.exit(2);
}

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');

const redirect = detectRedirect(appData);
if (redirect.redirectedTo) {
  console.error(
    [
      'Refusing to queue: this shell is containerised, so writes to %APPDATA% are redirected',
      `into ${redirect.redirectedTo} and the collector will never see them.`,
      '',
      'The write would succeed and read back perfectly — that is what makes it dangerous.',
      'Run this from an ordinary terminal in the same Windows session as the app.'
    ].join('\n')
  );
  process.exit(3);
}

const pointerPath = join(appData, 'tradeanalyzer-shared', 'data-root.json');
if (!existsSync(pointerPath)) {
  console.error(
    `No generation pointer at ${pointerPath}.\n` +
      'Run TradeAnalyzer 2 once — it creates the generation and writes the pointer both apps read.'
  );
  process.exit(1);
}

const { dataRoot, currentGeneration } = JSON.parse(readFileSync(pointerPath, 'utf8'));
const dbPath = join(dataRoot, `gen-${String(currentGeneration).padStart(3, '0')}`, 'data.sqlite');
if (!existsSync(dbPath)) {
  console.error(`Generation database missing: ${dbPath}`);
  process.exit(1);
}

// Opens with the SAME SQLite the applications use, and only when no application
// has the file open. Both rules exist because `meta_response` was corrupted
// twice on 2026-09-07 with a script and an app on one WAL database at once, and
// because `node:sqlite` (SQLite 3.51.3) and `better-sqlite3` (3.53.1) do not
// share a wal-index format by guarantee. See `lib/generation-access.mjs`.
const db = openGenerationExclusively(dbPath);

// A raw `no such table: meta_job_request` is a true statement and a useless
// one — it has three quite different causes and names none of them. Checked up
// front so the message can.
const hasQueue =
  db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta_job_request'")
    .get().n > 0;
if (!hasQueue) {
  db.close();
  console.error(
    [
      `This connection sees no schema in ${dbPath}.`,
      '',
      'No application had it open (this script refuses otherwise), so the file really is an',
      'empty shell — something created the path before TradeAnalyzer 2 did. Generation',
      'creation belongs to the new exe: delete the directory and launch it first.',
      `  Remove-Item -Recurse -Force "${join(dataRoot, `gen-${String(currentGeneration).padStart(3, '0')}`)}"`
    ].join('\n')
  );
  process.exit(4);
}

const info = db
  .prepare(
    `INSERT INTO meta_job_request (requested_at, requested_by, run_kind, params_json, state)
     VALUES (?, ?, ?, ?, 'queued')`
  )
  .run(new Date().toISOString(), 'queue-job.mjs (dev)', kind, paramsArg);

// Read back through a fresh statement, so the printed confirmation is what the
// file holds rather than what we believe we wrote. That distinction stopped
// being academic on 2026-09-07, when this script twice reported "request 1"
// because the previous insert had never reached the file.
const queued = db.prepare("SELECT COUNT(*) AS n FROM meta_job_request WHERE state = 'queued'").get();

console.log(
  `Queued ${kind} as request ${info.lastInsertRowid} in ` +
    `gen-${String(currentGeneration).padStart(3, '0')} (${dbPath}).\n` +
    `${queued.n} request(s) now queued. The existing app's collector-oneshot handler claims one\n` +
    'every ~2 minutes; it must be running. Watch logs/errors/ for a `collector-oneshot:tick` line.'
);

// Durable before this process exits, and loud if it is not.
checkpointAndClose(db);
