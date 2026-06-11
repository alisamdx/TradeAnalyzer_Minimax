// check-not-running.mjs
// Runs as part of prepackage / prebuild.
// Exits 1 with a clear message if TradeAnalyzer.exe is currently running
// so the package step fails loudly instead of silently overwriting a locked build.

import { execSync } from 'child_process';

const EXE = 'TradeAnalyzer.exe';

try {
  const out = execSync(`tasklist /FI "IMAGENAME eq ${EXE}" /NH 2>NUL`, { encoding: 'utf8' });
  if (out.includes(EXE)) {
    console.error('');
    console.error(`  ❌  ${EXE} is currently running.`);
    console.error(`      Stop the app first, then re-run:  npm run package`);
    console.error('');
    process.exit(1);
  }
} catch {
  // tasklist unavailable or failed — don't block the build
}
