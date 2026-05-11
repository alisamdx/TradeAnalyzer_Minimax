// BriefingView - Morning Briefing Dashboard
// Market regime, action items, and top setups
// see SPEC: Priority 7 - Morning Briefing Dashboard

import { useEffect, useState } from 'react';
import { useSortable } from '../hooks/useSortable.js';

type Trend = 'bullish' | 'bearish' | 'neutral';
type VixLevel = 'low' | 'normal' | 'high';
type ActionType = 'expiring' | 'delta_breach' | 'earnings';
type Priority = 'high' | 'medium' | 'low';

interface MarketRegime {
  spyTrend: Trend;
  spyPrice: number | null;
  spySma20: number | null;
  spySma50: number | null;
  vixLevel: VixLevel;
  vixValue: number | null;
  summary: string;
}

interface ActionItem {
  type: ActionType;
  ticker: string;
  details: string;
  priority: Priority;
  positionId?: number;
  daysRemaining?: number;
  delta?: number;
  expirationDate?: string;
}

interface TopSetup {
  ticker: string;
  roe: number | null;
  peRatio: number | null;
  debtToEquity: number | null;
  marketCap: number | null;
  fcfYield: number | null;
  currentIv?: number | null;
  wheelSuitability: number | null;
  targetStrike: number | null;
  estimatedPremium: number | null;
  lastPrice: number | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`;
}

function fmtLargeNumber(v: number | null): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(0)}`;
}

function getTrendColor(trend: Trend): string {
  switch (trend) {
    case 'bullish': return '#2ecc71';
    case 'bearish': return '#e74c3c';
    default: return '#95a5a6';
  }
}

function getVixColor(level: VixLevel): string {
  switch (level) {
    case 'low': return '#2ecc71';
    case 'high': return '#e74c3c';
    default: return '#f39c12';
  }
}

function getPriorityIcon(priority: Priority): string {
  switch (priority) {
    case 'high': return '🔴';
    case 'medium': return '🟡';
    default: return '🔵';
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BriefingView() {
  const [marketRegime, setMarketRegime] = useState<MarketRegime | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [topSetups, setTopSetups] = useState<TopSetup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const { sortedData, sortConfig, requestSort, getSortIndicator } = useSortable(topSetups, 'wheelSuitability', 'desc');

  const openValidateForTicker = (ticker: string) => {
    window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker } }));
  };

  const loadBriefing = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.api.briefing.getFull();
      if (result.success && result.data) {
        setMarketRegime(result.data.marketRegime);
        setActionItems(result.data.actionItems);
        setTopSetups(result.data.topSetups);
        setLastUpdated(new Date());
      } else {
        setError(result.error || 'Failed to load briefing');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBriefing();
    // Auto-refresh every 5 minutes
    const interval = setInterval(loadBriefing, 300000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="briefing-view">
      {/* ── Header ── */}
      <div className="briefing-header">
        <div>
          <h2>Morning Briefing</h2>
          {lastUpdated && (
            <span className="meta">
              Updated: {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
        <button onClick={loadBriefing} className="refresh-btn" disabled={loading}>
          {loading ? 'Loading...' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      {/* ── Market Regime Card ── */}
      <div className="briefing-section">
        <h3>Market Regime</h3>
        {marketRegime ? (
          <div className="market-regime-card">
            <div className="regime-badges">
              <div
                className="regime-badge"
                style={{ borderColor: getTrendColor(marketRegime.spyTrend) }}
              >
                <span className="badge-label">SPY Trend</span>
                <span
                  className="badge-value"
                  style={{ color: getTrendColor(marketRegime.spyTrend) }}
                >
                  {marketRegime.spyTrend.toUpperCase()}
                </span>
                <span className="badge-detail">
                  {fmtPrice(marketRegime.spyPrice)}
                </span>
                {(marketRegime.spySma20 || marketRegime.spySma50) && (
                  <span className="badge-sub">
                    20MA: {fmtPrice(marketRegime.spySma20)} | 50MA: {fmtPrice(marketRegime.spySma50)}
                  </span>
                )}
              </div>

              <div
                className="regime-badge"
                style={{ borderColor: getVixColor(marketRegime.vixLevel) }}
              >
                <span className="badge-label">VIX Level</span>
                <span
                  className="badge-value"
                  style={{ color: getVixColor(marketRegime.vixLevel) }}
                >
                  {marketRegime.vixLevel.toUpperCase()}
                </span>
                <span className="badge-detail">
                  {marketRegime.vixValue?.toFixed(2) ?? '—'}
                </span>
              </div>
            </div>

            <p className="regime-summary">{marketRegime.summary}</p>
          </div>
        ) : (
          <div className="loading-placeholder">Loading market data...</div>
        )}
      </div>

      {/* ── Action Items ── */}
      <div className="briefing-section">
        <h3>Action Items ({actionItems.length})</h3>
        {actionItems.length > 0 ? (
          <div className="action-items-list">
            {actionItems.map((item, idx) => (
              <div
                key={idx}
                className={`action-item ${item.priority}`}
              >
                <span className="action-icon">{getPriorityIcon(item.priority)}</span>
                <span className="action-ticker">{item.ticker}</span>
                <span className="action-details">{item.details}</span>
                {item.daysRemaining !== undefined && (
                  <span className="action-meta">{item.daysRemaining} days left</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            No action items requiring attention.
          </div>
        )}
      </div>

      {/* ── Top Setups ── */}
      <div className="briefing-section">
        <h3>Top 15 Quality Setups</h3>
        {topSetups.length > 0 ? (
          <div className="setups-table-wrap">
            <table className="setups-table">
              <thead>
                <tr>
                  <th onClick={() => requestSort('ticker')} className="sortable">
                    Ticker {getSortIndicator('ticker')}
                  </th>
                  <th onClick={() => requestSort('roe')} className="sortable num">
                    ROE {getSortIndicator('roe')}
                  </th>
                  <th onClick={() => requestSort('peRatio')} className="sortable num">
                    P/E {getSortIndicator('peRatio')}
                  </th>
                  <th onClick={() => requestSort('debtToEquity')} className="sortable num">
                    D/E {getSortIndicator('debtToEquity')}
                  </th>
                  <th onClick={() => requestSort('currentIv')} className="sortable num">
                    IV% {getSortIndicator('currentIv')}
                  </th>
                  <th onClick={() => requestSort('wheelSuitability')} className="sortable num">
                    Wheel Score {getSortIndicator('wheelSuitability')}
                  </th>
                  <th className="num">Target Strike</th>
                  <th className="num">Est. Premium</th>
                </tr>
              </thead>
              <tbody>
                {sortedData.map((setup) => (
                  <tr key={setup.ticker}>
                    <td>
                      <span
                        className="clickable-ticker"
                        onClick={() => openValidateForTicker(setup.ticker)}
                        title="Click to validate"
                      >
                        <strong>{setup.ticker}</strong>
                      </span>
                    </td>
                    <td className="num">{fmtPct(setup.roe)}</td>
                    <td className="num">{setup.peRatio?.toFixed(1) ?? '—'}</td>
                    <td className="num">{setup.debtToEquity?.toFixed(2) ?? '—'}</td>
                    <td className="num">
                      {setup.currentIv != null ? (
                        <span
                          style={{
                            color: setup.currentIv >= 30 ? '#2ecc71' : setup.currentIv >= 20 ? '#f39c12' : '#95a5a6'
                          }}
                          title={setup.currentIv >= 30 ? 'Good premium' : setup.currentIv >= 20 ? 'Moderate premium' : 'Low premium'}
                        >
                          {setup.currentIv.toFixed(1)}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="num">
                      {setup.wheelSuitability !== null ? (
                        <span
                          className="score-badge"
                          style={{
                            background: setup.wheelSuitability >= 70
                              ? 'rgba(46, 204, 113, 0.2)'
                              : setup.wheelSuitability >= 50
                                ? 'rgba(243, 156, 18, 0.2)'
                                : 'rgba(231, 76, 60, 0.2)',
                            color: setup.wheelSuitability >= 70
                              ? '#2ecc71'
                              : setup.wheelSuitability >= 50
                                ? '#f39c12'
                                : '#e74c3c'
                          }}
                        >
                          {setup.wheelSuitability}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="num">{fmtPrice(setup.targetStrike)}</td>
                    <td className="num">{fmtPrice(setup.estimatedPremium)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            No quality setups found. Run a screener with quality filters to populate.
          </div>
        )}
      </div>
    </div>
  );
}
