import type { ColumnEntry, TableEntry } from './types.js';
import { DICTIONARY } from './index.js';

/**
 * The DDL generator — 02 §0.5.
 *
 * This is the **only** way a table is created. There is no migrations directory
 * (06 §3): within a generation, schema change is additive only and applied as a
 * generated forward-only diff; anything else is a replay into a new generation.
 * That is P1 applied to the schema itself.
 */

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** A CHECK constraint pinning an enum column to its declared set. */
function enumCheck(c: ColumnEntry): string | undefined {
  if (c.unit !== 'enum' || !c.enumValues || c.enumValues.length === 0) return undefined;
  const list = c.enumValues.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  const inList = `${quote(c.column)} IN (${list})`;
  return c.nullable ? `(${quote(c.column)} IS NULL OR ${inList})` : inList;
}

/** A CHECK constraint pinning a flag column to 0/1. */
function flagCheck(c: ColumnEntry): string | undefined {
  if (c.unit !== 'flag') return undefined;
  const inList = `${quote(c.column)} IN (0, 1)`;
  return c.nullable ? `(${quote(c.column)} IS NULL OR ${inList})` : inList;
}

/**
 * The invariant that makes a status column mean something: a value column is
 * null **exactly when** its status is not `ok`. Without it the pair can drift
 * into a null value with `ok` status (a silent gap) or a present value with
 * `omitted` (a lie), and neither would ever raise.
 */
function statusCoherenceCheck(c: ColumnEntry, table: TableEntry): string | undefined {
  if (!c.statusColumn) return undefined;
  // Only emit once per (value, status) pair — a shared status column is checked
  // against each of the values it covers, which is what we want.
  const status = quote(c.statusColumn);
  const value = quote(c.column);
  const declared = table.columns.some((x) => x.column === c.statusColumn);
  if (!declared) return undefined;
  return `((${status} = 'ok' AND ${value} IS NOT NULL) OR (${status} <> 'ok' AND ${value} IS NULL))`;
}

export function columnDdl(c: ColumnEntry): string {
  const parts = [quote(c.column), c.type];
  if (c.primaryKey) parts.push('PRIMARY KEY');
  if (!c.nullable) parts.push('NOT NULL');
  if (c.unique && !c.primaryKey) parts.push('UNIQUE');
  if (c.references) {
    parts.push(`REFERENCES ${quote(c.references.table)}(${quote(c.references.column)})`);
  }
  return parts.join(' ');
}

export function tableDdl(table: TableEntry): string {
  const lines = table.columns.map(columnDdl);
  const checks: string[] = [];
  for (const c of table.columns) {
    const e = enumCheck(c);
    if (e) checks.push(e);
    const f = flagCheck(c);
    if (f) checks.push(f);
    const s = statusCoherenceCheck(c, table);
    if (s) checks.push(s);
  }
  const body = [...lines, ...checks.map((c) => `CHECK (${c})`)].join(',\n  ');
  return `CREATE TABLE IF NOT EXISTS ${quote(table.table)} (\n  ${body}\n);`;
}

export function indexDdl(table: TableEntry): readonly string[] {
  return table.indexes.map((idx, i) => {
    const name = `idx_${table.table}_${idx.columns.join('_')}${idx.where ? `_p${i}` : ''}`;
    const unique = idx.unique ? 'UNIQUE ' : '';
    const cols = idx.columns.map(quote).join(', ');
    const where = idx.where ? ` WHERE ${idx.where}` : '';
    return `CREATE ${unique}INDEX IF NOT EXISTS ${quote(name)} ON ${quote(table.table)} (${cols})${where};`;
  });
}

/**
 * Append-only enforcement (AC-2): a trigger that raises on UPDATE and on DELETE.
 *
 * A convention would not do. "No raw table has ever had a row updated or
 * deleted" has to be verifiable years later by someone who did not write the
 * ingestion code, and the only thing that survives that is the database refusing.
 * Supersession is a new row with a later `observed_at`; a generation reset drops
 * the file rather than deleting rows.
 */
export function appendOnlyTriggerDdl(table: TableEntry): readonly string[] {
  if (!table.appendOnly) return [];

  const noDelete =
    `CREATE TRIGGER IF NOT EXISTS ${quote(`trg_${table.table}_no_delete`)}\n` +
    `BEFORE DELETE ON ${quote(table.table)}\n` +
    `BEGIN SELECT RAISE(ABORT, '${table.table} is append-only: rows are removed only by a generation reset, never DELETE'); END;`;

  if (!table.validRangeColumn) {
    return [
      `CREATE TRIGGER IF NOT EXISTS ${quote(`trg_${table.table}_no_update`)}\n` +
        `BEFORE UPDATE ON ${quote(table.table)}\n` +
        `BEGIN SELECT RAISE(ABORT, '${table.table} is append-only: supersede with a new row (P1), never UPDATE'); END;`,
      noDelete
    ];
  }

  // A validity-range table (02 §0.2) closes exactly one column, exactly once.
  // Everything else about the row stays frozen, so "this membership ended" and
  // "what this membership said" remain two different acts — which is the whole
  // reason the range exists rather than an overwrite. Turning the guard off for
  // these tables would have been the easy fix and the wrong one.
  const range = quote(table.validRangeColumn);
  const editable = new Set([table.validRangeColumn, 'change_reason', 'removal_reason']);
  const frozen = table.columns
    .filter((c) => !editable.has(c.column))
    .map((c) => `OLD.${quote(c.column)} IS NOT NEW.${quote(c.column)}`)
    .join('\n     OR ');

  return [
    `CREATE TRIGGER IF NOT EXISTS ${quote(`trg_${table.table}_close_once`)}\n` +
      `BEFORE UPDATE ON ${quote(table.table)}\n` +
      `WHEN OLD.${range} IS NOT NULL\n` +
      `BEGIN SELECT RAISE(ABORT, '${table.table}.${table.validRangeColumn} is already closed: a range is closed once and never reopened'); END;`,
    `CREATE TRIGGER IF NOT EXISTS ${quote(`trg_${table.table}_no_edit`)}\n` +
      `BEFORE UPDATE ON ${quote(table.table)}\n` +
      `WHEN ${frozen}\n` +
      `BEGIN SELECT RAISE(ABORT, '${table.table} is append-only apart from closing ${table.validRangeColumn}: supersede with a new row (P1), never edit a stored fact'); END;`,
    noDelete
  ];
}

export interface GeneratedDdl {
  readonly tables: readonly string[];
  readonly indexes: readonly string[];
  readonly triggers: readonly string[];
}

export function generateDdl(dictionary: readonly TableEntry[] = DICTIONARY): GeneratedDdl {
  return {
    tables: dictionary.map(tableDdl),
    indexes: dictionary.flatMap(indexDdl),
    triggers: dictionary.flatMap(appendOnlyTriggerDdl)
  };
}

/** The whole schema as one script, in dependency-safe order. */
export function fullSchemaSql(dictionary: readonly TableEntry[] = DICTIONARY): string {
  const ddl = generateDdl(dictionary);
  return [
    '-- Generated from the data dictionary. Do not edit by hand:',
    '-- the dictionary is the source, and this file is regenerated from it.',
    '',
    ...ddl.tables,
    '',
    ...ddl.indexes,
    '',
    ...ddl.triggers,
    ''
  ].join('\n');
}
