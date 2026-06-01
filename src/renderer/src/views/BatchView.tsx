// BatchView — shows registered batch jobs and their run history.
// Top panel: job table with edit/run controls.
// Bottom panel: run history for selected job.
// v0.21.0

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BatchJob, BatchRun, BatchProgressEvent } from '@shared/types.js';

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

  const handleSave = () => {
    onSave({
      enabled,
      runOnStartup,
      startupDelaySeconds: Math.max(0, parseInt(startupDelay, 10) || 0),
      dailyScheduleEnabled: scheduleEnabled,
      dailyScheduleTime: scheduleTime,
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
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Cancel</button>
          <button className="action-btn" onClick={handleSave} style={{ background: '#2980b9', color: '#fff', border: 'none', padding: '6px 18px', borderRadius: 6 }}>Save</button>
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
  const [loading, setLoading] = useState(true);
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<BatchProgressEvent[]>([]);
  const [liveRunId, setLiveRunId] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

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
    } catch (err) {
      console.error('[BatchView] loadJobs error:', err);
    }
  }, [selectedJobId]);

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
    loadJobs().finally(() => setLoading(false));
  }, []);

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

  // Auto-scroll live log to bottom on new events
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveEvents]);

  // Clear live log 3 s after job finishes so it doesn't linger forever
  useEffect(() => {
    if (!runningJobId && liveEvents.length > 0) {
      const t = setTimeout(() => setLiveEvents([]), 3000);
      return () => clearTimeout(t);
    }
  }, [runningJobId, liveEvents.length]);

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

  const handleSaveConfig = async (jobId: string, patch: Partial<BatchJob>) => {
    await window.api.batch.updateJob(jobId, patch);
    await loadJobs();
    setEditJob(null);
  };

  const selectedJob = jobs.find(j => j.id === selectedJobId) ?? null;

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .batch-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .batch-table th { background: #1a2235; color: #89b4fa; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 1px solid #2d3748; }
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

      <h2 style={{ color: '#ecf0f1', margin: '0 0 20px' }}>⚙ Batch Jobs</h2>

      {/* ── Top panel: job table ── */}
      <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748', marginBottom: 24 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>
          Registered Jobs
        </div>
        {loading ? (
          <div style={{ padding: 20, color: '#95a5a6', textAlign: 'center' }}>Loading…</div>
        ) : jobs.length === 0 ? (
          <div style={{ padding: 20, color: '#95a5a6', textAlign: 'center' }}>No jobs registered.</div>
        ) : (
          <table className="batch-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Startup</th>
                <th>Schedule</th>
                <th>Status</th>
                <th>Last Run</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const isRunning = job.lastRunStatus === 'running';
                return (
                  <tr
                    key={job.id}
                    className={selectedJobId === job.id ? 'selected' : ''}
                    onClick={() => setSelectedJobId(job.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <strong style={{ color: job.enabled ? '#ecf0f1' : '#666' }}>{job.name}</strong>
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
                      {job.dailyScheduleEnabled
                        ? <span style={{ color: '#89b4fa', fontSize: 11 }}>{job.dailyScheduleTime} ET</span>
                        : <span style={{ color: '#555', fontSize: 11 }}>off</span>}
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

      {/* ── Live Activity panel — visible only while a job is running or log not yet cleared ── */}
      {liveEvents.length > 0 && (() => {
        const last = liveEvents[liveEvents.length - 1]!;
        const total = last.total ?? 0;
        const attempted = last.attempted ?? 0;
        const updated = last.updated ?? 0;
        const skipped = last.skipped ?? 0;
        const failed = last.failed ?? 0;
        const pct = total > 0 ? Math.round((attempted / total) * 100) : 0;

        return (
          <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748', marginBottom: 24 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>
                {runningJobId
                  ? <><span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</span> Live Activity</>
                  : '✓ Run Complete'}
              </span>
              <span style={{ color: '#95a5a6', fontSize: 12 }}>
                {attempted} / {total} tickers &nbsp;·&nbsp;
                <span style={{ color: '#2ecc71' }}>✓ {updated}</span> &nbsp;
                <span style={{ color: '#95a5a6' }}>— {skipped}</span> &nbsp;
                <span style={{ color: failed > 0 ? '#e74c3c' : '#95a5a6' }}>✗ {failed}</span>
              </span>
            </div>

            {/* Progress bar */}
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
                <span>{pct}%</span>
                <span>{total - attempted} remaining</span>
              </div>
            </div>

            {/* Ticker log */}
            <div style={{ maxHeight: 220, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12, padding: '4px 0' }}>
              {liveEvents.map((evt, i) => {
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
              <div ref={logEndRef} />
            </div>
          </div>
        );
      })()}

      {/* ── Bottom panel: run history ── */}
      <div style={{ background: '#131b2e', borderRadius: 10, border: '1px solid #2d3748' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2d3748', color: '#89b4fa', fontWeight: 600, fontSize: 13 }}>
          Run History{selectedJob ? ` — ${selectedJob.name} (last 30 days)` : ''}
        </div>
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
                <th>Updated ✓</th>
                <th>Skipped —</th>
                <th>Failed ✗</th>
                <th>Notes / Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id}>
                  <td style={{ color: '#95a5a6', fontSize: 12, whiteSpace: 'nowrap' }}>{formatTime(run.startedAt)}</td>
                  <td style={{ color: '#95a5a6', fontSize: 12 }}>{formatDuration(run.startedAt, run.completedAt)}</td>
                  <td><StatusBadge status={run.status} small /></td>
                  <td style={{ color: '#2ecc71', textAlign: 'center' }}>{run.tickersUpdated || '—'}</td>
                  <td style={{ color: '#95a5a6', textAlign: 'center' }}>{run.tickersSkipped || '—'}</td>
                  <td style={{ color: run.tickersFailed > 0 ? '#e74c3c' : '#95a5a6', textAlign: 'center' }}>{run.tickersFailed || '—'}</td>
                  <td style={{ color: '#95a5a6', fontSize: 12, maxWidth: 300, overflow: 'hidden' }}>
                    {run.errorMessage ? (
                      <span title={run.errorMessage} style={{ color: '#e74c3c', cursor: 'help' }}>
                        {run.errorMessage.slice(0, 60)}{run.errorMessage.length > 60 ? '…' : ''}
                      </span>
                    ) : run.notes ? (
                      <span title={run.notes}>
                        {run.notes.slice(0, 60)}{run.notes.length > 60 ? '…' : ''}
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Edit modal ── */}
      {editJob && (
        <EditModal
          job={editJob}
          onSave={(patch) => handleSaveConfig(editJob.id, patch)}
          onClose={() => setEditJob(null)}
        />
      )}
    </div>
  );
}
