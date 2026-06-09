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
  SnapshotAccuracy,
  TradeActionType,
  TradeLearning,
  TradeLearningGapCause,
  BriefLearningRecommendation,
  BriefPickDetail,
} from '@shared/types.js';

type Tab = 'summary' | 'inprogress' | 'history' | 'settings' | 'brieftrend';

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

const ACTION_COLOR: Record<TradeActionType, string> = {
  close:       '#f85149',
  take_profit: '#3fb950',
  roll:        '#58a6ff',
  watch:       '#e3a008',
  hold:        '#8b949e',
};
const ACTION_LABEL: Record<TradeActionType, string> = {
  close:       '⚑ Close',
  take_profit: '✓ Take Profit',
  roll:        '↻ Roll',
  watch:       '◉ Watch',
  hold:        '— Hold',
};
const ENTRY_FIT_LABEL: Record<string, string> = {
  good: 'Good entry', early: 'Entry too early', late: 'Entry too late', wrong: 'Wrong setup',
};
const ENTRY_FIT_COLOR: Record<string, string> = {
  good: '#3fb950', early: '#e3a008', late: '#e3a008', wrong: '#f85149',
};
const GAP_CAUSE_LABEL: Record<TradeLearningGapCause, string> = {
  EARNINGS_GAP_RISK:   '📅 Earnings gap',
  IV_CRUSH:            '📉 IV crush',
  TREND_REVERSAL:      '↩ Trend reversal',
  THETA_UNDERESTIMATE: '⏱ Theta underestimate',
  EARLY_CLOSE_MISSED:  '💸 Early close',
  MODEL_ERROR:         '❓ Model error',
};
const GAP_CAUSE_COLOR: Record<TradeLearningGapCause, string> = {
  EARNINGS_GAP_RISK:   '#f85149',
  IV_CRUSH:            '#e3a008',
  TREND_REVERSAL:      '#f85149',
  THETA_UNDERESTIMATE: '#58a6ff',
  EARLY_CLOSE_MISSED:  '#3fb950',
  MODEL_ERROR:         '#8b949e',
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

const GAP_CAUSE_BADGE_STYLE = (cause: TradeLearningGapCause) => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 11,
  fontWeight: 600,
  background: GAP_CAUSE_COLOR[cause] + '22',
  color: GAP_CAUSE_COLOR[cause],
  border: `1px solid ${GAP_CAUSE_COLOR[cause]}44`,
});

// ── Summary Tab ───────────────────────────────────────────────────────────────

function SummaryTab({
  summary,
  breakdown,
  snapAccuracy,
  recommendations,
}: {
  summary: PaperTradeSummary | null;
  breakdown: StrategyBreakdown[];
  snapAccuracy: SnapshotAccuracy | null;
  recommendations: BriefLearningRecommendation[];
}) {
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
          <div className="retro-section-title">
            Strategy Accuracy
            <span className="retro-snapshot-subtitle">Win Rate and Avg Return reflect closed / expired trades only</span>
          </div>
          <table className="retro-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Total</th>
                <th>Open</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Win Rate <span className="retro-col-note">(closed)</span></th>
                <th>Avg Return <span className="retro-col-note">(closed)</span></th>
                {snapAccuracy && snapAccuracy.totalSnapshots > 0 && (
                  <>
                    <th>Day+1 Acc <span className="retro-col-note">(snapshots)</span></th>
                    <th>Day+1 Avg <span className="retro-col-note">(snapshots)</span></th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {breakdown.map(row => {
                const snap = snapAccuracy?.byStrategy.find(s => s.strategy === row.strategy);
                return (
                  <tr key={row.strategy}>
                    <td>{STRATEGY_LABELS[row.strategy]}</td>
                    <td>{row.total}</td>
                    <td style={{ color: '#58a6ff' }}>{row.open}</td>
                    <td style={{ color: '#3fb950' }}>{row.wins}</td>
                    <td style={{ color: '#f85149' }}>{row.losses}</td>
                    <td style={{ minWidth: 110 }}>
                      {row.winRate !== null ? winRateBar(row.winRate) : <span className="retro-no-data">no closed trades</span>}
                    </td>
                    <td style={{ color: row.avgReturn !== null && row.avgReturn >= 0 ? '#3fb950' : '#f85149' }}>
                      {row.avgReturn !== null ? fmtPct(row.avgReturn) : <span className="retro-no-data">—</span>}
                    </td>
                    {snapAccuracy && snapAccuracy.totalSnapshots > 0 && (
                      <>
                        <td style={{ minWidth: 110 }}>
                          {snap && snap.accuracy !== null
                            ? winRateBar(snap.accuracy)
                            : <span className="retro-no-data">{snap ? 'need ≥ 3' : '—'}</span>}
                        </td>
                        <td style={{ color: snap?.avgReturn != null && snap.avgReturn >= 0 ? '#3fb950' : '#f85149' }}>
                          {snap?.avgReturn != null ? fmtPct(snap.avgReturn) : <span className="retro-no-data">—</span>}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
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

      {/* Pattern Recommendations (1c) */}
      {recommendations.length > 0 && (
        <div className="retro-snapshot-section">
          <div className="retro-section-title">
            Pattern Recommendations
            <span className="retro-snapshot-subtitle">Auto-generated from recurring gap causes (≥ 3 occurrences)</span>
          </div>
          <p className="retro-snapshot-desc">
            These suggestions are based on patterns detected across your closed paper trades.
            Apply them in <strong>Trade Scoring Config</strong> or <strong>Retrospect Settings</strong>.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recommendations.map(rec => (
              <div key={rec.id} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={GAP_CAUSE_BADGE_STYLE(rec.gapCause)}>{GAP_CAUSE_LABEL[rec.gapCause]}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {STRATEGY_LABELS[rec.strategy as ScoringStrategy] ?? rec.strategy} · {rec.occurrenceCount}× observed
                  </span>
                  {rec.status === 'acknowledged' && (
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8b949e', fontWeight: 600 }}>✓ Acknowledged</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#c9d1d9', marginBottom: 4 }}>{rec.description}</div>
                {rec.proposedTweak && (
                  <div style={{ fontSize: 12, color: '#58a6ff', fontStyle: 'italic' }}>💡 {rec.proposedTweak}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Next-Day Accuracy (snapshot-based) ── */}
      {snapAccuracy && snapAccuracy.totalSnapshots > 0 && (
        <div className="retro-snapshot-section">
          <div className="retro-section-title">
            Next-Day Accuracy
            <span className="retro-snapshot-subtitle">
              {snapAccuracy.totalSnapshots} snapshot{snapAccuracy.totalSnapshots !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="retro-snapshot-desc">
            Measures whether each pick moved in the right direction by the <strong>first trading-day close after the brief</strong>.
            Uses the same verdict thresholds as the live view (Positive / Negative / Neutral) so results are strategy-aware —
            e.g. Bearish picks are Positive when the stock drops.
            Unlike the Win Rate above (which only counts closed/expired options), this updates within one trading day
            and lets you spot scoring-engine improvements quickly.
          </p>

          {/* By strategy */}
          {snapAccuracy.byStrategy.length > 0 && (
            <table className="retro-table retro-snapshot-table">
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Picks</th>
                  <th style={{ color: '#3fb950' }}>Positive</th>
                  <th style={{ color: '#f85149' }}>Negative</th>
                  <th style={{ color: '#8b949e' }}>Neutral</th>
                  <th>Accuracy</th>
                  <th>Avg Return</th>
                </tr>
              </thead>
              <tbody>
                {snapAccuracy.byStrategy.map(row => (
                  <tr key={row.strategy}>
                    <td>{STRATEGY_LABELS[row.strategy]}</td>
                    <td>{row.total}</td>
                    <td style={{ color: '#3fb950' }}>{row.positives}</td>
                    <td style={{ color: '#f85149' }}>{row.negatives}</td>
                    <td style={{ color: '#8b949e' }}>{row.neutrals}</td>
                    <td style={{ minWidth: 120 }}>
                      {row.accuracy !== null
                        ? winRateBar(row.accuracy)
                        : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>need ≥ 3</span>}
                    </td>
                    <td style={{ color: row.avgReturn != null && row.avgReturn >= 0 ? '#3fb950' : '#f85149' }}>
                      {fmtPct(row.avgReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* By brief date */}
          {snapAccuracy.byBriefDate.length > 0 && (
            <>
              <div className="retro-section-title retro-section-title-sm">Brief Accuracy Trend</div>
              <p className="retro-snapshot-desc retro-snapshot-desc-sm">
                Each row is one brief. A brief only appears once its picks have at least one trading-day close in the price history —
                so the most recent brief is often absent until the next day's prices load.
                Use this to see whether accuracy is improving as you tune signal weights.
              </p>
              <table className="retro-table retro-snapshot-table">
                <thead>
                  <tr>
                    <th>Brief Date</th>
                    <th>Picks</th>
                    <th style={{ color: '#3fb950' }}>Positive</th>
                    <th style={{ color: '#f85149' }}>Negative</th>
                    <th>Accuracy</th>
                    <th>Avg Return</th>
                  </tr>
                </thead>
                <tbody>
                  {snapAccuracy.byBriefDate.map(row => (
                    <tr key={row.briefDate}>
                      <td style={{ fontWeight: 600 }}>{fmtDate(row.briefDate)}</td>
                      <td>{row.total}</td>
                      <td style={{ color: '#3fb950' }}>{row.positives}</td>
                      <td style={{ color: '#f85149' }}>{row.negatives}</td>
                      <td style={{ minWidth: 120 }}>
                        {row.accuracy !== null
                          ? winRateBar(row.accuracy)
                          : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>need ≥ 3</span>}
                      </td>
                      <td style={{ color: row.avgReturn != null && row.avgReturn >= 0 ? '#3fb950' : '#f85149' }}>
                        {fmtPct(row.avgReturn)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {snapAccuracy && snapAccuracy.totalSnapshots === 0 && summary.totalTrades > 0 && (
        <div className="retro-snapshot-section retro-snapshot-empty">
          <div className="retro-section-title">Next-Day Accuracy</div>
          <p className="meta">No snapshots yet — the Daily Paper Trade Snapshot job runs at 17:00 ET after market close.</p>
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

  // Sorted unique brief dates, descending (latest first)
  const briefDates = [...new Set(positions.map(p => p.briefDate))].sort((a, b) => b.localeCompare(a));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Always default to latest when positions reload
  const effectiveDate = selectedDate && briefDates.includes(selectedDate)
    ? selectedDate
    : briefDates[0] ?? null;

  const toggleExpand = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  if (loading) return <div className="empty">Loading…</div>;
  if (positions.length === 0) return (
    <div className="retro-empty-state">
      <p>No open paper trades.</p>
      <p className="meta">Picks from the next Daily Brief run will appear here automatically.</p>
    </div>
  );

  const trades = effectiveDate ? positions.filter(p => p.briefDate === effectiveDate) : [];

  return (
    <div className="retro-inprogress-tab">
      {/* Brief date selector */}
      <div className="retro-brief-selector">
        <label className="retro-brief-selector-label">Brief</label>
        <select
          className="retro-brief-select"
          value={effectiveDate ?? ''}
          onChange={e => { setSelectedDate(e.target.value); setExpanded(new Set()); }}
        >
          {briefDates.map(d => (
            <option key={d} value={d}>
              {fmtDate(d)}{d === briefDates[0] ? ' — latest' : ''}
            </option>
          ))}
        </select>
        <span className="retro-brief-selector-count">{trades.length} pick{trades.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="retro-date-group">
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
                <th>Action</th>
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
                        <div className="retro-action-cell">
                          <span
                            className="retro-action-badge"
                            style={{ background: ACTION_COLOR[p.insight.action] + '22', color: ACTION_COLOR[p.insight.action], borderColor: ACTION_COLOR[p.insight.action] + '55' }}
                          >
                            {ACTION_LABEL[p.insight.action]}
                          </span>
                          <span className="retro-action-reason">{p.insight.reason}</span>
                        </div>
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
                          {/* Recommendation suggestion */}
                          {p.insight.suggestion && (
                            <div className="retro-insight-suggestion" style={{ borderLeftColor: ACTION_COLOR[p.insight.action] }}>
                              <span className="retro-insight-icon" style={{ color: ACTION_COLOR[p.insight.action] }}>→</span>
                              <span>{p.insight.suggestion}</span>
                            </div>
                          )}
                          {/* Legs */}
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
    </div>
  );
}

// ── History Tab ───────────────────────────────────────────────────────────────

function LearningCell({ learning }: { learning: TradeLearning | null }) {
  if (!learning) return <span className="retro-no-data">capturing…</span>;
  return (
    <div className="retro-learning-cell">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="retro-learning-fit" style={{ color: ENTRY_FIT_COLOR[learning.entryFit] }}>
          {ENTRY_FIT_LABEL[learning.entryFit] ?? learning.entryFit}
        </span>
        {learning.strategyWorked
          ? <span className="retro-learning-worked">strategy worked</span>
          : <span className="retro-learning-failed">strategy missed</span>}
        {learning.gapCause && (
          <span style={{
            fontSize: 10, padding: '1px 6px', borderRadius: 3, fontWeight: 600,
            background: GAP_CAUSE_COLOR[learning.gapCause] + '22',
            color: GAP_CAUSE_COLOR[learning.gapCause],
            border: `1px solid ${GAP_CAUSE_COLOR[learning.gapCause]}44`,
          }}>
            {GAP_CAUSE_LABEL[learning.gapCause]}
          </span>
        )}
      </div>
      <div className="retro-learning-lesson">{learning.keyLesson}</div>
      {learning.suggestedTweak && (
        <div className="retro-learning-tweak">💡 {learning.suggestedTweak}</div>
      )}
    </div>
  );
}

function HistoryTab({ trades, loading }: { trades: PaperTrade[]; loading: boolean }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

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
            <th></th>
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
          {trades.map(t => {
            const hasLearning = t.learning !== null;
            const isExpanded  = expanded.has(t.id);
            return (
              <>
                <tr key={t.id}
                    className={hasLearning ? 'retro-history-row retro-has-learning' : 'retro-history-row'}
                    style={{ cursor: hasLearning ? 'pointer' : 'default' }}
                    onClick={() => hasLearning && toggleExpand(t.id)}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                    {hasLearning ? (isExpanded ? '▼' : '▶') : ''}
                  </td>
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
                {isExpanded && t.learning && (
                  <tr key={`${t.id}-learning`} className="retro-learning-row">
                    <td></td>
                    <td colSpan={10}>
                      <LearningCell learning={t.learning} />
                    </td>
                  </tr>
                )}
              </>
            );
          })}
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

// ── Brief Trend Tab ───────────────────────────────────────────────────────────

const CRITIC_COLORS: Record<string, string> = {
  pass:    '#3fb950',
  caution: '#e3a008',
  flag:    '#f85149',
};

function BriefTrendTab() {
  const [dates, setDates]           = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [picks, setPicks]           = useState<BriefPickDetail[]>([]);
  const [loading, setLoading]       = useState(false);
  const [stratFilter, setStratFilter] = useState<ScoringStrategy | 'all'>('all');

  // Load available brief dates on mount
  useEffect(() => {
    window.api.paper.briefDates().then(d => {
      setDates(d);
      if (d.length > 0) setSelectedDate(d[0]!);
    }).catch(() => {});
  }, []);

  // Reload picks when date changes
  useEffect(() => {
    if (!selectedDate) return;
    setLoading(true);
    window.api.paper.briefPickDrilldown(selectedDate)
      .then(p => setPicks(p))
      .catch(() => setPicks([]))
      .finally(() => setLoading(false));
  }, [selectedDate]);

  const filtered = stratFilter === 'all'
    ? picks
    : picks.filter(p => p.strategy === stratFilter);

  const ratedPicks  = filtered.filter(p => p.day5Verdict !== null);
  const hits        = ratedPicks.filter(p => p.day5Verdict === 'positive').length;
  const avgReturn   = ratedPicks.length > 0
    ? ratedPicks.reduce((s, p) => s + (p.day5ReturnPct ?? 0), 0) / ratedPicks.length
    : null;

  // Which strategies actually appear in this brief (for filter chips)
  const presentStrategies = [...new Set(picks.map(p => p.strategy))] as ScoringStrategy[];

  return (
    <div>
      {/* Controls row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ color: 'var(--text-muted)', fontSize: 13 }}>Brief date:</label>
        <select
          value={selectedDate ?? ''}
          onChange={e => setSelectedDate(e.target.value)}
          style={{
            background: '#161b22', border: '1px solid #30363d', color: '#c9d1d9',
            borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer',
          }}
        >
          {dates.length === 0 && <option value="">No briefs yet</option>}
          {dates.map(d => <option key={d} value={d}>{d}</option>)}
        </select>

        {/* Strategy filter chips */}
        {presentStrategies.length > 1 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['all', ...presentStrategies] as const).map(s => (
              <button
                key={s}
                onClick={() => setStratFilter(s)}
                style={{
                  padding: '3px 10px', borderRadius: 12, fontSize: 12, cursor: 'pointer', fontWeight: 500,
                  background: stratFilter === s ? '#1f6feb' : '#21262d',
                  border: `1px solid ${stratFilter === s ? '#388bfd' : '#30363d'}`,
                  color: stratFilter === s ? '#fff' : '#8b949e',
                }}
              >
                {s === 'all' ? 'All' : STRATEGY_LABELS[s]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Summary bar */}
      {ratedPicks.length > 0 && (
        <div className="brief-perf-banner" style={{ marginBottom: 14 }}>
          <span className="brief-perf-label" style={{ cursor: 'default' }}>
            📋 {selectedDate}:
          </span>
          <span className="brief-perf-chip">
            <span style={{ color: '#8b949e' }}>{filtered.length} picks</span>
          </span>
          <span className="brief-perf-chip">
            <span style={{ color: '#8b949e' }}>Day+5 rated:</span>
            {' '}
            <span style={{
              color: hits / ratedPicks.length >= 0.6 ? '#3fb950' : hits / ratedPicks.length >= 0.4 ? '#e3a008' : '#f85149',
              fontWeight: 700,
            }}>
              {hits}/{ratedPicks.length}
            </span>
          </span>
          {avgReturn !== null && (
            <span className="brief-perf-chip">
              <span style={{ color: '#8b949e' }}>avg return:</span>
              {' '}
              <span style={{ color: avgReturn >= 0 ? '#3fb950' : '#f85149', fontWeight: 700 }}>
                {fmtPct(avgReturn)}
              </span>
            </span>
          )}
        </div>
      )}

      {/* Table */}
      {loading && <div style={{ color: 'var(--text-muted)', padding: '24px 0' }}>Loading…</div>}

      {!loading && filtered.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="retro-table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th title="Ticker symbol">Ticker</th>
                <th title="Scoring strategy this pick came from">Strategy</th>
                <th title="Composite score (0–100) on brief day">Score</th>
                <th title="Stock price at time the brief was generated">Brief Price</th>
                <th title="Recommended entry zone from buy-mode analysis snapshot (buy strategy only)">Entry Zone</th>
                <th title="Was the brief-day price inside the entry zone? (buy strategy only)">In Zone?</th>
                <th title="Stock price at Day+5 (first snapshot with days_held ≥ 5). Number in parentheses = actual days elapsed.">Day+5 Price</th>
                <th title="Return % from brief price to Day+5 price. Colour interpretation: green = favorable for strategy, red = unfavorable (bearish strategy: green = price fell).">Return %</th>
                <th title="Outcome verdict at Day+5: ✅ positive · ❌ negative · ➖ neutral · ⏳ awaiting snapshot">Outcome</th>
                <th title="AI critic verdict from the brief: pass (confident pick) · caution (proceed with care) · flag (risk concern). Hover for the critic's rationale.">Critic</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const inZone =
                  p.entryZoneLow !== null && p.entryZoneHigh !== null && p.briefPrice !== null
                    ? p.briefPrice >= p.entryZoneLow && p.briefPrice <= p.entryZoneHigh
                    : null;

                const scoreColor = p.briefScore >= 70 ? '#3fb950' : p.briefScore >= 50 ? '#e3a008' : '#f85149';

                const outcomeEl =
                  p.day5Verdict === 'positive' ? <span title="Profitable at Day+5">✅</span> :
                  p.day5Verdict === 'negative' ? <span title="Loss at Day+5">❌</span> :
                  p.day5Verdict === 'neutral'  ? <span title="Roughly flat at Day+5" style={{ color: '#8b949e' }}>➖</span> :
                  <span title="Day+5 snapshot not yet available" style={{ color: '#8b949e' }}>⏳</span>;

                const criticEl = p.criticVerdict ? (
                  <span
                    title={p.criticRationale ?? p.criticVerdict}
                    style={{
                      display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                      fontSize: 11, fontWeight: 600, cursor: p.criticRationale ? 'help' : 'default',
                      background: CRITIC_COLORS[p.criticVerdict] + '22',
                      color: CRITIC_COLORS[p.criticVerdict],
                      border: `1px solid ${CRITIC_COLORS[p.criticVerdict]}44`,
                    }}
                  >
                    {p.criticVerdict}
                  </span>
                ) : <span style={{ color: '#8b949e' }}>—</span>;

                const entryZoneEl = p.entryZoneLow !== null && p.entryZoneHigh !== null
                  ? <span title="Entry zone computed from buy analysis snapshot nearest to brief date">
                      {fmtPrice(p.entryZoneLow)} – {fmtPrice(p.entryZoneHigh)}
                    </span>
                  : <span style={{ color: '#8b949e' }}>—</span>;

                const inZoneEl =
                  inZone === true  ? <span style={{ color: '#3fb950' }} title="Brief price was inside the entry zone">✓</span> :
                  inZone === false ? <span style={{ color: '#e3a008' }} title="Brief price was outside the entry zone">✗</span> :
                  <span style={{ color: '#8b949e' }}>—</span>;

                const day5El = p.day5Price !== null
                  ? <span title={p.day5DaysActual !== null ? `Snapshot at Day+${p.day5DaysActual}` : undefined}>
                      {fmtPrice(p.day5Price)}
                      {p.day5DaysActual !== null && (
                        <span style={{ color: '#8b949e', fontSize: 11, marginLeft: 4 }}>
                          (D+{p.day5DaysActual})
                        </span>
                      )}
                    </span>
                  : <span style={{ color: '#8b949e' }}>⏳</span>;

                return (
                  <tr key={`${p.strategy}:${p.ticker}`}>
                    <td>
                      <span
                        style={{ fontFamily: 'monospace', fontWeight: 700, color: '#58a6ff', cursor: 'help' }}
                        title={p.aiRationale ?? p.ticker}
                      >
                        {p.ticker}
                      </span>
                    </td>
                    <td>
                      <span style={{
                        display: 'inline-block', padding: '1px 7px', borderRadius: 4,
                        fontSize: 11, fontWeight: 600,
                        background: '#1f6feb22', color: '#89b4fa',
                        border: '1px solid #1f6feb44',
                      }}>
                        {STRATEGY_LABELS[p.strategy]}
                      </span>
                    </td>
                    <td style={{ color: scoreColor, fontWeight: 600 }}>{p.briefScore.toFixed(0)}</td>
                    <td>{fmtPrice(p.briefPrice)}</td>
                    <td>{entryZoneEl}</td>
                    <td style={{ textAlign: 'center' }}>{inZoneEl}</td>
                    <td>{day5El}</td>
                    <td style={{
                      color: p.day5ReturnPct !== null ? stockReturnColor(p.day5ReturnPct, p.strategy) : 'inherit',
                      fontWeight: p.day5ReturnPct !== null ? 600 : 400,
                    }}>
                      {fmtPct(p.day5ReturnPct)}
                    </td>
                    <td style={{ textAlign: 'center' }}>{outcomeEl}</td>
                    <td>{criticEl}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && picks.length === 0 && dates.length > 0 && (
        <div style={{ color: 'var(--text-muted)', padding: '32px 0', textAlign: 'center', fontSize: 14 }}>
          No paper trades found for {selectedDate}.
          <div style={{ fontSize: 12, marginTop: 6 }}>
            Trades are created automatically when the Daily Brief runs.
          </div>
        </div>
      )}

      {!loading && dates.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: '32px 0', textAlign: 'center', fontSize: 14 }}>
          No briefs with paper trades yet.
          <div style={{ fontSize: 12, marginTop: 6 }}>
            Run the Daily Brief job — picks are automatically tracked as paper trades.
          </div>
        </div>
      )}
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
  const [snapAccuracy, setSnapAccuracy] = useState<SnapshotAccuracy | null>(null);
  const [settings, setSettings] = useState<RetroSettings | null>(null);
  const [recommendations, setRecommendations] = useState<BriefLearningRecommendation[]>([]);
  const [loadingOpen, setLoadingOpen] = useState(false);
  const [loadingClosed, setLoadingClosed] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadOpen = useCallback(async () => {
    setLoadingOpen(true);
    try {
      const [open, sum, bd, snap, recs] = await Promise.all([
        window.api.paper.listOpen(),
        window.api.paper.summary(),
        window.api.paper.strategyBreakdown(),
        window.api.paper.snapshotAccuracy(),
        window.api.paper.getLearningRecommendations(),
      ]);
      setOpenPositions(open);
      setSummary(sum);
      setBreakdown(bd);
      setSnapAccuracy(snap);
      setRecommendations(recs);
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
          ['inprogress',  'In Progress',  openPositions.length],
          ['summary',     'Summary',      null],
          ['history',     'History',      null],
          ['brieftrend',  'Brief Trend',  null],
          ['settings',    'Settings',     null],
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
        {tab === 'summary'    && <SummaryTab summary={summary} breakdown={breakdown} snapAccuracy={snapAccuracy} recommendations={recommendations} />}
        {tab === 'inprogress' && (
          <InProgressTab
            positions={openPositions}
            onClose={handleClose}
            onDelete={handleDelete}
            loading={loadingOpen}
          />
        )}
        {tab === 'history'    && <HistoryTab trades={closedTrades} loading={loadingClosed} />}
        {tab === 'brieftrend' && <BriefTrendTab />}
        {tab === 'settings'   && <SettingsTab settings={settings} onSave={handleSaveSettings} />}
      </div>
    </div>
  );
}
