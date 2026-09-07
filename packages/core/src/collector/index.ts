/**
 * The collector — 04. A library with no Electron, no scheduler and no network
 * client of its own; everything environmental arrives through `CollectorHost`.
 */
export type { CollectorHost, ProviderResponse, ProviderName } from './host.js';
export { CollectorCancelled, throwIfCancelled } from './host.js';

export {
  archiveResponse,
  readArchivedResponse,
  verifyArchivedResponse,
  isEncryptedSlug,
  resetOffsetCache,
  ENC_HEADER
} from './archive.js';
export type { ArchiveLine, ArchiveLocation } from './archive.js';

export { captureResponse } from './capture.js';
export type { CaptureArgs, CaptureResult, IngestContext, IngestModule } from './capture.js';

export { beginRun, finishRun, captureRuleId } from './run.js';
export type { RunHandle, RunKind } from './run.js';

export {
  queueJob,
  claimNextJob,
  markJobRunning,
  finishJob,
  stalledRequests,
  STALL_THRESHOLD_MINUTES
} from './jobs.js';
export type { JobRequest, OneShotKind } from './jobs.js';

export { runPreflight, isTradingDay } from './phases/preflight.js';
export type { PreflightOutcome } from './phases/preflight.js';

export {
  runUniversePhase,
  reconcileMembership,
  referenceDue,
  UNIVERSE_RULE,
  REFERENCE_HEARTBEAT_DAYS
} from './phases/universe.js';
export type { UniverseMember, UniverseSeedResult } from './phases/universe.js';

export { runUniverseSeed } from './universe-seed.js';
export type { UniverseSeedReport, UniverseListSource } from './universe-seed.js';

export { ingestTickerReference, zeroPadCik, pickShares } from '../ingest/raw-ticker-reference.js';

export { runDaily } from './daily.js';
export type { DailyRunReport } from './daily.js';
export { runBarsPhase, runQuotesPhase, runActionsPhase, BARS_RULE, QUOTES_RULE, ACTIONS_RULE } from './phases/market.js';
export type { PhaseCounts } from './phases/market.js';
export {
  makeBarIngest, ingestSnapshot, ingestSplits, ingestDividends, toIntegerStrict, msEpochToEtDate, nsEpochToEt
} from '../ingest/market.js';
export { runBackfillBars, backfillQueueClear, BACKFILL_RULE } from './backfill.js';
export type { BackfillReport } from './backfill.js';
