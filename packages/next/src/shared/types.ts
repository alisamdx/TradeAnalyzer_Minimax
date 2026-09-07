/**
 * Types crossing the process boundary. Declared once, here — the existing app's
 * TS2717 quirk came from redeclaring the bridge per file (CLAUDE.md).
 */

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
}

export interface TableStats {
  readonly table: string;
  readonly rowCount: number;
  readonly newestAsOf: string | null;
  /** Per nullable column: the fraction of rows that are null, or null on an empty table. */
  readonly nullRates: Readonly<Record<string, number | null>>;
}

export interface TreeGroup {
  readonly layer: Layer;
  readonly domains: readonly { readonly domain: string; readonly tables: readonly string[] }[];
}

export interface QueryPage {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly nextCursor: number | null;
  readonly hasMore: boolean;
}

export interface QueryRequestDto {
  readonly table: string;
  readonly limit?: number;
  readonly cursor?: number | null;
  readonly sortColumn?: string | null;
  readonly sortDescending?: boolean;
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

/** The surface exposed on `window.api`. 05 §9 specifies the full set; this is B7a's. */
export interface NextApi {
  readonly appVersion: string | null;
  readonly platform: string;
  readonly generation: {
    current(): Promise<IpcResult<GenerationInfoDto>>;
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
}
