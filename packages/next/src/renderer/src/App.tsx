import { useCallback, useEffect, useState } from 'react';
import type { GenerationInfoDto, GenerationListItemDto, PilotStatusDto, TreeGroup } from '../../shared/types.js';
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
import { PilotView } from './views/PilotView.js';
import { RichText } from './views/RichText.js';
import { When } from './views/when.js';

/**
 * The shell, in 05 §2's order as far as it is built.
 *
 * The remaining sections — Bars, Universe, Archive, Settings — arrive with the
 * build steps that fill them. None is stubbed here: an empty section in a
 * sidebar reads as a broken feature, not as a future one.
 *
 * The same shell runs a **read-only window onto a closed generation** (05 §8,
 * B9c): the main process answers it from that generation's file, and it says
 * so in its frame, its banner and its title. Jobs is absent there — nothing a
 * job does belongs to a closed generation — and every write the other views
 * offer is hidden, with the main process refusing them regardless.
 */

type Section =
  | 'overview' | 'exceptions' | 'runs' | 'data' | 'chains' | 'account' | 'earnings' | 'iv'
  | 'legacy' | 'dictionary' | 'pilot' | 'jobs';

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
  { id: 'pilot', label: 'Pilot exit', hint: 'The clean-day streak, the rulings, and promotion to production' },
  { id: 'jobs', label: 'Jobs', hint: 'Queue one-shot jobs, and reset the generation' }
];

const pad = (n: number): string => String(n).padStart(3, '0');

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

  const readOnly = generation?.readOnly === true;
  const sections = readOnly ? SECTIONS.filter((s) => s.id !== 'jobs') : SECTIONS;
  const tableCount = tree.reduce((n, g) => n + g.domains.reduce((m, d) => m + d.tables.length, 0), 0);

  return (
    <div className={`app${readOnly ? ' is-readonly' : ''}`}>
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-name">TradeAnalyzer 2</span>
          <span className="brand-sub">
            {generation
              ? `gen-${pad(generation.generationNo)} · ${generation.status}${readOnly ? ' · read-only' : ''}`
              : 'opening…'}
          </span>
        </div>
        {sections.map((s) => (
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
        {readOnly && generation && (
          <div className="readonly-banner">
            <strong>gen-{pad(generation.generationNo)} — {generation.status}, opened read-only.</strong>{' '}
            Nothing in this window can change it. It keeps the schema it was built with
            (dictionary v{generation.dictionaryVersion}), so a table added since reads as absent.
          </div>
        )}
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
        {!error && section === 'exceptions' && <ExceptionsView focus={exceptionsFocus} readOnly={readOnly} />}
        {!error && section === 'runs' && (
          <RunsView
            focus={runsFocus}
            onOpenExceptions={(runId) => navigate({ section: 'exceptions', runId })}
          />
        )}
        {!error && section === 'data' && <DataView tree={tree} initialTable={dataTable} readOnly={readOnly} />}
        {!error && section === 'chains' && <ChainsView readOnly={readOnly} />}
        {!error && section === 'account' && <AccountView />}
        {!error && section === 'earnings' && <EarningsView />}
        {!error && section === 'iv' && <IvView />}
        {!error && section === 'legacy' && <LegacyView />}
        {!error && section === 'dictionary' && <DictionaryView tree={tree} />}
        {!error && section === 'pilot' && <PilotView readOnly={readOnly} />}
        {!error && section === 'jobs' && !readOnly && <JobsView onGenerationChanged={() => void loadGeneration()} />}
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
  const [pilot, setPilot] = useState<PilotStatusDto | null>(null);

  useEffect(() => {
    void window.api.dictionary.unverified().then((r) => { if (r.ok) setUnverified(r.data); });
    void window.api.pilot.status().then((r) => { if (r.ok) setPilot(r.data); });
  }, []);

  if (!generation) return <p className="muted">Opening the generation…</p>;

  return (
    <>
      <h1>Overview</h1>
      <p className="lede">
        Stage 1, build step B10 — the pilot. The collector runs every phase; findings are ruled on in
        Exceptions, runs are read in Runs, questions are asked and saved in Data, one-shot jobs are
        queued from Jobs, and the pilot is reviewed and promoted in Pilot exit.
      </p>

      <dl className="facts">
        <div><dt>Generation</dt><dd>gen-{pad(generation.generationNo)} — {generation.status}</dd></div>
        {pilot && generation.status === 'pilot' && (
          <div>
            <dt>Pilot streak</dt>
            <dd>
              {pilot.streak} of {pilot.streakTarget} clean trading days
              {pilot.lastEvaluatedDate ? ` (through ${pilot.lastEvaluatedDate})` : ' — nothing evaluated yet'}
              {' · '}{pilot.conditions.filter((c) => c.met).length} of {pilot.conditions.length} exit conditions met
            </dd>
          </div>
        )}
        {generation.predecessorNo !== null && (
          <div>
            <dt>Replaced</dt>
            <dd>
              gen-{pad(generation.predecessorNo)} (closed, still on disk)
              {generation.resetReason ? ` — ${generation.resetReason}` : ''}
            </dd>
          </div>
        )}
        <div><dt>Opened</dt><dd title={generation.openedAt}>{generation.openedAt.slice(0, 16).replace('T', ' ')}</dd></div>
        <div><dt>Dictionary</dt><dd>v{generation.dictionaryVersion} — {tableCount} tables</dd></div>
        <div><dt>Database</dt><dd className="path">{generation.dbPath}</dd></div>
        <div><dt>Archive</dt><dd className="path">{generation.archivePath}</dd></div>
      </dl>

      {!generation.readOnly && <Generations />}

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

/**
 * Every generation on disk (05 §8, AC-14). A reset leaves the previous
 * generation intact; this is where it can be found and opened, read-only, in a
 * window that cannot change it.
 */
function Generations() {
  const [list, setList] = useState<readonly GenerationListItemDto[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.api.generation.list().then((r) => {
      if (r.ok) setList(r.data); else setMessage(r.error);
    });
  }, []);

  if (message) return <div className="notice notice-refused">{message}</div>;
  if (!list || list.length <= 1) return null;

  const open = async (no: number): Promise<void> => {
    const r = await window.api.generation.openReadOnly(no);
    setMessage(r.ok ? null : r.error);
  };

  return (
    <section className="panel">
      <h2>Generations</h2>
      <table className="grid">
        <thead>
          <tr><th>Generation</th><th>Status</th><th>Opened</th><th>Closed</th><th>Why it was replaced</th><th /></tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <tr key={g.generationNo}>
              <td className="mono">gen-{pad(g.generationNo)}{g.current ? ' (this one)' : ''}</td>
              <td>{g.status ?? <span className="muted">{g.dbPresent ? 'unreadable' : 'no database'}</span>}</td>
              <td><When iso={g.openedAt} /></td>
              <td><When iso={g.closedAt} /></td>
              <td title={g.problem ?? g.resetReason ?? ''}>
                {g.problem ? <span className="bad">{g.problem}</span> : (g.resetReason ?? <span className="muted">—</span>)}
                {g.walPresent && !g.current && <span className="muted"> · has a write-ahead log (not closed cleanly)</span>}
              </td>
              <td>
                {!g.current && g.dbPresent && !g.problem && (
                  <button className="link" onClick={() => void open(g.generationNo)}>open read-only</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
