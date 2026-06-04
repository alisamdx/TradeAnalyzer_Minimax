// Retrospect — paper trading dashboard for evaluating Daily Brief accuracy.
// Auto-captures all post-gate picks from each brief run; tracks stock return
// vs entry price using historical_prices (no live API calls).
// see Requirements/paper-trading.md

import { useState, useEffect, useCallback } from 'react';
import type {
  PaperTradeWithPnl,
  PaperTrade,
  PaperTradeSummary,
  StrategyBreakdown,
  RetroSettings,
  RetroStrategySettings,
  ScoringStrategy,
} from '@shared/types.js';

type Tab = 'summary' | 'inprogress' | 'history' | 'settings';

const STRATEGY_LABELS: Record<ScoringStrategy, string> = {
  wheel:   '🎡 Wheel',
  bullish: '🐂 Bullish',
  bearish: '🐻 Bearish',
  income:  '💰 Income',
  buy:     '📈 Buy',
};

const VERDICT_COLOR: Record<string, string> = {
  positive:  '#3fb950',
  negative:  '#f85149',
  neutral:   '#8b949e',
};

// Color stock return based on what's favorable for the strategy — not just sign.
// Income wants small moves (green = small, red = large in either direction).
// Bearish wants stock down (green = down, red = up).
// All others want stock up (green = up, red = down).
function stockReturnColor(pct: number | null, strategy: ScoringStrategy): string {
  if (pct === null) return 'inherit';
  if (strategy === 'income') {
    return Math.abs(pct) <= 5 ? '#3fb950' : Math.abs(pct) <= 8 ? '#e3a008' : '#f85149';
  }
  if (strategy === 'bearish') {
    return pct < -1 ? '#3fb950' : pct > 1 ? '#f85149' : '#8b949e';
  }
  return pct > 1 ? '#3fb950' : pct < -1 ? '#f85149' : '#8b949e';
}

const VERDICT_LABEL: Record<string, string> = {
  positive: 'Positive',
  negative: 'Negative',
  neutral:  'Neutral',
};

const OUTCOME_COLOR: Record<string, string> = {
  win:       '#3fb950',
  loss:      '#f85149',
  breakeven: '#8b949e',
};

function fmtPct(n: number | null, decimals = 1): string {
  if (n === null) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(decimals) + '%';
}

function fmtPrice(n: number | null): string {
  if (n === null) return '—';
  return '$' + n.toFixed(2);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function winRateBar(rate: number | null): React.ReactElement {
  if (rate === null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const color = rate >= 60 ? '#3fb950' : rate >= 40 ? '#e3a008' : '#f85149';
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color, fontWeight: 600 }}>{rate.toFixed(0)}%</span>
      <span style={{ flex: 1, height: 4, background: '#30363d', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.min(100, rate)}%`, background: color, borderRadius: 2 }} />
      </span>
    </span>
  );
}

// ── Summary Tab ───────────────────────────────────────────────────────────────

function SummaryTab({ summary, breakdown }: { summary: PaperTradeSummary | null; breakdown: StrategyBreakdown[] }) {
  if (!summary) return <div className="empty">Loading…</div>;

  return (
    <div className="retro-summary-tab">
      {/* Top-line stats */}
      <div className="retro-stat-bar">
        <div className="retro-stat">
          <span className="retro-stat-val">{summary.totalTrades}</span>
          <span className="retro-stat-label">Total Tracked</span>
        </div>
        <div className="retro-stat">
          <span className="retro-stat-val" style={{ color: '#58a6ff' }}>{summary.openTrades}</span>
          <span className="retro-stat-label">Open</span>
        </div>
        <div className="retro-stat">
          <span className="retro-stat-val">{summary.closedTrades}</span>
          <span className="retro-stat-label">Closed / Expired</span>
        </div>
        <div className="retro-stat">
          <span className="retro-stat-val" style={{ color: summary.winRate !== null && summary.winRate >= 50 ? '#3fb950' : '#f85149' }}>
            {summary.winRate !== null ? summary.winRate.toFixed(0) + '%' : '—'}
          </span>
          <span className="retro-stat-label">Win Rate</span>
        </div>
        <div className="retro-stat">
          <span className="retro-stat-val" style={{ color: summary.avgReturn !== null && summary.avgReturn >= 0 ? '#3fb950' : '#f85149' }}>
            {fmtPct(summary.avgReturn)}
          </span>
          <span className="retro-stat-label">Avg Return</span>
        </div>
      </div>

      {/* Best / Worst */}
      {(summary.bestTrade || summary.worstTrade) && (
        <div className="retro-best-worst">
          {summary.bestTrade && (
            <div className="retro-bw-card retro-bw-best">
              <span className="retro-bw-label">Best Trade</span>
              <span className="retro-bw-ticker">{summary.bestTrade.ticker}</span>
              <span className="retro-bw-return" style={{ color: '#3fb950' }}>{fmtPct(summary.bestTrade.returnPct)}</span>
            </div>
          )}
          {summary.worstTrade && (
            <div className="retro-bw-card retro-bw-worst">
              <span className="retro-bw-label">Worst Trade</span>
              <span className="retro-bw-ticker">{summary.worstTrade.ticker}</span>
              <span className="retro-bw-return" style={{ color: '#f85149' }}>{fmtPct(summary.worstTrade.returnPct)}</span>
            </div>
          )}
        </div>
      )}

      {/* Per-strategy breakdown */}
      {breakdown.length > 0 && (
        <div className="retro-breakdown">
          <div className="retro-section-title">Strategy Accuracy</div>
          <table className="retro-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Total</th>
                <th>Open</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Win Rate</th>
                <th>Avg Return</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map(row => (
                <tr key={row.strategy}>
                  <td>{STRATEGY_LABELS[row.strategy]}</td>
                  <td>{row.total}</td>
                  <td style={{ color: '#58a6ff' }}>{row.open}</td>
                  <td style={{ color: '#3fb950' }}>{row.wins}</td>
                  <td style={{ color: '#f85149' }}>{row.losses}</td>
                  <td style={{ minWidth: 120 }}>{winRateBar(row.winRate)}</td>
                  <td style={{ color: row.avgReturn !== null && row.avgReturn >= 0 ? '#3fb950' : '#f85149' }}>
                    {fmtPct(row.avgReturn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary.totalTrades === 0 && (
        <div className="retro-empty-state">
          <p>No paper trades yet.</p>
          <p className="meta">Run the Daily Intelligence Brief to start tracking picks automatically.</p>
        </div>
      )}
    </div>
  );
}

// ── In Progress Tab ───────────────────────────────────────────────────────────

function InProgressTab({
  positions,
  onClose,
  onDelete,
  loading,
}: {
  positions: PaperTradeWithPnl[];
  onClose: (id: number) => void;
  onDelete: (id: number) => void;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggleExpand = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  if (loading) return <div className="empty">Loading…</div>;
  if (positions.length === 0) return (
    <div className="retro-empty-state">
      <p>No open paper trades.</p>
      <p className="meta">Picks from the next Daily Brief run will appear here automatically.</p>
    </div>
  );

  // Group by brief date
  const byDate = new Map<string, PaperTradeWithPnl[]>();
  for (const p of positions) {
    if (!byDate.has(p.briefDate)) byDate.set(p.briefDate, []);
    byDate.get(p.briefDate)!.push(p);
  }

  return (
    <div className="retro-inprogress-tab">
      {[...byDate.entries()].map(([date, trades]) => (
        <div key={date} className="retro-date-group">
          <div className="retro-date-header">Brief of {fmtDate(date)} · {trades.length} picks</div>
          <table className="retro-table retro-open-table">
            <thead>
              <tr>
                <th></th>
                <th>Ticker</th>
                <th>Strategy</th>
                <th>Structure</th>
                <th>Entry $</th>
                <th>Now $</th>
                <th>Stock %</th>
                <th>Est. P&L</th>
                <th>Days</th>
                <th>Expiry</th>
                <th>Verdict</th>
                <th>Signal</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(p => {
                const stockPct = p.currentPrice !== null && p.entryPrice !== null && p.entryPrice > 0
                  ? (p.currentPrice - p.entryPrice) / p.entryPrice * 100
                  : null;
                const stockColor = stockReturnColor(stockPct, p.briefStrategy);
                const isExpanded = expanded.has(p.id);
                const dteColor = p.daysToExpiry !== null
                  ? p.daysToExpiry <= 2 ? '#f85149'
                    : p.daysToExpiry <= 7 ? '#e3a008'
                    : 'inherit'
                  : 'inherit';

                return (
                  <>
                    <tr key={p.id} className="retro-open-row" onClick={() => toggleExpand(p.id)}
                        style={{ cursor: 'pointer' }}>
                      <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{isExpanded ? '▼' : '▶'}</td>
                      <td style={{ fontWeight: 600, color: '#58a6ff' }}>{p.ticker}</td>
                      <td>{STRATEGY_LABELS[p.briefStrategy]}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.strategyName ?? '—'}</td>
                      <td>{fmtPrice(p.entryPrice)}</td>
                      <td>{fmtPrice(p.currentPrice)}</td>
                      <td style={{ color: stockColor, fontWeight: 600 }}>
                        {fmtPct(stockPct)}
                      </td>
                      <td style={{ color: p.estimatedPnl !== null ? (p.estimatedPnl >= 0 ? '#3fb950' : '#f85149') : 'var(--text-muted)', fontSize: 12 }}>
                        {p.estimatedPnl !== null ? (p.estimatedPnl >= 0 ? '+' : '') + '$' + Math.abs(p.estimatedPnl).toFixed(0) + ' est.' : '—'}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.daysHeld}d</td>
                      <td style={{ color: dteColor, fontSize: 12 }}>
                        {p.expiryDate ? fmtDate(p.expiryDate) + (p.daysToExpiry !== null ? ` (${p.daysToExpiry}d)` : '') : '—'}
                      </td>
                      <td>
                        <span className="retro-verdict-chip" style={{ background: VERDICT_COLOR[p.verdict] + '22', color: VERDICT_COLOR[p.verdict], border: `1px solid ${VERDICT_COLOR[p.verdict]}44` }}>
                          {VERDICT_LABEL[p.verdict]}
                        </span>
                      </td>
                      <td>
                        {p.recommendation === 'close_signal' ? (
                          <span className="retro-close-signal">⚠ Close Signal</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Hold</span>
                        )}
                      </td>
                      <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        <button className="retro-action-btn retro-close-btn" onClick={() => onClose(p.id)}
                          title="Close position — auto-fills exit price from historical prices">
                          Close
                        </button>
                        <button className="retro-action-btn retro-delete-btn" onClick={() => onDelete(p.id)}
                          title="Delete this paper trade record">
                          ✕
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${p.id}-detail`} className="retro-detail-row">
                        <td colSpan={13}>
                          <div className="retro-legs-detail">
                            <span style={{ color: 'var(--text-muted)', fontSize: 12, marginRight: 12 }}>Legs:</span>
                            {(() => {
                              try {
                                type Leg = { action: string; side: string; strike: number; expiration: string; mid: number; delta: number | null; qty: number };
                                const legs = JSON.parse(p.legsJson) as Leg[];
                                if (legs.length === 0) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No leg data available</span>;
                                return legs.map((l, i) => (
                                  <span key={i} className="retro-leg-chip">
                                    {l.action === 'sell' ? 'Short' : 'Long'} {l.side} ${l.strike} · {l.expiration}
                                    {l.mid ? ` · $${l.mid.toFixed(2)}` : ''}
                                    {l.delta ? ` · Δ${l.delta.toFixed(2)}` : ''}
                                  </span>
                                ));
                              } catch {
                                return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No leg data</span>;
                              }
                            })()}
                            {p.entryPremium !== null && (
                              <span style={{ marginLeft: 12, fontSize: 12, color: p.entryPremium >= 0 ? '#3fb950' : '#f85149' }}>
                                {p.entryPremium >= 0 ? `$${p.entryPremium.toFixed(2)} credit` : `$${Math.abs(p.entryPremium).toFixed(2)} debit`}
                              </span>
                            )}
                            {p.priceDate && (
                              <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>
                                Price as of {fmtDate(p.priceDate)}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────

function HistoryTab({ trades, loading }: { trades: PaperTrade[]; loading: boolean }) {
  if (loading) return <div className="empty">Loading…</div>;
  if (trades.length === 0) return (
    <div className="retro-empty-state">
      <p>No closed trades yet.</p>
      <p className="meta">Trades close when you click Close, or auto-expire when their expiry date passes.</p>
    </div>
  );

  return (
    <div className="retro-history-tab">
      <table className="retro-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Strategy</th>
            <th>Structure</th>
            <th>Brief Date</th>
            <th>Entry $</th>
            <th>Exit $</th>
            <th>Stock %</th>
            <th>Exit Date</th>
            <th>Status</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(t => (
            <tr key={t.id}>
              <td style={{ fontWeight: 600, color: '#58a6ff' }}>{t.ticker}</td>
              <td>{STRATEGY_LABELS[t.briefStrategy]}</td>
              <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.strategyName ?? '—'}</td>
              <td style={{ fontSize: 12 }}>{fmtDate(t.briefDate)}</td>
              <td>{fmtPrice(t.entryPrice)}</td>
              <td>{fmtPrice(t.exitPrice)}</td>
              <td style={{ color: stockReturnColor(t.stockReturnPct, t.briefStrategy), fontWeight: 600 }}>
                {fmtPct(t.stockReturnPct)}
              </td>
              <td style={{ fontSize: 12 }}>{fmtDate(t.exitDate)}</td>
              <td style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{t.status}</td>
              <td>
                {t.outcome ? (
                  <span style={{ color: OUTCOME_COLOR[t.outcome], fontWeight: 600, textTransform: 'capitalize' }}>
                    {t.outcome}
                  </span>
                ) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Settings Tab ──────────────────────────────────────────────────────────────

const STRATEGY_ORDER: ScoringStrategy[] = ['wheel', 'bullish', 'bearish', 'income', 'buy'];

function SettingsTab({ settings, onSave }: { settings: RetroSettings | null; onSave: (s: RetroSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<RetroSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => { if (settings && !draft) setDraft(settings); }, [settings, draft]);

  if (!draft) return <div className="empty">Loading…</div>;

  const update = (strategy: ScoringStrategy, field: keyof RetroStrategySettings, value: number) => {
    setDraft(prev => prev ? {
      ...prev,
      [strategy]: { ...prev[strategy], [field]: value },
    } : null);
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      await onSave(draft);
      setMsg({ type: 'ok', text: 'Settings saved.' });
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(null), 3000);
    }
  };

  const fieldLabel: Record<keyof RetroStrategySettings, string> = {
    negThresholdPct:          'Negative threshold (%)',
    incomeRangeThresholdPct:  'Income range threshold (%)',
    closeSignalDte:           'Close Signal DTE ≤',
    maxMoveAgainstPct:        'Max move against (%) → Close Signal',
  };

  const fieldNote: Partial<Record<keyof RetroStrategySettings, string>> = {
    negThresholdPct:         'Stock must move this % against the trade to be "negative"',
    incomeRangeThresholdPct: 'Income only: move in either direction beyond this % = negative',
    closeSignalDte:          'When trade is negative and DTE ≤ this, raise Close Signal',
    maxMoveAgainstPct:       'Unconditional Close Signal when stock moves this % against you',
  };

  return (
    <div className="retro-settings-tab">
      <div className="retro-section-title">Verdict Thresholds</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
        These thresholds determine when a trade is marked Positive / Negative and when a Close Signal is raised.
        Defaults are based on standard options risk management. Tune after accumulating ≥ 20 closed trades.
      </p>

      {STRATEGY_ORDER.map(strategy => (
        <div key={strategy} className="retro-settings-strategy">
          <div className="retro-settings-strategy-header">{STRATEGY_LABELS[strategy]}</div>
          <div className="retro-settings-fields">
            {(Object.keys(fieldLabel) as Array<keyof RetroStrategySettings>)
              .filter(f => strategy !== 'income' || f !== 'negThresholdPct' ? true : false)
              .map(field => (
                <div key={field} className="retro-settings-field">
                  <label className="retro-settings-label">
                    {fieldLabel[field]}
                    {fieldNote[field] && <span className="retro-settings-note">{fieldNote[field]}</span>}
                  </label>
                  <input
                    type="number"
                    className="retro-settings-input"
                    value={draft[strategy][field]}
                    min={0}
                    max={field === 'closeSignalDte' ? 60 : 100}
                    step={field === 'closeSignalDte' ? 1 : 0.5}
                    onChange={e => update(strategy, field, parseFloat(e.target.value) || 0)}
                  />
                </div>
              ))
            }
          </div>
        </div>
      ))}

      <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {msg && (
          <span style={{ fontSize: 13, color: msg.type === 'ok' ? '#3fb950' : '#f85149' }}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────

export function RetrospectView() {
  const [tab, setTab] = useState<Tab>('inprogress');
  const [openPositions, setOpenPositions] = useState<PaperTradeWithPnl[]>([]);
  const [closedTrades, setClosedTrades] = useState<PaperTrade[]>([]);
  const [summary, setSummary] = useState<PaperTradeSummary | null>(null);
  const [breakdown, setBreakdown] = useState<StrategyBreakdown[]>([]);
  const [settings, setSettings] = useState<RetroSettings | null>(null);
  const [loadingOpen, setLoadingOpen] = useState(false);
  const [loadingClosed, setLoadingClosed] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadOpen = useCallback(async () => {
    setLoadingOpen(true);
    try {
      const [open, sum, bd] = await Promise.all([
        window.api.paper.listOpen(),
        window.api.paper.summary(),
        window.api.paper.strategyBreakdown(),
      ]);
      setOpenPositions(open);
      setSummary(sum);
      setBreakdown(bd);
    } catch (err) {
      console.error('[retrospect] load open error:', err);
    } finally {
      setLoadingOpen(false);
    }
  }, []);

  const loadClosed = useCallback(async () => {
    setLoadingClosed(true);
    try {
      const trades = await window.api.paper.listClosed(200);
      setClosedTrades(trades);
    } catch (err) {
      console.error('[retrospect] load closed error:', err);
    } finally {
      setLoadingClosed(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await window.api.paper.getSettings();
      setSettings(s);
    } catch (err) {
      console.error('[retrospect] load settings error:', err);
    }
  }, []);

  // On mount: expire stale positions, then load data
  useEffect(() => {
    (async () => {
      try {
        const expired = await window.api.paper.expireStale();
        if (expired > 0) console.log(`[retrospect] auto-expired ${expired} positions`);
      } catch { /* non-fatal */ }
      await loadOpen();
    })();
  }, [loadOpen]);

  useEffect(() => {
    if (tab === 'history') loadClosed();
    if (tab === 'settings') loadSettings();
    if (tab === 'summary') loadOpen();
  }, [tab, loadClosed, loadSettings, loadOpen]);

  const handleClose = async (id: number) => {
    try {
      await window.api.paper.close(id);
      setStatusMsg('Position closed.');
      setTimeout(() => setStatusMsg(null), 3000);
      await loadOpen();
      if (tab === 'history') await loadClosed();
    } catch (err) {
      setStatusMsg('Error: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await window.api.paper.delete(id);
      await loadOpen();
    } catch (err) {
      console.error('[retrospect] delete error:', err);
    }
  };

  const handleSaveSettings = async (s: RetroSettings) => {
    await window.api.paper.saveSettings(s);
    setSettings(s);
  };

  const closeSignalCount = openPositions.filter(p => p.recommendation === 'close_signal').length;

  return (
    <div className="view retro-view">
      {/* Header */}
      <div className="retro-header toolbar">
        <h2>Retrospect</h2>
        <span className="meta" style={{ marginLeft: 8 }}>Daily Brief performance tracker</span>
        {closeSignalCount > 0 && (
          <span className="retro-alert-badge">
            ⚠ {closeSignalCount} Close Signal{closeSignalCount !== 1 ? 's' : ''}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {statusMsg && <span style={{ fontSize: 13, color: '#3fb950' }}>{statusMsg}</span>}
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {summary && `${summary.openTrades} open · ${summary.closedTrades} closed`}
        </div>
      </div>

      {/* Tabs */}
      <div className="retro-tabs">
        {([
          ['inprogress', 'In Progress', openPositions.length],
          ['summary',    'Summary',     null],
          ['history',    'History',     null],
          ['settings',   'Settings',    null],
        ] as [Tab, string, number | null][]).map(([id, label, count]) => (
          <button
            key={id}
            className={`tab-btn ${tab === id ? 'active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}{count !== null ? ` (${count})` : ''}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="retro-content">
        {tab === 'summary'    && <SummaryTab summary={summary} breakdown={breakdown} />}
        {tab === 'inprogress' && (
          <InProgressTab
            positions={openPositions}
            onClose={handleClose}
            onDelete={handleDelete}
            loading={loadingOpen}
          />
        )}
        {tab === 'history'  && <HistoryTab trades={closedTrades} loading={loadingClosed} />}
        {tab === 'settings' && <SettingsTab settings={settings} onSave={handleSaveSettings} />}
      </div>
    </div>
  );
}
