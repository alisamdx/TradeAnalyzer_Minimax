import type { CheckDefinition } from './check.js';
import { CROSS_CUTTING_CHECKS } from './checks/cross-cutting.js';
import { BAR_CHECKS } from './checks/bars.js';
import { QUOTE_AND_ACTION_CHECKS } from './checks/quotes-actions.js';
import { CHAIN_CHECKS } from './checks/chains.js';
import { ACCOUNT_CHECKS } from './checks/account.js';

/**
 * Every registered check — 03 §3.
 *
 * The full catalogue is 63 checks. A check is registered when the phase that
 * writes its tables ships, never before: one registered against a table nothing
 * writes yet would evaluate zero things every run and sit in the zero-fire list
 * looking exactly like a check that is silently broken.
 *
 * B4 brought cross-cutting, bars, quotes and corporate actions; B6 adds chains
 * and account with phases 5 through 7.
 */
export const ALL_CHECKS: readonly CheckDefinition[] = [
  ...CROSS_CUTTING_CHECKS,
  ...BAR_CHECKS,
  ...QUOTE_AND_ACTION_CHECKS,
  ...CHAIN_CHECKS,
  ...ACCOUNT_CHECKS
];

export { CROSS_CUTTING_CHECKS, BAR_CHECKS, QUOTE_AND_ACTION_CHECKS, CHAIN_CHECKS, ACCOUNT_CHECKS };
