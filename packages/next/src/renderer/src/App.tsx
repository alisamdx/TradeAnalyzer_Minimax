import { useCallback, useEffect, useState } from 'react';
import type { GenerationInfoDto, TreeGroup } from '../../shared/types.js';
import type { DeepLinkRoute } from '../../shared/deeplink.js';
import { DataView } from './views/DataView.js';
import { DictionaryView } from './views/DictionaryView.js';
import { ChainsView } from './views/ChainsView.js';
import { AccountView } from './views/AccountView.js';
import { EarningsView } from './views/EarningsView.js';
import { IvView } from './views/IvView.js';
import { LegacyView } from './views/LegacyView.js';
import { ExceptionsView, type ExceptionsFocus } from './views/ExceptionsView.js';
import { RunsView, type RunsFocus } from './views/RunsView.js';
import { JobsView } from './views/JobsView.js';
import { RichText } from './views/RichText.js';

/**
 * The shell, in 05 §2's order as far as it is built.
 *
 * The remaining sections — Bars, Universe, Archive, Settings — arrive with the
 * build steps that fill them. None is stubbed here: an empty section in a
 * sidebar reads as a broken feature, not as a future one.
 */

type Section =
  | 'overview' | 'exceptions' | 'runs' | 'data' | 'chains' | 'account' | 'earnings' | 'iv'
  | 'legacy' | 'dictionary' | 'jobs';

const SECTIONS: readonly { id: Section; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'Generation and schema at a glance' },
  { id: 'exceptions', label: 'Exceptions', hint: 'Every finding the gate raised, and the rulings on it' },
  { id: 'runs', label: 'Runs', hint: 'Every collector run: its calls, and what the gate made of them' },
  { id: 'data', label: 'Data', hint: 'Every table, rendered from the dictionary' },
  { id: 'chains', label: 'Chains', hint: 'Option chains by ticker, date and expiration' },
  { id: 'account', label: 'Account', hint: 'Positions, executed orders and balances' },
  { id: 'earnings', label: 'Earnings', hint: 'Report dates, and every observation of them' },
  { id: 'iv', label: 'IV', hint: 'Our own IV30 against the external history, and the overlap between them' },
  { id: 'legacy', label: 'Legacy', hint: 'What the existing app decided, and what it turned down' },
  { id: 'dictionary', label: 'Dictionary', hint: 'Every column, and what a null in it means' },
  { id: 'jobs', label: 'Jobs', hint: 'Queue one-shot jobs, and reset the generation' }
];

export function App() {
  const [section, setSection] = useState<Section>('overview');
  const [generation, setGeneration] = useState<GenerationInfoDto | null>(null);
  const [tree, setTree] = useState<readonly TreeGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  const [exceptionsFocus, setExceptionsFocus] = useState<ExceptionsFocus>({ runId: null, exceptionId: null, nonce: 0 });
  const [runsFocus, setRunsFocus] = useState<RunsFocus>({ runId: null, nonce: 0 });
  const [dataTable, setDataTable] = useState<string | null>(null);

  const loadGeneration = useCallback(async () => {
    const g = await window.api.generation.current();
    if (!g.ok) { setError(g.error); return; }
    setGeneration(g.data);
    const t = await window.api.dictionary.tree();
    if (!t.ok) { setError(t.error); return; }
    setTree(t.data);
  }, []);

  useEffect(() => { void loadGeneration(); }, [loadGeneration]);

  /** A deep link: go somewhere, and nothing else (05 §11.1). */
  const navigate = useCallback((route: DeepLinkRoute) => {
    setLinkProblem(null);
    switch (route.section) {
      case 'exceptions':
        setExceptionsFocus((f) => ({ runId: route.runId ?? null, exceptionId: route.exceptionId ?? null, nonce: f.nonce + 1 }));
        setSection('exceptions');
        break;
      case 'runs':
        setRunsFocus((f) => ({ runId: route.runId ?? null, nonce: f.nonce + 1 }));
        setSection('runs');
        break;
      case 'data':
        setDataTable(route.table);
        setSection('data');
        break;
      case 'overview':
        setLinkProblem(route.problem);
        setSection('overview');
        break;
    }
  }, []);

  useEffect(() => {
    void window.api.deepLinks.initial().then((r) => { if (r.ok && r.data) navigate(r.data); });
    return window.api.deepLinks.onNavigate(navigate);
  }, [navigate]);

  const tableCount = tree.reduce((n, g) => n + g.domains.reduce((m, d) => m + d.tables.length, 0), 0);

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-name">TradeAnalyzer 2</span>
          <span className="brand-sub">
            {generation
              ? `gen-${String(generation.generationNo).padStart(3, '0')} · ${generation.status}`
              : 'opening…'}
          </span>
        </div>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`nav-item${section === s.id ? ' is-active' : ''}`}
            onClick={() => setSection(s.id)}
            title={s.hint}
          >
            {s.label}
          </button>
        ))}
        <div className="sidebar-foot">
          {tableCount > 0 ? `${tableCount} tables` : ''}
          {generation ? ` · dictionary v${generation.dictionaryVersion}` : ''}
        </div>
      </nav>

      <main className="content">
        {error && (
          <div className="banner banner-error">
            <strong>Could not open the generation.</strong>
            <p>{error}</p>
          </div>
        )}
        {linkProblem && (
          <div className="notice notice-refused">
            {linkProblem}
            <button className="link notice-close" onClick={() => setLinkProblem(null)}>dismiss</button>
          </div>
        )}
        {!error && section === 'overview' && <Overview generation={generation} tableCount={tableCount} />}
        {!error && section === 'exceptions' && <ExceptionsView focus={exceptionsFocus} />}
        {!error && section === 'runs' && (
          <RunsView
            focus={runsFocus}
            onOpenExceptions={(runId) => navigate({ section: 'exceptions', runId })}
          />
        )}
        {!error && section === 'data' && <DataView tree={tree} initialTable={dataTable} />}
        {!error && section === 'chains' && <ChainsView />}
        {!error && section === 'account' && <AccountView />}
        {!error && section === 'earnings' && <EarningsView />}
        {!error && section === 'iv' && <IvView />}
        {!error && section === 'legacy' && <LegacyView />}
        {!error && section === 'dictionary' && <DictionaryView tree={tree} />}
        {!error && section === 'jobs' && <JobsView onGenerationChanged={() => void loadGeneration()} />}
      </main>
    </div>
  );
}

function Overview({
  generation,
  tableCount
}: {
  generation: GenerationInfoDto | null;
  tableCount: number;
}) {
  const [unverified, setUnverified] = useState<readonly { table: string; column: string; note: string }[]>([]);

  useEffect(() => {
    void window.api.dictionary.unverified().then((r) => { if (r.ok) setUnverified(r.data); });
  }, []);

  if (!generation) return <p className="muted">Opening the generation…</p>;

  return (
    <>
      <h1>Overview</h1>
      <p className="lede">
        Stage 1, build step B9a. The collector runs every phase; findings are ruled on in
        Exceptions, runs are read in Runs, and one-shot jobs are queued from Jobs.
      </p>

      <dl className="facts">
        <div><dt>Generation</dt><dd>gen-{String(generation.generationNo).padStart(3, '0')} — {generation.status}</dd></div>
        {generation.predecessorNo !== null && (
          <div>
            <dt>Replaced</dt>
            <dd>
              gen-{String(generation.predecessorNo).padStart(3, '0')} (closed, still on disk)
              {generation.resetReason ? ` — ${generation.resetReason}` : ''}
            </dd>
          </div>
        )}
        <div><dt>Opened</dt><dd title={generation.openedAt}>{generation.openedAt.slice(0, 16).replace('T', ' ')}</dd></div>
        <div><dt>Dictionary</dt><dd>v{generation.dictionaryVersion} — {tableCount} tables</dd></div>
        <div><dt>Database</dt><dd className="path">{generation.dbPath}</dd></div>
        <div><dt>Archive</dt><dd className="path">{generation.archivePath}</dd></div>
      </dl>

      {unverified.length > 0 && (
        <section className="panel">
          <h2>{unverified.length} columns await a live response</h2>
          <p className="muted">
            These fields are declared but have never been seen in a real provider response (02 §16).
            They are shown here rather than presented as settled — a column whose provider meaning is
            unconfirmed is a column whose values cannot yet be trusted, and the generation cannot be
            promoted to production while any remain.
          </p>
          <ul className="unverified">
            {unverified.map((u) => (
              <li key={`${u.table}.${u.column}`}>
                <code>{u.table}.{u.column}</code>
                <span><RichText text={u.note} /></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
