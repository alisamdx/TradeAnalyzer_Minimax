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
export { ALL_CHECKS, CROSS_CUTTING_CHECKS, BAR_CHECKS, QUOTE_AND_ACTION_CHECKS } from './registry.js';
export {
  acknowledge, resolve, accept, expireAcceptances, recordTickerReuse, reviewQueue,
  OperatorActionRefused, DEFAULT_ACCEPTANCE_DAYS
} from './operator.js';
export type { ResolutionKind } from './operator.js';
