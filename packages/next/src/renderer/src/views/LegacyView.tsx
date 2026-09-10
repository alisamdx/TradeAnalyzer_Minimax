import { useEffect, useState } from 'react';
import type { LegacyRunDto, LegacyCandidateDto, LegacySummaryDto } from '../../../shared/types.js';

/**
 * The Legacy view — the existing application's decisions, B8.
 *
 * **The screen's job is to keep two samples apart.** Rows handed over live
 * carry every candidate the brief scored; rows imported backwards are
 * survivors-only, because the old app stored only what it picked. Both are
 * useful and they answer different questions — pooling them silently would put
 * a biased sample and an unbiased one in the same chart, so the split is the
 * first thing shown rather than a column somebody notices later.
 *
 * The run list leads with **rejected**, not with survivors, for the same
 * reason: how many a run turned down is the question this data exists to
 * answer, and a zero there means the run cannot answer it.
 */

export function LegacyView(): JSX.Element {
  const [summary, setSummary] = useState<LegacySummaryDto | null>(null);
  const [runs, setRuns] = useState<readonly LegacyRunDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<readonly LegacyCandidateDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.legacy.summary().then((r) => {
      if (r.ok) setSummary(r.data); else setError(r.error);
    });
    void window.api.legacy.runs().then((r) => {
      if (r.ok) setRuns(r.data); else setError(r.error);
    });
  }, []);

  useEffect(() => {
    if (selected === null) { setCandidates([]); return; }
    void window.api.legacy.candidates(selected).then((r) => {
      if (r.ok) setCandidates(r.data); else setError(r.error);
    });
  }, [selected]);

  if (error !== null) return <p className="error">{error}</p>;

  return (
    <section className="view">
      <h1>Legacy decisions</h1>
      <p className="lede">
        What the existing application decided, and — where the record allows it — what it turned
        down.
      </p>

      {summary && <Split summary={summary} />}

      {runs.length === 0 ? (
        <p className="empty">
          Nothing yet. Runs appear here as the existing app hands them over, and the one-time
          import brings in the older history.
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Date</th><th>Slot</th><th>Source</th>
              <th className="num">Considered</th>
              <th className="num">Rejected</th>
              <th className="num">Picked</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={selected === r.id ? 'is-selected' : ''}>
                <td>{r.date}</td>
                <td>{r.phase}</td>
                <td>{r.imported ? <span className="warn-tag">imported</span> : 'handed over'}</td>
                <td className="num">{r.candidates}</td>
                <td className="num">
                  {/* A zero here on an imported run is not "it rejected nothing":
                      it is the old app never having stored what it rejected. */}
                  {r.rejected === 0 && r.imported ? <span className="muted">not recorded</span> : r.rejected}
                </td>
                <td className="num">{r.survivors}</td>
                <td>
                  <button className="link" onClick={() => setSelected(r.id === selected ? null : r.id)}>
                    {r.id === selected ? 'hide' : 'candidates'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected !== null && <Candidates rows={candidates} />}
    </section>
  );
}

/**
 * The two samples, side by side, with the number that decides what can be
 * asked of each.
 */
function Split({ summary }: { summary: LegacySummaryDto }): JSX.Element {
  const rows: { label: string; hint: string; c: LegacySummaryDto['live'] }[] = [
    {
      label: 'Handed over live',
      hint: 'every candidate the brief scored, both daily slots',
      c: summary.live
    },
    {
      label: 'Imported backwards',
      hint: 'survivors only — the old app did not store what it rejected',
      c: summary.imported
    }
  ];

  return (
    <div className="panel">
      <table className="grid">
        <thead>
          <tr>
            <th>Source</th>
            <th className="num">Runs</th>
            <th className="num">Candidates</th>
            <th className="num">Rejected</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}<span className="hint-inline">{r.hint}</span></td>
              <td className="num">{r.c.runs}</td>
              <td className="num">{r.c.candidates}</td>
              <td className={r.c.losers === 0 ? 'num bad' : 'num'}>{r.c.losers}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="method">
        A source with no rejected candidates cannot say whether its ranking was any good — the
        ones it turned down are the comparison.
      </p>
    </div>
  );
}

function Candidates({ rows }: { rows: readonly LegacyCandidateDto[] }): JSX.Element {
  if (rows.length === 0) return <p className="empty">No candidates recorded for this run.</p>;

  return (
    <table className="grid">
      <thead>
        <tr>
          <th className="num">Rank</th>
          <th>Ticker</th><th>Mode</th>
          <th className="num">Score</th>
          <th>Outcome</th>
          <th>Why not</th>
        </tr>
      </thead>
      <tbody>
        {/* Ordered by the rank it was considered at, so the cut shows as a
            position in the list rather than as a flag to filter on. */}
        {rows.map((c) => (
          <tr key={c.rowId} className={c.picked ? '' : 'is-rejected'}>
            <td className="num">{c.rank}</td>
            <td>{c.ticker}</td>
            <td>{c.strategy}</td>
            <td className="num">
              {c.score === null ? <span className="muted">{c.scoreStatus}</span> : c.score.toFixed(1)}
            </td>
            <td>{c.picked ? 'picked' : 'rejected'}</td>
            <td>
              {c.firstFailure ?? (c.disposition ?? '')}
              {c.gatesFailed > 1 && <span className="muted"> +{c.gatesFailed - 1} more</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
