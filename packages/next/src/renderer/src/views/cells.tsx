import type { ColumnMeta } from '../../../shared/types.js';

/**
 * Cell and header rendering, driven entirely by a column's dictionary entry —
 * 05 §3.1.
 *
 * The null glyph is the part that matters. **A null cell is never blank**: it
 * shows why it is null, which is AC-3 made visible. A blank cell is the single
 * most expensive thing a data tool can render, because it looks identical
 * whether the provider omitted the field, the capture rule excluded it, the
 * value failed a range check, or the field has no meaning for that row — and
 * those four call for four different responses.
 */

const UNIT_LABEL: Readonly<Record<string, string>> = {
  fraction: 'fraction',
  usd: 'USD',
  usd_per_share: 'USD/sh',
  count: 'count',
  share_quantity: 'shares',
  date_et: 'ET date',
  timestamp_et: 'ET time',
  flag: '0/1',
  enum: 'enum',
  text: '',
  identifier: 'id',
  sha256: 'sha256',
  json: 'json',
  path: 'path',
  bytes: 'bytes',
  ratio: 'ratio',
  provider_defined: ''
};

export function UnitBadge({ column }: { column: ColumnMeta }) {
  if (column.unit === 'provider_defined') {
    return (
      <span className="unit" title={`The unit varies per row and is named by "${column.unitColumn}".`}>
        see {column.unitColumn}
      </span>
    );
  }
  const label = UNIT_LABEL[column.unit] ?? column.unit;
  if (!label) return null;
  return <span className="unit">{label}</span>;
}

const GLYPH: Readonly<Record<string, { mark: string; className: string; label: string }>> = {
  omitted: { mark: '○', className: 'null-omitted', label: 'omitted — the provider did not send this field' },
  outside_window: { mark: '⋯', className: 'null-outside', label: 'outside window — the capture rule did not request it' },
  invalid: { mark: '⚠', className: 'null-invalid', label: 'invalid — the provider sent a value that failed a range or type check; the raw body is in the archive' },
  not_applicable: { mark: '–', className: 'null-na', label: 'not applicable — this field has no meaning for this row' }
};

export function NullCell({ column, status }: { column: ColumnMeta; status: string | null }) {
  const glyph = status ? GLYPH[status] : undefined;
  const title = glyph
    ? `${column.column}: ${glyph.label}`
    : `${column.column} is null. ${column.nullMeaning ?? 'No meaning is declared — that is an AC-3 violation.'}`;
  return (
    <td className={`null ${glyph?.className ?? 'null-declared'}`} title={title}>
      <span className="null-mark">{glyph?.mark ?? '·'}</span>
    </td>
  );
}

/**
 * Formats a stored value for display. Stored units are never changed here — a
 * fraction shows as a fraction, and the raw stored value is always what the cell
 * carries as its title, so what is on screen can always be traced to what is in
 * the database.
 */
export function formatValue(
  column: ColumnMeta,
  value: unknown,
  row: Readonly<Record<string, unknown>>,
  statusColumns: ReadonlySet<string>
): JSX.Element | string {
  if (statusColumns.has(column.column)) {
    return <span className={`status status-${String(value)}`}>{String(value)}</span>;
  }
  if (column.unit === 'enum') {
    return <span className="chip">{String(value)}</span>;
  }
  if (column.unit === 'flag') {
    return <span className={value ? 'flag-on' : 'flag-off'}>{value ? 'yes' : 'no'}</span>;
  }
  if (column.unit === 'provider_defined' && column.unitColumn) {
    const unit = row[column.unitColumn];
    return <span title={`${String(value)} ${String(unit ?? '')}`}>{String(value)}</span>;
  }
  if (column.unit === 'fraction' && typeof value === 'number') {
    // Fractions are the unit this project has most often got wrong, so both
    // readings are always available: the percentage on screen, the stored value
    // on hover, never one silently standing in for the other.
    return <span title={`stored ${value}`}>{(value * 100).toFixed(2)}%</span>;
  }
  if (column.unit === 'json') {
    const text = String(value);
    return <span className="json" title={text}>{text.length > 60 ? `${text.slice(0, 60)}…` : text}</span>;
  }
  if (column.unit === 'sha256') {
    const text = String(value);
    return <span className="mono" title={text}>{text.slice(0, 10)}…</span>;
  }
  return String(value);
}
