import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The workspace's own version bookkeeping.
 *
 * `packages/next` required `@tradeanalyzer/core` at `"0.1.0"` while core was
 * 0.6.1 — six minor versions of drift, unnoticed because npm links a workspace
 * package by name and the build worked anyway. It was not harmless: `npm ls`
 * exited non-zero with `invalid: "0.1.0" from packages/next`, and core is
 * private and unpublished, so a resolution that ever took the range seriously
 * would look for a registry package that does not exist.
 *
 * A pinned range recreates the same trap on the next core bump, so the range is
 * `*` — always satisfied by whatever the workspace links — and this test says so
 * rather than leaving it to look like carelessness.
 */

function json(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as Record<string, unknown>;
}

const nextPkg = json('../package.json');
const corePkg = json('../../core/package.json');
const lock = json('../../../package-lock.json');

describe('workspace version bookkeeping', () => {
  it('the core dependency range cannot go stale as core moves', () => {
    const deps = nextPkg['dependencies'] as Record<string, string>;
    const range = deps['@tradeanalyzer/core'];
    // `*` needs no maintenance; an exact pin is allowed only while it is correct.
    expect(range === '*' || range === corePkg['version']).toBe(true);
  });

  it('package-lock records each workspace package at the version it actually is', () => {
    // The lock held 0.1.0 for both packages long after they had moved. `npm ci`
    // builds from the lock, so a stale entry is the version a clean machine gets
    // told it has. Refresh with: npm install --package-lock-only
    const packages = lock['packages'] as Record<string, { version?: string }>;
    expect(packages['packages/core']?.version).toBe(corePkg['version']);
    expect(packages['packages/next']?.version).toBe(nextPkg['version']);
  });
});
