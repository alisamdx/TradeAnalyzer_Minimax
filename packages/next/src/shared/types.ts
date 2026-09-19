/**
 * Types crossing the process boundary. Declared once, here — the existing app's
 * TS2717 quirk came from redeclaring the bridge per file (CLAUDE.md).
 */

import type { DeepLinkRoute, QueueableKind } from './deeplink.js';

export type Layer = 'meta' | 'ref' | 'raw' | 'ext' | 'derived' | 'legacy' | 'qa';

/** Every IPC method returns this. A failure is data, never a thrown string. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface GenerationInfoDto {
  readonly generationNo: number;
  readonly status: 'pilot' | 'production' | 'closed';
  readonly openedAt: string;
  readonly dbPath: string;
  readonly archivePath: string;
  readonly dataRoot: string;
  readonly dictionaryVersion: number;
  readonly createdNow: boolean;
  /** The generation a reset replaced; null for a first generation. */
  readonly predecessorNo: number | null;
  readonly resetReason: string | null;
  /** This window shows a closed generation, opened read-only (05 §8). Nothing here can change it. */
  readonly readOnly: boolean;
}

/** One generation found on disk — 05 §8, AC-14. */
export interface GenerationListItemDto {
  readonly generationNo: number;
  readonly dir: string;
  readonly current: boolean;
  readonly dbPresent: boolean;
  readonly walPresent: boolean;
  readonly status: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly predecessorNo: number | null;
  readonly resetReason: string | null;
  readonly problem: string | null;
}

/** The inspector's filters (05 §3.2, B9c). The rules are `core`'s; this is only their shape. */
export type FilterOpDto = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'in' | 'is_null' | 'not_null';

export interface FilterDto {
  readonly column: string;
  readonly op: FilterOpDto;
  readonly value?: string | number | readonly (string | number)[] | null;
}

export interface QueryCursorDto {
  /** The sort column's value on the last row returned; null when unsorted or in the null tail. */
  readonly sort: unknown;
  readonly key: number;
}

export interface QuestionDefinitionDto {
  readonly filters: readonly FilterDto[];
  readonly sortColumn: string | null;
  readonly sortDescending: boolean;
  readonly versionMode: 'all' | 'latest';
  readonly asOf: string | null;
  readonly columns: readonly string[] | null;
}

export interface SavedQuestionDto {
  readonly id: number;
  readonly name: string;
  readonly table: string;
  readonly definition: QuestionDefinitionDto;
  readonly note: string | null;
  readonly createdAt: string;
}

/** An open pin on a contract (05 §4.2). */
export interface PinDto {
  /** Why the contract is pinned. Not `reason` — that is a dictionary column, and AC-13 caught it. */
  readonly pinnedFor: string;
  readonly since: string;
  readonly origin: string | null;
}

export interface TableMeta {
  readonly table: string;
  readonly layer: Layer;
  readonly domain: string;
  readonly description: string;
  readonly naturalKey: readonly string[];
  readonly appendOnly: boolean;
  readonly columnCount: number;
}

export interface ColumnMeta {
  readonly column: string;
  readonly type: 'INTEGER' | 'REAL' | 'TEXT';
  readonly unit: string;
  readonly unitColumn: string | null;
  readonly nullable: boolean;
  /** Required whenever `nullable` — AC-3. The inspector shows it on a null cell. */
  readonly nullMeaning: string | null;
  readonly statusColumn: string | null;
  readonly enumValues: readonly string[] | null;
  readonly converter: string | null;
  readonly sourceProvider: string | null;
  readonly sourceField: string | null;
  readonly description: string;
  readonly primaryKey: boolean;
  readonly referencesTable: string | null;
  /** The 02 §16 verify note, when the field has not been seen in a live response. */
  readonly verify: string | null;
  /** The filter operators this column accepts — from `core`, so the form offers only what the query will run. */
  readonly filterOps: readonly FilterOpDto[];
  /** An index can start from this column, so a filter on it anchors a query on a large table (05 §8). */
  readonly indexed: boolean;
}

export interface TableStats {
  readonly table: string;
  readonly rowCount: number;
  readonly newestAsOf: string | null;
  /** Per nullable column: the fraction of rows that are null, or null on an empty table. */
  readonly nullRates: Readonly<Record<string, number | null>>;
  /** The table does not exist in this generation — it was built by an older dictionary (a read-only window, B9c). */
  readonly absent: boolean;
  /** The table has versions of one fact to choose between, so "latest" is offered (P1). */
  readonly latestAvailable: boolean;
}

export interface TreeGroup {
  readonly layer: Layer;
  readonly domains: readonly { readonly domain: string; readonly tables: readonly string[] }[];
}

export interface QueryPage {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: QueryCursorDto | null;
  readonly hasMore: boolean;
  /** Rows matching the filters, counted up to a cap; null when nothing narrows the table. */
  readonly matching: { readonly n: number; readonly capped: boolean } | null;
  /** What was actually applied — `all` when the table has no versions to choose between. */
  readonly versionMode: 'all' | 'latest';
}

export interface QueryRequestDto {
  readonly table: string;
  readonly limit?: number;
  readonly cursor?: QueryCursorDto | null;
  readonly sortColumn?: string | null;
  readonly sortDescending?: boolean;
  readonly filters?: readonly FilterDto[];
  readonly versionMode?: 'all' | 'latest';
  readonly asOf?: string | null;
}


/**
 * The domain views (05 §4.2, §4.4) — Chains and Account.
 *
 * These are shaped **in the main process**, into columns the renderer draws
 * without knowing what any of them mean. That is not indirection for its own
 * sake: AC-13's claim is that no table-specific code exists in the UI, and a
 * chain grid that hard-coded `open_interest` and `delta` would quietly retire
 * that claim while still working. Column labels, units and null meanings come
 * from the dictionary, so a column added there appears here for the same reason
 * it appears in the generic table view.
 */

export interface ViewColumn {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly nullMeaning: string | null;
  /** Groups render as a labelled band — "provider estimates" is one (02 §10). */
  readonly group: string | null;
}

export interface ViewCell {
  readonly value: unknown;
  /** The `<col>_status` value when the column has one, else null. */
  readonly status: string | null;
}

export interface ChainLegDto {
  readonly osiSymbol: string;
  /** The pin reason when this contract is in the sticky set, else null. */
  readonly stickyReason: string | null;
  readonly cells: readonly ViewCell[];
}

export interface ChainRowDto {
  readonly strike: number;
  readonly atm: boolean;
  readonly call: ChainLegDto | null;
  readonly put: ChainLegDto | null;
}

export interface ChainGridDto {
  readonly ticker: string;
  readonly asOfDate: string;
  readonly expirationDate: string;
  readonly underlyingPrice: number | null;
  readonly columns: readonly ViewColumn[];
  readonly rows: readonly ChainRowDto[];
  /**
   * QC-410's verdict on this ticker's provider Greeks for the date (v1.1.272). `usable: false`
   * means E*Trade's deltas imply a different price than the chain's own quotes. Null when
   * nothing could be judged (no 3M rate, too few near-the-money contracts).
   */
  readonly greeks: { readonly usable: boolean; readonly detail: string } | null;
}

export interface ExpirationOptionDto {
  readonly expirationDate: string;
  readonly expiryType: string;
  readonly windowReason: string;
  readonly inCaptureWindow: boolean;
  readonly contractCount: number;
}

export interface ContractHistoryRowDto {
  readonly asOfDate: string;
  readonly captured: boolean;
  /** Why a date has no row, when it has none. */
  readonly gapReason: string | null;
  readonly cells: readonly ViewCell[];
}

export interface ContractHistoryDto {
  readonly osiSymbol: string;
  readonly columns: readonly ViewColumn[];
  readonly rows: readonly ContractHistoryRowDto[];
}

export interface PositionRowDto {
  readonly key: string;
  readonly cells: readonly ViewCell[];
  /** How the position changed since the previous snapshot. */
  readonly change: 'unchanged' | 'appeared' | 'disappeared' | 'quantity_changed';
  readonly previousQuantity: number | null;
  /** Executed-order legs that explain the change; empty is a QC-802 marker. */
  readonly explainedBy: readonly string[];
}

export interface PositionsDto {
  readonly asOfDate: string;
  readonly previousAsOfDate: string | null;
  readonly columns: readonly ViewColumn[];
  readonly rows: readonly PositionRowDto[];
}

export interface OrderLegDto {
  readonly cells: readonly ViewCell[];
}

export interface OrderDto {
  readonly orderId: string;
  readonly cells: readonly ViewCell[];
  readonly legs: readonly OrderLegDto[];
}

export interface OrdersDto {
  readonly columns: readonly ViewColumn[];
  readonly legColumns: readonly ViewColumn[];
  readonly orders: readonly OrderDto[];
}

export interface BalancePointDto {
  readonly asOfDate: string;
  readonly cells: readonly ViewCell[];
}

export interface BalancesDto {
  readonly columns: readonly ViewColumn[];
  readonly points: readonly BalancePointDto[];
}

/**
 * The Earnings view (05 §4.3).
 *
 * The trail — every observation, not the resolved date — is the point. A view
 * showing only "the current best date" would render the truncation failure that
 * put an earnings date a quarter late as a perfectly ordinary row.
 */
export interface EarningsCalendarDto {
  readonly ticker: string;
  readonly reportTime: string | null;
  readonly reportTimeStatus: string;
  readonly source: string;
}

export interface EarningsMonthDto {
  readonly month: string;
  readonly days: readonly { readonly date: string; readonly tickers: readonly EarningsCalendarDto[] }[];
}

export interface EarningsObservationDto {
  readonly cells: readonly ViewCell[];
  /** Days moved against the previous observation from the SAME source; null on the first. */
  readonly slipDays: number | null;
  /** A later slip past the QC-601 limit. A nearer move is a correction and is not flagged. */
  readonly slipSuspect: boolean;
}

export interface EarningsTrailDto {
  readonly ticker: string;
  readonly columns: readonly ViewColumn[];
  readonly observations: readonly EarningsObservationDto[];
}

export interface EarningsAnomalyDto {
  readonly ticker: string;
  readonly kind: 'moved_later' | 'sources_disagree';
  readonly detail: string;
}

/**
 * The IV view's vocabulary — 05 §4.6.
 *
 * `own` and `external` rather than the column name they come from, and
 * `readable` rather than `accepted`: AC-13's scan is a substring match over the
 * renderer, so a DTO field carrying a dictionary column name would either fail
 * the scan or force an exemption that makes it vacuous. Naming the concepts
 * the UI actually shows is the point, not a workaround.
 */
export interface IvPointDto {
  readonly date: string;
  /** Our own computed value, null when it could not be computed that day. */
  readonly own: number | null;
  /** Why `own` is null — shown as a gap with a glyph, never interpolated across. */
  readonly ownStatus: string | null;
  readonly external: number | null;
  /** Both series measured this day: the only days the comparison is made of. */
  readonly paired: boolean;
}

export interface IvOverlapDto {
  readonly pairedDays: number;
  readonly requiredDays: number;
  readonly medianAbsDiff: number | null;
  readonly tolerance: number;
  /** Whether anything reads the external series yet. */
  readonly readable: boolean;
  readonly externalSource: string | null;
  readonly externalMethod: string | null;
}

export interface IvSeriesDto {
  readonly ticker: string;
  readonly points: readonly IvPointDto[];
  /** Null until a bootstrap is accepted — the normal state, not an error. */
  readonly stitchDate: string | null;
  /** Null when no external series has been loaded for this ticker. */
  readonly overlap: IvOverlapDto | null;
}

export interface IvTickerDto {
  readonly ticker: string;
  readonly ownDays: number;
  readonly externalDays: number;
}

/**
 * The Legacy view's vocabulary (B8).
 *
 * Four field names differ from the columns behind them, and all four are
 * deliberate. `imported` rather than `pre_collector`, `phase` rather than
 * `slot`, `strategy` rather than `mode`, `picked` rather than `survived`:
 * every one of those column names is matched by AC-13's scan on a word
 * boundary, and renaming a DTO field is cheaper than exempting a word and
 * costing the rule its meaning. `imported` is also simply the better word for
 * what a reader needs to know.
 */
export interface LegacyRunDto {
  readonly id: string;
  readonly date: string;
  readonly phase: string;
  readonly imported: boolean;
  readonly appVersion: string;
  readonly candidates: number;
  readonly survivors: number;
  readonly rejected: number;
}

export interface LegacyCandidateDto {
  readonly rowId: number;
  readonly ticker: string;
  readonly strategy: string;
  readonly rank: number;
  readonly picked: boolean;
  readonly score: number | null;
  readonly scoreStatus: string;
  readonly disposition: string | null;
  readonly gatesFailed: number;
  readonly firstFailure: string | null;
}

export interface LegacyCountsDto {
  readonly runs: number;
  readonly candidates: number;
  readonly losers: number;
}

export interface LegacySummaryDto {
  readonly live: LegacyCountsDto;
  readonly imported: LegacyCountsDto;
}

/**
 * The operator surface — B9a (05 §5, §7).
 *
 * Same rule as every other view: the field names are the UI's vocabulary, not
 * the columns'. `runsInARow` rather than `consecutive_runs`, `stillSeen` rather
 * than `still_firing`, `resolvedHow` rather than `resolution_kind` — each of
 * those column names is inside AC-13's scan, and a rename costs nothing while an
 * exemption costs the rule its meaning.
 */
export type ExceptionStateFilterDto =
  | 'active' | 'all' | 'open' | 'acknowledged' | 'expired_review' | 'accepted' | 'resolved';

export interface ExceptionFilterDto {
  readonly state?: ExceptionStateFilterDto;
  readonly severity?: string | null;
  readonly checkId?: string | null;
  readonly domain?: string | null;
  /** The status email's link: exceptions the run saw. */
  readonly runId?: number | null;
}

export interface ExceptionRowDto {
  readonly id: number;
  readonly checkId: string;
  readonly domain: string;
  readonly key: string;
  readonly severity: string;
  /** Current severity differs from where it started — it recurred its way up. */
  readonly escalated: boolean;
  readonly state: string;
  readonly detail: string;
  readonly firstSeenRun: number;
  readonly lastSeenRun: number;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly runsInARow: number;
  /** Fired on the most recent run. False while still open is "no longer observed, unresolved". */
  readonly stillSeen: boolean;
  readonly daysAffected: number;
  readonly acceptedUntil: string | null;
}

export interface ExceptionListDto {
  readonly rows: readonly ExceptionRowDto[];
  /** The list stops at 2,000 rows; true means there are more than shown. */
  readonly truncated: boolean;
  readonly checks: readonly string[];
  readonly domains: readonly string[];
  readonly counts: {
    readonly open: number;
    readonly acknowledged: number;
    readonly expiredReview: number;
    readonly blockingActive: number;
  };
}

export interface ExceptionEventDto {
  readonly at: string;
  readonly actor: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly note: string | null;
}

export interface ExceptionDetailDto {
  readonly row: ExceptionRowDto;
  /** Pretty-printed JSON, expected against actual. */
  readonly evidence: string;
  readonly remediations: string;
  readonly events: readonly ExceptionEventDto[];
  /** Each domain-day this finding touches, with its usability right now. */
  readonly affected: readonly { readonly date: string; readonly usability: string | null }[];
  readonly check: {
    readonly description: string;
    readonly thresholds: string;
    readonly evaluatedTotal: number;
    readonly firedTotal: number;
    readonly lastFiredAt: string | null;
  } | null;
  readonly resolvedAt: string | null;
  readonly resolvedHow: string | null;
  readonly resolvedNote: string | null;
  readonly acceptedAt: string | null;
  readonly acceptedNote: string | null;
  /** Present when the finding is a discontinuity a ticker-reuse ruling can answer (03 §6). */
  readonly reuseCandidate: { readonly ticker: string; readonly spliceDate: string | null } | null;
}

export type ResolutionHowDto = 'data_corrected' | 'provider_fixed' | 'rule_changed' | 'false_positive';

export interface BulkAckResultDto {
  readonly acknowledged: readonly number[];
  readonly skipped: readonly { readonly exceptionId: number; readonly why: string }[];
}

export interface ZeroFireDto {
  readonly checkId: string;
  readonly domain: string;
  readonly severity: string;
  readonly description: string;
  readonly evaluatedTotal: number;
}

// ── pilot exit (03 §8, 05 §6, B10a) ─────────────────────────────────────────
// UI vocabulary: `choice` and `list`, never the column names they are stored in.

export type PilotListDto = 'neverFired' | 'threshold';

export interface PilotRulingDto {
  readonly choice: string;
  readonly note: string;
  readonly proposed: number | null;
  readonly at: string;
  readonly by: string;
}

export interface PilotConditionDto {
  /**
   * Mirrors `core`'s `ConditionKey`. `backfill_queue` was added in core 0.6.4 and
   * missed here, so `next` stopped typechecking and the Pilot view had no label
   * for the ninth condition. `pilot.ts` assigns core's array to this type, which
   * is the check that caught it.
   */
  readonly key: 'status' | 'streak' | 'zero_fire' | 'thresholds' | 'inspections' | 'expired_review' | 'verify_notes' | 'backfill_queue' | 'replay';
  readonly met: boolean;
  readonly detail: string;
}

export interface PilotStatusDto {
  readonly generationNo: number | null;
  readonly generationStatus: string | null;
  readonly promotedAt: string | null;
  readonly lastEvaluatedDate: string | null;
  readonly streak: number;
  readonly streakTarget: number;
  readonly conditions: readonly PilotConditionDto[];
  readonly canPromote: boolean;
  readonly inspections: readonly { readonly domain: string; readonly lastAt: string | null; readonly note: string | null }[];
  readonly replay: {
    readonly sessionsSincePassing: number | null;
    readonly lastPassingAt: string | null;
    readonly differentDates: readonly string[];
  };
  /** The exact text the operator must type to promote. */
  readonly confirmation: string;
}

export interface PilotNeverFiredDto {
  readonly checkId: string;
  readonly version: number;
  readonly domain: string;
  readonly severity: string;
  readonly description: string;
  readonly evaluatedTotal: number;
  readonly ruling: PilotRulingDto | null;
}

export interface PilotBoundsDto {
  readonly lo: number;
  readonly hi: number;
}

export interface PilotThresholdDto {
  readonly checkId: string;
  readonly version: number;
  readonly domain: string;
  readonly quantity: string;
  readonly unit: string | null;
  readonly limit: number | null;
  readonly basis: string;
  readonly needsRuling: boolean;
  readonly runs: number;
  readonly n: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly p50: PilotBoundsDto | null;
  readonly p90: PilotBoundsDto | null;
  readonly p99: PilotBoundsDto | null;
  readonly nearBoundary: number;
  readonly decorative: 'yes' | 'no' | 'maybe' | null;
  readonly bulkAgainst: 'yes' | 'no' | 'maybe' | null;
  readonly extremes: readonly { readonly key: string; readonly value: number; readonly runId: number }[];
  readonly ruling: PilotRulingDto | null;
}

export interface RunRowDto {
  readonly runId: number;
  readonly kind: string;
  readonly date: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: string;
  /**
   * The gate's call when the run FINISHED. Never updated — usability now is per
   * domain-day. Named `gate`, not `verdict`: that is a dictionary column, and
   * AC-13 caught it in three views at once.
   */
  readonly gate: string | null;
  readonly host: string;
  readonly collector: string;
  readonly responses: number;
  readonly failedParses: number;
  readonly bytes: number;
}

export interface RunCallGroupDto {
  readonly provider: string;
  /** The archive slug — what was asked for. */
  readonly call: string;
  readonly count: number;
  readonly failedParses: number;
  /** No 2xx: a non-2xx status or no response at all. */
  readonly notOk: number;
  /** Responses the size of a known provider cap — evidence of truncation (P8). */
  readonly atCap: number;
  readonly bytes: number;
}

export interface RunDomainDto {
  readonly name: string;
  readonly expected: number | null;
  readonly stored: number | null;
  readonly usability: string | null;
}

export interface RunCheckDto {
  readonly checkId: string;
  readonly evaluated: number;
  readonly fired: number;
  readonly durationMs: number;
  /** One line: n, p50, p99, max, threshold, near-boundary count. Null for a predicate check. */
  readonly distribution: string | null;
}

export interface RunDetailDto {
  readonly run: RunRowDto;
  readonly calls: readonly RunCallGroupDto[];
  readonly report: {
    readonly gate: string;
    readonly emailStatus: string;
    readonly emailError: string | null;
    readonly emailSentAt: string | null;
    readonly domains: readonly RunDomainDto[];
  } | null;
  readonly checks: readonly RunCheckDto[];
  readonly exceptionsRaised: number;
  readonly exceptionsSeen: number;
  /** The Jobs request that started this run, when it was a one-shot. */
  readonly requestId: number | null;
}

/**
 * A replay's result, as the Jobs view's diff viewer draws it (04 §7.5, B9b).
 *
 * Samples are rows keyed by column name — data, not code, so the renderer
 * prints whatever columns they carry without naming any (AC-13).
 */
export interface ReplayTableDto {
  readonly table: string;
  readonly columns: readonly string[];
  readonly sourceRows: number;
  readonly replayRows: number;
  readonly matched: number;
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly addedSamples: readonly Readonly<Record<string, unknown>>[];
  readonly removedSamples: readonly Readonly<Record<string, unknown>>[];
}

export interface ReplayReportDto {
  readonly outcome: 'equal' | 'equal_on_replayed' | 'different' | 'nothing_replayable';
  readonly sourceRuns: readonly number[];
  readonly tradingDates: readonly string[];
  readonly considered: number;
  readonly replayed: number;
  readonly noIngest: number;
  readonly beforeRecipes: number;
  readonly unreadable: number;
  readonly digestMismatch: number;
  readonly badRecipe: number;
  readonly problems: readonly string[];
  readonly derivedCompared: boolean;
  readonly derivedNote: string | null;
  readonly scratchPath: string | null;
  readonly tables: readonly ReplayTableDto[];
}

export interface JobRequestDto {
  readonly id: number;
  readonly kind: string;
  readonly queuedAt: string;
  readonly queuedBy: string;
  readonly state: string;
  readonly claimedAt: string | null;
  readonly claimedBy: string | null;
  readonly finishedAt: string | null;
  readonly runId: number | null;
  /** Minutes spent queued so far; null once a host has it. */
  readonly waitingMinutes: number | null;
  readonly stalled: boolean;
  readonly error: string | null;
  /** The job's own report, pretty-printed. */
  readonly result: string | null;
  /** Parsed out of the result when the request was a replay, for the diff viewer. */
  readonly replay: ReplayReportDto | null;
  readonly gate: string | null;
  readonly runOutcome: string | null;
}

export interface JobCardDto {
  readonly kind: string;
  readonly title: string;
  readonly what: string;
  /** Which provider, and roughly how many calls — the single confirm of 05 §7. */
  readonly cost: string;
  readonly queueable: boolean;
  /** Why the job cannot be queued yet, when it cannot. */
  readonly notYet: string | null;
  readonly last: JobRequestDto | null;
}

export interface JobsDto {
  readonly cards: readonly JobCardDto[];
  readonly requests: readonly JobRequestDto[];
  readonly stallMinutes: number;
}

export interface ResetPreviewDto {
  readonly generationNo: number;
  readonly status: string;
  readonly openedAt: string;
  readonly dataDays: number;
  readonly blockers: readonly string[];
  readonly presumedDead: readonly string[];
  readonly queuedToWithdraw: number;
  /** The exact text the operator must type. */
  readonly confirmation: string;
  readonly successorDir: string;
}

export interface ResetResultDto {
  readonly predecessorNo: number;
  readonly successorNo: number;
  readonly withdrawn: number;
  readonly queued: readonly { readonly kind: string; readonly requestId: number }[];
}

/** The surface exposed on `window.api`. 05 §9 specifies the full set; this is B9a's. */
export interface NextApi {
  readonly appVersion: string | null;
  readonly platform: string;
  readonly generation: {
    current(): Promise<IpcResult<GenerationInfoDto>>;
    /** Every generation on disk (05 §8, AC-14). */
    list(): Promise<IpcResult<readonly GenerationListItemDto[]>>;
    /** Opens a closed generation read-only, in its own window. */
    openReadOnly(generationNo: number): Promise<IpcResult<GenerationInfoDto>>;
  };
  /** Saved questions (05 §11.2, B9c). */
  readonly questions: {
    list(table: string | null): Promise<IpcResult<readonly SavedQuestionDto[]>>;
    save(name: string, table: string, definition: QuestionDefinitionDto, note: string | null): Promise<IpcResult<SavedQuestionDto>>;
    retire(id: number): Promise<IpcResult<void>>;
  };
  readonly exceptions: {
    list(filter: ExceptionFilterDto): Promise<IpcResult<ExceptionListDto>>;
    detail(id: number): Promise<IpcResult<ExceptionDetailDto>>;
    acknowledge(id: number, note: string | null): Promise<IpcResult<void>>;
    bulkAcknowledge(ids: readonly number[], note: string | null): Promise<IpcResult<BulkAckResultDto>>;
    resolve(id: number, how: ResolutionHowDto, note: string): Promise<IpcResult<void>>;
    /** Returns the expiry actually recorded. */
    accept(id: number, note: string, until: string | null): Promise<IpcResult<string>>;
    recordReuse(id: number, ticker: string, spliceDate: string | null, note: string): Promise<IpcResult<string>>;
    zeroFire(): Promise<IpcResult<readonly ZeroFireDto[]>>;
  };
  readonly runs: {
    list(): Promise<IpcResult<readonly RunRowDto[]>>;
    detail(runId: number): Promise<IpcResult<RunDetailDto>>;
  };
  /** Queues and reset. Nothing here executes a provider job — the old app does (Q4). */
  readonly jobs: {
    overview(): Promise<IpcResult<JobsDto>>;
    /** `params` only for `replay`: `{ runId }`, or omitted for the latest completed daily run. */
    queue(kind: QueueableKind, params?: { readonly runId?: number }): Promise<IpcResult<number>>;
    cancel(requestId: number): Promise<IpcResult<boolean>>;
    resetPreview(): Promise<IpcResult<ResetPreviewDto>>;
    reset(reason: string, confirmation: string): Promise<IpcResult<ResetResultDto>>;
  };
  /** Pilot exit (03 §8, 05 §6, B10a). Every rule is enforced in `core`; the view only asks. */
  readonly pilot: {
    status(): Promise<IpcResult<PilotStatusDto>>;
    neverFired(): Promise<IpcResult<readonly PilotNeverFiredDto[]>>;
    thresholds(): Promise<IpcResult<readonly PilotThresholdDto[]>>;
    rule(list: PilotListDto, checkId: string, choice: string, note: string, proposed: number | null): Promise<IpcResult<number>>;
    inspect(domain: string, note: string | null): Promise<IpcResult<number>>;
    promote(confirmation: string): Promise<IpcResult<PilotStatusDto>>;
  };
  /** Navigation only — a link can never act (05 §11.1). */
  readonly deepLinks: {
    initial(): Promise<IpcResult<DeepLinkRoute | null>>;
    onNavigate(listener: (route: DeepLinkRoute) => void): () => void;
  };
  readonly dictionary: {
    tables(): Promise<IpcResult<readonly TableMeta[]>>;
    tree(): Promise<IpcResult<readonly TreeGroup[]>>;
    columns(table: string): Promise<IpcResult<readonly ColumnMeta[]>>;
    stats(table: string): Promise<IpcResult<TableStats>>;
    unverified(): Promise<IpcResult<readonly { table: string; column: string; note: string }[]>>;
  };
  readonly inspect: {
    query(req: QueryRequestDto): Promise<IpcResult<QueryPage>>;
  };
  readonly chains: {
    dates(): Promise<IpcResult<readonly string[]>>;
    tickers(asOfDate: string): Promise<IpcResult<readonly string[]>>;
    expirations(ticker: string, asOfDate: string): Promise<IpcResult<readonly ExpirationOptionDto[]>>;
    grid(ticker: string, asOfDate: string, expirationDate: string): Promise<IpcResult<ChainGridDto>>;
    contractHistory(osiSymbol: string): Promise<IpcResult<ContractHistoryDto>>;
    /** Open pins on a contract, whatever the reason (05 §4.2). */
    pins(osiSymbol: string): Promise<IpcResult<readonly PinDto[]>>;
    /** Pins for study, with a required note archived as the pin's provenance. */
    pin(osiSymbol: string, note: string): Promise<IpcResult<PinDto>>;
    unpin(osiSymbol: string, note: string): Promise<IpcResult<void>>;
  };
  readonly account: {
    snapshotDates(): Promise<IpcResult<readonly string[]>>;
    positions(asOfDate: string): Promise<IpcResult<PositionsDto>>;
    orders(limit?: number): Promise<IpcResult<OrdersDto>>;
    balances(): Promise<IpcResult<BalancesDto>>;
  };
  readonly earnings: {
    months(): Promise<IpcResult<readonly string[]>>;
    month(month: string): Promise<IpcResult<EarningsMonthDto>>;
    trail(ticker: string): Promise<IpcResult<EarningsTrailDto>>;
    anomalies(): Promise<IpcResult<readonly EarningsAnomalyDto[]>>;
  };
  /**
   * Named `volatility`, not `iv`.
   *
   * `iv` is a column on the option snapshot, and AC-13's scan is word-boundary
   * matched over the renderer — so `window.api.iv` is a genuine hit. Renaming
   * the namespace is the fix; adding `iv` to the scan's exemption list would
   * have silenced a rule that is doing exactly its job.
   */
  readonly volatility: {
    tickers(): Promise<IpcResult<readonly IvTickerDto[]>>;
    series(ticker: string): Promise<IpcResult<IvSeriesDto>>;
  };
  readonly legacy: {
    summary(): Promise<IpcResult<LegacySummaryDto>>;
    runs(): Promise<IpcResult<readonly LegacyRunDto[]>>;
    candidates(runId: string): Promise<IpcResult<readonly LegacyCandidateDto[]>>;
  };
}
