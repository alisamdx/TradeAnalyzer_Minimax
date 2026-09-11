import type { CheckDefinition } from './check.js';
import { CROSS_CUTTING_CHECKS } from './checks/cross-cutting.js';
import { BAR_CHECKS } from './checks/bars.js';
import { QUOTE_AND_ACTION_CHECKS } from './checks/quotes-actions.js';
import { CHAIN_CHECKS } from './checks/chains.js';
import { ACCOUNT_CHECKS } from './checks/account.js';
import { EARNINGS_FUNDAMENTALS_CHECKS } from './checks/earnings-fundamentals.js';
import { MACRO_CHECKS } from './checks/macro.js';
import { ivBootstrapChecks } from './checks/iv-bootstrap.js';
import { REPLAY_CHECKS } from './checks/replay.js';
import type { SqliteLike } from '../db/sqlite-like.js';

/**
 * Every registered check — 03 §3.
 *
 * The full catalogue is 63 checks. A check is registered when the phase that
 * writes its tables ships, never before: one registered against a table nothing
 * writes yet would evaluate zero things every run and sit in the zero-fire list
 * looking exactly like a check that is silently broken.
 *
 * B4 brought cross-cutting, bars, quotes and corporate actions; B6 added chains
 * and account with phases 5 through 7; B7a added earnings, fundamentals and the
 * macro/sentiment domains with phase 8. B10a added the replay pair (QC-951,
 * QC-956) — replay itself shipped at B9b, so they read a table that is written.
 *
 * **B7b's two bootstrap checks are NOT in this list**, because they are the one
 * pair whose registration is conditional on data rather than on a shipped phase
 * — see `checksFor`. An unbought bootstrap has nothing to compare, and a check
 * that *cannot* fire sitting in QC-952's zero-fire review is how that review
 * stops being read.
 */
export const ALL_CHECKS: readonly CheckDefinition[] = [
  ...CROSS_CUTTING_CHECKS,
  ...BAR_CHECKS,
  ...QUOTE_AND_ACTION_CHECKS,
  ...CHAIN_CHECKS,
  ...ACCOUNT_CHECKS,
  ...EARNINGS_FUNDAMENTALS_CHECKS,
  ...MACRO_CHECKS,
  ...REPLAY_CHECKS
];

/**
 * The checks to run against this generation, right now.
 *
 * `ALL_CHECKS` plus whichever conditional ones the data supports. Callers should
 * prefer this over `ALL_CHECKS`: the difference between them is exactly the set
 * of checks that would otherwise be vacuous, and a vacuous check is
 * indistinguishable from a broken one at the point it matters.
 */
export function checksFor(db: SqliteLike): readonly CheckDefinition[] {
  return [...ALL_CHECKS, ...ivBootstrapChecks(db)];
}

export {
  CROSS_CUTTING_CHECKS, BAR_CHECKS, QUOTE_AND_ACTION_CHECKS, CHAIN_CHECKS, ACCOUNT_CHECKS,
  EARNINGS_FUNDAMENTALS_CHECKS, MACRO_CHECKS, REPLAY_CHECKS
};
export {
  ivBootstrapChecks, QC907_BOOTSTRAP_OVERLAP, QC908_BOOTSTRAP_DISAGREEMENT,
  MIN_OVERLAP_DAYS, MAX_MEDIAN_ABS_DIFF
} from './checks/iv-bootstrap.js';
