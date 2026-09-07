import type { ViewCell, ViewColumn } from '../../../shared/types.js';

/**
 * The domain views' cell renderer — the same AC-3 discipline as the generic
 * table, over the generic column shape the main process sends.
 *
 * Nothing here knows what any column means. It has a label, a unit and a
 * declared null meaning, and that is enough to render it — which is what keeps
 * AC-13 true for the domain views as well as the table view.
 */

const GLYPH: Readonly<Record<string, { mark: string; className: string; label: string }>> = {
  omitted: { mark: '○', className: 'null-omitted', label: 'omitted — the provider did not send this field' },
  outside_window: { mark: '⋯', className: 'null-outside', label: 'outside window — the capture rule did not request it' },
  invalid: { mark: '⚠', className: 'null-invalid', label: 'invalid — the provider sent a value that failed a range or type check' },
  not_applicable: { mark: '–', className: 'null-na', label: 'not applicable — this field has no meaning for this row' }
};

export function renderCell(column: ViewColumn, cell: ViewCell): JSX.Element {
  if (cell.value === null || cell.value === undefined) {
    const glyph = cell.status ? GLYPH[cell.status] : undefined;
    const title = glyph
      ? `${column.label}: ${glyph.label}`
      : `${column.label} is null. ${column.nullMeaning ?? 'No meaning is declared — that is an AC-3 violation.'}`;
    return (
      <span className={`null-mark ${glyph?.className ?? 'null-declared'}`} title={title}>
        {glyph?.mark ?? '·'}
      </span>
    );
  }

  if (column.unit === 'fraction' && typeof cell.value === 'number') {
    // Both readings, always: the percentage on screen and the stored value on
    // hover. Never one silently standing in for the other.
    return <span title={`stored ${String(cell.value)}`}>{(cell.value * 100).toFixed(2)}%</span>;
  }
  if (column.unit === 'usd' && typeof cell.value === 'number') {
    return <span>{cell.value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}</span>;
  }
  if (column.unit === 'enum') {
    return <span className="chip">{String(cell.value)}</span>;
  }
  if (column.unit === 'timestamp_et') {
    const text = String(cell.value);
    return <span title={text}>{text.slice(0, 16).replace('T', ' ')}</span>;
  }
  return <span>{String(cell.value)}</span>;
}

/** Column groups render as a labelled band — "provider estimates" is one. */
export function groupSpans(
  columns: readonly ViewColumn[]
): readonly { group: string | null; span: number }[] {
  const out: { group: string | null; span: number }[] = [];
  for (const c of columns) {
    const last = out[out.length - 1];
    if (last && last.group === c.group) last.span++;
    else out.push({ group: c.group, span: 1 });
  }
  return out;
}
