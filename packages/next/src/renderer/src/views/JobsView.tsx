import { useCallback, useEffect, useState } from 'react';
import type {
  JobCardDto, JobRequestDto, JobsDto, ReplayReportDto, ReplayTableDto, ResetPreviewDto, ResetResultDto
} from '../../../shared/types.js';
import type { QueueableKind } from '../../../shared/deeplink.js';
import { When } from './when.js';

/**
 * The Jobs view — 05 §7, B9a/B9b.
 *
 * **It queues; it does not execute.** A Run here writes one request row. The
 * old app executes it, because it holds the provider transports and the E*Trade
 * token — and nothing in the old app picks a request up on its own any more:
 * the claim loop 05 §7 describes was removed after it re-ran one request
 * seventy times. So every queued request says, in words, what has to happen
 * next. A spinner in front of a job that will never start by itself is exactly
 * the lie P9 exists to forbid.
 *
 * Reset is the exception: this app performs it itself (04 §7.6), behind a
 * typed confirmation.
 */

const LIVE_STATES = new Set(['queued', 'claimed', 'running']);
const POLL_MS = 15_000;

export function JobsView({ onGenerationChanged }: { onGenerationChanged: () => void }): JSX.Element {
  const [jobs, setJobs] = useState<JobsDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'refused'; text: string } | null>(null);
  const [arming, setArming] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [replayRun, setReplayRun] = useState('');

  const load = useCallback(async () => {
    const r = await window.api.jobs.overview();
    if (r.ok) { setJobs(r.data); setError(null); } else setError(r.error);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Polls only while something is waiting or running — the two apps share only
  // the database, so reading it is the only way progress arrives (05 §8).
  const live = (jobs?.requests ?? []).some((q) => LIVE_STATES.has(q.state));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  const queue = async (kind: string): Promise<void> => {
    setArming(null);
    let params: { runId?: number } | undefined;
    if (kind === 'replay' && replayRun.trim() !== '') {
      const n = Number(replayRun.trim());
      // Sent as given; the main process checks it names a completed daily run.
      params = { runId: n };
    }
    const r = await window.api.jobs.queue(kind as QueueableKind, params);
    setNotice(
      r.ok
        ? { tone: 'ok', text: `Queued as request ${r.data}. Now run "Collector one-shot jobs" in TradeAnalyzer's Batch view — nothing picks it up on its own.` }
        : { tone: 'refused', text: r.error }
    );
    if (r.ok) setReplayRun('');
    await load();
  };

  const cancel = async (id: number): Promise<void> => {
    const r = await window.api.jobs.cancel(id);
    setNotice(r.ok ? { tone: 'ok', text: `Request ${id} withdrawn.` } : { tone: 'refused', text: r.error });
    await load();
  };

  return (
    <section className="view">
      <h1>Jobs</h1>
      <p className="lede">One-shot jobs for the current generation, and reset.</p>

      <div className="notice notice-info">
        <strong>Queueing is not running.</strong> A queued job waits until you open TradeAnalyzer and
        run <em>Collector one-shot jobs</em> from its Batch view — one request per press, oldest first.
        TradeAnalyzer executes it because it holds the provider connections; nothing claims a
        request automatically.
      </div>

      {notice && (
        <div className={`notice notice-${notice.tone}`}>
          {notice.text}
          <button className="link notice-close" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}
      {error && <div className="notice notice-refused">{error}</div>}

      {jobs && (
        <>
          <div className="job-cards">
            {jobs.cards.map((c) => (
              <Card
                key={c.kind}
                card={c}
                armed={arming === c.kind}
                onArm={() => setArming(c.kind)}
                onDisarm={() => setArming(null)}
                onQueue={() => void queue(c.kind)}
                extra={
                  c.kind === 'replay' ? (
                    <input
                      className="run-input"
                      placeholder="run id (blank = latest daily run)"
                      value={replayRun}
                      onChange={(e) => setReplayRun(e.target.value.replace(/[^0-9]/g, ''))}
                    />
                  ) : null
                }
              />
            ))}
          </div>

          <h2>Requests</h2>
          {jobs.requests.length === 0 ? (
            <p className="empty">Nothing has been queued in this generation.</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th className="num">#</th><th>Job</th><th>State</th><th>Queued</th><th>By</th>
                  <th>Claimed</th><th>Finished</th><th className="num">Run</th><th>Verdict</th><th />
                </tr>
              </thead>
              <tbody>
                {jobs.requests.map((q) => (
                  <RequestRows
                    key={q.id}
                    request={q}
                    stallMinutes={jobs.stallMinutes}
                    expanded={expanded === q.id}
                    onToggle={() => setExpanded(expanded === q.id ? null : q.id)}
                    onCancel={() => void cancel(q.id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <Reset onDone={async () => { onGenerationChanged(); await load(); }} />
    </section>
  );
}

function Card({
  card, armed, onArm, onDisarm, onQueue, extra
}: {
  card: JobCardDto;
  armed: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onQueue: () => void;
  extra: JSX.Element | null;
}): JSX.Element {
  const pending = card.last !== null && LIVE_STATES.has(card.last.state);
  return (
    <div className={`job-card${card.queueable ? '' : ' is-unavailable'}`}>
      <h3>{card.title}</h3>
      <p>{card.what}</p>
      <p className="muted">{card.cost}</p>
      {card.last ? (
        <p>
          Last: request {card.last.id} ·{' '}
          <span className={`state-tag state-${card.last.state}`}>{card.last.state}</span>
          {card.last.replay && <> · <OutcomeTag outcome={card.last.replay.outcome} /></>}
          {!card.last.replay && card.last.gate && <> · <span className={`verdict-${card.last.gate}`}>{card.last.gate}</span></>}
          {' · '}<When iso={card.last.finishedAt ?? card.last.queuedAt} />
        </p>
      ) : (
        <p className="muted">Never queued in this generation.</p>
      )}
      {!card.queueable ? (
        <p className="hint">{card.notYet}</p>
      ) : pending ? (
        <p className="hint">Already {card.last?.state} as request {card.last?.id}.</p>
      ) : armed ? (
        <div className="confirm-row">
          <span>Queue it? {card.cost}</span>
          <button className="btn" onClick={onQueue}>Queue</button>
          <button className="btn" onClick={onDisarm}>Cancel</button>
        </div>
      ) : (
        <div className="confirm-row">
          {extra}
          <button className="btn" onClick={onArm}>Run…</button>
        </div>
      )}
    </div>
  );
}

function RequestRows({
  request: q, stallMinutes, expanded, onToggle, onCancel
}: {
  request: JobRequestDto;
  stallMinutes: number;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <>
      <tr>
        <td className="num">{q.id}</td>
        <td>{q.kind}</td>
        <td>
          <span className={`state-tag state-${q.state}`}>{q.state}</span>
          {q.waitingMinutes !== null && (
            <span className={q.stalled ? 'stalled' : 'muted'}>
              {' '}· waiting {q.waitingMinutes} min
              {q.stalled && ` — over ${stallMinutes}; it needs a Run in TradeAnalyzer's Batch view`}
            </span>
          )}
        </td>
        <td><When iso={q.queuedAt} /></td>
        <td>{q.queuedBy}</td>
        <td>{q.claimedAt ? <><When iso={q.claimedAt} /> <span className="muted">{q.claimedBy}</span></> : <span className="muted">—</span>}</td>
        <td><When iso={q.finishedAt} /></td>
        <td className="num">{q.runId ?? <span className="muted">—</span>}</td>
        <td>
          {q.replay
            ? <OutcomeTag outcome={q.replay.outcome} />
            : <span className={q.gate ? `verdict-${q.gate}` : 'muted'}>{q.gate ?? '—'}</span>}
        </td>
        <td>
          {q.state === 'queued' && <button className="link" onClick={onCancel}>withdraw</button>}
          {(q.result || q.error) && <button className="link" onClick={onToggle}>{expanded ? 'hide' : 'report'}</button>}
        </td>
      </tr>
      {expanded && (
        <tr className="legs-row">
          <td colSpan={10}>
            {q.error && <p className="bad">{q.error}</p>}
            {q.replay ? <ReplayDiff report={q.replay} /> : q.result && <pre className="job-result">{q.result}</pre>}
          </td>
        </tr>
      )}
    </>
  );
}

const OUTCOME_LABEL: Readonly<Record<ReplayReportDto['outcome'], string>> = {
  equal: 'equal',
  equal_on_replayed: 'equal where replayed',
  different: 'different',
  nothing_replayable: 'nothing replayable'
};

function OutcomeTag({ outcome }: { outcome: ReplayReportDto['outcome'] }): JSX.Element {
  const tone = outcome === 'equal' ? 'green' : outcome === 'different' ? 'red' : 'amber';
  return <span className={`verdict-${tone}`}>{OUTCOME_LABEL[outcome]}</span>;
}

/**
 * The diff viewer (05 §7). Coverage first, because an "equal" over half the
 * responses and an "equal" over all of them are different findings — and
 * "nothing replayable" is shown as its own outcome, never as a pass.
 */
function ReplayDiff({ report: r }: { report: ReplayReportDto }): JSX.Element {
  const gaps = r.beforeRecipes + r.unreadable + r.digestMismatch + r.badRecipe;
  return (
    <div className="replay">
      <p>
        <OutcomeTag outcome={r.outcome} /> — run {r.sourceRuns.join(', ')} ({r.tradingDates.join(', ')}):{' '}
        <strong>{r.replayed}</strong> of {r.considered} responses replayed
        {r.noIngest > 0 && <span className="muted">; {r.noIngest} archived for provenance only, with no parser to re-run</span>}.
      </p>
      {gaps > 0 && (
        <ul className="replay-gaps">
          {r.beforeRecipes > 0 && <li>{r.beforeRecipes} captured before recipes were recorded — cannot be replayed without guessing how they were parsed</li>}
          {r.unreadable > 0 && <li className="bad">{r.unreadable} whose archive line could not be read</li>}
          {r.digestMismatch > 0 && <li className="bad">{r.digestMismatch} whose archived body no longer matches its recorded digest</li>}
          {r.badRecipe > 0 && <li className="bad">{r.badRecipe} whose recorded recipe the current code cannot build</li>}
        </ul>
      )}
      {r.derivedNote && <p className="muted">{r.derivedNote}</p>}
      {r.problems.length > 0 && <pre className="job-result">{r.problems.join('\n')}</pre>}
      {r.scratchPath && <p>Scratch database kept as evidence: <span className="path mono">{r.scratchPath}</span></p>}

      {r.tables.length > 0 && (
        <table className="grid">
          <thead>
            <tr>
              <th>Table</th>
              <th className="num">Stored</th><th className="num">Replayed</th><th className="num">Matched</th>
              <th className="num" title="The replay produced it; the generation does not hold it">Added</th>
              <th className="num" title="The generation holds it; the replay did not produce it">Removed</th>
              <th className="num" title="Of those, the same fact with a different value">Changed</th>
            </tr>
          </thead>
          <tbody>
            {r.tables.map((t) => <TableRow key={t.table} t={t} />)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TableRow({ t }: { t: ReplayTableDto }): JSX.Element {
  const [open, setOpen] = useState(false);
  const differs = t.added > 0 || t.removed > 0;
  return (
    <>
      <tr className={differs ? 'clickable' : ''} onClick={() => differs && setOpen(!open)}>
        <td className="mono">{t.table}</td>
        <td className="num">{t.sourceRows}</td>
        <td className="num">{t.replayRows}</td>
        <td className="num">{t.matched}</td>
        <td className={t.added > 0 ? 'num bad' : 'num'}>{t.added}</td>
        <td className={t.removed > 0 ? 'num bad' : 'num'}>{t.removed}</td>
        <td className={t.changed > 0 ? 'num bad' : 'num'}>{t.changed}</td>
      </tr>
      {open && (
        <tr className="legs-row">
          <td colSpan={7}>
            <Samples label="Removed (stored, not reproduced)" rows={t.removedSamples} columns={t.columns} />
            <Samples label="Added (reproduced, not stored)" rows={t.addedSamples} columns={t.columns} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Sample rows, drawn from whatever columns they carry — the renderer names none (AC-13). */
function Samples({
  label, rows, columns
}: {
  label: string;
  rows: readonly Readonly<Record<string, unknown>>[];
  columns: readonly string[];
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="samples">
      <h3>{label}</h3>
      <div className="table-scroll short">
        <table className="data-table nested">
          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => {
                  const v = row[c];
                  return <td key={c}>{v === null || v === undefined ? <span className="muted">null</span> : String(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Reset — AC-14. Typed confirmation, a mandatory reason, and the cost stated
 * before the button is reachable (05 §7).
 */
function Reset({ onDone }: { onDone: () => Promise<void> }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ResetPreviewDto | null>(null);
  const [why, setWhy] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'refused'; text: string } | null>(null);

  const loadPreview = useCallback(async () => {
    const r = await window.api.jobs.resetPreview();
    if (r.ok) setPreview(r.data); else setOutcome({ tone: 'refused', text: r.error });
  }, []);

  useEffect(() => { if (open) void loadPreview(); }, [open, loadPreview]);

  const perform = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.api.jobs.reset(why, typed);
      if (!r.ok) { setOutcome({ tone: 'refused', text: r.error }); return; }
      const d: ResetResultDto = r.data;
      setOutcome({
        tone: 'ok',
        text:
          `Now on gen-${String(d.successorNo).padStart(3, '0')}. gen-${String(d.predecessorNo).padStart(3, '0')} is closed and untouched` +
          `${d.withdrawn > 0 ? `; ${d.withdrawn} request(s) that were waiting there were withdrawn` : ''}. ` +
          `Queued into the new generation: ${d.queued.map((q) => `${q.kind} (#${q.requestId})`).join(', ')} — run them from TradeAnalyzer's Batch view.`
      });
      setWhy('');
      setTyped('');
      await onDone();
      await loadPreview();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reset">
      <h2>Reset the generation</h2>
      <p className="muted">
        Closes the current generation and opens the next one. Nothing is deleted or renamed — the
        closed generation stays on disk exactly as it is. The universe seed and the legacy import are
        queued into the new one automatically; the backfill and IV bootstrap are left for you to queue.
      </p>
      {outcome && <div className={`notice notice-${outcome.tone}`}>{outcome.text}</div>}
      {!open ? (
        <button className="btn btn-danger" onClick={() => setOpen(true)}>Consider a reset…</button>
      ) : !preview ? (
        <p className="muted">Reading what a reset would cost…</p>
      ) : (
        <>
          <dl className="facts">
            <div><dt>Closes</dt><dd>gen-{String(preview.generationNo).padStart(3, '0')} ({preview.status}), opened <When iso={preview.openedAt} /></dd></div>
            <div><dt>Costs</dt><dd><strong>{preview.dataDays}</strong> trading day(s) of collected data start again from zero</dd></div>
            <div><dt>Opens</dt><dd className="path">{preview.successorDir}</dd></div>
            {preview.queuedToWithdraw > 0 && (
              <div><dt>Withdraws</dt><dd>{preview.queuedToWithdraw} queued request(s) nothing would ever claim once the pointer moves</dd></div>
            )}
          </dl>
          {preview.blockers.length > 0 && (
            <>
              <p className="blocker">Refused right now:</p>
              <ul>{preview.blockers.map((b) => <li key={b} className="blocker">{b}</li>)}</ul>
            </>
          )}
          {preview.presumedDead.length > 0 && (
            <>
              <p className="muted">Marked in flight but too old to be — not blocking:</p>
              <ul>{preview.presumedDead.map((b) => <li key={b} className="muted">{b}</li>)}</ul>
            </>
          )}
          <div className="reset-form">
            <textarea rows={2} placeholder="why (required — recorded on the new generation for good)" value={why} onChange={(e) => setWhy(e.target.value)} />
            <input placeholder={`type ${preview.confirmation}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
            <div className="confirm-row">
              <button
                className="btn btn-danger"
                disabled={busy || preview.blockers.length > 0 || !why.trim() || typed.trim() !== preview.confirmation}
                onClick={() => void perform()}
              >
                Reset
              </button>
              <button className="btn" onClick={() => { setOpen(false); setWhy(''); setTyped(''); }}>Close</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
