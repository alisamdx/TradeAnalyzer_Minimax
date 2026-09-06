import type { SqliteLike } from '../db/sqlite-like.js';
import type { TableEntry } from './types.js';
import { DICTIONARY, DICTIONARY_VERSION } from './index.js';
import { generateDdl } from './ddl.js';

/**
 * Applying the dictionary to a generation database, and materialising it into
 * `meta_dictionary` — 02 §0.5, §1.
 *
 * `core` never opens the database. The host passes an open `SqliteLike` in
 * (06 §11), which is what keeps the native driver and its ABI flip out of here.
 */

export interface ApplyResult {
  readonly tablesCreated: readonly string[];
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

/**
 * Creates what is missing and adds columns the dictionary has gained.
 *
 * **Additive only, on purpose.** A new table, a new nullable column and a new
 * index are safe to apply to a generation in flight. A type change, a rename or
 * a unit change is not — it would silently reinterpret rows already written, so
 * it is a replay into a new generation (04 §7.5), never an in-place migration.
 * This function refuses the second kind rather than attempting it.
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

  // Columns the dictionary has gained since this generation was created.
  for (const table of dictionary) {
    if (!before.has(table.table)) continue; // freshly created above, already complete
    const present = existingColumns(db, table.table);
    for (const column of table.columns) {
      if (present.has(column.column)) continue;
      if (!column.nullable && column.primaryKey !== true) {
        throw new Error(
          `Cannot add NOT NULL column ${table.table}.${column.column} to an existing generation. ` +
            'Within a generation the dictionary may only grow by nullable columns, new tables and new ' +
            'indexes; anything else is a replay into a new generation (04 §7.5).'
        );
      }
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
