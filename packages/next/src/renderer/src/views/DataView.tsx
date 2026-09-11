import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ColumnMeta, FilterDto, FilterOpDto, QueryPage, QuestionDefinitionDto, SavedQuestionDto, TableStats, TreeGroup
} from '../../../shared/types.js';
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
 *
 * From B9c it filters (the operators each column offers come from `core`, so
 * the form offers only what the query will run), shows the latest version of
 * each fact, pages by keyset, chooses columns, and saves the whole question.
 */

const OP_LABEL: Readonly<Record<FilterOpDto, string>> = {
  eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥',
  contains: 'contains', in: 'is one of', is_null: 'is null', not_null: 'is not null'
};

const FRESH: QuestionDefinitionDto = {
  filters: [], sortColumn: null, sortDescending: false, versionMode: 'all', asOf: null, columns: null
};

export function DataView({
  tree,
  initialTable = null,
  readOnly = false
}: {
  tree: readonly TreeGroup[];
  /** Set by a `tradeanalyzer-next://table/<name>` link; the name was checked against the dictionary in main. */
  initialTable?: string | null;
  readOnly?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(initialTable);
  const [columns, setColumns] = useState<readonly ColumnMeta[]>([]);
  const [stats, setStats] = useState<TableStats | null>(null);
  const [asked, setAsked] = useState<QuestionDefinitionDto>(FRESH);
  const [visible, setVisible] = useState<readonly string[] | null>(null);
  const [rows, setRows] = useState<readonly Readonly<Record<string, unknown>>[]>([]);
  const [page, setPage] = useState<QueryPage | null>(null);
  const [questions, setQuestions] = useState<readonly SavedQuestionDto[]>([]);
  const [questionId, setQuestionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!initialTable) return;
    setSelected(initialTable);
  }, [initialTable]);

  const loadQuestions = useCallback(async (table: string) => {
    const r = await window.api.questions.list(table);
    if (r.ok) setQuestions(r.data);
  }, []);

  // A new table: a fresh question, its declaration, and the questions saved for it.
  useEffect(() => {
    if (!selected) return;
    setError(null);
    setNotice(null);
    setStats(null);
    setAsked(FRESH);
    setVisible(null);
    setQuestionId(null);
    setRows([]);
    setPage(null);
    void (async () => {
      const [c, s] = await Promise.all([window.api.dictionary.columns(selected), window.api.dictionary.stats(selected)]);
      if (!c.ok) return setError(c.error);
      if (!s.ok) return setError(s.error);
      setColumns(c.data);
      setStats(s.data);
      await loadQuestions(selected);
    })();
  }, [selected, loadQuestions]);

  const request = useCallback(
    (cursor: QueryPage['nextCursor']) =>
      window.api.inspect.query({
        table: selected ?? '',
        limit: 100,
        cursor,
        sortColumn: asked.sortColumn,
        sortDescending: asked.sortDescending,
        filters: asked.filters,
        versionMode: asked.versionMode,
        asOf: asked.asOf
      }),
    [selected, asked]
  );

  // The first page of whatever is being asked.
  useEffect(() => {
    if (!selected || !stats || stats.absent) return;
    let stale = false;
    void request(null).then((p) => {
      if (stale) return;
      if (!p.ok) {
        // A refusal is the answer, not a crash: it names the columns that would work.
        setError(p.error);
        setRows([]);
        setPage(null);
        return;
      }
      setError(null);
      setRows(p.data.rows);
      setPage(p.data);
    });
    return () => { stale = true; };
  }, [selected, stats, request]);

  const loadMore = async (): Promise<void> => {
    if (!page?.nextCursor) return;
    const p = await request(page.nextCursor);
    if (!p.ok) return setError(p.error);
    setRows((r) => [...r, ...p.data.rows]);
    setPage(p.data);
  };

  const ask = (patch: Partial<QuestionDefinitionDto>): void => {
    setAsked((a) => ({ ...a, ...patch }));
    setQuestionId(null);
  };

  const shown = useMemo(
    () => (visible === null ? columns : columns.filter((c) => visible.includes(c.column))),
    [columns, visible]
  );

  const applyQuestion = (q: SavedQuestionDto): void => {
    setAsked({ ...q.definition, columns: null });
    setVisible(q.definition.columns);
    setQuestionId(q.id);
    setNotice(q.note ? `${q.name}: ${q.note}` : null);
  };

  const saveAs = async (name: string, note: string): Promise<void> => {
    if (!selected) return;
    const r = await window.api.questions.save(name, selected, { ...asked, columns: visible }, note.trim() || null);
    if (!r.ok) return setError(r.error);
    setNotice(`Saved "${r.data.name}".`);
    await loadQuestions(selected);
    setQuestionId(r.data.id);
  };

  const retire = async (): Promise<void> => {
    if (questionId === null || !selected) return;
    const r = await window.api.questions.retire(questionId);
    if (!r.ok) return setError(r.error);
    setNotice('Retired. It stays in the generation, marked no longer in use.');
    setQuestionId(null);
    await loadQuestions(selected);
  };

  return (
    <div className="split">
      <TableTree tree={tree} selected={selected} onSelect={(t) => setSelected(t)} />
      <section className="pane">
        {!selected && (
          <p className="muted">
            Pick a table. Every one of them renders the same way, from its dictionary entry alone.
          </p>
        )}
        {selected && !stats && !error && <p className="muted">Loading {selected}…</p>}
        {selected && !stats && error && <div className="banner banner-error">{error}</div>}
        {selected && stats && (
          <>
            <header className="pane-head">
              <h2>{selected}</h2>
              <span className="count">
                {stats.rowCount.toLocaleString()} {stats.rowCount === 1 ? 'row' : 'rows'}
                {stats.newestAsOf ? ` · newest ${stats.newestAsOf}` : ''}
                {page?.matching &&
                  ` · ${page.matching.n.toLocaleString()}${page.matching.capped ? '+' : ''} matching`}
              </span>
            </header>

            {stats.absent ? (
              <p className="empty-note">
                This generation has no such table. It was built by an older dictionary, before the table
                existed — a read-only generation keeps the schema it was made with.
              </p>
            ) : (
              <>
                {stats.rowCount === 0 && <p className="empty-note">Empty — the schema exists, and nothing has been written to it yet.</p>}

                <QuestionBar
                  questions={questions}
                  questionId={questionId}
                  readOnly={readOnly}
                  onPick={applyQuestion}
                  onSave={saveAs}
                  onRetire={() => void retire()}
                />
                <FilterBar columns={columns} applied={asked.filters} onApply={(filters) => ask({ filters })} />

                <div className="query-row">
                  {stats.latestAvailable && (
                    <label>
                      Versions
                      <select
                        value={asked.versionMode}
                        onChange={(e) => ask({ versionMode: e.target.value as 'all' | 'latest' })}
                        title="Supersession is a new row with a later observation, never an edit (P1)"
                      >
                        <option value="all">all versions</option>
                        <option value="latest">latest of each fact</option>
                      </select>
                    </label>
                  )}
                  {asked.versionMode === 'latest' && (
                    <label>
                      as of
                      <input type="date" value={asked.asOf ?? ''} onChange={(e) => ask({ asOf: e.target.value || null })} />
                    </label>
                  )}
                  <ColumnChooser columns={columns} visible={visible} onChange={setVisible} />
                </div>

                {notice && <div className="notice notice-ok">{notice}<button className="link notice-close" onClick={() => setNotice(null)}>dismiss</button></div>}
                {error && <div className="notice notice-refused">{error}</div>}

                <Grid
                  columns={shown}
                  rows={rows}
                  stats={stats}
                  sortColumn={asked.sortColumn}
                  sortDescending={asked.sortDescending}
                  onSort={(c) =>
                    c === asked.sortColumn
                      ? ask({ sortDescending: !asked.sortDescending })
                      : ask({ sortColumn: c, sortDescending: false })
                  }
                />
                {page?.hasMore && (
                  <button className="btn load-more" onClick={() => void loadMore()}>
                    Load 100 more ({rows.length.toLocaleString()} shown)
                  </button>
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function QuestionBar({
  questions, questionId, readOnly, onPick, onSave, onRetire
}: {
  questions: readonly SavedQuestionDto[];
  questionId: number | null;
  readOnly: boolean;
  onPick: (q: SavedQuestionDto) => void;
  onSave: (name: string, note: string) => Promise<void>;
  onRetire: () => void;
}) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  return (
    <div className="question-bar">
      <label>
        Saved questions
        <select
          value={questionId ?? ''}
          onChange={(e) => {
            const q = questions.find((x) => String(x.id) === e.target.value);
            if (q) onPick(q);
          }}
        >
          <option value="">{questions.length === 0 ? 'none for this table' : 'choose…'}</option>
          {questions.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
        </select>
      </label>
      {!readOnly && questionId !== null && <button className="link" onClick={onRetire}>retire</button>}
      {!readOnly && (
        <span className="save-as">
          <input placeholder="save this question as…" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            className="btn"
            disabled={!name.trim()}
            onClick={() => void onSave(name, note).then(() => { setName(''); setNote(''); })}
          >
            Save
          </button>
        </span>
      )}
    </div>
  );
}

function FilterBar({
  columns, applied, onApply
}: {
  columns: readonly ColumnMeta[];
  applied: readonly FilterDto[];
  onApply: (filters: readonly FilterDto[]) => void;
}) {
  const filterable = columns.filter((c) => c.filterOps.length > 0);
  const [draft, setDraft] = useState<readonly FilterDto[]>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const byName = (name: string): ColumnMeta | undefined => filterable.find((c) => c.column === name);
  const update = (i: number, patch: Partial<FilterDto>): void =>
    setDraft(draft.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = (): void => {
    // An indexed column first: on a large table it is the one that makes the query possible.
    const c = filterable.find((x) => x.indexed) ?? filterable[0];
    if (c) setDraft([...draft, { column: c.column, op: c.filterOps[0] as FilterOpDto, value: '' }]);
  };
  const changed = JSON.stringify(draft) !== JSON.stringify(applied);

  return (
    <div className="filter-bar">
      {draft.map((f, i) => {
        const c = byName(f.column);
        return (
          <div className="filter" key={i}>
            <select
              value={f.column}
              onChange={(e) => {
                const next = byName(e.target.value);
                if (next) update(i, { column: next.column, op: next.filterOps[0] as FilterOpDto, value: '' });
              }}
            >
              {filterable.map((x) => (
                <option key={x.column} value={x.column}>{x.column}{x.indexed ? ' ⚑' : ''}</option>
              ))}
            </select>
            <select value={f.op} onChange={(e) => update(i, { op: e.target.value as FilterOpDto })}>
              {(c?.filterOps ?? []).map((op) => <option key={op} value={op}>{OP_LABEL[op]}</option>)}
            </select>
            {c && <ValueInput column={c} op={f.op} value={f.value} onChange={(v) => update(i, { value: v })} />}
            <button className="link" onClick={() => setDraft(draft.filter((_, j) => j !== i))} title="remove this filter">✕</button>
          </div>
        );
      })}
      <div className="filter-actions">
        <button className="link" onClick={add} disabled={filterable.length === 0}>+ filter</button>
        {(changed || applied.length > 0) && (
          <>
            <button className="btn" disabled={!changed} onClick={() => onApply(draft)}>Apply</button>
            {applied.length > 0 && <button className="link" onClick={() => { setDraft([]); onApply([]); }}>clear</button>}
          </>
        )}
        <span className="hint">⚑ an index starts from this column — on a large table, filter on one of these.</span>
      </div>
    </div>
  );
}

function ValueInput({
  column, op, value, onChange
}: {
  column: ColumnMeta;
  op: FilterOpDto;
  value: FilterDto['value'];
  onChange: (value: string) => void;
}) {
  if (op === 'is_null' || op === 'not_null') return null;
  const text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
  if (column.enumValues && op !== 'in') {
    return (
      <select value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">choose…</option>
        {column.enumValues.map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  if (column.unit === 'flag') {
    return (
      <select value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">choose…</option>
        <option value="1">1</option>
        <option value="0">0</option>
      </select>
    );
  }
  if (column.unit === 'date_et' || column.unit === 'timestamp_et') {
    return <input type="date" value={text.slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
  }
  const numeric = column.type === 'REAL' || column.type === 'INTEGER';
  return (
    <input
      type={numeric ? 'number' : 'text'}
      step="any"
      placeholder={op === 'in' ? 'comma-separated' : 'value'}
      value={text}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ColumnChooser({
  columns, visible, onChange
}: {
  columns: readonly ColumnMeta[];
  visible: readonly string[] | null;
  onChange: (visible: readonly string[] | null) => void;
}) {
  const shownCount = visible === null ? columns.length : visible.length;
  const toggle = (name: string, on: boolean): void => {
    const current = visible ?? columns.map((c) => c.column);
    const next = on ? columns.map((c) => c.column).filter((c) => c === name || current.includes(c)) : current.filter((c) => c !== name);
    onChange(next.length === columns.length ? null : next);
  };
  return (
    <details className="column-chooser">
      <summary>Columns ({shownCount} of {columns.length})</summary>
      <div className="column-list">
        <button className="link" onClick={() => onChange(null)}>show all</button>
        {columns.map((c) => (
          <label key={c.column}>
            <input
              type="checkbox"
              checked={visible === null || visible.includes(c.column)}
              disabled={visible !== null && visible.length === 1 && visible.includes(c.column)}
              onChange={(e) => toggle(c.column, e.target.checked)}
            />
            {c.column}
          </label>
        ))}
      </div>
    </details>
  );
}

function Grid({
  columns,
  rows,
  stats,
  sortColumn,
  sortDescending,
  onSort
}: {
  columns: readonly ColumnMeta[];
  rows: readonly Readonly<Record<string, unknown>>[];
  stats: TableStats;
  sortColumn: string | null;
  sortDescending: boolean;
  onSort: (column: string) => void;
}) {
  const statusColumns = useMemo(
    () => new Set(columns.map((c) => c.statusColumn).filter((s): s is string => s !== null)),
    [columns]
  );

  return (
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
          {rows.length === 0 && (
            <tr className="empty-row">
              <td colSpan={columns.length}>no rows</td>
            </tr>
          )}
          {rows.map((row, i) => (
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
  if (c.indexed) parts.push('Indexed — a filter here can anchor a query on a large table.');
  if (c.verify) parts.push(`UNVERIFIED — ${c.verify}`);
  return parts.join('\n\n');
}
