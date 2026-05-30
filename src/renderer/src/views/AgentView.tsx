import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { AgentStatus, AgentTrade, AgentLesson, AgentNativeLesson, AgentTheoryCheck, AgentDashboard, AgentRecommendation, AgentMemorySnapshot, AgentConfig, AgentStrategy, AgentStrategiesState, OptionStrategyType, Watchlist } from '@shared/types.js';

type Tab = 'overview' | 'trades' | 'actions' | 'lessons' | 'recommendations' | 'memory' | 'run' | 'config';

function liveDTE(expiration: string): number {
  return Math.max(0, Math.round((new Date(expiration + 'T21:00:00Z').getTime() - Date.now()) / 86400000));
}

function dteSeverity(dte: number): 'high' | 'medium' | 'low' | null {
  if (dte <= 7) return 'high';
  if (dte <= 14) return 'medium';
  if (dte <= 21) return 'low';
  return null;
}

// lastPrice = current stock price, strike = option strike
// Returns how at-risk the position is based on stock proximity to/through the strike
function strikeRisk(stockPrice: number, strike: number, strategy: string): 'high' | 'medium' | 'low' | null {
  const isCall = strategy.toLowerCase().includes('call');
  // dist > 0 = OTM (safe), dist < 0 = ITM (at risk)
  const dist = isCall
    ? (strike - stockPrice) / strike   // call: want stock below strike
    : (stockPrice - strike) / strike;  // put: want stock above strike
  if (dist < -0.05) return 'high';   // > 5% ITM
  if (dist < 0)     return 'medium'; // any ITM
  if (dist < 0.03)  return 'low';    // within 3% of strike (OTM but close)
  return null;
}

const SEVERITY_COLOR = { high: '#e74c3c', medium: '#f39c12', low: '#95a5a6' } as const;
const SEVERITY_BG    = { high: '#3a1a1a', medium: '#3a2a1a', low: '#2c2c2c' } as const;

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
  const [theoryChecks, setTheoryChecks] = useState<AgentTheoryCheck[]>([]);
  const [nativeLessons, setNativeLessons] = useState<AgentNativeLesson[]>([]);
  const [recs, setRecs] = useState<AgentRecommendation[]>([]);
  const [liveRecs, setLiveRecs] = useState<AgentRecommendation[]>([]);
  const [memory, setMemory] = useState<AgentMemorySnapshot | null>(null);
  const [dashboard, setDashboard] = useState<AgentDashboard | null>(null);
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

  // Strategy state
  const [strategies, setStrategies] = useState<AgentStrategy[]>([]);
  const [activeStrategyId, setActiveStrategyId] = useState<string | null>(null);
  const [editingStrategy, setEditingStrategy] = useState<AgentStrategy | null>(null);
  const [strategyMsg, setStrategyMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
    loadStrategies();
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

  const loadStrategies = useCallback(async () => {
    try {
      const state: AgentStrategiesState = await window.api.agent.listStrategies();
      setStrategies(state.strategies);
      setActiveStrategyId(state.activeId);
      const active = state.strategies.find(s => s.id === state.activeId) ?? state.strategies[0] ?? null;
      setEditingStrategy(active ? { ...active } : null);
    } catch { /* ignore */ }
  }, []);

  const loadAllData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, t, l, tc, nl, r, lr, m, d] = await Promise.all([
        window.api.agent.getStatus(),
        window.api.agent.getTrades('all'),
        window.api.agent.getLessons(50),
        window.api.agent.getTheoryChecks(100),
        window.api.agent.getNativeLessons(),
        window.api.agent.getRecommendations(),
        window.api.agent.getLiveRecommendations(),
        window.api.agent.getMemory(),
        window.api.agent.getDashboard()
      ]);
      setStatus(s);
      setTrades(t);
      setLessons(l);
      setTheoryChecks(tc);
      setNativeLessons(nl);
      setRecs(r);
      setLiveRecs(lr);
      setMemory(m);
      setDashboard(d);
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
      await loadStrategies();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleRunPhase = async () => {
    if (!agentProjectPath) {
      setError('Set the agent project path in Settings → Agent first.');
      return;
    }
    // Auto-sync active strategy to .env before spawning so the CLI always
    // runs with the current strategy settings, not a potentially stale file.
    const activeStrat = strategies.find(s => s.id === activeStrategyId);
    if (configDraft && activeStrat) {
      const merged: AgentConfig = {
        ...configDraft,
        screenerUniverse: activeStrat.screenerUniverse,
        preferredModes: activeStrat.preferredModes,
        dteMin: activeStrat.dteMin,
        dteMax: activeStrat.dteMax,
        deltaMin: activeStrat.deltaMin,
        deltaMax: activeStrat.deltaMax,
        minIv: activeStrat.minIv,
        minOi: activeStrat.minOi,
        maxBidAskPct: activeStrat.maxBidAskPct,
        minAnnualizedReturn: activeStrat.minAnnualizedReturn,
        earningsExclusionDays: activeStrat.earningsExclusionDays,
      };
      try {
        await window.api.agent.writeConfig(agentProjectPath, merged);
      } catch { /* non-fatal — proceed with existing .env */ }
    }
    setRunning(true);
    const stratLabel = activeStrat ? ` [strategy: ${activeStrat.name}]` : '';
    setLogs((prev) => [...prev, `▶ Starting phase: ${runPhase}${stratLabel}`]);
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
        {(['overview', 'trades', 'actions', 'lessons', 'recommendations', 'memory', 'run', 'config'] as Tab[]).map((t) => (
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
            {/* ── Today's Actions panel ────────────────────────────────────── */}
            {(() => {
              const openTrades = trades.filter((t) => t.status === 'open');
              if (openTrades.length === 0) return null;
              const actions: Array<{ trade: AgentTrade; action: string; reason: string; severity: 'high' | 'medium' | 'low' }> = [];
              for (const t of openTrades) {
                const dte = liveDTE(t.expiration);
                const isCall = t.strategy.toLowerCase().includes('call');
                // dist > 0 = OTM (safe), dist < 0 = ITM (at risk)
                const dist = t.lastPrice != null
                  ? (isCall ? (t.strike - t.lastPrice) / t.strike : (t.lastPrice - t.strike) / t.strike)
                  : null;

                if (dte <= 5) {
                  const itm = dist != null && dist < 0;
                  actions.push({ trade: t, action: '🔴 Close/Roll', reason: `Only ${dte} DTE — expiry imminent${itm ? ', position is ITM' : ''}`, severity: 'high' });
                } else if (dte <= 14) {
                  const itm = dist != null && dist < 0;
                  const nearMoney = dist != null && dist < 0.05;
                  actions.push({ trade: t, action: '⏰ Roll', reason: `${dte} DTE${itm ? ` — ITM ($${t.lastPrice!.toFixed(2)} ${isCall ? 'above' : 'below'} $${t.strike} strike)` : nearMoney ? ' — near strike, watch closely' : ''}`, severity: dte <= 7 ? 'high' : 'medium' });
                } else if (dist != null && dist < 0) {
                  // Stock through strike with time still remaining
                  const pct = (Math.abs(dist) * 100).toFixed(1);
                  actions.push({ trade: t, action: '🛡 Defend', reason: `Stock ${pct}% ITM — $${t.lastPrice!.toFixed(2)} ${isCall ? 'above' : 'below'} $${t.strike} strike`, severity: Math.abs(dist) > 0.05 ? 'high' : 'medium' });
                } else if (dist != null && dist < 0.03) {
                  // Near strike but still OTM
                  const pct = (dist * 100).toFixed(1);
                  actions.push({ trade: t, action: '⚠ Monitor', reason: `Stock within ${pct}% of $${t.strike} strike — $${t.lastPrice!.toFixed(2)}`, severity: 'low' });
                } else if (t.currentOptionMid != null && t.entryPremium > 0) {
                  // Real close signal: actual option P&L from theory check
                  const captured = (t.entryPremium - t.currentOptionMid) / t.entryPremium;
                  if (captured >= 0.5) {
                    const plPerContract = ((t.entryPremium - t.currentOptionMid) * 100).toFixed(0);
                    actions.push({ trade: t, action: '💰 Consider Close', reason: `${(captured * 100).toFixed(0)}% of premium captured — entry $${t.entryPremium.toFixed(2)} → now $${t.currentOptionMid.toFixed(2)} (+$${plPerContract}/contract)`, severity: captured >= 0.75 ? 'medium' : 'low' });
                  }
                }
              }
              if (actions.length === 0) return null;
              return (
                <div style={{ marginBottom: 14, background: '#12121e', borderRadius: 6, border: '1px solid #2c3050' }}>
                  <div style={{ padding: '7px 14px', borderBottom: '1px solid #2c2c2c', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>Today's Actions</span>
                    <span style={{ fontSize: 11, color: '#95a5a6' }}>{actions.length} position{actions.length !== 1 ? 's' : ''} need attention</span>
                  </div>
                  <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {actions.map(({ trade: t, action, reason, severity }) => (
                      <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
                        <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 11, fontWeight: 600, background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity], whiteSpace: 'nowrap' }}>
                          {action}
                        </span>
                        <span style={{ fontWeight: 600, minWidth: 55 }}>{t.ticker}</span>
                        <span style={{ color: '#95a5a6' }}>{t.strategy} ${t.strike}</span>
                        <span style={{ color: '#bdc3c7', flex: 1 }}>{reason}</span>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: t.ticker } }))}
                            style={{ fontSize: 10, padding: '1px 5px', background: '#1a2a3a', color: '#3498db', borderRadius: 3 }}>📊</button>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker: t.ticker, expiry: t.expiration } }))}
                            style={{ fontSize: 10, padding: '1px 5px', background: '#2a1a3a', color: '#9b59b6', borderRadius: 3 }}>⛓</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
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
                    {['#', 'Ticker', 'Strategy', 'Strike', 'Exp', 'DTE', 'Premium', 'Option Now', 'Capital', 'Score', 'Status', 'Entry', 'Close', 'P&L', 'Reason', 'Entry $', 'Last $ / Chg', ''].map((h) => (
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
                                  onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: t.ticker } })); }}
                                  title={`Analyze ${t.ticker}`}
                                  style={{ fontSize: 10, padding: '1px 5px', background: '#1a2a3a', color: '#3498db', borderRadius: 3, cursor: 'pointer', lineHeight: 1.4, fontWeight: 400 }}
                                >
                                  📊
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: t.ticker } })); }}
                                  title={`Validate ${t.ticker}`}
                                  style={{ fontSize: 10, padding: '1px 5px', background: '#1a2a1a', color: '#2ecc71', borderRadius: 3, cursor: 'pointer', lineHeight: 1.4, fontWeight: 400 }}
                                >
                                  🎯
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker: t.ticker, expiry: t.expiration } })); }}
                                  title={`Options chain for ${t.ticker}`}
                                  style={{ fontSize: 10, padding: '1px 5px', background: '#2a1a3a', color: '#9b59b6', borderRadius: 3, cursor: 'pointer', lineHeight: 1.4, fontWeight: 400 }}
                                >
                                  ⛓
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
                          <td style={{ padding: '4px 8px' }}>
                            {t.currentOptionMid != null ? (() => {
                              const pl = (t.entryPremium - t.currentOptionMid) * 100; // per contract
                              const captured = t.entryPremium > 0 ? (t.entryPremium - t.currentOptionMid) / t.entryPremium : 0;
                              const color = pl >= 0 ? '#2ecc71' : '#e74c3c';
                              return (
                                <span>
                                  <span style={{ color: '#bdc3c7' }}>${t.currentOptionMid.toFixed(2)}</span>
                                  <span style={{ marginLeft: 4, fontSize: 11, color }}>
                                    {pl >= 0 ? '+' : ''}${pl.toFixed(0)}/ct
                                  </span>
                                  {Math.abs(captured) >= 0.1 && (
                                    <span style={{ marginLeft: 3, fontSize: 10, color }}>
                                      ({(captured * 100).toFixed(0)}%)
                                    </span>
                                  )}
                                </span>
                              );
                            })() : <span style={{ color: '#555' }}>—</span>}
                          </td>
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
                            <td colSpan={18} style={{ padding: 0, borderBottom: '1px solid #2c2c2c' }}>
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

        {/* Actions */}
        {tab === 'actions' && (() => {
          const openTrades = trades.filter((t) => t.status === 'open');
          const expiringRows = openTrades
            .map((t) => ({ trade: t, dte: liveDTE(t.expiration), severity: dteSeverity(liveDTE(t.expiration)) }))
            .filter((r) => r.severity !== null)
            .sort((a, b) => a.dte - b.dte) as { trade: AgentTrade; dte: number; severity: 'high' | 'medium' | 'low' }[];
          // "Underwater" = stock near or through the strike (not premium comparison)
          const underwaterRows = openTrades
            .filter((t) => t.lastPrice !== null)
            .map((t) => {
              const severity = strikeRisk(t.lastPrice!, t.strike, t.strategy);
              const isCall = t.strategy.toLowerCase().includes('call');
              // dist < 0 = ITM, dist > 0 = OTM; sort most ITM first
              const dist = isCall
                ? (t.strike - t.lastPrice!) / t.strike
                : (t.lastPrice! - t.strike) / t.strike;
              return { trade: t, severity, dist };
            })
            .filter((r) => r.severity !== null)
            .sort((a, b) => a.dist - b.dist) as { trade: AgentTrade; severity: 'high' | 'medium' | 'low'; dist: number }[];
          const total = expiringRows.length + underwaterRows.length;
          return (
            <div>
              <div style={{ marginBottom: 16, fontSize: 12, color: '#95a5a6' }}>
                {openTrades.length} open trade{openTrades.length !== 1 ? 's' : ''} · {total} alert{total !== 1 ? 's' : ''}
              </div>
              {total === 0 && (
                <div style={{ color: '#2ecc71', fontSize: 13 }}>✓ No action needed — all open positions look healthy.</div>
              )}
              {expiringRows.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <h4 style={{ margin: '0 0 10px', color: '#bdc3c7' }}>Expiring Soon</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {expiringRows.map(({ trade: t, dte, severity }) => (
                      <div key={t.id} style={{
                        background: '#1a1a2e', borderRadius: 6, padding: '10px 14px',
                        borderLeft: `3px solid ${SEVERITY_COLOR[severity]}`,
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'
                      }}>
                        <span style={{ padding: '1px 7px', borderRadius: 3, fontSize: 11, fontWeight: 600, background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity] }}>
                          {severity.toUpperCase()}
                        </span>
                        <span style={{ fontWeight: 600, minWidth: 60 }}>{t.ticker}</span>
                        <span style={{ fontSize: 12, color: '#95a5a6' }}>{t.strategy} ${t.strike} · exp {fmtDate(t.expiration)}</span>
                        <span style={{ fontSize: 12, color: SEVERITY_COLOR[severity], fontWeight: 600 }}>{dte} DTE</span>
                        <span style={{ fontSize: 12, color: '#bdc3c7' }}>premium ${t.entryPremium.toFixed(2)}</span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: t.ticker } }))}
                            style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a3a', color: '#3498db', borderRadius: 3 }}>📊 Analysis</button>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: t.ticker } }))}
                            style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a1a', color: '#2ecc71', borderRadius: 3 }}>🎯 Validate</button>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker: t.ticker, expiry: t.expiration } }))}
                            style={{ fontSize: 11, padding: '2px 7px', background: '#2a1a3a', color: '#9b59b6', borderRadius: 3 }}>⛓ Options</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {underwaterRows.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 10px', color: '#bdc3c7' }}>Underwater Positions</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {underwaterRows.map(({ trade: t, severity, dist }) => {
                      const isCall = t.strategy.toLowerCase().includes('call');
                      const isITM = dist < 0;
                      const distPct = (Math.abs(dist) * 100).toFixed(1);
                      const label = isITM
                        ? `Stock ${distPct}% ITM ($${t.lastPrice!.toFixed(2)} ${isCall ? 'above' : 'below'} $${t.strike} strike)`
                        : `Stock within ${distPct}% of $${t.strike} strike ($${t.lastPrice!.toFixed(2)})`;
                      return (
                      <div key={t.id} style={{
                        background: '#1a1a2e', borderRadius: 6, padding: '10px 14px',
                        borderLeft: `3px solid ${SEVERITY_COLOR[severity]}`,
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'
                      }}>
                        <span style={{ padding: '1px 7px', borderRadius: 3, fontSize: 11, fontWeight: 600, background: SEVERITY_BG[severity], color: SEVERITY_COLOR[severity] }}>
                          {severity.toUpperCase()}
                        </span>
                        <span style={{ fontWeight: 600, minWidth: 60 }}>{t.ticker}</span>
                        <span style={{ fontSize: 12, color: '#95a5a6' }}>{t.strategy} ${t.strike} · exp {fmtDate(t.expiration)}</span>
                        <span style={{ fontSize: 12, color: SEVERITY_COLOR[severity], fontWeight: 600 }}>
                          {label}
                        </span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: t.ticker } }))}
                            style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a3a', color: '#3498db', borderRadius: 3 }}>📊 Analysis</button>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: t.ticker } }))}
                            style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a1a', color: '#2ecc71', borderRadius: 3 }}>🎯 Validate</button>
                          <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker: t.ticker, expiry: t.expiration } }))}
                            style={{ fontSize: 11, padding: '2px 7px', background: '#2a1a3a', color: '#9b59b6', borderRadius: 3 }}>⛓ Options</button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* Lessons */}
        {tab === 'lessons' && (
          <div>
            {/* ── Native Insights — computed from DB without running agent ── */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                <h4 style={{ margin: 0 }}>Portfolio Insights</h4>
                <span style={{ fontSize: 12, color: '#95a5a6' }}>detected from your trades — no agent run needed</span>
                <button onClick={loadAllData} disabled={loading} style={{ marginLeft: 'auto', fontSize: 11, background: '#1a2a3a', color: '#3498db' }}>
                  {loading ? '⟳' : '↻ Refresh Insights'}
                </button>
              </div>
              {nativeLessons.length === 0 ? (
                <div style={{ color: '#2ecc71', fontSize: 13 }}>✓ No issues detected — all open positions look healthy.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {nativeLessons.map((l) => {
                    const sevColor = l.severity === 'high' ? '#e74c3c' : l.severity === 'medium' ? '#f39c12' : '#95a5a6';
                    const sevBg = l.severity === 'high' ? '#3a1a1a' : l.severity === 'medium' ? '#3a2a1a' : '#2c2c2c';
                    return (
                      <div key={l.id} style={{
                        background: '#1a1a2e', borderRadius: 6, padding: '10px 14px',
                        borderLeft: `3px solid ${sevColor}`
                      }}>
                        <div style={{ display: 'flex', gap: 10, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 11, fontWeight: 600, background: sevBg, color: sevColor }}>
                            {l.severity.toUpperCase()}
                          </span>
                          <span style={{ fontWeight: 600 }}>{l.title}</span>
                          {l.ticker && (
                            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                              <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: l.ticker } }))}
                                style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a3a', color: '#3498db', borderRadius: 3 }}>📊</button>
                              <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: l.ticker } }))}
                                style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a1a', color: '#2ecc71', borderRadius: 3 }}>🎯</button>
                            </div>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: '#bdc3c7', lineHeight: 1.5 }}>{l.narrative}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Theory Checks — from the review phase */}
            {theoryChecks.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                  <h4 style={{ margin: 0 }}>Theory Validation</h4>
                  <span style={{ fontSize: 12, color: '#95a5a6' }}>
                    {theoryChecks.filter(c => c.verdict === 'CONFIRMED').length} confirmed ·{' '}
                    {theoryChecks.filter(c => c.verdict === 'AT_RISK').length} at risk ·{' '}
                    {theoryChecks.filter(c => c.verdict === 'INVALIDATED').length} invalidated
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {theoryChecks.map((c) => {
                    const vColor = c.verdict === 'CONFIRMED' ? '#2ecc71' : c.verdict === 'AT_RISK' ? '#f39c12' : '#e74c3c';
                    const vBg    = c.verdict === 'CONFIRMED' ? '#1a3a2a' : c.verdict === 'AT_RISK' ? '#3a2a1a' : '#3a1a1a';
                    return (
                      <div key={c.id} style={{
                        background: '#1a1a2e', borderRadius: 6, padding: '10px 14px',
                        borderLeft: `3px solid ${vColor}`
                      }}>
                        <div style={{ display: 'flex', gap: 10, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ padding: '1px 7px', borderRadius: 3, fontSize: 11, fontWeight: 600, background: vBg, color: vColor }}>
                            {c.verdict}
                          </span>
                          <span style={{ fontWeight: 600 }}>{c.ticker}</span>
                          <span style={{ fontSize: 12, color: '#95a5a6' }}>{c.strategy} ${c.strike} · exp {fmtDate(c.expiration)}</span>
                          <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, background: '#2c2c2c', color: '#95a5a6' }}>
                            {c.tradeStatus}
                          </span>
                          {c.currentDelta != null && (
                            <span style={{ fontSize: 12, color: '#bdc3c7' }}>δ {c.currentDelta.toFixed(2)}</span>
                          )}
                          {c.currentDTE != null && c.currentDTE > 0 && (
                            <span style={{ fontSize: 12, color: '#bdc3c7' }}>{c.currentDTE} DTE</span>
                          )}
                          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                            <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-analysis', { detail: { ticker: c.ticker } }))}
                              style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a3a', color: '#3498db', borderRadius: 3 }}>📊</button>
                            <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: c.ticker } }))}
                              style={{ fontSize: 11, padding: '2px 7px', background: '#1a2a1a', color: '#2ecc71', borderRadius: 3 }}>🎯</button>
                            <button onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-options', { detail: { ticker: c.ticker, expiry: c.expiration } }))}
                              style={{ fontSize: 11, padding: '2px 7px', background: '#2a1a3a', color: '#9b59b6', borderRadius: 3 }}>⛓</button>
                          </div>
                          <span style={{ fontSize: 11, color: '#555', marginLeft: 4 }}>{fmtDate(c.checkedAt)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: '#bdc3c7', lineHeight: 1.5 }}>{c.narrative}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Gap-analysis lessons from the learn phase */}
            {lessons.length > 0 && (
              <div>
                <h4 style={{ margin: '0 0 10px', color: '#bdc3c7' }}>Gap Analysis (Learn Phase)</h4>
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
              </div>
            )}

            {theoryChecks.length === 0 && lessons.length === 0 && (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>
                No theory checks or gap-analysis lessons yet. Run the <strong>review</strong> phase to validate open trade theories, or the <strong>learn</strong> phase after trades close to generate gap analysis.
              </div>
            )}
          </div>
        )}

        {/* Recommendations */}
        {tab === 'recommendations' && (() => {
          const sevColor = (s: string) => s === 'high' ? '#e74c3c' : s === 'medium' ? '#f39c12' : '#95a5a6';
          const sevBg    = (s: string) => s === 'high' ? '#3a1a1a' : s === 'medium' ? '#3a2a1a' : '#2c2c2c';
          // Category accent colors
          const catColor = (c: string) =>
            c === 'Close Now' ? '#2ecc71' :
            c === 'Roll'      ? '#3498db' :
            c === 'Defend'    ? '#f39c12' :
            '#9b59b6';
          const RecCard = ({ r }: { r: AgentRecommendation }) => (
            <div style={{
              background: '#1a1a2e', borderRadius: 6, padding: '10px 14px',
              borderLeft: `3px solid ${sevColor(r.severity)}`
            }}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 6, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 12, color: catColor(r.category) }}>{r.category}</span>
                <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 11, background: sevBg(r.severity), color: sevColor(r.severity) }}>
                  {r.severity}
                </span>
                <span style={{
                  padding: '1px 6px', borderRadius: 3, fontSize: 11,
                  background: r.status === 'live' ? '#1a2a1a' : r.status === 'pending' ? '#1a2a3a' : '#2c2c2c',
                  color: r.status === 'live' ? '#2ecc71' : r.status === 'pending' ? '#3498db' : '#95a5a6'
                }}>
                  {r.status === 'live' ? '⚡ live' : r.status}
                </span>
                <span style={{ marginLeft: 'auto', color: '#95a5a6' }}>{r.status !== 'live' ? fmtDate(r.createdAt) : ''}</span>
              </div>
              <div style={{ fontSize: 12, color: '#bdc3c7', marginBottom: 6 }}>{r.description}</div>
              <div style={{ fontSize: 12, color: '#95a5a6', fontStyle: 'italic' }}>→ {r.proposedChange}</div>
            </div>
          );
          const actionCategories = new Set(['Close Now', 'Roll', 'Defend']);
          const actionRecs = liveRecs.filter(r => actionCategories.has(r.category));
          const portfolioRecs = liveRecs.filter(r => !actionCategories.has(r.category));
          return (
            <div>
              {actionRecs.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                    <h4 style={{ margin: 0 }}>Trade Actions</h4>
                    <span style={{ fontSize: 12, color: '#95a5a6' }}>Close Now · Roll · Defend — computed from open position data</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {actionRecs.map((r) => <RecCard key={r.id} r={r} />)}
                  </div>
                </div>
              )}
              {portfolioRecs.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                    <h4 style={{ margin: 0 }}>Portfolio Insights</h4>
                    <span style={{ fontSize: 12, color: '#95a5a6' }}>computed now from your open positions</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {portfolioRecs.map((r) => <RecCard key={r.id} r={r} />)}
                  </div>
                </div>
              )}
              {recs.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 10px', color: '#bdc3c7' }}>Learned Recommendations</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {recs.map((r) => <RecCard key={r.id} r={r} />)}
                  </div>
                </div>
              )}
              {actionRecs.length === 0 && portfolioRecs.length === 0 && recs.length === 0 && (
                <div style={{ color: '#2ecc71', fontSize: 13 }}>
                  ✓ No recommendations. All positions within healthy parameters.
                </div>
              )}
            </div>
          );
        })()}

        {/* Memory — live dashboard */}
        {tab === 'memory' && (
          <div>
            {!dashboard ? (
              <div style={{ color: '#95a5a6', fontSize: 13 }}>No data yet — connect the agent DB.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

                {/* ── Row 1: top KPIs ── */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
                  <StatCard label="Open Positions"   value={String(dashboard.openPositionCount)} />
                  <StatCard label="Capital Deployed"  value={`$${dashboard.totalDeployedCapital.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
                  <StatCard label="Overall Win Rate"  value={dashboard.totalClosed > 0 ? fmtPct(dashboard.overallWinRate) : '—'}
                    color={dashboard.overallWinRate >= 0.6 ? '#2ecc71' : dashboard.overallWinRate >= 0.4 ? '#f39c12' : '#e74c3c'} />
                  <StatCard label="Total P&L"  value={fmt$(dashboard.totalRealizedPl)}
                    color={dashboard.totalRealizedPl >= 0 ? '#2ecc71' : '#e74c3c'} />
                  <StatCard label="Est. Daily θ"
                    value={dashboard.estimatedDailyTheta != null ? `$${dashboard.estimatedDailyTheta.toFixed(2)}` : '—'}
                    color="#3498db" />
                </div>

                {/* ── Row 2: IV environment ── */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  <StatCard label="Avg IV (open positions)"
                    value={dashboard.avgIv != null ? `${dashboard.avgIv.toFixed(1)}%` : '—'}
                    color={dashboard.avgIv != null ? (dashboard.avgIv >= 30 ? '#2ecc71' : '#f39c12') : undefined} />
                  <StatCard label="Avg Delta (open)"
                    value={dashboard.avgDelta != null ? dashboard.avgDelta.toFixed(2) : '—'}
                    color={dashboard.avgDelta != null && Math.abs(dashboard.avgDelta) > 0.4 ? '#e74c3c' : '#bdc3c7'} />
                  <StatCard label="Avg DTE (open)"
                    value={dashboard.avgDTE != null ? `${Math.round(dashboard.avgDTE)} days` : '—'}
                    color={dashboard.avgDTE != null && dashboard.avgDTE < 10 ? '#e74c3c' : '#bdc3c7'} />
                </div>

                {/* ── Row 3: Win rate by strategy + capital by strategy ── */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                  <div>
                    <h4 style={{ margin: '0 0 10px' }}>Win Rate by Strategy</h4>
                    {Object.keys(dashboard.winRateByStrategy).length === 0
                      ? <div style={{ color: '#95a5a6', fontSize: 12 }}>No closed trades yet.</div>
                      : Object.entries(dashboard.winRateByStrategy)
                          .sort((a, b) => b[1].total - a[1].total)
                          .map(([k, v]) => (
                            <div key={k} style={{ marginBottom: 8 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                                <span style={{ color: '#bdc3c7' }}>{k}</span>
                                <span style={{ color: '#95a5a6' }}>{v.wins}/{v.total} · {(v.winRate * 100).toFixed(0)}%</span>
                              </div>
                              <div style={{ background: '#2c2c2c', borderRadius: 3, height: 6 }}>
                                <div style={{ width: `${v.winRate * 100}%`, background: v.winRate >= 0.6 ? '#2ecc71' : v.winRate >= 0.4 ? '#f39c12' : '#e74c3c', height: '100%', borderRadius: 3, transition: 'width 0.3s' }} />
                              </div>
                            </div>
                          ))
                    }
                  </div>
                  <div>
                    <h4 style={{ margin: '0 0 10px' }}>Capital by Strategy (open)</h4>
                    {Object.keys(dashboard.capitalByStrategy).length === 0
                      ? <div style={{ color: '#95a5a6', fontSize: 12 }}>No open positions.</div>
                      : (() => {
                          const max = Math.max(...Object.values(dashboard.capitalByStrategy));
                          return Object.entries(dashboard.capitalByStrategy)
                            .sort((a, b) => b[1] - a[1])
                            .map(([k, v]) => (
                              <div key={k} style={{ marginBottom: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                                  <span style={{ color: '#bdc3c7' }}>{k}</span>
                                  <span style={{ color: '#95a5a6' }}>${v.toLocaleString(undefined, { maximumFractionDigits: 0 })} · {dashboard.totalDeployedCapital > 0 ? ((v / dashboard.totalDeployedCapital) * 100).toFixed(0) : 0}%</span>
                                </div>
                                <div style={{ background: '#2c2c2c', borderRadius: 3, height: 6 }}>
                                  <div style={{ width: `${(v / max) * 100}%`, background: '#3498db', height: '100%', borderRadius: 3 }} />
                                </div>
                              </div>
                            ));
                        })()
                    }
                  </div>
                </div>

                {/* ── Row 4: P&L by month ── */}
                {Object.keys(dashboard.plByMonth).length > 0 && (
                  <div>
                    <h4 style={{ margin: '0 0 10px' }}>Monthly P&L (last 6 months)</h4>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
                      {Object.entries(dashboard.plByMonth).map(([month, pl]) => {
                        const maxAbs = Math.max(...Object.values(dashboard.plByMonth).map(Math.abs), 1);
                        const h = Math.round((Math.abs(pl) / maxAbs) * 60);
                        return (
                          <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 10, color: pl >= 0 ? '#2ecc71' : '#e74c3c' }}>{pl >= 0 ? '+' : ''}${Math.round(pl)}</span>
                            <div style={{ width: '100%', height: h, background: pl >= 0 ? '#2ecc71' : '#e74c3c', borderRadius: '3px 3px 0 0', opacity: 0.8, minHeight: 4 }} />
                            <span style={{ fontSize: 10, color: '#95a5a6' }}>{month.slice(5)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Row 5: Capital by ticker (top 8) ── */}
                {Object.keys(dashboard.capitalByTicker).length > 0 && (
                  <div>
                    <h4 style={{ margin: '0 0 10px' }}>Capital by Ticker (open)</h4>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {Object.entries(dashboard.capitalByTicker)
                        .sort((a, b) => b[1] - a[1]).slice(0, 8)
                        .map(([ticker, cap]) => {
                          const pct = dashboard.totalDeployedCapital > 0 ? (cap / dashboard.totalDeployedCapital) * 100 : 0;
                          return (
                            <div key={ticker} style={{
                              background: '#1a1a2e', borderRadius: 6, padding: '8px 14px', minWidth: 110,
                              borderLeft: `3px solid ${pct > 40 ? '#e74c3c' : pct > 25 ? '#f39c12' : '#3498db'}`
                            }}>
                              <div style={{ fontWeight: 600, fontSize: 13 }}>{ticker}</div>
                              <div style={{ fontSize: 12, color: '#95a5a6' }}>${cap.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                              <div style={{ fontSize: 11, color: pct > 40 ? '#e74c3c' : pct > 25 ? '#f39c12' : '#bdc3c7' }}>{pct.toFixed(0)}%</div>
                            </div>
                          );
                        })}
                    </div>
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
                // Merge active strategy fields into the global config before writing .env
                const merged: AgentConfig = editingStrategy
                  ? { ...configDraft, screenerUniverse: editingStrategy.screenerUniverse, preferredModes: editingStrategy.preferredModes, dteMin: editingStrategy.dteMin, dteMax: editingStrategy.dteMax, deltaMin: editingStrategy.deltaMin, deltaMax: editingStrategy.deltaMax, minIv: editingStrategy.minIv, minOi: editingStrategy.minOi, maxBidAskPct: editingStrategy.maxBidAskPct, minAnnualizedReturn: editingStrategy.minAnnualizedReturn, earningsExclusionDays: editingStrategy.earningsExclusionDays }
                  : configDraft;
                await window.api.agent.writeConfig(agentProjectPath, merged);
                setConfig(merged);
                setConfigMsg({ type: 'ok', text: 'Saved — restart the agent for changes to take effect.' });
              } catch (e) {
                setConfigMsg({ type: 'err', text: (e as Error).message });
              } finally {
                setConfigSaving(false);
              }
            }}
            onReset={() => { setConfigDraft(config); setConfigMsg(null); }}
            strategies={strategies}
            activeStrategyId={activeStrategyId}
            editingStrategy={editingStrategy}
            strategyMsg={strategyMsg}
            onStrategyChange={(patch) => setEditingStrategy((prev) => prev ? { ...prev, ...patch } : prev)}
            onSelectStrategy={(id) => {
              const s = strategies.find(x => x.id === id);
              if (s) setEditingStrategy({ ...s });
              setStrategyMsg(null);
            }}
            onSaveStrategy={async () => {
              if (!editingStrategy) return;
              setStrategyMsg(null);
              try {
                const saved = await window.api.agent.saveStrategy(editingStrategy);
                setStrategies((prev) => {
                  const idx = prev.findIndex(s => s.id === saved.id);
                  return idx >= 0 ? prev.map((s, i) => i === idx ? saved : s) : [...prev, saved];
                });
                setEditingStrategy({ ...saved });
                setStrategyMsg({ type: 'ok', text: 'Strategy saved.' });
              } catch (e) {
                setStrategyMsg({ type: 'err', text: (e as Error).message });
              }
            }}
            onNewStrategy={() => {
              const s: AgentStrategy = {
                id: crypto.randomUUID(),
                name: 'New Strategy',
                screeningMode: 'both',
                screeningCriteria: { optionStrategies: ['wheel'], minCompositeScore: 60, minBuyStrength: 65 },
                screenerUniverse: 'sp500',
                preferredModes: 'wheel,options_income',
                dteMin: 25, dteMax: 50, deltaMin: 0.20, deltaMax: 0.35,
                minIv: 20, minOi: 500, maxBidAskPct: 0.05, minAnnualizedReturn: 0.15, earningsExclusionDays: 14,
              };
              setEditingStrategy(s);
              setStrategyMsg(null);
            }}
            onCloneStrategy={() => {
              if (!editingStrategy) return;
              const clone: AgentStrategy = { ...editingStrategy, id: crypto.randomUUID(), name: `${editingStrategy.name} (copy)` };
              setEditingStrategy(clone);
              setStrategyMsg(null);
            }}
            onDeleteStrategy={async () => {
              if (!editingStrategy) return;
              const confirmed = await window.dialog.confirm({ title: 'Delete strategy', message: `Delete "${editingStrategy.name}"?` });
              if (!confirmed) return;
              try {
                await window.api.agent.deleteStrategy(editingStrategy.id);
                await loadStrategies();
                setStrategyMsg({ type: 'ok', text: 'Strategy deleted.' });
              } catch (e) {
                setStrategyMsg({ type: 'err', text: (e as Error).message });
              }
            }}
            onActivateStrategy={async () => {
              if (!editingStrategy) return;
              try {
                // Save first, then activate
                const saved = await window.api.agent.saveStrategy(editingStrategy);
                await window.api.agent.setActiveStrategy(saved.id);
                setActiveStrategyId(saved.id);
                setStrategies((prev) => {
                  const idx = prev.findIndex(s => s.id === saved.id);
                  return idx >= 0 ? prev.map((s, i) => i === idx ? saved : s) : [...prev, saved];
                });
                setStrategyMsg({ type: 'ok', text: `"${saved.name}" is now the active strategy.` });
              } catch (e) {
                setStrategyMsg({ type: 'err', text: (e as Error).message });
              }
            }}
          />
        )}

        {/* Run */}
        {tab === 'run' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <h4 style={{ margin: 0 }}>Run Agent Phase</h4>
              {(() => {
                const activeStrat = strategies.find(s => s.id === activeStrategyId);
                return activeStrat
                  ? <span style={{ fontSize: 12, color: '#3498db' }}>★ {activeStrat.name} — {activeStrat.screeningMode} mode · {activeStrat.screenerUniverse}</span>
                  : <span style={{ fontSize: 12, color: '#95a5a6' }}>No active strategy</span>;
              })()}
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <select
                value={runPhase}
                onChange={(e) => setRunPhase(e.target.value)}
                disabled={running}
                style={{ fontSize: 13 }}
              >
                {['run', 'scout', 'decide', 'trade', 'monitor', 'learn', 'review'].map((p) => (
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

const OPTION_STRATEGY_LABELS: Record<OptionStrategyType, string> = {
  wheel: 'Wheel (CSP → CC)',
  leaps_csp: 'LEAPS + CSP',
  covered_call: 'Covered Call',
  bull_call_spread: 'Bull Call Spread',
  bear_put_spread: 'Bear Put Spread',
  iron_condor: 'Iron Condor',
};
const ALL_OPTION_STRATEGIES: OptionStrategyType[] = ['wheel', 'leaps_csp', 'covered_call', 'bull_call_spread', 'bear_put_spread', 'iron_condor'];

interface ConfigTabProps {
  config: AgentConfig | null;
  saving: boolean;
  msg: { type: 'ok' | 'err'; text: string } | null;
  onChange: (patch: Partial<AgentConfig>) => void;
  onSave: () => void;
  onReset: () => void;
  // Strategy props
  strategies: AgentStrategy[];
  activeStrategyId: string | null;
  editingStrategy: AgentStrategy | null;
  strategyMsg: { type: 'ok' | 'err'; text: string } | null;
  onStrategyChange: (patch: Partial<AgentStrategy>) => void;
  onSelectStrategy: (id: string) => void;
  onSaveStrategy: () => void;
  onNewStrategy: () => void;
  onCloneStrategy: () => void;
  onDeleteStrategy: () => void;
  onActivateStrategy: () => void;
}

function ConfigTab({
  config, saving, msg, onChange, onSave, onReset,
  strategies, activeStrategyId, editingStrategy, strategyMsg,
  onStrategyChange, onSelectStrategy, onSaveStrategy,
  onNewStrategy, onCloneStrategy, onDeleteStrategy, onActivateStrategy,
}: ConfigTabProps) {

  // ── Strategy field helpers ──
  const sNum = (label: string, key: keyof AgentStrategy, step = 1, hint?: string) => {
    if (!editingStrategy) return null;
    return (
      <ConfigField label={label} hint={hint}>
        <input
          type="number"
          step={step}
          value={editingStrategy[key] as number}
          onChange={(e) => onStrategyChange({ [key]: parseFloat(e.target.value) } as Partial<AgentStrategy>)}
          style={{ width: 120, fontSize: 13 }}
        />
      </ConfigField>
    );
  };

  // ── Global config field helpers ──
  const numField = (label: string, key: keyof AgentConfig, step = 1, hint?: string) => {
    if (!config) return null;
    return (
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
  };

  const strField = (label: string, key: keyof AgentConfig, hint?: string) => {
    if (!config) return null;
    return (
      <ConfigField label={label} hint={hint}>
        <input
          type="text"
          value={config[key] as string}
          onChange={(e) => onChange({ [key]: e.target.value } as Partial<AgentConfig>)}
          style={{ width: 320, fontSize: 13, fontFamily: 'monospace' }}
        />
      </ConfigField>
    );
  };

  const isActive = editingStrategy?.id === activeStrategyId;
  const isNew = editingStrategy ? !strategies.find(s => s.id === editingStrategy.id) : false;

  return (
    <div style={{ maxWidth: 760 }}>

      {/* ── Strategy selector bar ── */}
      <ConfigSection label="Strategies">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <select
            value={editingStrategy?.id ?? ''}
            onChange={(e) => onSelectStrategy(e.target.value)}
            style={{ fontSize: 13, minWidth: 200 }}
          >
            {strategies.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}{s.id === activeStrategyId ? ' ★' : ''}
              </option>
            ))}
            {isNew && editingStrategy && <option value={editingStrategy.id}>{editingStrategy.name} (unsaved)</option>}
          </select>
          <button onClick={onNewStrategy} style={{ fontSize: 12, background: '#2c3e50' }}>+ New</button>
          <button onClick={onCloneStrategy} disabled={!editingStrategy} style={{ fontSize: 12, background: '#2c3e50' }}>Clone</button>
          <button onClick={onDeleteStrategy} disabled={!editingStrategy || strategies.length <= 1} style={{ fontSize: 12, background: '#3a1a1a', color: '#e74c3c' }}>Delete</button>
          <span style={{ flex: 1 }} />
          <button
            onClick={onActivateStrategy}
            disabled={!editingStrategy || isActive}
            style={{ fontSize: 12, background: isActive ? '#1a3a1a' : '#1a4a2a', color: isActive ? '#2ecc71' : '#fff', border: isActive ? '1px solid #2ecc71' : 'none' }}
          >
            {isActive ? '★ Active' : '☆ Activate'}
          </button>
          <button onClick={onSaveStrategy} disabled={!editingStrategy} style={{ fontSize: 12, background: '#27ae60' }}>
            Save Strategy
          </button>
        </div>

        {strategyMsg && (
          <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: strategyMsg.type === 'ok' ? '#1a3a2a' : '#3a1a1a', color: strategyMsg.type === 'ok' ? '#2ecc71' : '#e74c3c' }}>
            {strategyMsg.text}
          </div>
        )}

        {editingStrategy && (
          <>
            <ConfigField label="Name">
              <input
                type="text"
                value={editingStrategy.name}
                onChange={(e) => onStrategyChange({ name: e.target.value })}
                style={{ width: 240, fontSize: 13 }}
              />
            </ConfigField>
            <ConfigField label="Description" hint="Optional note about this strategy's intent">
              <input
                type="text"
                value={editingStrategy.description ?? ''}
                onChange={(e) => onStrategyChange({ description: e.target.value })}
                style={{ width: 380, fontSize: 13 }}
              />
            </ConfigField>
          </>
        )}
      </ConfigSection>

      {/* ── Screening pipeline ── */}
      {editingStrategy && (
        <ConfigSection label="Screening Pipeline">
          <ConfigField label="Universe" hint="Strict screener filter applied first; then Validate/Analysis gates below">
            <select
              value={editingStrategy.screenerUniverse}
              onChange={(e) => onStrategyChange({ screenerUniverse: e.target.value as AgentStrategy['screenerUniverse'] })}
              style={{ fontSize: 13 }}
            >
              <option value="sp500">S&P 500</option>
              <option value="russell1000">Russell 1000</option>
              <option value="both">Both</option>
            </select>
          </ConfigField>

          <ConfigField label="Screening Mode" hint="Which gate(s) candidates must pass after the screener filter">
            <select
              value={editingStrategy.screeningMode}
              onChange={(e) => onStrategyChange({ screeningMode: e.target.value as AgentStrategy['screeningMode'] })}
              style={{ fontSize: 13 }}
            >
              <option value="analysis">Analysis only — option structure must match</option>
              <option value="validate">Validate only — stock buy-strength must pass</option>
              <option value="both">Both — stock AND option structure must pass</option>
            </select>
          </ConfigField>

          {(editingStrategy.screeningMode === 'analysis' || editingStrategy.screeningMode === 'both') && (
            <ConfigField label="Option Strategies" hint="Agent will only enter trades using the selected structures">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 2 }}>
                {ALL_OPTION_STRATEGIES.map(type => (
                  <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={editingStrategy.screeningCriteria.optionStrategies.includes(type)}
                      onChange={(e) => {
                        const current = editingStrategy.screeningCriteria.optionStrategies;
                        const next = e.target.checked ? [...current, type] : current.filter(x => x !== type);
                        onStrategyChange({ screeningCriteria: { ...editingStrategy.screeningCriteria, optionStrategies: next } });
                      }}
                    />
                    {OPTION_STRATEGY_LABELS[type]}
                  </label>
                ))}
              </div>
            </ConfigField>
          )}

          {(editingStrategy.screeningMode === 'analysis' || editingStrategy.screeningMode === 'both') && (
            <ConfigField label="Min Composite Score" hint="0–100; Analysis score a stock must reach to be considered">
              <input
                type="number"
                step={5}
                min={0}
                max={100}
                value={editingStrategy.screeningCriteria.minCompositeScore}
                onChange={(e) => onStrategyChange({ screeningCriteria: { ...editingStrategy.screeningCriteria, minCompositeScore: parseInt(e.target.value, 10) } })}
                style={{ width: 90, fontSize: 13 }}
              />
            </ConfigField>
          )}

          {(editingStrategy.screeningMode === 'validate' || editingStrategy.screeningMode === 'both') && (
            <ConfigField label="Min Buy Strength" hint="0–100; Validate score a stock must reach to be considered">
              <input
                type="number"
                step={5}
                min={0}
                max={100}
                value={editingStrategy.screeningCriteria.minBuyStrength}
                onChange={(e) => onStrategyChange({ screeningCriteria: { ...editingStrategy.screeningCriteria, minBuyStrength: parseInt(e.target.value, 10) } })}
                style={{ width: 90, fontSize: 13 }}
              />
            </ConfigField>
          )}
        </ConfigSection>
      )}

      {/* ── Trade filters (per strategy) ── */}
      {editingStrategy && (
        <ConfigSection label="Trade Filters">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
            {sNum('DTE Min', 'dteMin', 1, 'Minimum days to expiration')}
            {sNum('DTE Max', 'dteMax', 1, 'Maximum days to expiration')}
            {sNum('Delta Min', 'deltaMin', 0.01, 'Min put delta (e.g. 0.20 = 20-delta)')}
            {sNum('Delta Max', 'deltaMax', 0.01, 'Max put delta (e.g. 0.35 = 35-delta)')}
          </div>
          {sNum('Min IV %', 'minIv', 1, 'Only enter when current IV ≥ this % (e.g. 20 = 20%)')}
          {sNum('Min Annualized Return', 'minAnnualizedReturn', 0.01, 'e.g. 0.12 = 12% annualized minimum')}
          {sNum('Earnings Exclusion Days', 'earningsExclusionDays', 1, 'Skip trades within N days of earnings')}
          {sNum('Min Open Interest', 'minOi', 100, 'Minimum OI on the contract for liquidity')}
          {sNum('Max Bid/Ask % Spread', 'maxBidAskPct', 0.005, 'e.g. 0.05 = 5% — filter illiquid contracts')}
          <ConfigField label="Preferred Modes" hint="Comma-separated: wheel, options_income, buy">
            <input
              type="text"
              value={editingStrategy.preferredModes}
              onChange={(e) => onStrategyChange({ preferredModes: e.target.value })}
              style={{ width: 280, fontSize: 13, fontFamily: 'monospace' }}
            />
          </ConfigField>
        </ConfigSection>
      )}

      {/* ── Global: export to .env ── */}
      <div style={{ borderTop: '1px solid #2c2c2c', paddingTop: 16, marginTop: 8 }}>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, alignItems: 'center' }}>
          <h4 style={{ margin: 0, fontSize: 13 }}>Export to .env</h4>
          <span style={{ fontSize: 11, color: '#95a5a6' }}>Writes active strategy + global settings to agent project .env</span>
          <span style={{ flex: 1 }} />
          <button onClick={onSave} disabled={saving || !config} style={{ background: '#2980b9', fontSize: 13 }}>
            {saving ? 'Saving…' : 'Export .env'}
          </button>
          <button onClick={onReset} disabled={saving} style={{ fontSize: 13, background: '#2c2c2c' }}>Reset</button>
        </div>

        {msg && (
          <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 4, fontSize: 12, background: msg.type === 'ok' ? '#1a3a2a' : '#3a1a1a', color: msg.type === 'ok' ? '#2ecc71' : '#e74c3c' }}>
            {msg.text}
          </div>
        )}
      </div>

      {config && (
        <>
          <ConfigSection label="Capital & Risk (global — not per strategy)">
            {numField('Cash Balance ($)', 'cashBalance', 1000, 'Total available cash for the agent to deploy')}
            {numField('Max Positions', 'maxPositions', 1, 'Maximum number of open trades at once')}
            {numField('Max Position % of Cash', 'maxPositionPct', 0.01, 'e.g. 0.20 = 20% of cash per trade')}
            {numField('Max Positions per Sector', 'maxPositionsPerSector', 1, 'Prevents sector concentration')}
            {numField('Kelly Fraction', 'kellyFraction', 0.05, 'Fraction of Kelly criterion to use (0.25 = quarter-Kelly)')}
          </ConfigSection>

          <ConfigSection label="Connection">
            {strField('API URL', 'apiUrl', 'TradeAnalyzer API base URL')}
            {strField('Agent DB Path', 'agentDbPath', 'Absolute path to the agent SQLite database')}
          </ConfigSection>

          <ConfigSection label="Email / Notifications">
            <ConfigField label="Distribution List" hint="Comma-separated email addresses">
              <input type="text" value={config.emailList} onChange={(e) => onChange({ emailList: e.target.value })} placeholder="alice@example.com, bob@example.com" style={{ width: 400, fontSize: 13, fontFamily: 'monospace' }} />
            </ConfigField>
            <ConfigField label="From Address" hint="Sender address shown in the email">
              <input type="text" value={config.smtpFrom} onChange={(e) => onChange({ smtpFrom: e.target.value })} placeholder="traderagent@example.com" style={{ width: 280, fontSize: 13, fontFamily: 'monospace' }} />
            </ConfigField>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
              <ConfigField label="SMTP Host" hint="e.g. smtp.gmail.com">
                <input type="text" value={config.smtpHost} onChange={(e) => onChange({ smtpHost: e.target.value })} placeholder="smtp.gmail.com" style={{ width: 220, fontSize: 13, fontFamily: 'monospace' }} />
              </ConfigField>
              <ConfigField label="SMTP Port" hint="587 = TLS, 465 = SSL">
                <input type="number" step={1} value={config.smtpPort} onChange={(e) => onChange({ smtpPort: parseInt(e.target.value, 10) || 587 })} style={{ width: 90, fontSize: 13 }} />
              </ConfigField>
              <ConfigField label="SMTP Username">
                <input type="text" value={config.smtpUser} onChange={(e) => onChange({ smtpUser: e.target.value })} style={{ width: 220, fontSize: 13, fontFamily: 'monospace' }} />
              </ConfigField>
              <ConfigField label="SMTP Password" hint="App password recommended">
                <input type="password" value={config.smtpPass} onChange={(e) => onChange({ smtpPass: e.target.value })} style={{ width: 220, fontSize: 13, fontFamily: 'monospace' }} />
              </ConfigField>
            </div>
          </ConfigSection>
        </>
      )}
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
