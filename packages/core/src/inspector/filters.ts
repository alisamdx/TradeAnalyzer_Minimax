import type { ColumnEntry, TableEntry } from '../dictionary/types.js';

/**
 * The inspector's filter model — 05 §3.2, §8 (B9c).
 *
 * Pure and dictionary-driven, and in `core` rather than in the new exe for one
 * reason: a saved question is validated with the SAME rules that run it. A
 * filter the Data view would refuse must not be storable as a question that
 * then fails every time somebody opens it.
 *
 * Every filter names a dictionary column and an operator that column's type
 * allows; values are bound as parameters, never spliced into SQL.
 */

export const FILTER_OPS = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'in', 'is_null', 'not_null'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export type FilterValue = string | number | readonly (string | number)[] | null;

export interface InspectorFilter {
  readonly column: string;
  readonly op: FilterOp;
  readonly value?: FilterValue;
}

export type VersionMode = 'all' | 'latest';

export type ColumnKind = 'number' | 'flag' | 'enum' | 'date' | 'timestamp' | 'text';

export class FilterRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterRefused';
  }
}

/** Above this many rows a filtered or versioned query must be anchored on an index (05 §8). */
export const SMALL_TABLE_ROWS = 200_000;

/** Operators that let SQLite use an index on the column they filter. */
const ANCHOR_OPS: ReadonlySet<FilterOp> = new Set(['eq', 'in', 'lt', 'lte', 'gt', 'gte', 'is_null']);

export function columnKind(c: ColumnEntry): ColumnKind {
  if (c.unit === 'flag') return 'flag';
  if (c.unit === 'enum') return 'enum';
  if (c.unit === 'date_et') return 'date';
  if (c.unit === 'timestamp_et') return 'timestamp';
  if (c.type === 'INTEGER' || c.type === 'REAL') return 'number';
  return 'text';
}

const OPS_BY_KIND: Readonly<Record<ColumnKind, readonly FilterOp[]>> = {
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'],
  flag: ['eq'],
  enum: ['eq', 'ne', 'in'],
  date: ['eq', 'lt', 'lte', 'gt', 'gte'],
  // Equality on a full timestamp with offset is almost never what a person
  // means, so a timestamp is filtered by range only.
  timestamp: ['lt', 'lte', 'gt', 'gte'],
  text: ['eq', 'ne', 'contains']
};

/**
 * The operators a column accepts. `is_null` / `not_null` only on a column the
 * dictionary declares nullable — asking where a NOT NULL column is null is a
 * question with a known answer, and offering it would suggest otherwise.
 */
export function opsFor(c: ColumnEntry): readonly FilterOp[] {
  const base = OPS_BY_KIND[columnKind(c)];
  return c.nullable ? [...base, 'is_null', 'not_null'] : base;
}

/** The columns an index can start from: the primary key and the leading column of each full index. */
export function indexedColumns(entry: TableEntry): ReadonlySet<string> {
  const out = new Set<string>();
  for (const c of entry.columns) if (c.primaryKey) out.add(c.column);
  for (const idx of entry.indexes) {
    // A partial index serves only queries that repeat its predicate, which a
    // generic filter does not, so it does not count as an anchor.
    if (idx.where) continue;
    const first = idx.columns[0];
    if (first) out.add(first);
  }
  return out;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function numberOf(v: unknown, column: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new FilterRefused(`${column} needs a number; got "${String(v)}".`);
  return n;
}

function textOf(v: unknown, column: string): string {
  if (typeof v !== 'string' && typeof v !== 'number') throw new FilterRefused(`${column} needs a value.`);
  const s = String(v).trim();
  if (s === '') throw new FilterRefused(`${column} needs a value.`);
  if (s.length > 200) throw new FilterRefused(`${column}: a filter value is limited to 200 characters.`);
  return s;
}

/**
 * Checks one filter against its column and returns it with a clean value.
 *
 * A date given for a timestamp column is widened to the whole ET day, because
 * that is what "on or before 2026-09-09" means to a person; the comparison is
 * then done on the stored ISO string, which sorts correctly within one offset.
 */
export function validateFilter(entry: TableEntry, f: InspectorFilter): InspectorFilter {
  const c = entry.columns.find((x) => x.column === f.column);
  if (!c) throw new FilterRefused(`${entry.table} has no column "${f.column}".`);
  if (!(FILTER_OPS as readonly string[]).includes(f.op)) throw new FilterRefused(`Unknown filter operator "${String(f.op)}".`);
  const ops = opsFor(c);
  if (!ops.includes(f.op)) {
    throw new FilterRefused(
      `${c.column} cannot be filtered with "${f.op}". It accepts: ${ops.join(', ')}` +
        (f.op === 'is_null' || f.op === 'not_null' ? ' — the dictionary declares it never null.' : '.')
    );
  }
  if (f.op === 'is_null' || f.op === 'not_null') return { column: c.column, op: f.op, value: null };

  const kind = columnKind(c);
  switch (kind) {
    case 'number':
      return { column: c.column, op: f.op, value: numberOf(f.value, c.column) };
    case 'flag': {
      const n = numberOf(f.value, c.column);
      if (n !== 0 && n !== 1) throw new FilterRefused(`${c.column} is a 0/1 flag.`);
      return { column: c.column, op: f.op, value: n };
    }
    case 'enum': {
      const allowed = c.enumValues ?? [];
      const values = f.op === 'in'
        ? (Array.isArray(f.value) ? f.value : String(f.value ?? '').split(',')).map((v) => String(v).trim()).filter((v) => v !== '')
        : [textOf(f.value, c.column)];
      if (values.length === 0) throw new FilterRefused(`${c.column} needs at least one value.`);
      if (values.length > 50) throw new FilterRefused(`${c.column}: at most 50 values in one filter.`);
      const bad = values.filter((v) => !allowed.includes(v));
      if (bad.length > 0) {
        throw new FilterRefused(`${c.column} is never ${bad.join(', ')}. Its values are: ${allowed.join(', ')}.`);
      }
      return { column: c.column, op: f.op, value: f.op === 'in' ? values : (values[0] as string) };
    }
    case 'date': {
      const s = textOf(f.value, c.column);
      if (!ISO_DATE.test(s)) throw new FilterRefused(`${c.column} needs a date as yyyy-mm-dd; got "${s}".`);
      return { column: c.column, op: f.op, value: s };
    }
    case 'timestamp': {
      const s = textOf(f.value, c.column);
      if (!ISO_DATE.test(s) && !/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        throw new FilterRefused(`${c.column} needs a date (yyyy-mm-dd) or an ISO timestamp; got "${s}".`);
      }
      if (!ISO_DATE.test(s)) return { column: c.column, op: f.op, value: s };
      // Widen a bare date to its whole day: `T99` sorts after any real time of
      // day on that date, so `<= dT99` includes all of it and `> dT99` none.
      const widened = f.op === 'lte' || f.op === 'gt' ? `${s}T99` : s;
      return { column: c.column, op: f.op, value: widened };
    }
    case 'text':
      return { column: c.column, op: f.op, value: textOf(f.value, c.column) };
  }
}

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;
const SQL_OP: Readonly<Record<Exclude<FilterOp, 'contains' | 'in' | 'is_null' | 'not_null'>, string>> = {
  eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>='
};

/**
 * SQL conditions for validated filters, qualified by `alias` when given. Only
 * dictionary column names reach the SQL text; every value is a parameter.
 */
export function filterSql(
  filters: readonly InspectorFilter[],
  alias?: string
): { readonly conditions: readonly string[]; readonly params: readonly unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    const col = alias ? `${alias}.${quote(f.column)}` : quote(f.column);
    switch (f.op) {
      case 'is_null':
        conditions.push(`${col} IS NULL`);
        break;
      case 'not_null':
        conditions.push(`${col} IS NOT NULL`);
        break;
      case 'contains': {
        const escaped = String(f.value).replace(/[\\%_]/g, (m) => `\\${m}`);
        conditions.push(`${col} LIKE ? ESCAPE '\\'`);
        params.push(`%${escaped}%`);
        break;
      }
      case 'in': {
        const values = f.value as readonly (string | number)[];
        conditions.push(`${col} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
        break;
      }
      default:
        conditions.push(`${col} ${SQL_OP[f.op]} ?`);
        params.push(f.value);
    }
  }
  return { conditions, params };
}

/**
 * The columns that identify one fact across its versions, or null when the
 * table has no versions to choose between (P1: supersession is a new row with a
 * later `observed_at`, never an UPDATE).
 */
export function versionPartition(entry: TableEntry): readonly string[] | null {
  if (!entry.columns.some((c) => c.column === 'observed_at')) return null;
  const partition = entry.naturalKey.filter((k) => k !== 'observed_at');
  return partition.length > 0 ? partition : null;
}

/**
 * Refuses a query that would scan a large table unanchored (05 §8).
 *
 * The rule as drafted was "every filter maps to an index". As built it is
 * narrower and more useful: on a table above `SMALL_TABLE_ROWS`, a filtered or
 * latest-version query needs **at least one** filter an index can start from;
 * the others then narrow what the index found. Below it, anything goes — a
 * full scan of a small table is cheaper than the refusal's round trip. The
 * message names the columns that would work, so a refusal is a direction
 * rather than a wall.
 */
export function assertAnchored(
  entry: TableEntry,
  filters: readonly InspectorFilter[],
  versionMode: VersionMode,
  approxRows: number
): void {
  if (approxRows <= SMALL_TABLE_ROWS) return;
  if (filters.length === 0 && versionMode === 'all') return;
  const indexed = indexedColumns(entry);
  if (filters.some((f) => indexed.has(f.column) && ANCHOR_OPS.has(f.op))) return;
  throw new FilterRefused(
    `${entry.table} holds about ${approxRows.toLocaleString('en-US')} rows, so a ` +
      `${versionMode === 'latest' ? 'latest-version view' : 'filtered view'} needs at least one filter an index can ` +
      `use: an equality or range on ${[...indexed].join(', ')}. A column that should be indexed and is not ` +
      'is a dictionary change (02 §0.6).'
  );
}

export interface QuestionDefinition {
  readonly filters: readonly InspectorFilter[];
  readonly sortColumn: string | null;
  readonly sortDescending: boolean;
  readonly versionMode: VersionMode;
  /** Latest version as of this date; null = latest of all. */
  readonly asOf: string | null;
  /** The visible columns, in order; null = every column. */
  readonly columns: readonly string[] | null;
}

/** Checks a saved question's definition against the table it is asked of — the same rules the Data view runs. */
export function validateDefinition(entry: TableEntry, d: QuestionDefinition): QuestionDefinition {
  const has = (column: string): boolean => entry.columns.some((c) => c.column === column);
  if (d.sortColumn !== null && !has(d.sortColumn)) throw new FilterRefused(`${entry.table} has no column "${d.sortColumn}" to sort on.`);
  if (d.versionMode !== 'all' && d.versionMode !== 'latest') throw new FilterRefused(`Unknown version mode "${String(d.versionMode)}".`);
  if (d.versionMode === 'latest' && versionPartition(entry) === null) {
    throw new FilterRefused(`${entry.table} has no versions to choose between; use "all versions".`);
  }
  if (d.asOf !== null && !ISO_DATE.test(d.asOf)) throw new FilterRefused(`"As of" needs a date as yyyy-mm-dd; got "${d.asOf}".`);
  if (d.columns !== null) {
    if (d.columns.length === 0) throw new FilterRefused('A question must show at least one column.');
    const unknown = d.columns.filter((c) => !has(c));
    if (unknown.length > 0) throw new FilterRefused(`${entry.table} has no column ${unknown.join(', ')}.`);
  }
  if (d.filters.length > 20) throw new FilterRefused('A question may carry at most 20 filters.');
  return {
    filters: d.filters.map((f) => validateFilter(entry, f)),
    sortColumn: d.sortColumn,
    sortDescending: d.sortDescending === true,
    versionMode: d.versionMode,
    asOf: d.asOf,
    columns: d.columns === null ? null : [...d.columns]
  };
}
