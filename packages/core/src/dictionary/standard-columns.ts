import type { ColumnEntry, Layer, TableEntry } from './types.js';

/**
 * The six columns on every raw and snapshot table — 02 §0.2.
 *
 * They are generated, never typed out per table, for the reason that motivates
 * the whole dictionary: a provenance column that is present on 30 tables and
 * quietly missing from the 31st is exactly the kind of gap that is invisible
 * until the day it is needed. `source_response_id` in particular is what AC-1
 * rests on — "for any non-null value in any raw table, the inspector can open the
 * archived response it was parsed from" is only true if every such table has it.
 */
export function standardColumns(entry: {
  readonly ruleDriven: boolean;
  readonly table: string;
  readonly layer?: Layer;
}): readonly ColumnEntry[] {
  // **A derived row is not parsed from a response, so it cannot carry one.**
  // 02 §0.2 says these are the columns on every *raw and snapshot* table, and
  // `source_response_id` in particular is defined as "the archived response the
  // row was parsed from". A `derived_` row is a function of many stored rows —
  // `derived_iv30_daily` reads a whole chain across two expirations — so there
  // is no single response to name, and naming one of the contributors would be
  // a provenance claim that is false.
  //
  // Found at B7b, when phase 9 first tried to write the table B2 had declared:
  // NOT NULL with an FK, and nothing legitimate to put in it. AC-1 is unaffected
  // — it is scoped to raw tables, and the reproducibility guarantee for a
  // derived row is a different one, carried by `derivation_version` plus the
  // stored inputs (P4). The column stays, nullable, because "which run wrote
  // this" and "which response, if any" are still the inspector's navigations.
  const derived = entry.layer === 'derived';
  return [
    {
      column: 'row_id',
      type: 'INTEGER',
      unit: 'count',
      nullable: false,
      primaryKey: true,
      description: 'Surrogate key, never reused.',
      sourceProvider: 'collector'
    },
    {
      column: 'run_id',
      type: 'INTEGER',
      unit: 'count',
      nullable: false,
      references: { table: 'meta_run', column: 'run_id' },
      description: 'The collector run that wrote this row.',
      sourceProvider: 'collector'
    },
    {
      column: 'as_of_date',
      type: 'TEXT',
      unit: 'date_et',
      nullable: false,
      description:
        'The trading day the fact is *about* — not when it was fetched. A bar re-fetched ' +
        'on Monday for Friday has Friday here and Monday in `observed_at`.',
      sourceProvider: 'collector'
    },
    {
      column: 'observed_at',
      type: 'TEXT',
      unit: 'timestamp_et',
      nullable: false,
      description:
        'When the provider was asked (P1). Supersession is resolved on this: "current as of X" ' +
        'means the latest `observed_at` <= X per natural key, never an UPDATE.',
      sourceProvider: 'collector'
    },
    {
      column: 'capture_rule_id',
      type: 'INTEGER',
      unit: 'count',
      nullable: !entry.ruleDriven,
      ...(entry.ruleDriven
        ? {}
        : {
            nullMeaning: derived
              ? 'this table is derived — no capture rule caused the row; `derivation_version` says how it was produced'
              : 'this table is not rule-driven — reference and calendar data is captured unconditionally'
          }),
      references: { table: 'meta_capture_rule', column: 'capture_rule_id' },
      description:
        'Which capture rule version caused this row to exist (P6). A rule change creates a new ' +
        'rule row rather than editing the old one, so a past row still says what was asked for.',
      sourceProvider: 'collector'
    },
    {
      column: 'source_response_id',
      type: 'INTEGER',
      unit: 'count',
      nullable: derived,
      ...(derived
        ? {
            nullMeaning:
              'always null on a derived table — the row is a function of many stored rows, not a parse of one response'
          }
        : {}),
      references: { table: 'meta_response', column: 'source_response_id' },
      description:
        'The archived provider response this row was parsed from. AC-1 is exactly this column ' +
        'being present and correct on every raw row.',
      sourceProvider: 'collector'
    }
  ];
}

/** Builds a full `TableEntry`, prepending the standard columns where they apply. */
export function defineTable(
  spec: Omit<TableEntry, 'columns'> & { readonly columns: readonly ColumnEntry[] }
): TableEntry {
  const columns = spec.standardColumns
    ? [...standardColumns({ ruleDriven: spec.ruleDriven, table: spec.table, layer: spec.layer }), ...spec.columns]
    : spec.columns;
  return { ...spec, columns };
}
