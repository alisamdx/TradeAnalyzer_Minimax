#!/usr/bin/env node
/**
 * The same `universe_seed` replay as `replay-seed-locally.mjs`, run **inside an
 * Electron main process** — the test arm.
 *
 *   node packages/core/scripts/replay-seed-in-electron.cjs "C:\\some\\dir" [tickers] [delayMs]
 *
 * Needs `npm run rebuild:electron` first, and the Node control arm needs
 * `npm run rebuild:node`. The two cannot be run back to back without a rebuild
 * between them; each says which one it wants rather than dying on
 * `NODE_MODULE_VERSION`.
 *
 * ## Why this arm exists
 *
 * `meta_response` corrupted three times during a live `universe_seed`
 * (`btreeInitPage() returns error code 11`). Nine suspects were eliminated by
 * test rather than by argument — the MSIX redirect, two SQLite libraries on one
 * wal-index, the environment, `applyDictionary` drift, an overlapping job, two
 * processes, the collector code path, the tick's dictionary churn, and a
 * mismatched native binary. See the NewApp changelog entry for how each fell.
 *
 * The control arm runs the real seed offline and comes back clean, so what is
 * left between it and a corrupting live run is the **runtime**: an Electron main
 * process, its event loop, and `better-sqlite3` compiled against the Electron
 * ABI rather than Node's. This runs the identical replay there. One variable.
 *
 *  - **It corrupts** → the fault needs Electron, and a 0.6-second cycle replaces
 *    a five-minute live run. That is the difference between bisecting and
 *    guessing, which is the whole point of building it.
 *  - **It stays clean** → the runtime is cleared too, and the remaining
 *    differences are the live ones this harness deliberately removes: real
 *    network latency between writes, real `safeStorage` encryption, and the
 *    generation's own directory. `REPLAY_SAFE_STORAGE=1` turns the second of
 *    those on; the delay argument covers the first; `stress-sqlite.mjs` already
 *    covered the third and cleared it.
 *
 * ## Three things it must get right about Electron, all learned the hard way
 *
 * **This file is CommonJS on purpose, and must stay that way.** Electron 32
 * does not run a `.mjs` passed as its entry point: measured 2026-09-08, it
 * produces no output, no error and no exit — a headless main process holding
 * whatever it had opened, killed only by the harness timeout. The identical
 * script as `.cjs` runs and prints normally. A silent hang reads exactly like
 * the corruption bug being investigated, which would have been a rich source of
 * wasted evenings.
 *
 * **`ELECTRON_RUN_AS_NODE` is deleted from the child's environment.** Left set —
 * and the repo's own `dev` script exists because it leaks — Electron runs as
 * plain Node, this arm silently becomes a second copy of the control, and a
 * clean result would mean nothing at all. `process.type` is asserted inside for
 * the same reason.
 *
 * **Every exit path goes through `finish()`.** An error inside
 * `app.whenReady().then(...)` with no `.catch()` becomes an unhandled rejection
 * on a stderr nobody reads, and because no window was ever created
 * `window-all-closed` never fires — so the process neither reports nor exits.
 *
 * Writes into a throwaway directory it creates; never touches a real generation.
 */
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const baseDir = process.argv[2] || tmpdir();
const tickerCount = Number(process.argv[3] || 1089);
const delayMs = Number(process.argv[4] || 0);

/** The shared replay body, which is ESM. `import()` reaches it from CommonJS. */
const loadReplay = () => import(pathToFileURL(require.resolve('./lib/seed-replay.mjs')).href);

if (!process.versions.electron) {
  // ---- launcher half: plain Node, re-executes this file under Electron ----
  const { spawnSync } = require('node:child_process');

  let electronExe;
  try {
    electronExe = require('electron');
  } catch {
    console.error('Electron is not installed in this workspace (`npm install` at the repo root).');
    process.exit(2);
  }
  if (typeof electronExe !== 'string') {
    // `require('electron')` returns the exe path from Node and the API object
    // from inside Electron. Getting the object here would mean this half is
    // running somewhere it thinks it is not.
    console.error('`require("electron")` did not return a path; refusing to guess.');
    process.exit(2);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

  const child = spawnSync(
    electronExe,
    [__filename, baseDir, String(tickerCount), String(delayMs)],
    { stdio: 'inherit', env }
  );
  if (child.error) {
    console.error(`Could not start Electron: ${child.error.message}`);
    process.exit(2);
  }
  process.exit(child.status === null ? 1 : child.status);
}

// ---- test half: this is the Electron main process ----
const { app, safeStorage } = require('electron');

/** The only way out. See the header: an Electron main with no window cannot quit on its own. */
function finish(code, err) {
  if (err) console.error(`\n*** the Electron arm threw: ${(err && err.stack) || String(err)}`);
  app.exit(code);
}

process.on('unhandledRejection', (err) => finish(70, err));
process.on('uncaughtException', (err) => finish(70, err));

app
  .whenReady()
  .then(async () => {
    if (process.type !== 'browser') {
      // Belt and braces on the `ELECTRON_RUN_AS_NODE` trap: under it there is no
      // `process.type`, and this arm would be measuring the control arm.
      finish(3, new Error('Not an Electron main process — is ELECTRON_RUN_AS_NODE set?'));
      return;
    }

    const { loadBetterSqlite3, runSeedReplay } = await loadReplay();
    const Database = loadBetterSqlite3('electron');

    // Opt-in second variable: the real OS-backed cipher the collector host uses
    // for account-domain archive lines, instead of the byte flip. Off by
    // default, because two variables at once is how the last three diagnoses
    // went wrong.
    const useSafeStorage = process.env.REPLAY_SAFE_STORAGE === '1';
    if (useSafeStorage && !safeStorage.isEncryptionAvailable()) {
      finish(4, new Error('REPLAY_SAFE_STORAGE=1 but safeStorage reports encryption unavailable.'));
      return;
    }
    if (useSafeStorage) console.log('archive   : real safeStorage (REPLAY_SAFE_STORAGE=1)');

    const { ok } = await runSeedReplay({
      Database,
      label: 'electron',
      baseDir,
      tickerCount,
      delayMs,
      ticks: Number(process.env.REPLAY_TICKS || 60),
      encryptForArchive: useSafeStorage
        ? (b) => safeStorage.encryptString(b.toString('base64'))
        : undefined,
      decryptFromArchive: useSafeStorage
        ? (b) => Buffer.from(safeStorage.decryptString(b), 'base64')
        : undefined
    });

    finish(ok ? 0 : 1);
  })
  .catch((err) => finish(70, err));
