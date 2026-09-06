// Cross-platform rebuild of better-sqlite3 against either Electron's or system
// Node's ABI. Reads Electron's actual installed version (so a future Electron
// bump automatically picks up the right prebuild target) instead of hardcoding.
//
// Usage:
//   node scripts/rebuild-better-sqlite3.mjs electron
//   node scripts/rebuild-better-sqlite3.mjs node

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

try {
  execSync(`npx ${args.join(' ')}`, { cwd, stdio: 'inherit' });
} catch (err) {
  // Windows locks a loaded .node file, so a running app makes the swap fail with
  // a bare EBUSY and a stack trace that says nothing about the cause. That is
  // exactly the shape of failure this project keeps paying for: the message
  // names the symptom and hides the fix. `pretest` runs this, and `check-not-
  // running.mjs` guards `package` but not `test`, so a running exe turns
  // `npm test` into an unexplained crash.
  const message = String(err?.message ?? err);
  if (/EBUSY|resource busy or locked|EPERM/i.test(message)) {
    console.error('');
    console.error('  ❌  Could not swap the better-sqlite3 binary: the file is locked.');
    console.error('      An app has it loaded. Close TradeAnalyzer and TradeAnalyzer 2,');
    console.error('      and stop any `npm run dev`, then run this again.');
    console.error('');
    process.exit(1);
  }
  throw err;
}
