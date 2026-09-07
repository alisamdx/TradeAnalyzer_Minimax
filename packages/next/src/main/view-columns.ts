import { getTable, type ColumnEntry } from '@tradeanalyzer/core';
import type { ViewCell, ViewColumn } from '../shared/types.js';

/**
 * Turns dictionary columns into the generic shape the domain views render — 05
 * §4.
 *
 * The domain views (Chains, Account) are lenses on tables the generic Data view
 * already shows. What they must **not** be is a second, hand-written description
 * of those tables: a label typed here would drift from the dictionary silently,
 * and AC-13's claim that no table-specific UI code exists would quietly become
 * false while everything still worked.
 *
 * So the column list is picked by name in the main process — which owns SQL and
 * the dictionary anyway — and every label, unit and null meaning is read from
 * the dictionary entry. The renderer receives columns it cannot name.
 */

/** `open_interest` reads as "Open interest", not as a column name. */
function humanise(column: string): string {
  const words = column.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function viewColumns(
  table: string,
  picks: readonly { readonly column: string; readonly label?: string; readonly group?: string }[]
): readonly ViewColumn[] {
  const entry = getTable(table);
  if (!entry) throw new Error(`Unknown table: ${table}`);
  const byName = new Map(entry.columns.map((c) => [c.column, c]));

  return picks.map((p) => {
    const c = byName.get(p.column);
    if (!c) throw new Error(`${table} has no column ${p.column}`);
    return {
      key: c.column,
      label: p.label ?? humanise(c.column),
      unit: c.unit,
      nullMeaning: c.nullMeaning ?? null,
      group: p.group ?? null
    };
  });
}

/** The `<col>_status` companion, when the dictionary declares one. */
function statusColumnOf(table: string, column: string): string | null {
  const entry = getTable(table);
  const c = entry?.columns.find((x: ColumnEntry) => x.column === column);
  return c?.statusColumn ?? null;
}

export function cellsFor(
  table: string,
  columns: readonly ViewColumn[],
  row: Readonly<Record<string, unknown>>
): readonly ViewCell[] {
  return columns.map((col) => {
    const statusCol = statusColumnOf(table, col.key);
    return {
      value: row[col.key] ?? null,
      // Null with no status column still carries its declared meaning, which the
      // renderer reads off the column — a null cell is never blank (AC-3).
      status: statusCol ? ((row[statusCol] as string | undefined) ?? null) : null
    };
  });
}
