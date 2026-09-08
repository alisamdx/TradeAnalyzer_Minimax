import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNotRedirected, detectRedirect, shadowSuffixes } from '../src/db/appdata-redirect.js';

/**
 * The redirect guard — CLAUDE.md, and the reason gen-001 was destroyed twice on
 * 2026-09-07.
 *
 * The probe itself cannot be unit-tested end to end without a real MSIX
 * container, so what is pinned here is the part that decides **whether to probe
 * at all** and the part that decides **what a non-answer means**. Both have a
 * failure mode this project has shipped before: a check that is structurally
 * incapable of firing looks exactly like a check nothing violates (the
 * own-at-strike conviction band, 62 briefs, 0 rejections). So `shadowSuffixes`
 * is asserted in both directions — it must produce a candidate for a path that
 * *is* under AppData, and none for one that is not — because if it silently
 * produced none for everything the guard would be decorative and no test that
 * only asserted "does not throw" would notice.
 */

const REAL_APPDATA = process.env['APPDATA'];
const REAL_LOCAL = process.env['LOCALAPPDATA'];

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'redirect-guard-'));
});

afterEach(() => {
  if (REAL_APPDATA === undefined) delete process.env['APPDATA'];
  else process.env['APPDATA'] = REAL_APPDATA;
  if (REAL_LOCAL === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = REAL_LOCAL;
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * A container whose `LocalCache\Roaming` really *is* the directory being probed,
 * so a marker written into the latter genuinely appears in the former — which is
 * what a redirect does. A junction is used because that is the only way to make
 * one write land in two places without an actual MSIX package.
 *
 * Junction creation needs no elevation on Windows; on other platforms a plain
 * symlink does the same job, which is why `detectRedirect` honours an injected
 * `packagesRoot` even off Windows. Without this the suite could only ever assert
 * that the guard does *not* fire.
 */
function buildFakeContainer(): { roaming: string; packagesRoot: string } {
  const roaming = join(sandbox, 'Roaming');
  process.env['APPDATA'] = roaming;
  process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
  mkdirSync(roaming, { recursive: true });

  const packagesRoot = join(sandbox, 'Packages');
  const localCache = join(packagesRoot, 'Fake.Package_abc123', 'LocalCache');
  mkdirSync(localCache, { recursive: true });
  symlinkSync(roaming, join(localCache, 'Roaming'), 'junction');
  return { roaming, packagesRoot };
}

describe('shadowSuffixes — where a directory would appear inside a container', () => {
  it('names the container path for a directory under Roaming', () => {
    const roaming = join(sandbox, 'Roaming');
    process.env['APPDATA'] = roaming;
    expect(shadowSuffixes(join(roaming, 'trade-analyzer-next', 'data'))).toContain(
      join('Roaming', 'trade-analyzer-next', 'data')
    );
  });

  it('names the container path for the Roaming root itself', () => {
    const roaming = join(sandbox, 'Roaming');
    process.env['APPDATA'] = roaming;
    expect(shadowSuffixes(roaming)).toContain('Roaming');
  });

  it('distinguishes Local from Roaming rather than assuming one', () => {
    process.env['APPDATA'] = join(sandbox, 'Roaming');
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    expect(shadowSuffixes(join(sandbox, 'Local', 'app'))).toContain(join('Local', 'app'));
    expect(shadowSuffixes(join(sandbox, 'Local', 'app'))).not.toContain(join('Roaming', 'app'));
  });

  it('produces nothing for a path outside AppData, so no probe is written there', () => {
    process.env['APPDATA'] = join(sandbox, 'Roaming');
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    // A generation on another volume is not subject to AppData redirection, and
    // the guard must answer that without touching the filesystem.
    expect(shadowSuffixes(join(sandbox, 'elsewhere', 'gen-001'))).toEqual([]);
  });

  it('is not fooled by a sibling whose name merely starts the same way', () => {
    const roaming = join(sandbox, 'Roaming');
    process.env['APPDATA'] = roaming;
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    expect(shadowSuffixes(`${roaming}-backup`)).toEqual([]);
  });
});

describe('detectRedirect', () => {
  it('reports a path outside AppData as not redirected, and leaves no probe behind', () => {
    process.env['APPDATA'] = join(sandbox, 'Roaming');
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    const dir = join(sandbox, 'elsewhere');
    mkdirSync(dir, { recursive: true });

    expect(detectRedirect(dir).redirectedTo).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('probes the nearest existing ancestor when the generation directory does not exist yet', () => {
    process.env['APPDATA'] = join(sandbox, 'Roaming');
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    const parent = join(sandbox, 'elsewhere');
    mkdirSync(parent, { recursive: true });

    // First run: the pointer names a generation directory nothing has created.
    // The guard still has to answer, because refusing to answer would mean
    // refusing to start.
    expect(detectRedirect(join(parent, 'gen-001')).probed).toBe(parent);
  });

  it('says "undetermined" rather than "redirected" when it cannot answer', () => {
    // No container store to search, so the question is genuinely unanswered. The
    // distinction matters: a cheap local check standing in for an authority must
    // be able to say "don't know", never "no" — the stale-token check made
    // exactly that mistake and demanded a re-auth on a working token. Here "no"
    // would mean refusing to start the only application that can open the data.
    const roaming = join(sandbox, 'Roaming');
    process.env['APPDATA'] = roaming;
    mkdirSync(roaming, { recursive: true });

    const finding = detectRedirect(roaming, { packagesRoot: join(sandbox, 'no-such-store') });
    expect(finding.redirectedTo).toBeNull();
    expect(finding.undetermined).toBeTruthy();
  });

  it('leaves no probe file behind in a directory it did write to', () => {
    const roaming = join(sandbox, 'Roaming', 'trade-analyzer-next');
    process.env['APPDATA'] = join(sandbox, 'Roaming');
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    mkdirSync(roaming, { recursive: true });
    writeFileSync(join(roaming, 'keep.txt'), 'x', 'utf8');

    detectRedirect(roaming);
    expect(readdirSync(roaming)).toEqual(['keep.txt']);
  });
});

describe('assertNotRedirected', () => {
  it('lets an ordinary directory through', () => {
    process.env['APPDATA'] = join(sandbox, 'Roaming');
    process.env['LOCALAPPDATA'] = join(sandbox, 'Local');
    const dir = join(sandbox, 'elsewhere');
    mkdirSync(dir, { recursive: true });
    expect(() => assertNotRedirected([dir], 'TestApp')).not.toThrow();
  });

  it('throws when a directory IS redirected, naming both paths', () => {
    const { roaming, packagesRoot } = buildFakeContainer();
    expect(() => assertNotRedirected([roaming], 'TestApp', { packagesRoot })).toThrow(
      /TestApp was launched from a containerised process/
    );
    expect(() => assertNotRedirected([roaming], 'TestApp', { packagesRoot })).toThrow(
      /LocalCache/
    );
  });

  it('checks every directory it is given, not only the first', () => {
    // The pointer lives under %APPDATA% and the generation may not, so both are
    // passed. Patching one call site and leaving the other is the trap this
    // project has hit repeatedly (the portfolio cash snapshot, the E*Trade OAuth
    // transport) — so the loop is asserted with the redirect on the SECOND entry,
    // where a first-only check would pass silently.
    const { roaming, packagesRoot } = buildFakeContainer();
    const clean = join(sandbox, 'elsewhere');
    mkdirSync(clean, { recursive: true });

    expect(() => assertNotRedirected([clean], 'TestApp', { packagesRoot })).not.toThrow();
    expect(() => assertNotRedirected([clean, roaming], 'TestApp', { packagesRoot })).toThrow(
      /containerised/
    );
  });
});
