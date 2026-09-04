// PortfolioView - FR-6: Portfolio Tracking
// v0.16.0: E*Trade sync (Phase 1), per-position analysis (Phase 2), AI Advisor (Phase 3)
// see SPEC: Priority 6 - Portfolio Tracking

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSortable } from '../hooks/useSortable.js';
import type { PositionEtrade, PositionAnalysis, AdvisorSession, AdvisorProgressEvent } from '@shared/types.js';
import { positionToPayoffLegs } from '@shared/position-payoff.js';

type PositionType = 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
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
  delta: number | null;
  theta: number | null;
  vega: number | null;
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
    case 'close':        return '#f85149';
    case 'roll':         return '#58a6ff';
    case 'take_profits': return '#3fb950';
    case 'hedge':        return '#f97316';
    default:             return '#8b949e';
  }
}

const ACTION_LABEL: Record<PositionAnalysis['action'], string> = {
  hold:         '— Hold',
  close:        '⚑ Close',
  roll:         '↻ Roll',
  hedge:        '🛡 Hedge',
  take_profits: '✓ Take Profits',
};

const VERDICT_COLOR = { positive: '#3fb950', negative: '#f85149', neutral: '#8b949e' };
const VERDICT_LABEL = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral' };

function computeVerdict(returnPct: number | null): 'positive' | 'negative' | 'neutral' {
  if (returnPct === null) return 'neutral';
  if (returnPct > 2)  return 'positive';
  if (returnPct < -2) return 'negative';
  return 'neutral';
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

// ─── Trade Management Alerts Banner (ENH-5) ───────────────────────────────────
// Computed client-side from already-loaded positions + E*Trade data.
// Three rules: 50% profit (ET data), 21 DTE (expiry date), delta drift (stored Greeks).

const DELTA_DRIFT_THRESHOLD = 0.45;

const ALERT_LABEL = { profit: '✓ Take Profits', dte: '⏱ Manage Now', delta: '⚠ Delta Drift' } as const;
const ALERT_COLOR = { profit: '#22c55e', dte: '#f59e0b', delta: '#ef4444' } as const;

interface TradeAlert {
  positionId: number;
  ticker: string;
  positionType: PositionType;
  strikePrice: number | null;
  type: 'profit' | 'dte' | 'delta';
  detail: string;
}

function TradeAlertsBanner({
  positions,
  etMap,
  onView,
}: {
  positions: Position[];
  etMap: Map<number, PositionEtrade>;
  onView: (positionId: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const alerts = useMemo((): TradeAlert[] => {
    const result: TradeAlert[] = [];
    const now = Date.now();

    for (const pos of positions) {
      if (pos.status !== 'open' || pos.positionType === 'Stock') continue;
      const et = etMap.get(pos.id);

      // 50% Profit — E*Trade totalGainPct (reliable source of P&L %)
      if (et?.totalGainPct !== null && et?.totalGainPct !== undefined && et.totalGainPct >= 50) {
        result.push({
          positionId: pos.id, ticker: pos.ticker, positionType: pos.positionType,
          strikePrice: pos.strikePrice, type: 'profit',
          detail: `${et.totalGainPct.toFixed(0)}% gain`,
        });
      }

      // 21 DTE — computed from expirationDate
      if (pos.expirationDate) {
        const daysLeft = Math.round((new Date(pos.expirationDate).getTime() - now) / 86_400_000);
        if (daysLeft >= 0 && daysLeft <= 21) {
          result.push({
            positionId: pos.id, ticker: pos.ticker, positionType: pos.positionType,
            strikePrice: pos.strikePrice, type: 'dte',
            detail: `${daysLeft}d to expiry`,
          });
        }
      }

      // Delta Drift — E*Trade delta takes priority, falls back to stored Greeks
      const delta = et?.delta ?? pos.delta;
      if (delta !== null && Math.abs(delta) > DELTA_DRIFT_THRESHOLD) {
        result.push({
          positionId: pos.id, ticker: pos.ticker, positionType: pos.positionType,
          strikePrice: pos.strikePrice, type: 'delta',
          detail: `Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`,
        });
      }
    }

    return result;
  }, [positions, etMap]);

  if (alerts.length === 0) return null;

  return (
    <div style={{ border: '1px solid #374151', borderLeft: '3px solid #f59e0b', borderRadius: 6, marginBottom: 10, background: '#1a1f2e', overflow: 'hidden' }}>
      <button
        onClick={() => setCollapsed(p => !p)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: '8px 12px', cursor: 'pointer', color: '#f9fafb', fontSize: 12, fontWeight: 600, textAlign: 'left' }}
      >
        <span style={{ color: '#f59e0b' }}>⚡ Trade Management</span>
        <span style={{ background: '#f59e0b', color: '#000', borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '1px 6px', lineHeight: 1.5 }}>
          {alerts.length}
        </span>
        <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 11 }}>{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 0 }}>
          {alerts.map((a, i) => (
            <div
              key={i}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderTop: i > 0 ? '1px solid #1f2937' : 'none', fontSize: 12 }}
            >
              <span style={{ color: ALERT_COLOR[a.type], fontWeight: 600, minWidth: 112 }}>{ALERT_LABEL[a.type]}</span>
              <span style={{ color: '#60a5fa', fontWeight: 600, minWidth: 56 }}>{a.ticker}</span>
              <span style={{ color: '#9ca3af', minWidth: 30 }}>{a.positionType}</span>
              {a.strikePrice !== null && <span style={{ color: '#9ca3af' }}>${a.strikePrice}</span>}
              <span style={{ color: '#d1d5db' }}>{a.detail}</span>
              <button
                onClick={() => onView(a.positionId)}
                style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', background: '#1f2937', border: '1px solid #374151', borderRadius: 4, color: '#60a5fa', cursor: 'pointer' }}
              >
                View →
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

interface CapEff {
  portfolio: {
    tradingDays: number; idleDays: number; avgDeployed: number; peakDeployed: number;
    utilizationPct: number | null; realizedPnl: number;
    returnOnPortfolioPct: number | null; returnOnDeployedPct: number | null;
    annualizedOnDeployedPct: number | null;
  };
  positions: Array<{
    ticker: string; positionType: string; strike: number | null;
    daysHeld: number; dteAtEntry: number | null; capital: number; realizedPnl: number;
    projectedAnnualPct: number | null; realizedAnnualPct: number | null; clamped: boolean;
  }>;
  portfolioValue: number | null;
}

const fmt0 = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmt2 = (n: number): string => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct  = (n: number | null): string => (n == null ? '—' : `${n.toFixed(2)}%`);

/**
 * Matches the P&L summary cards at the top of this view.
 *
 * The first version used its own inline light-theme styling, which read as white boxes against
 * the app's dark surface. Reusing `.summary-card` keeps one visual language and picks up theme
 * changes for free rather than needing a second set of colours maintained by hand.
 */
function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'positive' | 'negative';
}) {
  return (
    <div className="summary-card">
      <span className="summary-label">{label}</span>
      <span className={`summary-value${tone ? ` ${tone}` : ''}`}>{value}</span>
      {sub ? <span className="summary-sub">{sub}</span> : null}
    </div>
  );
}

/** Shape returned by `portfolio:capital-utilisation` (see capital-utilisation.ts). */
type CapitalUtilisation = Awaited<ReturnType<typeof window.api.portfolio.capitalUtilisation>>;

/** Whole dollars — cents are noise at this scale and make the strip harder to scan. */
const fmtUsd = (n: number | null): string =>
  n === null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;

export function PortfolioView() {
  const [positions, setPositions]         = useState<Position[]>([]);
  const [capital, setCapital]             = useState<CapitalUtilisation | null>(null);
  const [etPositions, setEtPositions]     = useState<PositionEtrade[]>([]);
  const [analyses, setAnalyses]           = useState<Map<number, PositionAnalysis>>(new Map());
  const [summary, setSummary]             = useState<PnLSummary | null>(null);
  const [activeTab, setActiveTab]         = useState<'open' | 'closed' | 'advisor' | 'performance'>('open');
  const [capEff, setCapEff]               = useState<CapEff | null>(null);
  const [capEffBusy, setCapEffBusy]       = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [statusMsg, setStatusMsg]         = useState<string | null>(null);
  const [showAddForm, setShowAddForm]     = useState(false);
  const [editingPosition, setEditingPosition] = useState<Position | null>(null);

  // E*Trade sync state
  const [syncBusy, setSyncBusy]           = useState(false);
  const [syncClosedBusy, setSyncClosedBusy] = useState(false);
  const [lastSyncedAt, setLastSyncedAt]   = useState<string | null>(null);

  // Analysis state
  const [analyzingId, setAnalyzingId]     = useState<number | null>(null);
  const [analyzingAll, setAnalyzingAll]   = useState(false);
  const [expanded, setExpanded]           = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) =>
    setExpanded(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

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

  // Greeks refresh state
  const [fetchingGreeks, setFetchingGreeks] = useState(false);

  // Earnings map: ticker → upcoming report date/dte
  const [earningsMap, setEarningsMap] = useState<Map<string, { reportDate: string; dte: number|null }>>(new Map());

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

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Capital utilisation — available cash vs the committed book. Reloads with the position list
  // so it never shows a stale picture next to fresh positions.
  useEffect(() => {
    let cancelled = false;
    window.api.portfolio.capitalUtilisation()
      .then(r => { if (!cancelled) setCapital(r); })
      .catch(() => { if (!cancelled) setCapital(null); });
    return () => { cancelled = true; };
  }, [positions.length, lastSyncedAt]);

  // Load earnings for open options positions (non-blocking)
  useEffect(() => {
    const optionTickers = [...new Set(
      positions.filter(p => p.status === 'open' && p.positionType !== 'Stock').map(p => p.ticker)
    )];
    if (optionTickers.length === 0) return;
    Promise.all(optionTickers.map(t => window.api.earnings.get(t))).then(results => {
      const m = new Map<string, { reportDate: string; dte: number|null }>();
      results.forEach((e, i) => {
        if (e) m.set(optionTickers[i]!, { reportDate: e.reportDate, dte: e.dte });
      });
      setEarningsMap(m);
    }).catch(() => {});
  }, [positions]);

  // Auto-analyze open positions whenever they load or their count changes.
  // Fires on initial page load and after E*Trade sync adds new positions.
  useEffect(() => {
    if (activeTab !== 'open' || positions.length === 0 || analyzingAll) return;
    setAnalyzingAll(true);
    window.api.portfolio.analysis.runAll()
      .then(results => {
        const m = new Map<number, PositionAnalysis>();
        for (const r of results) m.set(r.positionId, r);
        setAnalyses(m);
      })
      .catch(() => {/* silent — analysis is best-effort */})
      .finally(() => setAnalyzingAll(false));
  // positions.length (not positions) avoids firing on every re-render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, positions.length]);

  // Load advisor history when switching to advisor tab.
  // Auto-select the most recent session so prior results are visible immediately.
  useEffect(() => {
    if (activeTab === 'advisor') {
      window.api.portfolio.advisor.history(10)
        .then(h => {
          setAdvisorHistory(h);
          // If no live session is active and nothing is selected yet, show the latest
          if (h.length > 0 && !advisorSession && !selectedHistoryId) {
            setSelectedHistoryId(h[0]!.id);
          }
        })
        .catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // E*Trade sync data takes precedence (already position-adjusted)
        if (et.delta != null) netDelta += et.delta * multiplier;
        if (isOption) {
          if (et.theta != null) totalTheta += et.theta * multiplier;
          if (et.vega  != null) totalVega  += et.vega  * multiplier;
        }
      } else if (isOption) {
        // Fallback: stored Greeks from live chain fetch (short-position convention)
        if (pos.delta != null) netDelta    += pos.delta * multiplier;
        if (pos.theta != null) totalTheta  += pos.theta * multiplier;
        if (pos.vega  != null) totalVega   += pos.vega  * multiplier;
      } else {
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
      const closedMsg = result.positionsClosed ? `, ${result.positionsClosed} closed` : '';
      const msg = `Synced: ${result.positionsUpserted} positions updated, ${result.positionsSkipped} skipped${closedMsg}`;
      setStatusMsg(result.errors.length > 0 ? `${msg}. Errors: ${result.errors.join('; ')}` : msg);
      loadData();
    } catch (e) { setError(`Sync failed: ${(e as Error).message}`); }
    finally { setSyncBusy(false); }
  };

  const handleSyncClosed = async () => {
    setSyncClosedBusy(true); setError(null);
    try {
      const result = await window.api.portfolio.etrade.syncClosed();
      const msg = `Imported: ${result.positionsUpserted} closed positions, ${result.positionsSkipped} already existed`;
      setStatusMsg(result.errors.length > 0 ? `${msg}. Errors: ${result.errors.join('; ')}` : msg);
      loadData();
    } catch (e) { setError(`Sync closed failed: ${(e as Error).message}`); }
    finally { setSyncClosedBusy(false); }
  };

  // ─── Capital efficiency ───────────────────────────────────────────────────────
  // Return on the capital actually at risk, not on the whole account. Measuring a wheel
  // against total portfolio value understates it whenever capital is deliberately held back.
  useEffect(() => {
    if (activeTab !== 'performance' || capEff || capEffBusy) return;
    setCapEffBusy(true);
    window.api.portfolio.capitalEfficiency()
      .then(r => setCapEff(r as unknown as CapEff))
      .catch(() => { /* panel simply stays empty */ })
      .finally(() => setCapEffBusy(false));
  }, [activeTab, capEff, capEffBusy]);

  // ─── Fetch live Greeks ────────────────────────────────────────────────────────

  const handleFetchGreeks = async () => {
    setFetchingGreeks(true); setError(null);
    try {
      const result = await window.api.portfolio.fetchGreeks();
      const msg = result.updated > 0
        ? `Greeks updated for ${result.updated} position${result.updated !== 1 ? 's' : ''}${result.failed > 0 ? ` (${result.failed} failed)` : ''}`
        : result.failed > 0
          ? `Greeks fetch failed for all ${result.failed} position${result.failed !== 1 ? 's' : ''}`
          : 'No open options positions to update';
      setStatusMsg(msg);
      if (result.updated > 0) loadData();
    } catch (e) { setError(`Greeks fetch failed: ${(e as Error).message}`); }
    finally { setFetchingGreeks(false); }
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
    ...(activeTab === 'open'   ? [{ key: '_expand',       label: '',              sortable: false, num: false }] : []),
    { key: 'ticker',             label: 'Ticker',          sortable: true,  num: false },
    { key: 'positionType',       label: 'Type',            sortable: true,  num: false },
    { key: 'quantity',           label: 'Qty',             sortable: true,  num: true  },
    { key: 'entryPrice',         label: 'Entry',           sortable: true,  num: true  },
    ...(activeTab === 'open'   ? [{ key: 'strike',         label: 'Strike/Exp',   sortable: false, num: true  }] : []),
    ...(activeTab === 'open'   ? [{ key: 'currentPrice',   label: 'Current',      sortable: true,  num: true  }] : []),
    ...(activeTab === 'closed' ? [{ key: 'exitPrice',      label: 'Exit',         sortable: true,  num: true  }] : []),
    ...(activeTab === 'open'   ? [{ key: 'marketValue',    label: 'Mkt Value',    sortable: false, num: true  }] : []),
    ...(activeTab === 'open'   ? [{ key: 'daysGain',       label: "Day's G/L",    sortable: false, num: true  }] : []),
    ...(activeTab === 'open'   ? [{ key: 'totalGain',      label: 'Total G/L',    sortable: false, num: true  }] : []),
    ...(activeTab === 'open'   ? [{ key: 'greeks',         label: 'Greeks',       sortable: false, num: false }] : []),
    ...(activeTab === 'open'   ? [{ key: 'expiryDate',     label: 'Expiry',       sortable: true,  num: false }] : []),
    ...(activeTab === 'closed' ? [{ key: 'realizedPnl',    label: 'Realized P&L', sortable: true,  num: true  }] : []),
    { key: 'entryDate',          label: 'Entry Date',      sortable: true,  num: false },
    ...(activeTab === 'open'   ? [{ key: 'verdict',        label: 'Verdict',      sortable: false, num: false }] : []),
    ...(activeTab === 'open'   ? [{ key: 'action',         label: 'Analysis',     sortable: false, num: false }] : []),
    { key: 'actions',            label: 'Actions',         sortable: false, num: false },
  ].filter(Boolean) as { key: string; label: string; sortable: boolean; num: boolean }[];

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

      {/* ── Capital utilisation ──
          available and committed are COMPLEMENTARY: E*Trade already withholds CSP collateral
          from cashAvailableForInvestment, so idle IS available — never available − committed. */}
      {capital && (capital.available !== null || capital.committed.total > 0) && (
        <div className="capital-strip">
          <div className="capital-bar" title={`Committed ${fmtUsd(capital.committed.total)} of ${fmtUsd(capital.total)}`}>
            <div
              className="capital-bar-fill"
              style={{ width: `${Math.min(100, Math.max(0, capital.utilisationPct ?? 0))}%` }}
            />
          </div>
          <div className="capital-stats">
            <div className="capital-stat">
              <span className="capital-k">Working</span>
              <span className="capital-v">{fmtUsd(capital.committed.total)}</span>
              <span className="capital-n">
                {capital.committed.csp > 0 && `CSP ${fmtUsd(capital.committed.csp)}`}
                {capital.committed.csp > 0 && capital.committed.stock > 0 && ' · '}
                {capital.committed.stock > 0 && `stock ${fmtUsd(capital.committed.stock)}`}
                {capital.committed.total === 0 && 'nothing open'}
              </span>
            </div>
            <div className="capital-stat">
              <span className="capital-k">Idle</span>
              <span className="capital-v">
                {capital.available === null ? '—' : fmtUsd(capital.available)}
              </span>
              <span className="capital-n">
                {capital.available === null
                  ? 'no balance synced yet'
                  : capital.idleStreakDays && capital.idleStreakDays > 1
                    ? `${capital.idleStreakDays} days without deploying`
                    : 'cash available'}
              </span>
            </div>
            <div className="capital-stat">
              <span className="capital-k">Utilisation</span>
              <span className="capital-v">
                {capital.utilisationPct === null ? '—' : `${capital.utilisationPct.toFixed(0)}%`}
              </span>
              <span className="capital-n">
                {capital.total === null ? 'needs a balance' : `of ${fmtUsd(capital.total)} total`}
              </span>
            </div>
          </div>
          {capital.balanceAgeDays !== null && capital.balanceAgeDays > 1 && (
            <div className="capital-stale">
              ⚠ Balance is {capital.balanceAgeDays} days old ({capital.balanceAsOf}) — sync to refresh.
            </div>
          )}
          {capital.committed.unclassified.length > 0 && (
            <div className="capital-stale">
              Not counted as committed: {capital.committed.unclassified.join(', ')} — unrecognised position type.
            </div>
          )}
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
          <button
            onClick={handleFetchGreeks}
            disabled={fetchingGreeks}
            style={{ fontSize: 10, padding: '4px 8px', background: 'transparent', border: '1px dashed #374151', borderRadius: 6, color: fetchingGreeks ? '#6b7280' : '#60a5fa', cursor: fetchingGreeks ? 'wait' : 'pointer', marginLeft: 'auto' }}
            title="Fetch live delta/theta/vega for open options positions from the options chain"
          >
            {fetchingGreeks ? '⟳ Fetching…' : '⚡ Refresh Greeks'}
          </button>
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
                <option value="Long Put">Long Put</option>
                <option value="Long Call">Long Call</option>
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
        <button className={`tab-btn ${activeTab === 'performance' ? 'active' : ''}`} onClick={() => setActiveTab('performance')}>
          📈 Performance
        </button>
        <button className={`tab-btn ${activeTab === 'advisor' ? 'active' : ''}`} onClick={() => setActiveTab('advisor')}>
          🤖 AI Advisor
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          POSITIONS TABLE (open / closed)
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab !== 'advisor' && activeTab !== 'performance' && (
        <>
          {/* Analyze All button for open tab */}
          {activeTab === 'closed' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <button
                onClick={handleSyncClosed}
                disabled={syncClosedBusy}
                style={{ padding: '4px 12px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 4, cursor: syncClosedBusy ? 'wait' : 'pointer', fontSize: 12 }}
              >
                {syncClosedBusy ? '⟳ Importing…' : '↓ Import Closed (YTD)'}
              </button>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Pulls closed trades for the year from E*Trade transaction history</span>
            </div>
          )}

          {activeTab === 'open' && analyzingAll && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
              ⟳ Analyzing positions…
            </div>
          )}

          {activeTab === 'open' && (
            <TradeAlertsBanner
              positions={positions}
              etMap={etMap}
              onView={(id) => {
                setExpanded(prev => { const s = new Set(prev); s.add(id); return s; });
                setTimeout(() => {
                  document.getElementById(`pos-row-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 50);
              }}
            />
          )}

          <div className="positions-table-wrap">
            <table className="positions-table">
              <thead>
                <tr>
                  {columns.map(col => (
                    <th
                      key={col.key}
                      className={[col.sortable ? 'sortable' : '', col.num ? 'num' : ''].filter(Boolean).join(' ') || undefined}
                      onClick={col.sortable ? () => requestSort(col.key) : undefined}
                      style={
                        col.key === '_expand'  ? { width: 20, minWidth: 20 } :
                        col.key === 'action'   ? { whiteSpace: 'nowrap' } :
                        col.key === 'actions'  ? { whiteSpace: 'nowrap' } :
                        undefined
                      }
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
                      No {activeTab} positions. {activeTab === 'open' ? 'Click "+ Add Position" or "Sync E*Trade" to get started.' : 'Click "Import Closed (YTD)" to pull closed trades from E*Trade.'}
                    </td>
                  </tr>
                ) : (
                  sortedData.map(pos => {
                    const et        = etMap.get(pos.id);
                    const an        = analyses.get(pos.id);
                    const daysLeft  = dte(pos.expirationDate);
                    const isAnalyzing = analyzingId === pos.id;
                    const isExpanded  = expanded.has(pos.id);
                    const verdict     = an ? computeVerdict(an.currentReturnPct) : null;

                    return (
                      <>
                        <tr
                          key={pos.id}
                          id={`pos-row-${pos.id}`}
                          style={{ cursor: activeTab === 'open' ? 'pointer' : 'default' }}
                          onClick={() => activeTab === 'open' && toggleExpand(pos.id)}
                        >
                          {/* Expand toggle */}
                          {activeTab === 'open' && (
                            <td style={{ color: 'var(--text-muted)', fontSize: 11, width: 20 }}>
                              {isExpanded ? '▼' : '▶'}
                            </td>
                          )}

                          <td>
                            <strong>{pos.ticker}</strong>
                            {et?.etradePositionId && (
                              <span style={{ fontSize: 9, color: '#3b82f6', marginLeft: 4 }} title="Synced from E*Trade">●ET</span>
                            )}
                            {(() => {
                              const ec = earningsMap.get(pos.ticker);
                              if (!ec || pos.positionType === 'Stock') return null;
                              const beforeExpiry = pos.expirationDate && ec.reportDate <= pos.expirationDate;
                              if (!beforeExpiry && (ec.dte ?? 999) > 21) return null;
                              const color = (ec.dte ?? 999) <= 7 ? '#ef4444' : '#f59e0b';
                              return (
                                <span title={`Earnings ${ec.reportDate} — ${beforeExpiry ? 'before expiry!' : ''}`}
                                  style={{ fontSize: 9, color, marginLeft: 5, fontWeight: 700 }}>
                                  📅{beforeExpiry ? '!' : ''}
                                </span>
                              );
                            })()}
                          </td>
                          <td>
                            <span className={`type-badge ${pos.positionType.toLowerCase().replace(/\s+/g, '-')}`}>
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

                          {/* Market value */}
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

                          {/* Total gain — full-position unrealized G/L (E*Trade totalGain $ + totalGainPct %) */}
                          {activeTab === 'open' && (() => {
                            const totalGain = et?.unrealizedPnl ?? pos.unrealizedPnl;
                            return (
                              <td className="num" style={{ fontSize: 11 }}>
                                {totalGain != null ? (
                                  <span style={{ color: totalGain >= 0 ? '#22c55e' : '#ef4444' }}>
                                    {fmtLargeNumber(totalGain)}
                                    {et?.totalGainPct != null && ` (${fmtPct(et.totalGainPct)})`}
                                  </span>
                                ) : '—'}
                              </td>
                            );
                          })()}

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

                          {/* Expiry date */}
                          {activeTab === 'open' && (
                            <td style={{ fontSize: 12 }}>
                              {pos.expirationDate ? (
                                <>
                                  <div>{pos.expirationDate.slice(0, 10)}</div>
                                  {daysLeft !== null && (
                                    <div style={{ fontSize: 10, color: daysLeft <= 7 ? '#f85149' : daysLeft <= 14 ? '#e3a008' : 'var(--text-muted)' }}>
                                      {daysLeft}d
                                    </div>
                                  )}
                                </>
                              ) : '—'}
                            </td>
                          )}
                          {activeTab === 'closed' && (
                            <td className={`num ${(pos.realizedPnl || 0) >= 0 ? 'positive' : 'negative'}`}>
                              {fmtLargeNumber(pos.realizedPnl)}
                            </td>
                          )}

                          <td>{formatDate(pos.entryDate)}</td>

                          {/* Verdict */}
                          {activeTab === 'open' && (
                            <td onClick={e => e.stopPropagation()}>
                              {verdict ? (
                                <span className="retro-verdict-chip" style={{
                                  background: VERDICT_COLOR[verdict] + '22',
                                  color: VERDICT_COLOR[verdict],
                                  border: `1px solid ${VERDICT_COLOR[verdict]}44`,
                                }}>
                                  {VERDICT_LABEL[verdict]}
                                </span>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
                              )}
                            </td>
                          )}

                          {/* Action badge — reason is in the expanded row */}
                          {activeTab === 'open' && (
                            <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                              {an ? (
                                <span
                                  className="retro-action-badge"
                                  title={an.explanation}
                                  style={{
                                    background: actionColor(an.action) + '22',
                                    color: actionColor(an.action),
                                    borderColor: actionColor(an.action) + '55',
                                  }}
                                >
                                  {ACTION_LABEL[an.action]}
                                </span>
                              ) : (
                                <button
                                  onClick={e => { e.stopPropagation(); handleAnalyze(pos.id); }}
                                  disabled={isAnalyzing}
                                  style={{ fontSize: 10, padding: '2px 8px', background: '#374151', border: '1px solid #4b5563', borderRadius: 4, color: '#d1d5db', cursor: 'pointer' }}
                                  title="Run position analysis"
                                >
                                  {isAnalyzing ? '⟳ …' : '🔬 Analyze'}
                                </button>
                              )}
                            </td>
                          )}

                          <td className="actions" onClick={e => e.stopPropagation()}>
                            <div>
                              <button
                                onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-validate', { detail: { ticker: pos.ticker } }))}
                                className="action-btn"
                                title={`Validate ${pos.ticker}`}
                              >
                                🎯
                              </button>
                              <button
                                onClick={() => {
                                  // Reconstruct the ACTUAL held position (exact strike/expiry/entry
                                  // premium) rather than rebuilding a generic CSP off the live chain.
                                  const legs = positionToPayoffLegs(pos);
                                  window.dispatchEvent(new CustomEvent('navigate-to-payoff', { detail: {
                                    ticker:   pos.ticker,
                                    spot:     et?.currentPrice ?? pos.currentPrice ?? undefined,
                                    expiry:   pos.expirationDate ?? undefined,
                                    legs,
                                    // Fall back to the old chain-rebuild only if we couldn't build legs.
                                    strike:   legs ? undefined : (pos.strikePrice ?? undefined),
                                    strategy: legs ? undefined : (pos.positionType === 'CSP' ? 'csp' : pos.positionType === 'CC' ? 'cc' : undefined),
                                  }}));
                                }}
                                className="action-btn"
                                title={`Payoff diagram for ${pos.ticker}`}
                              >
                                📐
                              </button>
                              {activeTab === 'open' && (
                                <button onClick={() => handleClosePosition(pos.id)} className="action-btn close" title="Close position">
                                  ✓ Close
                                </button>
                              )}
                              <button onClick={() => handleDeletePosition(pos.id)} className="action-btn delete" title="Delete position">
                                ✕
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* Expanded detail row */}
                        {activeTab === 'open' && isExpanded && (
                          <tr key={`${pos.id}-detail`} style={{ background: '#0d1117' }}>
                            <td colSpan={columns.length} style={{ padding: '10px 20px 12px 40px' }}>
                              {an ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {/* Full explanation */}
                                  <div style={{ fontSize: 13, color: '#c9d1d9', lineHeight: 1.5 }}>
                                    <span style={{ color: actionColor(an.action), fontWeight: 600, marginRight: 8 }}>{ACTION_LABEL[an.action]}</span>
                                    {an.explanation}
                                  </div>
                                  {/* Metrics row */}
                                  <div style={{ display: 'flex', gap: 20, fontSize: 11, color: '#8b949e' }}>
                                    {an.trend && <span>Trend: <strong style={{ color: an.trend === 'bullish' ? '#3fb950' : an.trend === 'bearish' ? '#f85149' : '#8b949e' }}>{an.trend}</strong></span>}
                                    {an.currentReturnPct !== null && <span>Return: <strong style={{ color: an.currentReturnPct >= 0 ? '#3fb950' : '#f85149' }}>{an.currentReturnPct >= 0 ? '+' : ''}{an.currentReturnPct.toFixed(1)}%</strong></span>}
                                    {an.rsi !== null && <span>RSI: <strong>{an.rsi.toFixed(0)}</strong></span>}
                                    {an.assignmentRisk && <span>Assignment risk: <strong style={{ color: an.assignmentRisk === 'high' ? '#f85149' : an.assignmentRisk === 'medium' ? '#e3a008' : '#3fb950' }}>{an.assignmentRisk}</strong></span>}
                                    {an.ivRank !== null && <span>IV Rank: <strong>{an.ivRank.toFixed(0)}</strong></span>}
                                    {an.compositeScore !== null && <span>Score: <strong>{an.compositeScore.toFixed(1)}/10</strong></span>}
                                    <span style={{ marginLeft: 'auto', color: '#4b5563' }}>
                                      Conviction: {'★'.repeat(an.conviction)}{'☆'.repeat(3 - an.conviction)}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <span style={{ color: '#4b5563', fontSize: 12 }}>
                                  No analysis yet — click <strong>🔬 Analyze</strong> to compute position metrics.
                                </span>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
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
      {activeTab === 'performance' && (
        <div style={{ padding: 4 }}>
          {capEffBusy && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Computing…</div>}
          {capEff && (
            <>
              <div className="pnl-summary-cards" style={{ borderBottom: 'none' }}>
                <Stat label="Return on deployed capital"
                      value={pct(capEff.portfolio.returnOnDeployedPct)}
                      sub={`on avg $${fmt0(capEff.portfolio.avgDeployed)} actually at risk`}
                      tone={(capEff.portfolio.returnOnDeployedPct ?? 0) >= 0 ? 'positive' : 'negative'} />
                <Stat label="Return on portfolio"
                      value={pct(capEff.portfolio.returnOnPortfolioPct)}
                      sub={capEff.portfolioValue ? `of ~$${fmt0(capEff.portfolioValue)} total` : 'portfolio value unknown'} />
                <Stat label="Utilization"
                      value={pct(capEff.portfolio.utilizationPct)}
                      sub={`${capEff.portfolio.idleDays} of ${capEff.portfolio.tradingDays} days flat · peak $${fmt0(capEff.portfolio.peakDeployed)}`} />
                <Stat label="Realized P&L"
                      value={`$${fmt2(capEff.portfolio.realizedPnl)}`}
                      tone={capEff.portfolio.realizedPnl >= 0 ? 'positive' : 'negative'}
                      sub={capEff.portfolio.annualizedOnDeployedPct != null
                        ? `${pct(capEff.portfolio.annualizedOnDeployedPct)} annualized on deployed` : ''} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 16px 10px', maxWidth: 760, lineHeight: 1.5 }}>
                Idle days are included in the average, so holding cash lowers deployed capital and
                raises return-per-dollar-deployed — while <b>return on portfolio</b> beside it shows what
                sitting flat cost. A covered call adds no capital of its own (the shares already secure
                it), and an assignment hands capital from the put to the stock rather than counting both.
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, margin: '10px 16px 6px' }}>
                Per-trade: what the premium promised vs what the trade delivered
              </div>
              <div style={{ overflowX: 'auto', padding: '0 16px' }}>
                <table className="positions-table" style={{ fontSize: 11 }}>
                  <thead><tr>
                    <th>Ticker</th><th>Type</th><th style={{ textAlign: 'right' }}>Strike</th>
                    <th style={{ textAlign: 'right' }}>Held</th><th style={{ textAlign: 'right' }}>DTE</th>
                    <th style={{ textAlign: 'right' }}>Capital</th><th style={{ textAlign: 'right' }}>P&L</th>
                    <th style={{ textAlign: 'right' }}>Proj %/yr</th><th style={{ textAlign: 'right' }}>Real %/yr</th>
                  </tr></thead>
                  <tbody>
                    {capEff.positions.map((r, i) => (
                      <tr key={i}>
                        <td>{r.ticker}</td><td>{r.positionType}</td>
                        <td style={{ textAlign: 'right' }}>{r.strike ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{r.daysHeld}d</td>
                        <td style={{ textAlign: 'right' }}>{r.dteAtEntry ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>${fmt0(r.capital)}</td>
                        <td className={r.realizedPnl >= 0 ? 'positive' : 'negative'} style={{ textAlign: 'right' }}>
                          {r.realizedPnl >= 0 ? '+' : ''}{fmt2(r.realizedPnl)}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                          {r.projectedAnnualPct == null ? '—' : `${r.projectedAnnualPct.toFixed(0)}%`}
                        </td>
                        <td className={(r.realizedAnnualPct ?? 0) >= 0 ? 'positive' : 'negative'}
                            style={{ textAlign: 'right', fontWeight: 600 }}>
                          {r.realizedAnnualPct == null ? '—' : `${r.realizedAnnualPct.toFixed(0)}%`}
                          {r.clamped ? '*' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 16px 0', maxWidth: 760, lineHeight: 1.5 }}>
                <b>Proj %/yr</b> is the annualized return the premium implied if carried to expiry;
                <b> Real %/yr</b> is what the actual holding period delivered. A close that beats its own
                projection was efficient; one far below it gave up more time value than the move justified.
                <span> Long options show no projection — they pay a debit rather than collecting premium.</span>
                <span> * annualization clamped at ±{999}% on very short holds; dollar P&L is always exact.</span>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'advisor' && (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 0' }}>

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
              {advisorHistory.length > 0 && (
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
