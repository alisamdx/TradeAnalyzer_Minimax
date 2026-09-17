import type { ColumnEntry, Layer, TableEntry } from './types.js';
import { metaTables } from './tables/meta.js';
import { referenceTables } from './tables/reference.js';
import { marketTables } from './tables/market.js';
import { fundamentalsAccountTables } from './tables/fundamentals-account.js';
import { derivedLegacyTables } from './tables/derived-legacy.js';
import { qaTables } from './tables/qa.js';

export * from './types.js';
export { defineTable, standardColumns } from './standard-columns.js';

/**
 * The data dictionary — 02, as code.
 *
 * **A column that is not here cannot exist**: the DDL generator reads this array
 * and nothing else, and there is no migrations directory (06 §3). That is AC-3
 * and AC-13 held up by construction rather than by discipline.
 */
export const DICTIONARY: readonly TableEntry[] = [
  ...metaTables,
  ...referenceTables,
  ...marketTables,
  ...fundamentalsAccountTables,
  ...derivedLegacyTables,
  ...qaTables
];

/**
 * Bumped on **any** change to **any** entry. Written to `meta_run` and
 * `meta_dictionary`, and it is what tells a reader whether two generations share
 * a schema. Within a generation, changes are additive only (new tables, new
 * nullable columns, new indexes); anything else is a replay into a new
 * generation, never an in-place migration.
 */
export const DICTIONARY_VERSION = 17;

/** Layer render order for the inspector's tree (02 §0.4). */
export const LAYER_ORDER: readonly Layer[] = ['meta', 'ref', 'raw', 'ext', 'derived', 'legacy', 'qa'];

const byName = new Map(DICTIONARY.map((t) => [t.table, t]));

export function tableNames(): readonly string[] {
  return DICTIONARY.map((t) => t.table);
}

export function getTable(name: string): TableEntry | undefined {
  return byName.get(name);
}

/** Every column entry in the dictionary, flattened, with its table. */
export function allColumns(): readonly { table: TableEntry; column: ColumnEntry; ordinal: number }[] {
  return DICTIONARY.flatMap((table) =>
    table.columns.map((column, ordinal) => ({ table, column, ordinal }))
  );
}

/**
 * Tables grouped for the inspector tree: by layer in `LAYER_ORDER`, then by
 * domain in declaration order, which for `raw_` is the order of 02's sections.
 */
export function groupedForInspector(
  tables: readonly TableEntry[] = DICTIONARY
): readonly { layer: Layer; domains: readonly { domain: string; tables: readonly TableEntry[] }[] }[] {
  return LAYER_ORDER.map((layer) => {
    const inLayer = tables.filter((t) => t.layer === layer);
    const domains: { domain: string; tables: TableEntry[] }[] = [];
    for (const t of inLayer) {
      const existing = domains.find((d) => d.domain === t.domain);
      if (existing) existing.tables.push(t);
      else domains.push({ domain: t.domain, tables: [t] });
    }
    return { layer, domains };
  }).filter((g) => g.domains.length > 0);
}

/**
 * Columns still carrying a verify note (02 §16) — fields not yet observed in a
 * live response. Surfaced rather than buried: the Dictionary view lists them, and
 * a generation cannot be promoted to production while any remain, because a
 * column whose provider meaning is unconfirmed is a column whose values cannot
 * be trusted.
 */
export function unverifiedColumns(): readonly { table: string; column: string; note: string }[] {
  return allColumns()
    .filter((c) => c.column.verify)
    .map((c) => ({ table: c.table.table, column: c.column.column, note: c.column.verify as string }));
}
