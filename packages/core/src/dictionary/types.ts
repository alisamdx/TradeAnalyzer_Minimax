/**
 * The data dictionary's type system — 02 §0.5.
 *
 * The dictionary is **code**, and it is the only way a table comes into
 * existence: the DDL generator reads these entries and nothing else, so a column
 * that is not declared here cannot exist in the database (AC-3, AC-13).
 *
 * Everything in this file exists to make a wrong entry a compile error or a test
 * failure rather than a column that quietly means something other than it says.
 */

/** SQLite's storage classes, as 02 §0.1 uses them. */
export type SqlType = 'INTEGER' | 'REAL' | 'TEXT';

/**
 * The unit a stored value is in — 02 §0.1. This is not decoration: the inspector
 * renders a unit badge from it, and the AC-7 conversion tests are generated per
 * converted field. A ratio stored as a percentage is a *unit* error that no type
 * system catches, which is exactly the class of bug the existing app shipped —
 * IV as 38.82 in one place and 0.3882 in another.
 */
export type Unit =
  /** Decimal fraction: ratio, rate, yield, IV, Greek. `0.3882`, never `38.82`. */
  | 'fraction'
  /** USD at the account level. */
  | 'usd'
  /** USD per share — never per contract; no raw table applies the x100 multiplier. */
  | 'usd_per_share'
  /** A count of things: shares, contracts, volume, open interest, rows. */
  | 'count'
  /** `YYYY-MM-DD` in America/New_York. */
  | 'date_et'
  /** ISO-8601 with offset, e.g. `2026-09-05T17:02:11-04:00`. */
  | 'timestamp_et'
  /** `0` / `1`. */
  | 'flag'
  /** A fixed set, declared in `enumValues`. */
  | 'enum'
  /** Free text meant for a human to read. */
  | 'text'
  /** A provider's identifier, stored verbatim. */
  | 'identifier'
  /** A hex digest. */
  | 'sha256'
  /** A JSON document stored as text. */
  | 'json'
  /** A filesystem path, relative to the generation directory. */
  | 'path'
  /** A byte length. */
  | 'bytes'
  /**
   * A dimensionless ratio that is **not** bounded to 0..1 — a split of 1 to 4.
   * Distinct from `fraction` because rendering it as a percentage would be
   * nonsense, and REAL rather than INTEGER because providers send fractional
   * split ratios.
   */
  | 'ratio'
  /**
   * The unit **varies per row** and is named by the column in `unitColumn`.
   * EDGAR's facts are the honest case: one table holds USD, shares, USD/shares
   * and pure numbers, and flattening them to a single declared unit would be a
   * lie the inspector then renders as a badge. A column of this unit shows
   * "see <unitColumn>" instead.
   */
  | 'provider_defined';

/** Which storage class each unit must use. Enforced by the conformance test. */
export const UNIT_STORAGE: Readonly<Record<Unit, SqlType>> = {
  fraction: 'REAL',
  usd: 'REAL',
  usd_per_share: 'REAL',
  count: 'INTEGER',
  date_et: 'TEXT',
  timestamp_et: 'TEXT',
  flag: 'INTEGER',
  enum: 'TEXT',
  text: 'TEXT',
  identifier: 'TEXT',
  sha256: 'TEXT',
  json: 'TEXT',
  path: 'TEXT',
  bytes: 'INTEGER',
  ratio: 'REAL',
  provider_defined: 'REAL'
};

/**
 * The standard status values — 02 §0.3. A value column that could be null for
 * more than one reason carries a companion `<col>_status` and its null meaning
 * becomes "see status"; a column with exactly one possible null meaning states
 * that reason directly and has no status column.
 */
export const STATUS_VALUES = [
  /** Value observed. */
  'ok',
  /** Provider response did not include the field. */
  'omitted',
  /** Not requested, because the capture rule excluded it. */
  'outside_window',
  /** Provider sent a value that failed a range or type check; raw kept in the archive. */
  'invalid',
  /** Field has no meaning for this row (a `strike` on a stock position). */
  'not_applicable'
] as const;

export type StatusValue = (typeof STATUS_VALUES)[number];

/** Providers a column's value can originate from. */
export type Provider =
  | 'polygon'
  | 'etrade'
  | 'edgar'
  | 'finnhub'
  | 'treasury'
  | 'fred'
  | 'ivolatility'
  | 'marketdata'
  | 'finra'
  | 'nyse_rules'
  /** Computed by the collector at ingestion from other captured values. */
  | 'derived_at_ingestion'
  /** Written by the collector about itself — run ids, timings, archive offsets. */
  | 'collector'
  /** Handed over by the existing application (04 §8, Q19). */
  | 'legacy_app'
  /** Entered by the operator. */
  | 'operator';

/** The prefix layers of 02 §0.4. The inspector groups by these. */
export type Layer = 'meta' | 'ref' | 'raw' | 'ext' | 'derived' | 'legacy' | 'qa';

export interface ColumnEntry {
  readonly column: string;
  readonly type: SqlType;
  readonly unit: Unit;
  readonly nullable: boolean;
  /**
   * Why this column can be null, in the operator's words. **Required whenever
   * `nullable` is true** — that is AC-3, and it is checked. When `statusColumn`
   * is set this is the literal `see status`, because the reason is per-row.
   */
  readonly nullMeaning?: string;
  /** Companion `<col>_status` column, when null has more than one meaning. */
  readonly statusColumn?: string;
  /** The fixed set, when `unit` is `enum`. Rendered as filter chips. */
  readonly enumValues?: readonly string[];
  /**
   * Which column in the same table names this value's unit. **Required when
   * `unit` is `provider_defined`** — a per-row unit that is not recorded
   * anywhere is a number nobody can interpret later, so the dictionary refuses
   * to declare one without saying where the unit lives.
   */
  readonly unitColumn?: string;
  /**
   * The named converter in `units/` that produces this value from the provider's
   * representation. Its absence means the value is stored exactly as sent — which
   * the inspector shows too: "0.3882 stored, 0.3882 from E*Trade OptionGreeks.iv,
   * no conversion".
   */
  readonly converter?: string;
  readonly sourceProvider?: Provider;
  /** The provider's own field path, verbatim, e.g. `OptionGreeks.iv`. */
  readonly sourceField?: string;
  readonly description: string;
  readonly primaryKey?: boolean;
  readonly unique?: boolean;
  readonly references?: { readonly table: string; readonly column: string };
  /**
   * Set when the field has **not** been observed in a live response yet (02 §16).
   * The value is the verify-list note. A column carrying this cannot be part of a
   * frozen dictionary — the pre-pilot checklist in 04 §11 closes them.
   */
  readonly verify?: string;
}

export interface IndexEntry {
  readonly columns: readonly string[];
  readonly unique?: boolean;
  /** A partial-index predicate, e.g. `valid_to IS NULL` for "current members". */
  readonly where?: string;
}

export interface TableEntry {
  readonly table: string;
  readonly layer: Layer;
  /** Groups tables inside a layer; the inspector orders `raw_` by 02's sections. */
  readonly domain: string;
  readonly description: string;
  /**
   * The columns that identify a fact across versions (02 §0.5). Version mode and
   * the replay comparison (04 §7.5) both read this. Empty only for control tables
   * whose rows are not facts.
   */
  readonly naturalKey: readonly string[];
  /**
   * `true` for tables whose rows are facts: no UPDATE and no DELETE path,
   * enforced by a trigger (AC-2).
   */
  readonly appendOnly: boolean;
  /**
   * Names the column a **validity-range** table closes — 02 §0.2: "Where a
   * domain needs an explicit validity range (membership tables) it uses
   * `valid_from` / `valid_to` instead" of supersession.
   *
   * Such a table is still append-only for its facts: the generated trigger
   * permits an UPDATE **only** when it sets this column from NULL and changes
   * nothing else. That is narrower than turning the guard off, and it is the
   * distinction that matters — a departure closing a membership row is not the
   * same act as editing what that membership said.
   */
  readonly validRangeColumn?: string;
  /**
   * `false` for tables the dictionary marks "not rule-driven" (reference,
   * calendar) — their `capture_rule_id` is nullable. 02 §0.2.
   */
  readonly ruleDriven: boolean;
  /** Whether the six standard columns of 02 §0.2 are prepended. */
  readonly standardColumns: boolean;
  readonly columns: readonly ColumnEntry[];
  readonly indexes: readonly IndexEntry[];
}

/** Convenience builders — several hundred column entries have to stay readable. */
export const col = {
  text: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'TEXT', unit: 'text', nullable: false, description, ...rest
  }),
  ident: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'TEXT', unit: 'identifier', nullable: false, description, ...rest
  }),
  date: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'TEXT', unit: 'date_et', nullable: false, description, ...rest
  }),
  ts: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'TEXT', unit: 'timestamp_et', nullable: false, description, ...rest
  }),
  enumOf: (
    column: string,
    enumValues: readonly string[],
    description: string,
    rest: Partial<ColumnEntry> = {}
  ): ColumnEntry => ({
    column, type: 'TEXT', unit: 'enum', nullable: false, enumValues, description, ...rest
  }),
  int: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'INTEGER', unit: 'count', nullable: false, description, ...rest
  }),
  flag: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'INTEGER', unit: 'flag', nullable: false, description, ...rest
  }),
  usd: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'REAL', unit: 'usd', nullable: false, description, ...rest
  }),
  perShare: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'REAL', unit: 'usd_per_share', nullable: false, description, ...rest
  }),
  fraction: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'REAL', unit: 'fraction', nullable: false, description, ...rest
  }),
  json: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'TEXT', unit: 'json', nullable: false, description, ...rest
  }),
  ratio: (column: string, description: string, rest: Partial<ColumnEntry> = {}): ColumnEntry => ({
    column, type: 'REAL', unit: 'ratio', nullable: false, description, ...rest
  }),
  /** A value whose unit varies per row; `unitColumn` says which column names it. */
  providerDefined: (
    column: string,
    unitColumn: string,
    description: string,
    rest: Partial<ColumnEntry> = {}
  ): ColumnEntry => ({
    column, type: 'REAL', unit: 'provider_defined', unitColumn, nullable: false, description, ...rest
  })
};

/**
 * Marks a column nullable with a single stated reason (02 §0.3) — no status
 * column, because there is only one way for it to be null.
 */
export function nullable(entry: ColumnEntry, meaning: string): ColumnEntry {
  return { ...entry, nullable: true, nullMeaning: meaning };
}

/**
 * Marks a column nullable with a companion `<col>_status`, for values that can be
 * null for more than one reason. Returns **both** columns, so a status column can
 * never be forgotten: the pattern is one call, not two entries kept in step by
 * hand.
 */
export function withStatus(
  entry: ColumnEntry,
  opts: { readonly statuses?: readonly StatusValue[] } = {}
): readonly ColumnEntry[] {
  const statusColumn = `${entry.column}_status`;
  return [
    { ...entry, nullable: true, nullMeaning: 'see status', statusColumn },
    {
      column: statusColumn,
      type: 'TEXT',
      unit: 'enum',
      nullable: false,
      enumValues: opts.statuses ?? STATUS_VALUES,
      description: `Why \`${entry.column}\` is null, or \`ok\` when it is not.`,
      sourceProvider: 'collector'
    }
  ];
}

/**
 * Several value columns sharing one status column — the Greeks, or a quote's
 * bid/ask pair. Returns the value columns pointing at the shared status, then the
 * status column itself.
 */
export function withSharedStatus(
  entries: readonly ColumnEntry[],
  statusColumn: string,
  opts: { readonly statuses?: readonly StatusValue[] } = {}
): readonly ColumnEntry[] {
  const covered = entries.map((e) => `\`${e.column}\``).join(', ');
  return [
    ...entries.map((e) => ({ ...e, nullable: true, nullMeaning: 'see status', statusColumn })),
    {
      column: statusColumn,
      type: 'TEXT',
      unit: 'enum',
      nullable: false,
      enumValues: opts.statuses ?? STATUS_VALUES,
      description: `Why ${covered} are null, or \`ok\` when they are not.`,
      sourceProvider: 'collector'
    }
  ];
}
