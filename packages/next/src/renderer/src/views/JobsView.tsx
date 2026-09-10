import { useCallback, useEffect, useState } from 'react';
import type { JobCardDto, JobRequestDto, JobsDto, ResetPreviewDto, ResetResultDto } from '../../../shared/types.js';
import type { QueueableKind } from '../../../shared/deeplink.js';
import { When } from './when.js';

/**
 * The Jobs view — 05 §7, B9a.
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
    const r = await window.api.jobs.queue(kind as QueueableKind);
    setNotice(
      r.ok
        ? { tone: 'ok', text: `Queued as request ${r.data}. Now run "Collector one-shot jobs" in TradeAnalyzer's Batch view — nothing picks it up on its own.` }
        : { tone: 'refused', text: r.error }
    );
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
  card, armed, onArm, onDisarm, onQueue
}: {
  card: JobCardDto;
  armed: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onQueue: () => void;
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
          {card.last.gate && <> · <span className={`verdict-${card.last.gate}`}>{card.last.gate}</span></>}
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
        <button className="btn" onClick={onArm}>Run…</button>
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
        <td className={q.gate ? `verdict-${q.gate}` : 'muted'}>{q.gate ?? '—'}</td>
        <td>
          {q.state === 'queued' && <button className="link" onClick={onCancel}>withdraw</button>}
          {(q.result || q.error) && <button className="link" onClick={onToggle}>{expanded ? 'hide' : 'report'}</button>}
        </td>
      </tr>
      {expanded && (
        <tr className="legs-row">
          <td colSpan={10}>
            {q.error && <p className="bad">{q.error}</p>}
            {q.result && <pre className="job-result">{q.result}</pre>}
          </td>
        </tr>
      )}
    </>
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
