import type { CheckDefinition } from './check.js';
import { CROSS_CUTTING_CHECKS } from './checks/cross-cutting.js';
import { BAR_CHECKS } from './checks/bars.js';
import { QUOTE_AND_ACTION_CHECKS } from './checks/quotes-actions.js';

/**
 * Every registered check — 03 §3.
 *
 * The full catalogue is 63 checks; B4 implements the ones for the domains that
 * exist (cross-cutting, bars, quotes, corporate actions). The rest arrive with
 * their phases, because a check registered against a table nothing writes yet
 * would evaluate zero things every run and sit in the zero-fire list looking
 * exactly like a check that is silently broken.
 */
export const ALL_CHECKS: readonly CheckDefinition[] = [
  ...CROSS_CUTTING_CHECKS,
  ...BAR_CHECKS,
  ...QUOTE_AND_ACTION_CHECKS
];

export { CROSS_CUTTING_CHECKS, BAR_CHECKS, QUOTE_AND_ACTION_CHECKS };
