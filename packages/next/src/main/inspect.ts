import {
  DICTIONARY,
  FilterRefused,
  assertAnchored,
  filterSql,
  getTable,
  groupedForInspector,
  indexedColumns,
  opsFor,
  validateFilter,
  versionPartition,
  type ColumnEntry,
  type InspectorFilter,
  type VersionMode
} from '@tradeanalyzer/core';
import { currentDb, currentGeneration } from './generation.js';
import type {
  ColumnMeta, FilterDto, QueryCursorDto, QueryPage, TableMeta, TableStats, TreeGroup
} from '../shared/types.js';

/**
 * The schema-driven inspector's main-process half — 05 §3.
 *
 * Everything the renderer needs to draw a table comes from the dictionary. There
 * is **no per-table code anywhere**, which is AC-13: adding a table to the
 * dictionary is the whole of adding it to the inspector.
 *
 * From B9c it filters, pages and shows the latest version of each fact. The
 * filter rules live in `core` (`inspector/filters.ts`), so a saved question is
 * held to exactly the rules that run it here.
 */

function toColumnMeta(c: ColumnEntry, indexed: ReadonlySet<string>): ColumnMeta {
  return {
    column: c.column,
    type: c.type,
    unit: c.unit,
    unitColumn: c.unitColumn ?? null,
    nullable: c.nullable,
    nullMeaning: c.nullMeaning ?? null,
    statusColumn: c.statusColumn ?? null,
    enumValues: c.enumValues ? [...c.enumValues] : null,
    converter: c.converter ?? null,
    sourceProvider: c.sourceProvider ?? null,
    sourceField: c.sourceField ?? null,
    description: c.description,
    primaryKey: c.primaryKey === true,
    referencesTable: c.references?.table ?? null,
    verify: c.verify ?? null,
    filterOps: [...opsFor(c)],
    indexed: indexed.has(c.column)
  };
}

export function tables(): readonly TableMeta[] {
  return DICTIONARY.map((t) => ({
    table: t.table,
    layer: t.layer,
    domain: t.domain,
    description: t.description,
    naturalKey: [...t.naturalKey],
    appendOnly: t.appendOnly,
    columnCount: t.columns.length
  }));
}

export function tree(): readonly TreeGroup[] {
  return groupedForInspector().map((g) => ({
    layer: g.layer,
    domains: g.domains.map((d) => ({ domain: d.domain, tables: d.tables.map((t) => t.table) }))
  }));
}

export function columns(table: string): readonly ColumnMeta[] {
  const entry = getTable(table);
  if (!entry) throw new Error(`Unknown table: ${table}`);
  const indexed = indexedColumns(entry);
  return entry.columns.map((c) => toColumnMeta(c, indexed));
}

/**
 * Whether the open generation has this table at all. A closed generation opened
 * read-only (B9c) was built by an older dictionary and cannot be upgraded — a
 * read-only connection cannot run `applyDictionary` — so a table added since
 * simply is not there, and that is a fact to show rather than an error to throw.
 */
function tableExists(table: string): boolean {
  return (
    currentDb().prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
  );
}

function presentColumns(table: string): ReadonlySet<string> {
  const rows = currentDb().prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Row count, newest `as_of_date` and per-column null rate.
 *
 * The null rate is what makes D7 visible: a column that is **always** null is a
 * declared gap masquerading as data, and it is invisible in a table view because
 * every cell looks the same as every other empty cell.
 */
export function stats(table: string): TableStats {
  const entry = getTable(table);
  if (!entry) throw new Error(`Unknown table: ${table}`);
  const latestAvailable = versionPartition(entry) !== null;
  if (!tableExists(table)) {
    return { table, rowCount: 0, newestAsOf: null, nullRates: {}, absent: true, latestAvailable };
  }
  const db = currentDb();
  const present = presentColumns(table);

  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };

  let newestAsOf: string | null = null;
  if (present.has('as_of_date')) {
    const row = db.prepare(`SELECT MAX(as_of_date) AS d FROM "${table}"`).get() as { d: string | null };
    newestAsOf = row.d;
  }

  const nullRates: Record<string, number | null> = {};
  const nullableCols = entry.columns.filter((c) => c.nullable && present.has(c.column));
  if (n > 0) {
    if (nullableCols.length > 0) {
      const selects = nullableCols
        .map((c) => `SUM(CASE WHEN "${c.column}" IS NULL THEN 1 ELSE 0 END) AS "${c.column}"`)
        .join(', ');
      const row = db.prepare(`SELECT ${selects} FROM "${table}"`).get() as Record<string, number>;
      for (const c of nullableCols) nullRates[c.column] = (row[c.column] ?? 0) / n;
    }
  } else {
    for (const c of nullableCols) nullRates[c.column] = null;
  }

  return { table, rowCount: n, newestAsOf, nullRates, absent: false, latestAvailable };
}

export interface QueryRequest {
  readonly table: string;
  readonly limit?: number;
  readonly cursor?: QueryCursorDto | null;
  readonly sortColumn?: string | null;
  readonly sortDescending?: boolean;
  readonly filters?: readonly FilterDto[];
  readonly versionMode?: VersionMode;
  readonly asOf?: string | null;
}

/** How far a "matching rows" count goes before it stops and says "more than". */
const MATCH_CAP = 100_000;

const quote = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/**
 * A page of rows.
 *
 * **Keyset pagination, never OFFSET.** The chain snapshot table grows to
 * millions of rows, and OFFSET makes page N cost N pages of scanning. With a
 * sort the cursor is `(sort value, key)`, and NULLs are ordered last and paged
 * as their own tail — a plain tuple comparison against NULL is NULL, which
 * would silently end the walk at the first null.
 *
 * **Latest version** (P1): one row per natural key, the latest `observed_at`
 * (as of a date, when given). Filters on the natural-key columns go INSIDE the
 * window, where they are exact — every version of a fact shares them — and let
 * an index be used; filters on anything else go outside, so they test the
 * latest value rather than picking "the latest version that happened to match".
 */
export function query(req: QueryRequest): QueryPage {
  const entry = getTable(req.table);
  if (!entry) throw new Error(`Unknown table: ${req.table}`);
  if (!tableExists(req.table)) {
    throw new Error(
      `gen-${String(currentGeneration().generationNo).padStart(3, '0')} has no ${req.table} — ` +
        'it was created by an older dictionary, before this table existed.'
    );
  }
  const db = currentDb();

  const limit = Math.min(Math.max(req.limit ?? 100, 1), 1000);

  // Only a declared column may be sorted on — the dictionary is the allow-list,
  // so no caller can reach a column that does not exist or inject through this.
  const sortColumn =
    req.sortColumn && entry.columns.some((c) => c.column === req.sortColumn) ? req.sortColumn : null;

  const filters: InspectorFilter[] = (req.filters ?? []).map((f) => validateFilter(entry, f as InspectorFilter));
  const partition = req.versionMode === 'latest' ? versionPartition(entry) : null;
  if (req.versionMode === 'latest' && !partition) {
    throw new FilterRefused(`${entry.table} has no versions to choose between.`);
  }
  const mode: VersionMode = partition ? 'latest' : 'all';
  const asOf = req.asOf ?? null;
  if (asOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new FilterRefused(`"As of" needs a date as yyyy-mm-dd; got "${asOf}".`);

  const key = entry.columns.some((c) => c.column === 'row_id') ? 'row_id' : 'rowid';
  const keyExpr = key === 'rowid' ? 't.rowid' : `t.${quote(key)}`;
  // MAX(key) is an O(log n) upper bound on the row count — good enough to
  // decide whether a query must be anchored, where COUNT(*) would scan it all.
  const approxRows =
    (db.prepare(`SELECT MAX(${key === 'rowid' ? 'rowid' : quote(key)}) AS n FROM ${quote(entry.table)}`).get() as { n: number | null }).n ?? 0;

  const inner = partition ? filters.filter((f) => partition.includes(f.column)) : filters;
  const outer = partition ? filters.filter((f) => !partition.includes(f.column)) : [];
  assertAnchored(entry, inner, mode, approxRows);

  let source: string;
  const sourceParams: unknown[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (partition) {
    const innerSql = filterSql(inner, 't');
    const where = [...innerSql.conditions];
    sourceParams.push(...innerSql.params);
    if (asOf !== null) {
      where.push('substr(t."observed_at", 1, 10) <= ?');
      sourceParams.push(asOf);
    }
    source =
      `SELECT t.*, ${keyExpr} AS __key, ROW_NUMBER() OVER (` +
      `PARTITION BY ${partition.map((c) => `t.${quote(c)}`).join(', ')} ` +
      `ORDER BY t."observed_at" DESC, ${keyExpr} DESC) AS __rn ` +
      `FROM ${quote(entry.table)} t${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;
    conditions.push('q.__rn = 1');
    const outerSql = filterSql(outer, 'q');
    conditions.push(...outerSql.conditions);
    params.push(...outerSql.params);
  } else {
    // A plain projection, which SQLite flattens — so filters on the outer query
    // still reach the table's indexes.
    source = `SELECT ${keyExpr} AS __key, t.* FROM ${quote(entry.table)} t`;
    const sql = filterSql(filters, 'q');
    conditions.push(...sql.conditions);
    params.push(...sql.params);
  }

  const cursorConditions: string[] = [];
  const cursorParams: unknown[] = [];
  const cursor = req.cursor ?? null;
  const sortExpr = sortColumn ? `q.${quote(sortColumn)}` : null;
  if (cursor) {
    if (!sortExpr) {
      cursorConditions.push('q.__key > ?');
      cursorParams.push(cursor.key);
    } else if (cursor.sort === null || cursor.sort === undefined) {
      cursorConditions.push(`(${sortExpr} IS NULL AND q.__key > ?)`);
      cursorParams.push(cursor.key);
    } else {
      const cmp = req.sortDescending ? '<' : '>';
      cursorConditions.push(
        `((${sortExpr} IS NOT NULL AND (${sortExpr} ${cmp} ? OR (${sortExpr} = ? AND q.__key > ?))) OR ${sortExpr} IS NULL)`
      );
      cursorParams.push(cursor.sort, cursor.sort, cursor.key);
    }
  }

  const order = sortExpr
    ? `ORDER BY (${sortExpr} IS NULL), ${sortExpr} ${req.sortDescending ? 'DESC' : 'ASC'}, q.__key ASC`
    : 'ORDER BY q.__key ASC';
  const where = (extra: readonly string[]): string => {
    const all = [...conditions, ...extra];
    return all.length > 0 ? `WHERE ${all.join(' AND ')}` : '';
  };

  const sql = `SELECT * FROM (${source}) q ${where(cursorConditions)} ${order} LIMIT ${limit + 1}`;
  const rows = db.prepare(sql).all(...sourceParams, ...params, ...cursorParams) as Record<string, unknown>[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor: QueryCursorDto | null =
    hasMore && last ? { sort: sortColumn ? (last[sortColumn] ?? null) : null, key: last['__key'] as number } : null;

  // How many rows match, counted only when something narrows the table and
  // capped so a count can never be the slow part of a page.
  let matching: QueryPage['matching'] = null;
  if (!cursor && (filters.length > 0 || mode === 'latest')) {
    const counted = (
      db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM (${source}) q ${where([])} LIMIT ${MATCH_CAP + 1})`)
        .get(...sourceParams, ...params) as { n: number }
    ).n;
    matching = { n: Math.min(counted, MATCH_CAP), capped: counted > MATCH_CAP };
  }

  return {
    table: req.table,
    columns: entry.columns.map((c) => c.column),
    rows: page.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of entry.columns) out[c.column] = r[c.column] ?? null;
      return out;
    }),
    nextCursor,
    hasMore,
    matching,
    versionMode: mode
  };
}
