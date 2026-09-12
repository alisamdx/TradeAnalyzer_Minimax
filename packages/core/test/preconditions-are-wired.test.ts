import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A precondition that exists only in a comment is not a precondition.
 *
 * `backfillQueueClear` carried this docstring from B5 until 2026-09-11:
 *
 *   "Whether the backfill's review queue is clear — B5's gate, and a
 *    precondition on the pilot's clean-day streak (04 §7.2). ... Counting such
 *    a day toward the streak would certify a generation whose history is known
 *    to be wrong."
 *
 * It was referenced by **nothing**. `pilotExitStatus` never called it, so a
 * generation could have been promoted with an unruled ticker-reuse candidate
 * outstanding — the precise outcome the comment said must never happen. The
 * function was correct, exported, and inert.
 *
 * This is the same family as `void dte;` sitting after a `return`, as the
 * hand-off comment claiming the host signed a request it never signed, and as
 * `ref_macro_series` being read by a blocking check and written by nobody. In
 * each, prose asserted a mechanism that did not exist, and prose is what gets
 * read when someone asks "is this handled?".
 *
 * So: any function whose own documentation calls it a **precondition on** or
 * **gate on** something must be referenced somewhere other than its own
 * definition. The scan is deliberately crude — it cannot tell a real wiring from
 * a passing mention — but it cannot be satisfied by a comment alone, which is
 * the failure it exists to catch.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Exported functions whose docstring claims to gate something. */
function claimedPreconditions(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const file of sources(SRC)) {
    const code = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    // A block comment immediately followed by an exported function.
    for (const m of code.matchAll(/\/\*\*([\s\S]*?)\*\/\s*export function (\w+)/g)) {
      const doc = (m[1] as string).toLowerCase();
      if (/precondition on|gate on|gates the|is a precondition/.test(doc)) {
        out.push({ file, name: m[2] as string });
      }
    }
  }
  return out;
}

describe('a documented precondition is wired to something', () => {
  it('finds the claims at all — the scan must not be vacuous', () => {
    // If this ever reaches zero, the regex stopped matching and every assertion
    // below passes for free. The guard that guards the guard.
    expect(claimedPreconditions().length).toBeGreaterThan(0);
  });

  it('every function claiming to be a precondition is referenced elsewhere', () => {
    const files = sources(SRC);
    const unwired: string[] = [];

    for (const claim of claimedPreconditions()) {
      const referencedElsewhere = files.some((file) => {
        if (file === claim.file) return false;
        return new RegExp(`\\b${claim.name}\\b`).test(readFileSync(file, 'utf8'));
      });
      if (!referencedElsewhere) {
        unwired.push(`${claim.name} (${claim.file.slice(SRC.length + 1)}) documents a precondition but nothing calls it`);
      }
    }

    expect(unwired).toEqual([]);
  });
});
