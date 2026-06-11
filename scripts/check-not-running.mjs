// check-not-running.mjs
// Runs as part of prepackage / prebuild.
// Exits 1 with a clear message if TradeAnalyzer.exe is currently running
// so the package step fails loudly instead of silently building a stale bundle.

import { execSync } from 'child_process';

const EXE_NAME = 'TradeAnalyzer';

let running = false;

try {
  // Use PowerShell explicitly — reliable from any parent shell (cmd, Git Bash, PS).
  const out = execSync(
    `powershell.exe -NoProfile -NonInteractive -Command "Get-Process -Name '${EXE_NAME}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  running = out.toLowerCase() === EXE_NAME.toLowerCase();
} catch {
  // PowerShell unavailable or Get-Process failed — don't block the build
}

if (running) {
  console.error('');
  console.error(`  ❌  ${EXE_NAME}.exe is currently running.`);
  console.error(`      Stop the app first, then re-run:  npm run package`);
  console.error('');
  process.exit(1);
}
