import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Core purity — 06 §1, §7.
 *
 * `core` is Electron-free and native-free: everything environmental enters
 * through `CollectorHost` or a function parameter. This test makes that a build
 * failure rather than a convention.
 *
 * It is a **source scan**, not a runtime check, on purpose: an accidental
 * `import { app } from 'electron'` in a module nothing imports yet would still
 * break packaging later and would be invisible to any test that only exercises
 * reachable code.
 *
 * Every rule carries `fires` and `clean` fixtures and both are asserted below.
 * That is the same discipline 03 §P10 demands of the QC checks, applied to the
 * guard itself — this project has already shipped one gate that was structurally
 * incapable of firing and looked healthy for 62 brief days (CLAUDE.md,
 * own-at-strike). A purity scan that silently matches nothing would fail exactly
 * that way.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strips line and block comments so a rule cannot fire on prose about itself. */
/**
 * Removes comments but keeps every newline, so a violation is reported at the line it is on.
 * Deleting a block comment whole used to renumber everything after it: on 2026-09-18 a match
 * on line 358 of `earnings-fundamentals.ts` was reported as `:33`.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Blanks the contents of string literals, keeping the quotes so syntax survives. */
function stripStringContents(src: string): string {
  // The scan is line-by-line, so a literal never spans a newline here.
  return src
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

interface Rule {
  name: string;
  why: string;
  pattern: RegExp;
  /** `import type` / `export type` erase at compile time and load nothing. */
  allowTypeOnly?: boolean;
  /**
   * Strip string literals before matching. Set on rules about **code reaching a
   * global**, which prose cannot do: the dictionary's own column descriptions
   * name `safeStorage` when explaining that account archives are encrypted, and
   * flagging that would train everyone to work around the guard instead of
   * heeding it. Rules that match a module path keep their strings.
   */
  ignoreStrings?: boolean;
  /** Must be flagged. */
  fires: string[];
  /** Must not be flagged. */
  clean: string[];
}

const RULES: Rule[] = [
  {
    name: 'never imports electron',
    why: 'core must compile and run under plain node, in vitest and in either exe',
    pattern: /\bfrom\s+['"]electron(\/|['"])|\brequire\(\s*['"]electron['"]|\bimport\(\s*['"]electron['"]/,
    fires: [
      `import { app } from 'electron';`,
      `import { safeStorage } from 'electron/main';`,
      `const { app } = require('electron');`,
      `const m = await import('electron');`
    ],
    clean: [`import { x } from 'electron-ish-name';`, `import { y } from './electron-links.js';`]
  },
  {
    name: 'never imports better-sqlite3 at value level',
    why: 'loading the driver would drag the native binary and its ABI flip into core (06 §11)',
    pattern: /\bfrom\s+['"]better-sqlite3['"]|\brequire\(\s*['"]better-sqlite3['"]/,
    allowTypeOnly: true,
    fires: [`import Database from 'better-sqlite3';`, `const D = require('better-sqlite3');`],
    clean: [`import type { Database } from 'better-sqlite3';`, `import type BS from 'better-sqlite3';`]
  },
  {
    name: 'never loads a native module',
    why: 'a native binding is per-runtime; core is imported by two runtimes',
    pattern: /\bfrom\s+['"]bindings['"]|\brequire\(\s*['"]bindings['"]|['"][^'"]*\.node['"]|\bprocess\.dlopen\b/,
    fires: [`const bindings = require('bindings');`, `require('./build/Release/thing.node');`],
    clean: [`import { x } from './node-utils.js';`, `const p = 'something.nodes';`]
  },
  {
    name: 'uses no path aliases',
    why: 'the @shared/* alias is why plain-node harnesses could never import the existing app (CLAUDE.md)',
    pattern: /\bfrom\s+['"]@(shared|main|renderer)\//,
    fires: [`import { T } from '@shared/types';`, `import { s } from '@main/services/x.js';`],
    clean: [`import { T } from '@tradeanalyzer/core';`, `import { u } from '../units/iv.js';`]
  },
  {
    name: 'reaches no Electron-only or app-shaped globals',
    why: 'paths, secrets and IPC are the host’s, injected through CollectorHost (04 §1)',
    pattern: /\bapp\.getPath\(|\bsafeStorage\b|\bipcMain\b|\bipcRenderer\b|\bBrowserWindow\b/,
    // This rule is about code *reaching* a global, which prose cannot do. The
    // dictionary's own column descriptions name `safeStorage` when explaining
    // that account archives are encrypted, and failing on that would train
    // everyone to work around the guard rather than heed it.
    ignoreStrings: true,
    fires: [`const dir = app.getPath('userData');`, `safeStorage.encryptString(v);`, `ipcMain.handle('x', f);`],
    clean: [
      `const dir = host.dataRoot();`,
      `const p = paths.getPath;`,
      `description: 'written through safeStorage/DPAPI (Q20, P15)'`,
      "col.flag('encrypted', '`1` for files written through safeStorage', { sourceProvider: 'collector' })"
    ]
  },
  {
    name: 'makes no network call of its own',
    why: 'providers build and parse; the transport is the host’s, so rate limiting, renew-and-retry and API logging stay in one place',
    pattern: /(^|[^.\w])fetch\s*\(|\bfrom\s+['"]node:(https?|net)['"]|\brequire\(\s*['"]https?['"]/,
    fires: [`const res = await fetch(url);`, `import https from 'node:https';`],
    clean: [`const res = await host.fetch(req);`, `const body = await this.transport.fetch(req);`]
  }
];

function matches(rule: Rule, line: string): boolean {
  const raw = line.trim();
  const t = rule.ignoreStrings ? stripStringContents(raw) : raw;
  if (!rule.pattern.test(t)) return false;
  if (rule.allowTypeOnly && /^\s*(import|export)\s+type\s/.test(t)) return false;
  return true;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** The violations in one file's source, with 1-based line numbers into the ORIGINAL text. */
function scanSource(rule: Rule, src: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  stripComments(src)
    .split('\n')
    .forEach((raw, i) => {
      if (matches(rule, raw)) found.push({ line: i + 1, text: raw.trim() });
    });
  return found;
}

function scanTree(rule: Rule): Violation[] {
  const found: Violation[] = [];
  for (const file of sourceFiles(SRC)) {
    for (const v of scanSource(rule, readFileSync(file, 'utf8'))) {
      found.push({ file: relative(SRC, file).split(sep).join('/'), ...v });
    }
  }
  return found;
}

describe('core purity', () => {
  it('has source files to check — the scan must not pass on an empty tree', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(0);
  });

  describe.each(RULES)('$name', (rule) => {
    it(`holds across core/src (${rule.why})`, () => {
      expect(scanTree(rule).map((v) => `${v.file}:${v.line}  ${v.text}`).join('\n')).toBe('');
    });

    it('flags every violating fixture', () => {
      for (const sample of rule.fires) {
        expect(matches(rule, sample), `should have been flagged: ${sample}`).toBe(true);
      }
    });

    it('leaves every clean fixture alone', () => {
      for (const sample of rule.clean) {
        expect(matches(rule, sample), `should NOT have been flagged: ${sample}`).toBe(false);
      }
    });
  });

  it('ignores a violation that appears only inside a comment', () => {
    const body = stripComments(`// import { app } from 'electron';\nconst x = 1;`);
    expect(body.split('\n').some((l) => matches(RULES[0] as Rule, l))).toBe(false);
  });

  it('reports a violation at its real line, past block and line comments, LF or CRLF', () => {
    const network = RULES.find((r) => r.name === 'makes no network call of its own') as Rule;
    const lines = [
      '/**',
      ' * A doc comment spanning',
      ' * several lines.',
      ' */',
      'const a = 1; // trailing',
      '/* one-line block */ const b = 2;',
      'const res = await fetch(url);'
    ];
    for (const eol of ['\n', '\r\n']) {
      expect(scanSource(network, lines.join(eol)).map((v) => v.line), JSON.stringify(eol)).toEqual([7]);
    }
  });

  it('exports the two version constants the run header needs', async () => {
    const core = await import('../src/index.js');
    expect(core.COLLECTOR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Number.isInteger(core.DICTIONARY_VERSION)).toBe(true);
  });

  it('keeps COLLECTOR_VERSION in step with the package version (it is meta_run.collector_version)', async () => {
    const core = await import('../src/index.js');
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      version: string;
    };
    expect(core.COLLECTOR_VERSION).toBe(pkg.version);
  });
});
