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
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const KINDS = ['universe_seed', 'backfill_bars', 'bootstrap_iv', 'legacy_import', 'replay', 'reset'];

const kind = process.argv[2];
const paramsArg = process.argv[3] ?? '{}';

if (!kind || !KINDS.includes(kind)) {
  console.error(`Usage: node packages/core/scripts/queue-job.mjs <${KINDS.join('|')}> [paramsJson]`);
  process.exit(2);
}

const pointerPath = join(homedir(), 'AppData', 'Roaming', 'tradeanalyzer-shared', 'data-root.json');
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
const Database = require('better-sqlite3');
const db = new Database(dbPath);

const info = db
  .prepare(
    `INSERT INTO meta_job_request (requested_at, requested_by, run_kind, params_json, state)
     VALUES (?, ?, ?, ?, 'queued')`
  )
  .run(new Date().toISOString(), 'queue-job.mjs (dev)', kind, paramsArg);

console.log(
  `Queued ${kind} as request ${info.lastInsertRowid} in gen-${String(currentGeneration).padStart(3, '0')}.\n` +
    'The existing app\'s collector-oneshot handler claims it within ~2 minutes; it must be running.'
);
db.close();
