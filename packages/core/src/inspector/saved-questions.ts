import type { SqliteLike } from '../db/sqlite-like.js';
import type { OperatorHost } from '../collector/host.js';
import { getTable } from '../dictionary/index.js';
import { OperatorActionRefused } from '../qa/operator.js';
import { validateDefinition, type QuestionDefinition } from './filters.js';

/**
 * Saved questions — 05 §11.2 (B9c).
 *
 * A named filter + sort + version mode + column set, stored IN the generation
 * (`meta_saved_question`) so a question travels with the data it was asked of.
 * The honest precursor to a stage-2 study: "which rows did I look at, and how
 * did I ask" becomes a thing that can be re-opened rather than re-typed.
 *
 * **Nothing is deleted** (05 §9). Saving under a name already in use retires
 * the old definition and writes a new row, so what a name meant last week is
 * still readable; retiring stamps `retired_at` — the one edit the table's
 * trigger permits.
 */

export interface SavedQuestion {
  readonly id: number;
  readonly name: string;
  readonly table: string;
  readonly definition: QuestionDefinition;
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
}

interface Row {
  question_id: number;
  name: string;
  table_name: string;
  definition_json: string;
  note: string | null;
  created_at: string;
  created_by: string;
}

function toQuestion(r: Row): SavedQuestion {
  return {
    id: r.question_id,
    name: r.name,
    table: r.table_name,
    definition: JSON.parse(r.definition_json) as QuestionDefinition,
    note: r.note,
    createdAt: r.created_at,
    createdBy: r.created_by
  };
}

export function saveQuestion(
  db: SqliteLike,
  host: OperatorHost,
  args: { readonly name: string; readonly table: string; readonly definition: QuestionDefinition; readonly note?: string | null }
): SavedQuestion {
  const name = args.name.trim();
  if (name === '') throw new OperatorActionRefused('A saved question needs a name.');
  if (name.length > 80) throw new OperatorActionRefused('A question name is limited to 80 characters.');
  const entry = getTable(args.table);
  if (!entry) throw new OperatorActionRefused(`The dictionary declares no table "${args.table}".`);

  // Validated with the rules the Data view runs, so a stored question is one
  // that can actually be asked. A FilterRefused surfaces with its own reason.
  const definition = validateDefinition(entry, args.definition);
  const now = host.nowET();
  const note = args.note?.trim() ? args.note.trim() : null;

  let id = 0;
  const write = db.transaction(() => {
    db.prepare('UPDATE meta_saved_question SET retired_at = ? WHERE name = ? AND retired_at IS NULL').run(now, name);
    id = Number(
      db
        .prepare(
          `INSERT INTO meta_saved_question (name, table_name, definition_json, note, created_at, created_by)
           VALUES (?,?,?,?,?,?)`
        )
        .run(name, entry.table, JSON.stringify(definition), note, now, `${host.hostApp.name} ${host.hostApp.version}`)
        .lastInsertRowid
    );
  });
  write();

  return {
    id, name, table: entry.table, definition, note, createdAt: now,
    createdBy: `${host.hostApp.name} ${host.hostApp.version}`
  };
}

export function retireQuestion(db: SqliteLike, host: OperatorHost, id: number): void {
  const changed = db
    .prepare('UPDATE meta_saved_question SET retired_at = ? WHERE question_id = ? AND retired_at IS NULL')
    .run(host.nowET(), id).changes;
  if (changed === 0) throw new OperatorActionRefused(`No saved question ${id} is in use.`);
}

/** The questions in use, optionally only those asked of one table. */
export function listQuestions(db: SqliteLike, table?: string): readonly SavedQuestion[] {
  const rows = (
    table === undefined
      ? db.prepare('SELECT * FROM meta_saved_question WHERE retired_at IS NULL ORDER BY name').all()
      : db.prepare('SELECT * FROM meta_saved_question WHERE retired_at IS NULL AND table_name = ? ORDER BY name').all(table)
  ) as Row[];
  return rows.map(toQuestion);
}
