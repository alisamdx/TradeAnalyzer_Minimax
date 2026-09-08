import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * How the dev scripts are allowed to touch a generation — 06 §3.4.
 *
 * Both rules were paid for on 2026-09-07, when `meta_response` was corrupted
 * twice (`btreeInitPage() returns error code 11`) while these scripts were run
 * against a generation the collector was writing — and the second corruption
 * happened *after* the redirect guard shipped, which is how the redirect was
 * ruled out as the cause.
 *
 * These run the helper in a child process, because both refusals are
 * `process.exit`. That is the right shape for a script — a thrown error in a
 * one-shot tool is a stack trace nobody reads — but it means the only honest
 * test is to run it and look at the exit code.
 */

const LIB = fileURLToPath(new URL('../scripts/lib/generation-access.mjs', import.meta.url));

function runProbe(dbPath: string): { code: number; out: string } {
  // `pathToFileURL`, not a slash-swapped path: the ESM loader rejects a bare
  // `C:/...` specifier outright, so the probe would fail for a reason with
  // nothing to do with what is being tested.
  const script = `import { openGenerationExclusively } from ${JSON.stringify(pathToFileURL(LIB).href)};
openGenerationExclusively(${JSON.stringify(dbPath)});
console.log('OPENED');`;
  const dir = mkdtempSync(join(tmpdir(), 'gen-access-probe-'));
  const file = join(dir, 'probe.mjs');
  writeFileSync(file, script, 'utf8');
  try {
    const out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generation-access — how a script may open a generation', () => {
  it('refuses while an application has the database open', () => {
    // `-shm` exists exactly while some process holds the database, so it is the
    // check. A script and an app on one WAL database, with two different SQLite
    // libraries coordinating through one wal-index, is the corruption mechanism.
    const dir = mkdtempSync(join(tmpdir(), 'gen-access-'));
    const dbPath = join(dir, 'data.sqlite');
    writeFileSync(dbPath, '');
    writeFileSync(`${dbPath}-shm`, '');

    const { code, out } = runProbe(dbPath);
    expect(code).toBe(5);
    expect(out).toMatch(/an application has this[\s\S]*generation open/);
    expect(out).not.toContain('OPENED');

    rmSync(dir, { recursive: true, force: true });
  });

  it('opens when nothing else holds it', () => {
    // The other half of the pair. A guard that refuses everything is not a
    // guard, it is an outage — and it would look identical in a suite that only
    // asserted the refusal.
    const dir = mkdtempSync(join(tmpdir(), 'gen-access-'));
    const dbPath = join(dir, 'data.sqlite');

    const { code, out } = runProbe(dbPath);
    expect(code, out).toBe(0);
    expect(out).toContain('OPENED');

    rmSync(dir, { recursive: true, force: true });
  });

  it('never falls back to node:sqlite when better-sqlite3 cannot load', () => {
    // The ABI mismatch is a real cost of using the applications' own SQLite, and
    // the tempting fix is a fallback. A fallback would reintroduce exactly the
    // library mixing this exists to prevent, at the moment nobody is watching —
    // so the source must not contain one.
    const src = readFileSync(LIB, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/DatabaseSync|from\s+['"]node:sqlite['"]/);
    // And it must still name the fix, because refusing without one is just a wall.
    expect(src).toContain('npm run rebuild:node');
  });

  it('catches the ABI failure where it actually happens', () => {
    // better-sqlite3 loads its binding lazily: `require` succeeds against the
    // wrong ABI and `new Database(...)` is what throws. Guarding only the
    // require let the raw NODE_MODULE_VERSION stack through instead of the
    // message naming the fix. Pinned because the two calls look separable and
    // are not.
    const src = readFileSync(LIB, 'utf8');
    const tryBlock = src.slice(src.indexOf('try {', src.indexOf('openGenerationExclusively')));
    const body = tryBlock.slice(0, tryBlock.indexOf('} catch'));
    expect(body).toContain("require('better-sqlite3')");
    expect(body).toContain('new Database(dbPath)');
  });
});
