import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStatus, AgentTrade, AgentLesson, AgentRecommendation, AgentMemorySnapshot, AgentConfig, Watchlist } from '@shared/types.js';

type Tab = 'overview' | 'trades' | 'lessons' | 'recommendations' | 'memory' | 'run' | 'config';

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
  const [selectedTradeId, setSelectedTradeId] = useState<number | null>(null);
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

  // Config state
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<AgentConfig | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Email state
  const [emailSending, setEmailSending] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Watchlist state
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [wlPickerTradeId, setWlPickerTradeId] = useState<number | null>(null);
  const [wlAdding, setWlAdding] = useState<number | null>(null);
  const [wlMsg, setWlMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Load settings on mount
  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setAgentDbPath(s.agentDbPath ?? '');
      setAgentProjectPath(s.agentProjectPath ?? '');
      if (s.agentDbPath) {
        setDbConnected(true);
        loadAllData();
        if (s.agentProjectPath) loadConfig(s.agentProjectPath);
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

  // Load watchlists when db is connected
  useEffect(() => {
    if (!dbConnected) return;
    window.api.watchlists.list().then(setWatchlists).catch(() => {});
  }, [dbConnected]);

  // Close watchlist picker on outside click
  useEffect(() => {
    if (wlPickerTradeId === null) return;
    const close = () => setWlPickerTradeId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [wlPickerTradeId]);

  const loadConfig = useCallback(async (projectPath: string) => {
    if (!projectPath) return;
    try {
      const c = await window.api.agent.readConfig(projectPath);
      setConfig(c);
      setConfigDraft(c);
    } catch { /* ignore */ }
  }, []);

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
      await loadConfig(agentProjectPath);
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

  const handleDeleteTrade = useCallback(async (trade: AgentTrade) => {
    const confirmed = await window.dialog.confirm({
      title: 'Delete trade',
      message: `Delete trade #${trade.id} (${trade.ticker} ${trade.strategy} $${trade.strike})? This removes it from all tracking and cannot be undone.`
    });
    if (!confirmed) return;
    try {
      await window.api.agent.deleteTrade(trade.id);
      setSelectedTradeId(null);
      await loadAllData();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [loadAllData]);

  const handleAddToWatchlist = useCallback(async (watchlistId: number, ticker: string, tradeId: number) => {
    setWlPickerTradeId(null);
    setWlAdding(tradeId);
    setWlMsg(null);
    try {
      await window.api.watchlists.items.add(watchlistId, ticker, null);
      setWlMsg({ type: 'ok', text: `${ticker} added to watchlist.` });
    } catch (e) {
      setWlMsg({ type: 'err', text: (e as Error).message });
    } finally {
      setWlAdding(null);
    }
  }, []);

  const handleEmailPositions = async () => {
    if (!agentProjectPath) {
      setEmailMsg({ type: 'err', text: 'Set the agent project path first, then configure Email in the Config tab.' });
      return;
    }
    setEmailSending(true);
    setEmailMsg(null);
    try {
      const result = await window.api.agent.sendPositionsEmail(agentProjectPath);
      setEmailMsg({ type: 'ok', text: `Sent to ${result.sent} recipient${result.sent !== 1 ? 's' : ''}.` });
    } catch (e) {
      setEmailMsg({ type: 'err', text: (e as Error).message });
    } finally {
      setEmailSending(false);
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
        {(['overview', 'trades', 'lessons', 'recommendations', 'memory', 'run', 'config'] as Tab[]).map((t) => (
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
            <div style={{ display: 'flex', gap: 8, marginBottom: emailMsg ? 8 : 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {(['all', 'open', 'closed'] as const).map((f) => (
                <button key={f} onClick={() => setTradeFilter(f)}
                  style={{ fontSize: 12, background: tradeFilter === f ? '#3498db' : '#2c2c2c' }}>
                  {f.charAt(0).toUpperCase() + f.slice(1)}
                </button>
              ))}
              <span style={{ fontSize: 12, color: '#95a5a6' }}>
                {filteredTrades.length} trade{filteredTrades.length !== 1 ? 's' : ''}
              </span>
              <button
                onClick={handleEmailPositions}
                disabled={emailSending}
                style={{ marginLeft: 'auto', fontSize: 12, background: emailSending ? '#2c2c2c' : '#8e44ad' }}
                title="Email current positions to the distribution list configured in Config → Email"
              >
                {emailSending ? '⟳ Sending…' : '✉ Email Positions'}
              </button>
            </div>
            {emailMsg && (
              <div style={{
                marginBottom: 10, padding: '6px 10px', borderRadius: 4, fontSize: 12,
                background: emailMsg.type === 'ok' ? '#1a3a2a' : '#3a1a1a',
                color: emailMsg.type === 'ok' ? '#2ecc71' : '#e74c3c',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}>
                {emailMsg.text}
                <span style={{ cursor: 'pointer', marginLeft: 12 }} onClick={() => setEmailMsg(null)}>✕</span>
              </div>
            )}
            {wlMsg && (
              <div style={{
                marginBottom: 10, padding: '6px 10px', borderRadius: 4, fontSize: 12,
                background: wlMsg.type === 'ok' ? '#1a3a2a' : '#3a1a1a',
                color: wlMsg.type === 'ok' ? '#2ecc71' : '#e74c3c',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center'
              }}>
                {wlMsg.text}
                <span style={{ cursor: 'pointer', marginLeft: 12 }} onClick={() => setWlMsg(null)}>✕</span>
              </div>
            )}
            {filteredTrades.length === 0 ? (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>No trades found.</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: '#95a5a6', borderBottom: '1px solid #2c2c2c' }}>
                    {['#', 'Ticker', 'Strategy', 'Strike', 'Exp', 'DTE', 'Premium', 'Capital', 'Score', 'Status', 'Entry', 'Close', 'P&L', 'Reason', 'Entry $', 'Last $ / Chg', ''].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredTrades.map((t) => {
                    const isSelected = selectedTradeId === t.id;
                    return (
                      <>
                        <tr
                          key={t.id}
                          onClick={() => setSelectedTradeId(isSelected ? null : t.id)}
                          style={{
                            borderBottom: isSelected ? 'none' : '1px solid #1a1a1a',
                            cursor: 'pointer',
                            background: isSelected ? '#1a1a2e' : 'transparent'
                          }}
                        >
                          <td style={{ padding: '4px 8px', color: '#95a5a6' }}>
                            <span style={{ marginRight: 4, fontSize: 10, color: '#3498db' }}>{isSelected ? '▼' : '▶'}</span>
                            {t.id}
                          </td>
                          <td style={{ padding: '4px 8px', fontWeight: 600 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {t.ticker}
                              <div style={{ position: 'relative' }}>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setWlPickerTradeId(wlPickerTradeId === t.id ? null : t.id); }}
                                  disabled={wlAdding === t.id || watchlists.length === 0}
                                  title={watchlists.length === 0 ? 'No watchlists available' : 'Add to watchlist'}
                                  style={{ fontSize: 10, padding: '1px 5px', background: '#1a2a3a', color: '#3498db', borderRadius: 3, cursor: 'pointer', lineHeight: 1.4, fontWeight: 400 }}
                                >
                                  {wlAdding === t.id ? '…' : '+WL'}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: t.ticker } })); }}
                                  title={`Validate ${t.ticker}`}
                                  style={{ fontSize: 10, padding: '1px 5px', background: '#1a2a1a', color: '#2ecc71', borderRadius: 3, cursor: 'pointer', lineHeight: 1.4, fontWeight: 400 }}
                                >
                                  🎯
                                </button>
                                {wlPickerTradeId === t.id && (
                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                      position: 'absolute', top: '100%', left: 0, zIndex: 200,
                                      background: '#1a1a2e', border: '1px solid #2c2c2c', borderRadius: 4,
                                      minWidth: 180, boxShadow: '0 4px 12px rgba(0,0,0,0.6)', marginTop: 2
                                    }}
                                  >
                                    <div style={{ padding: '5px 10px', fontSize: 11, color: '#95a5a6', borderBottom: '1px solid #2c2c2c' }}>
                                      Add {t.ticker} to…
                                    </div>
                                    {watchlists.map((wl) => (
                                      <button
                                        key={wl.id}
                                        onClick={() => handleAddToWatchlist(wl.id, t.ticker, t.id)}
                                        style={{
                                          display: 'block', width: '100%', textAlign: 'left',
                                          padding: '7px 12px', fontSize: 12, background: 'transparent',
                                          color: '#ecf0f1', borderRadius: 0, cursor: 'pointer'
                                        }}
                                      >
                                        {wl.name}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
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
                          <td style={{ padding: '4px 8px', color: '#95a5a6' }}>
                            {t.entryPrice != null ? `$${t.entryPrice.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ padding: '4px 8px' }}>
                            {t.lastPrice != null ? (
                              <span>
                                <span style={{ color: '#bdc3c7' }}>${t.lastPrice.toFixed(2)}</span>
                                {t.entryPrice != null && (
                                  <span style={{
                                    marginLeft: 4, fontSize: 11,
                                    color: t.lastPrice - t.entryPrice >= 0 ? '#2ecc71' : '#e74c3c'
                                  }}>
                                    {t.lastPrice - t.entryPrice >= 0 ? '+' : ''}${(t.lastPrice - t.entryPrice).toFixed(2)}
                                  </span>
                                )}
                              </span>
                            ) : '—'}
                          </td>
                          <td style={{ padding: '4px 6px' }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteTrade(t); }}
                              title={`Delete trade #${t.id}`}
                              style={{ fontSize: 11, padding: '1px 5px', background: '#3a1a1a', color: '#e74c3c', borderRadius: 3, cursor: 'pointer', lineHeight: 1.4 }}
                            >
                              🗑
                            </button>
                          </td>
                        </tr>
                        {isSelected && (
                          <tr key={`${t.id}-detail`}>
                            <td colSpan={17} style={{ padding: 0, borderBottom: '1px solid #2c2c2c' }}>
                              <TradeDetail trade={t} />
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
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

        {/* Config */}
        {tab === 'config' && (
          <ConfigTab
            config={configDraft}
            saving={configSaving}
            msg={configMsg}
            onChange={(patch) => setConfigDraft((prev) => prev ? { ...prev, ...patch } : prev)}
            onSave={async () => {
              if (!configDraft || !agentProjectPath) return;
              setConfigSaving(true);
              setConfigMsg(null);
              try {
                await window.api.agent.writeConfig(agentProjectPath, configDraft);
                setConfig(configDraft);
                setConfigMsg({ type: 'ok', text: 'Saved — restart the agent for changes to take effect.' });
              } catch (e) {
                setConfigMsg({ type: 'err', text: (e as Error).message });
              } finally {
                setConfigSaving(false);
              }
            }}
            onReset={() => { setConfigDraft(config); setConfigMsg(null); }}
          />
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

function TradeDetail({ trade }: { trade: AgentTrade }) {
  return (
    <div style={{ background: '#12121e', padding: '12px 16px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Rationale */}
      <div>
        <div style={{ fontSize: 11, color: '#95a5a6', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Why this trade</div>
        <div style={{ fontSize: 13, color: '#ecf0f1', lineHeight: 1.6 }}>{trade.rationale || '—'}</div>
      </div>

      {/* Key metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        <DetailCell label="Target P&L" value={trade.targetPl != null ? `$${trade.targetPl.toFixed(2)}` : '—'} />
        <DetailCell label="Max Loss" value={trade.maxLoss != null ? `-$${Math.abs(trade.maxLoss).toFixed(0)}` : '—'} color="#e74c3c" />
        <DetailCell label="Ann. Return" value={trade.annualizedReturn != null ? `${(trade.annualizedReturn * 100).toFixed(1)}%` : '—'} color="#2ecc71" />
        <DetailCell label="Rank at Entry" value={`#${trade.rankAtEntry}`} />
        <DetailCell label="Mode" value={trade.mode} />
      </div>

      {/* Close info if closed */}
      {trade.closeDate && (
        <div style={{ borderTop: '1px solid #2c2c2c', paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: '#95a5a6', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Close details</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <DetailCell label="Closed" value={fmtDate(trade.closeDate)} />
            <DetailCell label="Actual P&L" value={fmt$(trade.actualPl)} color={(trade.actualPl ?? 0) >= 0 ? '#2ecc71' : '#e74c3c'} />
            <DetailCell label="Reason" value={trade.closeReason ?? '—'} />
          </div>
        </div>
      )}
    </div>
  );
}

function DetailCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: '#1a1a2e', borderRadius: 4, padding: '6px 10px' }}>
      <div style={{ fontSize: 10, color: '#95a5a6', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: color ?? '#ecf0f1' }}>{value}</div>
    </div>
  );
}

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

// ── Config tab ─────────────────────────────────────────────────────────────────

interface ConfigTabProps {
  config: AgentConfig | null;
  saving: boolean;
  msg: { type: 'ok' | 'err'; text: string } | null;
  onChange: (patch: Partial<AgentConfig>) => void;
  onSave: () => void;
  onReset: () => void;
}

function ConfigTab({ config, saving, msg, onChange, onSave, onReset }: ConfigTabProps) {
  if (!config) return <div style={{ color: '#95a5a6', fontSize: 13 }}>No config found — set the agent project path first.</div>;

  const numField = (label: string, key: keyof AgentConfig, step = 1, hint?: string) => (
    <ConfigField label={label} hint={hint}>
      <input
        type="number"
        step={step}
        value={config[key] as number}
        onChange={(e) => onChange({ [key]: parseFloat(e.target.value) } as Partial<AgentConfig>)}
        style={{ width: 120, fontSize: 13 }}
      />
    </ConfigField>
  );

  const strField = (label: string, key: keyof AgentConfig, hint?: string) => (
    <ConfigField label={label} hint={hint}>
      <input
        type="text"
        value={config[key] as string}
        onChange={(e) => onChange({ [key]: e.target.value } as Partial<AgentConfig>)}
        style={{ width: 320, fontSize: 13, fontFamily: 'monospace' }}
      />
    </ConfigField>
  );

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>Agent Configuration</h4>
        <span style={{ fontSize: 12, color: '#95a5a6' }}>Writes to .env in the agent project folder</span>
        <button onClick={onSave} disabled={saving} style={{ marginLeft: 'auto', background: '#27ae60', fontSize: 13 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={onReset} disabled={saving} style={{ fontSize: 13, background: '#2c2c2c' }}>
          Reset
        </button>
      </div>

      {msg && (
        <div style={{
          marginBottom: 16, padding: '8px 12px', borderRadius: 4, fontSize: 12,
          background: msg.type === 'ok' ? '#1a3a2a' : '#3a1a1a',
          color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c'
        }}>{msg.text}</div>
      )}

      <ConfigSection label="Capital & Risk">
        {numField('Cash Balance ($)', 'cashBalance', 1000, 'Total available cash for the agent to deploy')}
        {numField('Max Positions', 'maxPositions', 1, 'Maximum number of open trades at once')}
        {numField('Max Position % of Cash', 'maxPositionPct', 0.01, 'e.g. 0.20 = 20% of cash per trade ($10k on $50k)')}
        {numField('Max Positions per Sector', 'maxPositionsPerSector', 1, 'Prevents sector concentration')}
        {numField('Kelly Fraction', 'kellyFraction', 0.05, 'Fraction of Kelly criterion to use (0.25 = quarter-Kelly)')}
      </ConfigSection>

      <ConfigSection label="Trade Filters">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          {numField('DTE Min', 'dteMin', 1, 'Minimum days to expiration')}
          {numField('DTE Max', 'dteMax', 1, 'Maximum days to expiration')}
          {numField('Delta Min', 'deltaMin', 0.01, 'Min put delta (e.g. 0.20 = 20-delta)')}
          {numField('Delta Max', 'deltaMax', 0.01, 'Max put delta (e.g. 0.35 = 35-delta)')}
        </div>
        {numField('Min IV Rank', 'minIvRank', 1, 'Only trade when IV rank ≥ this value (0–100)')}
        {numField('Min Annualized Return', 'minAnnualizedReturn', 0.01, 'e.g. 0.12 = 12% annualized — filter out low-yield trades')}
        {numField('Earnings Exclusion Days', 'earningsExclusionDays', 1, 'Skip trades within N days of earnings')}
        {numField('Min Open Interest', 'minOi', 100, 'Minimum OI on the contract for liquidity')}
        {numField('Max Bid/Ask % Spread', 'maxBidAskPct', 0.005, 'e.g. 0.05 = 5% — filter illiquid contracts')}
      </ConfigSection>

      <ConfigSection label="Universe & Modes">
        <ConfigField label="Screener Universe" hint="Which index to pull candidates from">
          <select
            value={config.screenerUniverse}
            onChange={(e) => onChange({ screenerUniverse: e.target.value as AgentConfig['screenerUniverse'] })}
            style={{ fontSize: 13 }}
          >
            <option value="sp500">S&P 500</option>
            <option value="russell1000">Russell 1000</option>
            <option value="both">Both</option>
          </select>
        </ConfigField>
        {strField('Preferred Modes', 'preferredModes', 'Comma-separated: wheel, options_income, buy')}
      </ConfigSection>

      <ConfigSection label="Connection">
        {strField('API URL', 'apiUrl', 'TradeAnalyzer API base URL')}
        {strField('Agent DB Path', 'agentDbPath', 'Absolute path to the agent SQLite database')}
      </ConfigSection>

      <ConfigSection label="Email / Notifications">
        <ConfigField label="Distribution List" hint="Comma-separated email addresses — all emails go to everyone here">
          <input
            type="text"
            value={config.emailList}
            onChange={(e) => onChange({ emailList: e.target.value })}
            placeholder="alice@example.com, bob@example.com"
            style={{ width: 400, fontSize: 13, fontFamily: 'monospace' }}
          />
        </ConfigField>
        <ConfigField label="From Address" hint="Sender address shown in the email">
          <input
            type="text"
            value={config.smtpFrom}
            onChange={(e) => onChange({ smtpFrom: e.target.value })}
            placeholder="traderagent@example.com"
            style={{ width: 280, fontSize: 13, fontFamily: 'monospace' }}
          />
        </ConfigField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          <ConfigField label="SMTP Host" hint="e.g. smtp.gmail.com">
            <input
              type="text"
              value={config.smtpHost}
              onChange={(e) => onChange({ smtpHost: e.target.value })}
              placeholder="smtp.gmail.com"
              style={{ width: 220, fontSize: 13, fontFamily: 'monospace' }}
            />
          </ConfigField>
          <ConfigField label="SMTP Port" hint="587 = TLS, 465 = SSL, 25 = plain">
            <input
              type="number"
              step={1}
              value={config.smtpPort}
              onChange={(e) => onChange({ smtpPort: parseInt(e.target.value, 10) || 587 })}
              style={{ width: 90, fontSize: 13 }}
            />
          </ConfigField>
          <ConfigField label="SMTP Username" hint="Usually your full email address">
            <input
              type="text"
              value={config.smtpUser}
              onChange={(e) => onChange({ smtpUser: e.target.value })}
              style={{ width: 220, fontSize: 13, fontFamily: 'monospace' }}
            />
          </ConfigField>
          <ConfigField label="SMTP Password" hint="App password recommended (e.g. Gmail app password)">
            <input
              type="password"
              value={config.smtpPass}
              onChange={(e) => onChange({ smtpPass: e.target.value })}
              style={{ width: 220, fontSize: 13, fontFamily: 'monospace' }}
            />
          </ConfigField>
        </div>
      </ConfigSection>
    </div>
  );
}

function ConfigSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: '#3498db', textTransform: 'uppercase',
        letterSpacing: '0.08em', marginBottom: 10, paddingBottom: 6,
        borderBottom: '1px solid #2c2c2c'
      }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function ConfigField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, minHeight: 32 }}>
      <div style={{ width: 220, flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: '#ecf0f1' }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: '#636e72', marginTop: 1 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}
