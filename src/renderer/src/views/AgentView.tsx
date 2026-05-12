import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStatus, AgentTrade, AgentLesson, AgentRecommendation, AgentMemorySnapshot } from '@shared/types.js';

type Tab = 'overview' | 'trades' | 'lessons' | 'recommendations' | 'memory' | 'run';

const fmt$ = (n: number | null | undefined) =>
  n == null ? '—' : n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
const fmtPct = (n: number | null | undefined) =>
  n == null ? '—' : `${(n * 100).toFixed(1)}%`;
const fmtDate = (s: string | null | undefined) =>
  s ? s.slice(0, 10) : '—';

export function AgentView() {
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [trades, setTrades] = useState<AgentTrade[]>([]);
  const [lessons, setLessons] = useState<AgentLesson[]>([]);
  const [recs, setRecs] = useState<AgentRecommendation[]>([]);
  const [memory, setMemory] = useState<AgentMemorySnapshot | null>(null);
  const [tradeFilter, setTradeFilter] = useState<'open' | 'closed' | 'all'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Settings for agent paths
  const [agentDbPath, setAgentDbPath] = useState('');
  const [agentProjectPath, setAgentProjectPath] = useState('');
  const [dbConnected, setDbConnected] = useState(false);

  // Run phase state
  const [runPhase, setRunPhase] = useState('run');
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Load settings on mount
  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setAgentDbPath(s.agentDbPath ?? '');
      setAgentProjectPath(s.agentProjectPath ?? '');
      if (s.agentDbPath) {
        setDbConnected(true);
        loadAllData();
      }
    }).catch(() => {});
  }, []);

  // Subscribe to log stream
  useEffect(() => {
    const offLog = window.api.agent.onLog(({ line }) => {
      setLogs((prev) => [...prev.slice(-499), line]);
    });
    const offDone = window.api.agent.onPhaseDone(({ phase, code }) => {
      setLogs((prev) => [...prev, `✓ Phase "${phase}" finished (exit ${code ?? '?'})`]);
      setRunning(false);
      loadAllData();
    });
    return () => { offLog(); offDone(); };
  }, []);

  // Scroll logs to bottom
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const loadAllData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, t, l, r, m] = await Promise.all([
        window.api.agent.getStatus(),
        window.api.agent.getTrades('all'),
        window.api.agent.getLessons(50),
        window.api.agent.getRecommendations(),
        window.api.agent.getMemory()
      ]);
      setStatus(s);
      setTrades(t);
      setLessons(l);
      setRecs(r);
      setMemory(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleConnect = async () => {
    try {
      const opened = await window.api.agent.openDb(agentDbPath);
      if (!opened) {
        setError('Could not open agent DB — check the path.');
        return;
      }
      await window.api.settings.setAll({ agentDbPath, agentProjectPath });
      setDbConnected(true);
      await loadAllData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleRunPhase = async () => {
    if (!agentProjectPath) {
      setError('Set the agent project path in Settings → Agent first.');
      return;
    }
    setRunning(true);
    setLogs((prev) => [...prev, `▶ Starting phase: ${runPhase}`]);
    try {
      await window.api.agent.runPhase(runPhase, agentProjectPath);
    } catch (e) {
      setError((e as Error).message);
      setRunning(false);
    }
  };

  const filteredTrades = tradeFilter === 'all' ? trades
    : trades.filter((t) => (tradeFilter === 'open' ? t.status === 'open' : t.status !== 'open'));

  // ── Not connected state ────────────────────────────────────────────────────
  if (!dbConnected) {
    return (
      <div className="agent-view" style={{ padding: 24 }}>
        <h2>🤖 TraderAgent</h2>
        <p style={{ color: '#95a5a6', marginBottom: 16 }}>
          Connect to the TraderAgent SQLite database to view trades, lessons, and agent memory.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 }}>
          <label style={{ fontSize: 12, color: '#bdc3c7' }}>Agent DB path (.sqlite)</label>
          <input
            type="text"
            value={agentDbPath}
            onChange={(e) => setAgentDbPath(e.target.value)}
            placeholder="C:\Shaky\Projects\TraderAgent\data\trader.sqlite"
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          <label style={{ fontSize: 12, color: '#bdc3c7', marginTop: 8 }}>Agent project path (for running phases)</label>
          <input
            type="text"
            value={agentProjectPath}
            onChange={(e) => setAgentProjectPath(e.target.value)}
            placeholder="C:\Shaky\Projects\TraderAgent"
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          />
          {error && <div style={{ color: '#e74c3c', fontSize: 12 }}>{error}</div>}
          <button onClick={handleConnect} disabled={!agentDbPath} style={{ marginTop: 8, alignSelf: 'flex-start' }}>
            Connect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '12px 20px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>🤖 TraderAgent</h2>
        <span style={{ fontSize: 11, color: '#2ecc71', background: '#1a3a2a', padding: '2px 8px', borderRadius: 4 }}>
          ● Connected
        </span>
        <button onClick={loadAllData} disabled={loading} style={{ marginLeft: 'auto', fontSize: 12 }}>
          {loading ? '⟳ Loading…' : '↻ Refresh'}
        </button>
        <button onClick={() => { setDbConnected(false); window.api.agent.closeDb().catch(() => {}); }}
          style={{ fontSize: 12, background: '#2c2c2c' }}>
          Disconnect
        </button>
      </div>

      {error && (
        <div style={{ margin: '8px 20px', padding: '6px 10px', background: '#3a1a1a', color: '#e74c3c', borderRadius: 4, fontSize: 12 }}
          onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      {/* Tabs */}
      <div style={{ padding: '8px 20px 0', display: 'flex', gap: 4, borderBottom: '1px solid #2c2c2c' }}>
        {(['overview', 'trades', 'lessons', 'recommendations', 'memory', 'run'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '4px 12px', fontSize: 12, borderRadius: '4px 4px 0 0',
              background: tab === t ? '#1a1a2e' : 'transparent',
              borderBottom: tab === t ? '2px solid #3498db' : '2px solid transparent',
              color: tab === t ? '#3498db' : '#95a5a6'
            }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>

        {/* Overview */}
        {tab === 'overview' && status && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
              <StatCard label="Open Trades" value={String(status.openTrades)} />
              <StatCard label="Closed Trades" value={String(status.closedTrades)} />
              <StatCard label="Total P&L" value={fmt$(status.totalPl)}
                color={status.totalPl >= 0 ? '#2ecc71' : '#e74c3c'} />
              <StatCard label="Win Rate" value={fmtPct(status.winRate)} />
              <StatCard label="Confidence" value={fmtPct(status.confidence)} />
              <StatCard label="Last Run" value={fmtDate(status.lastRunAt)} />
            </div>
            {memory && (
              <div style={{ marginTop: 8 }}>
                <h4 style={{ marginBottom: 8 }}>Agent Memory</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <WeightBar label="Scoring Weights" data={memory.weights} />
                  <WeightBar label="Win Rate by Mode" data={memory.winRateByMode} pct />
                </div>
                {memory.topLessons.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <h5 style={{ marginBottom: 6 }}>Top Lessons</h5>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: '#bdc3c7' }}>
                      {memory.topLessons.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Trades */}
        {tab === 'trades' && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {(['all', 'open', 'closed'] as const).map((f) => (
                <button key={f} onClick={() => setTradeFilter(f)}
                  style={{ fontSize: 12, background: tradeFilter === f ? '#3498db' : '#2c2c2c' }}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#95a5a6', alignSelf: 'center' }}>
                {filteredTrades.length} trade{filteredTrades.length !== 1 ? 's' : ''}
              </span>
            </div>
            {filteredTrades.length === 0 ? (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>No trades found.</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: '#95a5a6', borderBottom: '1px solid #2c2c2c' }}>
                    {['#', 'Ticker', 'Strategy', 'Strike', 'Exp', 'DTE', 'Premium', 'Capital', 'Score', 'Status', 'Entry', 'Close', 'P&L', 'Reason'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredTrades.map((t) => (
                    <tr key={t.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                      <td style={{ padding: '4px 8px', color: '#95a5a6' }}>{t.id}</td>
                      <td style={{ padding: '4px 8px', fontWeight: 600 }}>{t.ticker}</td>
                      <td style={{ padding: '4px 8px' }}>{t.strategy}</td>
                      <td style={{ padding: '4px 8px' }}>${t.strike}</td>
                      <td style={{ padding: '4px 8px' }}>{fmtDate(t.expiration)}</td>
                      <td style={{ padding: '4px 8px' }}>{t.dteAtEntry}</td>
                      <td style={{ padding: '4px 8px' }}>${t.entryPremium.toFixed(2)}</td>
                      <td style={{ padding: '4px 8px' }}>${t.capitalRequired.toLocaleString()}</td>
                      <td style={{ padding: '4px 8px' }}>{t.compositeScore.toFixed(2)}</td>
                      <td style={{ padding: '4px 8px' }}>
                        <span style={{
                          padding: '1px 6px', borderRadius: 3, fontSize: 11,
                          background: t.status === 'open' ? '#1a3a2a' : '#2c2c2c',
                          color: t.status === 'open' ? '#2ecc71' : '#95a5a6'
                        }}>{t.status}</span>
                      </td>
                      <td style={{ padding: '4px 8px' }}>{fmtDate(t.entryDate)}</td>
                      <td style={{ padding: '4px 8px' }}>{fmtDate(t.closeDate)}</td>
                      <td style={{ padding: '4px 8px', color: (t.actualPl ?? 0) >= 0 ? '#2ecc71' : '#e74c3c' }}>
                        {fmt$(t.actualPl)}
                      </td>
                      <td style={{ padding: '4px 8px', color: '#95a5a6', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.closeReason ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Lessons */}
        {tab === 'lessons' && (
          <div>
            {lessons.length === 0 ? (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>No lessons recorded yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {lessons.map((l) => (
                  <div key={l.id} style={{ background: '#1a1a2e', borderRadius: 6, padding: '10px 14px', borderLeft: '3px solid #3498db' }}>
                    <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 12 }}>
                      <span style={{ color: '#f39c12', fontWeight: 600 }}>{l.gapCause}</span>
                      <span style={{ color: '#e74c3c' }}>{fmt$(l.gapAmountUsd)}</span>
                      <span style={{ color: '#95a5a6' }}>({(l.gapPct * 100).toFixed(1)}%)</span>
                      <span style={{ marginLeft: 'auto', color: '#95a5a6' }}>Trade #{l.tradeId} · {fmtDate(l.createdAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#bdc3c7', lineHeight: 1.5 }}>{l.narrative}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Recommendations */}
        {tab === 'recommendations' && (
          <div>
            {recs.length === 0 ? (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>No recommendations yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {recs.map((r) => (
                  <div key={r.id} style={{
                    background: '#1a1a2e', borderRadius: 6, padding: '10px 14px',
                    borderLeft: `3px solid ${r.severity === 'high' ? '#e74c3c' : r.severity === 'medium' ? '#f39c12' : '#95a5a6'}`
                  }}>
                    <div style={{ display: 'flex', gap: 10, marginBottom: 6, fontSize: 12, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: '#3498db' }}>{r.category}</span>
                      <span style={{
                        padding: '1px 6px', borderRadius: 3, fontSize: 11,
                        background: r.severity === 'high' ? '#3a1a1a' : r.severity === 'medium' ? '#3a2a1a' : '#2c2c2c',
                        color: r.severity === 'high' ? '#e74c3c' : r.severity === 'medium' ? '#f39c12' : '#95a5a6'
                      }}>{r.severity}</span>
                      <span style={{
                        padding: '1px 6px', borderRadius: 3, fontSize: 11,
                        background: r.status === 'pending' ? '#1a2a3a' : '#2c2c2c',
                        color: r.status === 'pending' ? '#3498db' : '#95a5a6'
                      }}>{r.status}</span>
                      <span style={{ marginLeft: 'auto', color: '#95a5a6' }}>{fmtDate(r.createdAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#bdc3c7', marginBottom: 6 }}>{r.description}</div>
                    <div style={{ fontSize: 12, color: '#95a5a6', fontStyle: 'italic' }}>
                      → {r.proposedChange}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Memory */}
        {tab === 'memory' && (
          <div>
            {!memory ? (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>No memory snapshot found.</div>
            ) : (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                  <StatCard label="Trade Count" value={String(memory.tradeCount)} />
                  <StatCard label="Confidence" value={fmtPct(memory.confidence)} />
                  <StatCard label="Saved" value={fmtDate(memory.savedAt)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                  <div>
                    <h4 style={{ marginBottom: 10 }}>Scoring Weights</h4>
                    {Object.entries(memory.weights).map(([k, v]) => (
                      <BarRow key={k} label={k} value={v} max={1} />
                    ))}
                  </div>
                  <div>
                    <h4 style={{ marginBottom: 10 }}>Win Rate by Mode</h4>
                    {Object.entries(memory.winRateByMode).map(([k, v]) => (
                      <BarRow key={k} label={k} value={v} max={1} pct />
                    ))}
                    {Object.keys(memory.winRateByMode).length === 0 && (
                      <div style={{ color: '#95a5a6', fontSize: 12 }}>No closed trades yet.</div>
                    )}
                  </div>
                </div>
                {memory.topLessons.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <h4 style={{ marginBottom: 8 }}>Top Lessons</h4>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#bdc3c7', lineHeight: 1.8 }}>
                      {memory.topLessons.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Run */}
        {tab === 'run' && (
          <div>
            <h4 style={{ marginBottom: 12 }}>Run Agent Phase</h4>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={runPhase}
                onChange={(e) => setRunPhase(e.target.value)}
                disabled={running}
                style={{ fontSize: 13 }}
              >
                {['run', 'scout', 'decide', 'trade', 'monitor', 'learn'].map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button onClick={handleRunPhase} disabled={running || !agentProjectPath}
                style={{ background: running ? '#2c2c2c' : '#2980b9', fontSize: 13 }}>
                {running ? '⟳ Running…' : '▶ Run'}
              </button>
              <button onClick={() => setLogs([])} disabled={running} style={{ fontSize: 12, background: '#2c2c2c' }}>
                Clear logs
              </button>
              {!agentProjectPath && (
                <span style={{ fontSize: 12, color: '#f39c12' }}>
                  ⚠ Set agent project path in Settings → Agent
                </span>
              )}
            </div>
            <div style={{
              background: '#0d0d0d', borderRadius: 6, padding: 12, fontFamily: 'monospace',
              fontSize: 12, color: '#bdc3c7', height: 440, overflowY: 'auto',
              border: '1px solid #2c2c2c', whiteSpace: 'pre-wrap', wordBreak: 'break-all'
            }}>
              {logs.length === 0
                ? <span style={{ color: '#444' }}>No output yet. Select a phase and click Run.</span>
                : logs.map((l, i) => (
                  <div key={i} style={{
                    color: l.startsWith('[stderr]') ? '#e74c3c'
                      : l.startsWith('✓') ? '#2ecc71'
                      : l.startsWith('▶') ? '#3498db'
                      : '#bdc3c7'
                  }}>{l}</div>
                ))
              }
              <div ref={logsEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 6, padding: '12px 16px' }}>
      <div style={{ fontSize: 11, color: '#95a5a6', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? '#ecf0f1' }}>{value}</div>
    </div>
  );
}

function BarRow({ label, value, max, pct }: { label: string; value: number; max: number; pct?: boolean }) {
  const pctVal = Math.min(1, Math.max(0, value / max));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
        <span style={{ color: '#bdc3c7' }}>{label}</span>
        <span style={{ color: '#ecf0f1', fontWeight: 600 }}>
          {pct ? `${(value * 100).toFixed(1)}%` : value.toFixed(3)}
        </span>
      </div>
      <div style={{ height: 6, background: '#2c2c2c', borderRadius: 3 }}>
        <div style={{ height: '100%', width: `${pctVal * 100}%`, background: '#3498db', borderRadius: 3 }} />
      </div>
    </div>
  );
}

function WeightBar({ label, data, pct }: { label: string; data: Record<string, number>; pct?: boolean }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <div>
      <h5 style={{ marginBottom: 8 }}>{label}</h5>
      {entries.map(([k, v]) => <BarRow key={k} label={k} value={v} max={1} pct={pct} />)}
    </div>
  );
}
