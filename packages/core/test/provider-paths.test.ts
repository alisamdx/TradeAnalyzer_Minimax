import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Provider paths carry no unreplaced placeholder.
 *
 * `/stocks/vX/short-interest` shipped with the `vX` from the documentation's
 * own prose still in it. Polygon answers that with an 18-byte
 * "404 page not found", the collector recorded a non-2xx like any other, and the
 * failure was read as **"short interest is not available on our plan"** — which
 * went into 02 §12 as "the one domain with no confirmed free source", into the
 * dictionary as a verify note, and from there into the pilot's promotion
 * blockers. The endpoint is `/stocks/v1/short-interest` and is included in every
 * Polygon Stocks plan.
 *
 * The lesson is not about one typo: **a wrong URL and an unentitled URL are the
 * same HTTP status**, so a 404 is never evidence about a plan until the path is
 * known to be right. A scan is the cheap half of that; the live call is the
 * other half.
 */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Comments may legitimately discuss a placeholder — this file's own do. */
function stripComments(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const COLLECTOR = fileURLToPath(new URL('../src/collector', import.meta.url));

describe('provider paths', () => {
  it('contain no unreplaced version placeholder', () => {
    const offenders: string[] = [];
    for (const file of sources(COLLECTOR)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // A placeholder inside a path segment: /vX/, /vN/, /v{version}/.
      for (const m of code.matchAll(/['"`][^'"`\n]*\/v(?:X|N|\{[^}]*\})\/[^'"`\n]*['"`]/g)) {
        offenders.push(`${file.slice(COLLECTOR.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan can actually fire — a placeholder path is caught', () => {
    // Without this the regex could be wrong and the guard vacuous, which is the
    // failure mode of every source scan in this repo.
    const fixture = `const path = '/stocks/vX/short-interest';`;
    expect(/['"`][^'"`\n]*\/v(?:X|N|\{[^}]*\})\/[^'"`\n]*['"`]/.test(fixture)).toBe(true);
    expect(/['"`][^'"`\n]*\/v(?:X|N|\{[^}]*\})\/[^'"`\n]*['"`]/.test(`'/stocks/v1/short-interest'`)).toBe(false);
  });

  it('short interest reads the documented endpoint', () => {
    const events = stripComments(
      readFileSync(fileURLToPath(new URL('../src/collector/phases/events.ts', import.meta.url)), 'utf8')
    );
    expect(events).toContain("'/stocks/v1/short-interest'");
  });
});
