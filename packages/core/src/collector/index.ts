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
export type {
  CaptureArgs, CaptureResult, IngestContext, IngestModule, IngestedRowSpec, IngestedChildRows
} from './capture.js';

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
export {
  ensureTradingCalendar, buildTradingCalendar, nyseHolidays, nyseEarlyCloses
} from './trading-calendar.js';
export type { TradingDayRow, HolidayRule, CalendarSeedResult } from './trading-calendar.js';
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
export {
  runAccountPhase, deriveHeldStickyContracts, maskAccountKey, accountKeysFrom, ACCOUNT_RULE
} from './phases/account.js';
export type { AccountPhaseResult } from './phases/account.js';
export {
  runChainSubsetPhase, runChainsPhase, selectExpirations, subsetCandidates,
  closeExpiredStickyContracts, CHAIN_SUBSET_RULE, CHAIN_RULE
} from './phases/chains.js';
export type { SubsetPhaseResult, ChainPhaseResult } from './phases/chains.js';
export {
  makeExpirationIngest, makeChainIngest, etradeYesNoToFlag, secondsEpochToEt, etradeExpiryToDate
} from '../ingest/options.js';
export type { ExpirationSelection } from '../ingest/options.js';
export {
  makePositionIngest, makeBalanceIngest, makeOrderIngest, makeTransactionIngest,
  orderFingerprint, hashAccountKey, msEpochToEt
} from '../ingest/account.js';
export {
  runEventsPhase, runEarningsSweep, runIndexQuotes, runTreasuryYields, runMacroCalendar,
  runEdgarFilings, runEdgarFacts, runShortInterest, runRecommendations, runInsiderSweep,
  EVENTS_RULE
} from './phases/events.js';
export type { EventsPhaseResult, SubPhaseCount } from './phases/events.js';
export {
  makeEarningsIngest, makeIndexQuoteIngest, ingestTreasuryYields, makeRecommendationIngest,
  ingestShortInterest, earningsResponseAtCap, finnhubHourToReportTime, parseCsvLine,
  mmddyyyyToDate, FINNHUB_BULK_CAP
} from '../ingest/events.js';
export {
  parseFomcCalendar, parseBlsSchedule, ingestFomcCalendar, makeBlsScheduleIngest,
  BLS_RELEASES, FOMC_CALENDAR_URL, blsScheduleUrl
} from '../ingest/macro-calendar.js';
export type { ParsedMacroEvent } from '../ingest/macro-calendar.js';
export {
  makeSubmissionsIngest, makeCompanyFactsIngest, makeForm4Ingest, parseDailyFormIndex,
  dailyFormIndexUrl, submissionsAtCap, EDGAR_RECENT_CAP
} from '../ingest/edgar.js';
export type { IndexedFiling } from '../ingest/edgar.js';

export { runBackfillBars, backfillQueueClear, BACKFILL_RULE } from './backfill.js';
export type { BackfillReport } from './backfill.js';
