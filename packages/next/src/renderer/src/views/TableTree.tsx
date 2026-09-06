import { useEffect, useState } from 'react';
import type { TableStats, TreeGroup } from '../../../shared/types.js';

/**
 * The table tree — 05 §3.3.
 *
 * Grouped by prefix, then by domain in the order 02 declares them. **The row
 * count and newest date show in the tree itself**, so an empty or stale table is
 * visible without opening it — which is the whole point of a tree over a
 * dropdown.
 */

const LAYER_LABEL: Readonly<Record<string, string>> = {
  meta: 'meta — the collection describing itself',
  ref: 'ref — reference and membership',
  raw: 'raw — provider facts',
  ext: 'ext — external series',
  derived: 'derived — pure functions of raw',
  legacy: 'legacy — the existing app’s decisions',
  qa: 'qa — quality reports'
};

export function TableTree({
  tree,
  selected,
  onSelect
}: {
  tree: readonly TreeGroup[];
  selected: string | null;
  onSelect: (table: string) => void;
}) {
  const [stats, setStats] = useState<Readonly<Record<string, TableStats>>>({});

  useEffect(() => {
    if (tree.length === 0) return;
    void (async () => {
      const all = tree.flatMap((g) => g.domains.flatMap((d) => d.tables));
      const collected: Record<string, TableStats> = {};
      for (const table of all) {
        const r = await window.api.dictionary.stats(table);
        if (r.ok) collected[table] = r.data;
      }
      setStats(collected);
    })();
  }, [tree]);

  return (
    <nav className="tree">
      {tree.map((group) => (
        <div key={group.layer} className="tree-layer">
          <div className="tree-layer-label" title={LAYER_LABEL[group.layer]}>{group.layer}</div>
          {group.domains.map((domain) => (
            <div key={domain.domain} className="tree-domain">
              <div className="tree-domain-label">{domain.domain}</div>
              {domain.tables.map((table) => {
                const s = stats[table];
                return (
                  <button
                    key={table}
                    className={`tree-table${selected === table ? ' is-active' : ''}`}
                    onClick={() => onSelect(table)}
                  >
                    <span className="tree-table-name">{table}</span>
                    <span className={`tree-table-count${s && s.rowCount === 0 ? ' is-empty' : ''}`}>
                      {s ? s.rowCount.toLocaleString() : '·'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
