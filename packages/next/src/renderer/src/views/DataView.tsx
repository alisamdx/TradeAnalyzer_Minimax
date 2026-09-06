import { useEffect, useMemo, useState } from 'react';
import type { ColumnMeta, QueryPage, TableStats, TreeGroup } from '../../../shared/types.js';
import { TableTree } from './TableTree.js';
import { UnitBadge, NullCell, formatValue } from './cells.js';

/**
 * The schema-driven inspector — 05 §3, and the proof of AC-13.
 *
 * **There is no table-specific code in this file, or anywhere else.** Every
 * column header, unit badge, alignment, enum chip and null glyph is derived from
 * the dictionary. Adding a table to the dictionary is the whole of adding it
 * here; if this component ever needs a branch on a table name, the inspector has
 * stopped being schema-driven and AC-13 no longer holds.
 */
export function DataView({ tree }: { tree: readonly TreeGroup[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [columns, setColumns] = useState<readonly ColumnMeta[]>([]);
  const [stats, setStats] = useState<TableStats | null>(null);
  const [page, setPage] = useState<QueryPage | null>(null);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDescending, setSortDescending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    void (async () => {
      const [c, s, p] = await Promise.all([
        window.api.dictionary.columns(selected),
        window.api.dictionary.stats(selected),
        window.api.inspect.query({ table: selected, limit: 100, sortColumn, sortDescending })
      ]);
      if (!c.ok) return setError(c.error);
      if (!s.ok) return setError(s.error);
      if (!p.ok) return setError(p.error);
      setColumns(c.data);
      setStats(s.data);
      setPage(p.data);
    })();
  }, [selected, sortColumn, sortDescending]);

  return (
    <div className="split">
      <TableTree tree={tree} selected={selected} onSelect={(t) => { setSortColumn(null); setSelected(t); }} />
      <section className="pane">
        {!selected && (
          <p className="muted">
            Pick a table. Every one of them renders the same way, from its dictionary entry alone.
          </p>
        )}
        {selected && (
          <TableInspector
            table={selected}
            columns={columns}
            stats={stats}
            page={page}
            error={error}
            sortColumn={sortColumn}
            sortDescending={sortDescending}
            onSort={(c) => {
              if (c === sortColumn) setSortDescending((d) => !d);
              else { setSortColumn(c); setSortDescending(false); }
            }}
          />
        )}
      </section>
    </div>
  );
}

function TableInspector({
  table,
  columns,
  stats,
  page,
  error,
  sortColumn,
  sortDescending,
  onSort
}: {
  table: string;
  columns: readonly ColumnMeta[];
  stats: TableStats | null;
  page: QueryPage | null;
  error: string | null;
  sortColumn: string | null;
  sortDescending: boolean;
  onSort: (column: string) => void;
}) {
  const statusColumns = useMemo(
    () => new Set(columns.map((c) => c.statusColumn).filter((s): s is string => s !== null)),
    [columns]
  );

  if (error) return <div className="banner banner-error">{error}</div>;
  if (!page || !stats) return <p className="muted">Loading {table}…</p>;

  return (
    <>
      <header className="pane-head">
        <h2>{table}</h2>
        <span className="count">
          {stats.rowCount.toLocaleString()} {stats.rowCount === 1 ? 'row' : 'rows'}
          {stats.newestAsOf ? ` · newest ${stats.newestAsOf}` : ''}
        </span>
      </header>

      {stats.rowCount === 0 && (
        <p className="empty-note">
          Empty. The schema exists; the collector that fills it arrives at B3.
        </p>
      )}

      <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.column}
                  className={numeric(c) ? 'num' : ''}
                  title={headerTitle(c)}
                  onClick={() => onSort(c.column)}
                >
                  <span className="col-name">
                    {c.column}
                    {c.primaryKey && <span className="pk" title="Primary key">key</span>}
                    {c.verify && <span className="verify" title={c.verify}>unverified</span>}
                  </span>
                  <UnitBadge column={c} />
                  {sortColumn === c.column && <span className="sort">{sortDescending ? '▼' : '▲'}</span>}
                  {stats.nullRates[c.column] === 1 && (
                    <span className="all-null" title="Every stored row is null here — a declared gap, not data (D7).">
                      all null
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.length === 0 && (
              <tr className="empty-row">
                <td colSpan={columns.length}>no rows</td>
              </tr>
            )}
            {page.rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const value = row[c.column];
                  if (value === null || value === undefined) {
                    const status = c.statusColumn ? (row[c.statusColumn] as string | null) : null;
                    return <NullCell key={c.column} column={c} status={status} />;
                  }
                  return (
                    <td
                      key={c.column}
                      className={numeric(c) ? 'num' : ''}
                      title={`${c.column}: ${String(value)}`}
                    >
                      {formatValue(c, value, row, statusColumns)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {page.hasMore && <p className="muted">More rows follow — paging arrives with the data at B3.</p>}
    </>
  );
}

function numeric(c: ColumnMeta): boolean {
  return c.type === 'REAL' || (c.type === 'INTEGER' && c.unit !== 'flag');
}

function headerTitle(c: ColumnMeta): string {
  const parts = [c.description];
  if (c.sourceProvider) {
    parts.push(`Source: ${c.sourceProvider}${c.sourceField ? ` ${c.sourceField}` : ''}`);
  }
  parts.push(c.converter ? `Converter: ${c.converter}` : 'Stored exactly as the provider sent it.');
  if (c.nullable && c.nullMeaning) parts.push(`Null means: ${c.nullMeaning}`);
  if (c.verify) parts.push(`UNVERIFIED — ${c.verify}`);
  return parts.join('\n\n');
}
