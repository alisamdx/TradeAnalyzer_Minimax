// PortfolioView - FR-6: Portfolio Tracking
// v0.16.0: E*Trade sync (Phase 1), per-position analysis (Phase 2), AI Advisor (Phase 3)
// see SPEC: Priority 6 - Portfolio Tracking

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSortable } from '../hooks/useSortable.js';
import type { PositionEtrade, PositionAnalysis, AdvisorSession, AdvisorProgressEvent } from '@shared/types.js';

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

function dte(expirationDate: string | null): number | null {
  if (!expirationDate) return null;
  return Math.round((new Date(expirationDate).getTime() - Date.now()) / 86_400_000);
}

function actionColor(action: PositionAnalysis['action']): string {
  switch (action) {
    case 'close':       return '#ef4444';
    case 'roll':        return '#3b82f6';
    case 'take_profits': return '#22c55e';
    case 'hedge':       return '#f97316';
    default:            return '#6b7280';
  }
}

function urgencyColor(urgency: 'immediate' | 'this_week' | 'monitor'): string {
  switch (urgency) {
    case 'immediate':  return '#ef4444';
    case 'this_week':  return '#f59e0b';
    default:           return '#6b7280';
  }
}

// ─── Greeks chip ──────────────────────────────────────────────────────────────

function GreeksChip({ label, value, color, title }: { label: string; value: string; color: string; title?: string }) {
  return (
    <div
      title={title}
      style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#1f2937', borderRadius: 6, padding: '4px 10px', fontSize: 11 }}
    >
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PortfolioView() {
  const [positions, setPositions]         = useState<Position[]>([]);
  const [etPositions, setEtPositions]     = useState<PositionEtrade[]>([]);
  const [analyses, setAnalyses]           = useState<Map<number, PositionAnalysis>>(new Map());
  const [summary, setSummary]             = useState<PnLSummary | null>(null);
  const [activeTab, setActiveTab]         = useState<'open' | 'closed' | 'advisor'>('open');
  const [error, setError]                 = useState<string | null>(null);
  const [statusMsg, setStatusMsg]         = useState<string | null>(null);
  const [showAddForm, setShowAddForm]     = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);

  // E*Trade sync state
  const [syncBusy, setSyncBusy]           = useState(false);
  const [lastSyncedAt, setLastSyncedAt]   = useState<string | null>(null);

  // Analysis state
  const [analyzingId, setAnalyzingId]     = useState<number | null>(null);
  const [analyzingAll, setAnalyzingAll]   = useState(false);

  // Advisor state
  const [advisorBusy, setAdvisorBusy]           = useState(false);
  const [advisorSession, setAdvisorSession]       = useState<AdvisorSession | null>(null);
  const [advisorHistory, setAdvisorHistory]       = useState<AdvisorSession[]>([]);
  const [showApiKeyInput, setShowApiKeyInput]     = useState(false);
  const [apiKeyInput, setApiKeyInput]             = useState('');
  const [hasApiKey, setHasApiKey]                 = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState<number | null>(null);

  // Account size for BP% calculation
  const [accountSize, setAccountSize]     = useState<number>(0);

  // Streaming state
  const [streamStatus, setStreamStatus]   = useState<string>('');
  const [thinkingText, setThinkingText]   = useState<string>('');
  const thinkingRef                        = useRef<HTMLDivElement | null>(null);

  // Form state
  const [formTicker, setFormTicker]       = useState('');
  const [formType, setFormType]           = useState<PositionType>('Stock');
  const [formQuantity, setFormQuantity]   = useState(1);
  const [formEntryPrice, setFormEntryPrice] = useState('');
  const [formEntryDate, setFormEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [formEntryNotes, setFormEntryNotes] = useState('');
  const [formStrikePrice, setFormStrikePrice] = useState('');
  const [formExpiration, setFormExpiration] = useState('');
  const [formPremium, setFormPremium]     = useState('');

  // Load positions, summary, and E*Trade enhanced positions
  const loadData = useCallback(async () => {
    try {
      const [posResult, sumResult, etResult, syncResult, apiKeyResult, settingsResult] = await Promise.all([
        window.api.portfolio.list(activeTab === 'open' ? 'open' : activeTab === 'closed' ? 'closed' : 'open'),
        window.api.portfolio.pnlSummary(),
        window.api.portfolio.etrade.listPositions(),
        window.api.portfolio.etrade.lastSync(),
        window.api.portfolio.advisor.hasApiKey(),
        window.api.settings.getAll(),
      ]);

      if (posResult.success && posResult.data) setPositions(posResult.data);
      if (sumResult.success && sumResult.data) setSummary(sumResult.data);
      setEtPositions(etResult);
      setLastSyncedAt(syncResult);
      setHasApiKey(apiKeyResult);
      setAccountSize(settingsResult.accountSize ?? 0);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activeTab]);

  useEffect(() => { loadData(); }, [loadData]);

  // Load advisor history when switching to advisor tab
  useEffect(() => {
    if (activeTab === 'advisor') {
      window.api.portfolio.advisor.history(10)
        .then(h => setAdvisorHistory(h))
        .catch(() => {});
    }
  }, [activeTab]);

  // ─── Sorting ───────────────────────────────────────────────────────────────

  const { sortedData, requestSort, getSortIndicator } = useSortable(positions, 'entryDate', 'desc');

  // Build a map of positionId → PositionEtrade for quick lookup
  const etMap = useMemo(() => {
    const m = new Map<number, PositionEtrade>();
    for (const p of etPositions) m.set(p.id, p);
    return m;
  }, [etPositions]);

  // Aggregate portfolio Greeks from open positions + E*Trade data
  // see docs/formulas.md#portfolio-greeks
  const greeksSummary = useMemo(() => {
    const open = positions.filter(p => p.status === 'open');
    let netDelta = 0, totalTheta = 0, totalVega = 0;
    const now = Date.now();
    let exp7 = 0, exp14 = 0, exp21 = 0;

    for (const pos of open) {
      const et = etMap.get(pos.id);
      const isOption = pos.positionType !== 'Stock';
      const multiplier = isOption ? pos.quantity * 100 : pos.quantity;

      if (et) {
        if (et.delta != null) netDelta += et.delta * multiplier;
        if (isOption) {
          if (et.theta != null) totalTheta += et.theta * multiplier;
          if (et.vega  != null) totalVega  += et.vega  * multiplier;
        }
      } else if (!isOption) {
        netDelta += pos.quantity; // stock with no ET data: assume Δ=1/share
      }

      if (pos.expirationDate) {
        const d = Math.round((new Date(pos.expirationDate).getTime() - now) / 86_400_000);
        if (d >= 0 && d <= 7)        exp7++;
        else if (d >= 0 && d <= 14)  exp14++;
        else if (d >= 0 && d <= 21)  exp21++;
      }
    }

    const bpUsedPct = accountSize > 0 && summary
      ? (summary.totalCapitalDeployed / accountSize) * 100
      : null;

    return { netDelta, totalTheta, totalVega, bpUsedPct, exp7, exp14, exp21 };
  }, [positions, etMap, accountSize, summary]);

  // ─── Form handling ────────────────────────────────────────────────────────────

  const resetForm = () => {
    setFormTicker(''); setFormType('Stock'); setFormQuantity(1);
    setFormEntryPrice(''); setFormEntryDate(new Date().toISOString().slice(0, 10));
    setFormEntryNotes(''); setFormStrikePrice(''); setFormExpiration(''); setFormPremium('');
  };

  const handleAddPosition = async () => {
    if (!formTicker || !formEntryPrice) { setError('Ticker and entry price are required'); return; }
    try {
      const result = await window.api.portfolio.add({
        ticker: formTicker.toUpperCase(),
        positionType: formType,
        quantity: formQuantity,
        entryPrice: parseFloat(formEntryPrice),
        entryDate: formEntryDate,
        entryNotes: formEntryNotes || null,
        strikePrice: formType !== 'Stock' ? parseFloat(formStrikePrice) || null : null,
        expirationDate: formType !== 'Stock' ? formExpiration || null : null,
        premiumReceived: formType !== 'Stock' ? parseFloat(formPremium) || null : null,
      });
      if (result.success) {
        setStatusMsg(`Added ${formType} position for ${formTicker.toUpperCase()}`);
        resetForm(); setShowAddForm(false); loadData();
      } else { setError(result.error || 'Failed to add position'); }
    } catch (e) { setError((e as Error).message); }
  };

  const handleClosePosition = async (id: number) => {
    const exitPrice = prompt('Enter exit price:');
    if (!exitPrice) return;
    const exitNotes = prompt('Enter exit notes (optional):') || '';
    try {
      const result = await window.api.portfolio.close(id, {
        exitPrice: parseFloat(exitPrice),
        exitDate: new Date().toISOString().slice(0, 10),
        exitNotes: exitNotes || null,
      });
      if (result.success) { setStatusMsg('Position closed successfully'); loadData(); }
      else setError(result.error || 'Failed to close position');
    } catch (e) { setError((e as Error).message); }
  };

  const handleDeletePosition = async (id: number) => {
    if (!confirm('Are you sure you want to delete this position?')) return;
    try {
      const result = await window.api.portfolio.delete(id);
      if (result.success) { setStatusMsg('Position deleted'); loadData(); }
      else setError(result.error || 'Failed to delete position');
    } catch (e) { setError((e as Error).message); }
  };

  // ─── E*Trade sync ─────────────────────────────────────────────────────────────

  const handleSync = async () => {
    setSyncBusy(true); setError(null);
    try {
      const result = await window.api.portfolio.etrade.sync();
      setLastSyncedAt(result.syncedAt);
      const msg = `Synced: ${result.positionsUpserted} positions updated, ${result.positionsSkipped} skipped`;
      setStatusMsg(result.errors.length > 0 ? `${msg}. Errors: ${result.errors.join('; ')}` : msg);
      loadData();
    } catch (e) { setError(`Sync failed: ${(e as Error).message}`); }
    finally { setSyncBusy(false); }
  };

  // ─── Position analysis ────────────────────────────────────────────────────────

  const handleAnalyze = async (positionId: number) => {
    setAnalyzingId(positionId); setError(null);
    try {
      const analysis = await window.api.portfolio.analysis.run(positionId);
      setAnalyses(prev => new Map(prev).set(positionId, analysis));
      setStatusMsg(`Analysis complete for position ${positionId}`);
    } catch (e) { setError(`Analysis failed: ${(e as Error).message}`); }
    finally { setAnalyzingId(null); }
  };

  const handleAnalyzeAll = async () => {
    setAnalyzingAll(true); setError(null);
    try {
      const results = await window.api.portfolio.analysis.runAll();
      const m = new Map<number, PositionAnalysis>();
      for (const r of results) m.set(r.positionId, r);
      setAnalyses(m);
      setStatusMsg(`Analyzed ${results.length} position${results.length !== 1 ? 's' : ''}`);
    } catch (e) { setError(`Analysis failed: ${(e as Error).message}`); }
    finally { setAnalyzingAll(false); }
  };

  // ─── AI Advisor ───────────────────────────────────────────────────────────────

  const handleRunAdvisor = async () => {
    setAdvisorBusy(true); setError(null); setThinkingText(''); setStreamStatus('');

    // Subscribe to streaming progress events
    const unsubscribe = window.api.portfolio.advisor.onProgress((evt: AdvisorProgressEvent) => {
      if (evt.type === 'thinking') {
        setThinkingText(prev => prev + evt.text);
        // Auto-scroll the thinking box
        requestAnimationFrame(() => {
          if (thinkingRef.current) {
            thinkingRef.current.scrollTop = thinkingRef.current.scrollHeight;
          }
        });
      } else if (evt.type === 'status') {
        setStreamStatus(evt.text);
      }
    });

    try {
      const session = await window.api.portfolio.advisor.run();
      setAdvisorSession(session);
      setAdvisorHistory(prev => [session, ...prev.slice(0, 9)]);
      setSelectedHistoryId(null); // always show the new session
    } catch (e) { setError(`Advisor failed: ${(e as Error).message}`); }
    finally {
      unsubscribe();
      setAdvisorBusy(false);
      setStreamStatus('');
      // Keep thinkingText visible until user starts a new run
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKeyInput.trim()) return;
    try {
      await window.api.portfolio.advisor.setApiKey(apiKeyInput.trim());
      setHasApiKey(true); setShowApiKeyInput(false); setApiKeyInput('');
      setStatusMsg('Anthropic API key saved');
    } catch (e) { setError((e as Error).message); }
  };

  // ─── Column definitions ───────────────────────────────────────────────────────

  const columns = [
    { key: 'ticker',        label: 'Ticker',      sortable: true },
    { key: 'positionType',  label: 'Type',        sortable: true },
    { key: 'quantity',      label: 'Qty',         sortable: true },
    { key: 'entryPrice',    label: 'Entry',       sortable: true },
    ...(activeTab === 'open'   ? [{ key: 'strike',        label: 'Strike/Exp',  sortable: false }] : []),
    ...(activeTab === 'open'   ? [{ key: 'currentPrice',  label: 'Current',     sortable: true  }] : []),
    ...(activeTab === 'closed' ? [{ key: 'exitPrice',     label: 'Exit',        sortable: true  }] : []),
    ...(activeTab === 'open'   ? [{ key: 'marketValue',   label: 'Mkt Value',   sortable: false }] : []),
    ...(activeTab === 'open'   ? [{ key: 'daysGain',      label: "Day's G/L",   sortable: false }] : []),
    ...(activeTab === 'open'   ? [{ key: 'greeks',        label: 'Greeks',      sortable: false }] : []),
    ...(activeTab === 'open'   ? [{ key: 'unrealizedPnl', label: 'Unreal P&L',  sortable: true  }] : []),
    ...(activeTab === 'closed' ? [{ key: 'realizedPnl',   label: 'Realized P&L',sortable: true  }] : []),
    { key: 'entryDate',     label: 'Entry Date',  sortable: true },
    ...(activeTab === 'open'   ? [{ key: 'analysis',      label: 'Analysis',    sortable: false }] : []),
    { key: 'actions',       label: 'Actions',     sortable: false },
  ].filter(Boolean) as { key: string; label: string; sortable: boolean }[];

  // ─── Advisor tab content ──────────────────────────────────────────────────────

  const displaySession = advisorHistory.find(s => s.id === selectedHistoryId) ?? advisorSession;

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="portfolio-view">
      {/* ── Toasts ── */}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {lastSyncedAt && (
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              Last sync: {new Date(lastSyncedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={handleSync}
            disabled={syncBusy}
            className="add-position-btn"
            style={{ background: '#1d4ed8' }}
          >
            {syncBusy ? '⟳ Syncing…' : '↓ Sync E*Trade'}
          </button>
          <button onClick={() => setShowAddForm(!showAddForm)} className="add-position-btn">
            {showAddForm ? '✕ Cancel' : '+ Add Position'}
          </button>
        </div>
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

      {/* ── Portfolio Greeks Bar ── */}
      {positions.some(p => p.status === 'open') && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <GreeksChip
            label="Net Δ"
            value={greeksSummary.netDelta.toFixed(2)}
            color={Math.abs(greeksSummary.netDelta) > 0 ? '#60a5fa' : '#6b7280'}
            title="Net portfolio delta (sum of position deltas × multiplier)"
          />
          <GreeksChip
            label="Θ/day"
            value={`$${greeksSummary.totalTheta.toFixed(0)}`}
            color={greeksSummary.totalTheta >= 0 ? '#22c55e' : '#ef4444'}
            title="Total daily theta decay in dollars (options only)"
          />
          <GreeksChip
            label="Vega"
            value={greeksSummary.totalVega.toFixed(0)}
            color="#a78bfa"
            title="Total vega (P&L per 1% IV move, options only)"
          />
          {greeksSummary.bpUsedPct !== null && (
            <GreeksChip
              label="BP Used"
              value={`${greeksSummary.bpUsedPct.toFixed(1)}%`}
              color={greeksSummary.bpUsedPct > 80 ? '#ef4444' : greeksSummary.bpUsedPct > 50 ? '#f59e0b' : '#22c55e'}
              title={`Buying power used (capital deployed / $${accountSize.toLocaleString()} account size)`}
            />
          )}
          {(greeksSummary.exp7 + greeksSummary.exp14 + greeksSummary.exp21) > 0 && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', background: '#1f2937', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: '#9ca3af' }}>
              <span style={{ marginRight: 4 }}>Exp:</span>
              {greeksSummary.exp7  > 0 && <span style={{ color: '#ef4444', fontWeight: 600 }}>{greeksSummary.exp7} ≤7d</span>}
              {greeksSummary.exp7  > 0 && (greeksSummary.exp14 + greeksSummary.exp21) > 0 && <span style={{ color: '#374151' }}>·</span>}
              {greeksSummary.exp14 > 0 && <span style={{ color: '#f59e0b', fontWeight: 600 }}>{greeksSummary.exp14} ≤14d</span>}
              {greeksSummary.exp14 > 0 && greeksSummary.exp21 > 0 && <span style={{ color: '#374151' }}>·</span>}
              {greeksSummary.exp21 > 0 && <span style={{ color: '#d1d5db' }}>{greeksSummary.exp21} ≤21d</span>}
            </div>
          )}
          {accountSize === 0 && (
            <button
              onClick={() => {
                const size = prompt('Enter account size ($):');
                if (size) window.api.settings.setAll({ accountSize: parseFloat(size) }).then(() => loadData());
              }}
              style={{ fontSize: 10, padding: '4px 8px', background: 'transparent', border: '1px dashed #374151', borderRadius: 6, color: '#6b7280', cursor: 'pointer' }}
              title="Set account size to enable BP% display"
            >
              + Set account size
            </button>
          )}
        </div>
      )}

      {/* ── Add Position Form ── */}
      {showAddForm && (
        <div className="add-position-form">
          <h3>Add New Position</h3>
          <div className="form-row">
            <div className="form-field">
              <label>Ticker</label>
              <input type="text" value={formTicker} onChange={e => setFormTicker(e.target.value.toUpperCase())} placeholder="AAPL" maxLength={10} />
            </div>
            <div className="form-field">
              <label>Type</label>
              <select value={formType} onChange={e => setFormType(e.target.value as PositionType)}>
                <option value="Stock">Stock</option>
                <option value="CSP">Cash-Secured Put</option>
                <option value="CC">Covered Call</option>
              </select>
            </div>
            <div className="form-field">
              <label>Quantity</label>
              <input type="number" value={formQuantity} onChange={e => setFormQuantity(parseInt(e.target.value) || 1)} min={1} />
            </div>
            <div className="form-field">
              <label>Entry Price</label>
              <input type="number" step="0.01" value={formEntryPrice} onChange={e => setFormEntryPrice(e.target.value)} placeholder="150.00" />
            </div>
            <div className="form-field">
              <label>Entry Date</label>
              <input type="date" value={formEntryDate} onChange={e => setFormEntryDate(e.target.value)} />
            </div>
          </div>
          {formType !== 'Stock' && (
            <div className="form-row">
              <div className="form-field">
                <label>Strike Price</label>
                <input type="number" step="0.01" value={formStrikePrice} onChange={e => setFormStrikePrice(e.target.value)} placeholder="150.00" />
              </div>
              <div className="form-field">
                <label>Expiration Date</label>
                <input type="date" value={formExpiration} onChange={e => setFormExpiration(e.target.value)} />
              </div>
              <div className="form-field">
                <label>Premium Received</label>
                <input type="number" step="0.01" value={formPremium} onChange={e => setFormPremium(e.target.value)} placeholder="2.50" />
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="form-field full-width">
              <label>Notes</label>
              <input type="text" value={formEntryNotes} onChange={e => setFormEntryNotes(e.target.value)} placeholder="Optional notes..." />
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
        <button className={`tab-btn ${activeTab === 'open' ? 'active' : ''}`} onClick={() => setActiveTab('open')}>
          Open Positions ({summary?.openPositions || 0})
        </button>
        <button className={`tab-btn ${activeTab === 'closed' ? 'active' : ''}`} onClick={() => setActiveTab('closed')}>
          Closed Positions ({summary?.closedPositions || 0})
        </button>
        <button className={`tab-btn ${activeTab === 'advisor' ? 'active' : ''}`} onClick={() => setActiveTab('advisor')}>
          🤖 AI Advisor
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          POSITIONS TABLE (open / closed)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab !== 'advisor' && (
        <>
          {/* Analyze All button for open tab */}
          {activeTab === 'open' && positions.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button
                onClick={handleAnalyzeAll}
                disabled={analyzingAll}
                style={{ padding: '4px 12px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, cursor: analyzingAll ? 'wait' : 'pointer', fontSize: 12 }}
              >
                {analyzingAll ? '⟳ Analyzing…' : '🔬 Analyze All Positions'}
              </button>
              <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>
                {analyses.size > 0 ? `${analyses.size} analyzed` : 'No analysis yet — click to run'}
              </span>
            </div>
          )}

          <div className="positions-table-wrap">
            <table className="positions-table">
              <thead>
                <tr>
                  {columns.map(col => (
                    <th key={col.key} className={col.sortable ? 'sortable' : ''} onClick={col.sortable ? () => requestSort(col.key) : undefined}>
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
                      No {activeTab} positions. {activeTab === 'open' ? 'Click "+ Add Position" or "Sync E*Trade" to get started.' : 'No closed positions yet.'}
                    </td>
                  </tr>
                ) : (
                  sortedData.map(pos => {
                    const et = etMap.get(pos.id);
                    const an = analyses.get(pos.id);
                    const daysLeft = dte(pos.expirationDate);
                    const isAnalyzing = analyzingId === pos.id;

                    return (
                      <tr key={pos.id}>
                        <td>
                          <strong>{pos.ticker}</strong>
                          {et?.etradePositionId && (
                            <span style={{ fontSize: 9, color: '#3b82f6', marginLeft: 4 }} title="Synced from E*Trade">●ET</span>
                          )}
                        </td>
                        <td>
                          <span className={`type-badge ${pos.positionType.toLowerCase()}`}>
                            {pos.positionType}
                          </span>
                        </td>
                        <td className="num">{pos.quantity}</td>
                        <td className="num">{fmtPrice(pos.entryPrice)}</td>

                        {/* Strike / DTE */}
                        {activeTab === 'open' && (
                          <td className="num" style={{ fontSize: 11 }}>
                            {pos.strikePrice ? (
                              <>
                                <div>{fmtPrice(pos.strikePrice)}</div>
                                {daysLeft !== null && (
                                  <div style={{ color: daysLeft <= 7 ? '#ef4444' : daysLeft <= 14 ? '#f59e0b' : '#9ca3af' }}>
                                    {daysLeft}d
                                  </div>
                                )}
                              </>
                            ) : '—'}
                          </td>
                        )}

                        {/* Current price */}
                        {activeTab === 'open' && (
                          <td className="num">{fmtPrice(et?.currentPrice ?? pos.currentPrice)}</td>
                        )}
                        {activeTab === 'closed' && (
                          <td className="num">{fmtPrice(pos.exitPrice)}</td>
                        )}

                        {/* Market value (E*Trade) */}
                        {activeTab === 'open' && (
                          <td className="num" style={{ fontSize: 11 }}>
                            {et?.marketValue != null ? fmtLargeNumber(et.marketValue) : '—'}
                          </td>
                        )}

                        {/* Day's gain */}
                        {activeTab === 'open' && (
                          <td className="num" style={{ fontSize: 11 }}>
                            {et?.daysGain != null ? (
                              <span style={{ color: et.daysGain >= 0 ? '#22c55e' : '#ef4444' }}>
                                {fmtLargeNumber(et.daysGain)}
                                {et.daysGainPct != null && ` (${fmtPct(et.daysGainPct)})`}
                              </span>
                            ) : '—'}
                          </td>
                        )}

                        {/* Greeks */}
                        {activeTab === 'open' && (
                          <td style={{ fontSize: 10, color: '#9ca3af' }}>
                            {et && (et.delta != null || et.iv != null) ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {et.delta != null && <span>Δ {et.delta.toFixed(2)}</span>}
                                {et.theta != null && <span>Θ {et.theta.toFixed(2)}</span>}
                                {et.iv    != null && <span>IV {et.iv.toFixed(1)}%</span>}
                              </div>
                            ) : '—'}
                          </td>
                        )}

                        {/* P&L */}
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

                        {/* Analysis badge */}
                        {activeTab === 'open' && (
                          <td>
                            {an ? (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{
                                  fontSize: 10, padding: '1px 5px', borderRadius: 3,
                                  background: actionColor(an.action), color: '#fff', fontWeight: 600
                                }}>
                                  {an.action.replace('_', ' ').toUpperCase()}
                                </span>
                                <span style={{ fontSize: 9, color: '#9ca3af' }}>
                                  {an.trend ?? '?'} · {an.compositeScore?.toFixed(1) ?? '?'}/10
                                </span>
                              </div>
                            ) : (
                              <button
                                onClick={() => handleAnalyze(pos.id)}
                                disabled={isAnalyzing}
                                style={{ fontSize: 10, padding: '2px 6px', background: '#374151', border: 'none', borderRadius: 3, color: '#d1d5db', cursor: 'pointer' }}
                              >
                                {isAnalyzing ? '⟳' : '🔬'}
                              </button>
                            )}
                          </td>
                        )}

                        <td className="actions">
                          {activeTab === 'open' && (
                            <button onClick={() => handleClosePosition(pos.id)} className="action-btn close" title="Close position">
                              ✓ Close
                            </button>
                          )}
                          <button onClick={() => handleDeletePosition(pos.id)} className="action-btn delete" title="Delete position">
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          AI ADVISOR TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'advisor' && (
        <div style={{ padding: '16px 0' }}>

          {/* ── API key setup ── */}
          {!hasApiKey && !showApiKeyInput && (
            <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, padding: 16, marginBottom: 16 }}>
              <p style={{ margin: '0 0 8px', color: '#d1d5db' }}>
                🔑 An Anthropic API key is required to use the AI Advisor.
              </p>
              <button onClick={() => setShowApiKeyInput(true)} style={{ padding: '6px 14px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Add API Key
              </button>
            </div>
          )}

          {showApiKeyInput && (
            <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, padding: 16, marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="password"
                value={apiKeyInput}
                onChange={e => setApiKeyInput(e.target.value)}
                placeholder="sk-ant-..."
                style={{ flex: 1, padding: '6px 10px', background: '#111827', border: '1px solid #374151', borderRadius: 4, color: '#f9fafb', fontFamily: 'monospace' }}
              />
              <button onClick={handleSaveApiKey} style={{ padding: '6px 14px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Save
              </button>
              <button onClick={() => { setShowApiKeyInput(false); setApiKeyInput(''); }} style={{ padding: '6px 10px', background: '#374151', color: '#d1d5db', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )}

          {/* ── Run Advisor ── */}
          <div style={{ display: 'flex', gap: 8, marginBottom: advisorBusy ? 8 : 16, alignItems: 'center' }}>
            <button
              onClick={handleRunAdvisor}
              disabled={advisorBusy || !hasApiKey}
              style={{
                padding: '8px 18px', background: hasApiKey ? '#7c3aed' : '#374151',
                color: '#fff', border: 'none', borderRadius: 6, cursor: hasApiKey ? 'pointer' : 'not-allowed',
                fontWeight: 600, fontSize: 13
              }}
            >
              {advisorBusy ? '⟳ Consulting Claude…' : '🤖 Run AI Portfolio Advisor'}
            </button>
            {hasApiKey && !advisorBusy && (
              <button
                onClick={() => setShowApiKeyInput(true)}
                style={{ padding: '6px 10px', background: 'transparent', color: '#6b7280', border: '1px solid #374151', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}
              >
                Update API Key
              </button>
            )}
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {advisorBusy ? streamStatus : '(uses Anthropic API key · claude-opus-4-7 · adaptive thinking)'}
            </span>
          </div>

          {/* ── Live thinking stream ── */}
          {advisorBusy && thinkingText && (
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#a855f7', animation: 'pulse 1.4s ease-in-out infinite' }} />
                Claude is reasoning…
              </div>
              <div
                ref={thinkingRef}
                style={{
                  maxHeight: 200, overflowY: 'auto', fontSize: 11, color: '#94a3b8',
                  whiteSpace: 'pre-wrap', lineHeight: 1.55, fontFamily: 'ui-monospace, monospace',
                }}
              >
                {thinkingText}
              </div>
            </div>
          )}

          {/* ── Previous thinking (collapsed) ── */}
          {!advisorBusy && thinkingText && advisorSession && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 11, color: '#6b7280', cursor: 'pointer', userSelect: 'none' }}>
                🧠 Show reasoning from last run
              </summary>
              <div style={{
                background: '#0f172a', border: '1px solid #334155', borderRadius: 6,
                padding: 10, marginTop: 6, maxHeight: 200, overflowY: 'auto',
                fontSize: 11, color: '#94a3b8', whiteSpace: 'pre-wrap', lineHeight: 1.55,
                fontFamily: 'ui-monospace, monospace',
              }}>
                {thinkingText}
              </div>
            </details>
          )}

          {/* ── Session display ── */}
          {displaySession && (
            <div style={{ display: 'flex', gap: 16 }}>

              {/* History sidebar */}
              {advisorHistory.length > 1 && (
                <div style={{ width: 160, flexShrink: 0 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>History</div>
                  {advisorHistory.map(s => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedHistoryId(s.id)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px',
                        background: (selectedHistoryId === s.id || (!selectedHistoryId && s === advisorSession)) ? '#374151' : 'transparent',
                        border: 'none', borderRadius: 4, color: '#d1d5db', cursor: 'pointer',
                        fontSize: 11, marginBottom: 2
                      }}
                    >
                      {new Date(s.requestedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </button>
                  ))}
                </div>
              )}

              {/* Main session content */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                  {new Date(displaySession.requestedAt).toLocaleString()} · {displaySession.model}
                  {displaySession.inputTokens != null && ` · ${displaySession.inputTokens + (displaySession.outputTokens ?? 0)} tokens`}
                </div>

                {/* Summary */}
                <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, color: '#f9fafb', marginBottom: 6 }}>📊 Portfolio Summary</div>
                  <p style={{ color: '#d1d5db', margin: 0, lineHeight: 1.6 }}>{displaySession.adviceText}</p>
                </div>

                {/* Portfolio observations */}
                {displaySession.observations.length > 0 && (
                  <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, color: '#f9fafb', marginBottom: 8 }}>🔭 Observations</div>
                    <ul style={{ margin: 0, paddingLeft: 20, color: '#d1d5db' }}>
                      {displaySession.observations.map((obs, i) => (
                        <li key={i} style={{ marginBottom: 4 }}>{obs}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Action items */}
                {displaySession.actionItems.length > 0 && (
                  <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                    <div style={{ fontWeight: 600, color: '#f9fafb', marginBottom: 8 }}>✅ Action Items</div>
                    {displaySession.actionItems.map((item, i) => (
                      <div key={i} style={{
                        display: 'flex', gap: 8, padding: '8px 0',
                        borderBottom: i < displaySession.actionItems.length - 1 ? '1px solid #374151' : 'none'
                      }}>
                        <span style={{
                          flexShrink: 0, fontSize: 10, padding: '2px 6px', borderRadius: 3,
                          background: urgencyColor(item.urgency), color: '#fff', fontWeight: 700,
                          height: 'fit-content', marginTop: 1
                        }}>
                          {item.urgency.replace('_', ' ').toUpperCase()}
                        </span>
                        <div>
                          <div style={{ color: '#f9fafb', fontWeight: 600, fontSize: 13 }}>
                            {item.ticker && <span style={{ color: '#60a5fa' }}>{item.ticker} </span>}
                            {item.action}
                          </div>
                          <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 2 }}>{item.rationale}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Per-position advice */}
                {Object.keys(displaySession.positionAdvice).length > 0 && (
                  <div style={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8, padding: 14 }}>
                    <div style={{ fontWeight: 600, color: '#f9fafb', marginBottom: 8 }}>📌 Per-Position Advice</div>
                    {Object.entries(displaySession.positionAdvice).map(([posId, advice]) => {
                      const pos = positions.find(p => p.id === parseInt(posId));
                      return (
                        <div key={posId} style={{ padding: '6px 0', borderBottom: '1px solid #374151' }}>
                          <span style={{ color: '#60a5fa', fontWeight: 600, marginRight: 8 }}>
                            {pos ? `${pos.ticker} (${pos.positionType})` : `#${posId}`}
                          </span>
                          <span style={{ color: '#d1d5db', fontSize: 12 }}>{advice}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {!displaySession && (
            <div style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>
              No advisor sessions yet. Click "Run AI Portfolio Advisor" above.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
