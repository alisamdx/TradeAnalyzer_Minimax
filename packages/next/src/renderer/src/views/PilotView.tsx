import { useCallback, useEffect, useState } from 'react';
import type {
  PilotBoundsDto, PilotConditionDto, PilotListDto, PilotNeverFiredDto, PilotRulingDto, PilotStatusDto, PilotThresholdDto
} from '../../../shared/types.js';
import { When } from './when.js';

/**
 * Pilot exit — 03 §8, 05 §6, B10a.
 *
 * The gate can count clean days on its own; it cannot say whether a check that
 * never fired is watching a clean system or incapable of firing, whether a
 * working threshold sits anywhere near the data, or whether a domain looks
 * right to a person. Those three are rulings, and this is where they are made.
 *
 * Nothing here decides anything. Every refusal — a ruling that does not fit the
 * check, a promotion with a condition unmet, a mistyped confirmation — comes
 * from `core`, and the view shows the reason it gives.
 */

const CONDITION_LABEL: Readonly<Record<PilotConditionDto['key'], string>> = {
  'status': 'Generation is in pilot',
  'streak': 'Clean-day streak',
  'zero_fire': 'Never-fired checks ruled on',
  'thresholds': 'Working thresholds ruled on',
  'inspections': 'Every domain inspected by a person',
  'expired_review': 'No expired acceptance awaiting a ruling',
  'verify_notes': 'Every column observed in a live response',
  'replay': 'A replay passed recently, and none differs'
};

const NEVER_FIRED_CHOICES = [
  { id: 'keep', label: 'keep — plausibly rare' },
  { id: 'fix', label: 'fix — cannot fire as written' },
  { id: 'drop', label: 'drop' }
] as const;

const THRESHOLD_CHOICES = [
  { id: 'confirm', label: 'confirm' },
  { id: 'move', label: 'move to…' },
  { id: 'unmeasurable', label: 'unmeasurable on this sample' }
] as const;

const fmt = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : Math.abs(v) >= 1000 ? v.toLocaleString() : String(Number(v.toPrecision(4)));

const bounds = (b: PilotBoundsDto | null): string =>
  b === null ? '—' : b.lo === b.hi ? fmt(b.lo) : `${fmt(b.lo)} – ${fmt(b.hi)}`;

export function PilotView({ readOnly }: { readOnly: boolean }): JSX.Element {
  const [status, setStatus] = useState<PilotStatusDto | null>(null);
  const [neverFired, setNeverFired] = useState<readonly PilotNeverFiredDto[]>([]);
  const [thresholds, setThresholds] = useState<readonly PilotThresholdDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, z, t] = await Promise.all([
      window.api.pilot.status(), window.api.pilot.neverFired(), window.api.pilot.thresholds()
    ]);
    if (!s.ok) { setError(s.error); return; }
    setError(null);
    setStatus(s.data);
    if (z.ok) setNeverFired(z.data); else setError(z.error);
    if (t.ok) setThresholds(t.data); else setError(t.error);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="notice notice-refused">{error}</div>;
  if (!status) return <p className="muted">Reading the pilot…</p>;

  const promoted = status.generationStatus === 'production';
  const working = thresholds.filter((t) => t.needsRuling);

  return (
    <>
      <h1>Pilot exit</h1>
      <p className="lede">
        The pilot becomes production after {status.streakTarget} consecutive clean trading days, once a
        person has ruled on what the gate cannot judge for itself (03 §8).
      </p>

      {promoted && (
        <div className="notice notice-ok">
          Promoted to production <When iso={status.promotedAt} />. The checklist it was promoted on is stored with the generation.
        </div>
      )}

      <section className="panel">
        <h2>Checklist</h2>
        <ul className="checklist">
          {status.conditions.map((c) => (
            <li key={c.key} className={c.met ? 'is-met' : 'is-unmet'}>
              <span className="mark">{c.met ? '✓' : '✗'}</span>
              <span className="label">{CONDITION_LABEL[c.key]}</span>
              <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
        {!promoted && !readOnly && <Promote status={status} onDone={load} />}
      </section>

      <Inspections status={status} readOnly={readOnly || promoted} onDone={load} />

      <section className="panel">
        <h2>Checks that never fired ({neverFired.filter((z) => z.ruling).length} of {neverFired.length} ruled)</h2>
        <p className="muted">
          Zero fires in ten evaluations and zero in ten thousand are different findings. Rule each one:
          keep it (the event is plausibly rare), fix it (the condition cannot be true as written), or drop it.
          A ruling covers the version shown; a fixed check comes back as a new version to rule on again.
        </p>
        {neverFired.length === 0 ? (
          <p className="empty">Every check in force has fired at least once.</p>
        ) : (
          <div className="table-scroll short">
            <table className="grid">
              <thead>
                <tr><th>Check</th><th>Domain</th><th>Severity</th><th className="num">Evaluations</th><th>What it looks for</th><th>Ruling</th></tr>
              </thead>
              <tbody>
                {neverFired.map((z) => (
                  <tr key={z.checkId}>
                    <td className="mono">{z.checkId} <span className="muted">v{z.version}</span></td>
                    <td>{z.domain}</td>
                    <td className={`sev-${z.severity}`}>{z.severity}</td>
                    <td className={z.evaluatedTotal === 0 ? 'num bad' : 'num'}>{z.evaluatedTotal.toLocaleString()}</td>
                    <td className="wrap">{z.description}</td>
                    <td>
                      <RulingCell
                        ruling={z.ruling}
                        list="neverFired"
                        checkId={z.checkId}
                        choices={NEVER_FIRED_CHOICES}
                        readOnly={readOnly || promoted}
                        onDone={load}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Thresholds against the pilot data ({working.filter((t) => t.ruling).length} of {working.length} working thresholds ruled)</h2>
        <p className="muted">
          Pooled over every run under the version in force. Each run keeps a summary, not every value,
          so a pooled percentile is shown as the range it must lie in — exact bounds, not an estimate.
          <strong> Decorative</strong>: p99 under half the threshold, so nothing came near it.
          <strong> Bulk against</strong>: p50 within ±25 % of it, so it fires on ordinary data.
          Only working (†) thresholds need a ruling; a move is applied by a code change, which opens a new version.
        </p>
        {thresholds.length === 0 ? (
          <p className="empty">No check in force measures a magnitude yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Check</th><th>Measures</th><th className="num">Threshold</th><th className="num">Runs</th>
                  <th className="num">n</th><th className="num">p50</th><th className="num">p99</th><th className="num">max</th>
                  <th className="num">Near</th><th>Decorative</th><th>Bulk against</th><th>Ruling</th>
                </tr>
              </thead>
              <tbody>
                {thresholds.map((t) => (
                  <tr key={t.checkId}>
                    <td className="mono">{t.checkId} <span className="muted">v{t.version}</span></td>
                    <td>{t.quantity}{t.unit ? <span className="muted"> ({t.unit})</span> : null}</td>
                    <td className="num">{fmt(t.limit)} <span className="muted">{t.basis}</span></td>
                    <td className={t.runs === 0 ? 'num bad' : 'num'}>{t.runs}</td>
                    <td className="num">{t.n.toLocaleString()}</td>
                    <td className="num">{bounds(t.p50)}</td>
                    <td className="num">{bounds(t.p99)}</td>
                    <td className="num" title={t.extremes.slice(0, 5).map((e) => `${e.key} = ${fmt(e.value)} (run ${e.runId})`).join('\n')}>
                      {fmt(t.max)}
                    </td>
                    <td className="num">{t.nearBoundary.toLocaleString()}</td>
                    <td className={t.decorative === 'yes' ? 'bad' : ''}>{t.decorative ?? '—'}</td>
                    <td className={t.bulkAgainst === 'yes' ? 'bad' : ''}>{t.bulkAgainst ?? '—'}</td>
                    <td>
                      {t.needsRuling ? (
                        <RulingCell
                          ruling={t.ruling}
                          list="threshold"
                          checkId={t.checkId}
                          choices={THRESHOLD_CHOICES}
                          readOnly={readOnly || promoted}
                          onDone={load}
                        />
                      ) : (
                        <span className="muted">not needed ({t.basis})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function RulingCell({
  ruling, list, checkId, choices, readOnly, onDone
}: {
  ruling: PilotRulingDto | null;
  list: PilotListDto;
  checkId: string;
  choices: readonly { readonly id: string; readonly label: string }[];
  readOnly: boolean;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');
  const [note, setNote] = useState('');
  const [proposed, setProposed] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const value = choice === 'move' ? Number(proposed) : null;
    const r = await window.api.pilot.rule(list, checkId, choice, note, value);
    if (!r.ok) { setRefusal(r.error); return; }
    setOpen(false); setChoice(''); setNote(''); setProposed(''); setRefusal(null);
    await onDone();
  };

  return (
    <div className="ruling">
      {ruling ? (
        <span title={`${ruling.note}\n— ${ruling.by}, ${ruling.at}`}>
          <strong>{ruling.choice}</strong>
          {ruling.proposed !== null ? ` → ${fmt(ruling.proposed)}` : ''}
          <span className="muted"> · {ruling.note}</span>
        </span>
      ) : (
        <span className="muted">unruled</span>
      )}
      {!readOnly && !open && (
        <button className="link" onClick={() => setOpen(true)}>{ruling ? 'rule again' : 'rule'}</button>
      )}
      {open && (
        <div className="rule-form">
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">choose…</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {choice === 'move' && (
            <input className="short" placeholder="new threshold" value={proposed} onChange={(e) => setProposed(e.target.value)} />
          )}
          <input placeholder="why (required)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn" disabled={!choice || !note.trim()} onClick={() => void save()}>Save</button>
          <button className="btn" onClick={() => { setOpen(false); setRefusal(null); }}>Cancel</button>
          {refusal && <div className="notice notice-refused">{refusal}</div>}
        </div>
      )}
    </div>
  );
}

function Inspections({
  status, readOnly, onDone
}: {
  status: PilotStatusDto;
  readOnly: boolean;
  onDone: () => Promise<void>;
}): JSX.Element {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  const record = async (domain: string): Promise<void> => {
    const r = await window.api.pilot.inspect(domain, notes[domain]?.trim() || null);
    if (!r.ok) { setRefusal(r.error); return; }
    setRefusal(null);
    setNotes((n) => ({ ...n, [domain]: '' }));
    await onDone();
  };

  const done = status.inspections.filter((i) => i.lastAt !== null).length;

  return (
    <section className="panel">
      <h2>Domains inspected ({done} of {status.inspections.length})</h2>
      <p className="muted">
        Look at the data of each domain in its view or in Data — a few tickers you know, a date you remember —
        then record it here. Recording again adds a row; the history of who looked when is kept.
      </p>
      {refusal && <div className="notice notice-refused">{refusal}</div>}
      <table className="grid">
        <thead><tr><th>Domain</th><th>Last inspected</th><th>Note</th><th /></tr></thead>
        <tbody>
          {status.inspections.map((i) => (
            <tr key={i.domain}>
              <td>{i.domain}</td>
              <td>{i.lastAt ? <When iso={i.lastAt} /> : <span className="bad">never</span>}</td>
              <td className="wrap">{i.note ?? <span className="muted">—</span>}</td>
              <td>
                {!readOnly && (
                  <div className="rule-form">
                    <input
                      placeholder="what you looked at (optional)"
                      value={notes[i.domain] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [i.domain]: e.target.value }))}
                    />
                    <button className="btn" onClick={() => void record(i.domain)}>Record inspection</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Promote({ status, onDone }: { status: PilotStatusDto; onDone: () => Promise<void> }): JSX.Element {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const perform = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await window.api.pilot.promote(typed);
      if (!r.ok) { setRefusal(r.error); return; }
      setRefusal(null);
      setTyped('');
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reset-form">
      {refusal && <div className="notice notice-refused">{refusal}</div>}
      {status.canPromote ? (
        <>
          <p className="muted">
            Every condition holds. Promoting marks this generation production — downstream stages may
            then read it — and stores this checklist with it.
          </p>
          <input placeholder={`type ${status.confirmation}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          <div className="confirm-row">
            <button
              className="btn"
              disabled={busy || typed.trim() !== status.confirmation}
              onClick={() => void perform()}
            >
              Promote to production
            </button>
          </div>
        </>
      ) : (
        <p className="muted">Promote to production becomes available when every condition above holds.</p>
      )}
    </div>
  );
}
