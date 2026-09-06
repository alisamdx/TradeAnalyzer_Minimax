import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTIONARY, tableNames } from '@tradeanalyzer/core';

/**
 * AC-13 — "Every table appears in the inspector with no table-specific UI code."
 *
 * A screenshot can show that a table renders. It cannot show that the *next*
 * table will, which is the actual claim. So this is a structural test: if the
 * renderer is genuinely schema-driven then **no table name and no column name
 * appears anywhere in it**, and a table added to the dictionary tomorrow renders
 * for exactly the same reason today's does.
 *
 * The moment someone writes `if (table === 'raw_option_contract_snapshot')` to
 * fix one view, that stops being true — and it would be invisible for a long
 * time, because the special case would work.
 */

const RENDERER = fileURLToPath(new URL('../src/renderer', import.meta.url));
const MAIN = fileURLToPath(new URL('../src/main', import.meta.url));

/**
 * Strips comments and string-literal contents before scanning.
 *
 * Learned twice now, once here and once in `core`'s purity guard: a source scan
 * that reads comments fires on its own documentation. This file's own doc
 * comment names `meta_dictionary` and the word OFFSET, and without this both
 * would be reported as violations — which trains everyone to stop writing the
 * comments that explain the rule.
 */
function stripProse(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const rendererSources = sourceFiles(RENDERER).map((f) => ({
  file: relative(RENDERER, f).split(sep).join('/'),
  /** Comments and string contents removed — the scan is about code, not prose. */
  body: stripProse(readFileSync(f, 'utf8')),
  raw: readFileSync(f, 'utf8')
}));

describe('AC-13 — the inspector is schema-driven', () => {
  it('has renderer sources to check', () => {
    expect(rendererSources.length).toBeGreaterThan(3);
  });

  it('names no table from the dictionary anywhere in the renderer', () => {
    const offenders: string[] = [];
    for (const table of tableNames()) {
      for (const { file, body } of rendererSources) {
        if (body.includes(table)) offenders.push(`${file} mentions ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no domain-specific column from the dictionary in the renderer', () => {
    // Two exclusions, both principled rather than convenient.
    //
    // `meta_` columns are excluded wholesale: those tables describe the
    // machinery itself, so `meta_dictionary.nullable` and `meta_dictionary
    // .converter` ARE the generic vocabulary a schema-driven renderer must
    // speak. Naming them is the opposite of table-specific code.
    //
    // The rest are English words that happen to be column names and would match
    // as bare substrings without meaning anything.
    const generic = new Set([
      'status', 'unit', 'description', 'source', 'value', 'date', 'ticker', 'symbol', 'form',
      'name', 'version', 'error', 'domain', 'concept', 'frame', 'active', 'right', 'last', 'open',
      'high', 'low', 'volume', 'price', 'amount', 'quantity', 'strike', 'bid', 'ask', 'weight'
    ]);
    const columnNames = new Set(
      DICTIONARY.filter((t) => t.layer !== 'meta')
        .flatMap((t) => t.columns.map((c) => c.column))
        .filter((c) => !generic.has(c))
    );
    const offenders: string[] = [];
    for (const column of columnNames) {
      // Word boundary, so `expiration_date` does not match inside a longer word.
      const re = new RegExp(`\\b${column}\\b`);
      for (const { file, body } of rendererSources) {
        if (re.test(body)) offenders.push(`${file} mentions ${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('renders null cells from the dictionary status vocabulary, not a hand-written list', () => {
    const cells = rendererSources.find((s) => s.file.endsWith('views/cells.tsx'));
    expect(cells).toBeDefined();
    // Every status the dictionary can produce has a glyph. A status with no
    // glyph would render as a bare dot and silently lose the reason — which is
    // the AC-3 failure this whole component exists to prevent.
    for (const status of ['omitted', 'outside_window', 'invalid', 'not_applicable']) {
      expect(cells!.raw).toContain(status);
    }
  });

  it('never renders a bare blank for a null — AC-3 made visible', () => {
    const cells = rendererSources.find((s) => s.file.endsWith('views/cells.tsx'))!;
    // The null cell always carries a title, and the title always falls back to
    // the declared meaning.
    expect(cells.raw).toMatch(/title=\{title\}/);
    expect(cells.raw).toContain('column.nullMeaning');
  });
});

describe('the main process is the only place that touches SQL', () => {
  it('keeps every SQL string out of the renderer', () => {
    const sqlish = /\b(SELECT|INSERT|UPDATE|DELETE|PRAGMA|CREATE TABLE)\b/;
    const offenders = rendererSources
      .filter((s) => sqlish.test(s.body))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('sorts only on a column the dictionary declares', () => {
    // The dictionary is the allow-list for anything that reaches SQL from the
    // renderer. Without that, a sort column is a string the UI chose that ends
    // up inside an ORDER BY.
    const inspect = readFileSync(join(MAIN, 'inspect.ts'), 'utf8');
    expect(inspect).toContain('entry.columns.some((c) => c.column === req.sortColumn)');
  });

  it('pages by keyset, never OFFSET', () => {
    // OFFSET makes page N cost N pages of scanning. Imperceptible on the empty
    // tables of B2, unusable on the chain snapshot table at B6 — by which time
    // the call site is everywhere.
    const inspect = readFileSync(join(MAIN, 'inspect.ts'), 'utf8');
    expect(stripProse(inspect)).not.toMatch(/\bOFFSET\b/);
    expect(inspect).toContain('LIMIT');
  });
});
