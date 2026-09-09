// Cross-platform rebuild of better-sqlite3 against either Electron's or system
// Node's ABI. Reads Electron's actual installed version (so a future Electron
// bump automatically picks up the right prebuild target) instead of hardcoding.
//
// Usage:
//   node scripts/rebuild-better-sqlite3.mjs electron
//   node scripts/rebuild-better-sqlite3.mjs node

import { execSync } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const target = process.argv[2];
if (target !== 'electron' && target !== 'node') {
  console.error('Usage: node scripts/rebuild-better-sqlite3.mjs <electron|node>');
  process.exit(2);
}

const args = ['prebuild-install', '--runtime', target, '--force'];

if (target === 'electron') {
  const electronPkg = JSON.parse(
    readFileSync(resolve(repoRoot, 'node_modules/electron/package.json'), 'utf8')
  );
  args.push('--target', electronPkg.version);
}

const cwd = resolve(repoRoot, 'node_modules/better-sqlite3');
console.log(`[rebuild-better-sqlite3] target=${target}${target === 'electron' ? ` electron=${args[args.indexOf('--target') + 1]}` : ''}`);

const nativeBinary = resolve(cwd, 'build/Release/better_sqlite3.node');

/**
 * Is the compiled binary locked by a process that has it loaded?
 *
 * Asked of the FILE, not of an error message. Windows maps a loaded `.node` as
 * an executable image and refuses to open it for writing, so this answers
 * directly — and it answers before `prebuild-install` downloads anything.
 *
 * A missing file is not locked (first install), and any other errno is left to
 * the real attempt to report.
 */
function nativeBinaryLocked() {
  try {
    closeSync(openSync(nativeBinary, 'r+'));
    return false;
  } catch (err) {
    return err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES';
  }
}

function reportLocked() {
  console.error('');
  console.error('  ❌  Could not swap the better-sqlite3 binary: the file is locked.');
  console.error('      Some process has it loaded. Close whichever of these is running:');
  console.error('        • TradeAnalyzer / TradeAnalyzer 2');
  console.error('        • `npm run dev`');
  console.error('        • a replay or diagnostic harness — `packages/core/scripts/*`,');
  console.error('          including one left running in the background');
  console.error('');
  console.error(`      ${nativeBinary}`);
  console.error('');
  process.exit(1);
}

// Checked up front. `pretest` runs this, so an unnoticed background process
// turns `npm test` into an unexplained crash with a stack trace pointing at
// `execSync`.
if (nativeBinaryLocked()) reportLocked();

try {
  execSync(`npx ${args.join(' ')}`, { cwd, stdio: 'inherit' });
} catch (err) {
  // The guard below used to be the ONLY one, and it could never fire.
  //
  // It matched `EBUSY` against `err.message` — but `stdio: 'inherit'` sends
  // `prebuild-install`'s output straight to the console, so `err.message` is
  // only ever `Command failed: npx prebuild-install --runtime node --force`.
  // The word EBUSY was on the screen and never in the string being tested, so
  // the friendly message was unreachable and the raw stack came out instead.
  // Found 2026-09-09 by hitting exactly the case it was written for.
  //
  // It now asks the file. The message regex is kept as a second path for the
  // day this is called with captured output, but it is no longer the only one —
  // a guard whose input cannot contain what it looks for is not a guard.
  if (nativeBinaryLocked() || /EBUSY|resource busy or locked|EPERM/i.test(String(err?.message ?? err))) {
    reportLocked();
  }
  throw err;
}
