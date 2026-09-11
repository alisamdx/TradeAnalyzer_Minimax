/**
 * The collector — 04. A library with no Electron, no scheduler and no network
 * client of its own; everything environmental arrives through `CollectorHost`.
 */
export type { CollectorHost, OperatorHost, ProviderResponse, ProviderName } from './host.js';
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

export { captureResponse, indexAndIngest, ensureRecipe } from './capture.js';
export type {
  CaptureArgs, CaptureResult, IndexArgs, IngestContext, IngestModule, IngestedRowSpec, IngestedChildRows
} from './capture.js';
export type { ScratchDb } from './host.js';

// Ingest recipes and replay (B9b, 04 §7.5, AC-4).
export {
  recipes, buildIngest, recipeDigest, canonicalJson, parseStoredRecipe, isIngestModuleName,
  INGEST_MODULES, RecipeError
} from '../ingest/recipes.js';
export type { IngestRecipe, IngestModuleName, RecipeArgs, Json } from '../ingest/recipes.js';
export { runReplay, runReplayJob, factColumns, RECIPES_FROM_DICTIONARY } from './replay.js';
export type { ReplayReport, ReplayJobReport, ReplayCoverage, ReplayVerdict, TableDiff } from './replay.js';

export { beginRun, finishRun, captureRuleId } from './run.js';
export type { RunHandle, RunKind } from './run.js';

export {
  queueJob,
  claimNextJob,
  markJobRunning,
  finishJob,
  cancelJob,
  stalledRequests,
  STALL_THRESHOLD_MINUTES
} from './jobs.js';
export type { JobRequest, OneShotKind } from './jobs.js';

// Reset (B9a, 04 §7.6). Executed by the new exe, which owns generation creation.
export {
  performReset, resetPreview, validateResetRequest, resetConfirmationText,
  RESET_FOLLOW_UPS, IN_FLIGHT_HOURS
} from './reset.js';
export type { ResetArgs, ResetPreview, ResetReport } from './reset.js';

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

// Phase 9 (B7b). Exported alongside `runDaily` because a replay runs the
// derivation over a rebuilt raw layer, and QC-951's equivalence check compares
// derived rows as well as raw ones.
export { runDerivePhase } from './phases/derive.js';
export type { DerivePhaseCounts } from './phases/derive.js';

// The IV bootstrap one-shot (B7b). Runnable only with an IVolatility
// subscription; the parser and the job are complete and fixture-tested so the
// pull is a button-press when that spend decision is taken.
export { runBootstrapIv, bootstrapTickers, BOOTSTRAP_IV_RULE, IVX_ENDPOINT } from './bootstrap-iv.js';
export type { BootstrapIvReport } from './bootstrap-iv.js';
export {
  makeIvBootstrapIngest, pickIv30, extractRows, outOfBandCount, IVX_METHOD_NOTE
} from '../ingest/iv-bootstrap.js';

// The legacy hand-off (B8, 04 §8). The existing app's brief job calls
// `writeLegacyHandoff` with what it already holds in memory at the end of a run.
export { writeLegacyHandoff, LEGACY_HANDOFF_RULE } from './legacy-handoff.js';
export type { LegacyHandoffResult } from './legacy-handoff.js';
export { makeLegacyBriefIngest, stickyRowsFor, legacyRunId } from '../ingest/legacy-brief.js';
export type {
  LegacyBriefHandoff, LegacyHandoffCandidate, LegacyHandoffLeg
} from '../ingest/legacy-brief.js';
export { osiSymbol } from '../ingest/osi.js';

// The one-time backward import (B8, 04 §7.4, Q19 categories 1 and 5).
export { runLegacyImport, validateBandOrder, CONFIG_SOURCES, LEGACY_IMPORT_RULE } from './legacy-import.js';
export type { LegacyImportReport, ImportedTable, ConfigKind } from './legacy-import.js';
