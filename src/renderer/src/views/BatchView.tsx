// BatchView — shows registered batch jobs and their run history.
// Top panel: job table with edit/run controls.
// Bottom panel: run history for selected job.
// v0.33.0 — Orchestrator: dedicated config modal, trigger/slotTime in history, excluded from sequence.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BatchJob, BatchRun, BatchProgressEvent, OrchestratorJobConfig } from '@shared/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return '…';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status, small }: { status: string | null; small?: boolean }) {
  if (!status) return <span style={{ color: '#95a5a6' }}>—</span>;

  const colors: Record<string, { bg: string; text: string }> = {
    success:  { bg: '#1a3a1a', text: '#2ecc71' },
    failed:   { bg: '#3a1a1a', text: '#e74c3c' },
    skipped:  { bg: '#2a2a2a', text: '#95a5a6' },
    running:  { bg: '#1a2a3a', text: '#3498db' },
    cancelled:{ bg: '#2a2020', text: '#e67e22' },
  };
  const c = colors[status] ?? { bg: '#2a2a2a', text: '#bbb' };
  const size = small ? { fontSize: 11, padding: '1px 6px' } : { fontSize: 12, padding: '2px 8px' };
  return (
    <span style={{
      background: c.bg,
      color: c.text,
      borderRadius: 10,
      fontWeight: 600,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      ...size,
    }}>
      {status === 'running' && <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>}
      {status}
    </span>
  );
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

interface EditModalProps {
  job: BatchJob;
  onSave: (patch: Partial<BatchJob>) => void;
  onClose: () => void;
}

function EditModal({ job, onSave, onClose }: EditModalProps) {
  const [enabled, setEnabled] = useState(job.enabled);
  const [runOnStartup, setRunOnStartup] = useState(job.runOnStartup);
  const [startupDelay, setStartupDelay] = useState(String(job.startupDelaySeconds));
  const [scheduleEnabled, setScheduleEnabled] = useState(job.dailyScheduleEnabled);
  const [scheduleTime, setScheduleTime] = useState(job.dailyScheduleTime);
  const [sequenceOrder, setSequenceOrder] = useState(String(job.sequenceOrder));

  // E*Trade delay — applies to IV Update, Options Snapshot, and Earnings Refresh
  const hasDelayConfig = job.id === 'daily-iv-update' || job.id === 'daily-options-snapshot' || job.id === 'earnings-refresh';
  const defaultDelay = job.id === 'earnings-refresh' ? 500 : 1100;
  const currentDelay = typeof job.config?.['callDelayMs'] === 'number'
    ? job.config['callDelayMs'] as number
    : defaultDelay;
  const [callDelayMs, setCallDelayMs] = useState(String(currentDelay));

  const handleSave = () => {
    const patch: Partial<BatchJob> = {
      enabled,
      runOnStartup,
      startupDelaySeconds: Math.max(0, parseInt(startupDelay, 10) || 0),
      dailyScheduleEnabled: scheduleEnabled,
      dailyScheduleTime: scheduleTime,
      sequenceOrder: Math.max(1, parseInt(sequenceOrder, 10) || 1),
    };
    if (hasDelayConfig) {
      const minDelay = job.id === 'earnings-refresh' ? 0 : 200;
    const delay = Math.max(minDelay, Math.min(2000, parseInt(callDelayMs, 10) || 1100));
      patch.config = { callDelayMs: delay };
    }
    onSave(patch);
    onClose();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e2535', border: '1px solid #2d3748', borderRadius: 10,
        padding: 24, minWidth: 380, maxWidth: 480,
      }}>
        <h3 style={{ margin: '0 0 16px', color: '#ecf0f1' }}>Edit Job: {job.name}</h3>

        <div className="settings-section">
          <div className="settings-row">
            <label>Enabled</label>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          </div>
          <div className="settings-row">
            <label>Run on startup</label>
            <input type="checkbox" checked={runOnStartup} onChange={e => setRunOnStartup(e.target.checked)} />
          </div>
          {runOnStartup && (
            <div className="settings-row">
              <label>Startup delay (seconds)</label>
              <input
                type="number" min={0} max={600}
                value={startupDelay}
                onChange={e => setStartupDelay(e.target.value)}
                style={{ width: 80 }}
              />
            </div>
          )}
          <div className="settings-row">
            <label>Daily schedule</label>
            <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />
          </div>
          {scheduleEnabled && (
            <div className="settings-row">
              <label>Schedule time (ET, HH:MM)</label>
              <input
                type="text" placeholder="16:00"
                value={scheduleTime}
                onChange={e => setScheduleTime(e.target.value)}
                style={{ width: 80 }}
              />
            </div>
          )}
          <div className="settings-row">
            <label>Sequence order</label>
            <input
              type="number" min={1}
              value={sequenceOrder}
              onChange={e => setSequenceOrder(e.target.value)}
              style={{ width: 80 }}
            />
          </div>
          {hasDelayConfig && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #2d3748' }}>
              <div style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
                E*Trade Rate Limit
              </div>
              <div className="settings-row">
                <label style={{ flex: 1 }}>
                  Call delay (ms)
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {job.id === 'earnings-refresh'
                      ? '0–2000ms · default 500 · 0 = no artificial delay (E*Trade API ~250ms natural)'
                      : '200–2000ms · default 1100 · lower = faster but risks 429s'}
                  </div>
                </label>
                <input
                  type="number" min={job.id === 'earnings-refresh' ? 0 : 200} max={2000} step={50}
                  value={callDelayMs}
                  onChange={e => setCallDelayMs(e.target.value)}
                  style={{ width: 80 }}
                />
              </div>
              <div style={{ fontSize: 11, color: '#f39c12', marginTop: 6 }}>
                {job.id === 'daily-iv-update' && <>Est. run time: ~{Math.round((1068 * (parseInt(callDelayMs, 10) || 1100)) / 60_000)} min at {callDelayMs}ms</>}
                {job.id === 'daily-options-snapshot' && <>Est. run time: ~{Math.round((1100 * (parseInt(callDelayMs, 10) || 1100)) / 60_000)} min at {callDelayMs}ms (full universe ~1,100 tickers)</>}
                {job.id === 'earnings-refresh' && <>First run: ~{Math.round((1100 * (250 + (parseInt(callDelayMs, 10) || 0))) / 60_000)} min (API ~250ms + {callDelayMs}ms delay) · Subsequent runs: mostly skipped</>}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="action-btn" onClick={handleSave} style={{ background: '#2980b9', color: '#fff', border: 'none', padding: '6px 18px', borderRadius: 6 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Orchestrator config modal ────────────────────────────────────────────────

interface OrchestratorEditModalProps {
  job: BatchJob;
  allJobs: BatchJob[];
  onSave: (patch: Partial<BatchJob>) => void;
  onClose: () => void;
}

function OrchestratorEditModal({ job, allJobs, onSave, onClose }: OrchestratorEditModalProps) {
  const cfg = (job.config ?? {}) as Partial<OrchestratorJobConfig>;
  const subJobs = allJobs.filter(j => j.id !== 'batch-orchestrator');

  const [enabled, setEnabled] = useState(job.enabled);
  const [scheduleEnabled, setScheduleEnabled] = useState(job.dailyScheduleEnabled);
  const [validateToken, setValidateToken] = useState(cfg.validateEtradeToken ?? true);
  const [emailOnStart, setEmailOnStart] = useState(cfg.emailOnStart ?? true);
  const [slots, setSlots] = useState<string[]>(cfg.scheduleSlots ?? []);
  const [newSlot, setNewSlot] = useState('');
  const [slotError, setSlotError] = useState('');

  const initialEnabled = Object.fromEntries(
    subJobs.map(j => {
      const entry = (cfg.jobs ?? []).find(c => c.id === j.id);
      return [j.id, entry ? entry.enabled : true];
    })
  );
  const [jobEnabled, setJobEnabled] = useState<Record<string, boolean>>(initialEnabled);

  const addSlot = () => {
    const trimmed = newSlot.trim();
    if (!/^\d{2}:\d{2}$/.test(trimmed)) { setSlotError('Use HH:MM format (e.g. 10:15)'); return; }
    const [h, m] = trimmed.split(':').map(Number);
    if (h! > 23 || m! > 59) { setSlotError('Invalid time'); return; }
    if (slots.includes(trimmed)) { setSlotError('Slot already added'); return; }
    setSlots(prev => [...prev, trimmed].sort());
    setNewSlot('');
    setSlotError('');
  };

  const removeSlot = (s: string) => setSlots(prev => prev.filter(x => x !== s));

  const handleSave = () => {
    const updatedConfig: OrchestratorJobConfig = {
      scheduleSlots: slots,
      validateEtradeToken: validateToken,
      emailOnStart,
      jobs: subJobs.map(j => ({ id: j.id, enabled: jobEnabled[j.id] ?? true })),
    };
    onSave({
      enabled,
      dailyScheduleEnabled: scheduleEnabled,
      config: updatedConfig as unknown as Record<string, unknown>,
    });
    onClose();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e2535', border: '1px solid #2d3748', borderRadius: 10,
        padding: 24, minWidth: 420, maxWidth: 520, maxHeight: '85vh', overflowY: 'auto',
      }}>
        <h3 style={{ margin: '0 0 16px', color: '#ecf0f1' }}>⚙ Edit: Batch Orchestrator</h3>

        <div className="settings-section">
          <div className="settings-row">
            <label>Enabled</label>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          </div>
          <div className="settings-row">
            <label>Daily schedule enabled</label>
            <input type="checkbox" checked={scheduleEnabled} onChange={e => setScheduleEnabled(e.target.checked)} />
          </div>
        </div>

        {/* ── Schedule slots ── */}
        <div style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13, margin: '16px 0 8px' }}>
          Schedule Slots <span style={{ color: '#666', fontWeight: 400 }}>(ET times — each fires at most once per day)</span>
        </div>
        <div className="settings-section">
          {slots.length === 0 ? (
            <div style={{ color: '#555', fontSize: 12, padding: '6px 0' }}>No slots configured — add one below.</div>
          ) : (
            slots.map(s => (
              <div key={s} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #2d3748' }}>
                <span style={{ color: '#89b4fa', fontFamily: 'monospace', fontSize: 13 }}>{s} ET</span>
                <button
                  onClick={() => removeSlot(s)}
                  style={{ background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}
                  title="Remove slot"
                >✕</button>
              </div>
            ))
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <input
              type="text"
              placeholder="HH:MM"
              value={newSlot}
              onChange={e => { setNewSlot(e.target.value); setSlotError(''); }}
              onKeyDown={e => e.key === 'Enter' && addSlot()}
              style={{ width: 70, background: '#131b2e', border: '1px solid #3d4f6e', borderRadius: 4, color: '#ecf0f1', padding: '4px 8px', fontSize: 13 }}
            />
            <button
              onClick={addSlot}
              style={{ padding: '4px 12px', borderRadius: 5, border: '1px solid #2ecc71', background: '#1e2535', color: '#2ecc71', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
            >+ Add</button>
            {slotError && <span style={{ color: '#e74c3c', fontSize: 11 }}>{slotError}</span>}
          </div>
        </div>

        <div style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13, margin: '16px 0 8px' }}>Settings</div>
        <div className="settings-section">
          <div className="settings-row">
            <label>Validate E*Trade token before start</label>
            <input type="checkbox" checked={validateToken} onChange={e => setValidateToken(e.target.checked)} />
          </div>
          <div className="settings-row">
            <label>Send email on start</label>
            <input type="checkbox" checked={emailOnStart} onChange={e => setEmailOnStart(e.target.checked)} />
          </div>
        </div>

        <div style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13, margin: '16px 0 8px' }}>
          Jobs to run <span style={{ color: '#666', fontWeight: 400 }}>(in current sequence order)</span>
        </div>
        <div className="settings-section">
          {subJobs.map(j => (
            <div key={j.id} className="settings-row">
              <label style={{ flex: 1 }}>
                {j.name}
                {!j.enabled && <span style={{ marginLeft: 6, fontSize: 11, color: '#555' }}>(job disabled)</span>}
              </label>
              <input
                type="checkbox"
                checked={jobEnabled[j.id] ?? true}
                onChange={e => setJobEnabled(prev => ({ ...prev, [j.id]: e.target.checked }))}
              />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="action-btn" onClick={handleSave} style={{ background: '#2980b9', color: '#fff', border: 'none', padding: '6px 18px', borderRadius: 6 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ─── Run notes / error ────────────────────────────────────────────────────────

/**
 * How much of a run's note the history cell shows before the modal is needed.
 *
 * The text was never lost — `batch_runs.notes` is an unbounded TEXT column and
 * the whole row reaches the renderer — but the cell truncated at 60 characters
 * and offered the rest only through a `title` tooltip. **A native tooltip cannot
 * be selected, scrolled or copied**, so a long note was effectively unreadable:
 * the collector one-shots put a whole gate summary there (bars, tickers, split
 * pages, verdict, finding count), which is exactly the text worth keeping.
 */
const PREVIEW_CHARS = 60;

export function notePreview(run: Pick<BatchRun, 'notes' | 'errorMessage'>): string {
  const text = run.errorMessage ?? run.notes ?? '';
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** What Copy puts on the clipboard: both fields, labelled, when a run has both. */
export function runNotesText(run: Pick<BatchRun, 'notes' | 'errorMessage'>): string {
  const parts: string[] = [];
  if (run.errorMessage) parts.push(`Error: ${run.errorMessage}`);
  if (run.notes) parts.push(run.notes);
  return parts.join('\n\n');
}

function noteBoxStyle(color: string): CSSProperties {
  return {
    margin: 0,
    padding: 12,
    background: '#131b2e',
    border: '1px solid #2d3748',
    borderRadius: 6,
    color,
    fontSize: 12,
    lineHeight: 1.5,
    // Wrap rather than clip, and stay selectable — the two properties whose
    // absence is the whole bug.
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    userSelect: 'text',
    maxHeight: 320,
    overflowY: 'auto',
  };
}

function RunNotesModal({ run, onClose }: { run: BatchRun; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = () => {
    void navigator.clipboard.writeText(runNotesText(run)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#1e2535', border: '1px solid #2d3748', borderRadius: 10,
          padding: 24, minWidth: 480, maxWidth: 760,
        }}
      >
        <h3 style={{ margin: '0 0 4px', color: '#ecf0f1' }}>Run details</h3>
        <div style={{ color: '#95a5a6', fontSize: 12, marginBottom: 16 }}>
          {formatTime(run.startedAt)} · {run.status} · {formatDuration(run.startedAt, run.completedAt)}
        </div>

        {run.errorMessage && (
          <>
            <div style={{ color: '#e74c3c', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Error</div>
            <pre style={noteBoxStyle('#e74c3c')}>{run.errorMessage}</pre>
          </>
        )}
        {run.notes && (
          <>
            <div style={{ color: '#89b4fa', fontSize: 12, fontWeight: 600, margin: run.errorMessage ? '12px 0 6px' : '0 0 6px' }}>
              Notes
            </div>
            <pre style={noteBoxStyle('#ecf0f1')}>{run.notes}</pre>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="batch-btn" onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
          <button className="batch-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

const MAX_LIVE_EVENTS = 300;

export function BatchView() {
  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [runs, setRuns] = useState<BatchRun[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [editJob, setEditJob] = useState<BatchJob | null>(null);
  const [noteRun, setNoteRun] = useState<BatchRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<BatchProgressEvent[]>([]);
  const [liveRunId, setLiveRunId] = useState<number | null>(null);
  const [batchEnabled, setBatchEnabled] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // ── Run-all-in-sequence state ─────────────────────────────────────────────
  const [seqActive, setSeqActive] = useState(false);
  const [seqTotal, setSeqTotal] = useState(0);
  const [seqCurrent, setSeqCurrent] = useState(0); // 1-based index of running job
  const seqActiveRef = useRef(false);               // sync ref — checked inside async loop
  const [freshness, setFreshness] = useState<{ generatedAt: string | null; isToday: boolean } | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const list = await window.api.batch.listJobs();
      setJobs(list);
      // Pick first job by default
      if (selectedJobId === null && list.length > 0) {
        setSelectedJobId(list[0]!.id);
      }
      // Track running job
      const running = list.find(j => j.lastRunStatus === 'running');
      setRunningJobId(running?.id ?? null);
      try { setFreshness(await window.api.batch.briefFreshness()); } catch { /* non-fatal */ }
    } catch (err) {
      console.error('[BatchView] loadJobs error:', err);
    }
  }, [selectedJobId]);

  // Toggle whether a sub-job is after-close-only (skipped by the lean intraday slot) — spec 08 §4.
  const toggleAfterClose = useCallback(async (job: BatchJob) => {
    await window.api.batch.updateJob(job.id, { afterCloseOnly: !job.afterCloseOnly });
    await loadJobs();
  }, [loadJobs]);

  const loadRuns = useCallback(async (jobId: string) => {
    try {
      const list = await window.api.batch.listRuns(jobId);
      setRuns(list);
    } catch (err) {
      console.error('[BatchView] loadRuns error:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadJobs(),
      window.api.batch.getEnabled().then(v => setBatchEnabled(v)),
    ]).finally(() => setLoading(false));
  }, []);

  const handleToggleEnabled = async (enabled: boolean) => {
    await window.api.batch.setEnabled(enabled);
    setBatchEnabled(enabled);
  };

  // Reload runs when selected job changes
  useEffect(() => {
    if (selectedJobId) {
      loadRuns(selectedJobId);
    }
  }, [selectedJobId, loadRuns]);

  // Subscribe to progress events — accumulate for live log
  useEffect(() => {
    const unsub = window.api.batch.onProgress((evt: BatchProgressEvent) => {
      setRunningJobId(evt.jobId);

      // Reset log when a new run starts
      setLiveRunId(prev => {
        if (prev !== evt.runId) {
          setLiveEvents([evt]);
          return evt.runId;
        }
        // Accumulate, capped at MAX_LIVE_EVENTS
        setLiveEvents(prev => {
          const next = [...prev, evt];
          return next.length > MAX_LIVE_EVENTS ? next.slice(next.length - MAX_LIVE_EVENTS) : next;
        });
        return prev;
      });

      // Refresh jobs badge
      loadJobs();
      // Refresh run history if this is the selected job
      if (evt.jobId === selectedJobId) {
        loadRuns(evt.jobId);
      }
    });
    return () => unsub();
  }, [selectedJobId, loadJobs, loadRuns]);

  // Auto-scroll live log to bottom on new events — scroll ONLY the log
  // container (scrollIntoView scrolls every ancestor, yanking the whole page
  // down on each event and pushing the jobs grid out of view).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveEvents]);

  // The log is NOT auto-cleared after a run — it stays visible so failures can
  // be inspected/copied. It resets automatically when the next run starts
  // (runId change in the progress subscription).

  // Auto-poll while a job is running
  useEffect(() => {
    if (runningJobId) {
      pollRef.current = setInterval(() => {
        loadJobs();
        if (selectedJobId) loadRuns(selectedJobId);
      }, 3000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runningJobId, selectedJobId, loadJobs, loadRuns]);

  const handleRunNow = async (jobId: string) => {
    await window.api.batch.runNow(jobId);
    await loadJobs();
  };

  const handleCancel = async (jobId: string) => {
    await window.api.batch.cancel(jobId);
    await loadJobs();
  };

  // ── Sequence: run every enabled job one at a time via sync IPC ───────────
  // runNowSync awaits full job completion on the main side, so no event-watching
  // race conditions. force=true bypasses non-trading-day guards in each job.
  const handleRunAllSequence = async () => {
    if (seqActive || runningJobId !== null) return;
    const queue = jobs
      .filter(j => j.enabled && j.id !== 'batch-orchestrator')
      .sort((a, b) => a.sequenceOrder - b.sequenceOrder)
      .map(j => j.id);
    if (queue.length === 0) return;

    seqActiveRef.current = true;
    setSeqActive(true);
    setSeqTotal(queue.length);
    setSeqCurrent(0);

    for (let i = 0; i < queue.length; i++) {
      if (!seqActiveRef.current) break;
      setSeqCurrent(i + 1);
      await window.api.batch.runNowSync(queue[i]!);
      await loadJobs();
    }

    seqActiveRef.current = false;
    setSeqActive(false);
    setSeqTotal(0);
    setSeqCurrent(0);
  };

  const handleCancelSequence = async () => {
    seqActiveRef.current = false; // stops the loop after current job finishes
    setSeqActive(false);
    setSeqTotal(0);
    setSeqCurrent(0);
    if (runningJobId) await handleCancel(runningJobId);
  };

  const handleSaveConfig = async (jobId: string, patch: Partial<BatchJob>) => {
    await window.api.batch.updateJob(jobId, patch);
    await loadJobs();
    setEditJob(null);
  };


  const selectedJob = jobs.find(j => j.id === selectedJobId) ?? null;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
    <div style={{ padding: '20px 24px' }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .batch-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .batch-table th { background: #1a2235; color: #89b4fa; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 1px solid #2d3748; }
        .batch-table thead { position: sticky; top: 0; z-index: 1; }
        .batch-table td { padding: 8px 10px; border-bottom: 1px solid #1e2535; vertical-align: middle; }
        .batch-table tr:hover td { background: #1a2535; }
        .batch-table tr.selected td { background: #1a2a3a; }
        .batch-btn { padding: 4px 10px; border-radius: 5px; border: 1px solid #3d4f6e; background: #1e2a3a; color: #89b4fa; cursor: pointer; font-size: 12px; }
        .batch-btn:hover { background: #2a3a5a; }
        .batch-btn.run { border-color: #2ecc71; color: #2ecc71; }
        .batch-btn.cancel { border-color: #e74c3c; color: #e74c3c; }
        .settings-section { background: #1a2235; border-radius: 8px; padding: 12px 16px; }
        .settings-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #2d3748; }
        .settings-row:last-child { border-bottom: none; }
        .settings-row label { color: #a0aec0; font-size: 13px; }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ color: '#ecf0f1', margin: 0 }}>⚙ Batch Jobs</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Sequence controls */}
          {seqActive ? (
            <>
              <span style={{ color: '#89b4fa', fontSize: 13, fontWeight: 600 }}>
                <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', marginRight: 6 }}>⟳</span>
                Sequence: {seqCurrent} / {seqTotal}
              </span>
              <button
                onClick={handleCancelSequence}
                style={{ padding: '5px 14px', borderRadius: 6, border: '1px solid #e74c3c', background: '#1e2535', color: '#e74c3c', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                ✕ Cancel Sequence
              </button>
            </>
          ) : (
            <button
              onClick={handleRunAllSequence}
              disabled={runningJobId !== null || jobs.filter(j => j.enabled).length === 0}
              title="Run all enabled jobs one at a time in sequence order"
              style={{
                padding: '5px 14px', borderRadius: 6,
                border: '1px solid #2ecc71', background: '#1e2535',
                color: runningJobId !== null ? '#555' : '#2ecc71',
                borderColor: runningJobId !== null ? '#444' : '#2ecc71',
                cursor: runningJobId !== null ? 'not-allowed' : 'pointer',
                fontSize: 13, fontWeight: 600,
              }}
            >
              ▶▶ Run All in Sequence
            </button>
          )}
          {/* Jobs ON/OFF toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ color: batchEnabled ? '#2ecc71' : '#e74c3c', fontWeight: 600, fontSize: 13 }}>
            {batchEnabled ? 'Jobs ON' : 'Jobs OFF'}
          </span>
          <span style={{
            position: 'relative', display: 'inline-block', width: 40, height: 22,
          }}>
            <input
              type="checkbox"
              checked={batchEnabled}
              onChange={e => handleToggleEnabled(e.target.checked)}
              style={{ opacity: 0, width: 0, height: 0, position: 'absolute' }}
            />
            <span style={{
              position: 'absolute', inset: 0, borderRadius: 11,
              background: batchEnabled ? '#27ae60' : '#444',
              transition: 'background 0.2s',
              cursor: 'pointer',
            }} onClick={() => handleToggleEnabled(!batchEnabled)} />
            <span style={{
              position: 'absolute', top: 3, left: batchEnabled ? 21 : 3, width: 16, height: 16,
              borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
              pointerEvents: 'none',
            }} />
          </span>
          </label>
        </div>
      </div>

      {!batchEnabled && (
        <div style={{
          background: '#2a1a00', border: '1px solid #e67e22', borderRadius: 8,
          padding: '10px 16px', marginBottom: 20, color: '#e67e22', fontSize: 13,
        }}>
          Batch jobs are disabled for this session. Startup and scheduled jobs will not run until re-enabled. Manual &quot;Run Now&quot; still works.
        </div>
      )}

      {/* ── Brief-freshness banner (spec 08 §5.4): does the engine have a fresh same-day brief? ── */}
      {freshness && (
        <div style={{
          background: freshness.isToday ? 'rgba(46,204,113,0.10)' : 'rgba(243,156,18,0.10)',
          border: `1px solid ${freshness.isToday ? '#2ecc71' : '#f39c12'}`,
          borderRadius: 8, padding: '8px 14px', marginBottom: 16, fontSize: 13,
          color: freshness.isToday ? '#2ecc71' : '#f39c12',
        }}>
          {freshness.generatedAt
            ? (freshness.isToday
                ? `✓ Today's brief committed ${new Date(freshness.generatedAt).toLocaleString()} — the engine has a fresh brief to act on.`
                : `⚠ Latest brief is ${new Date(freshness.generatedAt).toLocaleString()} (not today). The engine will not act until today's brief commits.`)
            : 'No brief found yet.'}
        </div>
      )}

      {/* ── Top panel: job table ── */}
      <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748', marginBottom: 24 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>
          Registered Jobs <span style={{ color: '#95a5a6', fontWeight: 400 }}>· the lean ~10:15 slot skips “After-close” jobs</span>
        </div>
        {/* Fixed height — all three panels keep constant size so the layout never shifts */}
        <div style={{ height: 300, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20, color: '#95a5a6', textAlign: 'center' }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: 20, color: '#95a5a6', textAlign: 'center' }}>No jobs registered.</div>
        ) : (
          <table className="batch-table">
            <thead>
              <tr>
                <th style={{ width: 32, textAlign: 'center', color: '#555' }}>#</th>
                <th>Name</th>
                <th>Description</th>
                <th>Startup</th>
                <th>Schedule</th>
                <th>Slot</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const isRunning = job.lastRunStatus === 'running';
                const isOrch = job.id === 'batch-orchestrator';
                return (
                  <tr
                    key={job.id}
                    className={selectedJobId === job.id ? 'selected' : ''}
                    onClick={() => setSelectedJobId(job.id)}
                    style={{ cursor: 'pointer', background: isOrch ? 'rgba(137,180,250,0.04)' : undefined }}
                  >
                    <td style={{ textAlign: 'center', color: '#555', fontSize: 12 }}>{job.sequenceOrder}</td>
                    <td>
                      <strong style={{ color: job.enabled ? (isOrch ? '#89b4fa' : '#ecf0f1') : '#666' }}>
                        {isOrch ? '⚙ ' : ''}{job.name}
                      </strong>
                      {!job.enabled && <span style={{ marginLeft: 6, fontSize: 11, color: '#555' }}>(disabled)</span>}
                    </td>
                    <td style={{ color: '#95a5a6', maxWidth: 280, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {job.description}
                    </td>
                    <td>
                      {job.runOnStartup
                        ? <span style={{ color: '#2ecc71', fontSize: 11 }}>ON ({job.startupDelaySeconds}s)</span>
                        : <span style={{ color: '#555', fontSize: 11 }}>off</span>}
                    </td>
                    <td>
                      {isOrch ? (
                        (() => {
                          const orchSlots = (job.config as Partial<OrchestratorJobConfig> | undefined)?.scheduleSlots ?? [];
                          return job.dailyScheduleEnabled && orchSlots.length > 0
                            ? <span style={{ color: '#89b4fa', fontSize: 11 }}>{orchSlots.join(', ')} ET</span>
                            : <span style={{ color: '#555', fontSize: 11 }}>{job.dailyScheduleEnabled ? 'on (no slots)' : 'off'}</span>;
                        })()
                      ) : job.dailyScheduleEnabled
                        ? <span style={{ color: '#89b4fa', fontSize: 11 }}>{job.dailyScheduleTime} ET</span>
                        : <span style={{ color: '#555', fontSize: 11 }}>off</span>}
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      {isOrch ? (
                        (() => {
                          const cfg = job.config as Partial<OrchestratorJobConfig> | undefined;
                          const slots = cfg?.scheduleSlots ?? [];
                          const lean = cfg?.leanSlots ?? (slots.length > 1 ? slots.slice(0, -1) : []);
                          return <span style={{ fontSize: 11, color: '#95a5a6' }} title="Slots that run lean (skip after-close-only jobs)">
                            {lean.length ? `lean: ${lean.join(', ')}` : '—'}
                          </span>;
                        })()
                      ) : (
                        <button
                          className="batch-btn"
                          onClick={() => toggleAfterClose(job)}
                          title={job.afterCloseOnly
                            ? 'After-close only — runs in the full ~17:00 slot. Click to also run in the lean ~10:15 slot.'
                            : 'Lean — runs in both the ~10:15 and ~17:00 slots. Click to defer to after-close only.'}
                          style={{
                            fontSize: 11, padding: '2px 8px',
                            background: job.afterCloseOnly ? 'rgba(243,156,18,0.16)' : 'rgba(46,204,113,0.16)',
                            color: job.afterCloseOnly ? '#f39c12' : '#2ecc71',
                          }}>
                          {job.afterCloseOnly ? 'After-close' : 'Lean'}
                        </button>
                      )}
                    </td>
                    <td><StatusBadge status={job.lastRunStatus} small /></td>
                    <td style={{ color: '#95a5a6', fontSize: 12 }}>{relativeTime(job.lastRunAt)}</td>
                    <td style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }} onClick={e => e.stopPropagation()}>
                      {isRunning ? (
                        <button className="batch-btn cancel" onClick={() => handleCancel(job.id)}>✕ Cancel</button>
                      ) : (
                        <button className="batch-btn run" onClick={() => handleRunNow(job.id)} disabled={runningJobId !== null && runningJobId !== job.id}>
                          ▶ Run Now
                        </button>
                      )}
                      <button className="batch-btn" onClick={() => setEditJob(job)}>✎ Edit</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        </div>
      </div>

      {/* ── Bottom panel: run history ── */}
      <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748', marginBottom: 24 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>
          Run History{selectedJob ? ` — ${selectedJob.name} (last 30 days)` : ''}
        </div>
        {/* Fixed height ≈ 4 rows — constant regardless of state */}
        <div style={{ height: 160, overflowY: 'auto' }}>
        {!selectedJobId ? (
          <div style={{ padding: 20, color: '#95a5a6', textAlign: 'center' }}>Select a job above to view history.</div>
        ) : runs.length === 0 ? (
          <div style={{ padding: 20, color: '#95a5a6', textAlign: 'center' }}>No runs recorded yet.</div>
        ) : (
            <table className="batch-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Trigger</th>
                  <th>Updated ✓</th>
                  <th>Skipped —</th>
                  <th>Failed ✗</th>
                  <th>Notes / Error</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => {
                  const triggerLabel = run.slotTime
                    ? `sched ${run.slotTime}`
                    : run.trigger === 'schedule' ? 'sched'
                    : run.trigger === 'startup'  ? 'startup'
                    : 'manual';
                  return (
                  <tr key={run.id}>
                    <td style={{ color: '#95a5a6', fontSize: 12, whiteSpace: 'nowrap' }}>{formatTime(run.startedAt)}</td>
                    <td style={{ color: '#95a5a6', fontSize: 12 }}>{formatDuration(run.startedAt, run.completedAt)}</td>
                    <td><StatusBadge status={run.status} small /></td>
                    <td style={{ color: '#89b4fa', fontSize: 11 }}>{triggerLabel}</td>
                    <td style={{ color: '#2ecc71', textAlign: 'center' }}>{run.tickersUpdated || '—'}</td>
                    <td style={{ color: '#95a5a6', textAlign: 'center' }}>{run.tickersSkipped || '—'}</td>
                    <td style={{ color: run.tickersFailed > 0 ? '#e74c3c' : '#95a5a6', textAlign: 'center' }}>{run.tickersFailed || '—'}</td>
                    <td style={{ color: '#95a5a6', fontSize: 12, maxWidth: 300, overflow: 'hidden' }}>
                      {(run.errorMessage ?? run.notes) ? (
                        <span
                          onClick={() => setNoteRun(run)}
                          title="Click for the full text"
                          style={{
                            color: run.errorMessage ? '#e74c3c' : '#95a5a6',
                            cursor: 'pointer',
                            textDecoration: 'underline dotted',
                          }}
                        >
                          {notePreview(run)}
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
        )}
        </div>
      </div>

      {/* ── Live Activity panel — always visible, fixed height (no layout shift) ── */}
      {(() => {
        const last = liveEvents.length > 0 ? liveEvents[liveEvents.length - 1]! : null;
        const total = last?.total ?? 0;
        const attempted = last?.attempted ?? 0;
        const updated = last?.updated ?? 0;
        const skipped = last?.skipped ?? 0;
        const failed = last?.failed ?? 0;
        const pct = total > 0 ? Math.round((attempted / total) * 100) : 0;

        const copyLog = () => {
          const text = liveEvents
            .map(evt => `${evt.status === 'updated' ? '✓' : evt.status === 'failed' ? '✗' : '—'} ${evt.ticker} ${evt.status}${evt.message ? ` — ${evt.message}` : ''}`)
            .join('\n');
          void navigator.clipboard.writeText(text);
        };

        return (
          <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748', marginBottom: 24 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>
                {runningJobId
                  ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Live Activity</>
                  : liveEvents.length > 0 ? '✓ Run Complete' : 'Live Activity — idle'}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {liveEvents.length > 0 && (
                  <span style={{ color: '#95a5a6', fontSize: 12 }}>
                    {attempted} / {total} tickers &nbsp;·&nbsp;
                    <span style={{ color: '#2ecc71' }}>✓ {updated}</span> &nbsp;
                    <span style={{ color: '#95a5a6' }}>— {skipped}</span> &nbsp;
                    <span style={{ color: failed > 0 ? '#e74c3c' : '#95a5a6' }}>✗ {failed}</span>
                  </span>
                )}
                <button className="batch-btn" onClick={copyLog} disabled={liveEvents.length === 0}
                  title="Copy the full log to clipboard">
                  ⧉ Copy
                </button>
                <button className="batch-btn" onClick={() => setLiveEvents([])} disabled={liveEvents.length === 0}
                  title="Clear the log">
                  ✕ Clear
                </button>
              </span>
            </div>

            {/* Progress bar — always rendered so the panel height is constant */}
            <div style={{ padding: '8px 16px', borderBottom: '1px solid #1e2535' }}>
              <div style={{ background: '#1a2235', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                <div style={{
                  width: `${pct}%`,
                  height: '100%',
                  background: runningJobId ? '#3498db' : '#2ecc71',
                  borderRadius: 4,
                  transition: 'width 0.3s ease',
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: '#666' }}>
                <span>{total > 0 ? `${pct}%` : '—'}</span>
                <span>{total > 0 ? `${total - attempted} remaining` : 'no run in progress'}</span>
              </div>
            </div>

            {/* Ticker log — fixed height; auto-scrolls its own scrollbar only */}
            <div ref={logRef} style={{ height: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12, padding: '4px 0' }}>
              {liveEvents.length === 0 ? (
                <div style={{ padding: 20, color: '#555', textAlign: 'center', fontFamily: 'inherit' }}>
                  No activity yet — run a job to see live progress. The log stays here after the run finishes until the next run starts.
                </div>
              ) : liveEvents.map((evt, i) => {
                const statusColor: Record<string, string> = {
                  updated:  '#2ecc71',
                  skipped:  '#95a5a6',
                  failed:   '#e74c3c',
                  'no-data': '#e67e22',
                };
                const color = statusColor[evt.status] ?? '#bbb';
                const icon = evt.status === 'updated' ? '✓' : evt.status === 'failed' ? '✗' : '—';
                return (
                  <div key={i} style={{ padding: '2px 16px', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ color, minWidth: 14, textAlign: 'center' }}>{icon}</span>
                    <span style={{ color: '#ecf0f1', minWidth: 72 }}>{evt.ticker}</span>
                    <span style={{ color }}>{evt.status}</span>
                    {evt.message && <span style={{ color: '#666', fontSize: 11 }}>— {evt.message}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Run notes / error modal ── */}
      {noteRun && <RunNotesModal run={noteRun} onClose={() => setNoteRun(null)} />}

      {/* ── Edit modal ── */}
      {editJob && (
        editJob.id === 'batch-orchestrator' ? (
          <OrchestratorEditModal
            job={editJob}
            allJobs={jobs}
            onSave={(patch) => handleSaveConfig(editJob.id, patch)}
            onClose={() => setEditJob(null)}
          />
        ) : (
          <EditModal
            job={editJob}
            onSave={(patch) => handleSaveConfig(editJob.id, patch)}
            onClose={() => setEditJob(null)}
          />
        )
      )}
    </div>
    </div>
  );
}
