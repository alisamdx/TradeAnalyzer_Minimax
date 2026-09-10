import { useEffect, useState } from 'react';
import type { RunDetailDto, RunRowDto } from '../../../shared/types.js';
import { When, bytesLabel } from './when.js';

/**
 * The Runs view — 05 §2, B9a.
 *
 * Every collector run and one-shot job: what it called, how those calls went,
 * and what the gate made of the result.
 *
 * The verdict column is **the verdict when the run finished**, and it is never
 * rewritten. A run that went red and whose findings were later resolved still
 * reads red here, which is correct — whether its data may be used NOW is a
 * per-domain-day question the Exceptions view answers.
 */

export interface RunsFocus {
  readonly runId: number | null;
  readonly nonce: number;
}

export function RunsView({
  focus, onOpenExceptions
}: {
  focus: RunsFocus;
  onOpenExceptions: (runId: number) => void;
}): JSX.Element {
  const [runs, setRuns] = useState<readonly RunRowDto[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<RunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.api.runs.list().then((r) => {
      if (r.ok) setRuns(r.data); else setError(r.error);
    });
  }, []);

  useEffect(() => {
    if (focus.nonce > 0 && focus.runId !== null) setSelected(focus.runId);
  }, [focus.nonce, focus.runId]);

  useEffect(() => {
    if (selected === null) { setDetail(null); return; }
    void window.api.runs.detail(selected).then((r) => {
      if (r.ok) { setDetail(r.data); setError(null); } else { setDetail(null); setError(r.error); }
    });
  }, [selected]);

  return (
    <section className="view">
      <h1>Runs</h1>
      <p className="lede">
        Every collector run and one-shot job. The verdict is the gate&apos;s at the moment the run
        finished and is never rewritten — whether the data is usable now is a per-day question.
      </p>
      {error && <div className="notice notice-refused">{error}</div>}

      {runs === null ? (
        <p className="muted">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="empty">No runs yet. The collector writes one per trading day, and one per one-shot job.</p>
      ) : (
        <div className="table-scroll short">
          <table className="grid">
            <thead>
              <tr>
                <th className="num">Run</th><th>Kind</th><th>Trading day</th><th>Started</th><th>Finished</th>
                <th>Outcome</th><th>Verdict</th>
                <th className="num">Calls</th><th className="num">Parse failures</th><th className="num">Bytes</th>
                <th>Host</th><th>Core</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} className={`clickable${selected === r.runId ? ' is-selected' : ''}`}
                    onClick={() => setSelected(selected === r.runId ? null : r.runId)}>
                  <td className="num">{r.runId}</td>
                  <td>{r.kind}</td>
                  <td className="mono">{r.date}</td>
                  <td><When iso={r.startedAt} /></td>
                  <td><When iso={r.finishedAt} /></td>
                  <td className={`state-tag state-${r.outcome}`}>{r.outcome}</td>
                  <td className={r.gate ? `verdict-${r.gate}` : 'muted'}>{r.gate ?? 'not evaluated'}</td>
                  <td className="num">{r.responses}</td>
                  <td className={r.failedParses > 0 ? 'num bad' : 'num'}>{r.failedParses}</td>
                  <td className="num">{bytesLabel(r.bytes)}</td>
                  <td>{r.host}</td>
                  <td>{r.collector}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && <Detail detail={detail} onOpenExceptions={onOpenExceptions} />}
    </section>
  );
}

function Detail({
  detail, onOpenExceptions
}: {
  detail: RunDetailDto;
  onOpenExceptions: (runId: number) => void;
}): JSX.Element {
  const r = detail.run;
  return (
    <div className="detail panel">
      <h2>Run {r.runId} · {r.kind} · {r.date}</h2>
      <dl className="facts">
        <div><dt>Outcome</dt><dd className={`state-${r.outcome}`}>{r.outcome}</dd></div>
        <div><dt>Verdict at finish</dt><dd className={r.gate ? `verdict-${r.gate}` : 'muted'}>{r.gate ?? 'not evaluated'}</dd></div>
        <div><dt>Started</dt><dd><When iso={r.startedAt} /></dd></div>
        <div><dt>Finished</dt><dd><When iso={r.finishedAt} /></dd></div>
        <div><dt>Hosted by</dt><dd>{r.host} · core {r.collector}</dd></div>
        {detail.requestId !== null && <div><dt>Started by</dt><dd>Jobs request {detail.requestId}</dd></div>}
        <div>
          <dt>Findings</dt>
          <dd>
            {detail.exceptionsRaised} raised, {detail.exceptionsSeen} seen on this run{' '}
            {detail.exceptionsSeen > 0 && (
              <button className="link" onClick={() => onOpenExceptions(r.runId)}>open them</button>
            )}
          </dd>
        </div>
      </dl>

      {detail.report && (
        <>
          <h3>Quality report</h3>
          <p>
            <span className={`verdict-${detail.report.gate}`}>{detail.report.gate}</span>
            {' · email '}
            <span className={detail.report.emailStatus === 'failed' ? 'bad' : ''}>{detail.report.emailStatus}</span>
            {detail.report.emailSentAt && <> at <When iso={detail.report.emailSentAt} /></>}
            {detail.report.emailError && <span className="bad"> — {detail.report.emailError}</span>}
          </p>
          {detail.report.domains.length > 0 && (
            <table className="grid">
              <thead><tr><th>Domain</th><th className="num">Expected</th><th className="num">Stored</th><th>Status</th></tr></thead>
              <tbody>
                {detail.report.domains.map((d) => (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td className="num">{d.expected ?? <span className="muted">—</span>}</td>
                    <td className={d.expected !== null && d.stored !== null && d.stored < d.expected ? 'num bad' : 'num'}>
                      {d.stored ?? <span className="muted">—</span>}
                    </td>
                    <td>{d.usability ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <h3>Calls</h3>
      {detail.calls.length === 0 ? (
        <p className="muted">This run made no provider calls.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Provider</th><th>Call</th><th className="num">Count</th><th className="num">Not 2xx</th>
              <th className="num">Parse failures</th><th className="num" title="Responses the size of a known provider cap — evidence of truncation">At cap</th>
              <th className="num">Bytes</th>
            </tr>
          </thead>
          <tbody>
            {detail.calls.map((c) => (
              <tr key={`${c.provider}/${c.call}`}>
                <td>{c.provider}</td>
                <td className="mono">{c.call}</td>
                <td className="num">{c.count}</td>
                <td className={c.notOk > 0 ? 'num bad' : 'num'}>{c.notOk}</td>
                <td className={c.failedParses > 0 ? 'num bad' : 'num'}>{c.failedParses}</td>
                <td className={c.atCap > 0 ? 'num bad' : 'num'}>{c.atCap}</td>
                <td className="num">{bytesLabel(c.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Checks</h3>
      {detail.checks.length === 0 ? (
        <p className="muted">No checks recorded for this run.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr><th>Check</th><th className="num">Evaluated</th><th className="num">Fired</th><th className="num">ms</th><th>Distribution of the tested quantity</th></tr>
          </thead>
          <tbody>
            {detail.checks.map((c) => (
              <tr key={c.checkId}>
                <td>{c.checkId}</td>
                {/* Zero evaluations is not a pass: the check had nothing to look at. */}
                <td className={c.evaluated === 0 ? 'num bad' : 'num'}>{c.evaluated}</td>
                <td className={c.fired > 0 ? 'num bad' : 'num'}>{c.fired}</td>
                <td className="num">{c.durationMs}</td>
                <td className="mono" title={c.distribution ?? 'a predicate check — no magnitude to distribute'}>
                  {c.distribution ?? <span className="muted">predicate</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
