import { useEffect, useState } from 'react';
import type { ColumnMeta, TableMeta, TableStats, TreeGroup } from '../../../shared/types.js';
import { TableTree } from './TableTree.js';
import { UnitBadge } from './cells.js';
import { RichText } from './RichText.js';

/**
 * The Dictionary view — 05 §6, and where AC-3 is directly readable.
 *
 * Every table and column as the dictionary declares it: type, unit, nullability,
 * **what a null means**, source provider and field, converter, and the null rate
 * over what is actually stored. The null rate is the D7 half — a column that is
 * *always* null is a declared gap wearing the costume of data, and no table view
 * makes that visible because every empty cell looks like every other one.
 *
 * The pilot-exit checklist also lives here (05 §6); it arrives at B10, when
 * there is a pilot to exit.
 */
export function DictionaryView({ tree }: { tree: readonly TreeGroup[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [meta, setMeta] = useState<TableMeta | null>(null);
  const [columns, setColumns] = useState<readonly ColumnMeta[]>([]);
  const [stats, setStats] = useState<TableStats | null>(null);

  useEffect(() => {
    if (!selected) return;
    void (async () => {
      const [tabs, cols, s] = await Promise.all([
        window.api.dictionary.tables(),
        window.api.dictionary.columns(selected),
        window.api.dictionary.stats(selected)
      ]);
      if (tabs.ok) setMeta(tabs.data.find((t) => t.table === selected) ?? null);
      if (cols.ok) setColumns(cols.data);
      if (s.ok) setStats(s.data);
    })();
  }, [selected]);

  return (
    <div className="split">
      <TableTree tree={tree} selected={selected} onSelect={setSelected} />
      <section className="pane">
        {!selected && <p className="muted">Pick a table to read its declaration.</p>}
        {selected && meta && (
          <>
            <header className="pane-head">
              <h2>{meta.table}</h2>
              <span className="count">
                {meta.layer} · {meta.domain} · {meta.appendOnly ? 'append-only' : 'mutable'}
              </span>
            </header>
            <p className="table-desc"><RichText text={meta.description} /></p>
            <p className="muted">
              Natural key: <code>{meta.naturalKey.join(', ')}</code>
              {meta.appendOnly && ' — a fact is superseded by a new row with a later observed_at, never updated.'}
            </p>

            <div className="table-scroll">
              <table className="grid dict">
                {/* Fixed widths, so "what a null means" is on screen without
                    scrolling. It is the AC-3 column: pushing it off the right
                    edge would make the one thing this view exists to show the
                    one thing you have to go looking for. */}
                <colgroup>
                  <col style={{ width: '25%' }} />
                  <col style={{ width: '7%' }} />
                  <col style={{ width: '8%' }} />
                  <col style={{ width: '5%' }} />
                  <col style={{ width: '23%' }} />
                  <col style={{ width: '13%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '7%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>column</th>
                    <th>type</th>
                    <th>unit</th>
                    <th>null</th>
                    <th>what a null means</th>
                    <th>source</th>
                    <th>conversion</th>
                    <th className="num">null rate</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c) => {
                    const rate = stats?.nullRates[c.column];
                    return (
                      <tr key={c.column} className={c.verify ? 'is-unverified' : ''}>
                        <td>
                          <code>{c.column}</code>
                          {c.primaryKey && <span className="pk">key</span>}
                          {c.referencesTable && (
                            <span className="fk" title={`References ${c.referencesTable}`}>fk</span>
                          )}
                          {c.verify && <span className="verify" title={c.verify}>unverified</span>}
                          <div className="col-desc"><RichText text={c.description} /></div>
                          {c.enumValues && (
                            <div className="enum-chips">
                              {c.enumValues.map((v) => <span key={v} className="chip">{v}</span>)}
                            </div>
                          )}
                        </td>
                        <td className="mono">{c.type}</td>
                        <td><UnitBadge column={c} /></td>
                        <td>{c.nullable ? 'yes' : 'no'}</td>
                        <td className="null-meaning">
                          {c.nullable
                            ? c.statusColumn
                              ? <>see <code>{c.statusColumn}</code></>
                              : <RichText text={c.nullMeaning ?? ''} />
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          {c.sourceProvider ?? <span className="muted">—</span>}
                          {c.sourceField && <div className="source-field mono">{c.sourceField}</div>}
                        </td>
                        <td>
                          {c.converter
                            ? <code>{c.converter}</code>
                            : <span className="muted" title="Stored exactly as the provider sent it.">none</span>}
                        </td>
                        <td className="num">
                          {rate === null || rate === undefined
                            ? <span className="muted" title={stats?.rowCount === 0 ? 'No rows yet.' : 'Not nullable.'}>—</span>
                            : <span className={rate === 1 ? 'all-null' : ''}>{(rate * 100).toFixed(0)}%</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
