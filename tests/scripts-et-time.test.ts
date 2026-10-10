import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs helper, no type declarations
import { etDate, etParts } from '../scripts/lib/et-time.mjs';

/**
 * Four analysis scripts converted UTC to ET with a fixed −4 h. That is right only under EDT:
 * from the first Sunday of November it reads one hour late, so every ET hour is one too high
 * and 23:00–23:59 ET lands on the next calendar day. They now share `scripts/lib/et-time.mjs`.
 */
describe('scripts/lib/et-time.mjs', () => {
  it('gets the ET date right in summer and in winter', () => {
    // 19:30 EDT = 23:30Z. Fixed −4 h was right under EDT.
    expect(etDate('2026-10-08T23:30:00Z')).toBe('2026-10-08');
    // 23:30 EST = 04:30Z. Fixed −4 h reads 00:30 on the NEXT day.
    expect(etDate('2026-11-10T04:30:00Z')).toBe('2026-11-09');
  });

  it('gives the ET hour 0-23, shifting at the DST change', () => {
    expect(etParts('2026-10-08T14:15:00Z')).toEqual({ date: '2026-10-08', hour: 10 }); // EDT
    expect(etParts('2026-11-09T15:15:00Z')).toEqual({ date: '2026-11-09', hour: 10 }); // EST
    expect(etParts('2026-10-09T04:14:00Z')).toEqual({ date: '2026-10-09', hour: 0 });  // never 24
  });

  it('accepts a Date or epoch ms as well as an ISO string', () => {
    const ms = Date.parse('2026-11-10T04:30:00Z');
    expect(etDate(ms)).toBe('2026-11-09');
    expect(etDate(new Date(ms))).toBe('2026-11-09');
  });
});

describe('no script converts to ET with a fixed offset', () => {
  // Comments stripped first (CLAUDE.md, source-scan quirk): the helper's own header describes
  // the pattern it replaces.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fixedOffset = /getTime\(\)\s*-\s*[45]\s*\*\s*(3600_000|3600000|3_600_000|60\s*\*\s*60\s*\*\s*1000)/;

  it('fires on the old pattern and not on clean code (guard is not vacuous)', () => {
    expect(fixedOffset.test(strip('const d = new Date(new Date(iso).getTime() - 4 * 3600_000);'))).toBe(true);
    expect(fixedOffset.test(strip('// was: getTime() - 4 * 3600_000\nconst d = etDate(iso);'))).toBe(false);
  });

  it('holds for every script', () => {
    const dir = join(__dirname, '../scripts');
    const offenders = readdirSync(dir)
      .filter((f) => /\.(mjs|cjs|js)$/.test(f))
      .filter((f) => fixedOffset.test(strip(readFileSync(join(dir, f), 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
