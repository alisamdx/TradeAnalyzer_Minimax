import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ExecEngineStateView,
  ExecConfig,
  ExecRiskState,
  ExecPositionRow,
  ExecProposalRow,
  ExecAuditRow,
} from '@shared/types.js';

// The 🤝 Execution control surface (Requirements/v2-execution §4, Phase 5c).
// Drives the (mock-backed) ExecutionEngine entirely through window.api.execution.*.
// Engine starts `stopped`; nothing here places a real order — the broker is the
// deterministic mock until the IBKR adapter lands (Phase 6).

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

// ─── component ──────────────────────────────────────────────────────────────

export function TradingDeskView() {
  const [state, setState] = useState<ExecEngineStateView | null>(null);
  const [config, setConfig] = useState<ExecConfig | null>(null);
  const [risk, setRisk] = useState<ExecRiskState | null>(null);
  const [positions, setPositions] = useState<ExecPositionRow[]>([]);
  const [proposals, setProposals] = useState<ExecProposalRow[]>([]);
  const [audit, setAudit] = useState<ExecAuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [s, c, r, p, pr, a] = await Promise.all([
        window.api.execution.getState(),
        window.api.execution.getConfig(),
        window.api.execution.getRiskState(),
        window.api.execution.getPositions(),
        window.api.execution.getProposals(),
        window.api.execution.getAudit(50),
      ]);
      setState(s); setConfig(c); setRisk(r);
      setPositions(p); setProposals(pr); setAudit(a);
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

  return (
    <div style={{ padding: 16, maxWidth: 1200, flex: 1, minHeight: 0, overflowY: 'auto' }}>
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

      {/* ── Master control + capital ── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
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

      {/* ── Proposals queue ── */}
      <h3 style={{ marginBottom: 8 }}>Proposals ({proposals.length})</h3>
      {proposals.length === 0
        ? <div className="empty" style={{ marginBottom: 20 }}>No pending proposals.</div>
        : (
          <table className="data-table" style={{ width: '100%', fontSize: 13, marginBottom: 20 }}>
            <thead>
              <tr>
                <Th>#</Th><Th>Kind</Th><Th>Ticker</Th><Th>Strategy</Th><Th>Structure</Th>
                <Th right>Net credit</Th><Th right>Max loss</Th><Th right>Qty</Th>
                <Th>Expires</Th><Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {proposals.map(p => (
                <tr key={p.id}>
                  <Td>{p.id}</Td>
                  <Td>{pill(p.kind, p.kind === 'exit' ? 'var(--warning)' : 'var(--accent)')}</Td>
                  <Td><strong>{p.ticker}</strong></Td>
                  <Td>{p.strategy}</Td>
                  <Td>{p.structure}{p.close_reason ? ` (${p.close_reason})` : ''}</Td>
                  <Td right>{fmtMoney2(p.net_credit)}</Td>
                  <Td right>{fmtMoney(p.max_loss)}</Td>
                  <Td right>{p.contracts}</Td>
                  <Td>{fmtTime(p.expires_at)}</Td>
                  <Td>
                    <button onClick={() => onApprove(p)} disabled={busy} style={{ marginRight: 6 }}>
                      {isLive ? 'Approve (live)' : 'Approve'}
                    </button>
                    <button onClick={() => onReject(p)} disabled={busy} className="danger">Reject</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {/* ── Open positions ── */}
      <h3 style={{ marginBottom: 8 }}>Open positions ({positions.length})</h3>
      {positions.length === 0
        ? <div className="empty" style={{ marginBottom: 20 }}>No open positions.</div>
        : (
          <table className="data-table" style={{ width: '100%', fontSize: 13, marginBottom: 20 }}>
            <thead>
              <tr>
                <Th>#</Th><Th>Ticker</Th><Th>Strategy</Th><Th>Structure</Th><Th right>Qty</Th>
                <Th right>Entry credit</Th><Th right>Mark</Th><Th right>P&L</Th>
                <Th>Status</Th><Th>Opened</Th>
              </tr>
            </thead>
            <tbody>
              {positions.map(p => (
                <tr key={p.id}>
                  <Td>{p.id}</Td>
                  <Td><strong>{p.ticker}</strong></Td>
                  <Td>{p.strategy}</Td>
                  <Td>{p.structure}</Td>
                  <Td right>{p.contracts}</Td>
                  <Td right>{fmtMoney2(p.entry_net_credit)}</Td>
                  <Td right>{fmtMoney2(p.current_mark)}</Td>
                  <Td right style={{ color: (p.current_pnl ?? 0) < 0 ? 'var(--danger)' : 'var(--success)' }}>{fmtMoney2(p.current_pnl)}</Td>
                  <Td>{p.status}</Td>
                  <Td>{fmtTime(p.opened_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {/* ── Audit log ── */}
      <h3 style={{ marginBottom: 8 }}>Activity log</h3>
      {audit.length === 0
        ? <div className="empty">No activity yet.</div>
        : (
          <table className="data-table" style={{ width: '100%', fontSize: 12 }}>
            <thead><tr><Th>Time</Th><Th>Event</Th><Th>Ref</Th><Th>Detail</Th></tr></thead>
            <tbody>
              {audit.map(a => (
                <tr key={a.id}>
                  <Td>{fmtTime(a.at)}</Td>
                  <Td>{a.event}</Td>
                  <Td>{a.ref_table ? `${a.ref_table}#${a.ref_id ?? '?'}` : '—'}</Td>
                  <Td style={{ color: 'var(--text-muted)', maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.detail_json ?? ''}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
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

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th style={{ textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap' }}>{children}</th>;
}

function Td({ children, right, style }: { children?: React.ReactNode; right?: boolean; style?: React.CSSProperties }) {
  return <td style={{ textAlign: right ? 'right' : 'left', ...style }}>{children}</td>;
}

export default TradingDeskView;
