/**
 * Written to `meta_run.collector_version` on every run (06 §2, §6).
 *
 * Its own module so `collector/` can read it without importing the package root,
 * which would be a cycle. A test asserts it equals this package's `version`:
 * drift between the two would mislabel every run of a generation, silently, and
 * only visibly much later.
 */
export const COLLECTOR_VERSION = '0.6.34';
