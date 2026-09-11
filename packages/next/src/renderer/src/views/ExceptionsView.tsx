import { useCallback, useEffect, useState } from 'react';
import type {
  ExceptionDetailDto,
  ExceptionFilterDto,
  ExceptionListDto,
  ExceptionRowDto,
  ExceptionStateFilterDto,
  ResolutionHowDto,
  ZeroFireDto
} from '../../../shared/types.js';
import { When } from './when.js';

/**
 * The Exceptions workbench — 05 §5, B9a.
 *
 * Where 03 §5 happens: every finding the gate has raised, and the four rulings
 * an operator can make on one. **Nothing here decides what is allowed.** Each
 * button is one call to the same `core` function `scripts/exception.mjs` has
 * driven since B5, and a refusal comes back as `core`'s own explanation — so
 * "still firing, accept it instead" is shown as the answer it is, not hidden as
 * an error.
 *
 * Bulk acknowledge exists; bulk resolve and bulk accept deliberately do not.
 * Acknowledging claims nothing, so doing it to forty findings is honest.
 * Resolving or accepting is a claim about ONE finding, and a bulk version
 * would make it a claim about a filter.
 */

type Notice = { readonly tone: 'ok' | 'refused'; readonly text: string } | null;

export interface ExceptionsFocus {
  readonly runId: number | null;
  readonly exceptionId: number | null;
  /** Bumped per deep link, so the same link twice still navigates. */
  readonly nonce: number;
}

const STATE_OPTIONS: readonly { value: ExceptionStateFilterDto; label: string }[] = [
  { value: 'active', label: 'Needs a ruling' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'expired_review', label: 'Acceptance expired' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'all', label: 'All' }
];

const HOW: readonly { value: ResolutionHowDto; label: string }[] = [
  { value: 'data_corrected', label: 'Data corrected' },
  { value: 'provider_fixed', label: 'Provider fixed it' },
  { value: 'rule_changed', label: 'Rule changed' },
  { value: 'false_positive', label: 'False positive — the check is wrong here' }
];

export function ExceptionsView({ focus, readOnly = false }: { focus: ExceptionsFocus; readOnly?: boolean }): JSX.Element {
  const [tab, setTab] = useState<'list' | 'zero'>('list');
  const [filter, setFilter] = useState<ExceptionFilterDto>({ state: 'active' });
  const [list, setList] = useState<ExceptionListDto | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<ExceptionDetailDto | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const [bulkNote, setBulkNote] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [error, setError] = useState<string | null>(null);

  // A deep link navigates and does nothing else (05 §11.1).
  useEffect(() => {
    if (focus.nonce === 0) return;
    setTab('list');
    if (focus.runId !== null) {
      setFilter({ state: 'all', runId: focus.runId });
      setSelected(null);
    }
    if (focus.exceptionId !== null) {
      setFilter({ state: 'all' });
      setSelected(focus.exceptionId);
    }
  }, [focus.nonce, focus.runId, focus.exceptionId]);

  const loadList = useCallback(async () => {
    const r = await window.api.exceptions.list(filter);
    if (r.ok) {
      setList(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [filter]);

  const loadDetail = useCallback(async (id: number) => {
    const r = await window.api.exceptions.detail(id);
    if (r.ok) setDetail(r.data);
    else {
      setDetail(null);
      setNotice({ tone: 'refused', text: r.error });
    }
  }, []);

  useEffect(() => {
    setChecked(new Set());
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selected === null) setDetail(null);
    else void loadDetail(selected);
  }, [selected, loadDetail]);

  /** Every action reports, then everything on screen is re-read from the database — never patched locally. */
  const report = async (outcome: { ok: boolean; text: string }): Promise<void> => {
    setNotice({ tone: outcome.ok ? 'ok' : 'refused', text: outcome.text });
    await loadList();
    if (selected !== null) await loadDetail(selected);
  };

  const bulkAcknowledge = async (): Promise<void> => {
    const r = await window.api.exceptions.bulkAcknowledge([...checked], bulkNote.trim() || null);
    if (!r.ok) return report({ ok: false, text: r.error });
    setChecked(new Set());
    setBulkNote('');
    const skipped = r.data.skipped;
    return report({
      ok: true,
      text:
        `Acknowledged ${r.data.acknowledged.length}.` +
        (skipped.length > 0
          ? ` Skipped ${skipped.length}: ${skipped.map((s) => `#${s.exceptionId} — ${s.why}`).join('; ')}`
          : '')
    });
  };

  const set = (patch: Partial<ExceptionFilterDto>): void => {
    setFilter((f) => ({ ...f, ...patch }));
  };

  const openRows = (list?.rows ?? []).filter((r) => r.state === 'open');

  return (
    <section className="view">
      <h1>Exceptions</h1>
      <p className="lede">
        Every finding the quality gate has raised, and the rulings on each. A finding is a fact about
        the data, not about a run — the same condition tomorrow is the same exception.
      </p>

      <div className="tabs">
        <button className={`tab${tab === 'list' ? ' is-active' : ''}`} onClick={() => setTab('list')}>Findings</button>
        <button className={`tab${tab === 'zero' ? ' is-active' : ''}`} onClick={() => setTab('zero')}>Checks that never fire</button>
      </div>

      {notice && (
        <div className={`notice notice-${notice.tone}`}>
          {notice.text}
          <button className="link notice-close" onClick={() => setNotice(null)}>dismiss</button>
        </div>
      )}
      {error && <div className="notice notice-refused">{error}</div>}

      {tab === 'zero' && <ZeroFire />}

      {tab === 'list' && list && (
        <>
          <div className="counts">
            <span><strong>{list.counts.open}</strong> open</span>
            <span><strong>{list.counts.acknowledged}</strong> acknowledged</span>
            <span className={list.counts.expiredReview > 0 ? 'bad' : ''}>
              <strong>{list.counts.expiredReview}</strong> acceptances expired
            </span>
            <span className={list.counts.blockingActive > 0 ? 'bad' : ''}>
              <strong>{list.counts.blockingActive}</strong> blocking awaiting a ruling
            </span>
          </div>

          <div className="filters">
            <label>
              State
              <select value={filter.state ?? 'active'} onChange={(e) => set({ state: e.target.value as ExceptionStateFilterDto })}>
                {STATE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              Severity
              <select value={filter.severity ?? ''} onChange={(e) => set({ severity: e.target.value || null })}>
                <option value="">any</option>
                <option value="blocking">blocking</option>
                <option value="warning">warning</option>
                <option value="info">info</option>
              </select>
            </label>
            <label>
              Check
              <select value={filter.checkId ?? ''} onChange={(e) => set({ checkId: e.target.value || null })}>
                <option value="">any</option>
                {list.checks.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>
              Domain
              <select value={filter.domain ?? ''} onChange={(e) => set({ domain: e.target.value || null })}>
                <option value="">any</option>
                {list.domains.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            {filter.runId != null && (
              <span className="chip">
                seen on run {filter.runId}{' '}
                <button className="link" onClick={() => set({ runId: null })}>clear</button>
              </span>
            )}
          </div>

          {checked.size > 0 && !readOnly && (
            <div className="bulk">
              <span>{checked.size} selected</span>
              <input placeholder="note (optional)" value={bulkNote} onChange={(e) => setBulkNote(e.target.value)} />
              <button className="btn" onClick={() => void bulkAcknowledge()}>Acknowledge {checked.size}</button>
              <span className="hint">Resolving and accepting are one finding at a time, by design.</span>
            </div>
          )}

          {list.rows.length === 0 ? (
            <p className="empty">Nothing matches. With the default filter that means nothing is waiting for a ruling.</p>
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        title="Select every open finding shown"
                        checked={openRows.length > 0 && openRows.every((r) => checked.has(r.id))}
                        onChange={(e) => setChecked(e.target.checked ? new Set(openRows.map((r) => r.id)) : new Set())}
                      />
                    </th>
                    <th>Severity</th><th>Check</th><th>Domain</th><th>Key</th><th>Detail</th><th>State</th>
                    <th>First seen</th><th>Last seen</th>
                    <th className="num" title="Runs in a row it has fired while open">In a row</th>
                    <th className="num">Days</th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <Row
                      key={r.id}
                      row={r}
                      selected={selected === r.id}
                      checked={checked.has(r.id)}
                      onToggle={(on) =>
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (on) next.add(r.id); else next.delete(r.id);
                          return next;
                        })
                      }
                      onSelect={() => setSelected(selected === r.id ? null : r.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.truncated && <p className="muted">Showing the first 2,000. Narrow the filter to see the rest.</p>}

          {detail && <Detail detail={detail} onReport={report} readOnly={readOnly} />}
        </>
      )}
    </section>
  );
}

function Row({
  row, selected, checked, onToggle, onSelect
}: {
  row: ExceptionRowDto;
  selected: boolean;
  checked: boolean;
  onToggle: (on: boolean) => void;
  onSelect: () => void;
}): JSX.Element {
  return (
    <tr className={`clickable${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <td onClick={(e) => e.stopPropagation()}>
        {row.state === 'open' && (
          <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        )}
      </td>
      <td className={`sev-${row.severity}`}>
        {row.severity}
        {row.escalated && <span className="escalated" title="Escalated by recurring — it did not start at this severity">▲</span>}
      </td>
      <td>{row.checkId}</td>
      <td>{row.domain}</td>
      <td className="mono">{row.key}</td>
      <td title={row.detail}>{row.detail}</td>
      <td>
        {row.state}
        {/* Open but not seen on the last run: "it went away" is exactly how
            the earnings-date bug hid, so it is labelled, never dropped. */}
        {!row.stillSeen && row.state !== 'resolved' && <span className="not-seen"> · not seen last run</span>}
      </td>
      <td><When iso={row.firstSeenAt} /></td>
      <td><When iso={row.lastSeenAt} /></td>
      <td className="num">{row.runsInARow}</td>
      <td className="num">{row.daysAffected}</td>
    </tr>
  );
}

function Detail({
  detail, onReport, readOnly
}: {
  detail: ExceptionDetailDto;
  onReport: (outcome: { ok: boolean; text: string }) => Promise<void>;
  readOnly: boolean;
}): JSX.Element {
  const r = detail.row;
  return (
    <div className="detail panel">
      <h2>
        #{r.id} · {r.checkId} · {r.domain} / <span className="mono">{r.key}</span>
      </h2>
      <p>{r.detail}</p>

      <dl className="facts">
        <div><dt>State</dt><dd>{r.state}{!r.stillSeen && r.state !== 'resolved' ? ' — not seen on the most recent run, still unresolved' : ''}</dd></div>
        <div><dt>Severity</dt><dd className={`sev-${r.severity}`}>{r.severity}{r.escalated ? ' (escalated by recurring)' : ''}</dd></div>
        <div><dt>First seen</dt><dd>run {r.firstSeenRun} · <When iso={r.firstSeenAt} /></dd></div>
        <div><dt>Last seen</dt><dd>run {r.lastSeenRun} · <When iso={r.lastSeenAt} /></dd></div>
        <div><dt>In a row</dt><dd>{r.runsInARow} run(s)</dd></div>
        {detail.acceptedAt && (
          <div><dt>Accepted</dt><dd><When iso={detail.acceptedAt} /> until {r.acceptedUntil} — {detail.acceptedNote}</dd></div>
        )}
        {detail.resolvedAt && (
          <div><dt>Resolved</dt><dd><When iso={detail.resolvedAt} /> as {detail.resolvedHow} — {detail.resolvedNote}</dd></div>
        )}
      </dl>

      <h3>Affected domain-days</h3>
      {detail.affected.length === 0 ? (
        <p className="muted">None recorded.</p>
      ) : (
        <ul className="day-list">
          {detail.affected.map((a) => (
            <li key={a.date}>
              <span className="mono">{a.date}</span>{' '}
              <span className={a.usability === 'unusable' ? 'bad' : 'muted'}>{a.usability ?? 'not computed'}</span>
            </li>
          ))}
        </ul>
      )}

      {!readOnly && <Actions detail={detail} onReport={onReport} />}

      {detail.check && (
        <>
          <h3>The check</h3>
          <p>{detail.check.description}</p>
          <p className="muted">
            Fired {detail.check.firedTotal} time(s) in {detail.check.evaluatedTotal} evaluation(s)
            {detail.check.lastFiredAt ? <>, last <When iso={detail.check.lastFiredAt} /></> : ''}.
          </p>
          <pre>{detail.check.thresholds}</pre>
        </>
      )}

      <h3>Evidence</h3>
      <pre>{detail.evidence}</pre>
      {detail.remediations !== '[]' && detail.remediations !== '' && (
        <>
          <h3>Remediations attempted</h3>
          <pre>{detail.remediations}</pre>
        </>
      )}

      <h3>Trail</h3>
      <table className="grid">
        <thead><tr><th>When</th><th>Who</th><th>From</th><th>To</th><th>Note</th></tr></thead>
        <tbody>
          {detail.events.map((e, i) => (
            <tr key={i}>
              <td><When iso={e.at} /></td>
              <td>{e.actor}</td>
              <td>{e.fromState ?? <span className="muted">created</span>}</td>
              <td>{e.toState}</td>
              <td title={e.note ?? ''}>{e.note ?? <span className="muted">no note</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The rulings. Each form posts exactly what `core` needs and shows what `core`
 * says back; the hints repeat the rules so a refusal is never a surprise, but
 * the refusal itself is `core`'s, not this component's.
 */
function Actions({
  detail, onReport
}: {
  detail: ExceptionDetailDto;
  onReport: (outcome: { ok: boolean; text: string }) => Promise<void>;
}): JSX.Element {
  const r = detail.row;
  const [ackNote, setAckNote] = useState('');
  const [how, setHow] = useState<ResolutionHowDto>('data_corrected');
  const [resolveNote, setResolveNote] = useState('');
  const [acceptNote, setAcceptNote] = useState('');
  const [until, setUntil] = useState('');
  const [reuseTicker, setReuseTicker] = useState(detail.reuseCandidate?.ticker ?? '');
  const [spliceDate, setSpliceDate] = useState(detail.reuseCandidate?.spliceDate ?? '');
  const [reuseNote, setReuseNote] = useState('');
  const [reuseArmed, setReuseArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  // A different exception selected: clear every half-typed form, so a note
  // written about one finding can never be submitted against the next.
  useEffect(() => {
    setAckNote(''); setResolveNote(''); setAcceptNote(''); setUntil('');
    setReuseTicker(detail.reuseCandidate?.ticker ?? '');
    setSpliceDate(detail.reuseCandidate?.spliceDate ?? '');
    setReuseNote(''); setReuseArmed(false);
  }, [r.id, detail.reuseCandidate?.ticker, detail.reuseCandidate?.spliceDate]);

  const run = async (fn: () => Promise<{ ok: boolean; text: string }>): Promise<void> => {
    setBusy(true);
    try {
      await onReport(await fn());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="actions">
      {r.state === 'open' && (
        <div className="action">
          <h3>Acknowledge</h3>
          <p className="hint">Stops the ageing clock. Claims nothing was fixed.</p>
          <input placeholder="note (optional)" value={ackNote} onChange={(e) => setAckNote(e.target.value)} />
          <button className="btn" disabled={busy} onClick={() => void run(async () => {
            const res = await window.api.exceptions.acknowledge(r.id, ackNote.trim() || null);
            return res.ok ? { ok: true, text: `#${r.id} acknowledged.` } : { ok: false, text: res.error };
          })}>Acknowledge</button>
        </div>
      )}

      {r.state !== 'resolved' && (
        <div className="action">
          <h3>Resolve</h3>
          <p className="hint">
            {r.stillSeen
              ? 'Still firing — only "false positive" is accepted while it fires. If the finding is real but tolerable, accept it instead.'
              : 'Say what was done. The note is kept with the finding for good.'}
          </p>
          <select value={how} onChange={(e) => setHow(e.target.value as ResolutionHowDto)}>
            {HOW.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
          </select>
          <textarea rows={2} placeholder="what was done (required)" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} />
          <button className="btn" disabled={busy || !resolveNote.trim()} onClick={() => void run(async () => {
            const res = await window.api.exceptions.resolve(r.id, how, resolveNote);
            return res.ok ? { ok: true, text: `#${r.id} resolved.` } : { ok: false, text: res.error };
          })}>Resolve</button>
        </div>
      )}

      {r.state !== 'accepted' && r.state !== 'resolved' && (
        <div className="action">
          <h3>Accept</h3>
          <p className="hint">
            Tolerates a real finding until a date — 30 days if left blank, at most 180. When it runs out
            the finding comes back for a ruling.
          </p>
          <textarea rows={2} placeholder="why it is tolerable (required)" value={acceptNote} onChange={(e) => setAcceptNote(e.target.value)} />
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} title="Leave blank for 30 days" />
          <button className="btn" disabled={busy || !acceptNote.trim()} onClick={() => void run(async () => {
            const res = await window.api.exceptions.accept(r.id, acceptNote, until || null);
            return res.ok
              ? { ok: true, text: `#${r.id} accepted until ${res.data}. It returns for a ruling after that.` }
              : { ok: false, text: res.error };
          })}>Accept</button>
        </div>
      )}

      {detail.reuseCandidate && r.state !== 'resolved' && (
        <div className="action action-danger">
          <h3>Confirm ticker reuse</h3>
          <p className="hint">
            The symbol now belongs to a different company. Closes its membership the day before the
            splice and opens a new one. Deletes nothing — the earlier bars stay as evidence. Leave the
            date blank to take it from the discontinuity itself.
          </p>
          <input placeholder="ticker" value={reuseTicker} onChange={(e) => { setReuseTicker(e.target.value); setReuseArmed(false); }} />
          <input type="date" value={spliceDate} onChange={(e) => { setSpliceDate(e.target.value); setReuseArmed(false); }} title="First trading date of the NEW company" />
          <textarea rows={2} placeholder="how you know (required)" value={reuseNote} onChange={(e) => setReuseNote(e.target.value)} />
          {!reuseArmed ? (
            <button className="btn btn-danger" disabled={busy || !reuseNote.trim() || !reuseTicker.trim()} onClick={() => setReuseArmed(true)}>
              Record reuse…
            </button>
          ) : (
            <div className="confirm-row">
              <span>
                Split {reuseTicker.trim().toUpperCase()} into two entities
                {spliceDate ? ` at ${spliceDate}` : ' at the observed discontinuity'}?
              </span>
              <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => {
                const res = await window.api.exceptions.recordReuse(r.id, reuseTicker, spliceDate || null, reuseNote);
                setReuseArmed(false);
                return res.ok ? { ok: true, text: res.data } : { ok: false, text: res.error };
              })}>Confirm</button>
              <button className="btn" onClick={() => setReuseArmed(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Checks that have never fired (QC-952, P10). Listed with how much they have
 * looked at — zero fires in ten evaluations and zero in ten thousand are
 * different findings, and only the second says anything about the check.
 */
function ZeroFire(): JSX.Element {
  const [rows, setRows] = useState<readonly ZeroFireDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.exceptions.zeroFire().then((r) => {
      if (r.ok) setRows(r.data); else setError(r.error);
    });
  }, []);

  if (error) return <div className="notice notice-refused">{error}</div>;
  if (!rows) return <p className="muted">Loading…</p>;

  return (
    <>
      <p className="muted">
        A check that never fires is either watching a clean system or incapable of firing, and only
        its distribution can say which. The keep / fix / drop ruling on each is made in Pilot exit,
        beside the threshold review.
      </p>
      {rows.length === 0 ? (
        <p className="empty">Every registered check has fired at least once.</p>
      ) : (
        <table className="grid">
          <thead><tr><th>Check</th><th>Domain</th><th>Severity</th><th className="num">Evaluations</th><th>What it looks for</th></tr></thead>
          <tbody>
            {rows.map((z) => (
              <tr key={z.checkId}>
                <td>{z.checkId}</td>
                <td>{z.domain}</td>
                <td className={`sev-${z.severity}`}>{z.severity}</td>
                <td className={z.evaluatedTotal === 0 ? 'num bad' : 'num'}>{z.evaluatedTotal}</td>
                <td title={z.description}>{z.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
