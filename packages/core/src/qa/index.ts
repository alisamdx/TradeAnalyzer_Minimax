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
export {
  computeRunDelta, baselineRun, deltaHeadline, deltaLines,
  type RunDelta, type CheckDelta, type DeltaKind
} from './delta.js';
export type { EmailModel } from './email.js';
export {
  ALL_CHECKS, CROSS_CUTTING_CHECKS, BAR_CHECKS, QUOTE_AND_ACTION_CHECKS,
  CHAIN_CHECKS, ACCOUNT_CHECKS, EARNINGS_FUNDAMENTALS_CHECKS, MACRO_CHECKS
} from './registry.js';
export { bsDelta, normCdf, impliedSpotFromDelta, paritySpot } from './black-scholes.js';
export { greekConsistencyFor } from './checks/chains.js';
export {
  acknowledge, bulkAcknowledge, resolve, accept, expireAcceptances, recordTickerReuse, reviewQueue,
  OperatorActionRefused, DEFAULT_ACCEPTANCE_DAYS, MAX_ACCEPTANCE_DAYS
} from './operator.js';
export type { ResolutionKind } from './operator.js';

// B10a — the replay checks and pilot exit (03 §8).
export {
  REPLAY_CHECKS, QC951_REPLAY_EQUIVALENCE, QC956_REPLAY_OVERDUE, REPLAY_MAX_AGE_TRADING_DAYS,
  completedReplays, latestReplayPerDate, sessionsSincePassingReplay
} from './checks/replay.js';
export type { CompletedReplay } from './checks/replay.js';
export {
  PILOT_CLEAN_DAYS, zeroFireReview, thresholdReview, recordCheckRuling, recordDomainInspection,
  gateDomains, pilotExitStatus, promoteToProduction, promoteConfirmationText
} from './pilot-exit.js';
export type {
  RulingReview, RulingDecision, ZeroFireDecision, ThresholdDecision, Ruling, ZeroFireItem, ThresholdItem,
  Bounds, ShapeVerdict, Condition, ConditionKey, PilotExitStatus, PilotExitOptions
} from './pilot-exit.js';

// B7b's bootstrap checks and their thresholds. `checksFor` is what callers
// should use over `ALL_CHECKS` (already exported above): the difference between
// the two is exactly the set of checks that would otherwise be vacuous.
export { checksFor } from './registry.js';
export {
  ivBootstrapChecks, QC907_BOOTSTRAP_OVERLAP, QC908_BOOTSTRAP_DISAGREEMENT,
  MIN_OVERLAP_DAYS, MAX_MEDIAN_ABS_DIFF
} from './checks/iv-bootstrap.js';
