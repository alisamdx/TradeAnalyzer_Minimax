import { useEffect, useState } from 'react';
import type { GenerationInfoDto, TreeGroup } from '../../shared/types.js';
import { DataView } from './views/DataView.js';
import { DictionaryView } from './views/DictionaryView.js';
import { ChainsView } from './views/ChainsView.js';
import { AccountView } from './views/AccountView.js';
import { EarningsView } from './views/EarningsView.js';
import { RichText } from './views/RichText.js';

/**
 * The shell: Overview, Data, Chains, Account, Earnings and Dictionary.
 *
 * The remaining sections of 05 §2 — Exceptions, Runs, Bars, Universe, IV,
 * Archive, Legacy, Jobs, Settings — arrive with the build steps that fill their
 * tables. None is stubbed here: an empty section in a sidebar reads as a broken
 * feature, not as a future one.
 */

type Section = 'overview' | 'data' | 'chains' | 'account' | 'earnings' | 'dictionary';

const SECTIONS: readonly { id: Section; label: string; hint: string }[] = [
  { id: 'overview', label: 'Overview', hint: 'Generation and schema at a glance' },
  { id: 'data', label: 'Data', hint: 'Every table, rendered from the dictionary' },
  { id: 'chains', label: 'Chains', hint: 'Option chains by ticker, date and expiration' },
  { id: 'account', label: 'Account', hint: 'Positions, executed orders and balances' },
  { id: 'earnings', label: 'Earnings', hint: 'Report dates, and every observation of them' },
  { id: 'dictionary', label: 'Dictionary', hint: 'Every column, and what a null in it means' }
];

export function App() {
  const [section, setSection] = useState<Section>('overview');
  const [generation, setGeneration] = useState<GenerationInfoDto | null>(null);
  const [tree, setTree] = useState<readonly TreeGroup[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const g = await window.api.generation.current();
      if (!g.ok) { setError(g.error); return; }
      setGeneration(g.data);
      const t = await window.api.dictionary.tree();
      if (!t.ok) { setError(t.error); return; }
      setTree(t.data);
    })();
  }, []);

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
        {!error && section === 'overview' && <Overview generation={generation} tableCount={tableCount} />}
        {!error && section === 'data' && <DataView tree={tree} />}
        {!error && section === 'chains' && <ChainsView />}
        {!error && section === 'account' && <AccountView />}
        {!error && section === 'earnings' && <EarningsView />}
        {!error && section === 'dictionary' && <DictionaryView tree={tree} />}
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
        Stage 1, build step B6. The collector runs phases 0 through 7 — universe, bars, quotes,
        corporate actions, the account, the chain subset and the chains themselves.
      </p>

      <dl className="facts">
        <div><dt>Generation</dt><dd>gen-{String(generation.generationNo).padStart(3, '0')} — {generation.status}</dd></div>
        <div><dt>Opened</dt><dd>{new Date(generation.openedAt).toLocaleString()}</dd></div>
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
