import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
await openGenerationExclusively(${JSON.stringify(dbPath)}, 'probe');
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
    //
    // The file has to exist now: the helper refuses to CREATE a generation,
    // because `new Database(path)` creates and a generation made by anything but
    // TradeAnalyzer 2 has no `meta_generation` row.
    const dir = mkdtempSync(join(tmpdir(), 'gen-access-'));
    const dbPath = join(dir, 'data.sqlite');
    writeFileSync(dbPath, '');

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
    // Anchored on the DECLARATION, not the first mention. Anchoring on the name
    // found the header comment as soon as the header started explaining what
    // lives in this function, and then read the wrong `try` block entirely.
    const decl = src.indexOf('export async function openGenerationExclusively');
    expect(decl, 'openGenerationExclusively is not declared as expected').toBeGreaterThan(-1);
    const tryBlock = src.slice(src.indexOf('try {', decl));
    const body = tryBlock.slice(0, tryBlock.indexOf('} catch'));
    expect(body).toContain("require('better-sqlite3')");
    expect(body).toContain('new Database(dbPath)');
  });

  it('refuses to create a generation that is not there', () => {
    // `new Database(path)` CREATES. A generation made by anything but
    // TradeAnalyzer 2 has 52 tables, `integrity_check: ok` and zero rows in
    // `meta_generation` — healthy from every angle except whose it is, and
    // indistinguishable from the real one having lost its data. The collector
    // host was fixed for this on 2026-09-07; only one of the three scripts had
    // the same refusal, and it was the one nobody was running.
    const dir = mkdtempSync(join(tmpdir(), 'gen-access-'));
    const dbPath = join(dir, 'data.sqlite');

    const { code, out } = runProbe(dbPath);
    expect(code, out).toBe(1);
    expect(out).toContain('Refusing to create one');
    expect(out).not.toContain('OPENED');

    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * The rule that makes a fourth script impossible to get wrong.
 *
 * `exception.mjs` was written after `queue-job.mjs` and
 * `diagnose-generation.mjs`, for the ticker-reuse rulings B5's gate needs, and
 * it opened the live generation with a bare `new Database(dbPath)`: no redirect
 * check, no in-use check, no refusal to create, and no checkpoint on close. Each
 * of those existed already, in one or two of its siblings. Nobody counted the
 * third script in the same directory.
 *
 * So the invariant is asserted rather than remembered: **a script that resolves
 * the shared pointer must open through `lib/generation-access.mjs`.** Scripts
 * that never touch a real generation — the replay arms, the stress test — are
 * free to open whatever they like in their own temporary directory, which is why
 * the rule keys on the pointer and not on `new Database`.
 */
describe('generation-access — no script may open a generation on its own', () => {
  const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url));

  /** Source with comments removed and string literals KEPT. */
  function code(src: string): string {
    // Comments must go: this file's own prose names `new Database(dbPath)` and
    // `data-root.json` repeatedly, and every sibling script explains the very
    // trap being scanned for. A guard that fires on its own documentation
    // teaches one lesson — stop writing the comment — and it is the wrong one.
    //
    // Strings must STAY: the module path `./lib/generation-access.mjs` and the
    // pointer filename are both string literals, so stripping them would make
    // the rule vacuous. (CLAUDE.md: a rule about a module path keeps strings; a
    // rule about reaching a global strips them.)
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  /** Empty when the source is fine; otherwise says what is wrong with it. */
  function violations(src: string): string[] {
    const c = code(src);
    const touchesGeneration =
      c.includes('data-root.json') ||
      c.includes('tradeanalyzer-shared') ||
      c.includes('resolveGenerationPointer');
    if (!touchesGeneration) return [];

    const found: string[] = [];
    if (!c.includes('lib/generation-access.mjs')) {
      found.push('resolves the shared pointer without importing lib/generation-access.mjs');
    }
    if (/new\s+Database\s*\(/.test(c)) {
      found.push('opens the generation directly with `new Database(...)`');
    }
    return found;
  }

  it('fires on a script that opens the pointer database itself', () => {
    // `exception.mjs` as it stood until 2026-09-08, in miniature. Without this
    // arm the scan could be structurally incapable of firing and would look
    // exactly like a rule nothing violates — the own-at-strike band again.
    const offender = `
      import { readFileSync } from 'node:fs';
      const { dataRoot } = JSON.parse(readFileSync(pointer('data-root.json'), 'utf8'));
      const db = new Database(join(dataRoot, 'gen-001', 'data.sqlite'));
    `;
    expect(violations(offender)).toHaveLength(2);
  });

  it('stays quiet on a script that goes through the helper', () => {
    const good = `
      import { openGenerationExclusively, resolveGenerationPointer } from './lib/generation-access.mjs';
      const { dbPath } = await resolveGenerationPointer();
      const db = await openGenerationExclusively(dbPath, 'good.mjs');
    `;
    expect(violations(good)).toEqual([]);
  });

  it('does not fire on prose about the trap', () => {
    // The over-reach arm. Four separate source scans in this project have fired
    // on their own explanatory comments; each failure's only available lesson
    // was "delete the comment".
    const documented = `
      // Never call new Database(dbPath) on the data-root.json generation yourself.
      /* tradeanalyzer-shared holds the pointer; new Database(...) would create it. */
      const x = 1;
    `;
    expect(violations(documented)).toEqual([]);
  });

  it('holds for every script in the directory', () => {
    const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs') || f.endsWith('.cjs'));
    // If this ever reads zero the rule is vacuous, which is a failure and not a pass.
    expect(files.length).toBeGreaterThan(3);

    const offenders = files
      .map((f) => [f, violations(readFileSync(join(SCRIPTS, f), 'utf8'))] as const)
      .filter(([, v]) => v.length > 0)
      .map(([f, v]) => `${f}: ${v.join('; ')}`);

    expect(offenders).toEqual([]);
  });
});
