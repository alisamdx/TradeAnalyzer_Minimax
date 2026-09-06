// check-not-running.mjs
// Runs as part of prebuild / prepackage, for BOTH apps.
//
// Exits 1 with a clear message if either exe is currently running, so the
// package step fails loudly instead of silently building a stale bundle.
// Both are checked from either app's build because in stage 1 they share a
// generation directory: the existing app hosts the collector (writer) and the
// new exe holds the same DB open (reader). 06 §4.

import { execSync } from 'child_process';

// Process names as Windows reports them — the exe basename without `.exe`.
//
// These follow `executableName`, NOT `productName`. The new app displays as
// "TradeAnalyzer 2" but ships as `TradeAnalyzer2.exe`, deliberately: a space in
// an executable name has to be quoted in every script, shortcut and command line
// that ever touches it, and the one that forgets fails in a way that looks like
// the file is missing.
const APPS = [
  { proc: 'TradeAnalyzer', label: 'TradeAnalyzer (existing app)' },
  { proc: 'TradeAnalyzer2', label: 'TradeAnalyzer 2 (new exe)' }
];

function isRunning(proc) {
  try {
    // PowerShell explicitly — reliable from any parent shell (cmd, Git Bash, PS).
    // -Name matches without the .exe suffix and is not a wildcard here, so
    // 'TradeAnalyzer' does not match 'TradeAnalyzer 2'.
    const out = execSync(
      `powershell.exe -NoProfile -NonInteractive -Command "Get-Process -Name '${proc}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return out.toLowerCase() === proc.toLowerCase();
  } catch {
    // PowerShell unavailable or Get-Process failed — don't block the build.
    return false;
  }
}

const running = APPS.filter((a) => isRunning(a.proc));

if (running.length > 0) {
  console.error('');
  for (const a of running) console.error(`  ❌  ${a.label} is currently running.`);
  console.error(`      Stop it first, then re-run the build.`);
  console.error('');
  process.exit(1);
}
