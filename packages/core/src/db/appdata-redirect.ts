import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Refusing to open a generation from a process whose filesystem view is
 * redirected — CLAUDE.md, 06 §3.1.
 *
 * A containerised (MSIX/packaged) Windows process has `%APPDATA%` silently
 * redirected into its package's `LocalCache\Roaming`, with **copy-on-write**:
 * reads fall through to the real file until the first write, at which point
 * Windows makes a private copy. Nothing announces it. `%APPDATA%` still reads as
 * the real path, and `process.execPath`, `cwd()` and `import.meta.url` are not
 * rewritten — a first version of this guard pattern-matched those and did not
 * fire.
 *
 * **For a WAL database this is not a stale read, it is a split.** `data.sqlite`
 * is copy-on-written into the container while `-wal` and `-shm` still fall
 * through to the real ones, so two processes coordinate through one lock while
 * writing two different base files, and on close the checkpoint lands in
 * whichever `data.sqlite` that process can see. That destroyed gen-001 twice on
 * 2026-09-07: `PRAGMA integrity_check` reported `btreeInitPage() returns error
 * code 11` descending through one btree — root page 5, `meta_response`, the
 * table `universe_seed` was writing — at an identical 2,318,336 bytes on two
 * independent runs. Deterministic, because it is not I/O damage: it is two
 * writers on one lock and two files.
 *
 * The guard lived only in the two dev scripts, which is exactly the trap this
 * project keeps re-learning — a capability that must apply to every caller
 * belongs in the function they all call. **The exes are where the damage
 * happens**, so both of them check here, on the one path that opens a
 * generation, before any SQLite handle exists.
 */

export interface RedirectFinding {
  /** The directory actually probed — the nearest existing ancestor of the one asked about. */
  readonly probed: string;
  /** Where the write landed, or null when it landed where it said it would. */
  readonly redirectedTo: string | null;
  /**
   * Set when the question could not be answered at all: not Windows, no package
   * store, nothing writable. **Never reported as redirected** — a cheap local
   * check standing in for an authority must be allowed to say "don't know",
   * never "no" (CLAUDE.md), and here "don't know" has to mean carry on, because
   * refusing to open the only database on an inconclusive probe is the worse
   * failure.
   */
  readonly undetermined?: string;
}

/** The nearest ancestor of `dir` that exists, so a not-yet-created directory can still be probed. */
function nearestExisting(dir: string): string | undefined {
  let cur = dir;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/**
 * The three real AppData roots, each with the `LocalCache` subdirectory a
 * container shadows it into. Only paths under one of these are subject to the
 * redirect, so a generation on another volume is answered without a probe.
 */
function appDataRoots(): readonly { readonly cacheDir: string; readonly root: string }[] {
  const home = homedir();
  return [
    { cacheDir: 'Roaming', root: process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming') },
    { cacheDir: 'Local', root: process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local') },
    { cacheDir: 'LocalLow', root: join(home, 'AppData', 'LocalLow') }
  ];
}

/** Where `dir` would appear inside a package container, for each root it sits under. */
export function shadowSuffixes(dir: string): readonly string[] {
  const out: string[] = [];
  for (const { cacheDir, root } of appDataRoots()) {
    const rel = relative(root, dir);
    if (rel === '') out.push(cacheDir);
    else if (!rel.startsWith('..') && !isAbsolute(rel)) out.push(join(cacheDir, rel));
  }
  return out;
}

/**
 * Answers "does a write here land where it says it does" by **measuring it**.
 *
 * Writing a marker and going looking for it is the only honest test, because
 * everything the process can read about itself says the redirect is not there.
 */
export interface RedirectProbeOptions {
  /**
   * Where the package containers live. Defaults to the real store.
   *
   * A seam, and a load-bearing one: without it the guard can only be tested for
   * *not* firing, and a check that is structurally incapable of firing is
   * indistinguishable from a check nothing violates — this project shipped one
   * that rejected 0 of 39 picks across 62 briefs and looked healthy throughout
   * (CLAUDE.md, own-at-strike). With it, a test builds a container whose
   * `LocalCache\Roaming` really is the probed directory and asserts the throw.
   */
  readonly packagesRoot?: string;
}

export function detectRedirect(dir: string, opts: RedirectProbeOptions = {}): RedirectFinding {
  const probed = nearestExisting(dir);
  if (probed === undefined) {
    return { probed: dir, redirectedTo: null, undetermined: `no part of ${dir} exists yet` };
  }
  if (process.platform !== 'win32' && opts.packagesRoot === undefined) {
    return {
      probed,
      redirectedTo: null,
      undetermined: 'not Windows — AppData redirection is a Windows container behaviour'
    };
  }

  const suffixes = shadowSuffixes(probed);
  if (suffixes.length === 0) {
    // Outside AppData entirely, so no container redirects it. Answered without
    // writing anything.
    return { probed, redirectedTo: null };
  }

  const packages = opts.packagesRoot ?? join(homedir(), 'AppData', 'Local', 'Packages');
  if (!existsSync(packages)) {
    return { probed, redirectedTo: null, undetermined: 'no package container store on this machine' };
  }

  const marker = `.generation-redirect-probe-${process.pid}-${Date.now()}`;
  const probeFile = join(probed, marker);
  try {
    writeFileSync(probeFile, 'probe', 'utf8');
  } catch (err) {
    return {
      probed,
      redirectedTo: null,
      undetermined: `could not write a probe into ${probed}: ${(err as Error).message}`
    };
  }

  try {
    for (const pkg of readdirSync(packages)) {
      for (const suffix of suffixes) {
        const shadowDir = join(packages, pkg, 'LocalCache', suffix);
        if (existsSync(join(shadowDir, marker))) return { probed, redirectedTo: shadowDir };
      }
    }
    return { probed, redirectedTo: null };
  } catch (err) {
    return {
      probed,
      redirectedTo: null,
      undetermined: `could not search the container store: ${(err as Error).message}`
    };
  } finally {
    try {
      rmSync(probeFile, { force: true });
    } catch {
      // Best effort. A leftover zero-byte marker is harmless, and failing to
      // remove one must never be why an application refuses to start.
    }
  }
}

/**
 * Throws unless every one of `dirs` is what it claims to be.
 *
 * Called before the first `new Database(...)` on the generation, by **both**
 * applications. The message is what the operator reads in a startup dialog, so
 * it says what happened, why it looks fine from the inside, and what to do.
 */
export function assertNotRedirected(
  dirs: readonly string[],
  appName: string,
  opts: RedirectProbeOptions = {}
): void {
  for (const dir of dirs) {
    const finding = detectRedirect(dir, opts);
    if (finding.redirectedTo === null) continue;
    throw new Error(
      `${appName} was launched from a containerised process, so its writes to\n` +
        `  ${finding.probed}\n` +
        'are silently redirected into\n' +
        `  ${finding.redirectedTo}\n\n` +
        'Opening the generation from here would not be a read. SQLite would keep its lock and ' +
        'write-ahead log on the real files while writing a private copy of data.sqlite, and the ' +
        'checkpoint on close would land in that copy — which corrupts the generation and leaves ' +
        'the data where nobody will open it again.\n\n' +
        'None of this is visible from inside the process: %APPDATA% still reads as the real ' +
        'path, and every write reads back perfectly.\n\n' +
        `Close this instance and start ${appName} normally — from the Start menu or by ` +
        'double-clicking the executable — never from a terminal embedded in a packaged app.'
    );
  }
}
