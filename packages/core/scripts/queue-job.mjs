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
 * Uses **`node:sqlite`**, not `better-sqlite3`, on purpose: this repo swaps the
 * native module's ABI between Node and Electron builds (CLAUDE.md), so a script
 * depending on it only runs in whichever half of the cycle you are currently in.
 * A built-in has no ABI to be wrong.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

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

/**
 * Detects the redirect by **measuring it**, not by pattern-matching a path.
 *
 * The first version of this guard looked for `AppData\\Local\\Packages` in
 * `process.execPath`, `cwd()` and `import.meta.url` — and did not fire, because
 * none of those is rewritten. `%APPDATA%` itself still reads as the real path
 * too. The redirect is genuinely invisible from the inside, so the only honest
 * test is to write a file and go looking for where it actually landed.
 */
function appDataIsRedirected(appDataDir) {
  const marker = `.queue-job-write-probe-${process.pid}-${Date.now()}`;
  const probe = join(appDataDir, marker);
  try {
    writeFileSync(probe, 'probe', 'utf8');
  } catch {
    return null; // cannot write at all; the real errors below will say why
  }
  try {
    const packages = join(homedir(), 'AppData', 'Local', 'Packages');
    if (!existsSync(packages)) return null;
    for (const pkg of readdirSync(packages)) {
      const shadow = join(packages, pkg, 'LocalCache', 'Roaming', marker);
      if (existsSync(shadow)) return join(packages, pkg, 'LocalCache', 'Roaming');
    }
    return null;
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
}

const redirectedTo = appDataIsRedirected(appData);
if (redirectedTo) {
  console.error(
    'Refusing to queue: this shell is containerised, so writes to %APPDATA% are redirected\n' +
      `into ${redirectedTo} and the collector will never see them.\n\n` +
      'The write would succeed and read back perfectly — that is what makes it dangerous.\n' +
      'Run this from an ordinary terminal in the same Windows session as the app.'
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

// Write-capable, never readonly: on Windows a readonly connection cannot attach
// the live WAL index and would read a stale generation (CLAUDE.md).
const db = new DatabaseSync(dbPath);

const insert = db.prepare(
  `INSERT INTO meta_job_request (requested_at, requested_by, run_kind, params_json, state)
   VALUES (?, ?, ?, ?, 'queued')`
);
const info = insert.run(new Date().toISOString(), 'queue-job.mjs (dev)', kind, paramsArg);

// Read back through a fresh statement, so the printed confirmation is what the
// file holds rather than what we believe we wrote.
const queued = db
  .prepare("SELECT COUNT(*) AS n FROM meta_job_request WHERE state = 'queued'")
  .get();

console.log(
  `Queued ${kind} as request ${info.lastInsertRowid} in ` +
    `gen-${String(currentGeneration).padStart(3, '0')} (${dbPath}).\n` +
    `${queued.n} request(s) now queued. The existing app's collector-oneshot handler claims one\n` +
    'every ~2 minutes; it must be running. Watch logs/errors/ for a `collector-oneshot:tick` line.'
);
db.close();
