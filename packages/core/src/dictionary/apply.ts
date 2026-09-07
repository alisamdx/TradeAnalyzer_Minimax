import type { SqliteLike } from '../db/sqlite-like.js';
import type { TableEntry } from './types.js';
import { DICTIONARY, DICTIONARY_VERSION } from './index.js';
import { generateDdl, tableDdl } from './ddl.js';

/**
 * Applying the dictionary to a generation database, and materialising it into
 * `meta_dictionary` — 02 §0.5, §1.
 *
 * `core` never opens the database. The host passes an open `SqliteLike` in
 * (06 §11), which is what keeps the native driver and its ABI flip out of here.
 */

export interface ApplyResult {
  readonly tablesCreated: readonly string[];
  /** Empty tables whose shape changed and were recreated from the dictionary. */
  readonly tablesRebuilt: readonly string[];
  readonly columnsAdded: readonly { table: string; column: string }[];
  readonly indexesCreated: number;
  readonly triggersCreated: number;
  readonly dictionaryRows: number;
}

function existingTables(db: SqliteLike): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function existingColumns(db: SqliteLike, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function rowCount(db: SqliteLike, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/**
 * Creates what is missing and adds columns the dictionary has gained.
 *
 * **Additive only, on purpose.** A new table, a new nullable column and a new
 * index are safe to apply to a generation in flight. A type change, a rename or
 * a unit change is not — it would silently reinterpret rows already written, so
 * it is a replay into a new generation (04 §7.5), never an in-place migration.
 * This function refuses the second kind rather than attempting it.
 *
 * **The rule protects written rows, so an EMPTY table is a different case.** A
 * table with no rows carries no facts, and nothing can be reinterpreted that was
 * never recorded — so a reshape of one is applied by rebuilding it from the
 * dictionary rather than refused. A table with even one row keeps the old,
 * strict treatment.
 *
 * That distinction was missing, and the omission bricked the new exe at B7a:
 * splitting `raw_index_quote`'s shared status added a NOT NULL column to a table
 * holding **zero rows**, which was refused, correctly by the letter of the rule
 * and pointlessly in substance.
 *
 * **The second gap was worse, because it was silent.** The guard only ever
 * looked at columns the dictionary had *gained*. A column the dictionary had
 * **lost** stayed in the table — still NOT NULL, still carrying its CHECK — so
 * even a permitted migration could leave a table that accepts no inserts at all,
 * and the failure would arrive much later as a confusing constraint error inside
 * an ingestion transaction. A reshape has two halves and only one was being
 * checked.
 */
export function applyDictionary(
  db: SqliteLike,
  dictionary: readonly TableEntry[] = DICTIONARY
): ApplyResult {
  const before = existingTables(db);
  const ddl = generateDdl(dictionary);

  const columnsAdded: { table: string; column: string }[] = [];

  db.exec('PRAGMA foreign_keys = ON;');

  for (const statement of ddl.tables) db.exec(statement);

  const tablesRebuilt: string[] = [];

  // Columns the dictionary has gained — and, just as importantly, ones it has
  // lost — since this generation was created.
  for (const table of dictionary) {
    if (!before.has(table.table)) continue; // freshly created above, already complete
    const present = existingColumns(db, table.table);
    const declared = new Set(table.columns.map((c) => c.column));

    const added = table.columns.filter((c) => !present.has(c.column));
    const removed = [...present].filter((c) => !declared.has(c));
    const needsRebuild =
      removed.length > 0 || added.some((c) => !c.nullable && c.primaryKey !== true);

    if (needsRebuild) {
      const rows = rowCount(db, table.table);
      if (rows > 0) {
        const why = [
          ...added
            .filter((c) => !c.nullable && c.primaryKey !== true)
            .map((c) => `adds NOT NULL column ${c.column}`),
          ...removed.map((c) => `drops column ${c}`)
        ].join('; ');
        throw new Error(
          `Cannot reshape ${table.table} in an existing generation: it ${why}, and the table holds ` +
            `${rows} row(s). Within a generation the dictionary may only grow by nullable columns, ` +
            'new tables and new indexes; anything else is a replay into a new generation (04 §7.5).'
        );
      }

      // Empty, so there are no facts to reinterpret: rebuild from the
      // dictionary. The append-only triggers reference the table by name and
      // are recreated below along with the indexes.
      db.exec(`DROP TABLE "${table.table}";`);
      db.exec(tableDdl(table));
      tablesRebuilt.push(table.table);
      continue;
    }

    for (const column of added) {
      const nullMeaning = column.nullMeaning ?? '';
      db.exec(
        `ALTER TABLE "${table.table}" ADD COLUMN "${column.column}" ${column.type};` +
          (nullMeaning ? ` -- null means: ${nullMeaning.replace(/\n/g, ' ')}` : '')
      );
      columnsAdded.push({ table: table.table, column: column.column });
    }
  }

  for (const statement of ddl.indexes) db.exec(statement);
  for (const statement of ddl.triggers) db.exec(statement);

  const dictionaryRows = materialiseDictionary(db, dictionary);

  return {
    tablesCreated: dictionary.map((t) => t.table).filter((n) => !before.has(n)),
    tablesRebuilt,
    columnsAdded,
    indexesCreated: ddl.indexes.length,
    triggersCreated: ddl.triggers.length,
    dictionaryRows
  };
}

/**
 * Writes the dictionary into `meta_dictionary`.
 *
 * The point is not convenience for the inspector — it is that a generation
 * opened years from now still explains its own columns without the code that
 * wrote them. A schema whose only description lives in a source tree is a schema
 * that stops being self-describing the moment the two drift.
 */
export function materialiseDictionary(
  db: SqliteLike,
  dictionary: readonly TableEntry[] = DICTIONARY,
  version: number = DICTIONARY_VERSION
): number {
  // meta_dictionary is a projection, not a fact table: it is rebuilt for this
  // version rather than appended to, so re-running is idempotent.
  db.prepare('DELETE FROM meta_dictionary WHERE dictionary_version = ?').run(version);

  const insert = db.prepare(
    `INSERT INTO meta_dictionary (
       dictionary_version, table_name, column_name, ordinal, layer, domain, table_description,
       sql_type, unit, nullable, null_meaning, status_column, enum_values, unit_column, converter,
       source_provider, source_field, description, is_primary_key, references_table,
       natural_key, append_only, verify_note
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  let rows = 0;
  const write = db.transaction(() => {
    for (const table of dictionary) {
      const naturalKey = JSON.stringify(table.naturalKey);
      table.columns.forEach((c, ordinal) => {
        insert.run(
          version,
          table.table,
          c.column,
          ordinal,
          table.layer,
          table.domain,
          table.description,
          c.type,
          c.unit,
          c.nullable ? 1 : 0,
          c.nullMeaning ?? null,
          c.statusColumn ?? null,
          c.enumValues ? JSON.stringify(c.enumValues) : null,
          c.unitColumn ?? null,
          c.converter ?? null,
          c.sourceProvider ?? null,
          c.sourceField ?? null,
          c.description,
          c.primaryKey ? 1 : 0,
          c.references?.table ?? null,
          naturalKey,
          table.appendOnly ? 1 : 0,
          c.verify ?? null
        );
        rows++;
      });
    }
  });
  write();
  return rows;
}
