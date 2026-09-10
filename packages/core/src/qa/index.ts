/** The quality gate — 03. */
export type {
  CheckContext, CheckDefinition, Distribution, Evaluation, RemediationCode, Severity
} from './check.js';
export { summarise, primaryThreshold, validateDefinition } from './check.js';
export {
  runGate, syncRegistry, recomputeDomainDayStatus, markNotRun, cleanDayStreak,
  fingerprint, ESCALATE_AFTER_RUNS
} from './gate.js';
export type { GateResult, Verdict } from './gate.js';
export { buildStatusEmail, buildNoRunEmail } from './email.js';
export type { EmailModel } from './email.js';
export {
  ALL_CHECKS, CROSS_CUTTING_CHECKS, BAR_CHECKS, QUOTE_AND_ACTION_CHECKS,
  CHAIN_CHECKS, ACCOUNT_CHECKS, EARNINGS_FUNDAMENTALS_CHECKS, MACRO_CHECKS
} from './registry.js';
export { bsDelta, normCdf } from './black-scholes.js';
export {
  acknowledge, bulkAcknowledge, resolve, accept, expireAcceptances, recordTickerReuse, reviewQueue,
  OperatorActionRefused, DEFAULT_ACCEPTANCE_DAYS, MAX_ACCEPTANCE_DAYS
} from './operator.js';
export type { ResolutionKind } from './operator.js';

// B7b's bootstrap checks and their thresholds. `checksFor` is what callers
// should use over `ALL_CHECKS` (already exported above): the difference between
// the two is exactly the set of checks that would otherwise be vacuous.
export { checksFor } from './registry.js';
export {
  ivBootstrapChecks, QC907_BOOTSTRAP_OVERLAP, QC908_BOOTSTRAP_DISAGREEMENT,
  MIN_OVERLAP_DAYS, MAX_MEDIAN_ABS_DIFF
} from './checks/iv-bootstrap.js';
