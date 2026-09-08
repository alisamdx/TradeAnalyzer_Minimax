#!/usr/bin/env node
/**
 * Runs a full `universe_seed` through the REAL collector code, offline, in plain
 * Node — the **control arm**.
 *
 *   node packages/core/scripts/replay-seed-locally.mjs "C:\\some\\dir" [tickers] [delayMs]
 *
 * Written 2026-09-07, after `meta_response` was corrupted three times and three
 * candidate causes were tested and cleared:
 *
 *  - the MSIX redirect (guarded; corruption recurred)
 *  - two SQLite libraries on one wal-index (fixed; corruption recurred)
 *  - the environment — `stress-sqlite.mjs` wrote 1,100 paced transactions into
 *    the generation's own directory over 285 s and came back CLEAN
 *
 * and two more were ruled out by inspection: `applyDictionary` is idempotent (no
 * rebuilds on re-apply), and the batch mutex genuinely prevents a second
 * collector job during a run. TradeAnalyzer 2 was closed for every corrupting
 * run, so it was never two processes either.
 *
 * What is left is the difference between the stress test and the real thing:
 * the actual schema with its foreign keys, CHECK constraints and append-only
 * triggers; parent and child rows inside one transaction; the archive file
 * written between transactions; and `captureResponse` itself.
 *
 * **So this runs exactly that** — `runUniverseSeed` over a stub host that serves
 * canned Polygon bodies. Real dictionary, real capture contract, real archive
 * writer, real ingestion. No Electron, no network, one process.
 *
 * It came back CLEAN, which is what makes the Electron arm worth running:
 * `replay-seed-in-electron.mjs` executes this same replay inside an Electron
 * main process, and the two differ in the runtime and nothing else. Keep them
 * that way — the shared body lives in `lib/seed-replay.mjs` for that reason.
 *
 * Writes into a throwaway directory it creates; never touches a real generation.
 */
import { tmpdir } from 'node:os';
import { loadBetterSqlite3, runSeedReplay } from './lib/seed-replay.mjs';

const Database = loadBetterSqlite3('node');

const { ok } = await runSeedReplay({
  Database,
  label: 'node',
  baseDir: process.argv[2] ?? tmpdir(),
  tickerCount: Number(process.argv[3] ?? 1089),
  delayMs: Number(process.argv[4] ?? 0),
  ticks: Number(process.env.REPLAY_TICKS ?? 60)
});

process.exit(ok ? 0 : 1);
