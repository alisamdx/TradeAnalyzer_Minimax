import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExecEngineStateView,
  ExecConfig,
  ExecRiskState,
  ExecPositionRow,
  ExecProposalRow,
  ExecAuditRow,
  ExecDryRunRow,
} from '@shared/types.js';
import { useSortable } from '../hooks/useSortable.js';

// The 🤝 Execution control surface (Requirements/v2-execution §4 + spec 08 §5 — the
// tabbed Trading Desk redesign). Drives the ExecutionEngine entirely through
// window.api.execution.*. Engine starts `stopped`; nothing here places a real order —
// the broker is the mock until the IBKR adapter is the active broker.

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtMoney2(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Clock-only (HH:MM:SS, local) for the live feed. */
function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

/** ET calendar date (YYYY-MM-DD) for an ISO timestamp — the day-bucket for the tabs. */
function etDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** ET wall-clock minutes-since-midnight for an ISO timestamp (for the timeline x-position). */
function etMinutes(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

const PROTECTIVE = new Set(['stop', 'defensive', 'flatten']);

const STATE_COLOR: Record<string, string> = {
  running: 'var(--success)',
  stopped: 'var(--text-muted)',
  paused: 'var(--warning)',
  kill_tripped: 'var(--danger)',
};

function pill(label: string, color: string) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12,
      fontWeight: 600, color: '#fff', background: color, whiteSpace: 'nowrap',
    }}>{label}</span>
  );
}

// Friendly one-liners + dot color for the live feed / timeline, keyed by audit event.
function describeEvent(a: ExecAuditRow): { text: React.ReactNode; color: string; pin?: string } {
  let d: Record<string, unknown> = {};
  try { d = a.detail_json ? JSON.parse(a.detail_json) : {}; } catch { /* keep {} */ }
  const tkr = typeof d.ticker === 'string' ? d.ticker : undefined;
  const reason = typeof d.reason === 'string' ? d.reason : undefined;
  switch (a.event) {
    case 'position_opened':
      return { text: <>Entered <strong>{tkr ?? '—'}</strong>{d.contracts ? ` ×${d.contracts}` : ''}</>, color: 'var(--success)', pin: `entered ${tkr ?? ''}` };
    case 'position_closed':
      return { text: <>Closed <strong>{tkr ?? `position #${a.ref_id ?? '?'}`}</strong></>, color: 'var(--warning)', pin: `exit ${tkr ?? ''}` };
    case 'exit_fired':
      return { text: <>Exit fired <span className="muted">({reason ?? 'exit'}{d.cls ? `, ${d.cls}` : ''})</span> on #{a.ref_id ?? '?'}</>, color: 'var(--warning)', pin: `exit ${reason ?? ''}` };
    case 'exit_proposed':
      return { text: <>Exit proposed <span className="muted">({reason ?? 'exit'})</span> on #{a.ref_id ?? '?'}</>, color: 'var(--accent)' };
    case 'proposal_created':
      return { text: <>Proposal created <span className="muted">{tkr ? `· ${tkr}` : ''}</span></>, color: 'var(--accent)' };
    case 'proposal_approved':
      return { text: <>Proposal approved <span className="muted">#{a.ref_id ?? '?'}</span></>, color: 'var(--success)' };
    case 'proposal_rejected':
    case 'order_rejected':
      return { text: <>Rejected <span className="muted">#{a.ref_id ?? '?'}{reason ? ` — ${reason}` : ''}</span></>, color: 'var(--danger)' };
    case 'proposal_user_rejected':
      return { text: <>You rejected proposal #{a.ref_id ?? '?'}</>, color: 'var(--text-muted)' };
    case 'gate_reject':
      return { text: <>Gate rejected <strong>{tkr ?? '—'}</strong> <span className="muted">{reason ? `— ${reason}` : ''}</span></>, color: 'var(--danger)' };
    case 'gate_pass':
      return { text: <>Gate passed <strong>{tkr ?? '—'}</strong></>, color: 'var(--success)' };
    case 'fill':
      return { text: <>Fill on order #{a.ref_id ?? '?'} <span className="muted">@ {fmtMoney2(typeof d.price === 'number' ? d.price : null)}</span></>, color: 'var(--success)' };
    case 'order_submitted':
      return { text: <>Order submitted <span className="muted">#{a.ref_id ?? '?'} ({String(d.side ?? '')})</span></>, color: 'var(--accent)' };
    case 'kill_tripped':
      return { text: <>⛔ Kill switch TRIPPED <span className="muted">{reason ? `— ${reason}` : ''}</span></>, color: 'var(--danger)', pin: 'kill trip' };
    case 'kill_cleared':
      return { text: <>Kill switch cleared</>, color: 'var(--success)', pin: 'kill clear' };
    case 'engine_state':
      return { text: <>Engine {String(d.from ?? '?')} → <strong>{String(d.to ?? '?')}</strong></>, color: 'var(--text-muted)' };
    case 'brief_ready':
      return { text: <>Brief ready</>, color: 'var(--accent)', pin: 'brief' };
    case 'reconcile_mismatch':
      return { text: <>⚠ Reconcile mismatch</>, color: 'var(--danger)', pin: 'reconcile drift' };
    case 'preflight_permission_ok':
      return { text: <>Broker permission preflight OK</>, color: 'var(--success)' };
    case 'preflight_permission_failed':
    case 'preflight_connect_failed':
      return { text: <>Preflight failed <span className="muted">({a.event.replace('preflight_', '').replace(/_/g, ' ')})</span></>, color: 'var(--danger)' };
    default:
      return { text: <>{a.event.replace(/_/g, ' ')}</>, color: 'var(--text-muted)' };
  }
}

// ─── reusable sortable grid ───────────────────────────────────────────────────

interface GridCol<T> {
  key: string;            // sort key (a field on the row); '' = non-sortable
  label: string;
  num?: boolean;          // right-align + tabular nums
  render: (row: T) => React.ReactNode;
  cell?: (row: T) => string | undefined; // optional td className (pos/neg)
}

function Grid<T extends Record<string, unknown>>({
  rows, cols, getKey, defaultSort, defaultDir = 'desc', empty,
}: {
  rows: T[];
  cols: GridCol<T>[];
  getKey: (row: T) => string;
  defaultSort?: string;
  defaultDir?: 'asc' | 'desc';
  empty: string;
}) {
  const { sortedData, requestSort, getSortIndicator } = useSortable(rows, defaultSort, defaultDir);
  return (
    <div className="td-grid-wrap">
      <table className="td-grid">
        <thead>
          <tr>
            {cols.map((c) => {
              const sortable = !!c.key;
              const ind = sortable ? getSortIndicator(c.key) : '';
              return (
                <th
                  key={c.key || c.label}
                  className={[sortable ? 'sortable' : '', c.num ? 'num' : ''].filter(Boolean).join(' ') || undefined}
                  data-active={ind ? '' : undefined}
                  onClick={sortable ? () => requestSort(c.key) : undefined}
                >
                  {c.label}
                  {sortable && <span className="sort-indicator">{ind || '↕'}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedData.length === 0 ? (
            <tr><td className="td-grid-empty" colSpan={cols.length}>{empty}</td></tr>
          ) : (
            sortedData.map((r) => (
              <tr key={getKey(r)}>
                {cols.map((c) => (
                  <td key={c.key || c.label} className={[c.num ? 'num' : '', c.cell?.(r) ?? ''].filter(Boolean).join(' ') || undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── derived row shapes for the day tabs ──────────────────────────────────────

interface EntryRow extends Record<string, unknown> {
  _key: string;
  ticker: string;
  strategy: string;
  structure: string;
  contracts: number | null;
  net_credit: number | null;
  max_loss: number | null;
  pnl: number | null;
  status: string;        // position status, or 'dry-run'
  at: string;
  placed: boolean;
  sortAt: number;
}

interface ExitRow extends Record<string, unknown> {
  _key: string;
  ticker: string;
  strategy: string;
  structure: string;
  reason: string;
  cls: 'protective' | 'discretionary';
  pnl: number | null;
  at: string;
  placed: boolean;
  sortAt: number;
}

interface RejectRow extends Record<string, unknown> {
  _key: string;
  ticker: string;
  event: string;
  reason: string;
  at: string;
  sortAt: number;
}

// ─── component ──────────────────────────────────────────────────────────────

type TabId = 'live' | 'proposals' | 'entries' | 'exits' | 'rejects' | 'positions' | 'activity';

export function TradingDeskView() {
  const [state, setState] = useState<ExecEngineStateView | null>(null);
  const [config, setConfig] = useState<ExecConfig | null>(null);
  const [risk, setRisk] = useState<ExecRiskState | null>(null);
  const [positions, setPositions] = useState<ExecPositionRow[]>([]);
  const [recent, setRecent] = useState<ExecPositionRow[]>([]);
  const [proposals, setProposals] = useState<ExecProposalRow[]>([]);
  const [audit, setAudit] = useState<ExecAuditRow[]>([]);
  const [dryRun, setDryRun] = useState<ExecDryRunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabId>('live');
  const busyRef = useRef(false);
  const prevProposalIds = useRef<Set<number>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const [s, c, r, p, rp, pr, a, dr] = await Promise.all([
        window.api.execution.getState(),
        window.api.execution.getConfig(),
        window.api.execution.getRiskState(),
        window.api.execution.getPositions(),
        window.api.execution.getRecentPositions(200),
        window.api.execution.getProposals(),
        window.api.execution.getAudit(200),
        window.api.execution.getDryRunLog(200),
      ]);
      setState(s); setConfig(c); setRisk(r);
      setPositions(p); setRecent(rp); setProposals(pr); setAudit(a); setDryRun(dr);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Live engine events → refresh. Also a slow poll as a fallback.
  useEffect(() => {
    const unsub = window.api.execution.onEvent(() => { refresh(); });
    const id = setInterval(refresh, 15_000);
    return () => { unsub(); clearInterval(id); };
  }, [refresh]);

  // Auto-focus the Proposals tab the moment a *new* pending proposal appears (spec 08 §5.3).
  useEffect(() => {
    const ids = new Set(proposals.map((p) => p.id));
    const hasNew = proposals.some((p) => !prevProposalIds.current.has(p.id));
    if (hasNew && proposals.length > 0) setTab('proposals');
    prevProposalIds.current = ids;
  }, [proposals]);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await fn(); await refresh(); }
    catch (e) { setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }, [refresh]);

  const isLive = config?.executionMode === 'live';
  const engineState = state?.engineState ?? 'stopped';
  const killTripped = state?.killSwitch.tripped ?? false;

  const onStart = () => run(async () => {
    const res = await window.api.execution.start();
    if (!res.started) setError(`Engine refused to start: ${res.reason ?? 'unknown'}`);
  });
  const onStop = () => run(() => window.api.execution.stop());
  const onPause = () => run(() => window.api.execution.pause());
  const onKillTrip = () => run(() => window.api.execution.killTrip());
  const onKillClear = () => run(() => window.api.execution.killClear());

  const automationMode = state?.automationMode ?? config?.automationMode ?? 'semi';
  const armed = state?.armed ?? false;
  const onSetAutomation = (mode: 'semi' | 'dry_run' | 'unattended') => run(async () => {
    if (mode === 'unattended' && isLive) {
      setError('Unattended auto-entry is PAPER-ONLY. Switch to paper to arm.');
      return;
    }
    if (mode === 'unattended') {
      const okc = await window.dialog.confirm({
        title: 'Arm unattended mode',
        message: 'While running on paper, the engine will auto-enter and auto-exit trades with NO approval. Continue?',
      });
      if (!okc) return;
    }
    await window.api.execution.updateConfig({ automationMode: mode });
  });

  const onApprove = (p: ExecProposalRow) => run(async () => {
    // Paper = 1-click. Live = type-to-confirm (guard against fat-finger live orders).
    if (isLive) {
      const typed = await window.dialog.prompt({
        title: `LIVE order — type ${p.ticker} to confirm approving ${p.kind} #${p.id}`,
      });
      if (typed?.trim().toUpperCase() !== p.ticker.toUpperCase()) {
        setError('Live approval cancelled (confirmation did not match).');
        return;
      }
    }
    const res = await window.api.execution.approveProposal(p.id);
    if (!res.ok) setError(`Approve failed: ${res.reason ?? 'unknown'}`);
  });

  const onReject = (p: ExecProposalRow) => run(async () => {
    const ok = await window.dialog.confirm({
      title: 'Reject proposal',
      message: `Reject ${p.kind} proposal for ${p.ticker} (#${p.id})?`,
    });
    if (ok) await window.api.execution.rejectProposal(p.id);
  });

  const ceiling = config?.capitalCeiling ?? 0;
  const deployed = risk?.capitalDeployed ?? 0;
  const deployedPct = ceiling > 0 ? Math.min(100, (deployed / ceiling) * 100) : 0;
  const dayPnl = (risk?.dayRealizedPnl ?? 0) + (risk?.dayUnrealizedPnl ?? 0);
  const tripThreshold = ceiling > 0 && config ? -(ceiling * config.dailyLossTripPct / 100) : null;

  const todayET = etDate(new Date().toISOString());

  // ── derive the day tabs ──────────────────────────────────────────────────
  const entries = useMemo<EntryRow[]>(() => {
    const live: EntryRow[] = recent
      .filter((p) => etDate(p.opened_at) === todayET)
      .map((p) => ({
        _key: `pos-${p.id}`, ticker: p.ticker, strategy: p.strategy, structure: p.structure,
        contracts: p.contracts, net_credit: p.entry_net_credit, max_loss: p.max_loss,
        pnl: p.current_pnl, status: p.status, at: p.opened_at, placed: true,
        sortAt: new Date(p.opened_at).getTime() || 0,
      }));
    const dry: EntryRow[] = dryRun
      .filter((d) => d.kind === 'entry' && d.et_date === todayET)
      .map((d) => ({
        _key: `dry-${d.id}`, ticker: d.ticker, strategy: d.strategy ?? '—', structure: d.structure ?? '—',
        contracts: d.contracts, net_credit: d.net_credit, max_loss: d.max_loss,
        pnl: null, status: 'dry-run', at: d.at, placed: false,
        sortAt: new Date(d.at).getTime() || 0,
      }));
    return [...live, ...dry];
  }, [recent, dryRun, todayET]);

  const exits = useMemo<ExitRow[]>(() => {
    const live: ExitRow[] = recent
      .filter((p) => p.closed_at && etDate(p.closed_at) === todayET)
      .map((p) => ({
        _key: `pos-${p.id}`, ticker: p.ticker, strategy: p.strategy, structure: p.structure,
        reason: p.close_reason ?? 'manual',
        cls: PROTECTIVE.has(p.close_reason ?? '') ? 'protective' : 'discretionary',
        pnl: p.current_pnl, at: p.closed_at!, placed: true,
        sortAt: new Date(p.closed_at!).getTime() || 0,
      }));
    const dry: ExitRow[] = dryRun
      .filter((d) => d.kind === 'exit' && d.et_date === todayET)
      .map((d) => ({
        _key: `dry-${d.id}`, ticker: d.ticker, strategy: d.strategy ?? '—', structure: d.structure ?? '—',
        reason: d.reason ?? 'exit',
        cls: PROTECTIVE.has(d.reason ?? '') ? 'protective' : 'discretionary',
        pnl: null, at: d.at, placed: false,
        sortAt: new Date(d.at).getTime() || 0,
      }));
    return [...live, ...dry];
  }, [recent, dryRun, todayET]);

  const REJECT_EVENTS = useMemo(() => new Set(['gate_reject', 'proposal_rejected', 'order_rejected', 'proposal_user_rejected']), []);
  const rejects = useMemo<RejectRow[]>(() => {
    return audit
      .filter((a) => REJECT_EVENTS.has(a.event) && etDate(a.at) === todayET)
      .map((a) => {
        let d: Record<string, unknown> = {};
        try { d = a.detail_json ? JSON.parse(a.detail_json) : {}; } catch { /* keep {} */ }
        return {
          _key: `aud-${a.id}`,
          ticker: typeof d.ticker === 'string' ? d.ticker : '—',
          event: a.event,
          reason: typeof d.reason === 'string' ? d.reason : a.event.replace(/_/g, ' '),
          at: a.at,
          sortAt: new Date(a.at).getTime() || 0,
        };
      });
  }, [audit, REJECT_EVENTS, todayET]);

  // ── live feed + timeline (today's audit) ──────────────────────────────────
  const todayAudit = useMemo(() => audit.filter((a) => etDate(a.at) === todayET), [audit, todayET]);

  const proposalCount = proposals.length;
  const needsAttention = proposalCount > 0;

  const TABS: { id: TabId; label: string; count?: number; attn?: boolean }[] = [
    { id: 'live', label: 'Live' },
    { id: 'proposals', label: 'Proposals', count: proposalCount, attn: needsAttention },
    { id: 'entries', label: 'Entries', count: entries.length },
    { id: 'exits', label: 'Exits', count: exits.length },
    { id: 'rejects', label: 'Rejects', count: rejects.length },
    { id: 'positions', label: 'Positions', count: positions.length },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div style={{ padding: 16, maxWidth: 1280, flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>🤝 Trading Desk</h2>
        {config && pill(isLive ? 'LIVE' : 'PAPER', isLive ? 'var(--danger)' : 'var(--accent)')}
        {pill(engineState.replace('_', ' ').toUpperCase(), STATE_COLOR[engineState] ?? 'var(--text-muted)')}
        {automationMode === 'unattended' && pill(armed ? '⚡ ARMED' : 'UNATTENDED', '#7c3aed')}
        {automationMode === 'dry_run' && pill('DRY-RUN', 'var(--warning)')}
        <span style={{ flex: 1 }} />
        <button onClick={refresh} disabled={busy}>↻ Refresh</button>
      </div>

      {error && (
        <div onClick={() => setError(null)} style={{
          background: '#3a1a1a', border: '1px solid var(--danger)', color: 'var(--text)',
          borderRadius: 6, padding: '8px 12px', marginBottom: 12, cursor: 'pointer',
        }}>{error} <span style={{ float: 'right' }}>✕</span></div>
      )}

      {/* ── Always-visible header: master control + capital (spec 08 §5.2) ── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <Panel title="Engine">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={onStart} disabled={busy || engineState === 'running' || killTripped}>▶ Start</button>
            <button onClick={onPause} disabled={busy || engineState !== 'running'}>⏸ Pause</button>
            <button onClick={onStop} disabled={busy || engineState === 'stopped'} className="danger" title="Master Stop = hard stop">■ Stop</button>
          </div>
          <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-muted)' }}>
            Broker: {state?.health.brokerConnected ? '🟢 connected' : '⚪ disconnected'}
            {' · '}health: {state?.health.healthy ? 'OK' : (state?.health.degradedReason ?? 'degraded')}
            <br />last cycle: {fmtTime(state?.health.lastCycleAt)}
          </div>
        </Panel>

        <Panel title="Automation (arm switch)">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => onSetAutomation('semi')} disabled={busy || automationMode === 'semi'}
              title="Approve every entry manually">Off</button>
            <button onClick={() => onSetAutomation('dry_run')} disabled={busy || automationMode === 'dry_run'}
              title="Decide everything, place nothing">Dry-run</button>
            <button onClick={() => onSetAutomation('unattended')} disabled={busy || automationMode === 'unattended' || isLive}
              title={isLive ? 'PAPER ONLY — auto-entry is disabled in live' : 'Auto-enter + auto-exit, unattended'}
              style={armed ? { background: '#7c3aed', color: '#fff' } : undefined}>⚡ Armed</button>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            {automationMode === 'unattended'
              ? (armed ? '⚡ Armed — auto-entry active (paper).' : 'Unattended set; arms once running on paper.')
              : automationMode === 'dry_run'
                ? 'Decides everything, places nothing → dry-run log.'
                : 'Manual — every entry needs approval.'}
            <br /><strong style={{ color: 'var(--warning)' }}>Paper-only</strong> — live always requires approval.
          </div>
        </Panel>

        <Panel title="Kill Switch">
          {killTripped
            ? <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 8 }}>
                ⛔ TRIPPED — {state?.killSwitch.reason ?? 'manual'}
              </div>
            : <div style={{ color: 'var(--success)', fontSize: 13, marginBottom: 8 }}>✓ armed (not tripped)</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onKillTrip} disabled={busy || killTripped} className="danger">Trip</button>
            <button onClick={onKillClear} disabled={busy || !killTripped}>Clear</button>
          </div>
        </Panel>

        <Panel title="Capital">
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div>Deployed: <strong>{fmtMoney(deployed)}</strong> / {fmtMoney(ceiling)}</div>
            <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden', margin: '4px 0 8px' }}>
              <div style={{ width: `${deployedPct}%`, height: '100%', background: deployedPct > 90 ? 'var(--danger)' : 'var(--accent)' }} />
            </div>
            <div>Day P&L: <strong style={{ color: dayPnl < 0 ? 'var(--danger)' : 'var(--success)' }}>{fmtMoney2(dayPnl)}</strong></div>
            <div style={{ color: 'var(--text-muted)' }}>
              realized {fmtMoney2(risk?.dayRealizedPnl)} · unrealized {fmtMoney2(risk?.dayUnrealizedPnl)}
            </div>
            {tripThreshold !== null && (
              <div style={{ color: 'var(--text-muted)' }}>trip at {fmtMoney(tripThreshold)} ({config?.dailyLossTripPct}%)</div>
            )}
            {state && (
              <div style={{ color: (state.drawdownPct ?? 0) > 0 ? 'var(--warning)' : 'var(--text-muted)' }}>
                drawdown {(state.drawdownPct ?? 0).toFixed(1)}% · HWM {fmtMoney(risk?.equityHighWater)}
                {config && config.drawdownThrottlePct > 0 && (state.drawdownPct ?? 0) >= config.drawdownThrottlePct
                  ? ` · throttled ×${config.drawdownThrottleFactor}`
                  : ''}
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ── Tab bar ── */}
      <div className="td-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={['td-tab', tab === t.id ? 'active' : '', t.attn ? 'attn' : ''].filter(Boolean).join(' ')}
            onClick={() => setTab(t.id)}
            role="tab"
            aria-selected={tab === t.id}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="td-tab-count">{t.count}</span>}
            {t.id === 'proposals' && t.attn && <span title="Needs your approval"> ⚠</span>}
          </button>
        ))}
      </div>

      {/* ── Tab panels ── */}
      {tab === 'live' && (
        <LiveTab audit={todayAudit} armed={armed} automationMode={automationMode} engineState={engineState} />
      )}

      {tab === 'proposals' && (
        <Grid<ExecProposalRow & Record<string, unknown>>
          rows={proposals as (ExecProposalRow & Record<string, unknown>)[]}
          getKey={(p) => `prop-${p.id}`}
          defaultSort="created_at"
          empty="No pending proposals — nothing needs your approval."
          cols={[
            { key: 'kind', label: 'Kind', render: (p) => pill(p.kind, p.kind === 'exit' ? 'var(--warning)' : 'var(--accent)') },
            { key: 'ticker', label: 'Ticker', render: (p) => <strong>{p.ticker}</strong> },
            { key: 'strategy', label: 'Strategy', render: (p) => p.strategy },
            { key: 'structure', label: 'Structure', render: (p) => <>{p.structure}{p.close_reason ? ` (${p.close_reason})` : ''}</> },
            { key: 'net_credit', label: 'Net credit', num: true, render: (p) => fmtMoney2(p.net_credit) },
            { key: 'max_loss', label: 'Max loss', num: true, render: (p) => fmtMoney(p.max_loss) },
            { key: 'contracts', label: 'Qty', num: true, render: (p) => p.contracts },
            { key: 'expires_at', label: 'Expires', render: (p) => fmtTime(p.expires_at) },
            { key: '', label: 'Actions', render: (p) => (
              <>
                <button onClick={() => onApprove(p as ExecProposalRow)} disabled={busy} style={{ marginRight: 6 }}>
                  {isLive ? 'Approve (live)' : 'Approve'}
                </button>
                <button onClick={() => onReject(p as ExecProposalRow)} disabled={busy} className="danger">Reject</button>
              </>
            ) },
          ]}
        />
      )}

      {tab === 'entries' && (
        <Grid<EntryRow>
          rows={entries}
          getKey={(r) => r._key}
          defaultSort="sortAt"
          empty="No entries today."
          cols={[
            { key: 'at', label: 'Time', render: (r) => fmtClock(r.at) },
            { key: 'ticker', label: 'Ticker', render: (r) => <strong>{r.ticker}</strong> },
            { key: 'strategy', label: 'Strategy', render: (r) => r.strategy },
            { key: 'structure', label: 'Structure', render: (r) => r.structure },
            { key: 'contracts', label: 'Qty', num: true, render: (r) => r.contracts ?? '—' },
            { key: 'net_credit', label: 'Net credit', num: true, render: (r) => fmtMoney2(r.net_credit) },
            { key: 'max_loss', label: 'Max loss', num: true, render: (r) => fmtMoney(r.max_loss) },
            { key: 'pnl', label: 'P&L', num: true, cell: (r) => (r.pnl ?? 0) < 0 ? 'neg' : (r.pnl ?? 0) > 0 ? 'pos' : undefined, render: (r) => fmtMoney2(r.pnl) },
            { key: 'placed', label: 'Status', render: (r) => r.placed
              ? <span className="td-badge placed">{r.status}</span>
              : <span className="td-badge dryrun">dry-run · not placed</span> },
          ]}
        />
      )}

      {tab === 'exits' && (
        <Grid<ExitRow>
          rows={exits}
          getKey={(r) => r._key}
          defaultSort="sortAt"
          empty="No exits today."
          cols={[
            { key: 'at', label: 'Time', render: (r) => fmtClock(r.at) },
            { key: 'ticker', label: 'Ticker', render: (r) => <strong>{r.ticker}</strong> },
            { key: 'strategy', label: 'Strategy', render: (r) => r.strategy },
            { key: 'structure', label: 'Structure', render: (r) => r.structure },
            { key: 'cls', label: 'Type', render: (r) => <span className={`td-badge ${r.cls}`}>{r.cls}</span> },
            { key: 'reason', label: 'Reason', render: (r) => r.reason },
            { key: 'pnl', label: 'P&L', num: true, cell: (r) => (r.pnl ?? 0) < 0 ? 'neg' : (r.pnl ?? 0) > 0 ? 'pos' : undefined, render: (r) => fmtMoney2(r.pnl) },
            { key: 'placed', label: 'Status', render: (r) => r.placed
              ? <span className="td-badge placed">placed</span>
              : <span className="td-badge dryrun">dry-run · not placed</span> },
          ]}
        />
      )}

      {tab === 'rejects' && (
        <Grid<RejectRow>
          rows={rejects}
          getKey={(r) => r._key}
          defaultSort="sortAt"
          empty="No rejected candidates today."
          cols={[
            { key: 'at', label: 'Time', render: (r) => fmtClock(r.at) },
            { key: 'ticker', label: 'Ticker', render: (r) => <strong>{r.ticker}</strong> },
            { key: 'event', label: 'Gate', render: (r) => <span className="td-badge protective">{r.event.replace(/_/g, ' ')}</span> },
            { key: 'reason', label: 'Reason', render: (r) => r.reason },
          ]}
        />
      )}

      {tab === 'positions' && (
        <Grid<ExecPositionRow & Record<string, unknown>>
          rows={positions as (ExecPositionRow & Record<string, unknown>)[]}
          getKey={(p) => `pos-${p.id}`}
          defaultSort="opened_at"
          empty="No open positions."
          cols={[
            { key: 'ticker', label: 'Ticker', render: (p) => <strong>{p.ticker}</strong> },
            { key: 'strategy', label: 'Strategy', render: (p) => p.strategy },
            { key: 'structure', label: 'Structure', render: (p) => p.structure },
            { key: 'contracts', label: 'Qty', num: true, render: (p) => p.contracts },
            { key: 'entry_net_credit', label: 'Entry credit', num: true, render: (p) => fmtMoney2(p.entry_net_credit) },
            { key: 'current_mark', label: 'Mark', num: true, render: (p) => fmtMoney2(p.current_mark) },
            { key: 'current_pnl', label: 'P&L', num: true, cell: (p) => (p.current_pnl ?? 0) < 0 ? 'neg' : (p.current_pnl ?? 0) > 0 ? 'pos' : undefined, render: (p) => fmtMoney2(p.current_pnl) },
            { key: 'status', label: 'Status', render: (p) => p.status },
            { key: 'opened_at', label: 'Opened', render: (p) => fmtTime(p.opened_at) },
          ]}
        />
      )}

      {tab === 'activity' && (
        <Grid<ExecAuditRow & Record<string, unknown>>
          rows={audit as (ExecAuditRow & Record<string, unknown>)[]}
          getKey={(a) => `aud-${a.id}`}
          defaultSort="id"
          empty="No activity yet."
          cols={[
            { key: 'at', label: 'Time', render: (a) => fmtTime(a.at) },
            { key: 'event', label: 'Event', render: (a) => a.event },
            { key: '', label: 'Ref', render: (a) => a.ref_table ? `${a.ref_table}#${a.ref_id ?? '?'}` : '—' },
            { key: '', label: 'Detail', render: (a) => (
              <span style={{ color: 'var(--text-muted)', display: 'inline-block', maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.detail_json ?? ''}
              </span>
            ) },
          ]}
        />
      )}
    </div>
  );
}

// ─── Live tab: timeline + feed ─────────────────────────────────────────────────

const OPEN_MIN = 9 * 60 + 30;   // 09:30 ET
const CLOSE_MIN = 16 * 60;      // 16:00 ET
const SPAN_START = 9 * 60;      // 09:00 left edge
const SPAN_END = 16 * 60 + 30;  // 16:30 right edge

function spanPct(min: number): number {
  return Math.max(0, Math.min(100, ((min - SPAN_START) / (SPAN_END - SPAN_START)) * 100));
}

/** Left offset within the inset (12px) track: 12px + (track width) * pct/100. */
function trackLeft(pct: number): string {
  return `calc(12px + (100% - 24px) * ${pct} / 100)`;
}

function LiveTab({ audit, armed, automationMode, engineState }: {
  audit: ExecAuditRow[];
  armed: boolean;
  automationMode: string;
  engineState: string;
}) {
  // Pinned timeline events (the "story of the day").
  const pins = audit
    .map((a) => {
      const desc = describeEvent(a);
      const min = etMinutes(a.at);
      return desc.pin && min !== null ? { id: a.id, min, color: desc.color, label: desc.pin, at: a.at } : null;
    })
    .filter((x): x is { id: number; min: number; color: string; label: string; at: string } => x !== null);

  const winStart = spanPct(OPEN_MIN + 30); // entry window ≈ 10:00 ET → 15:00 ET (config default)
  const winEnd = spanPct(15 * 60);

  return (
    <div>
      {/* ── daily activity timeline (spec 08 §5.5) ── */}
      <div className="td-timeline">
        <div className="td-timeline-track" />
        {/* entry window shading */}
        <div className="td-timeline-window" style={{ left: trackLeft(winStart), width: `calc((100% - 24px) * ${winEnd - winStart} / 100)` }} />
        {/* open / close markers */}
        <div className="td-timeline-label" style={{ left: trackLeft(spanPct(OPEN_MIN)) }}>9:30 open</div>
        <div className="td-timeline-label" style={{ left: trackLeft(spanPct(CLOSE_MIN)) }}>4:00 close</div>
        {pins.length === 0 && <div className="td-timeline-empty">No pinned events yet today</div>}
        {pins.map((p) => (
          <div
            key={p.id}
            className="td-timeline-ev"
            style={{ left: trackLeft(spanPct(p.min)), background: p.color }}
            title={`${fmtClock(p.at)} · ${p.label}`}
          />
        ))}
      </div>

      {/* ── live feed ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px' }}>
        <h3 style={{ margin: 0 }}>Live activity</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {engineState === 'running'
            ? (armed ? '⚡ armed — auto-trading (paper)' : automationMode === 'dry_run' ? 'dry-run — deciding, placing nothing' : 'running — manual approval')
            : 'engine stopped'}
        </span>
      </div>
      {audit.length === 0 ? (
        <div className="td-grid-empty">No activity today.</div>
      ) : (
        <ul className="td-feed">
          {audit.map((a) => {
            const d = describeEvent(a);
            return (
              <li key={a.id} className="td-feed-item">
                <span className="td-feed-time">{fmtClock(a.at)}</span>
                <span className="td-feed-dot" style={{ color: d.color }}>●</span>
                <span className="td-feed-text">{d.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── tiny presentational helpers ──────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8,
      padding: 14, minWidth: 240, flex: '1 1 240px',
    }}>
      <div style={{ fontSize: 12, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 10, letterSpacing: 0.5 }}>{title}</div>
      {children}
    </div>
  );
}

export default TradingDeskView;
