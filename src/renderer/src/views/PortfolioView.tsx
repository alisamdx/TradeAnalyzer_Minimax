// PortfolioView - FR-6: Portfolio Tracking
// Position management, P&L tracking, trade history
// see SPEC: Priority 6 - Portfolio Tracking

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSortable } from '../hooks/useSortable.js';

type PositionType = 'CSP' | 'CC' | 'Stock';
type PositionStatus = 'open' | 'closed';

interface Position {
  id: number;
  ticker: string;
  positionType: PositionType;
  quantity: number;
  entryPrice: number;
  entryDate: string;
  entryNotes: string | null;
  exitPrice: number | null;
  exitDate: string | null;
  exitNotes: string | null;
  strikePrice: number | null;
  expirationDate: string | null;
  premiumReceived: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  status: PositionStatus;
  createdAt: string;
  updatedAt: string;
}

interface PositionWithMetrics extends Position {
  capitalRequired: number;
  daysHeld: number | null;
  returnPct: number | null;
  annualizedReturn: number | null;
}

interface PnLSummary {
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalCapitalDeployed: number;
  winRate: number;
  averageReturnPct: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fmtPrice(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`;
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function fmtLargeNumber(v: number | null): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(0)}`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PortfolioView() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [summary, setSummary] = useState<PnLSummary | null>(null);
  const [activeTab, setActiveTab] = useState<'open' | 'closed'>('open');
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);

  // Form state
  const [formTicker, setFormTicker] = useState('');
  const [formType, setFormType] = useState<PositionType>('Stock');
  const [formQuantity, setFormQuantity] = useState(1);
  const [formEntryPrice, setFormEntryPrice] = useState('');
  const [formEntryDate, setFormEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [formEntryNotes, setFormEntryNotes] = useState('');
  const [formStrikePrice, setFormStrikePrice] = useState('');
  const [formExpiration, setFormExpiration] = useState('');
  const [formPremium, setFormPremium] = useState('');

  // Load positions and summary
  const loadData = useCallback(async () => {
    try {
      const [positionsResult, summaryResult] = await Promise.all([
        window.api.portfolio.list(activeTab),
        window.api.portfolio.pnlSummary()
      ]);

      if (positionsResult.success && positionsResult.data) {
        setPositions(positionsResult.data);
      }
      if (summaryResult.success && summaryResult.data) {
        setSummary(summaryResult.data);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activeTab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ─── Sorting ───────────────────────────────────────────────────────────────

  const { sortedData, sortConfig, requestSort, getSortIndicator } = useSortable(positions, 'entryDate', 'desc');

  // ─── Form handling ────────────────────────────────────────────────────────────

  const resetForm = () => {
    setFormTicker('');
    setFormType('Stock');
    setFormQuantity(1);
    setFormEntryPrice('');
    setFormEntryDate(new Date().toISOString().slice(0, 10));
    setFormEntryNotes('');
    setFormStrikePrice('');
    setFormExpiration('');
    setFormPremium('');
  };

  const handleAddPosition = async () => {
    if (!formTicker || !formEntryPrice) {
      setError('Ticker and entry price are required');
      return;
    }

    try {
      const input = {
        ticker: formTicker.toUpperCase(),
        positionType: formType,
        quantity: formQuantity,
        entryPrice: parseFloat(formEntryPrice),
        entryDate: formEntryDate,
        entryNotes: formEntryNotes || null,
        strikePrice: formType !== 'Stock' ? parseFloat(formStrikePrice) || null : null,
        expirationDate: formType !== 'Stock' ? formExpiration || null : null,
        premiumReceived: formType !== 'Stock' ? parseFloat(formPremium) || null : null
      };

      const result = await window.api.portfolio.add(input);
      if (result.success) {
        setStatusMsg(`Added ${formType} position for ${formTicker.toUpperCase()}`);
        resetForm();
        setShowAddForm(false);
        loadData();
      } else {
        setError(result.error || 'Failed to add position');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleClosePosition = async (id: number) => {
    const exitPrice = prompt('Enter exit price:');
    if (!exitPrice) return;

    const exitNotes = prompt('Enter exit notes (optional):') || '';

    try {
      const result = await window.api.portfolio.close(id, {
        exitPrice: parseFloat(exitPrice),
        exitDate: new Date().toISOString().slice(0, 10),
        exitNotes: exitNotes || null
      });

      if (result.success) {
        setStatusMsg('Position closed successfully');
        loadData();
      } else {
        setError(result.error || 'Failed to close position');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDeletePosition = async (id: number) => {
    if (!confirm('Are you sure you want to delete this position?')) return;

    try {
      const result = await window.api.portfolio.delete(id);
      if (result.success) {
        setStatusMsg('Position deleted');
        loadData();
      } else {
        setError(result.error || 'Failed to delete position');
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // ─── Column definitions ───────────────────────────────────────────────────────

  const columns = [
    { key: 'ticker', label: 'Ticker', sortable: true },
    { key: 'positionType', label: 'Type', sortable: true },
    { key: 'quantity', label: 'Qty', sortable: true },
    { key: 'entryPrice', label: 'Entry', sortable: true },
    ...(activeTab === 'open' ? [{ key: 'currentPrice', label: 'Current', sortable: true }] : []),
    ...(activeTab === 'closed' ? [{ key: 'exitPrice', label: 'Exit', sortable: true }] : []),
    ...(activeTab === 'open' ? [{ key: 'unrealizedPnl', label: 'Unrealized P&L', sortable: true }] : []),
    ...(activeTab === 'closed' ? [{ key: 'realizedPnl', label: 'Realized P&L', sortable: true }] : []),
    { key: 'entryDate', label: 'Entry Date', sortable: true },
    { key: 'actions', label: 'Actions', sortable: false }
  ].filter(Boolean) as { key: string; label: string; sortable: boolean }[];

  return (
    <div className="portfolio-view">
      {/* ── Error / status ── */}
      {error && (
        <div className="error-toast" onClick={() => setError(null)}>
          {error} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}
      {statusMsg && !error && (
        <div className="status-toast" onClick={() => setStatusMsg(null)}>
          {statusMsg} <span style={{ float: 'right', cursor: 'pointer' }}>✕</span>
        </div>
      )}

      {/* ── Header ── */}
      <div className="portfolio-header">
        <h2>Portfolio Tracking</h2>
        <button onClick={() => setShowAddForm(!showAddForm)} className="add-position-btn">
          {showAddForm ? '✕ Cancel' : '+ Add Position'}
        </button>
      </div>

      {/* ── P&L Summary Cards ── */}
      {summary && (
        <div className="pnl-summary-cards">
          <div className="summary-card">
            <span className="summary-label">Total Positions</span>
            <span className="summary-value">{summary.totalPositions}</span>
            <span className="summary-sub">{summary.openPositions} open, {summary.closedPositions} closed</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Unrealized P&L</span>
            <span className={`summary-value ${summary.totalUnrealizedPnl >= 0 ? 'positive' : 'negative'}`}>
              {fmtLargeNumber(summary.totalUnrealizedPnl)}
            </span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Realized P&L</span>
            <span className={`summary-value ${summary.totalRealizedPnl >= 0 ? 'positive' : 'negative'}`}>
              {fmtLargeNumber(summary.totalRealizedPnl)}
            </span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Capital Deployed</span>
            <span className="summary-value">{fmtLargeNumber(summary.totalCapitalDeployed)}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Win Rate</span>
            <span className="summary-value">{summary.winRate.toFixed(1)}%</span>
          </div>
        </div>
      )}

      {/* ── Add Position Form ── */}
      {showAddForm && (
        <div className="add-position-form">
          <h3>Add New Position</h3>
          <div className="form-row">
            <div className="form-field">
              <label>Ticker</label>
              <input
                type="text"
                value={formTicker}
                onChange={(e) => setFormTicker(e.target.value.toUpperCase())}
                placeholder="AAPL"
                maxLength={10}
              />
            </div>
            <div className="form-field">
              <label>Type</label>
              <select value={formType} onChange={(e) => setFormType(e.target.value as PositionType)}>
                <option value="Stock">Stock</option>
                <option value="CSP">Cash-Secured Put</option>
                <option value="CC">Covered Call</option>
              </select>
            </div>
            <div className="form-field">
              <label>Quantity</label>
              <input
                type="number"
                value={formQuantity}
                onChange={(e) => setFormQuantity(parseInt(e.target.value) || 1)}
                min={1}
              />
            </div>
            <div className="form-field">
              <label>Entry Price</label>
              <input
                type="number"
                step="0.01"
                value={formEntryPrice}
                onChange={(e) => setFormEntryPrice(e.target.value)}
                placeholder="150.00"
              />
            </div>
            <div className="form-field">
              <label>Entry Date</label>
              <input
                type="date"
                value={formEntryDate}
                onChange={(e) => setFormEntryDate(e.target.value)}
              />
            </div>
          </div>

          {formType !== 'Stock' && (
            <div className="form-row">
              <div className="form-field">
                <label>Strike Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={formStrikePrice}
                  onChange={(e) => setFormStrikePrice(e.target.value)}
                  placeholder="150.00"
                />
              </div>
              <div className="form-field">
                <label>Expiration Date</label>
                <input
                  type="date"
                  value={formExpiration}
                  onChange={(e) => setFormExpiration(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label>Premium Received</label>
                <input
                  type="number"
                  step="0.01"
                  value={formPremium}
                  onChange={(e) => setFormPremium(e.target.value)}
                  placeholder="2.50"
                />
              </div>
            </div>
          )}

          <div className="form-row">
            <div className="form-field full-width">
              <label>Notes</label>
              <input
                type="text"
                value={formEntryNotes}
                onChange={(e) => setFormEntryNotes(e.target.value)}
                placeholder="Optional notes..."
              />
            </div>
          </div>

          <div className="form-actions">
            <button onClick={handleAddPosition} className="save-btn">Save Position</button>
            <button onClick={() => { resetForm(); setShowAddForm(false); }} className="cancel-btn">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="portfolio-tabs">
        <button
          className={`tab-btn ${activeTab === 'open' ? 'active' : ''}`}
          onClick={() => setActiveTab('open')}
        >
          Open Positions ({summary?.openPositions || 0})
        </button>
        <button
          className={`tab-btn ${activeTab === 'closed' ? 'active' : ''}`}
          onClick={() => setActiveTab('closed')}
        >
          Closed Positions ({summary?.closedPositions || 0})
        </button>
      </div>

      {/* ── Positions Table ── */}
      <div className="positions-table-wrap">
        <table className="positions-table">
          <thead>
            <tr>
              {columns.map(col => (
                <th
                  key={col.key}
                  className={col.sortable ? 'sortable' : ''}
                  onClick={col.sortable ? () => requestSort(col.key) : undefined}
                >
                  {col.label}
                  {col.sortable && getSortIndicator(col.key) && (
                    <span className="sort-indicator">{getSortIndicator(col.key)}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="empty-cell">
                  No {activeTab} positions. Click "Add Position" to get started.
                </td>
              </tr>
            ) : (
              sortedData.map(pos => (
                <tr key={pos.id}>
                  <td><strong>{pos.ticker}</strong></td>
                  <td>
                    <span className={`type-badge ${pos.positionType.toLowerCase()}`}>
                      {pos.positionType}
                    </span>
                  </td>
                  <td className="num">{pos.quantity}</td>
                  <td className="num">{fmtPrice(pos.entryPrice)}</td>
                  {activeTab === 'open' && (
                    <td className="num">{fmtPrice(pos.currentPrice)}</td>
                  )}
                  {activeTab === 'closed' && (
                    <td className="num">{fmtPrice(pos.exitPrice)}</td>
                  )}
                  {activeTab === 'open' && (
                    <td className={`num ${(pos.unrealizedPnl || 0) >= 0 ? 'positive' : 'negative'}`}>
                      {fmtLargeNumber(pos.unrealizedPnl)}
                    </td>
                  )}
                  {activeTab === 'closed' && (
                    <td className={`num ${(pos.realizedPnl || 0) >= 0 ? 'positive' : 'negative'}`}>
                      {fmtLargeNumber(pos.realizedPnl)}
                    </td>
                  )}
                  <td>{formatDate(pos.entryDate)}</td>
                  <td className="actions">
                    {activeTab === 'open' && (
                      <button
                        onClick={() => handleClosePosition(pos.id)}
                        className="action-btn close"
                        title="Close position"
                      >
                        ✓ Close
                      </button>
                    )}
                    <button
                      onClick={() => handleDeletePosition(pos.id)}
                      className="action-btn delete"
                      title="Delete position"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
