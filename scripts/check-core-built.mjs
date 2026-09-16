#!/usr/bin/env node
/**
 * Refuses to build unless `packages/core/dist` matches `packages/core/src`.
 *
 * **Why this exists.** `@tradeanalyzer/core` is consumed through `dist/`
 * (`package.json` `main`/`exports`), and nothing in the root build ever compiled
 * it — `prepackage` ran the not-running guard and the better-sqlite3 ABI swap and
 * went straight to `electron-vite build`. So `dist/` was whatever the last person
 * to type `tsc` had left there.
 *
 * On 2026-09-15 that shipped v1.1.248 and v1.1.249 with `dist/` from v1.1.245:
 * the cross-day dedup fix, the OSI padding fix, the email cap and the run delta
 * were all committed, all tested, all packaged, and **none of them were in the
 * binary**. It surfaced only because `meta_run.collector_version` recorded
 * `0.6.9` on a run made by an app calling itself 1.1.249 — one run too late, and
 * by luck, because that is the only field anywhere that names the built artefact.
 *
 * Nothing could have caught it earlier: the tests import `src/`, the typecheck
 * reads `src/`, and the version test asserts `src/version.ts` equals
 * `packages/core/package.json` — three checks that agree with each other and say
 * nothing at all about what was shipped. **A suite that runs against source is
 * not evidence about an artefact built from something else.**
 *
 * The real fix is that `prepackage` now builds core. This check is the second
 * half: a build step that silently does not run looks exactly like one that ran,
 * so the result is verified rather than assumed.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(root, 'packages', 'core');
const distVersionFile = join(core, 'dist', 'version.js');

function fail(lines) {
  console.error('');
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

if (!existsSync(distVersionFile)) {
  fail([
    '❌  packages/core/dist is missing — the app imports core from dist, not src.',
    '    Run:  npm run build:core'
  ]);
}

const declared = JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version;
const built = /COLLECTOR_VERSION\s*=\s*'([^']+)'/.exec(readFileSync(distVersionFile, 'utf8'))?.[1];

if (built !== declared) {
  fail([
    `❌  packages/core/dist is STALE: built ${built ?? 'unknown'}, source declares ${declared}.`,
    '    The packaged app would run the old collector while reporting the new app version —',
    '    exactly how v1.1.248 and v1.1.249 shipped with none of their changes in them.',
    '    Run:  npm run build:core'
  ]);
}

/**
 * The version only moves when somebody remembers to bump it, so it cannot catch
 * a source edit made without one. Timestamps can, and a false positive here
 * costs one `tsc` run.
 */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const t = entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

const srcNewest = newestMtime(join(core, 'src'));
const distNewest = newestMtime(join(core, 'dist'));
if (srcNewest > distNewest) {
  fail([
    '❌  packages/core/src is newer than packages/core/dist.',
    `    src  last changed ${new Date(srcNewest).toISOString()}`,
    `    dist last built   ${new Date(distNewest).toISOString()}`,
    '    Run:  npm run build:core'
  ]);
}

console.log(`[check-core-built] packages/core/dist is current (${built}).`);
