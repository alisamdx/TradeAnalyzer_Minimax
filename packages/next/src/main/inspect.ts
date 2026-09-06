import { DICTIONARY, getTable, groupedForInspector, type ColumnEntry } from '@tradeanalyzer/core';
import { currentDb } from './generation.js';
import type { ColumnMeta, TableMeta, TableStats, QueryPage, TreeGroup } from '../shared/types.js';

/**
 * The schema-driven inspector's main-process half — 05 §3.
 *
 * Everything the renderer needs to draw a table comes from the dictionary. There
 * is **no per-table code anywhere**, which is AC-13: adding a table to the
 * dictionary is the whole of adding it to the inspector.
 */

function toColumnMeta(c: ColumnEntry): ColumnMeta {
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
    verify: c.verify ?? null
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
  return entry.columns.map(toColumnMeta);
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
  const db = currentDb();

  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };

  let newestAsOf: string | null = null;
  if (entry.columns.some((c) => c.column === 'as_of_date')) {
    const row = db.prepare(`SELECT MAX(as_of_date) AS d FROM "${table}"`).get() as { d: string | null };
    newestAsOf = row.d;
  }

  const nullRates: Record<string, number | null> = {};
  if (n > 0) {
    const nullableCols = entry.columns.filter((c) => c.nullable);
    if (nullableCols.length > 0) {
      const selects = nullableCols
        .map((c) => `SUM(CASE WHEN "${c.column}" IS NULL THEN 1 ELSE 0 END) AS "${c.column}"`)
        .join(', ');
      const row = db.prepare(`SELECT ${selects} FROM "${table}"`).get() as Record<string, number>;
      for (const c of nullableCols) nullRates[c.column] = (row[c.column] ?? 0) / n;
    }
  } else {
    for (const c of entry.columns.filter((x) => x.nullable)) nullRates[c.column] = null;
  }

  return { table, rowCount: n, newestAsOf, nullRates };
}

export interface QueryRequest {
  readonly table: string;
  readonly limit?: number;
  readonly cursor?: number | null;
  readonly sortColumn?: string | null;
  readonly sortDescending?: boolean;
}

/**
 * A page of rows.
 *
 * **Keyset pagination on `rowid`, never OFFSET.** The chain snapshot table grows
 * to millions of rows, and OFFSET makes page N cost N pages of scanning — the
 * kind of thing that is imperceptible on an empty table at B2 and unusable at
 * B6, by which time the call site is everywhere.
 */
export function query(req: QueryRequest): QueryPage {
  const entry = getTable(req.table);
  if (!entry) throw new Error(`Unknown table: ${req.table}`);
  const db = currentDb();

  const limit = Math.min(Math.max(req.limit ?? 100, 1), 1000);

  // Only a declared column may be sorted on — the dictionary is the allow-list,
  // so no caller can reach a column that does not exist or inject through this.
  const sortColumn =
    req.sortColumn && entry.columns.some((c) => c.column === req.sortColumn) ? req.sortColumn : null;

  const key = entry.columns.some((c) => c.column === 'row_id') ? 'row_id' : 'rowid';
  const where = req.cursor != null ? `WHERE "${key}" > ?` : '';
  const order = sortColumn
    ? `ORDER BY "${sortColumn}" ${req.sortDescending ? 'DESC' : 'ASC'}, "${key}" ASC`
    : `ORDER BY "${key}" ASC`;

  const sql = `SELECT "${key}" AS __key, * FROM "${req.table}" ${where} ${order} LIMIT ${limit + 1}`;
  const rows = (req.cursor != null ? db.prepare(sql).all(req.cursor) : db.prepare(sql).all()) as Record<
    string,
    unknown
  >[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore ? (page[page.length - 1]?.['__key'] as number) : null;

  return {
    table: req.table,
    columns: entry.columns.map((c) => c.column),
    rows: page.map((r) => {
      const out: Record<string, unknown> = {};
      for (const c of entry.columns) out[c.column] = r[c.column] ?? null;
      return out;
    }),
    nextCursor,
    hasMore
  };
}
