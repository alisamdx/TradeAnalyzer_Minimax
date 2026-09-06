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
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Rule {
  name: string;
  why: string;
  pattern: RegExp;
  /** `import type` / `export type` erase at compile time and load nothing. */
  allowTypeOnly?: boolean;
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
    fires: [`const dir = app.getPath('userData');`, `safeStorage.encryptString(v);`, `ipcMain.handle('x', f);`],
    clean: [`const dir = host.dataRoot();`, `const p = paths.getPath;`]
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
  const t = line.trim();
  if (!rule.pattern.test(t)) return false;
  if (rule.allowTypeOnly && /^\s*(import|export)\s+type\s/.test(t)) return false;
  return true;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scanTree(rule: Rule): Violation[] {
  const found: Violation[] = [];
  for (const file of sourceFiles(SRC)) {
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((raw, i) => {
        if (matches(rule, raw)) {
          found.push({ file: relative(SRC, file).split(sep).join('/'), line: i + 1, text: raw.trim() });
        }
      });
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
